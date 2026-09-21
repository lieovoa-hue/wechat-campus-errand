/**
 * =====================================================================
 * 垃圾文件清理命令行工具
 * ---------------------------------------------------------------------
 * 用法（在 backend 目录下执行）：
 *   node scripts/cleanGarbage.js              按 .env 配置执行一轮清理
 *   node scripts/cleanGarbage.js --dry-run    只统计不删除（先看清单再决定）
 *   node scripts/cleanGarbage.js --list       额外列出每个待回收文件
 *   node scripts/cleanGarbage.js --days=3     本次把「孤立图片保留期」改成 3 天
 *   node scripts/cleanGarbage.js --apply      忽略 .env 的 CLEAN_DRY_RUN，强制真删
 *
 * 安全说明（详见 src/utils/garbageCleaner.js 头部注释）：
 *   只认三个白名单目录（uploads / backend\logs / logs）、只删白名单扩展名、
 *   只删「数据库里没有任何记录引用」且「超过保留期」的图片，
 *   且图片是先移进 uploads\.trash 回收站、滞留期满才真删，随时可以人工救回。
 * =====================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const cleaner = require('../src/utils/garbageCleaner');

/** 解析命令行参数 */
function parseArgs(argv) {
  const args = { dryRun: null, list: false, days: null, json: false };
  argv.forEach((raw) => {
    const arg = String(raw || '');
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--apply') args.dryRun = false;
    else if (arg === '--list' || arg === '-l') args.list = true;
    else if (arg === '--json') args.json = true;
    else if (arg.indexOf('--days=') === 0) {
      const value = Number(arg.slice('--days='.length));
      if (Number.isFinite(value) && value >= 0) args.days = value;
    }
  });
  return args;
}

/** 字节数转成人类可读文本 */
function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(2) + ' MB';
}

/** 打印一个子任务的统计行 */
function printStat(name, stats, dryRun) {
  if (!stats) return;
  const acted = dryRun ? stats.wouldDelete : stats.deleted;
  const lines = [
    `  ${name}：扫描 ${stats.scanned} 个，${dryRun ? '待处理' : '已处理'} ${acted} 个，释放 ${formatSize(stats.bytes)}`
  ];
  const reasons = Object.keys(stats.skipReasons || {});
  if (reasons.length) {
    lines.push('    跳过原因：' + reasons.map((r) => `${r}×${stats.skipReasons[r]}`).join('，'));
  }
  lines.forEach((line) => console.log(line));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const override = {};
  if (args.dryRun !== null) override.dryRun = args.dryRun;
  if (args.days !== null) override.orphanKeepDays = args.days;

  const options = cleaner.getOptions(override);

  console.log('==============================================================');
  console.log(' 校园跑腿 · 垃圾文件清理');
  console.log(` 模式：${options.dryRun ? '空跑（只统计，不删除）' : '实际执行'}`);
  console.log(` 孤立图片保留：${options.orphanKeepDays} 天 | 回收站滞留：${options.trashKeepDays} 天`);
  console.log(` 日志保留：${options.logKeepDays} 天 | 单日志上限：${options.logMaxMb} MB`);
  console.log('==============================================================');

  // --list 时先把「待回收清单」打出来，方便人工确认
  if (args.list) {
    const all = await cleaner.listOrphans(options);
    const targets = all.filter((item) => item.deletable);
    const kept = all.filter((item) => !item.deletable);
    console.log(`\n【待回收清单】共 ${targets.length} 个`);
    targets.forEach((item) => {
      console.log(`  - ${item.relative}  ${formatSize(item.size)}  修改于 ${item.mtime.toLocaleString('zh-CN')}`);
    });
    console.log(`\n【保留清单】共 ${kept.length} 个（仍被引用 / 未过保留期）`);
    kept.slice(0, 20).forEach((item) => {
      console.log(`  - ${item.relative}  ${item.reason || '未超过保留期'}`);
    });
    if (kept.length > 20) console.log(`  …… 其余 ${kept.length - 20} 个省略`);
    console.log('');
  }

  const summary = await cleaner.runAll(options);

  if (!args.json) {
    console.log('\n----------------------------- 结果 -----------------------------');
    printStat('孤立图片', summary.orphan, options.dryRun);
    printStat('回收站', summary.trash, options.dryRun);
    printStat('日志文件', summary.logs, options.dryRun);
    if (summary.database) {
      console.log(`  短信验证码表：清理 ${summary.database.deleted} 条历史记录`);
    }
    console.log('----------------------------------------------------------------');
    if (options.dryRun) {
      console.log('当前是空跑模式，文件未做任何改动。确认无误后执行：');
      console.log('  node scripts/cleanGarbage.js --apply');
    }
    console.log('');
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
})()
  .catch((err) => {
    console.error('清理异常：', err.message);
    process.exitCode = 1;
  })
  .then(async () => {
    // 连接池不关，进程会一直挂着不退出
    try {
      await require('../src/db/db').closePool();
    } catch (err) {
      /* 忽略关闭异常 */
    }
  });
