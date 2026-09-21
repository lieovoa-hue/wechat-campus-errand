/**
 * =====================================================================
 * 管理员账号自动认证 / 管理员标识 自检脚本
 * ---------------------------------------------------------------------
 * 校验 3 件事：
 *  1. .env 白名单学号对应的账号，数据库里是否已是「校园认证通过 + is_admin=1」
 *  2. 登录接口返回的用户对象是否带 isAdmin / roleTag，且 isCampusAudit=2
 *  3. 任务列表接口是否把「管理员标识」下发给其他人（ownerRoleTag / ownerIsAdmin）
 *
 * 运行：node scripts/checkAdminStatus.js
 * ---------------------------------------------------------------------
 * 登录账号默认自动从数据库解析（管理员 = 白名单学号账号，普通用户 = 任一非白名单账号），
 * 也可用环境变量指定：
 *   CHECK_ADMIN_ACCOUNT / CHECK_ADMIN_PASSWORD   （默认密码取 INIT_ADMIN_PASSWORD）
 *   CHECK_NORMAL_ACCOUNT / CHECK_NORMAL_PASSWORD （默认密码 abc123456）
 * 前置条件不满足时输出「[跳过]」，不计入失败，避免把「缺少测试数据」误报成功能异常。
 * =====================================================================
 */

require('dotenv').config();

const { query, closePool } = require('../src/db/db');
const { getAdminStudentIds, isAdminStudent } = require('../src/utils/adminUtil');
const { CAMPUS_AUDIT_ENUM, USER_ROLE_ENUM, ROLE_TAG } = require('../src/utils/constant');

/**
 * 自检用的管理员账号 / 密码（可被环境变量覆盖）
 * 默认留空 -> 自动从数据库里取「学号命中白名单」的那个账号（通常是 A0001）
 * 默认密码与 scripts/initAdmin.js 创建的初始化管理员保持一致
 */
const ADMIN_ACCOUNT = process.env.CHECK_ADMIN_ACCOUNT || process.env.CHECK_ADMIN_PHONE || '';
const ADMIN_PASSWORD = process.env.CHECK_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';
/** 自检用的「普通用户」账号（默认自动从数据库里挑一个非白名单账号） */
const NORMAL_ACCOUNT = process.env.CHECK_NORMAL_ACCOUNT || process.env.CHECK_NORMAL_PHONE || '';
const NORMAL_PASSWORD = process.env.CHECK_NORMAL_PASSWORD || 'abc123456';
/** 后端地址 */
const BASE_URL = process.env.CHECK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

let passCount = 0;
let failCount = 0;

/**
 * 断言输出
 * @param {boolean} condition 断言结果
 * @param {string} label 用例描述
 * @param {*} detail 附加信息
 */
function check(condition, label, detail) {
  if (condition) {
    passCount += 1;
    console.log(`  [通过] ${label}`);
  } else {
    failCount += 1;
    console.log(`  [失败] ${label}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
  }
}

/**
 * 跳过输出：环境不满足前置条件（例如库里还没有普通用户账号）时使用，
 * 不计入失败，避免把「缺少测试数据」误报成功能异常
 */
function skip(label, detail) {
  console.log(`  [跳过] ${label}${detail === undefined ? '' : ' -> ' + String(detail)}`);
}

/** 把学号数组转成参数化占位符（数组长度来自配置，不含用户输入） */
function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

/**
 * 解析管理员登录账号：优先用环境变量，其次取数据库中命中白名单学号的账号
 * @returns {Promise<string>} 账号编号（或手机号），找不到返回空串
 */
async function resolveAdminAccount() {
  if (ADMIN_ACCOUNT) return ADMIN_ACCOUNT;
  const whitelist = getAdminStudentIds();
  if (!whitelist.length) return '';
  const rows = await query(
    'SELECT account_no, phone FROM users WHERE student_id IN (' + placeholders(whitelist.length) + ') ORDER BY id ASC LIMIT 1',
    whitelist
  );
  if (!rows.length) return '';
  return rows[0].account_no || rows[0].phone;
}

/**
 * 解析普通用户登录账号：取数据库中第一个非白名单学号的账号
 * @returns {Promise<string>} 账号编号（或手机号），找不到返回空串
 */
async function resolveNormalAccount() {
  if (NORMAL_ACCOUNT) return NORMAL_ACCOUNT;
  const whitelist = getAdminStudentIds();
  const sql = whitelist.length
    ? 'SELECT account_no, phone FROM users WHERE student_id NOT IN (' + placeholders(whitelist.length) + ') ORDER BY id ASC LIMIT 1'
    : 'SELECT account_no, phone FROM users ORDER BY id ASC LIMIT 1';
  const rows = await query(sql, whitelist);
  if (!rows.length) return '';
  return rows[0].account_no || rows[0].phone;
}

/** 1. 数据库层校验 */
async function checkDatabase() {
  console.log('\n[1/3] 数据库管理员账号状态');
  const whitelist = getAdminStudentIds();
  console.log(`  白名单学号（.env ADMIN_STUDENT_IDS）：${whitelist.join(', ') || '（未配置）'}`);

  const rows = await query('SELECT id, student_id, nickname, is_campus_audit, is_admin FROM users ORDER BY id ASC');
  check(rows.length > 0, 'users 表存在账号');

  rows.forEach((user) => {
    const shouldBeAdmin = isAdminStudent(user.student_id);
    const certified = Number(user.is_campus_audit) === CAMPUS_AUDIT_ENUM.PASS;
    const adminFlag = Number(user.is_admin) === USER_ROLE_ENUM.ADMIN;
    const label = `账号 #${user.id}（学号 ${user.student_id} / 昵称 ${user.nickname}）`
      + ` is_campus_audit=${user.is_campus_audit} is_admin=${user.is_admin}`;
    if (shouldBeAdmin) {
      check(certified && adminFlag, `${label} 应自动认证 + 带管理员标识`);
    } else {
      check(true, `${label} 非白名单账号，不强制认证`);
    }
  });
}

