/**
 * =====================================================================
 * 端到端业务回归脚本（新版账号体系：图形验证码 + 账号ID + 密保问题）
 * ---------------------------------------------------------------------
 * 覆盖范围（全部走真实 HTTP 接口，不使用任何后端内部快捷通道）：
 *   1. 注册：图形验证码 / 账号ID 格式 / 弱密码拒绝 / ID 占用拒绝 / 未设密保 428 拦截
 *   2. 校园认证：未认证禁发禁接 / 提交认证 / 管理员审核 / 学号唯一性
 *   3. 发布与支付：模拟支付上架 / 服务费账单 / 任务大厅可见 / 表单强校验
 *   4. 并发接单：乐观锁只允许一个人成功 / 不能接自己的任务 / 限时倒计时
 *   5. 取消接单：10 分钟内可取消并回到待接单
 *   6. 编辑与加酬金：待接单仅可上调 / 进行中只可加酬金 / 3 分钟间隔限制
 *   7. 送达：未上传照片被拒 / 上传后进入待确认
 *   8. 确认送达与自动记账：非雇主不能确认 / 接单者账单入账 / 重复确认幂等
 *   9. 撤销与退费：撤销后 status=5 / 已撤销任务才可退费 / 退费改支付流水 / 被接单过不退费
 *  10. 举报：不能举报自己的任务 / 半小时 3 次上限
 *  11. 权限：非管理员访问管理员接口被拒 / 越权改他人任务被拒
 *  12. 消息与账单：站内消息 / 一键已读 / 账单倒序
 * 运行：node scripts/regression-business-flow.js   （需先启动后端服务）
 * =====================================================================
 */

const h = require('./_accountHelper');
const db = require('../src/db/db');
const {
  TASK_STATUS_ENUM, BILL_TYPE_ENUM, PAY_STATUS_ENUM, AUDIT_STATUS_ENUM, CAMPUS_AUDIT_ENUM
} = require('../src/utils/constant');

let passCount = 0;
let failCount = 0;
const failedNames = [];

function title(text) {
  console.log(`\n===== ${text} =====`);
}

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failCount += 1;
    failedNames.push(name);
    console.log(`  [FAIL] ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`);
  }
}

/** 带令牌的快捷请求 */
function api(method, path, body, token) {
  return h.request(method, path, body, { token, deviceId: 'regression-device' });
}

/** 读取任务行（数据库口径，用于核对真正落库的状态） */
async function taskRow(taskId) {
  const rows = await db.query(
    `SELECT t.*, p.status AS pay_status FROM tasks t
       LEFT JOIN payments p ON p.task_id = t.id AND p.status <> ${PAY_STATUS_ENUM.REFUNDED}
      WHERE t.id = ?`,
    [taskId]
  );
  return rows[0];
}

/** 读取某任务下最新的支付流水 */
async function paymentRow(taskId) {
  const rows = await db.query('SELECT * FROM payments WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId]);
  return rows[0];
}

/** 读取某任务下某用户的账单 */
async function billRows(taskId, userId, type) {
  return db.query(
    'SELECT * FROM user_bill WHERE task_id = ? AND user_id = ? AND type = ?',
    [taskId, userId, type]
  );
}

/** 干净的发布表单（避免幂等键重复命中） */
function taskForm(overrides) {
  return Object.assign({
    receiverName: '李收件',
    receiverPhone: '13900139001',
    deliverAddress: 'X栋X楼A101',
    detailAddress: '宿舍A101门口',
    pickupCode: '8-2-3021',
    timeLimitMin: 60,
    remark: '自动化回归测试任务',
    reward: 2,
    img1: '/uploads/test/task_a.jpg'
  }, overrides || {});
}

/**
 * 发布任务（带限流重试）
 * 后端 publishLimit = 5 次/分钟/账号；本脚本在收尾阶段还会再发布几张任务，
 * 一旦 409「发布过于频繁」直接抛错会让后面几十条断言全部崩掉（data 为 null），
 * 这里统一等一个限流窗口再重试，失败才真正抛出。
 */
async function publishTask(token, overrides, label) {
  let res = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    res = await api('POST', '/api/task/createOrder', taskForm(overrides), token);
    if (res.code === 200 && res.data) return res.data;
    if (!/过于频繁/.test(res.msg || '')) break;
    await h.sleep(20000);
  }
  throw new Error((label || '发布任务') + '失败：' + res.code + ' ' + res.msg);
}

const createdAccountNos = [];

