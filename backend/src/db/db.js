/**
 * =====================================================================
 * MySQL 8.0 连接池（mysql2/promise）
 * - 全项目统一从此处获取连接，禁止在业务代码里单独 new Connection
 * - 所有 SQL 必须使用参数化占位符 ?，严禁字符串拼接，防御 SQL 注入
 * =====================================================================
 */

// 显式加载环境变量，保证单独 require 本文件时也能拿到配置
require('dotenv').config();

const mysql = require('mysql2/promise');
const { log } = require('../utils/common');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'campus_errand',
  waitForConnections: true,
  connectionLimit: 10,        // 连接池最大连接数
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,              // 排队不限制
  charset: 'utf8mb4',
  // DECIMAL 类型以数字返回，避免前端出现字符串金额
  decimalNumbers: true,
  // 时间字段以 'YYYY-MM-DD HH:mm:ss' 字符串返回，避免时区来回转换引发误差
  dateStrings: true,
  timezone: '+08:00',
  // 关闭多语句执行，进一步降低注入风险
  multipleStatements: false
});

/**
 * 执行 SQL（自动从池中取连接并归还）
 * @param {string} sql 含 ? 占位符的 SQL
 * @param {Array} params 参数数组
 * @returns {Promise<Array|object>} 查询结果
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 执行写操作，返回 result（含 affectedRows / insertId）
 */
async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * 获取一个独立连接（事务内部使用）
 */
async function getConnection() {
  return pool.getConnection();
}

/**
 * 事务封装：所有多步写操作必须走这里，保证数据一致性
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} handler
 * @returns {Promise<any>} handler 的返回值
 */
async function transaction(handler) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      log('error', '事务回滚失败：', rollbackErr.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 启动时检测数据库连通性
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

/**
 * 优雅关闭连接池
 */
async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  execute,
  getConnection,
  transaction,
  testConnection,
  closePool
};
