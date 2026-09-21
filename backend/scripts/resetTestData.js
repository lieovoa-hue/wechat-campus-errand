const mysql = require('mysql2/promise');
require('dotenv').config();
(async () => {
  const conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'campus_errand' });
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['user_bill','payments','report','messages','appeals','audit_apply','tasks','sms_code','users']) {
    await conn.query('TRUNCATE TABLE `' + t + '`');
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('所有表已清空');
  await conn.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