async function main() {
  title('0. 环境自检');
  const health = await api('GET', '/api/health');
  check('后端健康检查通过', health.code === 200, health.msg);
  check('图形验证码开关已开启（短信已下线）', health.data && health.data.captchaEnabled === true, health.data);

  // ---------------------------------------------------------------- 账号体系
  title('1. 注册（图形验证码 + 自选账号ID + 强制设密保）');
  const rand = await api('GET', '/api/user/randomAccountNo');
  check('随机账号ID格式为 X+数字', rand.code === 200 && /^X\d+$/.test(rand.data.accountNo), rand.data && rand.data.accountNo);

  const weakCap = await h.captcha();
  const weakAccountNo = h.localAccountNo();
  const weak = await api('POST', '/api/user/register', {
    accountNo: weakAccountNo, password: '12345678', captchaId: weakCap.captchaId, captchaCode: weakCap.answer, agreeProtocol: true
  });
  check('弱密码（纯数字）被拒绝', weak.code === 400 && /8-20位/.test(weak.msg || ''), weak.msg);

  const noAgreeCap = await h.captcha();
  const noAgreeAccountNo = h.localAccountNo();
  const noAgree = await api('POST', '/api/user/register', {
    accountNo: noAgreeAccountNo, password: 'Abcd1234', captchaId: noAgreeCap.captchaId, captchaCode: noAgreeCap.answer
  });
  check('未勾选用户协议被拒绝', noAgree.code === 400, noAgree.msg);

  // 账号ID 每次随机（X+数字），保证脚本可以反复运行而不会撞上「ID 已被占用」
  const employer = await h.createUser({ phone: h.testPhone(1001), nickname: '回归雇主' });
  createdAccountNos.push(employer.accountNo);
  check('注册成功并返回账号ID', /^X\d+$/.test(employer.accountNo) && employer.user.userIdText === employer.accountNo, employer.user.userIdText);
  check('注册阶段不采集姓名/学号（留到校园认证），且未认证',
    employer.user.studentId === '' && employer.user.isCampusAudit === 0,
    { studentId: employer.user.studentId, isCampusAudit: employer.user.isCampusAudit });

  const dupCap = await h.captcha();
  const dup = await api('POST', '/api/user/register', {
    accountNo: employer.accountNo, password: 'Abcd1234', captchaId: dupCap.captchaId, captchaCode: dupCap.answer, agreeProtocol: true
  });
  check('重复账号ID注册被拒绝', dup.code === 409, dup.code + ' ' + dup.msg);

  const freshReg = await h.register({ phone: h.testPhone(1002) });
  createdAccountNos.push(freshReg.accountNo);
  check('第二个账号注册成功', freshReg.res.code === 200, freshReg.res.msg);
  const freshToken = freshReg.res.data.accessToken;
  const blocked428 = await api('POST', '/api/task/createOrder', taskForm(), freshToken);
  check('未设置密保访问业务接口返回 428', blocked428.code === 428, blocked428.code + ' ' + blocked428.msg);

  // 手机号是选填项：连续两个都不填手机号的账号必须都能注册成功
  // （users.phone 是唯一索引，若后端把「未填写」写成空串，第二个账号会被误判成手机号重复）
  const noPhoneA = await h.createUser({ nickname: '无手机号A' });
  const noPhoneB = await h.createUser({ nickname: '无手机号B' });
  createdAccountNos.push(noPhoneA.accountNo, noPhoneB.accountNo);
  check('手机号选填：连续两个不填手机号的账号都能注册成功',
    noPhoneA.user.phone === '' && noPhoneB.user.phone === '', { a: noPhoneA.user.phone, b: noPhoneB.user.phone });
  const infoWhitelist = await api('GET', '/api/user/info', null, freshToken);
  check('白名单接口 /user/info 不受 428 影响', infoWhitelist.code === 200, infoWhitelist.msg);

  const badSecurity = await h.setSecurity(freshToken, { answers: ['a', 'b'] });
  check('密保答案过短被拒绝', badSecurity.code === 400, badSecurity.msg);
  const okSecurity = await h.setSecurity(freshToken);
  check('设置密保成功', okSecurity.code === 200, okSecurity.msg);
  const afterSecurity = await api('POST', '/api/task/createOrder', taskForm(), freshToken);
  check('设完密保后不再被 428 拦截（改为未认证 403）', afterSecurity.code === 403, afterSecurity.code + ' ' + afterSecurity.msg);

  // ---------------------------------------------------------------- 校园认证
  title('2. 校园认证与权限边界');
  const taker = await h.createUser({ phone: h.testPhone(1003), nickname: '回归跑腿' });
  createdAccountNos.push(taker.accountNo);
  const takerCap = await h.captcha();
  const takerCert = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '回归跑腿', certStudentId: '20259901', certPhone: takerCap ? h.testPhone(1004) : '', applyContent: '/uploads/test/cert.jpg'
  }, taker.token);
  check('未认证账号可提交校园认证申请', takerCert.code === 200, takerCert.msg);
  check('认证申请返回剩余次数（7天内3次，首次后剩2次）',
    takerCert.data && takerCert.data.campusApply && takerCert.data.campusApply.remainTimes === 2,
    takerCert.data && takerCert.data.campusApply);

  const notCertPublish = await api('POST', '/api/task/createOrder', taskForm(), employer.token);
  check('未认证账号不能发布任务', notCertPublish.code === 403 && /校园认证/.test(notCertPublish.msg || ''), notCertPublish.msg);
  const notCertTake = await api('POST', '/api/task/take', { taskId: 1 }, employer.token);
  check('未认证账号不能接单', notCertTake.code === 403, notCertTake.code + ' ' + notCertTake.msg);

  const admin = await h.adminToken();
  const approveTaker = await h.handleAudit(admin, takerCert.data.applyId, AUDIT_STATUS_ENUM.PASS);
  check('管理员审核通过校园认证', approveTaker.code === 200, approveTaker.msg);
  const takerInfo = await api('GET', '/api/user/info', null, taker.token);
  check('认证后 isCampusAudit=2 且可接单',
    takerInfo.data && takerInfo.data.user.isCampusAudit === CAMPUS_AUDIT_ENUM.PASS && takerInfo.data.canTake === true,
    takerInfo.data && { isCampusAudit: takerInfo.data.user.isCampusAudit, canTake: takerInfo.data.canTake });

  // 学号唯一性：另一个账号用「已经被认证通过」的学号提交，必须当场驳回
  const dupStudentUser = await h.createUser({ phone: h.testPhone(1005), nickname: '同学号测试' });
  createdAccountNos.push(dupStudentUser.accountNo);
  const dupCert = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '同学号', certStudentId: '20259901', certPhone: h.testPhone(1006), applyContent: '/uploads/test/cert2.jpg'
  }, dupStudentUser.token);
  check('已被认证过的学号直接驳回', dupCert.code === 409 && /已被其他账号/.test(dupCert.msg || ''), dupCert.msg);

  const employerCert = await h.submitCampusCert(employer.token, { name: '回归雇主', studentId: '20259902', phone: h.testPhone(1007) });
  check('雇主提交校园认证成功', employerCert.code === 200, employerCert.msg);
  await h.handleAudit(admin, employerCert.data.applyId, AUDIT_STATUS_ENUM.PASS);
  const employerInfo = await api('GET', '/api/user/info', null, employer.token);
  check('雇主认证通过后可发布', employerInfo.data && employerInfo.data.canPublish === true, employerInfo.data && employerInfo.data.canPublish);

  const messages = await api('GET', '/api/message/list?page=1&pageSize=20', null, employer.token);
  check('认证通过推送站内消息',
    messages.code === 200 && messages.data.list.some((m) => m.title === '校园认证通过'),
    messages.data && messages.data.list.map((m) => m.title));

  // ---------------------------------------------------------------- 发布与支付
  title('3. 发布任务（模拟支付）与表单强校验');
  const lowReward = await api('POST', '/api/task/createOrder', taskForm({ reward: 0.3 }), employer.token);
  check('酬金低于0.5元被拒绝', lowReward.code === 400, lowReward.msg);
  const noImg = await api('POST', '/api/task/createOrder', taskForm({ img1: '', reward: 1.2 }), employer.token);
  check('未上传任务图片被拒绝', noImg.code === 400, noImg.msg);

  const created = await api('POST', '/api/task/createOrder', taskForm({ reward: 2, remark: '主流程任务' }), employer.token);
  check('创建任务订单并模拟支付成功', created.code === 200 && created.data.paid === true, created.msg);
  const taskId = created.data && created.data.taskId;
  check('信息服务费固定 0.1 元', created.data && Number(created.data.serviceFee) === 0.1, created.data && created.data.serviceFee);
  const rowCreated = await taskRow(taskId);
  check('任务上架为待接单(status=0)', Number(rowCreated.status) === TASK_STATUS_ENUM.WAIT_TAKE, rowCreated && rowCreated.status);
  check('任务生成订单号 GCPT+数字', /^GCPT\d+$/.test(String(rowCreated.order_no)), rowCreated.order_no);
  const feeBills = await billRows(taskId, employer.userId, BILL_TYPE_ENUM.SERVICE_FEE);
  check('为发布者生成 0.1 元服务费支出账单', feeBills.length === 1 && Number(feeBills[0].amount) === 0.1, feeBills);

  // 任务大厅需要登录才能浏览（未认证用户同样可以看，只是不能发布 / 接单）
  const hall = await api('GET', '/api/task/list?page=1&pageSize=50&sort=time_desc', null, employer.token);
  const hallList = (hall.data && hall.data.list) || [];
  check('任务大厅能看到新发布的任务', hall.code === 200 && hallList.some((t) => t.id === taskId),
    hall.code + ' total=' + (hall.data && hall.data.total));
  check('任务卡片带发布者学号与认证标记',
    hallList.some((t) => t.id === taskId && t.ownerStudentId === '20259902' && t.ownerIsCertified === true),
    hallList.filter((t) => t.id === taskId).map((t) => ({ s: t.ownerStudentId, c: t.ownerIsCertified })));

  // ---------------------------------------------------------------- 接单并发
  title('4. 接单（并发乐观锁 / 限时倒计时）');
  const ownTake = await api('POST', '/api/task/take', { taskId }, employer.token);
  check('不能接自己发布的任务', ownTake.code === 403, ownTake.code + ' ' + ownTake.msg);

  const racerA = await h.createCertifiedUser({ adminToken: admin, name: '并发跑腿A', studentId: '20259903', phone: h.testPhone(1008) });
  const racerB = await h.createCertifiedUser({ adminToken: admin, name: '并发跑腿B', studentId: '20259904', phone: h.testPhone(1009) });
  createdAccountNos.push(racerA.accountNo, racerB.accountNo);

  const takeResults = await Promise.all([
    api('POST', '/api/task/take', { taskId }, racerA.token),
    api('POST', '/api/task/take', { taskId }, racerB.token)
  ]);
  const takeOk = takeResults.filter((r) => r.code === 200);
  const takeConflict = takeResults.filter((r) => r.code !== 200);
  check('并发接单只有一个成功（乐观锁）', takeOk.length === 1 && takeConflict.length === 1,
    takeResults.map((r) => r.code + ':' + r.msg));
  const takerWinner = takeResults[0].code === 200 ? racerA : racerB;
  const takerLoser = takeResults[0].code === 200 ? racerB : racerA;
  check('接单失败方提示任务已被他人接单', /已被/.test(takeConflict[0].msg || ''), takeConflict[0].msg);

  const rowTaken = await taskRow(taskId);
  check('接单后 status=1 且写入接单人', Number(rowTaken.status) === TASK_STATUS_ENUM.TAKING && Number(rowTaken.taker_user_id) === takerWinner.userId,
    { status: rowTaken.status, taker: rowTaken.taker_user_id });
  check('接单后 once_taken 永久置 1', Number(rowTaken.once_taken) === 1, rowTaken.once_taken);

  const detailTaken = await api('GET', `/api/task/${taskId}`, null, employer.token);
  check('限时任务详情返回倒计时秒数', detailTaken.code === 200 && Number(detailTaken.data.remainSeconds) > 0,
    detailTaken.data && detailTaken.data.remainSeconds);
  check('详情页雇主可见接单人学号',
    detailTaken.data.task.takerStudentId === '20259904' || detailTaken.data.task.takerStudentId === '20259903',
    detailTaken.data.task.takerStudentId);

  // ---------------------------------------------------------------- 取消接单 / 编辑
  title('5. 取消接单与编辑规则');
  const cancelTake = await api('POST', '/api/task/cancelTake', { taskId }, takerWinner.token);
  check('接单10分钟内可取消接单', cancelTake.code === 200, cancelTake.msg);
  const rowCanceled = await taskRow(taskId);
  check('取消接单后回到待接单且清空接单人',
    Number(rowCanceled.status) === TASK_STATUS_ENUM.WAIT_TAKE && !rowCanceled.taker_user_id,
    { status: rowCanceled.status, taker: rowCanceled.taker_user_id });

  const editDown = await api('POST', '/api/task/edit', { taskId, reward: 1 }, employer.token);
  check('待接单任务酬金不可下调', editDown.code === 400, editDown.msg);
  check('酬金下调提示取自字典文案', /不可降低/.test(editDown.msg || ''), editDown.msg);

  // 取消接单后立刻又被同一个人接单会命中「3 秒防连点幂等窗口」，这里等一下再重试
  await h.sleep(3200);
  const retake = await api('POST', '/api/task/take', { taskId }, takerLoser.token);
  check('取消后可被其他人再次接单', retake.code === 200, retake.msg);

  const editTaked = await api('POST', '/api/task/edit', { taskId, deliverAddress: '改地址' }, employer.token);
  check('进行中任务不可编辑普通字段', editTaked.code === 409, editTaked.code + ' ' + editTaked.msg);

  const adjustDown = await api('POST', '/api/task/adjustReward', { taskId, reward: 1.5 }, employer.token);
  check('进行中任务酬金只能上调', adjustDown.code === 400, adjustDown.msg);
  const adjustUp = await api('POST', '/api/task/adjustReward', { taskId, reward: 3.5 }, employer.token);
  check('进行中任务提高酬金成功', adjustUp.code === 200, adjustUp.msg);
  const takerMsg = await api('GET', '/api/message/list?page=1&pageSize=20', null, takerLoser.token);
  check('加酬金后接单者收到站内消息',
    takerMsg.code === 200 && takerMsg.data.list.some((m) => m.title === '雇主提高了酬金'), takerMsg.data && takerMsg.data.list.map((m) => m.title));
  const adjustFreq = await api('POST', '/api/task/adjustReward', { taskId, reward: 4 }, employer.token);
  check('两次酬金调整间隔不足3分钟被拒绝', adjustFreq.code === 409, adjustFreq.msg);

  // ---------------------------------------------------------------- 送达与确认
  title('6. 确认取货 → 送达 → 确认收货 → 完成任务（两步确认 / 自动记账）');
  // 1) 未确认取货前直接提交送达：必须被拦（否则等于跳过取货环节）
  const beforePickup = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/uploads/test/d1.jpg']
  }, takerLoser.token);
  check('未确认取货时提交送达被拒 409', beforePickup.code === 409 && /确认取货/.test(beforePickup.msg || ''), beforePickup.msg);

  // 2) 确认取货必须带物品照片
  const pickupNoPhoto = await api('POST', '/api/task/confirmPickup', { taskId }, takerLoser.token);
  check('确认取货必须上传物品照片', pickupNoPhoto.code === 400 && /物品照片/.test(pickupNoPhoto.msg || ''), pickupNoPhoto.msg);

  // 3) 非接单人不能替别人确认取货
  const pickupWrongUser = await api('POST', '/api/task/confirmPickup', {
    taskId, pickupImages: ['/uploads/test/p1.jpg']
  }, employer.token);
  check('非接单人不能确认取货', pickupWrongUser.code === 403, pickupWrongUser.code + ' ' + pickupWrongUser.msg);

  // 4) 接单人确认取货：物品照片落库并锁定（接口有 3 秒防连点幂等窗口，这里等一下）
  await h.sleep(3200);
  const pickup = await api('POST', '/api/task/confirmPickup', {
    taskId, pickupImages: ['/uploads/test/p1.jpg', '/uploads/test/p2.jpg']
  }, takerLoser.token);
  check('接单人确认取货成功（物品照片锁定）', pickup.code === 200, pickup.msg);
  const rowPickup = await taskRow(taskId);
  check('确认取货时间已落库', !!rowPickup.pickup_confirm_time, rowPickup.pickup_confirm_time);
  check('物品照片最多3张且已落库', [rowPickup.pickup_img1, rowPickup.pickup_img2, rowPickup.pickup_img3].filter(Boolean).length === 2,
    [rowPickup.pickup_img1, rowPickup.pickup_img2, rowPickup.pickup_img3]);
  const detailAfterPickup = await api('GET', '/api/task/' + taskId, null, takerLoser.token);
  check('进度推进到第 2 段（已取货）', detailAfterPickup.data.task.progressStep === 2, detailAfterPickup.data.task.progressStep);


  // 6) 重复确认取货：照片已锁定，不允许掉包
  await h.sleep(3200);
  const pickupAgain = await api('POST', '/api/task/confirmPickup', {
    taskId, pickupImages: ['/uploads/test/p9.jpg']
  }, takerLoser.token);
  check('重复确认取货被拒绝（物品照片不可掉包）', pickupAgain.code === 409 && /锁定/.test(pickupAgain.msg || ''), pickupAgain.msg);

  // 7) 送达：只认送达照片，且必须至少 1 张
  const noPhoto = await api('POST', '/api/task/submitFinish', { taskId }, takerLoser.token);
  check('没传送达照片时提交失败', noPhoto.code === 400 && /送达照片/.test(noPhoto.msg || ''), noPhoto.msg);
  await h.sleep(3200);
  const submit = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/uploads/test/d1.jpg', '/uploads/test/d2.jpg']
  }, takerLoser.token);
  check('送达照片齐全后提交进入待确认(status=2)', submit.code === 200, submit.msg);
  const rowSubmit = await taskRow(taskId);
  check('任务状态变为待雇主确认', Number(rowSubmit.status) === TASK_STATUS_ENUM.WAIT_CONFIRM, rowSubmit.status);
  check('提交完成时间已落库', !!rowSubmit.submit_finish_time, rowSubmit.submit_finish_time);
  check('送达照片最多3张且已落库', [rowSubmit.delivery_img1, rowSubmit.delivery_img2, rowSubmit.delivery_img3].filter(Boolean).length === 2,
    [rowSubmit.delivery_img1, rowSubmit.delivery_img2, rowSubmit.delivery_img3]);
  check('物品照片快照未被送达环节改写（仍是最初那两张）',
    String(rowSubmit.pickup_img1) === '/uploads/test/p1.jpg' && String(rowSubmit.pickup_img2) === '/uploads/test/p2.jpg',
    [rowSubmit.pickup_img1, rowSubmit.pickup_img2]);
  const detailAfterSubmit = await api('GET', '/api/task/' + taskId, null, employer.token);
  check('进度推进到第 3 段（已送达·待雇主确认）', detailAfterSubmit.data.task.progressStep === 3, detailAfterSubmit.data.task.progressStep);

  // 8) 两步确认：先确认收货，再完成任务
  const wrongReceipt = await api('POST', '/api/task/receiptFinish', { taskId }, takerLoser.token);
  check('接单者不能替雇主确认收货', wrongReceipt.code === 403, wrongReceipt.code + ' ' + wrongReceipt.msg);
  const finishBeforeReceipt = await api('POST', '/api/task/confirmFinish', { taskId }, employer.token);
  check('未确认收货不能直接完成任务 409', finishBeforeReceipt.code === 409 && /确认收货/.test(finishBeforeReceipt.msg || ''), finishBeforeReceipt.msg);
  const receipt = await api('POST', '/api/task/receiptFinish', { taskId }, employer.token);
  check('雇主确认收货成功（进入待支付）', receipt.code === 200, receipt.msg);
  const rowReceipt = await taskRow(taskId);
  check('确认收货时间已落库', !!rowReceipt.owner_receipt_time, rowReceipt.owner_receipt_time);
  const detailAfterReceipt = await api('GET', '/api/task/' + taskId, null, employer.token);
  check('进度推进到第 4 段（待支付）', detailAfterReceipt.data.task.progressStep === 4, detailAfterReceipt.data.task.progressStep);

  const wrongConfirm = await api('POST', '/api/task/confirmFinish', { taskId }, takerLoser.token);
  check('接单者不能替雇主完成任务', wrongConfirm.code === 403, wrongConfirm.code + ' ' + wrongConfirm.msg);
  const confirm = await api('POST', '/api/task/confirmFinish', { taskId }, employer.token);
  check('雇主完成任务成功', confirm.code === 200, confirm.msg);
  const rowConfirmed = await taskRow(taskId);
  check('任务状态变为已完成(status=3)', Number(rowConfirmed.status) === TASK_STATUS_ENUM.FINISHED, rowConfirmed.status);
  const detailFinished = await api('GET', '/api/task/' + taskId, null, employer.token);
  check('进度推进到第 5 段（完成）', detailFinished.data.task.progressStep === 5, detailFinished.data.task.progressStep);

  const incomeBills = await billRows(taskId, takerLoser.userId, BILL_TYPE_ENUM.TASK_INCOME);
  check('为接单者生成任务收入账单（按调整后酬金 3.5 元）',
    incomeBills.length === 1 && Number(incomeBills[0].amount) === 3.5, incomeBills);
  const confirmAgain = await api('POST', '/api/task/confirmFinish', { taskId }, employer.token);
  const incomeAfter = await billRows(taskId, takerLoser.userId, BILL_TYPE_ENUM.TASK_INCOME);
  check('重复完成任务幂等（不重复记账）', confirmAgain.code === 200 && incomeAfter.length === 1, incomeAfter.length);

  const takerBill = await api('GET', '/api/bill/list?page=1&pageSize=20', null, takerLoser.token);
  check('接单者账单可查看且含该任务收入',
    takerBill.code === 200 && takerBill.data.list.some((b) => Number(b.taskId || b.task_id) === taskId && Number(b.amount) === 3.5),
    takerBill.data && { summary: takerBill.data.summary, list: takerBill.data.list.length });

  // ------------------------------------------- 确认取货后的锁定连锁效果（独立任务）
  // 单独开一张任务来验证：确认取货 = 物品照片锁定为凭证，撤单入口必须被后端硬拦截
  title('6B. 确认取货后：接单人不可撤单 / 雇主不可撤销');
  // 这张任务由 takerWinner 发布、employer 接单：避免主流程账号撞上「5 次/分钟」发布限流
  const lockTask = await publishTask(takerWinner.token, { reward: 2, remark: '取货锁定回归任务' }, '锁定校验任务发布');
  const lockTaskId = lockTask.taskId;
  await h.sleep(3200);
  const lockTake = await api('POST', '/api/task/take', { taskId: lockTaskId }, employer.token);
  check('锁定校验任务接单成功', lockTake.code === 200, lockTake.msg);
  await h.sleep(3200);
  const lockPickup = await api('POST', '/api/task/confirmPickup',
    { taskId: lockTaskId, pickupImages: ['/uploads/test/p1.jpg'] }, employer.token);
  check('锁定校验任务确认取货成功', lockPickup.code === 200, lockPickup.msg);
  const lockCancelTake = await api('POST', '/api/task/cancelTake', { taskId: lockTaskId }, employer.token);
  check('确认取货后接单人不可再取消接单（应 409）', lockCancelTake.code === 409, lockCancelTake.code + ' ' + lockCancelTake.msg);
  const lockCancelOwner = await api('POST', '/api/task/cancel', { taskId: lockTaskId }, takerWinner.token);
  check('确认取货后雇主不可再撤销任务（应 409）', lockCancelOwner.code === 409, lockCancelOwner.code + ' ' + lockCancelOwner.msg);
  const lockRow = await taskRow(lockTaskId);
  check('锁定校验任务物品照片与确认时间已落库', !!lockRow.pickup_confirm_time, [lockRow.pickup_confirm_time, lockRow.taker_user_id]);

  // ---------------------------------------------------------------- 撤销与退费
  title('7. 撤销任务与退费');
  const refundTask = await publishTask(employer.token, { reward: 2.5, remark: '退费流程任务' }, '退费流程任务发布');
  const refundTaskId = refundTask.taskId;
  const wrongRefund = await api('POST', '/api/task/applyRefund', { taskId: refundTaskId }, employer.token);
  check('未撤销的任务不能直接申请退费', wrongRefund.code === 409 && /请先撤销/.test(wrongRefund.msg || ''), wrongRefund.msg);

  const cancelTask = await api('POST', '/api/task/cancel', { taskId: refundTaskId }, employer.token);
  check('雇主可撤销待接单任务并提示可退费', cancelTask.code === 200 && cancelTask.data.canApplyRefund === true, cancelTask.data);
  const rowCancel = await taskRow(refundTaskId);
  check('撤销后状态标记为 5（雇主主动撤销）', Number(rowCancel.status) === TASK_STATUS_ENUM.OWNER_CANCEL, rowCancel.status);
  const hallAfter = await api('GET', '/api/task/list?page=1&pageSize=50&sort=time_desc', null, employer.token);
  const hallAfterList = (hallAfter.data && hallAfter.data.list) || [];
  check('撤销任务从任务大厅下架', hallAfter.code === 200 && !hallAfterList.some((t) => t.id === refundTaskId),
    hallAfter.code + ' total=' + (hallAfter.data && hallAfter.data.total));

  const refund = await api('POST', '/api/task/applyRefund', { taskId: refundTaskId }, employer.token);
  check('已撤销任务可申请退费成功', refund.code === 200, refund.msg);
  const payRow = await paymentRow(refundTaskId);
  check('支付流水更新为已退款(status=3)', Number(payRow.status) === PAY_STATUS_ENUM.REFUNDED, payRow.status);
  check('退款金额 0.1 元并记录退款时间', Number(payRow.refund_fee) === 0.1 && !!payRow.refund_time, payRow);
  const rowRefunded = await taskRow(refundTaskId);
  check('任务标记 is_refunded=1', Number(rowRefunded.is_refunded) === 1, rowRefunded.is_refunded);
  const refundAgain = await api('POST', '/api/task/applyRefund', { taskId: refundTaskId }, employer.token);
  check('重复申请退费被拒绝（幂等）', refundAgain.code === 409, refundAgain.msg);

  // 换一个雇主账号发布：发布限流按「账号 + 1 分钟 5 次」统计，
  // 上面这些失败重试已经把这个账号的配额用掉了，继续发布会被限流拦住
  const cancelOwner = await h.createCertifiedUser({
    adminToken: admin, name: '退费限制雇主', studentId: '20259906', phone: h.testPhone(1011)
  });
  createdAccountNos.push(cancelOwner.accountNo);
  const takenCancelTask = await api('POST', '/api/task/createOrder', taskForm({ reward: 1.6, remark: '被人接过的任务' }), cancelOwner.token);
  const takenTaskId = takenCancelTask.data.taskId;
  const takeThenCancel = await api('POST', '/api/task/take', { taskId: takenTaskId }, racerA.token);
  check('跑腿员接单用于验证退费限制', takeThenCancel.code === 200, takeThenCancel.msg);
  await api('POST', '/api/task/cancelTake', { taskId: takenTaskId }, racerA.token);
  const cancelTaken = await api('POST', '/api/task/cancel', { taskId: takenTaskId }, cancelOwner.token);
  check('曾被接单的任务撤销后不提示可退费', cancelTaken.code === 200 && cancelTaken.data.canApplyRefund === false, cancelTaken.data);
  const refundTaken = await api('POST', '/api/task/applyRefund', { taskId: takenTaskId }, cancelOwner.token);
  check('once_taken=1 的任务永久不可退费', refundTaken.code === 403, refundTaken.code + ' ' + refundTaken.msg);

  // ---------------------------------------------------------------- 举报
  title('8. 举报规则');
  // 换一个账号发布被举报的任务：发布限流是「同一账号 1 分钟最多 5 次」，
  // 上面雇主账号已经用掉了配额（限流本身也是被测行为，不能为了测试把它关掉）
  const reportOwner = await h.createCertifiedUser({
    adminToken: admin, name: '举报测试雇主', studentId: '20259905', phone: h.testPhone(1010)
  });
  createdAccountNos.push(reportOwner.accountNo);
  const reportTask = await api('POST', '/api/task/createOrder', taskForm({ reward: 1.8, remark: '举报测试任务' }), reportOwner.token);
  const reportTaskId = reportTask.data.taskId;
  const reportDetail = await api('GET', `/api/task/${reportTaskId}`, null, reportOwner.token);
  const orderNo = reportDetail.data.task.orderNo;
  const selfReport = await api('POST', '/api/report/submit', { taskId: reportTaskId, reportReason: '自己举报自己测试', orderNo }, reportOwner.token);
  check('雇主不能举报自己的任务', selfReport.code === 403 && /自己发布/.test(selfReport.msg || ''), selfReport.msg);
  const report1 = await api('POST', '/api/report/submit', { taskId: reportTaskId, reportReason: '任务信息不真实', orderNo }, racerA.token);
  check('其他用户可举报任务', report1.code === 200, report1.msg);
  const reportDup = await api('POST', '/api/report/submit', { taskId: reportTaskId, reportReason: '重复举报同一条任务', orderNo }, racerA.token);
  check('同一任务已有待处理举报时被拦截', reportDup.code === 409, reportDup.msg);
  await h.sleep(3100);
  const reportAdminList = await api('GET', '/api/report/adminList?page=1&pageSize=20', null, admin);
  check('管理员举报列表能看到该举报并带订单号与双方信息',
    reportAdminList.code === 200
      && reportAdminList.data.list.some((r) => r.taskId === reportTaskId && r.orderNo === orderNo && r.reporterStudentId === '20259903'),
    reportAdminList.data && reportAdminList.data.list.filter((r) => r.taskId === reportTaskId));
  const reportRows = await db.query(
    'SELECT status FROM report WHERE task_id = ? AND user_id = ? ORDER BY id ASC', [reportTaskId, racerA.userId]
  );
  check('举报记录落库且带订单号快照', reportRows.length >= 1, reportRows.length);
  const snapshot = await db.query('SELECT order_no FROM report WHERE task_id = ? LIMIT 1', [reportTaskId]);
  check('举报快照记录订单号', snapshot.length > 0, snapshot);

  // ---------------------------------------------------------------- 权限
  title('9. 越权校验');
  const adminListDenied = await api('GET', '/api/admin/userList?page=1&pageSize=5', null, racerA.token);
  check('普通用户访问管理员接口被拒绝', adminListDenied.code === 403, adminListDenied.code + ' ' + adminListDenied.msg);
  const adminListOk = await api('GET', '/api/admin/userList?page=1&pageSize=5', null, admin);
  check('管理员可访问用户列表', adminListOk.code === 200, adminListOk.msg);
  const editOthers = await api('POST', '/api/task/edit', { taskId: reportTaskId, reward: 9 }, racerA.token);
  check('不能编辑他人发布的任务', editOthers.code === 403, editOthers.code + ' ' + editOthers.msg);
  const othersBill = await api('GET', '/api/bill/list?page=1&pageSize=20', null, racerA.token);
  check('账单接口只返回本人数据',
    othersBill.code === 200 && othersBill.data.list.every((b) => b.userId === undefined || b.userId === racerA.userId),
    othersBill.data && othersBill.data.list.length);

  // ---------------------------------------------------------------- 消息
  title('10. 消息中心与一键已读');
  const unreadBefore = await api('GET', '/api/message/list?page=1&pageSize=20', null, takerLoser.token);
  check('消息列表接口可用并返回未读数', unreadBefore.code === 200 && typeof unreadBefore.data.unread === 'number', unreadBefore.data && unreadBefore.data.unread);
  const readAll = await api('POST', '/api/message/readAll', null, takerLoser.token);
  check('一键已读成功', readAll.code === 200, readAll.msg);
  const unreadAfter = await api('GET', '/api/message/list?page=1&pageSize=20', null, takerLoser.token);
  check('已读后未读数归零', unreadAfter.data.unread === 0, unreadAfter.data.unread);

  // ---------------------------------------------------------------- 邀请码免费代拿
  title('11. 邀请码免费代拿权益（7 天内 1 次，免服务费不免酬金）');
  const inviterInfo = await api('GET', '/api/user/info', null, employer.token);
  const inviterCode = inviterInfo.data.user.inviteCode;
  check('账号带专属邀请码', !!inviterCode, inviterCode);

  const badInvite = await h.register({ phone: h.testPhone(1012), inviteCode: 'NO-SUCH-CODE' });
  check('邀请码不存在时注册被拦截', badInvite.res.code === 400 && /邀请码/.test(badInvite.res.msg || ''), badInvite.res.msg);

  const invited = await h.createCertifiedUser({
    adminToken: admin, name: '被邀请用户', studentId: '20259907', phone: h.testPhone(1013), inviteCode: inviterCode
  });
  createdAccountNos.push(invited.accountNo);
  check('填写有效邀请码注册即获得 1 次免费代拿',
    invited.user.freeDeliveryCount === 1 && invited.user.freeDeliveryAvailable === true,
    { count: invited.user.freeDeliveryCount, available: invited.user.freeDeliveryAvailable });
  const inviteMsg = await api('GET', '/api/message/list?page=1&pageSize=20', null, invited.token);
  check('被邀请人收到「邀请码奖励到账」站内消息',
    inviteMsg.data.list.some((m) => /邀请码奖励/.test(m.title || '')), inviteMsg.data.list.map((m) => m.title));

  const freePublish = await api('POST', '/api/task/createOrder',
    Object.assign(taskForm({ reward: 1.2, remark: '免费代拿任务' }), { useFreeDelivery: true }), invited.token);
  check('使用免费代拿权益发布任务（服务费 0 元）',
    freePublish.code === 200 && Number(freePublish.data.serviceFee) === 0 && freePublish.data.freeDelivery === true,
    freePublish.data);
  const freeTaskId = freePublish.data.taskId;
  check('免费单不生成服务费支出账单',
    (await billRows(freeTaskId, invited.user.userId, BILL_TYPE_ENUM.SERVICE_FEE)).length === 0, '账单条数为 0');
  const usedInfo = await api('GET', '/api/user/info', null, invited.token);
  check('免费次数已核销（不再可用）', usedInfo.data.user.freeDeliveryAvailable === false,
    usedInfo.data.user.freeDeliveryCount);
  const freeCancel = await api('POST', '/api/task/cancel', { taskId: freeTaskId }, invited.token);
  const returnedInfo = await api('GET', '/api/user/info', null, invited.token);
  check('无人接单撤销后免费次数自动返还',
    freeCancel.code === 200 && freeCancel.data.freeDeliveryReturned === true && returnedInfo.data.user.freeDeliveryAvailable === true,
    returnedInfo.data.user.freeDeliveryCount);

  // ---------------------------------------------------------------- 管理员封禁
  title('12. 管理员封禁 / 解封接单权限');
  const banTarget = await h.createCertifiedUser({
    adminToken: admin, name: '封禁测试用户', studentId: '20259908', phone: h.testPhone(1014)
  });
  createdAccountNos.push(banTarget.accountNo);
  const banSelfTry = await api('POST', '/api/admin/banUser', { keyword: h.ADMIN_ACCOUNT, durationType: '30m', reason: '越权尝试' }, admin);
  check('管理员账号不可被封禁', banSelfTry.code === 403, banSelfTry.code + ' ' + banSelfTry.msg);
  const ban = await api('POST', '/api/admin/banUser',
    { userId: banTarget.user.userId, durationType: '30m', reason: '回归测试封禁' }, admin);
  check('管理员可封禁用户接单权限', ban.code === 200, ban.msg);
  const banList = await api('GET', `/api/admin/banList?keyword=${banTarget.user.studentId}`, null, admin);
  check('封禁列表可按学号搜索到该用户',
    banList.code === 200 && banList.data.list.some((r) => r.userId === banTarget.user.userId && r.isBanned === true),
    banList.data && banList.data.total);
  const bannedTake = await api('POST', '/api/task/take', { taskId: reportTaskId }, banTarget.token);
  check('封禁期内无法接单', bannedTake.code === 403 && /禁止接单/.test(bannedTake.msg || ''), bannedTake.msg);
  const unban = await api('POST', '/api/admin/unbanUser', { userId: banTarget.user.userId }, admin);
  check('管理员可解封', unban.code === 200, unban.msg);
  const banMsg = await api('GET', '/api/message/list?page=1&pageSize=20', null, banTarget.token);
  check('封禁与解封都会推送站内消息给本人',
    banMsg.data.list.filter((m) => /封禁|解禁/.test(m.title || '')).length >= 2, banMsg.data.list.map((m) => m.title));

  // ---------------------------------------------------------------- 收尾
  title('13. 清理测试数据');
  const purged = await h.purgeAccounts(createdAccountNos);
  check('测试账号与关联数据已清理', purged === createdAccountNos.length, { purged, expect: createdAccountNos.length });

  console.log(`\n===== 结果：${passCount} 项通过 / ${failCount} 项失败（共 ${passCount + failCount} 项）=====`);
  if (failCount) console.log('失败项：\n  - ' + failedNames.join('\n  - '));
}

main()
  .catch((err) => {
    failCount += 1;
    console.error('\n脚本异常：', err && err.message ? err.message : err);
  })
  .then(async () => {
    try {
      if (db.closePool) await db.closePool();
      else if (db.pool && db.pool.end) await db.pool.end();
    } catch (err) {
      /* 忽略关闭连接池异常 */
    }
    process.exit(failCount ? 1 : 0);
  });
