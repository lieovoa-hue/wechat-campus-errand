/**
 * =====================================================================
 * 垃圾文件 / 缓存自动清理器
 * ---------------------------------------------------------------------
 * 【为什么需要】
 *   小程序每注册并使用一个用户，都会在服务器上留下文件：
 *     - 上传图片：头像、校园认证截图、任务物品照、送达照片
 *     - 运行日志：每来一次请求就写一行，只增不减
 *   其中真正会「越用越多、且永远不会再被用到」的是**孤立图片**：
 *     1) 用户上传了图片但最后没提交（放弃发布 / 退出页面）
 *     2) 用户换了头像，旧头像文件没人引用
 *     3) 账号注销后头像 / 认证截图字段被清空，文件却留在磁盘上
 *     4) 管理员删除任务后，该任务的照片全部变成无主文件
 *
 * 【清理什么】（三件事，全部可单独关闭）
 *   1. 孤立上传图片：扫描 uploads 下所有图片，与数据库里仍被引用的图片比对，
 *      未被任何记录引用、且超过保留期的，先移入 uploads/.trash 回收站，
 *      回收站里再滞留超过 N 天的才真正删除（两步走，误判也能救回来）
 *   2. 日志文件：logs 目录下超过保留期的 .log 直接删除；
 *      体积超限的当天日志尝试「只保留尾部」，正在被进程占用的会跳过并记录原因
 *   3. 数据库轻量清理：短信验证码表 sms_code 里的过期 / 已用记录
 *      （短信通道已下线，该表属于历史遗留数据）
 *
 * 【安全设计：为什么不会误删核心文件】（这是本模块最关键的部分）
 *   A. 白名单根目录：只有 UPLOAD_DIR / backend/logs / <项目根>/logs 三处会被触碰，
 *      其它任何路径一律拒绝，绝不递归整个项目。
 *   B. 扩展名白名单：uploads 只处理 .jpg/.jpeg/.png/.webp，logs 只处理 .log，
 *      代码文件（.js/.json/.env/.pem/.key/.md…）在第一步就被排除。
 *   C. 路径包含校验：删除前用 path.relative 复核目标确实位于白名单根目录内，
 *      防止 .. 穿越或软链接指向外部。
 *   D. 敏感目录黑名单：路径中只要出现 src / node_modules / scripts / cert /
 *      miniprogram / models / controllers 等片段，直接跳过。
 *   E. 引用保护：仍在数据库中被引用的图片永远不删（哪怕文件很老）。
 *   F. 时间闸门：只处理「修改时间超过保留期」的文件，默认 7 天，
 *      保证刚上传、正在进行中的业务文件绝不会被碰到。
 *   G. 两步删除：先移入回收站，滞留期满才真删；期间随时可人工救回。
 *   H. 空跑模式：CLEAN_DRY_RUN=true 时只统计不动作，方便先看清单。
 *   I. 不删目录：只删文件，绝不 rm -rf 任何目录结构。
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/db');
const { log } = require('./common');

// ------------------------------ 路径定义 ------------------------------

/** backend 目录 */
const BACKEND_DIR = path.resolve(__dirname, '../..');
/** 项目根目录（仓库根） */
const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..');
/** 上传目录 */
const UPLOAD_DIR = path.resolve(BACKEND_DIR, 'uploads');
/** 回收站：孤立图片先移到这里，滞留期满才真删 */
const TRASH_DIR = path.resolve(UPLOAD_DIR, '.trash');
/** 后端日志目录 */
const BACKEND_LOG_DIR = path.resolve(BACKEND_DIR, 'logs');
/** 守护脚本日志目录（项目根 /logs） */
const ROOT_LOG_DIR = path.resolve(PROJECT_ROOT, 'logs');

/** 允许清理的根目录白名单：不在此列表内的路径一概不处理 */
const ALLOWED_ROOTS = [UPLOAD_DIR, BACKEND_LOG_DIR, ROOT_LOG_DIR];

/** 路径片段黑名单：出现任意一项即跳过（双保险，正常情况不会命中） */
const FORBIDDEN_SEGMENTS = [
  'node_modules', 'src', 'scripts', 'cert', 'miniprogram', '.git',
  'pages', 'components', 'models', 'controllers', 'routes', 'middleware',
  'db', 'schedule', 'utils', 'dist', 'build'
];

/** 各清理场景允许删除的扩展名白名单 */
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const LOG_EXT = ['.log'];

/** 受保护文件名：即使扩展名命中白名单也永不删除 */
const PROTECTED_NAMES = [
  '.env', '.env.example', '.gitignore', '.gitkeep',
  '_e2e_account.txt', 'cpolar-url.txt', 'cpolar.yml.bak',
  'package.json', 'package-lock.json', 'readme.md'
];

