/**
 * =====================================================================
 * 用户数据访问层（users）
 * 所有 SQL 均为参数化查询；需要参与事务的方法统一支持传入 conn
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const crypto = require('crypto');
const { formatUserId, maskPhone, buildAccountNo, BizError, toInt } = require('../utils/common');
const {
  BIZ, CAMPUS_AUDIT_ENUM, USER_ROLE_ENUM, ACCOUNT_NO_RULE, NICKNAME_COUNT_UNLIMITED, DEACTIVATED_NAME,
  SECURITY_STATUS, getText
} = require('../utils/constant');

/** 密保设置状态（与 constant.js 中 SECURITY_STATUS 的键保持一致） */
const SECURITY_SET_UNSET = 0;
const SECURITY_SET_DONE = 1;
// 管理员判定统一走白名单工具，models 层也需要（登录 / 鉴权时自动认证管理员账号）
const { isAdminStudent, roleTagOf, getAdminStudentIds, buildPlaceholders } = require('../utils/adminUtil');

/**
 * 执行 SQL 的统一入口：有事务连接用事务连接，没有则用连接池
 * @param {object|null} conn 事务连接
 * @param {string} sql 参数化 SQL
 * @param {Array} params 参数
 */
async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/** 可对外输出的用户字段（绝不包含 password_hash） */
const SAFE_FIELDS = [
  'id', 'account_no', 'student_id', 'name', 'phone', 'nickname', 'nickname_modify_count',
  'avatar', 'is_avatar_audit', 'campus_cert_img', 'is_campus_audit', 'is_admin',
  'invite_code', 'invited_by', 'invite_code_used',
  'free_delivery_count', 'free_delivery_expire', 'free_delivery_used_at', 'publish_coupon_count',
  'ban_take_time', 'login_lock_time', 'deactivated_at', 'last_login_time', 'created_at'
  , 'security_set', 'sec_question1', 'sec_question2', 'security_lock_time', 'security_updated_at'
].join(', ');

/** 按主键查询（含密码哈希，仅内部使用） */
function findById(id, conn = null) {
  return run(conn, 'SELECT * FROM users WHERE id = ? LIMIT 1', [id]).then((rows) => rows[0] || null);
}

/** 按主键加行锁查询（事务内防并发使用） */
function findByIdForUpdate(id, conn) {
  return run(conn, 'SELECT * FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [id]).then((rows) => rows[0] || null);
}

/** 按手机号查询（含密码哈希） */
function findByPhone(phone, conn = null) {
  return run(conn, 'SELECT * FROM users WHERE phone = ? LIMIT 1', [phone]).then((rows) => rows[0] || null);
}

/**
 * 按账号编号查询（A0001 / X0001，大小写不敏感）
 * @param {string} accountNo 账号编号
 */
function findByAccountNo(accountNo, conn = null) {
  const account = String(accountNo || '').trim().toUpperCase();
  return run(conn, 'SELECT * FROM users WHERE account_no = ? LIMIT 1', [account]).then((rows) => rows[0] || null);
}

/** 按学号查询 */
function findByStudentId(studentId, conn = null) {
  const sid = String(studentId === undefined || studentId === null ? '' : studentId).trim();
  // 空学号直接返回 null：注册阶段不再采集学号，users.student_id 可能为空串，
  // 若不拦截会出现「按空学号匹配到任意未认证账号」的越权风险。
  if (!sid) return Promise.resolve(null);
  return run(conn, 'SELECT * FROM users WHERE student_id = ? LIMIT 1', [sid]).then((rows) => rows[0] || null);
}

/**
 * 按学号查询全部账号（学号登录用）
 * 学号在「校园认证通过」后才全局唯一；认证前注册初始值为空串，因此这里只做
 * 「最多 5 条」的探测：命中 1 条才允许登录，命中多条提示改用账号ID登录。
 * @param {string} studentId 学号
 * @param {object|null} conn 事务连接
 * @returns {Promise<object[]>} 账号列表
 */
function findAllByStudentId(studentId, conn = null) {
  const sid = String(studentId === undefined || studentId === null ? '' : studentId).trim();
  if (!sid) return Promise.resolve([]);
  return run(conn, 'SELECT * FROM users WHERE student_id = ? LIMIT 5', [sid]);
}

/**
 * 账号ID是否已被占用（注册时自选账号ID的唯一性校验，大小写不敏感）
 * @param {string} accountNo 账号ID，如 X0001
 * @param {object|null} conn
 * @returns {Promise<boolean>}
 */
function isAccountNoTaken(accountNo, conn = null) {
  const account = String(accountNo || '').trim().toUpperCase();
  if (!account) return Promise.resolve(false);
  return run(conn, 'SELECT id FROM users WHERE account_no = ? LIMIT 1', [account]).then((rows) => rows.length > 0);
}

/**
 * 随机生成一个未被占用的账号ID（注册页「随机生成」按钮调用）
 * 规则：前缀固定 X（普通用户），后 4 位取 0001~9999 的随机数，与人工填写走完全相同的唯一性校验。
 * @param {object|null} conn
 * @returns {Promise<string>} 可用账号ID；极端情况下返回空串由调用方兜底
 */
async function randomAvailableAccountNo(conn = null) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = buildAccountNo(crypto.randomInt(1, 10000), false);
    const taken = await isAccountNoTaken(candidate, conn);
    if (!taken) return candidate;
  }
  return '';
}

/**
 * 按邀请码查询用户（注册时填写邀请码 -> 定位邀请人）
 * @param {string} inviteCode 邀请码（大小写不敏感，统一按大写查询）
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>} 邀请人用户行，不存在返回 null
 */
function findByInviteCode(inviteCode, conn = null) {
  const code = String(inviteCode || '').trim().toUpperCase();
  if (!code) return Promise.resolve(null);
  return run(conn, 'SELECT * FROM users WHERE invite_code = ? LIMIT 1', [code]).then((rows) => rows[0] || null);
}

/**
 * 按手机号查询「除自己以外」的账号（管理员改手机号时的唯一性校验）
 * @param {string} phone 目标手机号
 * @param {number} exceptId 排除的用户主键（通常是当前被修改的用户）
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>} 命中其他账号时返回该账号，未占用返回 null
 */
function findByPhoneExcept(phone, exceptId, conn = null) {
  return run(
    conn,
    'SELECT id, account_no, phone FROM users WHERE phone = ? AND id <> ? LIMIT 1',
    [phone, exceptId]
  ).then((rows) => rows[0] || null);
}

/**
 * 按学号查询「除自己以外」的账号（管理员改学号时的唯一性校验）
 * @param {string} studentId 目标学号
 * @param {number} exceptId 排除的用户主键
 * @param {object|null} conn 事务连接
 */
function findByStudentIdExcept(studentId, exceptId, conn = null) {
  return run(
    conn,
    'SELECT id, account_no, student_id FROM users WHERE student_id = ? AND id <> ? LIMIT 1',
    [studentId, exceptId]
  ).then((rows) => rows[0] || null);
}

