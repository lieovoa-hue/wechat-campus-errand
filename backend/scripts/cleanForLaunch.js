/**
 * =====================================================================
 * 上线前数据清洁（保留管理员账号，其余业务数据全部清空）
 *   node scripts/cleanForLaunch.js --dry-run   # 只统计将要删除的数据，不落库
 *   node scripts/cleanForLaunch.js             # 真正执行删除
 * ---------------------------------------------------------------------
 * 保留：users 中 student_id = 环境变量 KEEP_ADMIN_STUDENT_ID（必填，无默认值）
 *       的管理员账号，以及它自己的 user_device 记录（避免下次登录被判为新设备）
 * 清空：tasks / payments / user_bill / messages / report / appeals /
 *       audit_apply / announcements / sms_code / user_kick
 *       + 非管理员的 users 与 user_device
 * ---------------------------------------------------------------------
 * 执行前建议先做一次备份：node scripts/backupDb.js
 * 空表同时重置自增，让上线后的第一笔订单从 1 开始编号。
 * =====================================================================
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
// 清空业务数据的表（按外键依赖顺序排列：先删子表）
const BUSINESS_TABLES = [
  'user_bill', 'payments', 'report', 'messages', 'appeals',
  'audit_apply', 'user_kick', 'tasks', 'announcements', 'sms_code'
];
// 自动化脚本用过的假 device_id（真实设备 ID 是 mp_ 开头的随机串，永远不会命中）
const FAKE_DEVICE_IDS = ['helper-admin-device', 'dev-C', 'admin-dev', 'admin-device', 'check-admin-script', 'regression-device'];

// 允许重置自增的表（user_device / users 会保留管理员数据，不能重置）
const RESET_AI_TABLES = BUSINESS_TABLES;

(async () => {
  const keepStudentId = String(process.env.KEEP_ADMIN_STUDENT_ID || '').trim();
  if (!keepStudentId) {
    console.error('[中止] 请先在 backend/.env 里设置 KEEP_ADMIN_STUDENT_ID（要保留的管理员学号），避免误删全部用户');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'campus_errand'
  });

  const [admins] = await conn.execute(
    'SELECT id, account_no, nickname FROM users WHERE student_id = ?',
    [keepStudentId]
  );
  if (!admins.length) {
    console.error('[中止] 没有找到学号为 ' + keepStudentId + ' 的管理员账号，为避免误删全部用户已停止执行');
    await conn.end();
    process.exit(1);
  }
  const keepIds = admins.map((r) => r.id);
  console.log('保留管理员：' + admins.map((r) => r.id + '/' + r.account_no + '/' + r.nickname).join(', '));

  const [[{ keepUsers }]] = await conn.query(
    'SELECT COUNT(*) AS keepUsers FROM users WHERE id IN (' + keepIds.join(',') + ')'
  );
  const [[{ delUsers }]] = await conn.query(
    'SELECT COUNT(*) AS delUsers FROM users WHERE id NOT IN (' + keepIds.join(',') + ')'
  );
  console.log('用户表：保留 ' + keepUsers + ' 条，删除 ' + delUsers + ' 条');

  for (const t of BUSINESS_TABLES) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM `' + t + '`');
    console.log('  ' + t.padEnd(14) + ' 待清空 ' + n + ' 条');
  }
  const [[{ dv }]] = await conn.query(
    'SELECT COUNT(*) AS dv FROM user_device WHERE user_id NOT IN (' + keepIds.join(',') + ')'
  );
  console.log('  user_device    待清空 ' + dv + ' 条（保留管理员设备）');

  if (DRY_RUN) {
    console.log('--dry-run 模式：未做任何修改');
    await conn.end();
    return;
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of BUSINESS_TABLES) {
    await conn.query('DELETE FROM `' + t + '`');
    if (RESET_AI_TABLES.indexOf(t) >= 0) {
      await conn.query('ALTER TABLE `' + t + '` AUTO_INCREMENT = 1');
    }
  }
  await conn.query('DELETE FROM user_device WHERE user_id NOT IN (' + keepIds.join(',') + ')');
  await conn.query('DELETE FROM users WHERE id NOT IN (' + keepIds.join(',') + ')');
  // 自动化脚本登录留下的「假设备」记录，保留下来会让「我的 → 设备管理」页显示
  // 一堆陌生设备，反而吓到用户，这里一并清掉（真实手机 / 开发者工具不受影响）。
  if (FAKE_DEVICE_IDS.length) {
    await conn.query(
      'DELETE FROM user_device WHERE device_id IN (' + FAKE_DEVICE_IDS.map(() => '?').join(',') + ')',
      FAKE_DEVICE_IDS
    );
    console.log('已清理自动化测试设备记录 ' + FAKE_DEVICE_IDS.length + ' 类');
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 保留账号如果引用了已被删掉的图片（头像 / 校园认证图），一并清空，
  // 否则「垃圾清理」定时任务会一直看到悬空引用，前端也会显示裂图。
  const [keptUsers] = await conn.query(
    'SELECT id, avatar, campus_cert_img FROM users WHERE id IN (' + keepIds.join(',') + ')'
  );
  const fsMod = require('fs');
  const uploadsRoot = require('path').join(__dirname, '..');
  let clearedImgs = 0;
  for (const u of keptUsers) {
    const patch = {};
    for (const field of ['avatar', 'campus_cert_img']) {
      const val = u[field] || '';
      if (!val || val.indexOf('/uploads/') < 0) continue;
      const abs = require('path').join(uploadsRoot, (val.charAt(0) === '/' ? val.slice(1) : val).split('?')[0]);
      if (!fsMod.existsSync(abs)) patch[field] = '';
    }
    const keys = Object.keys(patch);
    if (!keys.length) continue;
    await conn.query(
      'UPDATE users SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?',
      keys.map((k) => patch[k]).concat([u.id])
    );
    clearedImgs += keys.length;
  }
  console.log('保留账号的悬空图片引用已清空：' + clearedImgs + ' 处');

  console.log('数据清洁完成：业务数据已清空，仅保留管理员账号与它的设备记录');
  await conn.end();
})().catch((e) => { console.error('清洁异常：', e.message); process.exit(1); });