/** 回收站目录名（扫描孤立图片时跳过，避免把回收站里的东西再判一遍） */
const TRASH_DIR_NAME = '.trash';

// ------------------------------ 配置读取 ------------------------------

/** 读取数值型环境变量，非法值回退默认 */
function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 汇总本次清理的运行参数 */
function getOptions(override = {}) {
  const options = {
    // 总开关
    enabled: String(process.env.CLEAN_ENABLED || 'true') === 'true',
    // 空跑：只统计不删除
    dryRun: String(process.env.CLEAN_DRY_RUN || 'false') === 'true',
    // 孤立图片保留天数（修改时间早于「今天 - 该天数」才会被回收）
    orphanKeepDays: envInt('CLEAN_ORPHAN_KEEP_DAYS', 7),
    // 回收站滞留天数（超过才真删）
    trashKeepDays: envInt('CLEAN_TRASH_KEEP_DAYS', 3),
    // 日志保留天数
    logKeepDays: envInt('CLEAN_LOG_KEEP_DAYS', 7),
    // 单个日志体积上限（MB），超出尝试只保留尾部
    logMaxMb: envInt('CLEAN_LOG_MAX_MB', 20),
    // 日志超限后保留的行数
    logKeepLines: envInt('CLEAN_LOG_KEEP_LINES', 2000),
    // 短信验证码表保留天数
    smsKeepDays: envInt('CLEAN_SMS_KEEP_DAYS', 7)
  };
  return Object.assign(options, override);
}

// ------------------------------ 安全护栏 ------------------------------

/**
 * 判断路径是否位于允许清理的根目录内（关键安全校验）
 * 用 path.relative 而不是字符串 startsWith：能正确处理大小写、分隔符与 .. 归一化
 * @param {string} targetPath
 * @returns {boolean}
 */
function isInsideAllowedRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  return ALLOWED_ROOTS.some((root) => {
    const rel = path.relative(root, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * 判断路径中是否含有敏感目录片段
 * @param {string} targetPath
 * @returns {boolean}
 */
function hasForbiddenSegment(targetPath) {
  const parts = path.resolve(targetPath).toLowerCase().split(/[\\/]+/);
  return parts.some((part) => FORBIDDEN_SEGMENTS.indexOf(part) >= 0);
}

/**
 * 删除前的最终安全复核（任何一项不通过都不删）
 * @param {string} targetPath 目标文件绝对路径
 * @param {string[]} allowedExts 本次允许删除的扩展名白名单
 * @returns {{ok:boolean, reason:string}}
 */
function assertDeletable(targetPath, allowedExts) {
  if (!targetPath) return { ok: false, reason: '空路径' };
  if (!isInsideAllowedRoot(targetPath)) return { ok: false, reason: '不在允许清理的目录内' };
  if (hasForbiddenSegment(targetPath)) return { ok: false, reason: '命中敏感目录黑名单' };

  const name = path.basename(targetPath).toLowerCase();
  if (PROTECTED_NAMES.indexOf(name) >= 0) return { ok: false, reason: '受保护文件名' };
  if (allowedExts.indexOf(path.extname(name)) < 0) return { ok: false, reason: '扩展名不在白名单内' };

  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (err) {
    return { ok: false, reason: '无法读取文件信息' };
  }
  // 只删普通文件：目录、软链接（可能指向外部重要文件）一律跳过
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: '不是普通文件' };

  return { ok: true, reason: '' };
}

/**
 * 安全删除一个文件（带全部护栏校验）
 * @param {string} targetPath
 * @param {string[]} allowedExts
 * @param {{dryRun:boolean, stats:object}} ctx 上下文（是否空跑 + 统计累加器）
 * @returns {boolean} 是否真的删除成功
 */
function safeUnlink(targetPath, allowedExts, ctx) {
  const verdict = assertDeletable(targetPath, allowedExts);
  if (!verdict.ok) {
    ctx.stats.skipped += 1;
    ctx.stats.skipReasons[verdict.reason] = (ctx.stats.skipReasons[verdict.reason] || 0) + 1;
    return false;
  }
  if (ctx.dryRun) {
    ctx.stats.wouldDelete += 1;
    return false;
  }
  try {
    ctx.stats.bytes += fs.statSync(targetPath).size;
    fs.unlinkSync(targetPath);
    ctx.stats.deleted += 1;
    return true;
  } catch (err) {
    // EBUSY / EPERM：文件正被其它进程占用（典型的是 cmd 重定向中的当天日志）
    ctx.stats.skipped += 1;
    const reason = err.code === 'EBUSY' || err.code === 'EPERM' ? '文件正被占用' : `删除失败(${err.code})`;
    ctx.stats.skipReasons[reason] = (ctx.stats.skipReasons[reason] || 0) + 1;
    return false;
  }
}

/** 创建统计累加器 */
function newStats() {
  return { scanned: 0, deleted: 0, wouldDelete: 0, skipped: 0, bytes: 0, skipReasons: {} };
}

/** 判断文件是否已超过保留天数 */
function olderThanDays(filePath, days) {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs > days * 24 * 60 * 60 * 1000;
  } catch (err) {
    return false;
  }
}

// ------------------------------ 1. 孤立上传图片 ------------------------------

/**
 * 从数据库收集「仍被引用的图片」集合
 * 覆盖全部会存图片地址的字段：
 *   users.avatar / users.campus_cert_img
 *   tasks.img1~img3 / tasks.delivery_img1~delivery_img3
 *   audit_apply.apply_content（头像、昵称、校园认证三种申请共用该字段）
 * @returns {Promise<Set<string>>} 形如 /uploads/202609/xxx.jpg
 */
async function collectReferencedFiles() {
  // LIKE '%/uploads/%' 同时兼容「相对路径」与「历史遗留的绝对地址」两种历史数据
  const sql = `
    SELECT avatar AS p FROM users WHERE avatar LIKE '%/uploads/%'
    UNION ALL SELECT campus_cert_img FROM users WHERE campus_cert_img LIKE '%/uploads/%'
    UNION ALL SELECT img1 FROM tasks WHERE img1 LIKE '%/uploads/%'
    UNION ALL SELECT img2 FROM tasks WHERE img2 LIKE '%/uploads/%'
    UNION ALL SELECT img3 FROM tasks WHERE img3 LIKE '%/uploads/%'
    UNION ALL SELECT delivery_img1 FROM tasks WHERE delivery_img1 LIKE '%/uploads/%'
    UNION ALL SELECT delivery_img2 FROM tasks WHERE delivery_img2 LIKE '%/uploads/%'
    UNION ALL SELECT delivery_img3 FROM tasks WHERE delivery_img3 LIKE '%/uploads/%'
    UNION ALL SELECT apply_content FROM audit_apply WHERE apply_content LIKE '%/uploads/%'
  `;
  const rows = await db.query(sql);
  const set = new Set();
  rows.forEach((row) => {
    const normalized = normalizeUploadPath(row.p);
    if (normalized) set.add(normalized);
  });
  return set;
}

/**
 * 把任意形式的图片地址归一化成 /uploads/xxx 形式，便于与磁盘文件比对
 * @param {*} value
 * @returns {string} 归一化结果；不是 uploads 地址则返回空串
 */
function normalizeUploadPath(value) {
  if (typeof value !== 'string' || !value) return '';
  const index = value.indexOf('/uploads/');
  if (index < 0) return '';
  let result = value.slice(index);
  const queryIndex = result.indexOf('?');
  if (queryIndex >= 0) result = result.slice(0, queryIndex);
  try {
    result = decodeURIComponent(result);
  } catch (err) {
    // 非法转义序列保持原样
  }
  return result;
}

/** 把磁盘绝对路径转成数据库里存的 /uploads/xxx 形式 */
function fileToUploadPath(filePath) {
  const rel = path.relative(UPLOAD_DIR, filePath);
  return '/uploads/' + rel.split(path.sep).join('/');
}

/** 递归列出 uploads 下所有图片文件（跳过 .trash 回收站） */
function listUploadImages(dir, acc) {
  const list = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return list;
  }
  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === TRASH_DIR_NAME) return; // 回收站单独处理
      listUploadImages(full, list);
      return;
    }
    if (!entry.isFile()) return;
    if (IMAGE_EXT.indexOf(path.extname(entry.name).toLowerCase()) < 0) return;
    list.push(full);
  });
  return list;
}

/**
 * 列出孤立图片候选（供空跑预览 / 命令行 --list 使用）
 * 判定「可回收」的三个条件（必须同时满足）：
 *   1. 没有被数据库任何记录引用（参考 collectReferencedFiles 的字段清单）
 *   2. 修改时间已超过保留期（默认 7 天），避开「刚上传还没提交表单」的图片
 *   3. 通过全部安全护栏校验（目录白名单 / 扩展名白名单 / 非软链接）
 * @param {object} options
 * @returns {Promise<Array<object>>} 每项含 filePath / relative / size / mtime / referenced / deletable / reason
 */
