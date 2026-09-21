/**
 * =====================================================================
 * 申诉数据访问层（appeals）
 * 规则：单用户每日最多提交 2 条，每日 0 点重置（按自然日统计 created_at）
 * =====================================================================
 */

const { query, execute } = require('../db/db');

async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/** 提交申诉 */
async function create({ userId, content }, conn = null) {
  const sql = 'INSERT INTO appeals (user_id, content, status) VALUES (?, ?, 1)';
  if (conn) {
    const [result] = await conn.execute(sql, [userId, content]);
    return result.insertId;
  }
  const result = await execute(sql, [userId, content]);
  return result.insertId;
}

/** 按主键查询 */
function findById(id, conn = null) {
  return run(conn, 'SELECT * FROM appeals WHERE id = ? LIMIT 1', [id]).then((rows) => rows[0] || null);
}

/** 按主键加行锁查询 */
function findByIdForUpdate(id, conn) {
  return run(conn, 'SELECT * FROM appeals WHERE id = ? LIMIT 1 FOR UPDATE', [id]).then((rows) => rows[0] || null);
}

/** 统计用户今日已提交的申诉数量（每日 0 点自然重置） */
async function countTodayByUser(userId) {
  const rows = await query(
    'SELECT COUNT(*) AS total FROM appeals WHERE user_id = ? AND DATE(created_at) = CURDATE()',
    [userId]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

/** 我的申诉记录 */
async function listByUser({ userId, status = null, offset = 0, limit = 10 }) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (status !== null && status !== '' && status !== undefined) {
    where.push('status = ?');
    params.push(Number(status));
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    'SELECT * FROM appeals' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM appeals' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 管理员申诉列表 */
async function listForAdmin({ status = null, offset = 0, limit = 10 }) {
  const where = [];
  const params = [];
  if (status !== null && status !== '' && status !== undefined) {
    where.push('a.status = ?');
    params.push(Number(status));
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const list = await query(
    'SELECT a.*, u.nickname, u.phone, u.student_id FROM appeals a LEFT JOIN users u ON u.id = a.user_id' +
      whereSql + ' ORDER BY a.id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM appeals a' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 管理员回复申诉（幂等：仅待处理状态可回复）
 * @returns {Promise<number>} 受影响行数
 */
async function reply(id, adminReply, conn = null) {
  const sql = 'UPDATE appeals SET admin_reply = ?, status = 2 WHERE id = ? AND status = 1';
  if (conn) {
    const [result] = await conn.execute(sql, [adminReply, id]);
    return result.affectedRows;
  }
  const result = await execute(sql, [adminReply, id]);
  return result.affectedRows;
}

module.exports = {
  create,
  findById,
  findByIdForUpdate,
  countTodayByUser,
  listByUser,
  listForAdmin,
  reply
};
