/**
 * =====================================================================
 * 举报数据访问层（report）
 * 举报状态：1待处理 2已处理完毕
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const { REPORT_TYPE_ENUM } = require('../utils/constant');

async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/**
 * 提交举报
 * ---------------------------------------------------------------------
 * 业务要求：用户举报任务时，「订单号 + 雇主 / 接单人双方的 账号ID / 学号 / 手机号」
 *   必须一并上报并落库，管理员在后台「举报管理」里能直接看到是哪一单、涉及哪两个人。
 *   这里存的是「举报当时的快照」，即使之后双方资料变更，管理员看到的仍是举报时的信息。
 * @param {object} data { userId, taskId, reportReason, reportType, orderNo,
 *                        ownerUserId, ownerStudentId, ownerPhone,
 *                        takerUserId, takerStudentId, takerPhone }
 *   reportType：1 普通举报（任何用户可提交）/ 2 恶意超时投诉（仅雇主可提交，直达管理员）
 */
async function create({
  userId, taskId, reportReason, reportType = 1,
  orderNo = '', ownerUserId = null, ownerStudentId = '', ownerPhone = '',
  takerUserId = null, takerStudentId = '', takerPhone = ''
}, conn = null) {
  const sql = `INSERT INTO report
      (user_id, task_id, report_reason, report_type, status,
       order_no, owner_user_id, owner_student_id, owner_phone,
       taker_user_id, taker_student_id, taker_phone)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    userId, taskId, reportReason, Number(reportType) || 1,
    orderNo, ownerUserId, ownerStudentId, ownerPhone,
    takerUserId, takerStudentId, takerPhone
  ];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/**
 * 从任务行构建「举报快照」（订单号 + 双方账号信息）
 * 入参使用 Task.findById 返回的任务行（已联表带出 owner_ / taker_ 前缀字段）。
 * @param {object|null} task 任务行
 * @returns {object} 可直接展开传给 create 的快照字段
 */
function buildTaskSnapshot(task) {
  if (!task) {
    return {
      orderNo: '', ownerUserId: null, ownerStudentId: '', ownerPhone: '',
      takerUserId: null, takerStudentId: '', takerPhone: ''
    };
  }
  return {
    orderNo: task.order_no || '',
    ownerUserId: task.user_id || null,
    ownerStudentId: task.owner_student_id || '',
    ownerPhone: task.owner_phone || '',
    takerUserId: task.taker_user_id || null,
    takerStudentId: task.taker_student_id || '',
    takerPhone: task.taker_phone || ''
  };
}

/** 按主键查询 */
function findById(id, conn = null) {
  return run(conn, 'SELECT * FROM report WHERE id = ? LIMIT 1', [id]).then((rows) => rows[0] || null);
}

/**
 * 同一用户对同一任务是否存在待处理举报（防止重复举报）
 * @param {number} userId 举报人
 * @param {number} taskId 任务ID
 * @param {number|null} reportType 举报类型（传 null 表示不限类型）
 * @param {object|null} conn 事务连接
 */
function findPendingByUserAndTask(userId, taskId, reportType = null, conn = null) {
  const params = [userId, taskId];
  let sql = 'SELECT id FROM report WHERE user_id = ? AND task_id = ? AND status = 1';
  if (reportType !== null && reportType !== undefined) {
    sql += ' AND report_type = ?';
    params.push(Number(reportType));
  }
  sql += ' LIMIT 1';
  return run(
    conn,
    sql,
    params
  ).then((rows) => rows[0] || null);
}

/**
 * 统计「同一用户 + 同一任务」在最近 N 分钟内的举报次数
 * ---------------------------------------------------------------------
 * 业务要求：每条任务每人（除雇主外）半小时内最多举报 3 次，防止刷举报骚扰。
 * 说明：
 *   1. 统计窗口内全部状态的举报（待处理 + 已处理），只要提交过就计一次，
 *      避免「举报刚被处理完就马上重报」绕过频率限制；
 *   2. 时间窗口由数据库计算（NOW() 与 created_at 同为库内时间），
 *      不依赖应用服务器时钟，多实例部署时口径一致；
 *   3. SQL 全参数化，分钟数经 Number() 强制转换后再绑定，防御 SQL 注入。
 * @param {number} userId 举报人 user_id
 * @param {number} taskId 任务 ID
 * @param {number} minutes 统计窗口（分钟）
 * @param {object|null} conn 事务连接（可选）
 * @returns {Promise<number>} 窗口内的普通举报条数
 */
async function countRecentByUserAndTask(userId, taskId, minutes, conn = null) {
  const rows = await run(
    conn,
    `SELECT COUNT(*) AS total FROM report
      WHERE user_id = ? AND task_id = ? AND report_type = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [userId, taskId, REPORT_TYPE_ENUM.NORMAL, Number(minutes)]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * 管理员举报列表（可按处理状态 / 举报类型筛选）
 * 联表带出：举报人信息、被举报任务信息、接单人信息
 * （恶意超时投诉需要管理员直接看到接单人的账号ID / 学号 / 手机号，方便一键封禁）
 * @param {object} options { status, reportType, offset, limit }
 */
async function listForAdmin({ status = null, reportType = null, offset = 0, limit = 10 }) {
  const where = [];
  const params = [];
  if (status !== null && status !== '' && status !== undefined) {
    where.push('r.status = ?');
    params.push(Number(status));
  }
  if (reportType !== null && reportType !== '' && reportType !== undefined) {
    where.push('r.report_type = ?');
    params.push(Number(reportType));
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const list = await query(
    `SELECT r.id, r.user_id, r.task_id, r.report_reason, r.report_type, r.status,
            r.admin_note, r.created_at, r.updated_at,
            r.order_no, r.owner_user_id, r.owner_student_id, r.owner_phone,
            r.taker_user_id AS snap_taker_user_id,
            r.taker_student_id AS snap_taker_student_id,
            r.taker_phone AS snap_taker_phone,
            u.nickname AS reporter_nickname, u.phone AS reporter_phone,
            u.account_no AS reporter_account_no, u.student_id AS reporter_student_id,
            u.avatar AS reporter_avatar, u.is_campus_audit AS reporter_campus_audit,
            t.deliver_address, t.status AS task_status, t.user_id AS task_owner_id,
            t.reward AS task_reward, t.time_limit_min AS task_time_limit_min,
            t.order_no AS task_order_no,
            ow.nickname AS owner_live_nickname, ow.account_no AS owner_live_account_no,
            ow.student_id AS owner_live_student_id, ow.phone AS owner_live_phone,
            ow.avatar AS owner_live_avatar, ow.is_campus_audit AS owner_live_campus_audit,
            tk.id AS taker_user_id, tk.nickname AS taker_nickname, tk.phone AS taker_phone,
            tk.account_no AS taker_account_no, tk.student_id AS taker_student_id,
            tk.avatar AS taker_avatar, tk.is_campus_audit AS taker_campus_audit,
            tk.ban_take_time AS taker_ban_take_time
       FROM report r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN tasks t ON t.id = r.task_id
       LEFT JOIN users ow ON ow.id = t.user_id
       LEFT JOIN users tk ON tk.id = t.taker_user_id
       ${whereSql}
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM report r' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 管理员处理举报（幂等：仅待处理状态可处理）
 * @returns {Promise<number>} 受影响行数
 */
async function handle(id, adminNote, conn = null) {
  const sql = 'UPDATE report SET status = 2, admin_note = ? WHERE id = ? AND status = 1';
  if (conn) {
    const [result] = await conn.execute(sql, [adminNote, id]);
    return result.affectedRows;
  }
  const result = await execute(sql, [adminNote, id]);
  return result.affectedRows;
}

module.exports = {
  create,
  buildTaskSnapshot,
  findById,
  findPendingByUserAndTask,
  countRecentByUserAndTask,
  listForAdmin,
  handle
};