async function listOrphans(options) {
  const opts = getOptions(options);
  if (!fs.existsSync(UPLOAD_DIR)) return [];

  const referenced = await collectReferencedFiles();
  const keepMs = opts.orphanKeepDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return listUploadImages(UPLOAD_DIR)
    .map((filePath) => {
      const relative = fileToUploadPath(filePath);
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        return null;
      }
      const verdict = assertDeletable(filePath, IMAGE_EXT);
      const isReferenced = referenced.has(relative);
      const isExpired = now - stat.mtimeMs > keepMs;
      return {
        filePath,
        relative,
        size: stat.size,
        mtime: stat.mtime,
        referenced: isReferenced,
        deletable: !isReferenced && isExpired && verdict.ok,
        reason: isReferenced ? '仍被数据库引用' : (verdict.ok ? '' : verdict.reason)
      };
    })
    .filter(Boolean);
}

/**
 * 回收孤立图片：移入 uploads/.trash/<日期>/，而不是直接删除
 * @param {object} options
 * @returns {Promise<object>} 统计结果
 */
async function cleanOrphanUploads(options) {
  const opts = getOptions(options);
  const stats = newStats();
  const all = await listOrphans(opts);
  stats.scanned = all.length;

  const ctx = { dryRun: opts.dryRun, stats };
  for (const item of all) {
    // ???????????????? + ????? + ????????????
    if (!item.deletable) continue;
    if (opts.dryRun) {
      stats.wouldDelete += 1;
      continue;
    }
    try {
      const dayDir = path.join(TRASH_DIR, new Date().toISOString().slice(0, 10));
      if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
      // ?????????????????????????????????????
      const prefix = path.relative(UPLOAD_DIR, path.dirname(item.filePath)).split(path.sep).join('_');
      const target = path.join(dayDir, prefix + '__' + path.basename(item.filePath));
      fs.renameSync(item.filePath, target);
      stats.deleted += 1;
      stats.bytes += item.size;
    } catch (err) {
      stats.skipped += 1;
      const reason = '???????(' + err.code + ')';
      stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
    }
  }

  return stats;
}
/**
 * 清理回收站：滞留超过保留天数的文件才真正删除
 * @param {object} options
 * @returns {object} 统计结果
 */
function purgeTrash(options) {
  const opts = getOptions(options);
  const stats = newStats();
  if (!fs.existsSync(TRASH_DIR)) return stats;

  const ctx = { dryRun: opts.dryRun, stats };
  const dayDirs = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  dayDirs.forEach((dayDir) => {
    const dayPath = path.join(TRASH_DIR, dayDir.name);
    // 只处理「名称像日期」且已过滞留期的目录，异常目录名一律跳过
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDir.name)) return;
    const dayTime = Date.parse(`${dayDir.name}T00:00:00Z`);
    if (!Number.isFinite(dayTime)) return;
    if (Date.now() - dayTime <= opts.trashKeepDays * 24 * 60 * 60 * 1000) return;

    let files;
    try {
      files = fs.readdirSync(dayPath, { withFileTypes: true });
    } catch (err) {
      return;
    }
    files.forEach((entry) => {
      if (!entry.isFile()) return;
      stats.scanned += 1;
      safeUnlink(path.join(dayPath, entry.name), IMAGE_EXT, ctx);
    });
  });

  return stats;
}

// ------------------------------ 2. 日志文件 ------------------------------

/**
 * 清理日志：超期的直接删，体积超限的尝试只保留尾部
 * 说明：正在被 cmd「>>」重定向写入的当天日志在 Windows 上被独占锁定，
 *      删除会返回 EBUSY，这里会跳过并记录原因（重启后端后即可被回收）。
 * @param {object} options
 * @returns {object} 统计结果
 */
function cleanLogFiles(options) {
  const opts = getOptions(options);
  const stats = newStats();
  const ctx = { dryRun: opts.dryRun, stats };
  const maxBytes = opts.logMaxMb * 1024 * 1024;

  [BACKEND_LOG_DIR, ROOT_LOG_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    entries.forEach((entry) => {
      if (!entry.isFile()) return;
      const full = path.join(dir, entry.name);
      if (LOG_EXT.indexOf(path.extname(entry.name).toLowerCase()) < 0) return;
      stats.scanned += 1;

      // ① 超过保留天数 -> 删除
      if (olderThanDays(full, opts.logKeepDays)) {
        safeUnlink(full, LOG_EXT, ctx);
        return;
      }

      // ② 体积超限 -> 只保留尾部若干行，避免单文件无限膨胀
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch (err) {
        return;
      }
      if (size <= maxBytes) return;
      if (opts.dryRun) {
        stats.wouldDelete += 1;
        return;
      }
      const verdict = assertDeletable(full, LOG_EXT);
      if (!verdict.ok) {
        stats.skipped += 1;
        stats.skipReasons[verdict.reason] = (stats.skipReasons[verdict.reason] || 0) + 1;
        return;
      }
      const trimmed = keepTailLines(full, opts.logKeepLines);
      if (trimmed) {
        stats.deleted += 1; // 记为「已处理」，实际是截断而非删除
      } else {
        stats.skipped += 1;
        stats.skipReasons['日志正被占用，重启后端后自动回收'] =
          (stats.skipReasons['日志正被占用，重启后端后自动回收'] || 0) + 1;
      }
    });
  });

  return stats;
}

