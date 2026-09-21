/**
 * =====================================================================
 * 站内消息数据访问层（messages）
 * 消息类型 msg_type：1系统 2管理员 3任务 4雇主
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

/**
 * 创建站内消息（常用于事务内，与业务操作保持一致性）
 * @param {object} data { userId, msgType, title, content }
 */
async function create({ userId, msgType, title, content }, conn = null) {
  const sql = 'INSERT INTO messages (user_id, msg_type, title, content, is_read) VALUES (?, ?, ?, ?, 0)';
  const params = [userId, msgType, title, content];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/**
 * 消息列表（可按类型筛选，时间倒序）
 * @param {object} options { userId, msgType, offset, limit }
 */
async function listByUser({ userId, msgType = null, offset = 0, limit = 10 }) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (msgType !== null && msgType !== '' && msgType !== undefined) {
    where.push('msg_type = ?');
    params.push(Number(msgType));
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    'SELECT * FROM messages' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM messages' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 未读消息数量 */
async function countUnread(userId) {
  const rows = await query('SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND is_read = 0', [userId]);
  return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * 各分类未读数（消息中心分类 Tab 上的角标）
 * @param {number} userId
 * @returns {Promise<Object<number, number>>} { 1: 系统未读, 2: 管理员未读, ... }
 */
async function countUnreadByType(userId) {
  const rows = await query(
    'SELECT msg_type, COUNT(*) AS total FROM messages WHERE user_id = ? AND is_read = 0 GROUP BY msg_type',
    [userId]
  );
  const result = {};
  rows.forEach((row) => { result[Number(row.msg_type)] = Number(row.total); });
  return result;
}

/**
 * 全部删除（物理删除本人所有消息，含已读）
 * ---------------------------------------------------------------------
 * 与「清除未读」的区别：未读那一个只删未读消息，这里连已读一起清空，
 * 用于消息中心「全部删除」按钮（用户主动清空收件箱）。
 * @param {number} userId 当前登录用户 id
 * @returns {Promise<number>} 实际删除条数
 */
async function deleteAll(userId) {
  const result = await execute('DELETE FROM messages WHERE user_id = ?', [userId]);
  return result ? Number(result.affectedRows || 0) : 0;
}

/** 一键全部标记已读（幂等） */
function markAllRead(userId, conn = null) {
  return run(conn, 'UPDATE messages SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
}

/** 单条标记已读 */
function markRead(userId, id, conn = null) {
  return run(conn, 'UPDATE messages SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
}

/**
 * 查询单条消息（同时用 user_id 做归属校验，杜绝越权读他人消息）
 * @param {number} userId 当前登录用户 id
 * @param {number} id 消息 id
 * @returns {Promise<object|null>} 不存在或不属于本人时返回 null
 */
async function findById(userId, id) {
  const rows = await query('SELECT * FROM messages WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
  return rows[0] || null;
}

/**
 * 清除全部未读消息（物理删除，仅删本人的未读记录）
 * ---------------------------------------------------------------------
 * 与「一键已读」的区别：
 *   · 一键已读：is_read 置 1，消息仍留在列表里（保留历史）；
 *   · 一键清除：直接把未读消息删掉，列表里不再出现。
 * 条件里带 user_id，保证任何人都只能清理自己的消息。
 * @param {number} userId 当前登录用户 id
 * @returns {Promise<number>} 实际清除的条数
 */
async function clearUnread(userId) {
  const result = await execute('DELETE FROM messages WHERE user_id = ? AND is_read = 0', [userId]);
  return result ? Number(result.affectedRows || 0) : 0;
}

module.exports = {
  create,
  listByUser,
  countUnread,
  markAllRead,
  markRead,
  findById,
  clearUnread,
  countUnreadByType,
  deleteAll
};
