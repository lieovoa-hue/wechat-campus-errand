/**
 * =====================================================================
 * 公告数据访问层（announcements）
 * ---------------------------------------------------------------------
 * 展示位置 scope：
 *   1 跑马灯   —— 首页头部下方的横向滚动条，多条自动轮播
 *   2 通知条   —— 全局顶部横幅（各页面顶部，可关闭）
 * 两套内容分开维护：管理员在后台分别发布，互不影响。
 * 生效规则：is_active = 1 且（start_at 为空或已到时间）且（end_at 为空或未到期）。
 * =====================================================================
 */

const { query, execute } = require('../db/db');

/**
 * 新建公告
 * @param {object} data { scope, content, sort, startAt, endAt, isClosable, creatorId }
 * @param {object} conn 可选事务连接
 * @returns {Promise<number>} 新公告 id
 */
async function create({ scope, content, sort = 0, startAt = null, endAt = null, isClosable = 1, creatorId = null }, conn = null) {
  const sql = 'INSERT INTO announcements (scope, content, sort, start_at, end_at, is_closable, creator_id)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)';
  const params = [scope, content, sort, startAt, endAt, isClosable, creatorId];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/** 记录本次发布一并推送消息中心的用户数 */
function setPushCount(id, count) {
  return execute('UPDATE announcements SET push_count = ? WHERE id = ?', [count, id]);
}

/**
 * 管理员列表（按展示位置筛选，展示位置为空表示全部）
 */
async function listAdmin({ scope = null, offset = 0, limit = 10 }) {
  const where = [];
  const params = [];
  if (scope !== null && scope !== undefined && scope !== '') {
    where.push('scope = ?');
    params.push(Number(scope));
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const list = await query(
    'SELECT * FROM announcements' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM announcements' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 用户端生效中的公告（跑马灯 / 通知条各自调用一次）
 * 排序：sort 降序（数值越大越靠前），其次按发布时间倒序
 */
function listActive(scope) {
  return query(
    'SELECT id, scope, content, is_closable, sort, start_at, end_at, created_at'
    + ' FROM announcements'
    + ' WHERE scope = ? AND is_active = 1'
    + ' AND (start_at IS NULL OR start_at <= NOW())'
    + ' AND (end_at IS NULL OR end_at > NOW())'
    + ' ORDER BY sort DESC, id DESC LIMIT 20',
    [Number(scope)]
  );
}

/** 按 id 查询（管理员操作前的存在性校验） */
async function findById(id) {
  const rows = await query('SELECT * FROM announcements WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

/** 按 id 列表查询 */
function findByIds(ids) {
  if (!ids.length) return Promise.resolve([]);
  const placeholders = ids.map(() => '?').join(', ');
  return query('SELECT * FROM announcements WHERE id IN (' + placeholders + ')', ids);
}

/**
 * 更新公告（只允许更新内容 / 上下架 / 排序 / 生效起止时间）
 * @param {number} id 公告 id
 * @param {object} fields 已由控制器白名单过滤的字段
 */
async function updateFields(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return 0;
  const sql = 'UPDATE announcements SET ' + keys.map((key) => key + ' = ?').join(', ') + ' WHERE id = ?';
  const result = await execute(sql, keys.map((key) => fields[key]).concat([id]));
  return result ? Number(result.affectedRows || 0) : 0;
}

/**
 * 物理删除公告（管理员批量清理）
 * @param {number[]} ids
 * @returns {Promise<number>} 实际删除条数
 */
async function deleteByIds(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const result = await execute('DELETE FROM announcements WHERE id IN (' + placeholders + ')', ids);
  return result ? Number(result.affectedRows || 0) : 0;
}

module.exports = {
  create,
  setPushCount,
  listAdmin,
  listActive,
  findById,
  findByIds,
  updateFields,
  deleteByIds
};
