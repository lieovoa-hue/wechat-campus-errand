/**
 * =====================================================================
 * 回归测试：垃圾清理器的「安全性」与「有效性」
 * ---------------------------------------------------------------------
 * 本脚本重点验证用户最关心的一件事：**绝不误删核心文件**。
 *   A. 安全护栏：白名单目录、扩展名白名单、受保护文件名、敏感目录黑名单、
 *      路径穿越、软链接、目录，全部必须被拒绝
 *   B. 引用保护：仍被数据库引用的图片，即使文件很老也绝不回收
 *   C. 时间闸门：未超过保留期的孤立文件不动
 *   D. 两步删除：先入回收站，滞留期满才真删
 *   E. 清理后核心文件与数据库业务数据必须原封不动
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const cleaner = require('../src/utils/garbageCleaner');
const db = require('../src/db/db');

let failed = false;
const out = [];
const check = (name, pass, detail) => {
  out.push(pass);
  if (!pass) failed = true;
  console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' -> ' + detail : ''));
};

const BACKEND_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..');
const UPLOAD_DIR = cleaner.UPLOAD_DIR;
const TRASH_DIR = cleaner.TRASH_DIR;
const BACKEND_LOG_DIR = path.join(BACKEND_DIR, 'logs');
const ROOT_LOG_DIR = path.join(PROJECT_ROOT, 'logs');

/** 造一个「修改时间在 N 天前」的文件 */
function makeOldFile(filePath, days, content = 'probe') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, past, past);
  return filePath;
}

/** 删除文件（忽略不存在） */
function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    /* 忽略 */
  }
}

/** 递归删除目录（仅用于清理本脚本自己造出来的测试目录） */
function removeDirIfExists(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* 忽略 */
  }
}