/**
 * 把日志文件截断为「只保留最后 N 行」
 * 采用原地重写（r+）而不是删除重建：日志路径不会变，排查问题时仍能读到最近记录
 * @param {string} filePath
 * @param {number} keepLines
 * @returns {boolean} 是否处理成功
 */
function keepTailLines(filePath, keepLines) {
  let fd = null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - keepLines)).join('\r\n');
    const buffer = Buffer.from(tail, 'utf8');
    // r+：不改变文件句柄，原位覆写后再截断到新长度
    fd = fs.openSync(filePath, 'r+');
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.ftruncateSync(fd, buffer.length);
    return true;
  } catch (err) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err) { /* 忽略关闭异常 */ }
    }
  }
}

// ------------------------------ 3. 数据库轻量清理 ------------------------------

/**
 * 清理短信验证码表的历史记录
 * 短信通道已整体下线，sms_code 只剩历史数据：
 *   - 已过期超过保留期的
 *   - 已使用且超过保留期的
 * @param {object} options
 * @returns {Promise<object>} 统计结果
 */
async function cleanDatabase(options) {
  const opts = getOptions(options);
  const stats = newStats();
  try {
    const result = await db.query(
      `DELETE FROM sms_code
        WHERE (expire_time < DATE_SUB(NOW(), INTERVAL ? DAY))
           OR (used = 1 AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY))`,
      [opts.smsKeepDays, opts.smsKeepDays]
    );
    stats.deleted = result.affectedRows || 0;
  } catch (err) {
    stats.skipped += 1;
    stats.skipReasons[`短信表清理失败(${err.code || 'ERR'})`] = 1;
  }
  return stats;
}

// ------------------------------ 统一入口 ------------------------------

/**
 * 执行一轮完整清理
 * @param {object} [options] 覆盖默认配置（dryRun / 各类保留天数）
 * @returns {Promise<object>} 各子任务的统计结果
 */
async function runAll(options) {
  const opts = getOptions(options);
  const summary = { dryRun: opts.dryRun, orphan: null, trash: null, logs: null, database: null };

  if (!opts.enabled) {
    log('info', '[垃圾清理] CLEAN_ENABLED=false，已跳过');
    return summary;
  }

  summary.orphan = await cleanOrphanUploads(opts);
  summary.trash = purgeTrash(opts);
  summary.logs = cleanLogFiles(opts);
  summary.database = await cleanDatabase(opts);

  const action = opts.dryRun ? '待清理' : '已清理';
  log(
    'info',
    `[垃圾清理]${opts.dryRun ? '(空跑)' : ''} ` +
      `孤立图片：扫描 ${summary.orphan.scanned} 个，${action} ${opts.dryRun ? summary.orphan.wouldDelete : summary.orphan.deleted} 个；` +
      `回收站：${action} ${opts.dryRun ? summary.trash.wouldDelete : summary.trash.deleted} 个；` +
      `日志：${action} ${opts.dryRun ? summary.logs.wouldDelete : summary.logs.deleted} 个；` +
      `短信表记录：${summary.database.deleted} 条`
  );

  // 被跳过的原因也记一条，方便排查「为什么没清掉」（最常见的是当天日志被占用）
  const reasons = Object.assign({}, summary.logs.skipReasons);
  Object.keys(reasons).forEach((key) => {
    log('info', `[垃圾清理] 日志跳过原因：${key} × ${reasons[key]}`);
  });

  return summary;
}

module.exports = {
  UPLOAD_DIR,
  TRASH_DIR,
  ALLOWED_ROOTS,
  IMAGE_EXT,
  LOG_EXT,
  getOptions,
  listOrphans,
  isInsideAllowedRoot,
  hasForbiddenSegment,
  assertDeletable,
  normalizeUploadPath,
  collectReferencedFiles,
  listUploadImages,
  cleanOrphanUploads,
  purgeTrash,
  cleanLogFiles,
  cleanDatabase,
  runAll
};
