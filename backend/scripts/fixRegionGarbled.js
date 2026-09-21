/**
 * =====================================================================
 * 修复「我的设备」登录地点乱码（U+FFFD 替换字符）
 *   node scripts/fixRegionGarbled.js --dry-run   # 只看哪些设备中招
 *   node scripts/fixRegionGarbled.js             # 重新解析并写回
 * ---------------------------------------------------------------------
 * 背景：备用通道 whois.pconline.com.cn 返回 GBK，早期代码按 UTF-8 解码，
 *       汉字被替换成 U+FFFD（），写库后无法还原，只能按 IP 重新解析。
 * 修复：src/utils/ipRegion.js 已改为「Content-Type charset -> 严格 UTF-8 ->
 *       GB18030 兜底」，本脚本把历史脏数据按新逻辑重刷一遍。
 * =====================================================================
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { resolveRegion } = require('../src/utils/ipRegion');

const DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
const BAD = '\uFFFD';

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'campus_errand'
  });
  const [rows] = await conn.query(
    'SELECT id, login_ip, login_region FROM user_device WHERE login_region LIKE ? OR login_region = ?',
    ['%' + BAD + '%', BAD]
  );
  if (!rows.length) {
    console.log('没有发现乱码的登录地点记录');
    await conn.end();
    return;
  }
  console.log('发现 ' + rows.length + ' 条乱码记录：');
  for (const row of rows) {
    let region = '';
    try {
      region = await resolveRegion(row.login_ip);
    } catch (err) {
      region = '';
    }
    console.log('  id=' + row.id + ' ip=' + row.login_ip + ' 旧值=[' + row.login_region + '] -> 新值=[' + (region || '（解析失败，置空）') + ']');
    if (!DRY_RUN) {
      await conn.query('UPDATE user_device SET login_region = ? WHERE id = ?', [region, row.id]);
    }
  }
  console.log(DRY_RUN ? '--dry-run 模式：未写库' : '修复完成');
  await conn.end();
})().catch((e) => { console.error('修复异常：', e.message); process.exit(1); });