(async () => {
  const options = cleaner.getOptions({ dryRun: false });
  const created = []; // 记录本脚本创建的文件，测试结束统一清理

  // ==================== A. 安全护栏 ====================
  check('uploads 目录内文件属于允许清理范围', cleaner.isInsideAllowedRoot(path.join(UPLOAD_DIR, '202609', 'a.jpg')) === true);
  check('backend 日志目录属于允许清理范围', cleaner.isInsideAllowedRoot(path.join(BACKEND_LOG_DIR, 'x.log')) === true);
  check('项目根 logs 目录属于允许清理范围', cleaner.isInsideAllowedRoot(path.join(ROOT_LOG_DIR, 'keep-alive-20260101.log')) === true);
  check('后端源码目录不在允许范围', cleaner.isInsideAllowedRoot(path.join(BACKEND_DIR, 'src', 'app.js')) === false);
  check('.env 不在允许范围', cleaner.isInsideAllowedRoot(path.join(BACKEND_DIR, '.env')) === false);
  check('小程序目录不在允许范围', cleaner.isInsideAllowedRoot(path.join(PROJECT_ROOT, 'miniprogram', 'app.js')) === false);
  check('路径穿越后仍在白名单内才被接受', cleaner.isInsideAllowedRoot(path.join(UPLOAD_DIR, '..', 'src', 'app.js')) === false);
  check('白名单根目录本身不允许被删除', cleaner.isInsideAllowedRoot(UPLOAD_DIR) === false);

  check('敏感目录片段能被识别', cleaner.hasForbiddenSegment(path.join(BACKEND_DIR, 'node_modules', 'x', 'a.js')) === true);

  // 这些都必须被拒绝
  const mustReject = [
    [path.join(BACKEND_DIR, '.env'), '后端 .env'],
    [path.join(BACKEND_DIR, 'package.json'), 'package.json'],
    [path.join(BACKEND_DIR, 'src', 'app.js'), '后端入口源码'],
    [path.join(BACKEND_DIR, 'src', 'utils', 'garbageCleaner.js'), '清理器自身源码'],
    [path.join(PROJECT_ROOT, 'miniprogram', 'app.js'), '小程序入口'],
    [path.join(PROJECT_ROOT, 'miniprogram', 'images', 'tab', 'home.png'), 'tabBar 图标'],
    [path.join(PROJECT_ROOT, 'README.md'), 'README'],
    [path.join(PROJECT_ROOT, 'cpolar-url.txt'), 'cpolar 配置文件'],
    [path.join(ROOT_LOG_DIR, '_e2e_account.txt'), '联调账号记录'],
    [path.join(ROOT_LOG_DIR, 'cpolar.yml.bak'), 'cpolar 备份'],
    [path.join(UPLOAD_DIR, '.gitkeep'), 'uploads 占位文件'],
    [path.join(UPLOAD_DIR, '202609'), 'uploads 子目录（目录本身）'],
    [path.join(BACKEND_LOG_DIR, 'a.txt'), '日志目录里的非日志文件']
  ];
  mustReject.forEach((item) => {
    const verdict = cleaner.assertDeletable(item[0], cleaner.IMAGE_EXT.concat(cleaner.LOG_EXT));
    check(`拒绝删除：${item[1]}`, verdict.ok === false, verdict.ok ? '被错误放行！' : verdict.reason);
  });

  // ==================== B/C. 孤立判定 ====================
  // 造一个「10 天前上传、没有任何记录引用」的假图片
  const orphanName = `zzclean_test_orphan_${Date.now()}.jpg`;
  const orphanPath = makeOldFile(path.join(UPLOAD_DIR, '202609', orphanName), 10);
  created.push(orphanPath);

  // 再造一个「10 天前上传但刚创建、未过保留期」的假图片（保留期按 7 天算）
  const freshName = `zzclean_test_fresh_${Date.now()}.jpg`;
  const freshPath = path.join(UPLOAD_DIR, '202609', freshName);
  fs.writeFileSync(freshPath, 'probe');
  created.push(freshPath);

  const orphans = await cleaner.listOrphans(options);
  const orphanItem = orphans.find((item) => item.relative === `/uploads/202609/${orphanName}`);
  const freshItem = orphans.find((item) => item.relative === `/uploads/202609/${freshName}`);
  check('超期且无引用的图片被判定为可回收', !!orphanItem && orphanItem.deletable === true);
  check('未超期的图片不会被回收（时间闸门）', !!freshItem && freshItem.deletable === false);

  // 取一张真实被引用的图片：把它改成 30 天前，仍必须不可回收
  const referenced = await cleaner.collectReferencedFiles();
  const referencedList = Array.from(referenced);
  check('数据库中能取到被引用的图片清单', referencedList.length > 0, '共 ' + referencedList.length + ' 张');

  let referencedProbePath = '';
  let referencedProbeOriginalTime = null;
  if (referencedList.length) {
    referencedProbePath = path.join(UPLOAD_DIR, referencedList[0].replace('/uploads/', ''));
    if (fs.existsSync(referencedProbePath)) {
      const stat = fs.statSync(referencedProbePath);
      referencedProbeOriginalTime = stat.mtime;
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(referencedProbePath, past, past);
      const after = await cleaner.listOrphans(options);
      const item = after.find((one) => one.relative === referencedList[0]);
      check('仍被数据库引用的图片，即使 30 天前也不会被回收', !!item && item.deletable === false, item ? item.reason : '未找到');
    }
  }

  // ==================== D. 两步删除 ====================
  const beforeCount = fs.readdirSync(path.join(UPLOAD_DIR, '202609')).length;
  await cleaner.cleanOrphanUploads(options);
  const afterOrphanExists = fs.existsSync(orphanPath);
  const trashDayDir = path.join(TRASH_DIR, new Date().toISOString().slice(0, 10));
  const movedFiles = fs.existsSync(trashDayDir) ? fs.readdirSync(trashDayDir) : [];
  const moved = movedFiles.filter((name) => name.indexOf(orphanName) >= 0);

  check('孤立图片已从 uploads 移出', afterOrphanExists === false);
  check('孤立图片已进入回收站（可人工救回）', moved.length === 1, trashDayDir);
  check('未超期的图片原地未动', fs.existsSync(freshPath) === true);
  check('回收站内的当天文件不会被立即真删', moved.length === 1 && fs.existsSync(path.join(trashDayDir, moved[0])));
  check('uploads 文件数只减少 1 个', fs.readdirSync(path.join(UPLOAD_DIR, '202609')).length === beforeCount - 1);

  // 回收站滞留期满 -> 真删
  const oldTrashDir = path.join(TRASH_DIR, '2000-01-01');
  makeOldFile(path.join(oldTrashDir, 'old__probe.jpg'), 30);
  cleaner.purgeTrash(options);
  check('回收站中滞留期满的文件被真删', fs.existsSync(path.join(oldTrashDir, 'old__probe.jpg')) === false);
  removeDirIfExists(oldTrashDir);

  // 还原被改过时间的真实图片，避免影响真实业务
  if (referencedProbePath && referencedProbeOriginalTime) {
    try {
      fs.utimesSync(referencedProbePath, referencedProbeOriginalTime, referencedProbeOriginalTime);
    } catch (err) {
      /* 忽略 */
    }
  }

  // ==================== 日志清理 ====================
  const oldLog = makeOldFile(path.join(BACKEND_LOG_DIR, 'zzclean-old.log'), 30);
  const newLog = path.join(BACKEND_LOG_DIR, 'zzclean-new.log');
  fs.writeFileSync(newLog, 'keep me');
  const notLog = path.join(BACKEND_LOG_DIR, 'zzclean-keep.txt');
  fs.writeFileSync(notLog, 'keep me');
  created.push(newLog, notLog);

  cleaner.cleanLogFiles(options);
  check('超期日志被删除', fs.existsSync(oldLog) === false);
  check('未超期日志被保留', fs.existsSync(newLog) === true);
  check('日志目录里的非 .log 文件不动', fs.existsSync(notLog) === true);
  check(
    '核心日志目录本身未被删除',
    fs.existsSync(BACKEND_LOG_DIR) && fs.existsSync(ROOT_LOG_DIR)
  );

  // ==================== E. 全量执行后核心资产完好 ====================
  const usersBefore = await db.query('SELECT COUNT(*) AS c FROM users');
  await cleaner.runAll(cleaner.getOptions({ dryRun: false }));
  const usersAfter = await db.query('SELECT COUNT(*) AS c FROM users');
  check('清理后数据库用户数不变', usersBefore[0].c === usersAfter[0].c, `${usersBefore[0].c} -> ${usersAfter[0].c}`);

  const coreFiles = [
    path.join(BACKEND_DIR, '.env'),
    path.join(BACKEND_DIR, 'package.json'),
    path.join(BACKEND_DIR, 'src', 'app.js'),
    path.join(BACKEND_DIR, 'src', 'utils', 'garbageCleaner.js'),
    path.join(BACKEND_DIR, 'src', 'utils', 'constant.js'),
    path.join(PROJECT_ROOT, 'miniprogram', 'app.js'),
    path.join(PROJECT_ROOT, 'miniprogram', 'app.json'),
    path.join(PROJECT_ROOT, 'miniprogram', 'images', 'tab', 'home.png'),
    path.join(PROJECT_ROOT, 'cpolar-url.txt'),
    path.join(PROJECT_ROOT, 'README.md')
  ];
  const missing = coreFiles.filter((file) => !fs.existsSync(file));
  check('清理后全部核心文件依然存在', missing.length === 0, missing.length ? '缺失：' + missing.join(' , ') : '共校验 ' + coreFiles.length + ' 个');

  // 数据库中的图片引用仍然有效（抽查 10 张）
  const missingFiles = referencedList.slice(0, 10).filter((relative) => {
    return !fs.existsSync(path.join(UPLOAD_DIR, relative.replace('/uploads/', '')));
  });
  check('数据库引用的图片文件均未被删除（抽查10张）', missingFiles.length === 0, missingFiles.join(' , '));

  // ==================== 收尾：清理本脚本造出来的测试文件 ====================
  created.forEach(removeIfExists);
  removeIfExists(path.join(TRASH_DIR, new Date().toISOString().slice(0, 10), moved[0] || ''));
  removeIfExists(path.join(BACKEND_LOG_DIR, 'zzclean-old.log'));
  removeIfExists(path.join(BACKEND_LOG_DIR, 'zzclean-new.log'));
  removeIfExists(path.join(BACKEND_LOG_DIR, 'zzclean-keep.txt'));
  removeDirIfExists(TRASH_DIR);

  const pass = out.filter(Boolean).length;
  console.log('\n===== 垃圾清理器安全回归：' + pass + ' / ' + out.length + ' 项通过 =====');
})()
  .catch((err) => {
    console.error('异常', err.message, err.stack);
    failed = true;
  })
  .then(async () => {
    try {
      await db.closePool();
    } catch (err) {
      /* 忽略关闭异常 */
    }
    process.exit(failed ? 1 : 0);
  });
