/**
 * =====================================================================
 * 发布券（虚拟支付 B 方案）回归脚本
 * ---------------------------------------------------------------------
 * 背景：微信个人主体虚拟支付不支持退款，所以「撤销退费」改造为「返还发布券」：
 *   1. 有券时发布任务自动用券抵扣（不花钱）；
 *   2. 没券时按现金 0.1 元走支付（本地为模拟支付）；
 *   3. 撤销任务并申请退券后，账号重新获得 1 张发布券。
 * 覆盖：
 *   A. 现金单：pay_channel=1 / service_fee=0.1 / 撤券后余额 +1
 *   B. 券单：pay_channel=2 / service_fee=0 / 直接上架 / 余额 -1
 *   C. 券单撤销退券：余额回到 1，且不可重复退
 *   D. 免费代拿权益单不受发布券逻辑影响（撤销返还权益而不是券）
 * 运行：node scripts/regression-coupon-pay.js   （需先启动后端服务）
 * =====================================================================
 */

const h = require('./_accountHelper');
const db = require('../src/db/db');
const { PAY_CHANNEL_ENUM, PAY_STATUS_ENUM, BILL_TYPE_ENUM } = require('../src/utils/constant');

let passCount = 0;
let failCount = 0;
const failedNames = [];

function title(text) {
  console.log('\n===== ' + text + ' =====');
}

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    console.log('  [PASS] ' + name);
  } else {
    failCount += 1;
    failedNames.push(name);
    console.log('  [FAIL] ' + name + ' ' + (extra === undefined ? '' : JSON.stringify(extra)));
  }
}

function api(method, path, body, token) {
  return h.request(method, path, body, { token, deviceId: 'coupon-device' });
}

