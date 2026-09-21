/**
 * =====================================================================
 * 清空全部业务数据 + 创建一个指定的管理员账号
 * ---------------------------------------------------------------------
 * 做三件事：
 *   1. 自动补齐 users.account_no 列（老库升级，全新库为空操作）
 *   2. TRUNCATE 全部 9 张表，把之前注册的所有账号、任务、账单、认证、登录记录
 *      彻底清空，并把自增主键重置回 1（普通用户重新从 X0001 开始发号）
 *   3. 写入一个管理员账号（绕过注册接口的手机号格式校验）
 *
 * 管理员账号（可用环境变量覆盖）：
 *   账号编号 account_no = A0001
 *   手机号   phone      = 见 .env 的 INIT_ADMIN_PHONE
 *   学号     student_id = 见 .env 的 INIT_ADMIN_STUDENT_ID   <- 必须同时在 .env 的 ADMIN_STUDENT_IDS 白名单里
 *   密码     password   = 见 .env 的 INIT_ADMIN_PASSWORD
 *   主键 id             = 由 AUTO_INCREMENT 自动生成（清库后为 1），也可用 INIT_ADMIN_ID 指定
 *
 * 运行：node scripts/initAdmin.js
 *
 * 说明：登录页「账号」输入框输入 A0001（大小写均可）或对应学号都能登录该管理员；
 *      该账号学号命中白名单，后端会自动把它标记为「校园认证通过 + 管理员标识」，
 *      其他用户在任务详情里也能看到该管理员标识。
 * =====================================================================
 */

require('dotenv').config();

const crypto = require('crypto');
const db = require('../src/db/db');
const { hashPassword } = require('../src/utils/bcryptUtil');
const { getAdminStudentIds } = require('../src/utils/adminUtil');
const { ensureAccountNoColumn } = require('../src/db/ensureSchema');
const { buildAccountNo } = require('../src/utils/common');

/** 需要清空的表（子表在前，父表在后；TRUNCATE 会顺带把 AUTO_INCREMENT 重置为 1） */
const TABLES = [
  'user_bill', 'payments', 'report', 'messages',
  'appeals', 'audit_apply', 'tasks', 'sms_code', 'users'
];

/** 管理员账号信息 */
const ADMIN = {
  // 账号编号固定 A0001（第一个管理员）
  accountNo: process.env.INIT_ADMIN_ACCOUNT_NO || buildAccountNo(1, true),
  // 指定主键时使用指定值，否则交给 AUTO_INCREMENT 自增
  id: process.env.INIT_ADMIN_ID ? Number(process.env.INIT_ADMIN_ID) : null,
  phone: required('INIT_ADMIN_PHONE', process.env.INIT_ADMIN_PHONE),
  studentId: required('INIT_ADMIN_STUDENT_ID', process.env.INIT_ADMIN_STUDENT_ID),
  password: required('INIT_ADMIN_PASSWORD', process.env.INIT_ADMIN_PASSWORD),
  name: process.env.INIT_ADMIN_NAME || '系统管理员',
  nickname: process.env.INIT_ADMIN_NICKNAME || '系统管理员'
};

/** 读取必填的环境变量（真实值只写在 .env，源码里不留任何凭据） */
function required(name, value) {
  const v = String(value || '').trim();
  if (!v) {
    console.error('[中止] 缺少环境变量 ' + name + '，请先在 backend/.env 里设置后再执行');
    process.exit(1);
  }
  return v;
}

