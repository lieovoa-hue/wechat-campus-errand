/**
 * =====================================================================
 * 审核申请数据访问层（audit_apply）
 * 覆盖：头像审核(1) / 昵称审核(2) / 校园认证(3)
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const { AUDIT_STATUS_ENUM } = require('../utils/constant');

async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/** 创建审核申请 */
async function create(data, conn = null) {
  const sql = `INSERT INTO audit_apply
      (user_id, apply_type, apply_content, cert_name, cert_student_id, cert_phone, status, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    data.user_id,
    data.apply_type,
    data.apply_content,
    data.cert_name || '',
    data.cert_student_id || '',
    data.cert_phone || '',
    data.status === undefined ? AUDIT_STATUS_ENUM.PENDING : data.status,
    data.reject_reason || ''
  ];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/** 按主键查询 */
function findById(id, conn = null) {
  return run(conn, 'SELECT * FROM audit_apply WHERE id = ? LIMIT 1', [id]).then((rows) => rows[0] || null);
}

/** 按主键加行锁查询（事务内使用） */
function findByIdForUpdate(id, conn) {
  return run(conn, 'SELECT * FROM audit_apply WHERE id = ? LIMIT 1 FOR UPDATE', [id]).then((rows) => rows[0] || null);
}

/** 查询用户某类型的待审核申请 */
function findPending(userId, applyType, conn = null) {
  return run(
    conn,
    'SELECT * FROM audit_apply WHERE user_id = ? AND apply_type = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [userId, applyType, AUDIT_STATUS_ENUM.PENDING]
  ).then((rows) => rows[0] || null);
}

/**
 * 自动撤销旧的待审核申请（同一用户同类型只能存在 1 条待审核记录）
 * 撤销即置为已驳回 + 打上 is_void 作废标记，并写明原因
 * 说明：
 *   1. status = 3（驳回）保证「同一用户同类型只有 1 条待审核」的规则；
 *   2. is_void = 1 让这条被覆盖的旧申请不再出现在管理员审核列表里
 *      （否则管理员会看到同一个人多条认证申请，可能误点通过已作废的旧申请）；
 *   3. 记录本身保留，用户「我的审核记录」仍能看到完整提交历史。
 */
function cancelPending(userId, applyType, reason = '已被新申请覆盖', conn = null) {
  return run(
    conn,
    'UPDATE audit_apply SET status = ?, reject_reason = ?, is_void = 1 '
      + 'WHERE user_id = ? AND apply_type = ? AND status = ?',
    [AUDIT_STATUS_ENUM.REJECT, reason, userId, applyType, AUDIT_STATUS_ENUM.PENDING]
  );
}

/**
 * 管理员处理审核（幂等：仅待审核状态可被处理）
 * @returns {Promise<number>} 受影响行数
 */
async function handle(id, status, rejectReason = '', conn = null) {
  if (conn) {
    const [result] = await conn.execute(
      'UPDATE audit_apply SET status = ?, reject_reason = ? WHERE id = ? AND status = ?',
      [status, rejectReason, id, AUDIT_STATUS_ENUM.PENDING]
    );
    return result.affectedRows;
  }
  const result = await execute(
    'UPDATE audit_apply SET status = ?, reject_reason = ? WHERE id = ? AND status = ?',
    [status, rejectReason, id, AUDIT_STATUS_ENUM.PENDING]
  );
  return result.affectedRows;
}

/**
 * 管理员「直接修改用户校园认证状态」时，同步收尾该用户遗留的待审核申请
 * 目的：避免出现「用户资料已变成已认证，但审核列表里还挂着一堆待审核申请」的不一致。
 * 幂等：只更新 status = 待审核 的记录，重复调用不会影响已处理过的数据。
 * @param {number} userId 用户主键
 * @param {number} applyType 申请类型（1头像 2昵称 3校园认证）
 * @param {number} status 目标状态（2通过 / 3驳回）
 * @param {string} reason 驳回原因（通过时传空字符串）
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function resolvePending(userId, applyType, status, reason = '', conn = null) {
  return run(
    conn,
    'UPDATE audit_apply SET status = ?, reject_reason = ? WHERE user_id = ? AND apply_type = ? AND status = ?',
    [status, reason, userId, applyType, AUDIT_STATUS_ENUM.PENDING]
  );
}

/** 我的审核记录 */
async function listByUser({ userId, applyType = null, offset = 0, limit = 10 }) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (applyType !== null && applyType !== '' && applyType !== undefined) {
    where.push('apply_type = ?');
    params.push(Number(applyType));
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    'SELECT * FROM audit_apply' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM audit_apply' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 管理员审核列表
 * 【重要】只展示 is_void = 0 的申请：同一用户同类型的旧申请在提交新申请时已被作废，
 *   管理员只会看到该用户最新的一条待审核申请，避免重复处理 / 误通过已作废的旧申请。
 *   用户自己的「我的审核记录」（listByUser）不受此限制，仍保留完整历史。
 */
async function listForAdmin({ status = null, applyType = null, offset = 0, limit = 10 }) {
  const where = ['a.is_void = 0'];
  const params = [];
  if (status !== null && status !== '' && status !== undefined) {
    where.push('a.status = ?');
    params.push(Number(status));
  }
  if (applyType !== null && applyType !== '' && applyType !== undefined) {
    where.push('a.apply_type = ?');
    params.push(Number(applyType));
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const list = await query(
    'SELECT a.*, u.nickname, u.phone, u.student_id, u.is_campus_audit FROM audit_apply a LEFT JOIN users u ON u.id = a.user_id' +
      whereSql + ' ORDER BY a.id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM audit_apply a' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 统计用户最近 N 天内的校园认证提交次数（7 天内最多 3 次） */
async function countCampusApplyWithinDays(userId, days = 7) {
  const rows = await query(
    'SELECT COUNT(*) AS total FROM audit_apply WHERE user_id = ? AND apply_type = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
    [userId, 3, days]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

/** 定时任务：查询 7 天前被驳回且带图片的申请（用于清理图片文件） */
function findRejectedImagesBefore(days = 7, limit = 500) {
  return query(
    `SELECT id, apply_content FROM audit_apply
      WHERE status = ? AND apply_type IN (1, 3) AND apply_content LIKE '/uploads/%'
        AND updated_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
      LIMIT ?`,
    [AUDIT_STATUS_ENUM.REJECT, days, limit]
  );
}

/** 清空已删除图片的引用，避免残留失效路径 */
function clearContent(id, conn = null) {
  return run(conn, 'UPDATE audit_apply SET apply_content = ? WHERE id = ?', ['', id]);
}

module.exports = {
  create,
  findById,
  findByIdForUpdate,
  findPending,
  cancelPending,
  handle,
  resolvePending,
  listByUser,
  listForAdmin,
  countCampusApplyWithinDays,
  findRejectedImagesBefore,
  clearContent
};