async function taskRow(taskId) {
  const rows = await db.query('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
  return rows[0];
}

async function paymentRow(taskId) {
  const rows = await db.query('SELECT * FROM payments WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId]);
  return rows[0];
}

async function couponCount(token) {
  const res = await api('GET', '/api/user/info', null, token);
  return Number((res.data && res.data.user && res.data.user.publishCouponCount) || 0);
}

let formSeq = 0;
function taskForm() {
  formSeq += 1;
  return {
    receiverName: '券测试收件人',
    receiverPhone: h.testPhone(2001),
    deliverAddress: 'X栋X楼A' + (100 + formSeq),
    detailAddress: '发布券回归 A' + formSeq,
    pickupCode: '9-1-30' + (10 + formSeq),
    remark: '发布券回归测试任务 ' + formSeq,
    reward: 2,
    img1: '/uploads/test/task_a.jpg'
  };
}

async function publish(token) {
  let res = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    res = await api('POST', '/api/task/createOrder', taskForm(), token);
    if (res.code === 200 && res.data) return res;
    if (!/过于频繁/.test(res.msg || '')) break;
    await h.sleep(20000);
  }
  throw new Error('发布任务失败：' + res.code + ' ' + res.msg);
}

/** 关闭数据库连接池（脚本结束时必须调用，否则进程不会退出） */
async function closeDb() {
  try {
    if (typeof db.closePool === 'function') await db.closePool();
    else if (db.pool && db.pool.end) await db.pool.end();
  } catch (err) {
    /* 忽略关闭连接池异常 */
  }
}

const createdAccountNos = [];

async function main() {
  title('0. 环境自检');
  const health = await api('GET', '/api/health');
  check('后端健康检查通过', health.code === 200, health.msg);
  check('本地为模拟支付模式（不会真实扣款）', health.data && health.data.payMode === 'simulate', health.data && health.data.payMode);

  const employer = await h.createCertifiedUser({
    adminToken: await h.adminToken(), name: '发布券回归雇主', studentId: '20259931', phone: h.testPhone(2001)
  });
  createdAccountNos.push(employer.accountNo);
  check('新账号初始没有发布券', (await couponCount(employer.token)) === 0);

  // ---------------------------------------------------------------- A. 现金单
  title('A. 现金单：没券时正常付 0.1 元发布');
  const cashRes = await publish(employer.token);
  const cashTaskId = cashRes.data.taskId;
  const cashRow = await taskRow(cashTaskId);
  const cashPay = await paymentRow(cashTaskId);
  check('现金单 pay_channel=1（现金支付）', Number(cashRow.pay_channel) === PAY_CHANNEL_ENUM.CASH, cashRow.pay_channel);
  check('现金单服务费 0.1 元', Number(cashRow.service_fee) === 0.1, cashRow.service_fee);
  check('支付流水金额 0.1 元并已支付', Number(cashPay.total_fee) === 0.1 && Number(cashPay.status) === PAY_STATUS_ENUM.SUCCESS, cashPay);
  check('现金单会生成服务费支出账单',
    (await db.query('SELECT id FROM user_bill WHERE task_id = ? AND type = ?', [cashTaskId, BILL_TYPE_ENUM.SERVICE_FEE])).length === 1);
  check('发完现金单后仍没有发布券', (await couponCount(employer.token)) === 0);

  // ---------------------------------------------------------------- A2. 撤销退券
  title('A2. 撤销现金单 -> 申请退券 -> 余额 +1');
  const cancelCash = await api('POST', '/api/task/cancel', { taskId: cashTaskId }, employer.token);
  check('撤销成功且提示可申请退券', cancelCash.code === 200 && cancelCash.data.canApplyRefund === true, cancelCash.data);
  const refundCash = await api('POST', '/api/task/applyRefund', { taskId: cashTaskId }, employer.token);
  check('申请退券成功', refundCash.code === 200, refundCash.msg);
  const cashPayAfter = await paymentRow(cashTaskId);
  check('支付流水被标记为已退款', Number(cashPayAfter.status) === PAY_STATUS_ENUM.REFUNDED, cashPayAfter.status);
  const cashTaskAfter = await taskRow(cashTaskId);
  check('任务标记 is_refunded=1', Number(cashTaskAfter.is_refunded) === 1, cashTaskAfter.is_refunded);
  check('发布券余额变为 1 张', (await couponCount(employer.token)) === 1);
  const refundAgain = await api('POST', '/api/task/applyRefund', { taskId: cashTaskId }, employer.token);
  check('重复申请退券被拒绝（幂等）', refundAgain.code === 409, refundAgain.msg);
  check('重复申请后余额没有被重复加', (await couponCount(employer.token)) === 1);

  // ---------------------------------------------------------------- B. 券单
  title('B. 券单：有券时自动抵扣，不花现金');
  const couponRes = await publish(employer.token);
  const couponTaskId = couponRes.data.taskId;
  check('发布接口直接返回已支付（无需唤起支付）', couponRes.data.paid === true, couponRes.data);
  check('发布接口标记 couponUsed=true', couponRes.data.couponUsed === true, couponRes.data);
  check('发布接口返回的应付服务费为 0', Number(couponRes.data.serviceFee) === 0, couponRes.data.serviceFee);
  const couponRow = await taskRow(couponTaskId);
  const couponPay = await paymentRow(couponTaskId);
  check('券单 pay_channel=2（发布券）', Number(couponRow.pay_channel) === PAY_CHANNEL_ENUM.COUPON, couponRow.pay_channel);
  check('券单服务费 0 元', Number(couponRow.service_fee) === 0, couponRow.service_fee);
  check('券单支付流水金额 0 元且已支付', Number(couponPay.total_fee) === 0 && Number(couponPay.status) === PAY_STATUS_ENUM.SUCCESS, couponPay);
  check('券单不生成服务费支出账单',
    (await db.query('SELECT id FROM user_bill WHERE task_id = ? AND type = ?', [couponTaskId, BILL_TYPE_ENUM.SERVICE_FEE])).length === 0);
  check('用券后余额归零', (await couponCount(employer.token)) === 0);
  check('券单任务已上架（支付状态为成功）',
    (await db.query('SELECT id FROM payments WHERE task_id = ? AND status = ?', [couponTaskId, PAY_STATUS_ENUM.SUCCESS])).length === 1);

  // ---------------------------------------------------------------- C. 券单退券
  title('C. 券单撤销退券：余额回到 1 张');
  const cancelCoupon = await api('POST', '/api/task/cancel', { taskId: couponTaskId }, employer.token);
  check('券单撤销成功', cancelCoupon.code === 200 && cancelCoupon.data.canApplyRefund === true, cancelCoupon.data);
  const refundCoupon = await api('POST', '/api/task/applyRefund', { taskId: couponTaskId }, employer.token);
  check('券单退券成功', refundCoupon.code === 200, refundCoupon.msg);
  check('券单退券后余额回到 1 张', (await couponCount(employer.token)) === 1);

  // ---------------------------------------------------------------- D. 免费权益不串味
  title('D. 免费代拿权益单不影响发布券');
  // 直接给雇主发 1 次「免费代拿」权益：验证「权益优先于发布券」且撤销时返还的是权益而不是券
  await db.query(
    'UPDATE users SET free_delivery_count = 1, free_delivery_expire = DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id = ?',
    [employer.user.userId]
  );
  const freeForm = Object.assign(taskForm(), { useFreeDelivery: true });
  const freeRes = await api('POST', '/api/task/createOrder', freeForm, employer.token);
  check('免费代拿权益单发布成功', freeRes.code === 200 && freeRes.data.paid === true, freeRes.msg);
  const freeRow = await taskRow(freeRes.data.taskId);
  check('免费单 pay_channel=0（免费代拿权益）', Number(freeRow.pay_channel) === PAY_CHANNEL_ENUM.FREE, freeRow.pay_channel);
  check('免费单不使用发布券（余额仍为 1 张）', (await couponCount(employer.token)) === 1);
  const freeCancel = await api('POST', '/api/task/cancel', { taskId: freeRes.data.taskId }, employer.token);
  check('免费单撤销返还的是权益次数而不是发布券',
    freeCancel.code === 200 && freeCancel.data.freeDeliveryReturned === true
    && (await couponCount(employer.token)) === 1, freeCancel.data);
  // ---------------------------------------------------------------- 清理
  title('E. 清理测试数据');
  const purged = await h.purgeAccounts(createdAccountNos);
  check('测试账号与关联数据已清理', purged > 0, purged);

  console.log('\n===== 结果：' + passCount + ' 项通过 / ' + failCount + ' 项失败（共 ' + (passCount + failCount) + ' 项）=====');
  if (failedNames.length) {
    console.log('失败项：');
    failedNames.forEach((n) => console.log('  - ' + n));
  }
  await closeDb();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (err) => {
  console.error('脚本异常：', err);
  await h.purgeAccounts(createdAccountNos);
  await closeDb();
  process.exit(1);
});