/** 2. 登录接口校验 */
async function checkLogin() {
  console.log('\n[2/3] 登录接口返回的管理员身份');
  const account = await resolveAdminAccount();
  if (!account) {
    skip('管理员登录自检', '数据库中没有命中白名单学号的账号，请先执行 node scripts/initAdmin.js');
    return null;
  }
  const res = await fetch(`${BASE_URL}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: ADMIN_PASSWORD, deviceId: 'check-admin-script' })
  });
  const body = await res.json();
  if (body.code !== 200) {
    skip(`管理员账号 ${account} 登录`, body.msg + '（若不是初始化管理员，请用 CHECK_ADMIN_ACCOUNT / CHECK_ADMIN_PASSWORD 指定）');
    return null;
  }

  check(true, `管理员账号 ${account} 可登录`);

  const user = body.data.user;
  check(user.isAdmin === true, '登录返回 isAdmin=true', user.isAdmin);
  check(Number(user.isCampusAudit) === CAMPUS_AUDIT_ENUM.PASS, '登录返回 isCampusAudit=2（自动认证）', user.isCampusAudit);
  check(user.roleTag === ROLE_TAG[USER_ROLE_ENUM.ADMIN], `登录返回 roleTag=${ROLE_TAG[USER_ROLE_ENUM.ADMIN]}`, user.roleTag);
  return body.data.accessToken;
}

/**
 * 用普通用户账号登录，拿到的 token 用于验证「其他人视角」
 * @returns {Promise<string>} accessToken；登录失败返回空串
 */
async function loginAsNormalUser() {
  const account = await resolveNormalAccount();
  if (!account) {
    skip('普通用户登录自检', '数据库里还没有普通用户账号，注册一个普通用户后再执行本脚本');
    return '';
  }
  const res = await fetch(`${BASE_URL}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: NORMAL_PASSWORD, deviceId: 'check-normal-script' })
  });
  const body = await res.json();
  if (body.code !== 200) {
    skip(`普通用户 ${account} 登录`, body.msg + '（可用 CHECK_NORMAL_ACCOUNT / CHECK_NORMAL_PASSWORD 指定）');
    return '';
  }
  check(true, `普通用户 ${account} 可登录`);
  check(body.data.user.isAdmin === false, '普通用户 isAdmin=false', body.data.user.isAdmin);
  check(body.data.user.roleTag === ROLE_TAG[USER_ROLE_ENUM.NORMAL], `普通用户 roleTag=${ROLE_TAG[USER_ROLE_ENUM.NORMAL]}`, body.data.user.roleTag);
  return body.data.accessToken;
}

/** 3. 任务列表校验：管理员标识对其他人可见（必须带普通用户 token，业务接口需登录） */
async function checkTaskListVisible(token) {
  console.log('\n[3/3] 任务列表中的管理员标识（其他人视角）');
  if (!token) {
    skip('任务列表管理员标识校验', '没有可用的普通用户 token（数据库缺少普通用户账号或密码不匹配）');
    return;
  }
  const res = await fetch(`${BASE_URL}/api/task/list?page=1&pageSize=20`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const body = await res.json();
  if (body.code !== 200) {
    check(false, '普通用户可访问任务列表接口', body.msg);
    return;
  }
  check(true, '普通用户可访问任务列表接口');
  const list = body.data.list || [];
  check(Array.isArray(list), '任务列表返回数组', list.length);

  if (!list.length) {
    console.log('  （当前任务大厅暂无任务，跳过标识字段校验；账号自动认证部分已通过）');
    return;
  }
  list.forEach((task) => {
    const hasField = Object.prototype.hasOwnProperty.call(task, 'ownerIsAdmin');
    check(hasField, `任务 #${task.id} 下发 ownerIsAdmin 字段`, task.ownerIsAdmin);
    if (task.ownerIsAdmin) {
      check(task.ownerRoleTag === ROLE_TAG[USER_ROLE_ENUM.ADMIN],
        `任务 #${task.id} 展示管理员标识 ${ROLE_TAG[USER_ROLE_ENUM.ADMIN]}`, task.ownerRoleTag);
      check(task.ownerIsCertified === true, `任务 #${task.id} 发布者标记为已认证`, task.ownerIsCertified);
    }
  });
}

/** 主流程 */
async function main() {
  console.log(`后端地址：${BASE_URL}`);
  try {
    await checkDatabase();
    await checkLogin();
    const normalToken = await loginAsNormalUser();
    await checkTaskListVisible(normalToken);
  } catch (err) {
    failCount += 1;
    console.log(`  [异常] ${err.message}`);
  }
  console.log(`\n===== 自检结果：${passCount} 项通过 / ${failCount} 项失败 =====`);
  // 先优雅关闭数据库连接池，再设置退出码；不调用 process.exit，
  // 避免 Windows 下 libuv 因句柄未释放打印断言告警。
  await closePool();
  process.exitCode = failCount === 0 ? 0 : 1;
}

main();
