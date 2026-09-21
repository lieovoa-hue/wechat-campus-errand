/**
 * =====================================================================
 * 独立回归测试库初始化脚本
 * ---------------------------------------------------------------------
 * 作用：创建 / 重建 campus_errand_test 库并导入 sql/init.sql 的全部表结构。
 *
 * 为什么需要它？
 *   smokeTest.js / scheduleTest.js 会注册大量测试账号（13800138001 等），
 *   必须在「干净」的数据库上运行；若直接跑在正式库 campus_errand 上会污染真实数据。
 *
 * 用法（严格按顺序执行）：
 *   1) 若 3100 测试实例正在运行，先停掉它
 *      （DROP DATABASE 会让该实例已建立的连接失效，必须先停）
 *   2) node scripts/initTestDb.js                # 重建测试库
 *   3) $env:PORT='3100'; $env:DB_NAME='campus_errand_test'; node src/app.js
 *   4) $env:SMOKE_BASE='http://127.0.0.1:3100'; node scripts/smokeTest.js
 *      $env:DB_NAME='campus_errand_test'; $env:SMOKE_BASE='http://127.0.0.1:3100'; node scripts/scheduleTest.js
 *
 * 注意：接口限流是「后端进程内存」实现，同一分钟内重复跑 smokeTest 会触发
 *       「发布过于频繁」，重启 3100 实例即可清零。
 * =====================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** 测试库名（固定，绝不使用正式库名） */
const TEST_DB = process.env.TEST_DB_NAME || 'campus_errand_test';

/** 安全兜底：防止误把正式库当测试库删除 */
if (TEST_DB === (process.env.DB_NAME || 'campus_errand')) {
  console.error('测试库名不能与正式库名相同，已终止执行');
  process.exit(1);
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  await conn.query(
    `DROP DATABASE IF EXISTS \`${TEST_DB}\`;
     CREATE DATABASE \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`
  );

  // 复用正式建表脚本，仅替换库名，保证测试库结构与正式库完全一致
  const sqlText = fs.readFileSync(path.resolve(__dirname, '../sql/init.sql'), 'utf8')
    .replace(/campus_errand/g, TEST_DB);
  await conn.query(sqlText);

  const [tables] = await conn.query(`SHOW TABLES FROM \`${TEST_DB}\`;`);
  console.log(`测试库 ${TEST_DB} 初始化完成，共 ${tables.length} 张表`);
  console.log(`下一步：$env:PORT='3100'; $env:DB_NAME='${TEST_DB}'; node src/app.js`);
  await conn.end();
})().catch((err) => {
  console.error('测试库初始化失败：', err.message);
  process.exit(1);
});