/**
 * 管理员：按 账号ID / 学号 / 手机号 / 主键ID / 昵称 / 姓名 精确定位用户
 * 用于「封禁管理」中通过搜索框快速找到目标用户（全部参数化查询，绝不拼接 SQL）
 * 说明：账号ID 统一按大写比较（A0001），主键 ID 用 CAST 转字符串后等值比较，
 *      返回最多 5 条，由控制器判断是否匹配到多个用户。
 * @param {string} keyword 关键词
 * @param {object|null} conn 事务连接
 * @returns {Promise<Array>} 用户行数组（含封禁相关字段）
 */
function findByKeyword(keyword, conn = null) {
  const key = String(keyword || '').trim();
  if (!key) return Promise.resolve([]);
  const sql = 'SELECT ' + SAFE_FIELDS + ", ban_reason, ban_operator_id, ban_created_at FROM users"
    + ' WHERE account_no = ? OR phone = ? OR student_id = ? OR CAST(id AS CHAR) = ? OR nickname = ? OR name = ?'
    + ' ORDER BY id ASC LIMIT 5';
  return run(conn, sql, [key.toUpperCase(), key, key, key, key, key]);
}

/**
 * 查询是否存在「其他账号」已完成校园认证且使用目标学号（校园认证唯一性校验）
 * @param {string} studentId 目标学号
 * @param {number} selfUserId 当前用户（排除自身）
 * @param {object|null} conn
 */
async function findCertifiedByStudentId(studentId, selfUserId, conn = null) {
  const rows = await run(
    conn,
    'SELECT id, student_id FROM users WHERE is_campus_audit = ? AND student_id = ? AND id <> ? LIMIT 1',
    [2, studentId, selfUserId]
  );
  return rows[0] || null;
}

// ------------------------- 管理员账号自动认证 -------------------------

/**
 * 管理员账号自动认证
 * 命中 .env ADMIN_STUDENT_IDS 学号白名单的账号，自动置为「校园认证通过」并打上管理员标识。
 * 注意：users.is_admin 仅用于前端标识展示，后台权限判定始终走 adminAuth 白名单中间件，
 *       因此即使有人非法把 is_admin 改成 1，也拿不到任何管理员接口权限。
 * @param {object} user 用户行（命中白名单且状态不符时会被原地更新，当前请求内立即生效）
 * @param {object|null} conn 事务连接
 * @returns {Promise<object>} 用户行（可能已就地更新）
 */
async function autoCertifyAdmin(user, conn = null) {
  if (!user || !isAdminStudent(user.student_id)) return user;

  const certPassed = Number(user.is_campus_audit) === CAMPUS_AUDIT_ENUM.PASS;
  const adminFlagged = Number(user.is_admin) === USER_ROLE_ENUM.ADMIN;
  // 已是目标状态则不再产生写操作，避免每次请求都 UPDATE
  if (certPassed && adminFlagged) return user;

  await run(
    conn,
    'UPDATE users SET is_campus_audit = ?, is_admin = ? WHERE id = ?',
    [CAMPUS_AUDIT_ENUM.PASS, USER_ROLE_ENUM.ADMIN, user.id]
  );
  user.is_campus_audit = CAMPUS_AUDIT_ENUM.PASS;
  user.is_admin = USER_ROLE_ENUM.ADMIN;
  return user;
}

/**
 * 批量同步全部管理员账号（后端启动时执行一次，重启后立即生效，无需逐个登录触发）
 * 条件更新：仅修正状态不符的账号，已是目标状态的账号不会被重复写入
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function syncAdminAccounts(conn = null) {
  const studentIds = getAdminStudentIds();
  if (!studentIds.length) return 0;

  const sql = `UPDATE users
      SET is_campus_audit = ?, is_admin = ?
    WHERE student_id IN (${buildPlaceholders(studentIds.length)})
      AND (is_campus_audit <> ? OR is_admin <> ?)`;
  const params = [CAMPUS_AUDIT_ENUM.PASS, USER_ROLE_ENUM.ADMIN]
    .concat(studentIds, [CAMPUS_AUDIT_ENUM.PASS, USER_ROLE_ENUM.ADMIN]);

  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.affectedRows || 0;
  }
  const result = await execute(sql, params);
  return result.affectedRows || 0;
}

/**
 * 计算下一个普通用户账号编号序号（普通用户从 X0001 开始）
 * 取已存在的 X 开头编号中的最大序号 + 1；没有任何普通用户时从 1 开始
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>}
 */
async function nextNormalAccountSeq(conn = null) {
  const rows = await run(
    conn,
    'SELECT COALESCE(MAX(CAST(SUBSTRING(account_no, 2) AS UNSIGNED)), 0) AS maxSeq FROM users WHERE account_no LIKE ?',
    [ACCOUNT_NO_RULE.NORMAL_PREFIX + '%']
  );
  const maxSeq = rows[0] ? Number(rows[0].maxSeq) : 0;
  return (Number.isFinite(maxSeq) ? maxSeq : 0) + 1;
}

/**
 * 创建用户
 * 账号编号（account_no）由后端生成：普通用户 X0001 起按注册顺序递增。
 * 并发兜底：account_no 建有唯一索引，若极端并发下算出相同编号，
 *           MySQL 会抛出 ER_DUP_ENTRY，这里捕获后自动取下一个序号重试。
 * @param {object} data { student_id, password_hash, name, phone, nickname, invite_code, account_no? }
 * @param {object|null} conn
 * @returns {Promise<number>} 新用户 id
 */
async function create(data, conn = null) {
  const sql = 'INSERT INTO users (account_no, student_id, password_hash, name, phone, nickname, nickname_modify_count, invite_code, last_login_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 指定了账号编号（例如初始化管理员 A0001）则直接使用，否则按当前最大序号递增
    const accountNo = data.account_no || buildAccountNo((await nextNormalAccountSeq(conn)) + attempt, false);
    const params = [
      accountNo,
      data.student_id,
      data.password_hash,
      data.name,
      // 手机号已改为选填：未填写时必须写 NULL 而不是空串，
      // 否则 MySQL 唯一索引会把「第二个没填手机号的用户」判成手机号重复（多个 NULL 才会被允许）
      data.phone ? data.phone : null,
      data.nickname,
      data.nickname_modify_count === undefined ? 1 : data.nickname_modify_count,
      data.invite_code || null
    ];
    try {
      if (conn) {
        const [result] = await conn.execute(sql, params);
        return result.insertId;
      }
      const result = await execute(sql, params);
      return result.insertId;
    } catch (err) {
      const message = String((err && (err.sqlMessage || err.message)) || '');
      // 仅当「账号编号」冲突且编号是自动生成时才重试；其它错误（手机号/学号重复）原样抛出
      const accountNoConflict = err && err.code === 'ER_DUP_ENTRY' && message.indexOf('account_no') >= 0;
      if (accountNoConflict && !data.account_no && attempt < 4) {
        continue;
      }
      throw err;
    }
  }
  throw new BizError('账号编号生成失败，请稍后重试', 500);
}