/** 生成专属邀请码（唯一索引冲突时重试） */
async function generateUniqueInviteCode(conn) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i += 1) {
    let code = '';
    for (let j = 0; j < 8; j += 1) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    const [rows] = await conn.execute('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
}

(async () => {
  // ---------------- 0. 结构自愈：确保 account_no 列存在 ----------------
  await ensureAccountNoColumn();

  const conn = await db.getConnection();
  try {
    // ---------------- 1. 清空全部数据 ----------------
    console.log('\n[1/3] 清空全部业务数据（账号 / 认证 / 登录 / 任务 / 账单 / 消息等）...');
    const [before] = await conn.query('SELECT COUNT(*) AS total FROM users');
    console.log(`      清空前 users 表共 ${before[0].total} 个账号`);

    // 关掉外键检查才能按任意顺序 TRUNCATE 有外键关联的表
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await conn.query('TRUNCATE TABLE `' + table + '`');
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`      已清空 ${TABLES.length} 张表，自增主键已重置`);

    // ---------------- 2. 创建管理员账号 ----------------
    console.log('\n[2/3] 创建管理员账号...');
    const passwordHash = await hashPassword(ADMIN.password);
    const inviteCode = await generateUniqueInviteCode(conn);

    // is_campus_audit=2 表示校园认证通过；is_admin=1 仅用于前端标识展示，
    // 真正的管理员权限判定始终走 .env 学号白名单（adminAuth 中间件）。
    const useFixedId = Number.isInteger(ADMIN.id) && ADMIN.id > 0;
    const sql = useFixedId
      ? `INSERT INTO users
           (id, account_no, student_id, password_hash, name, phone, nickname, nickname_modify_count,
            avatar, is_avatar_audit, campus_cert_img, is_campus_audit, is_admin, invite_code,
            ban_take_time, login_fail_count, login_lock_time, last_login_time, login_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, '', 2, 1, ?, NULL, 0, NULL, NULL, '')`
      : `INSERT INTO users
           (account_no, student_id, password_hash, name, phone, nickname, nickname_modify_count,
            avatar, is_avatar_audit, campus_cert_img, is_campus_audit, is_admin, invite_code,
            ban_take_time, login_fail_count, login_lock_time, last_login_time, login_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, '', 2, 1, ?, NULL, 0, NULL, NULL, '')`;

    const baseParams = [
      ADMIN.accountNo, ADMIN.studentId, passwordHash, ADMIN.name,
      ADMIN.phone, ADMIN.nickname, 1, inviteCode
    ];
    const [result] = await conn.execute(sql, useFixedId ? [ADMIN.id].concat(baseParams) : baseParams);
    const adminId = useFixedId ? ADMIN.id : result.insertId;

    const [rows] = await conn.execute(
      'SELECT id, account_no, student_id, phone, nickname, is_campus_audit, is_admin, invite_code FROM users WHERE id = ?',
      [adminId]
    );
    console.log('      已创建：', JSON.stringify(rows[0]));

    // ---------------- 3. 自检 ----------------
    console.log('\n[3/3] 白名单自检');
    const whitelist = getAdminStudentIds();
    const inWhitelist = whitelist.includes(String(ADMIN.studentId));
    console.log(`      .env ADMIN_STUDENT_IDS = ${whitelist.join(', ') || '（未配置）'}`);
    if (inWhitelist) {
      console.log('      [OK] 学号已命中白名单，重启后端后该账号会被识别为管理员');
    } else {
      console.log(`      [!!] 学号 ${ADMIN.studentId} 不在白名单中！`);
      console.log(`           请把 backend/.env 的 ADMIN_STUDENT_IDS 改成包含 ${ADMIN.studentId}，然后重启后端`);
    }

    console.log('\n===== 管理员登录信息 =====');
    console.log(`账号编号：${rows[0].account_no}（登录页「账号」输入框可直接输入该编号）`);
    console.log(`手机号：${ADMIN.phone}    学号：${ADMIN.studentId}`);
    console.log(`数据库主键 id：${adminId}`);
    console.log(`密码：${ADMIN.password}`);
    console.log('普通用户注册后会按 X0001、X0002 ... 顺序自动分配账号编号\n');
  } finally {
    conn.release();
    await db.closePool();
  }
})().catch((err) => {
  console.error('执行失败：', err.message);
  process.exit(1);
});
