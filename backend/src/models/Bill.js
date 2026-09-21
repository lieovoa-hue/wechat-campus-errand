/**
 * =====================================================================
 * 用户收支账单数据访问层（user_bill）
 * 纯记账：平台不托管酬金，无提现功能，账单只能查看不可修改
 * 类型：1任务收入 2服务费支出
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const { BILL_TYPE_ENUM } = require('../utils/constant');

async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/**
 * 生成一条账单流水（事务内调用，与任务状态变更保持强一致）
 * @param {object} data { userId, taskId, type, amount, remark }
 */
async function create({ userId, taskId, type, amount, remark }, conn = null) {
  const sql = 'INSERT INTO user_bill (user_id, task_id, type, amount, remark) VALUES (?, ?, ?, ?, ?)';
  const params = [userId, taskId, type, amount, remark || ''];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/**
 * 判断账单是否已存在（记账幂等，防止重复生成同一条流水）
 * @param {number} taskId 任务 id
 * @param {number} userId 用户 id
 * @param {number} type 账单类型
 */
async function exists(taskId, userId, type, conn = null) {
  const rows = await run(
    conn,
    'SELECT id FROM user_bill WHERE task_id = ? AND user_id = ? AND type = ? LIMIT 1',
    [taskId, userId, type]
  );
  return rows.length > 0;
}

/**
 * 我的账单列表（时间倒序，可带任务信息方便点击跳转详情）
 * @param {object} options { userId, type, offset, limit }
 */
async function listByUser({ userId, type = null, offset = 0, limit = 10 }) {
  const where = ['b.user_id = ?'];
  const params = [userId];
  if (type !== null && type !== '' && type !== undefined) {
    where.push('b.type = ?');
    params.push(Number(type));
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    `SELECT b.*, t.deliver_address, t.reward, t.status AS task_status
       FROM user_bill b
       LEFT JOIN tasks t ON t.id = b.task_id
       ${whereSql}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query('SELECT COUNT(*) AS total FROM user_bill b' + whereSql, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 汇总用户收支（供账单页顶部展示） */
async function summary(userId) {
  const rows = await query(
    `SELECT
        IFNULL(SUM(CASE WHEN type = ? THEN amount ELSE 0 END), 0) AS income,
        IFNULL(SUM(CASE WHEN type = ? THEN amount ELSE 0 END), 0) AS expense,
        COUNT(*) AS total
      FROM user_bill WHERE user_id = ?`,
    [BILL_TYPE_ENUM.TASK_INCOME, BILL_TYPE_ENUM.SERVICE_FEE, userId]
  );
  return rows[0] || { income: 0, expense: 0, total: 0 };
}

/**
 * 同步「任务收入」账单金额（仅管理员在订单管理中修正已完成订单酬金时调用）
 * ---------------------------------------------------------------------
 * 账单是纯记账记录，正常情况下只增不改；
 * 但当管理员修正一条**已完成**订单的酬金后，必须同步账单金额，
 * 否则会出现「任务详情显示 5 元、账单却还是 3 元」的对账口径不一致。
 * @param {number} taskId 任务ID
 * @param {number} userId 接单人 user_id
 * @param {number} amount 修正后的金额
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function updateTaskIncomeAmount(taskId, userId, amount, conn = null) {
  const rows = await run(
    conn,
    'UPDATE user_bill SET amount = ? WHERE task_id = ? AND user_id = ? AND type = ?',
    [amount, taskId, userId, BILL_TYPE_ENUM.TASK_INCOME]
  );
  return rows.affectedRows;
}

module.exports = {
  create,
  exists,
  listByUser,
  summary,
  updateTaskIncomeAmount
};
