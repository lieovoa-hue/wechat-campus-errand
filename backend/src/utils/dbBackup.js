/**
 * =====================================================================
 * 数据库每日备份（mysqldump → 本地 sql 文件 + 自动清理过期备份）
 * ---------------------------------------------------------------------
 * 【为什么必须有】
 *   图片丢了还能让用户重传，数据库丢了整个平台就没了：用户、任务、账单、
 *   举报记录全在里面。而本机 MySQL 没有任何容灾能力（磁盘坏 / 误删库 / 误执行 SQL
 *   都会直接毁掉全部业务数据），所以定时全量备份是最低成本的保险。
 *
 * 【怎么备份】
 *   用 mysqldump 做逻辑备份（纯 SQL 文本，可直接 source 恢复）：
 *     · --single-transaction：InnoDB 一致性快照，备份期间不锁表、不影响线上读写
 *     · --no-tablespaces   ：避免普通账号因缺少 PROCESS 权限而报错
 *     · --databases        ：备份文件里自带 CREATE DATABASE / USE，恢复时不用先建库
 *
 * 【安全与可靠性细节】
 *   1. 密码走环境变量 MYSQL_PWD 传给子进程，不写在命令行参数里（避免出现在进程列表）；
 *   2. 先写 .tmp 再改名，中途失败不会留下"看着像备份实际是半截"的坏文件；
 *   3. 备份文件为空（0 字节）一律视为失败并删除，避免误以为备份成功；
 *   4. 只按文件名前缀匹配清理，只删自己目录里超过保留天数的 .sql，绝不碰其它文件。
 *
 * 【配置（.env）】
 *   BACKUP_ENABLED=true          # 总开关
 *   BACKUP_DIR=D:\backup\campus_errand
 *   BACKUP_KEEP_DAYS=14          # 保留天数
 *   MYSQLDUMP_PATH=              # 可留空，留空时自动探测
 * =====================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./common');

/** 备份文件统一前缀（清理时只认这个前缀） */
const FILE_PREFIX = 'campus_errand_';

/** 单次备份的兜底超时（毫秒）：防止 mysqldump 卡死把定时任务拖住 */
const BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

/** 是否启用备份（默认启用，只有显式写 false 才关闭） */
function isEnabled() {
  return String(process.env.BACKUP_ENABLED === undefined ? 'true' : process.env.BACKUP_ENABLED)
    .toLowerCase() !== 'false';
}

/** 备份目录：.env 优先，未配置时落在项目内的 backup/db 下 */
function getBackupDir() {
  const configured = String(process.env.BACKUP_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, '../../backup/db');
}

/** 保留天数（至少 1 天） */
function getKeepDays() {
  const days = Number(process.env.BACKUP_KEEP_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 14;
}

/**
 * 探测 mysqldump 可执行文件
 * 顺序：.env 指定 → PATH → Windows / Linux 常见安装位置
 * @returns {string} 可用路径；找不到返回空串
 */
function resolveMysqldump() {
  const configured = String(process.env.MYSQLDUMP_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;

  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
      'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe',
      'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      'C:\\Program Files (x86)\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      'D:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe'
    ]
    : ['/usr/bin/mysqldump', '/usr/local/bin/mysqldump', '/usr/local/mysql/bin/mysqldump'];

  for (const item of candidates) {
    try {
      if (fs.existsSync(item)) return item;
    } catch (err) {
      // 忽略：某个候选路径不可访问不影响继续找下一个
    }
  }
  // PATH 里能直接找到的情况（Linux 常见）：交给 spawn 用文件名解析
  return 'mysqldump';
}

/** 备份文件名：campus_errand_20260920_030000.sql */
function buildFileName(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${FILE_PREFIX}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.sql`;
}

/** 执行 mysqldump 并把 stdout 落盘 */
function dumpToFile(bin, filePath) {
  return new Promise((resolve) => {
    const args = [
      '--host=' + (process.env.DB_HOST || 'localhost'),
      '--port=' + (process.env.DB_PORT || 3306),
      '--user=' + (process.env.DB_USER || 'root'),
      '--single-transaction',
      '--quick',
      '--no-tablespaces',
      '--default-character-set=utf8mb4',
      '--databases',
      process.env.DB_NAME || 'campus_errand'
    ];
    const child = spawn(bin, args, {
      // 密码走环境变量，避免出现在命令行 / 进程列表里
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' },
      windowsHide: true
    });

    const out = fs.createWriteStream(filePath);
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end();
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* 进程可能已退出 */ }
      finish({ ok: false, reason: `备份超时（超过 ${Math.round(BACKUP_TIMEOUT_MS / 60000)} 分钟）` });
    }, BACKUP_TIMEOUT_MS);

    child.stdout.pipe(out);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => finish({ ok: false, reason: '启动 mysqldump 失败：' + err.message }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, reason: (stderr || `mysqldump 退出码 ${code}`).trim().slice(0, 500) });
    });
  });
}

/** 清理超过保留天数的备份文件（只认自己写的文件名前缀 + .sql 后缀） */
function pruneOldBackups(dir, keepDays) {
  const deadline = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.sql')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < deadline) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (err) {
      // 单个文件删不掉不影响其它文件
    }
  }
  return removed;
}

/**
 * 执行一次备份
 * @param {{keepDays?:number, dir?:string}} [options] 仅供测试覆盖
 * @returns {Promise<{ok:boolean, file?:string, size?:number, removed?:number, reason?:string}>}
 */
async function runBackup(options = {}) {
  if (!isEnabled() && !options.force) {
    return { ok: false, reason: 'BACKUP_ENABLED=false，已跳过' };
  }
  const dir = options.dir ? path.resolve(options.dir) : getBackupDir();
  const keepDays = options.keepDays || getKeepDays();

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: '创建备份目录失败：' + err.message };
  }

  const bin = resolveMysqldump();
  const target = path.join(dir, buildFileName());
  const tmp = target + '.tmp';

  const result = await dumpToFile(bin, tmp);
  if (!result.ok) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) { /* 清不掉也不影响 */ }
    return { ok: false, reason: result.reason };
  }

  let size = 0;
  try {
    size = fs.statSync(tmp).size;
  } catch (err) {
    size = 0;
  }
  // 0 字节 = 没备出东西来（常见于密码错、库不存在），必须当失败处理
  if (size <= 0) {
    try { fs.unlinkSync(tmp); } catch (err) { /* 同上 */ }
    return { ok: false, reason: '备份文件为空，请检查 DB_PASSWORD / DB_NAME 与 mysqldump 是否可用' };
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    return { ok: false, reason: '备份文件改名失败：' + err.message };
  }

  const removed = pruneOldBackups(dir, keepDays);
  return { ok: true, file: target, size, removed };
}

/** 定时任务入口：只记日志，不抛错（避免拖垮调度器） */
async function jobBackupDb() {
  try {
    const result = await runBackup();
    if (result.ok) {
      const mb = (result.size / 1024 / 1024).toFixed(2);
      log('info', `[数据库备份] 成功：${result.file}（${mb} MB）`
        + (result.removed ? `，同时清理 ${result.removed} 个过期备份` : ''));
    } else {
      log('error', '[数据库备份] 失败：' + result.reason);
    }
    return result;
  } catch (err) {
    log('error', '[数据库备份] 异常：' + err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  isEnabled,
  getBackupDir,
  getKeepDays,
  resolveMysqldump,
  buildFileName,
  pruneOldBackups,
  runBackup,
  jobBackupDb
};