/** 更新密码（忘记密码 / 重置密码） */
function updatePassword(userId, passwordHash, conn = null) {
  return run(conn, 'UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

/**
 * 管理员重置用户登录密码（与「忘记密码」保持同一套安全收尾动作）
 *   1. 写入新的 bcrypt 哈希（数据库永远不出现明文密码）
 *   2. 清零连续密码错误次数
 *   3. 解除登录锁定（被锁定的账号重置密码后立刻可用）
 *   4. 清空设备标识 -> 旧设备持有的 access_token 立即失效，必须用新密码重新登录
 * @param {number} userId 目标用户主键
 * @param {string} passwordHash bcrypt 哈希
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
function resetPasswordByAdmin(userId, passwordHash, conn = null) {
  return run(
    conn,
    'UPDATE users SET password_hash = ?, login_fail_count = 0, login_lock_time = NULL, login_device_id = ? WHERE id = ?',
    [passwordHash, '', userId]
  );
}

/**
 * 统计指定用户是否存在关联任务（雇主 / 接单人任一角色）
 * 用途：管理员批量删除「已注销」垃圾账号前的前置校验 —— 有关联任务的账号不删除，
 *      避免把对方的订单历史一起抹掉（历史任务里还留着与该账号的往来记录）。
 * @param {number[]} userIds
 * @returns {Promise<Set<number>>} 存在关联任务的用户 id 集合
 */
async function findIdsWithTasks(userIds) {
  if (!userIds.length) return new Set();
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = await query(
    'SELECT DISTINCT user_id AS id FROM tasks WHERE user_id IN (' + placeholders + ')'
    + ' UNION SELECT DISTINCT taker_user_id AS id FROM tasks WHERE taker_user_id IN (' + placeholders + ')',
    userIds.concat(userIds)
  );
  return new Set(rows.map((row) => Number(row.id)));
}

/**
 * 物理删除账号及其私有数据（仅用于清理「已注销」的垃圾账号）
 * ---------------------------------------------------------------------
 * 必须在事务中调用。删除顺序遵循外键依赖：先删引用 users 的从表，最后删 users 本体。
 * 注意：调用方必须已确认这些账号「没有关联任务」，否则 tasks 的外键会直接拒绝删除。
 * @param {number[]} userIds 目标用户 id
 * @param {object} conn 事务连接（必传）
 * @returns {Promise<number>} 实际删除的账号数
 */
async function hardDeleteUsers(userIds, conn) {
  if (!conn) throw new BizError('账号物理删除必须在事务中执行', 500);
  if (!userIds.length) return 0;
  const placeholders = userIds.map(() => '?').join(', ');
  const dependents = [
    'user_kick', 'user_device', 'messages', 'audit_apply', 'appeals',
    'report', 'payments', 'user_bill'
  ];
  for (const table of dependents) {
    await conn.execute('DELETE FROM ' + table + ' WHERE user_id IN (' + placeholders + ')', userIds);
  }
  const [result] = await conn.execute('DELETE FROM users WHERE id IN (' + placeholders + ')', userIds);
  return Number(result.affectedRows || 0);
}

/**
 * 账号注销（不可恢复）
 * ---------------------------------------------------------------------
 * 必须在事务中调用（conn 必传）：注销是一次多字段原子写操作，任一字段失败都整体回滚。
 * 注销动作：
 *   1) 手机号 / 学号改写为「不可注册的占位值」，释放唯一性占位，
 *      对应真实手机号与学号可被新账号重新注册 / 重新认证；
 *      - 手机号占位：'D' + 8 位补零 user_id（最长 10 位，VARCHAR(11) 可容纳 INT 最大值）
 *      - 学号占位：  'DX' + 8 位补零 user_id（最长 11 位，VARCHAR(20) 可容纳）
 *      两个占位值都含字母，永远不会与「11 位纯数字手机号 / 数字学号」冲突，也无法被注册流程命中。
 *   2) 密码哈希改写为随机串：bcrypt 对非法哈希一律返回 false，账号永远无法再登录，
 *      同时保证数据库中依旧不出现任何明文密码；
 *   3) 清空个人隐私资料（姓名 / 昵称 / 头像 / 认证截图）并重置审核状态；
 *      姓名与昵称统一改写为字典文案 DEACTIVATED_NAME（前端展示口径一致）；
 *   4) 清空设备标识 / 登录失败计数 / 登录锁定 / 接单封禁，让旧 token 与封禁状态一并失效
 *      （旧 token 的真正失效由 auth 中间件读取 deactivated_at 拦截，二者配合保证彻底失效）；
 *   5) 释放邀请码（置 NULL，唯一索引允许多个 NULL），避免注销后仍被他人填写；
 *   6) 记录 deactivated_at 注销时间。
 * 注意：account_no（对外账号编号 A0001 / X0001）必须保留，
 *      否则历史任务 / 账单 / 举报记录将失去可读的账号标识。
 * WHERE 附带 deactivated_at IS NULL，重复调用返回 0 行，天然幂等。
 * @param {number} userId 目标用户 user_id
 * @param {object} conn 事务连接（必传）
 * @returns {Promise<number>} 受影响行数（0 表示该账号此前已注销）
 */
async function deactivate(userId, conn = null) {
  if (!conn) {
    throw new BizError('账号注销必须在事务中执行', 500);
  }
  const seq = String(userId).padStart(8, '0');
  const phonePlaceholder = 'D' + seq;
  const studentIdPlaceholder = 'DX' + seq;
  const passwordPlaceholder = 'DEACTIVATED#' + crypto.randomBytes(16).toString('hex');
  const [result] = await conn.execute(
    `UPDATE users
        SET deactivated_at = NOW(),
            phone = ?, student_id = ?, password_hash = ?,
            name = ?, nickname = ?,
            avatar = '', campus_cert_img = '',
            is_avatar_audit = 0, is_campus_audit = 0,
            invite_code = NULL,
            login_fail_count = 0, login_lock_time = NULL, login_device_id = '',
            ban_take_time = NULL, ban_reason = '', ban_operator_id = NULL, ban_created_at = NULL
      WHERE id = ? AND deactivated_at IS NULL`,
    [phonePlaceholder, studentIdPlaceholder, passwordPlaceholder, DEACTIVATED_NAME, DEACTIVATED_NAME, userId]
  );
  return result.affectedRows;
}

/**
 * 登录成功：重置错误计数、解除锁定、更新最后登录时间与设备标识
 * 设备标识写入后，旧设备持有的 token 立即失效（单设备登录）
 */
function updateLoginSuccess(userId, deviceId, conn = null) {
  return run(
    conn,
    'UPDATE users SET login_fail_count = 0, login_lock_time = NULL, last_login_time = NOW(), login_device_id = ? WHERE id = ?',
    [deviceId || '', userId]
  );
}

/**
 * 密码错误次数 +1
 * @returns {Promise<number>} 累计错误次数
 */
async function increaseLoginFail(userId, conn = null) {
  await run(conn, 'UPDATE users SET login_fail_count = login_fail_count + 1 WHERE id = ?', [userId]);
  const rows = await run(conn, 'SELECT login_fail_count FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] ? Number(rows[0].login_fail_count) : 0;
}

/** 锁定账号：连续错误达到上限后调用 */
function lockLogin(userId, minutes = BIZ.LOGIN_LOCK_MINUTES, conn = null) {
  return run(
    conn,
    'UPDATE users SET login_lock_time = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
    [minutes, userId]
  );
}

/** 解除登录锁定并清零错误计数 */
function unlockLogin(userId, conn = null) {
  return run(conn, 'UPDATE users SET login_lock_time = NULL, login_fail_count = 0 WHERE id = ?', [userId]);
}

/** 校园认证通过后回写用户资料（姓名 / 学号 / 认证截图 / 认证状态） */
function updateCampusCert(userId, name, studentId, certImg, conn = null) {
  return run(
    conn,
    'UPDATE users SET name = ?, student_id = ?, campus_cert_img = ?, is_campus_audit = ? WHERE id = ?',
    [name, studentId, certImg, 2, userId]
  );
}

/** 更新校园认证状态（0无申请 1待审核 2通过 3驳回） */
function setCampusAuditStatus(userId, status, conn = null) {
  return run(conn, 'UPDATE users SET is_campus_audit = ? WHERE id = ?', [status, userId]);
}

/** 更新头像地址 */
function updateAvatar(userId, avatar, conn = null) {
  return run(conn, 'UPDATE users SET avatar = ? WHERE id = ?', [avatar, userId]);
}

/** 更新头像审核状态 */
function setAvatarAuditStatus(userId, status, conn = null) {
  return run(conn, 'UPDATE users SET is_avatar_audit = ? WHERE id = ?', [status, userId]);
}

/** 更新昵称（审核通过后调用），同时消耗一次昵称修改次数 */
function updateNickname(userId, nickname, conn = null) {
  return run(
    conn,
    'UPDATE users SET nickname = ?, nickname_modify_count = CASE WHEN nickname_modify_count > 0 THEN nickname_modify_count - 1 ELSE 0 END WHERE id = ?',
    [nickname, userId]
  );
}

/**
 * 管理员可直接修改的用户字段白名单
 * 【安全说明】SQL 的列名不能用占位符，因此这里采用「固定白名单 + 循环取列名」的方式，
 *            调用方传入的对象里即使携带任意其他 key 也会被直接忽略，杜绝 SQL 注入。
 */
const ADMIN_EDITABLE_FIELDS = [
  'nickname',           // 昵称
  'name',               // 真实姓名
  'phone',              // 登录手机号
  'student_id',         // 学号
  'is_campus_audit',    // 校园认证状态 0无申请 1待审核 2通过 3驳回
  'campus_cert_img',    // 校园认证截图
  'avatar',             // 头像地址
  'is_avatar_audit'     // 头像审核状态
];

/**
 * 管理员直接修改用户资料（多字段动态更新，全部参数化）
 * 未出现在 fields 里的字段不会被改写（置为 undefined / null 即跳过）。
 * @param {number} userId 目标用户主键
 * @param {object} fields { nickname?, name?, phone?, student_id?, is_campus_audit?, campus_cert_img?, avatar?, is_avatar_audit? }
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function updateProfileByAdmin(userId, fields = {}, conn = null) {
  const sets = [];
  const params = [];
  ADMIN_EDITABLE_FIELDS.forEach((col) => {
    if (fields[col] === undefined || fields[col] === null) return;
    sets.push('`' + col + '` = ?');
    params.push(fields[col]);
  });
  if (!sets.length) return 0;
  params.push(userId);
  const sql = 'UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?';
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.affectedRows;
  }
  const result = await execute(sql, params);
  return result.affectedRows;
}

/**
 * 管理员封禁 / 加时接单权限
 * ---------------------------------------------------------------------
 * 时长由 6 个时间单位组成：年 / 月 / 日 / 时 / 分 / 秒（每一项最小为 0，留空即 0）。
 * 累加基准 base = GREATEST(COALESCE(ban_take_time, NOW()), NOW())：
 *   - 用户当前不在封禁中 -> 从「当前时间」开始计时
 *   - 用户正在封禁中     -> 从「原封禁截止时间」继续叠加，即实现「加时」语义
 * 同时记录封禁原因、操作管理员与封禁时间，便于后台审计。
 * @param {number} userId 目标用户 user_id
 * @param {object} duration { year, month, day, hour, minute, second } 各时间单位数值（>=0）
 * @param {object} operator { adminUserId, reason } 操作管理员与封禁原因
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
function banTakeByDuration(userId, duration = {}, operator = {}, conn = null) {
  const sql = `UPDATE users
      SET ban_take_time = DATE_ADD(
            DATE_ADD(
              DATE_ADD(
                DATE_ADD(
                  DATE_ADD(
                    DATE_ADD(GREATEST(COALESCE(ban_take_time, NOW()), NOW()),
                      INTERVAL ? YEAR),
                    INTERVAL ? MONTH),
                  INTERVAL ? DAY),
                INTERVAL ? HOUR),
              INTERVAL ? MINUTE),
            INTERVAL ? SECOND),
          ban_reason = ?, ban_operator_id = ?, ban_created_at = NOW()
      WHERE id = ?`;
  const params = [
    toInt(duration.year, 0),
    toInt(duration.month, 0),
    toInt(duration.day, 0),
    toInt(duration.hour, 0),
    toInt(duration.minute, 0),
    toInt(duration.second, 0),
    String(operator.reason || '').slice(0, 200),
    operator.adminUserId || null,
    userId
  ];
  return run(conn, sql, params).then((rows) => rows.affectedRows);
}

/** 解除接单封禁（同时清空封禁原因 / 操作人 / 封禁时间） */
function unbanUser(userId, conn = null) {
  return run(
    conn,
    "UPDATE users SET ban_take_time = NULL, ban_reason = '', ban_operator_id = NULL, ban_created_at = NULL WHERE id = ?",
    [userId]
  ).then((rows) => rows.affectedRows);
}

/**
 * 管理员：封禁管理列表（分页 + 关键词搜索）
 * ---------------------------------------------------------------------
 * 业务要求：搜索框既要能搜到「正在封禁中」的用户，也要能搜到「未被封禁」的用户，
 *   方便管理员直接把搜索结果里的人拉去封禁（未封禁的人也要能一键封禁）。
 *   - 有关键词：在「全部用户」里搜索，封禁中的排前面（按解禁时间倒序），
 *     未封禁的按 id 升序排在后面，并下发 isBanned 让前端区分展示与按钮；
 *   - 无关键词：只列出正在封禁中的用户（ban_take_time > NOW()），
 *     这一屏就是「当前封禁名单」，一行一排，按解禁时间倒序。
 * 关键词支持：账号ID（A0001/X0001）、手机号、学号、昵称、姓名、主键ID（全部参数化，绝不拼接 SQL）
 * @param {object} options { keyword, offset, limit }
 */
async function listBanManage({ keyword = '', offset = 0, limit = 10 }) {
  const key = String(keyword || '').trim();
  const where = [];
  const params = [];
  if (key) {
    where.push('(account_no LIKE ? OR phone LIKE ? OR student_id LIKE ? OR nickname LIKE ? OR name LIKE ? OR CAST(id AS CHAR) = ?)');
    const like = '%' + key + '%';
    params.push(like, like, like, like, like, key);
  } else {
    // 未输入关键词：只展示「正在封禁中」的用户，保持封禁名单的语义
    where.push('ban_take_time IS NOT NULL', 'ban_take_time > NOW()');
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  // 搜索模式：封禁中的优先展示（按解禁时间倒序），未封禁的按 id 升序跟在其后
  const orderSql = key
    ? ' ORDER BY (ban_take_time IS NOT NULL AND ban_take_time > NOW()) DESC, ban_take_time DESC, id ASC'
    : ' ORDER BY ban_take_time DESC, id ASC';

  const list = await query(
    'SELECT ' + SAFE_FIELDS + ', ban_reason, ban_operator_id, ban_created_at FROM users'
      + whereSql + orderSql + ' LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM users' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 查询全部管理员账号（学号命中 .env 白名单的账号）
 * 用途：恶意超时投诉需要「直达管理员账号」，这里把管理员找出来逐个推送站内消息。
 * @returns {Promise<Array>} 管理员用户行
 */
function findAdminUsers(conn = null) {
  const studentIds = getAdminStudentIds();
  if (!studentIds.length) return Promise.resolve([]);
  const sql = 'SELECT id, account_no, nickname FROM users WHERE student_id IN (' + buildPlaceholders(studentIds.length) + ')';
  return run(conn, sql, studentIds);
}

// ------------------------- 定时任务专用查询 -------------------------

/** 查询 ban_take_time 已到期的用户（每分钟后自动解禁） */
function findExpiredBanUsers(limit = 200) {
  return query('SELECT id FROM users WHERE ban_take_time IS NOT NULL AND ban_take_time <= NOW() LIMIT ?', [limit]);
}

/** 批量解除到期的接单封禁 */
function clearExpiredBan() {
  return execute('UPDATE users SET ban_take_time = NULL WHERE ban_take_time IS NOT NULL AND ban_take_time <= NOW()');
}

/** 查询登录锁定已到期的账号 */
function findExpiredLockUsers(limit = 200) {
  return query('SELECT id FROM users WHERE login_lock_time IS NOT NULL AND login_lock_time <= NOW() LIMIT ?', [limit]);
}

/** 批量解除到期的登录锁定并清零错误计数 */
function clearExpiredLoginLock() {
  return execute('UPDATE users SET login_lock_time = NULL, login_fail_count = 0 WHERE login_lock_time IS NOT NULL AND login_lock_time <= NOW()');
}

// ------------------------- 邀请码免费代拿权益 -------------------------

/**
 * 判断账号当前是否有可用的「快递免费代拿」权益
 * 条件：剩余次数 > 0 且 有效期未过期
 * @param {object} user 用户行（users 表）
 * @returns {boolean}
 */
function isFreeDeliveryAvailable(user) {
  if (!user) return false;
  if (Number(user.free_delivery_count || 0) <= 0) return false;
  if (!user.free_delivery_expire) return false;
  // dateStrings: true -> 数据库返回 'YYYY-MM-DD HH:mm:ss' 字符串，统一转时间戳比较
  return new Date(user.free_delivery_expire).getTime() > Date.now();
}

/**
 * 发放邀请码注册奖励：记录邀请关系 + 赠送快递免费代拿次数（默认 7 天有效）
 * 有效期使用数据库时间计算（DATE_ADD(NOW(), INTERVAL ? DAY)），
 * 避免应用服务器与数据库服务器时区不一致导致的有效期偏差。
 * @param {object} data { userId, inviterId, inviteCode, count, days }
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function grantInviteReward({ userId, inviterId, inviteCode, count, days }, conn = null) {
  const result = await run(
    conn,
    `UPDATE users
        SET invited_by = ?, invite_code_used = ?, free_delivery_count = ?, free_delivery_expire = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?`,
    [inviterId, String(inviteCode || '').slice(0, 20), Number(count), Number(days), userId]
  );
  return result.affectedRows || 0;
}

/**
 * 核销一次「快递免费代拿」权益（并发安全：条件更新 + 乐观锁）
 * ---------------------------------------------------------------------
 * WHERE 同时限定「次数 > 0」与「有效期未过期」，因此：
 *   - 两个请求并发发布时，数据库只有一条 UPDATE 能命中（行锁 + 条件判断）
 *   - 返回 0 表示权益已用完 / 已过期 / 已被并发请求抢先使用，
 *     调用方必须回滚事务并按「正常收取信息服务费」或直接报错处理
 * @param {number} userId 用户主键
 * @param {object} conn 事务连接（必须在事务内调用，与任务创建同生共死）
 * @returns {Promise<number>} 受影响行数，1 表示核销成功
 */
async function consumeFreeDelivery(userId, conn) {
  const result = await run(
    conn,
    `UPDATE users
        SET free_delivery_count = free_delivery_count - 1, free_delivery_used_at = NOW()
      WHERE id = ?
        AND free_delivery_count > 0
        AND free_delivery_expire IS NOT NULL
        AND free_delivery_expire > NOW()`,
    [userId]
  );
  return result.affectedRows || 0;
}

/**
 * 清理已过期的免费代拿次数（定时任务调用，幂等）
 * 只做「展示口径归零」，业务判定始终以 free_delivery_expire > NOW() 为准，
 * 因此即使清理任务未及时执行，也不会出现「过期权益仍可核销」的问题。
 * @returns {Promise<number>} 被清理的账号数
 */
async function clearExpiredFreeDelivery() {
  const result = await execute(
    'UPDATE users SET free_delivery_count = 0 WHERE free_delivery_count > 0 AND (free_delivery_expire IS NULL OR free_delivery_expire <= NOW())'
  );
  return result.affectedRows || 0;
}

/**
 * 返还一次「快递免费代拿」权益
 * ---------------------------------------------------------------------
 * 业务场景：使用免费权益发布的任务，在「从未被任何人接单」的情况下被雇主撤销，
 *   系统把这一次免费代拿次数原样还给雇主，方便其重新发布。
 * 说明：
 *   1) 调用方必须先通过 Task.markFreeDeliveryReturned 的乐观锁「占位成功」再调用本方法，
 *      这样同一条任务即使被重复撤销 / 并发撤销，也只会返还一次；
 *   2) 返还时**不延长有效期**（仍沿用注册时给的 7 天窗口），
 *      否则会出现「发布 -> 撤销 -> 再发布 -> 再撤销」无限续期的漏洞；
 *   3) 若返还时权益已过期，次数虽然回到账号上，也不会被判定为可用
 *      （可用性判定统一看 free_delivery_expire > NOW()），每日定时任务会把它清零。
 * @param {number} userId 用户主键
 * @param {object} conn 事务连接（必须与任务状态变更同事务）
 * @returns {Promise<number>} 受影响行数
 */
async function returnFreeDelivery(userId, conn) {
  const result = await run(
    conn,
    'UPDATE users SET free_delivery_count = free_delivery_count + 1 WHERE id = ?',
    [userId]
  );
  return result.affectedRows || 0;
}


/**
 * 核销一张「发布券」（并发安全：条件更新 + 乐观锁）
 * ---------------------------------------------------------------------
 * 为什么需要：B 方案（个人主体 + 微信虚拟支付）不支持退款，
 *   因此撤销任务退的是「发布券」而不是现金；有券时发布任务免付 0.1 元。
 * WHERE publish_coupon_count > 0 保证并发发布时只有一条 UPDATE 能命中，
 * 返回 0 表示没有可用券（调用方回退到正常支付流程）。
 * @param {number} userId 用户 id
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示无券可扣
 */
async function consumePublishCoupon(userId, conn) {
  const result = await run(
    conn,
    'UPDATE users SET publish_coupon_count = publish_coupon_count - 1 WHERE id = ? AND publish_coupon_count > 0',
    [userId]
  );
  return result.affectedRows || 0;
}

/**
 * 返还「发布券」（撤销任务 / 管理员删单时调用）
 * 只做加法，天然幂等由调用方的 markRefunded 乐观锁保证（同一任务只退一次）。
 * @param {number} userId 用户 id
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function returnPublishCoupon(userId, conn) {
  const result = await run(
    conn,
    'UPDATE users SET publish_coupon_count = publish_coupon_count + 1 WHERE id = ?',
    [userId]
  );
  return result.affectedRows || 0;
}

// ------------------------- 管理端 / 展示辅助 -------------------------

/**
 * 管理员：用户列表（支持手机号 / 昵称 / 学号 / 姓名模糊搜索）
 * 注意：模糊查询使用参数化占位符，不做字符串拼接
 */
async function listUsers({ keyword = '', includeDeactivated = false, offset = 0, limit = 10 }) {
  const where = [];
  const params = [];
  // 已注销账号默认不出现在用户管理列表里（否则列表会被「已注销用户」占满）；
  // 管理员需要追溯时可在页面上打开「显示已注销」开关，此时 includeDeactivated = true
  if (!includeDeactivated) where.push('deactivated_at IS NULL');
  if (keyword) {
    where.push('(account_no LIKE ? OR phone LIKE ? OR nickname LIKE ? OR student_id LIKE ? OR name LIKE ?)');
    const like = '%' + keyword + '%';
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const list = await query(
    'SELECT ' + SAFE_FIELDS + ' FROM users' + whereSql + ' ORDER BY id ASC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM users' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 账号是否处于接单封禁期 */
function isBannedFromTaking(user) {
  if (!user || !user.ban_take_time) return false;
  return new Date(user.ban_take_time).getTime() > Date.now();
}

/**
 * 距离解禁还剩多少秒（未封禁 / 已过期返回 0）
 * 管理员封禁列表与用户列表都靠这个值展示「剩余封禁时长」，避免前后端各算一套
 * @param {object} user 用户行
 * @returns {number}
 */
function banRemainSeconds(user) {
  if (!user || !user.ban_take_time) return 0;
  return Math.max(0, Math.floor((new Date(user.ban_take_time).getTime() - Date.now()) / 1000));
}

// ------------------------- 密保问题（注册后必须设置） -------------------------

/**
 * 是否已设置密保问题
 * 未设置的账号不允许使用小程序（由 auth 中间件统一拦截并返回 428，前端据此跳转设置页）
 * @param {object} user 用户行
 * @returns {boolean}
 */
function hasSecurity(user) {
  return Number(user && user.security_set) === SECURITY_SET_DONE;
}

/**
 * 密保是否处于锁定期（答案连续答错 5 次锁定 15 分钟）
 * @param {object} user 用户行
 * @returns {boolean}
 */
function isSecurityLocked(user) {
  if (!user || !user.security_lock_time) return false;
  return new Date(user.security_lock_time).getTime() > Date.now();
}

/**
 * 设置 / 更换密保问题
 * 答案以 bcrypt 哈希落库，数据库中绝不出现明文答案；设置成功后清零错误次数并解除锁定。
 * @param {number} userId 账号主键
 * @param {{question1:string,answer1Hash:string,question2:string,answer2Hash:string}} data 密保数据
 * @param {object|null} conn 事务连接
 */
function setSecurity(userId, data, conn = null) {
  return run(
    conn,
    `UPDATE users
        SET security_set = ?, sec_question1 = ?, sec_answer1_hash = ?,
            sec_question2 = ?, sec_answer2_hash = ?,
            security_fail_count = 0, security_lock_time = NULL, security_updated_at = NOW()
      WHERE id = ?`,
    [SECURITY_SET_DONE, data.question1, data.answer1Hash, data.question2, data.answer2Hash, userId]
  );
}

/**
 * 密保答案答错一次，返回累计的连续错误次数
 * @param {number} userId 账号主键
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 连续错误次数
 */
async function increaseSecurityFail(userId, conn = null) {
  await run(conn, 'UPDATE users SET security_fail_count = security_fail_count + 1 WHERE id = ?', [userId]);
  const rows = await run(conn, 'SELECT security_fail_count FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] ? Number(rows[0].security_fail_count) : 0;
}

/**
 * 锁定密保验证（连续答错达到上限时调用）
 * @param {number} userId 账号主键
 * @param {number} minutes 锁定时长（分钟）
 * @param {object|null} conn 事务连接
 */
function lockSecurity(userId, minutes, conn = null) {
  return run(
    conn,
    'UPDATE users SET security_lock_time = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
    [minutes, userId]
  );
}

/**
 * 密保验证成功：清零错误次数并解除锁定
 * @param {number} userId 账号主键
 * @param {object|null} conn 事务连接
 */
function clearSecurityFail(userId, conn = null) {
  return run(conn, 'UPDATE users SET security_fail_count = 0, security_lock_time = NULL WHERE id = ?', [userId]);
}

/**
 * 通过密保重置密码（必须在事务内调用）
 * 安全收尾动作与管理员重置保持完全一致：
 *   1) 写入新的 bcrypt 哈希（数据库永远不出现明文密码）
 *   2) 清零连续密码错误次数、解除登录锁定
 *   3) 清空设备标识，旧设备持有的 access_token 立即失效，必须用新密码重新登录
 *   4) 记录 reset_pwd_time（同一账号 24 小时只能重置一次）
 *   5) 清零密保错误次数并解除密保锁定
 * @param {number} userId 账号主键
 * @param {string} passwordHash 新的 bcrypt 哈希
 * @param {object|null} conn 事务连接
 */
function resetPasswordBySecurity(userId, passwordHash, conn = null) {
  return run(
    conn,
    `UPDATE users
        SET password_hash = ?, login_fail_count = 0, login_lock_time = NULL, login_device_id = ?,
            reset_pwd_time = NOW(), security_fail_count = 0, security_lock_time = NULL
      WHERE id = ?`,
    [passwordHash, '', userId]
  );
}

/**
 * 查询最近一次通过密保重置密码的时间（24 小时限一次的依据）
 * @param {number} userId 账号主键
 * @param {object|null} conn 事务连接
 * @returns {Promise<Date|null>}
 */
async function getResetPwdTime(userId, conn = null) {
  const rows = await run(conn, 'SELECT reset_pwd_time FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] ? rows[0].reset_pwd_time : null;
}

/**
 * 查询密保锁定已到期的账号（定时任务解禁用）
 * @param {number} limit 单批处理条数
 */
function findExpiredSecurityLockUsers(limit = 500) {
  return query(
    'SELECT id FROM users WHERE security_lock_time IS NOT NULL AND security_lock_time <= NOW() LIMIT ?',
    [limit]
  );
}

/**
 * 批量解除到期的密保锁定
 * @returns {Promise<number>} 受影响行数
 */
async function clearExpiredSecurityLock() {
  const result = await execute(
    'UPDATE users SET security_lock_time = NULL, security_fail_count = 0 '
    + 'WHERE security_lock_time IS NOT NULL AND security_lock_time <= NOW()'
  );
  return result.affectedRows || 0;
}

// ------------------------- 账号-设备绑定（新设备登录需密保解锁） -------------------------

/**
 * 按「账号 + 设备标识」查询绑定记录
 * @param {number} userId 账号主键
 * @param {string} deviceId 设备标识
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>} 绑定记录，未绑定返回 null
 */
function findDevice(userId, deviceId, conn = null) {
  const did = String(deviceId || '').trim();
  if (!did) return Promise.resolve(null);
  return run(
    conn,
    'SELECT * FROM user_device WHERE user_id = ? AND device_id = ? LIMIT 1',
    [userId, did]
  ).then((rows) => rows[0] || null);
}

/**
 * 按「账号 + 微信 openid」查询绑定记录
 * 说明：openid 是「同一个微信号 + 同一个小程序」下的唯一标识，换手机、清缓存、重装小程序都不会变，
 *      是最可靠的「本人设备」判据，因此优先于设备指纹使用。
 * @param {number} userId 账号主键
 * @param {string} openid 微信 openid
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>} 绑定记录，未绑定返回 null
 */
function findDeviceByOpenid(userId, openid, conn = null) {
  const oid = String(openid || '').trim();
  if (!oid) return Promise.resolve(null);
  return run(
    conn,
    'SELECT * FROM user_device WHERE user_id = ? AND openid = ? LIMIT 1',
    [userId, oid]
  ).then((rows) => rows[0] || null);
}

/**
 * 账号已绑定的设备数量
 * @param {number} userId 账号主键
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>}
 */
async function countDevices(userId, conn = null) {
  const rows = await run(conn, 'SELECT COUNT(*) AS total FROM user_device WHERE user_id = ?', [userId]);
  return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * 账号已绑定设备列表（个人中心「设备管理」展示与解绑）
 * @param {number} userId 账号主键
 * @param {object|null} conn 事务连接
 */
function listDevices(userId, conn = null) {
  return run(
    conn,
    `SELECT id, openid, device_id, device_name, login_ip, login_region, last_login_time, created_at
       FROM user_device WHERE user_id = ? ORDER BY last_login_time DESC, id DESC`,
    [userId]
  );
}

/**
 * 绑定 / 刷新一台设备（同一账号同一设备只保留一条记录）
 * @param {{userId:number,openid:string,deviceId:string,deviceName:string,ip:string,region:string}} data 绑定数据
 * @param {object|null} conn 事务连接
 */
function bindDevice(data, conn = null) {
  return run(
    conn,
    `INSERT INTO user_device (user_id, openid, device_id, device_name, login_ip, login_region, last_login_time)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE openid = VALUES(openid),
       device_name = VALUES(device_name),
       login_ip = IF(VALUES(login_ip) = '', login_ip, VALUES(login_ip)),
       login_region = IF(VALUES(login_region) = '', login_region, VALUES(login_region)),
       last_login_time = NOW()`,
    [
      data.userId,
      data.openid || '',
      String(data.deviceId || '').slice(0, 100),
      String(data.deviceName || '').slice(0, 100),
      String(data.ip || '').slice(0, 45),
      String(data.region || '').slice(0, 50)
    ]
  );
}

/**
 * 解绑一台设备（SQL 带 user_id 条件，天然防止越权解绑他人设备）
 * @param {number} userId 账号主键
 * @param {number} deviceRowId user_device 主键
 * @param {object|null} conn 事务连接
 */
function deleteDevice(userId, deviceRowId, conn = null) {
  return run(conn, 'DELETE FROM user_device WHERE id = ? AND user_id = ?', [deviceRowId, userId]);
}

/**
 * 记录一次「顶号」事件（新设备登录把旧设备顶下线）
 * ---------------------------------------------------------------------
 * 单设备登录规则下，旧设备的 token 会立即失效，但用户本人是「无感」的，
 * 因此必须把「是哪台设备、什么时候、从哪个 IP 登录的」留档，
 * 由被顶下线的设备在下次请求时取走并弹窗告知本人（非本人操作可及时止损）。
 * @param {object} data { userId, deviceId, deviceName, newDeviceId, newDeviceName, ip, region }
 * @param {object|null} conn 事务连接（与「更新登录设备」同事务，保证不漏记）
 * @returns {Promise<number>} 新记录主键
 */
async function createKick(data, conn = null) {
  const result = await run(
    conn,
    `INSERT INTO user_kick
       (user_id, device_id, device_name, new_device_id, new_device_name, login_ip, login_region, kick_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      data.userId,
      String(data.deviceId || '').slice(0, 100),
      String(data.deviceName || '').slice(0, 100),
      String(data.newDeviceId || '').slice(0, 100),
      String(data.newDeviceName || '').slice(0, 100),
      String(data.ip || '').slice(0, 45),
      String(data.region || '').slice(0, 50)
    ]
  );
  return result.insertId;
}

/**
 * 取某台设备「尚未提示过」的最近一条顶号记录
 * ---------------------------------------------------------------------
 * 说明：调用方读取后【不要】立刻标记已读。
 *   前端收到 401 后会先自动尝试刷新令牌，这一跳会经过同一个判定分支，
 *   若此时把记录标记已读，真正弹窗时内容就只剩一串「未知」。
 *   记录的生命周期：该设备下次成功登录时由 clearDeviceKicks 统一清掉。
 *   表数据由定时任务 purgeOldKicks 按 30 天归档，不会无限增长。
 * @param {number} userId 账号主键
 * @param {string} deviceId 被顶下线的设备标识
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>}
 */
function findLatestUnreadKick(userId, deviceId, conn = null) {
  const did = String(deviceId || '').trim();
  if (!did) return Promise.resolve(null);
  return run(
    conn,
    'SELECT * FROM user_kick WHERE user_id = ? AND device_id = ? AND is_read = 0 ORDER BY id DESC LIMIT 1',
    [userId, did]
  ).then((rows) => rows[0] || null);
}

/**
 * 标记顶号提示已送达（避免同一条提示反复弹窗）
 * 条件里的 is_read = 0 同时起到幂等作用：重复调用不会产生额外写操作。
 * @param {number} kickId user_kick 主键
 * @param {object|null} conn 事务连接
 */
function markKickRead(kickId, conn = null) {
  return run(conn, 'UPDATE user_kick SET is_read = 1 WHERE id = ? AND is_read = 0', [kickId]);
}

/**
 * 按主键读取顶号记录（用于登录后补写站内消息）
 * @param {number} kickId user_kick 主键
 * @param {object|null} conn 事务连接
 * @returns {Promise<object|null>}
 */
function findKickById(kickId, conn = null) {
  return run(conn, 'SELECT * FROM user_kick WHERE id = ? LIMIT 1', [kickId])
    .then((rows) => rows[0] || null);
}

/**
 * 把某台设备的历史顶号提示全部标记为已读
 * 调用时机：该设备重新登录成功（说明本人已经回来处理过了，旧提示无需再弹）。
 * @param {number} userId 账号主键
 * @param {string} deviceId 设备标识
 * @param {object|null} conn 事务连接
 */
function clearDeviceKicks(userId, deviceId, conn = null) {
  const did = String(deviceId || '').trim();
  if (!did) return Promise.resolve({ affectedRows: 0 });
  return run(
    conn,
    'UPDATE user_kick SET is_read = 1 WHERE user_id = ? AND device_id = ? AND is_read = 0',
    [userId, did]
  );
}

/**
 * 归档清理历史顶号提示记录（每天 04:00 由定时任务调用）
 * ---------------------------------------------------------------------
 * 只删除「超过 keepDays 天 且 已读」的记录：
 *   · 未读记录一律保留 —— 用户还没看到提示，绝不能删；
 *   · 已读记录说明该设备已重新登录过（clearDeviceKicks），留着只是占空间。
 * @param {number} keepDays 保留天数，默认 30
 * @returns {Promise<number>} 删除行数
 */
async function purgeOldKicks(keepDays = 30) {
  const days = Number.isInteger(keepDays) && keepDays > 0 ? keepDays : 30;
  const result = await run(
    null,
    'DELETE FROM user_kick WHERE is_read = 1 AND kick_time < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [days]
  );
  return result.affectedRows || 0;
}

/** 账号是否处于登录锁定期 */
function isLoginLocked(user) {
  if (!user || !user.login_lock_time) return false;
  return new Date(user.login_lock_time).getTime() > Date.now();
}

/**
 * 账号是否已注销
 * deactivated_at 非空即视为已注销：这类账号不可登录、不可发布 / 接单，
 * 登录接口与 auth 中间件都靠本判定拦截。
 * @param {object} user 用户行
 * @returns {boolean}
 */
function isDeactivatedUser(user) {
  return !!(user && user.deactivated_at);
}

/**
 * 用户信息脱敏输出
 * @param {object} user 数据库用户行
 * @param {boolean} isAdmin 是否管理员（由后端白名单计算，不读数据库 is_admin 字段）
 */
function toSafeUser(user, isAdmin = false) {
  if (!user) return null;
  // 管理员账号身份上等价于「校园认证通过」，即使数据库尚未同步也向前端输出已认证
  const admin = !!isAdmin;
  // 已注销账号：个人隐私资料在注销时已被清空（手机号 / 学号改写为占位值），
  // 这里统一对外输出空串 + 字典文案，避免占位值泄漏到前端展示层。
  const deactivated = isDeactivatedUser(user);
  return {
    userId: user.id,
    // 账号编号（A0001 / X0001），前端「个人中心 - 账号 ID」与登录输入框都使用该值
    accountNo: user.account_no || '',
    userIdText: formatUserId(user.id, user.account_no),
    studentId: deactivated ? '' : user.student_id,
    name: deactivated ? DEACTIVATED_NAME : user.name,
    phone: deactivated ? '' : maskPhone(user.phone),
    nickname: deactivated ? DEACTIVATED_NAME : user.nickname,
    // ---------------- 账号注销 ----------------
    // 前端据此展示「已注销」标识，并隐藏依赖手机号 / 学号的操作入口
    isDeactivated: deactivated,
    deactivatedAt: user.deactivated_at || null,
    // 昵称剩余修改次数：管理员账号不受次数限制，统一下发 -1，前端展示为「不限」
    nicknameModifyCount: admin ? NICKNAME_COUNT_UNLIMITED : Number(user.nickname_modify_count || 0),
    avatar: user.avatar,
    isAvatarAudit: user.is_avatar_audit,
    campusCertImg: user.campus_cert_img,
    isCampusAudit: admin ? CAMPUS_AUDIT_ENUM.PASS : user.is_campus_audit,
    isCampusCertified: admin || Number(user.is_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,
    isAdmin: admin,
    // 角色标识文案（其他用户可见），文案统一取自 constant.js 字典
    roleTag: roleTagOf(admin),
    roleValue: admin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL,
    inviteCode: user.invite_code,
    // ---------------- 邀请码免费代拿权益 ----------------
    // freeDeliveryAvailable 为「当前是否真的有可用次数」（含有效期判定），前端据此显示角标
    freeDeliveryCount: Number(user.free_delivery_count || 0),
    freeDeliveryExpire: user.free_delivery_expire || null,
    freeDeliveryUsedAt: user.free_delivery_used_at || null,
    freeDeliveryAvailable: isFreeDeliveryAvailable(user),
    freeDeliveryDays: BIZ.FREE_DELIVERY_DAYS,
    // ---------------- 发布券（虚拟支付 B 方案） ----------------
    // 撤销任务返还的券；发布任务时会自动优先抵扣 0.1 元信息服务费，前端据此显示角标与提示
    publishCouponCount: Number(user.publish_coupon_count || 0),
    invitedBy: user.invited_by || null,
    inviteCodeUsed: user.invite_code_used || '',
    banTakeTime: user.ban_take_time,
    banReason: user.ban_reason || '',
    banCreatedAt: user.ban_created_at || null,
    banRemainSeconds: banRemainSeconds(user),
    isBanned: isBannedFromTaking(user),
    // ---------------- 账号安全（密保问题） ----------------
    // securitySet = 0 时前端必须强制跳转「设置密保」页面；未设置前所有业务接口都会被后端 428 拦截
    securitySet: Number(user.security_set || 0),
    securityStatus: getText(SECURITY_STATUS, Number(user.security_set || 0), SECURITY_STATUS[SECURITY_SET_UNSET]),
    // 密保问题文本（只下发问题，答案哈希绝不下发）
    securityQuestions: [user.sec_question1 || '', user.sec_question2 || ''],
    securityUpdatedAt: user.security_updated_at || null,
    securityLocked: isSecurityLocked(user),
    lastLoginTime: user.last_login_time,
    createdAt: user.created_at
  };
}

module.exports = {
  SAFE_FIELDS,
  findById,
  findByIdForUpdate,
  findByPhone,
  findByAccountNo,
  findByStudentId,
  findAllByStudentId,
  isAccountNoTaken,
  randomAvailableAccountNo,
  findByInviteCode,
  findByPhoneExcept,
  findByStudentIdExcept,
  findByKeyword,
  findCertifiedByStudentId,
  autoCertifyAdmin,
  syncAdminAccounts,
  nextNormalAccountSeq,
  create,
  updatePassword,
  resetPasswordByAdmin,
  deactivate,
  updateLoginSuccess,
  increaseLoginFail,
  lockLogin,
  unlockLogin,
  updateCampusCert,
  setCampusAuditStatus,
  updateAvatar,
  setAvatarAuditStatus,
  updateNickname,
  updateProfileByAdmin,
  ADMIN_EDITABLE_FIELDS,
  banTakeByDuration,
  unbanUser,
  listBanManage,
  findAdminUsers,
  findExpiredBanUsers,
  clearExpiredBan,
  findExpiredLockUsers,
  clearExpiredLoginLock,
  isFreeDeliveryAvailable,
  grantInviteReward,
  consumeFreeDelivery,
  returnFreeDelivery,
  consumePublishCoupon,
  returnPublishCoupon,
  clearExpiredFreeDelivery,
  listUsers,
  findIdsWithTasks,
  hardDeleteUsers,
  banRemainSeconds,
  isBannedFromTaking,
  isLoginLocked,
  isDeactivatedUser,
  hasSecurity,
  isSecurityLocked,
  setSecurity,
  increaseSecurityFail,
  lockSecurity,
  clearSecurityFail,
  resetPasswordBySecurity,
  getResetPwdTime,
  findExpiredSecurityLockUsers,
  clearExpiredSecurityLock,
  findDevice,
  findDeviceByOpenid,
  countDevices,
  listDevices,
  bindDevice,
  deleteDevice,
  createKick,
  findLatestUnreadKick,
  markKickRead,
  findKickById,
  clearDeviceKicks,
  purgeOldKicks,
  toSafeUser
};
