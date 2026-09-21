/**
 * =====================================================================
 * 数据库备份手动执行脚本
 * ---------------------------------------------------------------------
 * 定时任务每天 05:00 已经会自动备份（src/schedule/index.js -> jobBackupDb），
 * 本脚本用于「上线前手动存一份」「改数据库结构前先备份」这类需要立即备份的场景。
 *
 * 用法（必须在 backend 目录下执行，否则读不到 .env）：
 *   node scripts/backupDb.js                 真备份一次
 *   node scripts/backupDb.js --list          只看现有备份列表，不备份
 *   node scripts/backupDb.js --force         BACKUP_ENABLED=false 时也强制备份
 *   node scripts/backupDb.js --dir=D:\\bak   临时指定备份目录
 *   node scripts/backupDb.js --keep-days=7   临时指定保留天数
 *
 * 恢复方式（备份文件自带 CREATE DATABASE / USE，可直接整库还原）：
 *   mysql -u root -p < 备份文件.sql
 * =====================================================================
 */

// 必须最先加载 .env，dbBackup 读取 DB_* / BACKUP_* 都依赖它
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const dbBackup = require('../src/utils/dbBackup');

/** 解析命令行参数（只支持 --key=value 与 --flag 两种形式） */
function parseArgs(argv) {
  const args = { list: false, force: false };
  argv.forEach((item) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(item);
    if (!m) return;
    const key = m[1];
    const value = m[2];
    if (value === undefined) args[key] = true;
    else args[key] = value;
  });
  return args;
}

/** 列出备份目录里的 .sql 文件（按时间倒序，最新的在最前） */
function listBackups(dir) {
  if (!fs.existsSync(dir)) {
    console.log('备份目录不存在：' + dir + '（还没有执行过备份）');
    return [];
  }
  const files = fs.readdirSync(dir)
    .filter((name) => /^campus_errand_.*\.sql$/.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    console.log('备份目录里还没有备份文件：' + dir);
    return files;
  }
  console.log('备份目录：' + dir + '（共 ' + files.length + ' 个，保留 ' + dbBackup.getKeepDays() + ' 天）');
  files.forEach((f) => {
    const mb = (f.size / 1024 / 1024).toFixed(2);
    console.log('  ' + f.name + '  ' + mb + ' MB  ' + f.mtime.toLocaleString());
  });
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir ? path.resolve(args.dir) : dbBackup.getBackupDir();

  if (args.list) {
    listBackups(dir);
    return;
  }

  console.log('开始备份：' + process.env.DB_USER + '@' + process.env.DB_HOST + ':'
    + process.env.DB_PORT + '/' + process.env.DB_NAME);
  console.log('备份目录：' + dir);
  console.log('mysqldump：' + dbBackup.resolveMysqldump());

  const keepDays = args['keep-days'] ? Number(args['keep-days']) : undefined;
  const result = await dbBackup.runBackup({ dir, keepDays, force: !!args.force });

  if (!result.ok) {
    console.error('[备份失败] ' + result.reason);
    process.exitCode = 1;
    return;
  }
  console.log('[备份成功] ' + result.file);
  console.log('  文件大小：' + (result.size / 1024 / 1024).toFixed(2) + ' MB');
  if (result.removed) console.log('  同时清理了 ' + result.removed + ' 个超过 ' + (keepDays || dbBackup.getKeepDays()) + ' 天的旧备份');
  console.log('  恢复命令：mysql -u root -p < "' + result.file + '"');
}

main().catch((err) => {
  console.error('[备份异常] ' + err.message);
  process.exitCode = 1;
});
