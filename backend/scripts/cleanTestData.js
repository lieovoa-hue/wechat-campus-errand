/**
 * =====================================================================
 * 测试数据清理脚本（把自动化回归产生的测试账号及关联数据一并删除）
 *   node scripts/cleanTestData.js            # 清理
 *   node scripts/cleanTestData.js --dry-run  # 只看会删哪些账号，不真正删除
 * ---------------------------------------------------------------------
 * 识别规则（只认这三种，绝不动真实用户）：
 *   1. 昵称命中测试昵称清单（回归雇主 / 并发跑腿A / 举报测试雇主 …）
 *   2. 学号命中测试学号段（202599xx / 20259999）
 *   3. 手机号是脚本生成的测试号（形如 13000001001，中间连续 5 个 0）
 * =====================================================================
 */

const h = require('./_accountHelper');
const db = require('../src/db/db');

const NICKNAMES = ['回归雇主', '回归跑腿', '同学号测试', '并发跑腿A', '并发跑腿B', '举报测试雇主', '退费限制雇主',
  '辅助自检', '定时雇主', '定时跑腿', '锁定测试', '被邀请用户', '封禁测试用户', '测试同学', '登录定位探针',
  '无手机号A', '无手机号B', '下架测试雇主'];
const STUDENT_IDS = ['20259901', '20259902', '20259903', '20259904', '20259905', '20259906', '20259999',
  '20259907', '20259908', '20259911', '20259912', '20240010', '20240011', '20240012', '20240020'];
const dryRun = process.argv.indexOf('--dry-run') >= 0;

(async () => {
  const ph = NICKNAMES.map(() => '?').join(',');
  const sph = STUDENT_IDS.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT id, account_no, nickname, student_id, phone FROM users
      WHERE nickname IN (${ph})
         OR (student_id <> '' AND student_id IN (${sph}))
         OR phone LIKE '1_00000%'`,
    NICKNAMES.concat(STUDENT_IDS)
  );

  if (!rows.length) {
    console.log('没有需要清理的测试账号');
  } else if (dryRun) {
    console.log('将被清理的账号（--dry-run 未实际删除）：');
    rows.forEach((r) => console.log(`  ${r.account_no}  昵称=${r.nickname}  学号=${r.student_id || '-'}  手机=${r.phone || '-'}`));
  } else {
    const n = await h.purgeAccounts(rows.map((r) => r.account_no));
    console.log('已清理账号数：' + n);
    rows.forEach((r) => console.log(`  ${r.account_no}  昵称=${r.nickname}  学号=${r.student_id || '-'}  手机=${r.phone || '-'}`));
  }
  await db.pool.end();
})().catch((e) => { console.error('清理异常：', e.message); process.exit(1); });
