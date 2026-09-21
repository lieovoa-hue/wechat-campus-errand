/**
 * =====================================================================
 * 支付流水数据访问层（payments）
 * 状态：0待支付 1支付成功 2支付失败 3已退款
 * 关键操作均使用条件更新（乐观锁）保证幂等，回调重复推送不会重复记账
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const { PAY_STATUS_ENUM } = require('../utils/constant');

async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/**
 * 创建支付流水（发起发布任务时创建）
 * @param {object} data { userId, taskId, outTradeNo, totalFee }
 */
async function create({ userId, taskId, outTradeNo, totalFee }, conn = null) {
  const sql = `INSERT INTO payments (user_id, task_id, out_trade_no, total_fee, pay_type, status)
    VALUES (?, ?, ?, ?, 1, ?)`;
  const params = [userId, taskId, outTradeNo, totalFee, PAY_STATUS_ENUM.UNPAID];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.insertId;
  }
  const result = await execute(sql, params);
  return result.insertId;
}

/** 按主键查询 */
function findById(id, conn = null) {
  return run(conn, 'SELECT * FROM payments WHERE id = ? LIMIT 1', [id]).then((rows) => rows[0] || null);
}

/** 按任务查询最近一条支付流水 */
function findByTaskId(taskId, conn = null) {
  return run(
    conn,
    'SELECT * FROM payments WHERE task_id = ? ORDER BY id DESC LIMIT 1',
    [taskId]
  ).then((rows) => rows[0] || null);
}

/** 按商户订单号查询 */
function findByOutTradeNo(outTradeNo, conn = null) {
  return run(conn, 'SELECT * FROM payments WHERE out_trade_no = ? LIMIT 1', [outTradeNo]).then((rows) => rows[0] || null);
}

/** 按商户订单号加行锁查询（支付回调事务内使用） */
function findByOutTradeNoForUpdate(outTradeNo, conn) {
  return run(
    conn,
    'SELECT * FROM payments WHERE out_trade_no = ? LIMIT 1 FOR UPDATE',
    [outTradeNo]
  ).then((rows) => rows[0] || null);
}

/**
 * 标记支付成功（幂等：仅待支付状态可流转为成功）
 * @returns {Promise<number>} 受影响行数，0 表示已处理过（重复回调直接忽略）
 */
async function markPaid(outTradeNo, transactionId, conn = null) {
  const sql = 'UPDATE payments SET status = ?, transaction_id = ? WHERE out_trade_no = ? AND status = ?';
  const params = [PAY_STATUS_ENUM.SUCCESS, transactionId || '', outTradeNo, PAY_STATUS_ENUM.UNPAID];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.affectedRows;
  }
  const result = await execute(sql, params);
  return result.affectedRows;
}

/**
 * 标记支付失败（幂等）
 */
async function markFailed(outTradeNo, conn = null) {
  return run(
    conn,
    'UPDATE payments SET status = ? WHERE out_trade_no = ? AND status = ?',
    [PAY_STATUS_ENUM.FAIL, outTradeNo, PAY_STATUS_ENUM.UNPAID]
  );
}

/**
 * 标记已退款（幂等：仅支付成功状态可退）
 * @returns {Promise<number>} 受影响行数
 */
async function markRefunded(id, refundFee, conn = null) {
  const sql = 'UPDATE payments SET status = ?, refund_fee = ?, refund_time = NOW() WHERE id = ? AND status = ?';
  const params = [PAY_STATUS_ENUM.REFUNDED, refundFee, id, PAY_STATUS_ENUM.SUCCESS];
  if (conn) {
    const [result] = await conn.execute(sql, params);
    return result.affectedRows;
  }
  const result = await execute(sql, params);
  return result.affectedRows;
}

/** 任务是否已支付成功 */
async function hasPaid(taskId, conn = null) {
  const rows = await run(
    conn,
    'SELECT id FROM payments WHERE task_id = ? AND status = ? LIMIT 1',
    [taskId, PAY_STATUS_ENUM.SUCCESS]
  );
  return rows.length > 0;
}

module.exports = {
  create,
  findById,
  findByTaskId,
  findByOutTradeNo,
  findByOutTradeNoForUpdate,
  markPaid,
  markFailed,
  markRefunded,
  hasPaid
};
