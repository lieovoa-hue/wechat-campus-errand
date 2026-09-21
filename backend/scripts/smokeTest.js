/**
 * =====================================================================
 * 【已停用】本脚本基于旧账号体系（手机号 + 短信验证码）编写。
 *   短信验证码已整体下线，注册改为「图形验证码 + 自选账号ID」，
 *   姓名 / 学号改到校园认证阶段采集，注册后还必须先设置密保问题，
 *   因此本脚本直接运行会在第一步「发送验证码」处失败，请改用：
 *     node scripts/regression-business-flow.js   # 业务全流程回归（注册/认证/发布/接单/送达/退费/举报/封禁，102 项）
 *     node scripts/scheduleTest.js               # 6 个定时任务行为验证（44 项）
 *   如确需运行旧脚本，请设置环境变量 FORCE_LEGACY_SMS_TEST=1（预期大量失败）。
 *
 * 端到端业务流程测试脚本（需先启动后端服务）
 * 覆盖：注册 -> 双方式登录 -> 校园认证 -> 发布支付 -> 并发接单 -> 加酬金
 *       -> 送达照片强制校验 -> 确认送达自动记账 -> 退费 -> 申诉/举报 -> 管理员
 *       -> 限时倒计时 -> 超时送达扣酬金（5%，不足 0.5 元按 0.5 元）
 *   node scripts/smokeTest.js
 * =====================================================================
 */

// 部分场景（超时送达）需要把接单时间往前拨，直接用数据层改时间戳
const db = require('../src/db/db');

// 旧脚本保护：默认直接提示并退出，避免跑出一堆与「短信接口已下线」相关的误导性失败
if (process.env.FORCE_LEGACY_SMS_TEST !== '1') {
  console.error('[已停用] smokeTest.js 基于旧「手机号 + 短信验证码」账号体系，接口已下线。');
  console.error('请改用：node scripts/regression-business-flow.js（业务全流程回归）');
  console.error('        node scripts/scheduleTest.js（定时任务回归）');
  console.error('如确需运行旧脚本，请设置环境变量 FORCE_LEGACY_SMS_TEST=1。');
  process.exit(1);
}

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

let passCount = 0;
let failCount = 0;

function title(text) {
  console.log(`\n===== ${text} =====`);
}

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failCount += 1;
    console.log(`  [FAIL] ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`);
  }
}

/**
 * 统一请求方法
 */
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': 'smoke-device' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body)
  });
  let data = {};
  try {
    data = await resp.json();
  } catch (err) {
    data = { code: -1, msg: 'JSON解析失败' };
  }
  return { status: resp.status, ...data };
}

/**
 * 休眠指定毫秒
 * 用途：后端对「同一用户 + 同一任务」的举报设有 3 秒防连点幂等窗口，
 *      测试「半小时最多 3 次」频率限制前必须先跨过该窗口，
 *      否则命中的是「请勿重复提交」而不是频率限制提示。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 注册并返回登录信息 */
async function registerUser(phone, studentId, name) {
  const sms = await api('POST', '/api/user/sendSmsCode', { phone });
  const code = sms.data && sms.data.code;
  const res = await api('POST', '/api/user/register', {
    phone, password: 'abc123456', smsCode: code, name, studentId, nickname: name
  });
  return res;
}

async function main() {
  title('0. 健康检查');
  const health = await api('GET', '/api/health');
  check('服务可用', health.code === 200, health);

  title('1. 注册（短信模拟模式）');
  const regA = await registerUser('13800138001', '20240001', '张雇主');
  check('雇主注册成功', regA.code === 200, regA);
  const tokenA = regA.data.accessToken;
  check('普通用户账号编号 X0001', regA.data.user.userIdText === 'X0001' && regA.data.user.accountNo === 'X0001', regA.data.user.userIdText);
  check('白名单学号识别为管理员', regA.data.user.isAdmin === true);

  const regB = await registerUser('13800138002', '20239001', '李跑腿');
  check('跑腿员注册成功', regB.code === 200, regB);
  const tokenB = regB.data.accessToken;
  check('跑腿员非管理员', regB.data.user.isAdmin === false);

  const regC = await registerUser('13800138003', '20239002', '王同学');
  check('第三位用户注册成功', regC.code === 200, regC);
  const tokenC = regC.data.accessToken;

  title('2. 登录方式与防暴力破解');
  const loginByPhone = await api('POST', '/api/user/login', { account: '13800138001', password: 'abc123456' });
  check('手机号登录成功', loginByPhone.code === 200, loginByPhone);
  const loginByAccountNo = await api('POST', '/api/user/login', { account: 'X0001', password: 'abc123456' });
  check('账号编号(X0001)登录成功', loginByAccountNo.code === 200, loginByAccountNo);
  const loginByAccountNoLower = await api('POST', '/api/user/login', { account: 'x0001', password: 'abc123456' });
  check('账号编号小写(x0001)登录成功', loginByAccountNoLower.code === 200, loginByAccountNoLower);
  const loginById = await api('POST', '/api/user/login', { account: '0001', password: 'abc123456' });
  check('主键ID(0001)登录成功', loginById.code === 200, loginById);
  const loginById2 = await api('POST', '/api/user/login', { account: '1', password: 'abc123456' });
  check('去前导零主键ID(1)登录成功', loginById2.code === 200, loginById2);

  const notExist = await api('POST', '/api/user/login', { account: '13800138999', password: 'abc123456' });
  const wrongPwd = await api('POST', '/api/user/login', { account: '13800138003', password: 'wrong-password' });
  check('账号不存在与密码错误提示一致（防枚举）',
    notExist.msg === '账号或密码错误' && wrongPwd.msg === '账号或密码错误',
    { notExist: notExist.msg, wrongPwd: wrongPwd.msg });

  const noToken = await api('GET', '/api/task/myPublish');
  check('未登录访问业务接口返回401', noToken.code === 401, noToken);

  title('3. 校园认证（管理员自动认证 + 未认证不能发布/接单）');
  // 管理员白名单账号注册即自动认证，无需提交任何校园认证申请
  check('管理员账号自动校园认证（isCampusAudit=2）', regA.data.user.isCampusAudit === 2, regA.data.user.isCampusAudit);
  check('管理员账号带管理员标识 roleTag', regA.data.user.roleTag === '管理员', regA.data.user.roleTag);
  const infoA = await api('GET', '/api/user/info', undefined, tokenA);
  check('管理员无需认证申请即可发布/接单',
    infoA.data.canPublish === true && infoA.data.canTake === true, infoA.data);

  // 管理员不允许重复提交校园认证申请（否则会把已通过的认证改写成「待审核」）
  const adminApply = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '张雇主', certStudentId: '20240001', certPhone: '13800138001',
    applyContent: '/uploads/202609/cert_admin.jpg'
  }, tokenA);
  check('管理员重复提交校园认证被拦截', adminApply.code === 409, adminApply);
  const infoA2 = await api('GET', '/api/user/info', undefined, tokenA);
  check('拦截后管理员认证状态保持通过', infoA2.data.user.isCampusAudit === 2, infoA2.data.user.isCampusAudit);

  // 普通用户未认证：发布任务必须被拦截
  const blockedPublish = await api('POST', '/api/task/createOrder', {
    receiverName: '张三', receiverPhone: '13900139000', deliverAddress: '1号楼', reward: 5
  }, tokenB);
  check('未认证发布任务被拦截', blockedPublish.code === 403 && blockedPublish.msg.indexOf('校园认证') >= 0, blockedPublish);

  const applyB = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '李跑腿', certStudentId: '20239001', certPhone: '13800138002',
    applyContent: '/uploads/202609/cert_b.jpg'
  }, tokenB);
  check('校园认证申请提交成功', applyB.code === 200, applyB);
  check('校园认证提交返回剩余次数（首次提交后剩余2次）',
    !!applyB.data.campusApply && applyB.data.campusApply.remainTimes === 2, applyB.data.campusApply);

  const approveB = await api('POST', '/api/audit/handle', { applyId: applyB.data.applyId, status: 2 }, tokenA);
  check('管理员（白名单）审核通过', approveB.code === 200, approveB);

  const campusMsg = await api('GET', '/api/message/list', undefined, tokenB);
  check('认证通过推送站内消息',
    campusMsg.data.list.some((m) => m.title === '校园认证通过'), campusMsg.data.list);

  const infoB = await api('GET', '/api/user/info', undefined, tokenB);
  check('跑腿员认证通过后可接单', infoB.data.canTake === true, infoB.data);

  const dupStudent = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '王同学', certStudentId: '20240001', certPhone: '13800138003',
    applyContent: '/uploads/202609/cert_c.jpg'
  }, tokenC);
  check('重复学号认证直接驳回', dupStudent.code === 409 && dupStudent.msg.indexOf('已被其他账号') >= 0, dupStudent);

  // 王同学改用本人真实学号重新提交（同一账号 7 天内共提交 2 次，未超过 3 次上限）
  const applyC = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '王同学', certStudentId: '20239002', certPhone: '13800138003',
    applyContent: '/uploads/202609/cert_c2.jpg'
  }, tokenC);
  check('被驳回后可重新提交校园认证', applyC.code === 200, applyC);
  check('再次提交后剩余次数递减（共提交2次，剩余1次）',
    !!applyC.data.campusApply && applyC.data.campusApply.remainTimes === 1, applyC.data.campusApply);
  await api('POST', '/api/audit/handle', { applyId: applyC.data.applyId, status: 2 }, tokenA);
  const infoC = await api('GET', '/api/user/info', undefined, tokenC);
  check('第三位用户认证通过后可接单', infoC.data && infoC.data.canTake === true, infoC.data);

  title('4. 发布任务（模拟支付）');
  const created = await api('POST', '/api/task/createOrder', {
    receiverName: '张三', receiverPhone: '13900139000', deliverAddress: '东区1号宿舍楼',
    // 选填项：取件码（跑腿员凭码取件）+ 详细地址
    pickupCode: '6-8-1234', detailAddress: '3号楼2单元501室 靠窗第二张桌',
    timeLimitMin: 60, remark: '取快递 <script>alert(1)</script>', reward: 5.5,
    img1: '/uploads/202609/goods.jpg'
  }, tokenA);
  check('发布任务并支付成功', created.code === 200 && created.data.paid === true, created);
  const taskId = created.data.taskId;

  const list = await api('GET', '/api/task/list?page=1&pageSize=10&sort=reward_desc', undefined, tokenB);
  check('任务大厅可见已支付任务', list.data.total >= 1, list.data.total);
  const hallTask = list.data.list.find((t) => t.id === taskId);
  check('XSS 输入已转义存储', hallTask && hallTask.remark.indexOf('&lt;script&gt;') >= 0, hallTask && hallTask.remark);
  // 管理员标识对其他人可见：普通用户浏览任务大厅即可看到发布者的管理员身份
  check('任务列表下发发布者管理员标识',
    hallTask && hallTask.ownerIsAdmin === true && hallTask.ownerRoleTag === '管理员',
    hallTask && hallTask.ownerRoleTag);
  check('管理员发布的账号标记为已认证', hallTask && hallTask.ownerIsCertified === true,
    hallTask && hallTask.ownerIsCertified);

  // 订单号：每个发布的任务都会生成唯一订单号 GCPT + 6 位补零的任务ID
  check('任务列表下发订单号（GCPT+6位数字）',
    hallTask && /^GCPT\d{6}$/.test(hallTask.orderNo), hallTask && hallTask.orderNo);
  check('订单号与任务ID一一对应',
    hallTask && hallTask.orderNo === `GCPT${String(taskId).padStart(6, '0')}`,
    hallTask && hallTask.orderNo);
  const detailForOrder = await api('GET', `/api/task/${taskId}`, undefined, tokenA);
  check('任务详情下发订单号',
    detailForOrder.data.task.orderNo === hallTask.orderNo, detailForOrder.data.task.orderNo);

  // ---------------- 选填项：取件码 / 详细地址 ----------------
  check('雇主可见自己填写的取件码与详细地址',
    detailForOrder.data.task.pickupCode === '6-8-1234'
    && detailForOrder.data.task.detailAddress === '3号楼2单元501室 靠窗第二张桌',
    detailForOrder.data.task);

  const detailForOther = await api('GET', `/api/task/${taskId}`, undefined, tokenB);
  check('非接单者看不到取件码（防止他人凭码冒领包裹）',
    detailForOther.data.task.pickupCode === '', detailForOther.data.task.pickupCode);
  check('详细地址对其他人可见（与送达地址同级）',
    detailForOther.data.task.detailAddress === '3号楼2单元501室 靠窗第二张桌',
    detailForOther.data.task.detailAddress);
  check('任务大厅列表不下发取件码',
    !!hallTask && hallTask.pickupCode === '', hallTask && hallTask.pickupCode);

  const billA = await api('GET', '/api/bill/list', undefined, tokenA);
  check('支付成功生成服务费支出账单',
    billA.data.list.some((b) => b.type === 2 && Number(b.amount) === 0.1), billA.data.list);

  title('5. 并发接单（乐观锁）');
  const [takeB, takeC] = await Promise.all([
    api('POST', '/api/task/take', { taskId }, tokenB),
    api('POST', '/api/task/take', { taskId }, tokenC)
  ]);
  const successCount = [takeB, takeC].filter((r) => r.code === 200).length;
  const conflict = [takeB, takeC].find((r) => r.code === 409);
  check('并发接单只有一人成功', successCount === 1, { takeB, takeC });
  check('失败方提示任务已被他人接单', !!conflict && conflict.msg === '任务已被他人接单', conflict);

  const takerToken = takeB.code === 200 ? tokenB : tokenC;
  const otherToken = takeB.code === 200 ? tokenC : tokenB;

  const detailForTaker = await api('GET', `/api/task/${taskId}`, undefined, takerToken);
  check('接单者可见取件码（跑腿员凭码取件）',
    detailForTaker.data.task.pickupCode === '6-8-1234', detailForTaker.data.task.pickupCode);

  const selfTake = await api('POST', '/api/task/take', { taskId }, tokenA);
  check('不能接自己发布的任务或已接单任务', selfTake.code === 403 || selfTake.code === 409, selfTake);

  title('6. 进行中任务调整酬金');
  const adjust = await api('POST', '/api/task/adjustReward', { taskId, reward: 8 }, tokenA);
  check('酬金调高成功', adjust.code === 200, adjust);
  const adjustDown = await api('POST', '/api/task/adjustReward', { taskId, reward: 6 }, tokenA);
  check('酬金不可低于当前值', adjustDown.code === 400, adjustDown);
  const adjustFreq = await api('POST', '/api/task/adjustReward', { taskId, reward: 9 }, tokenA);
  check('3分钟内重复调整被拦截', adjustFreq.code === 409, adjustFreq);

  const takerMsg = await api('GET', '/api/message/list', undefined, takerToken);
  check('加酬金通知接单者', takerMsg.data.list.some((m) => m.title === '雇主提高了酬金'), takerMsg.data.list.map((m) => m.title));

  title('7. 送达照片强制校验');
  const noImg = await api('POST', '/api/task/submitFinish', { taskId, deliveryImages: [] }, takerToken);
  check('未上传送达照片被拦截', noImg.code === 400 && noImg.msg === '请先上传送达照片', noImg);
  const tooMany = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg']
  }, takerToken);
  check('送达照片最多3张', tooMany.code === 400, tooMany);
  const submitted = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/uploads/202609/d1.jpg', '/uploads/202609/d2.jpg']
  }, takerToken);
  check('提交送达成功', submitted.code === 200, submitted);

  const onTimeDetail = await api('GET', `/api/task/${taskId}`, undefined, tokenA);
  check('限时60分钟的任务按时送达，不产生超时扣减入口',
    onTimeDetail.data.task.isLateDelivery === false
      && onTimeDetail.data.task.actions.canDeductLateReward === false,
    onTimeDetail.data.task.isLateDelivery);

  const wrongConfirm = await api('POST', '/api/task/confirmFinish', { taskId }, otherToken);
  check('非雇主不能确认送达', wrongConfirm.code === 403, wrongConfirm);

  title('8. 雇主确认送达与自动记账');
  const confirm = await api('POST', '/api/task/confirmFinish', { taskId }, tokenA);
  check('确认送达成功', confirm.code === 200, confirm);
  const confirmAgain = await api('POST', '/api/task/confirmFinish', { taskId }, tokenA);
  check('重复确认幂等', confirmAgain.code === 200 && confirmAgain.data.repeated === true, confirmAgain);

  const billTaker = await api('GET', '/api/bill/list', undefined, takerToken);
  check('接单者生成任务收入账单',
    billTaker.data.list.some((b) => b.type === 1 && b.task_id === taskId && Number(b.amount) === 8), billTaker.data.list);
  check('账单按时间倒序', billTaker.data.list.length < 2
    || new Date(billTaker.data.list[0].created_at) >= new Date(billTaker.data.list[1].created_at));

  const detail = await api('GET', `/api/task/${taskId}`, undefined, tokenA);
  check('任务状态为已完成', detail.data.task.status === 3, detail.data.task.status);
  check('详情返回送达照片', detail.data.task.deliveryImages.length === 2, detail.data.task.deliveryImages);

  title('8.5 未送达申诉（提交后停止倒计时自动收货）');
  const createdDispute = await api('POST', '/api/task/createOrder', {
    receiverName: '赵六', receiverPhone: '13900139009', deliverAddress: '北区9号楼',
    timeLimitMin: 60, reward: 7, img1: '/uploads/202609/dispute.jpg'
  }, tokenA);
  check('发布申诉用任务并支付成功', createdDispute.code === 200, createdDispute);
  const disputeTaskId = createdDispute.data.taskId;
  const takeDispute = await api('POST', '/api/task/take', { taskId: disputeTaskId }, takerToken);
  check('跑腿员接单成功', takeDispute.code === 200, takeDispute);
  const subDispute = await api('POST', '/api/task/submitFinish', {
    taskId: disputeTaskId, deliveryImages: ['/uploads/202609/dispute_d1.jpg']
  }, takerToken);
  check('提交送达成功（status=2）', subDispute.code === 200, subDispute);

  const noTag = await api('POST', '/api/task/rejectFinish', { taskId: disputeTaskId, tags: [] }, tokenA);
  check('未勾选任何标签被拦截', noTag.code === 400, noTag);
  const otherNoText = await api('POST', '/api/task/rejectFinish', { taskId: disputeTaskId, tags: [4] }, tokenA);
  check('选择「其他」未填写原因被拦截', otherNoText.code === 400, otherNoText);
  const wrongReject = await api('POST', '/api/task/rejectFinish', { taskId: disputeTaskId, tags: [1] }, takerToken);
  check('非雇主不能提交未送达申诉', wrongReject.code === 403, wrongReject);
  const rejectOk = await api('POST', '/api/task/rejectFinish', {
    taskId: disputeTaskId, tags: [1, 3], otherText: ''
  }, tokenA);
  check('勾选标签直接发送成功', rejectOk.code === 200 && rejectOk.data.autoConfirmBlocked === true, rejectOk);
  const rejectAgain = await api('POST', '/api/task/rejectFinish', { taskId: disputeTaskId, tags: [2] }, tokenA);
  check('重复提交未送达申诉被拦截（409）', rejectAgain.code === 409, rejectAgain);

  const disputedDetail = await api('GET', `/api/task/${disputeTaskId}`, undefined, tokenA);
  check('详情返回申诉标记与原因',
    disputedDetail.data.task.isDisputed === true && disputedDetail.data.task.disputeReason.indexOf('不是我的商品') >= 0,
    disputedDetail.data.task.disputeReason);
  check('申诉后不再可再次申诉', disputedDetail.data.task.actions.canRejectFinish === false,
    disputedDetail.data.task.actions);

  const takerDisputeMsg = await api('GET', '/api/message/list', undefined, takerToken);
  check('申诉后通知跑腿员', takerDisputeMsg.data.list.some((m) => m.title === '雇主反馈未送达'), takerDisputeMsg.data.list.length);
  const reportListForDispute = await api('GET', '/api/report/adminList', undefined, tokenA);
  check('申诉同步生成举报记录供管理员跟进',
    reportListForDispute.data.list.some((r) => r.taskId === disputeTaskId), reportListForDispute.data.total);

  // 列表接口必须下发 isDisputed，否则「我的发布 / 我的任务」卡片无法渲染红色「已申诉」角标
  const publishDisputed = await api('GET', '/api/task/myPublish?page=1&pageSize=50', undefined, tokenA);
  const publishRow = publishDisputed.data.list.find((t) => t.id === disputeTaskId);
  check('我的发布列表下发申诉标记（卡片红色角标）',
    !!publishRow && publishRow.isDisputed === true && publishRow.disputeReason.length > 0,
    publishRow && { isDisputed: publishRow.isDisputed, reason: publishRow.disputeReason });
  const takeDisputed = await api('GET', '/api/task/myTake?page=1&pageSize=50', undefined, takerToken);
  const takeRow = takeDisputed.data.list.find((t) => t.id === disputeTaskId);
  check('我的任务列表下发申诉标记（跑腿员可见）', !!takeRow && takeRow.isDisputed === true, takeRow && takeRow.isDisputed);

  title('8.6 限时倒计时 + 超时送达扣酬金（5%，不足 0.5 元按 0.5 元）');
  const createdLate = await api('POST', '/api/task/createOrder', {
    receiverName: '超时收件人', receiverPhone: '13900139010', deliverAddress: '东区5号楼',
    timeLimitMin: 1, reward: 8, img1: '/uploads/202609/late.jpg'
  }, tokenA);
  check('限时1分钟任务发布并支付成功', createdLate.code === 200, createdLate);
  const lateTaskId = createdLate.data.taskId;
  const takeLate = await api('POST', '/api/task/take', { taskId: lateTaskId }, takerToken);
  check('跑腿员接单成功', takeLate.code === 200, takeLate);

  const takerRunning = await api('GET', `/api/task/${lateTaskId}`, undefined, takerToken);
  check('接单后详情下发倒计时秒数（接单方可见）',
    typeof takerRunning.data.remainSeconds === 'number' && takerRunning.data.remainSeconds > 0,
    takerRunning.data.remainSeconds);
  const ownerRunning = await api('GET', `/api/task/${lateTaskId}`, undefined, tokenA);
  check('接单后详情下发倒计时秒数（雇主可见）',
    typeof ownerRunning.data.remainSeconds === 'number' && ownerRunning.data.remainSeconds > 0,
    ownerRunning.data.remainSeconds);
  const takerListRunning = await api('GET', '/api/task/myTake?page=1&pageSize=50', undefined, takerToken);
  const runningRow = takerListRunning.data.list.find((t) => t.id === lateTaskId);
  check('我的任务列表带倒计时秒数（列表也能显示倒计时）',
    !!runningRow && typeof runningRow.remainSeconds === 'number' && runningRow.remainSeconds > 0,
    runningRow && runningRow.remainSeconds);

  // 把接单时间往前拨 5 分钟，制造「超过限时才送达」
  await db.execute('UPDATE tasks SET take_time = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [lateTaskId]);
  const lateSubmit = await api('POST', '/api/task/submitFinish', {
    taskId: lateTaskId, deliveryImages: ['/uploads/202609/late_d1.jpg']
  }, takerToken);
  check('超时后提交送达成功（status=2）', lateSubmit.code === 200, lateSubmit);

  const lateDetail = await api('GET', `/api/task/${lateTaskId}`, undefined, tokenA);
  const lateTask = lateDetail.data.task;
  check('详情标记为超时送达', lateTask.isLateDelivery === true, lateTask.isLateDelivery);
  check('酬金 8 元的 5% 为 0.4 元，不足 0.5 元按 0.5 元扣减',
    Number(lateTask.lateDeductPreview.deduct) === 0.5, lateTask.lateDeductPreview);
  check('扣减后酬金 7.5 元', Number(lateTask.lateDeductPreview.remain) === 7.5, lateTask.lateDeductPreview);
  check('雇主可扣减超时酬金', lateTask.actions.canDeductLateReward === true, lateTask.actions);

  const wrongDeduct = await api('POST', '/api/task/deductLateReward', { taskId: lateTaskId }, takerToken);
  check('非雇主不能扣减酬金', wrongDeduct.code === 403, wrongDeduct);

  const deduct = await api('POST', '/api/task/deductLateReward', { taskId: lateTaskId }, tokenA);
  check('超时扣减酬金成功且酬金降为 7.5 元',
    deduct.code === 200 && Number(deduct.data.reward) === 7.5 && Number(deduct.data.deduct) === 0.5, deduct);
  const deductAgain = await api('POST', '/api/task/deductLateReward', { taskId: lateTaskId }, tokenA);
  check('超时扣减只生效一次（重复提交 409）', deductAgain.code === 409, deductAgain);

  const deductMsg = await api('GET', '/api/message/list', undefined, takerToken);
  check('扣减后通知跑腿员',
    deductMsg.data.list.some((m) => m.title === '超时送达已扣减酬金'), deductMsg.data.list.length);

  const confirmLate = await api('POST', '/api/task/confirmFinish', { taskId: lateTaskId }, tokenA);
  check('扣减后确认送达成功', confirmLate.code === 200, confirmLate);
  const lateBill = await api('GET', '/api/bill/list', undefined, takerToken);
  check('账单按扣减后的酬金 7.5 元记账',
    lateBill.data.list.some((b) => b.type === 1 && b.task_id === lateTaskId && Number(b.amount) === 7.5),
    lateBill.data.list.filter((b) => b.task_id === lateTaskId));

  title('9. 退费流程（先撤销 -> 再到已撤销列表申请退费）');
  const created2 = await api('POST', '/api/task/createOrder', {
    receiverName: '李四', receiverPhone: '13900139001', deliverAddress: '西区2号楼', reward: 4,
    img1: '/uploads/test/refund.jpg'
  }, tokenA);
  const refundBeforeCancel = await api('POST', '/api/task/applyRefund', { taskId: created2.data.taskId }, tokenA);
  check('待接单状态不可直接退费（必须先撤销）', refundBeforeCancel.code === 409, refundBeforeCancel);
  const hallBeforeCancel = await api('GET', '/api/task/list?page=1&pageSize=50', undefined, tokenB);
  check('未撤销的任务仍在大厅展示',
    hallBeforeCancel.data.list.some((t) => t.id === created2.data.taskId), hallBeforeCancel.data.list.length);

  // 首页默认请求：未填酬金区间时前端传的是空串，曾因后端 parseMoney('')=0 导致大厅列表被整体筛空
  const hallDefault = await api('GET',
    '/api/task/list?page=1&pageSize=10&keyword=&sort=time_desc&minReward=&maxReward=', undefined, tokenB);
  check('首页默认请求（空酬金区间）可正常返回任务',
    hallDefault.code === 200 && hallDefault.data.list.length > 0, hallDefault);
  const hallSorted = await api('GET',
    '/api/task/list?page=1&pageSize=10&keyword=&sort=reward_desc&minReward=&maxReward=', undefined, tokenB);
  check('排序参数生效（酬金从高到低）',
    hallSorted.code === 200 && hallSorted.data.list.length > 0, hallSorted);
  const hallByReward = await api('GET',
    '/api/task/list?page=1&pageSize=50&minReward=4&maxReward=4', undefined, tokenB);
  check('酬金区间筛选生效（只返回区间内任务）',
    hallByReward.code === 200 && hallByReward.data.list.length > 0
    && hallByReward.data.list.every((t) => Number(t.reward) === 4), hallByReward.data.list.length);
  const cancel2 = await api('POST', '/api/task/cancel', { taskId: created2.data.taskId }, tokenA);
  check('撤销成功且不自动退费（返回可退费标记）',
    cancel2.code === 200 && cancel2.data.canApplyRefund === true, cancel2);

  const detailAfterCancel = await api('GET', `/api/task/${created2.data.taskId}`, undefined, tokenA);
  check('撤销后状态=5且仍未退费',
    detailAfterCancel.data.task.status === 5 && Number(detailAfterCancel.data.task.isRefunded) === 0,
    detailAfterCancel.data.task);

  const hallAfterCancel = await api('GET', '/api/task/list?page=1&pageSize=50', undefined, tokenB);
  check('撤销后任务已从大厅下架',
    !hallAfterCancel.data.list.some((t) => t.id === created2.data.taskId), hallAfterCancel.data.list.length);

  const cancelledList = await api('GET', '/api/task/myPublish?page=1&pageSize=50&status=5', undefined, tokenA);
  const cancelledRow = (cancelledList.data.list || []).find((t) => t.id === created2.data.taskId);
  check('我的发布-已撤销列表可找到该任务且允许申请退费',
    !!cancelledRow && cancelledRow.actions.canApplyRefund === true, cancelledRow && cancelledRow.actions);

  const refund = await api('POST', '/api/task/applyRefund', { taskId: created2.data.taskId }, tokenA);
  check('已撤销任务可申请退费并成功', refund.code === 200 && refund.data.refunded === true, refund);

  const refundAgain = await api('POST', '/api/task/applyRefund', { taskId: created2.data.taskId }, tokenA);
  check('已退费任务不可重复退费', refundAgain.code === 403 || refundAgain.code === 409, refundAgain);

  const detailAfterRefund = await api('GET', `/api/task/${created2.data.taskId}`, undefined, tokenA);
  check('退费后仍保持已撤销状态并标记已退费',
    detailAfterRefund.data.task.status === 5 && Number(detailAfterRefund.data.task.isRefunded) === 1,
    detailAfterRefund.data.task);
  title('10. 撤销任务与编辑规则');
  const created3 = await api('POST', '/api/task/createOrder', {
    receiverName: '王五', receiverPhone: '13900139002', deliverAddress: '南区3号楼', reward: 3,
    img1: '/uploads/test/edit.jpg'
  }, tokenA);
  const created3Detail = await api('GET', `/api/task/${created3.data.taskId}`, undefined, tokenA);
  check('未填写的取件码 / 详细地址落库为空串（选填项）',
    created3Detail.data.task.pickupCode === '' && created3Detail.data.task.detailAddress === '',
    created3Detail.data.task);
  const edit = await api('POST', '/api/task/edit', {
    taskId: created3.data.taskId, reward: 4,
    pickupCode: '12-34-5678', detailAddress: 'A区12号工位'
  }, tokenA);
  check('待接单任务可编辑且酬金上调', edit.code === 200, edit);
  const editDown = await api('POST', '/api/task/edit', { taskId: created3.data.taskId, reward: 2 }, tokenA);
  check('编辑时酬金不可降低', editDown.code === 400 && editDown.msg.indexOf('酬金') >= 0, editDown);

  const editedDetail = await api('GET', `/api/task/${created3.data.taskId}`, undefined, tokenA);
  check('编辑可同时保存取件码与详细地址',
    editedDetail.data.task.pickupCode === '12-34-5678'
    && editedDetail.data.task.detailAddress === 'A区12号工位', editedDetail.data.task);

  const editLongPickup = await api('POST', '/api/task/edit', {
    taskId: created3.data.taskId, reward: 4, pickupCode: 'A'.repeat(21)
  }, tokenA);
  check('编辑时取件码超过20字被拒绝（400）', editLongPickup.code === 400, editLongPickup);
  const editLongDetail = await api('POST', '/api/task/edit', {
    taskId: created3.data.taskId, reward: 4, detailAddress: 'B'.repeat(101)
  }, tokenA);
  check('编辑时详细地址超过100字被拒绝（400）', editLongDetail.code === 400, editLongDetail);

  const editFreq = await api('POST', '/api/task/edit', { taskId: created3.data.taskId, reward: 5 }, tokenA);
  check('编辑间隔3分钟限制', editFreq.code === 409, editFreq);
  const cancel = await api('POST', '/api/task/cancel', { taskId: created3.data.taskId }, tokenA);
  check('雇主撤销待接单任务', cancel.code === 200, cancel);
  check('撤销不自动退费，仅返回可退费标记', cancel.data.canApplyRefund === true, cancel.data);
  const cancelAgain = await api('POST', '/api/task/cancel', { taskId: created3.data.taskId }, tokenA);
  check('撤销幂等', cancelAgain.code === 200 && cancelAgain.data.repeated === true, cancelAgain);
  const editCancelled = await api('POST', '/api/task/edit', { taskId: created3.data.taskId, reward: 6 }, tokenA);
  check('已撤销任务不可编辑', editCancelled.code === 409, editCancelled);

  title('11. 申诉 / 举报 / 管理员接口');
  const appeal = await api('POST', '/api/appeal/submit', { content: '我的账号被误封，请管理员核实。' }, tokenB);
  check('提交申诉成功', appeal.code === 200, appeal);
  await api('POST', '/api/appeal/submit', { content: '第二条申诉内容测试。' }, tokenB);
  const appeal3 = await api('POST', '/api/appeal/submit', { content: '第三条申诉应被拒绝。' }, tokenB);
  check('每日申诉上限2条', appeal3.code === 409, appeal3);
  const appealAdmin = await api('GET', '/api/appeal/adminList?status=1', undefined, tokenA);
  check('管理员可查看申诉列表', appealAdmin.code === 200 && appealAdmin.data.total >= 2, appealAdmin.data);
  const reply = await api('POST', '/api/appeal/reply', {
    appealId: appeal.data.appealId, adminReply: '已核实，账号状态正常。'
  }, tokenA);
  check('管理员回复申诉', reply.code === 200, reply);
  const appealMsg = await api('GET', '/api/message/list?msgType=2', undefined, tokenB);
  check('回复后推送站内消息', appealMsg.data.list.length >= 1, appealMsg.data);

  const report = await api('POST', '/api/report/submit', { taskId, reportReason: '跑腿员态度恶劣，请核实处理。' }, otherToken);
  check('提交举报成功', report.code === 200, report);
  const reportAdmin = await api('GET', '/api/report/adminList', undefined, tokenA);
  check('管理员可查看举报列表', reportAdmin.code === 200 && reportAdmin.data.total >= 1, reportAdmin.data);
  check('举报回执返回订单号', report.data.orderNo === hallTask.orderNo, report.data.orderNo);
  const adminReportRow = reportAdmin.data.list.find((row) => row.id === report.data.reportId);
  check('管理员举报列表展示订单号',
    !!adminReportRow && adminReportRow.orderNo === hallTask.orderNo,
    adminReportRow && adminReportRow.orderNo);
  check('管理员举报列表展示雇主 账号ID/学号/手机号',
    !!adminReportRow && adminReportRow.ownerUserId > 0
      && adminReportRow.ownerStudentId.length > 0 && adminReportRow.ownerPhone.length > 0,
    adminReportRow && {
      ownerUserId: adminReportRow.ownerUserId,
      ownerStudentId: adminReportRow.ownerStudentId,
      ownerPhone: adminReportRow.ownerPhone
    });
  check('管理员举报列表展示接单人 账号ID/学号/手机号',
    !!adminReportRow && adminReportRow.takerUserId > 0
      && adminReportRow.takerStudentId.length > 0 && adminReportRow.takerPhone.length > 0,
    adminReportRow && {
      takerUserId: adminReportRow.takerUserId,
      takerStudentId: adminReportRow.takerStudentId,
      takerPhone: adminReportRow.takerPhone
    });
  // 上报的订单号必须与任务一致，防止把举报挂到别的订单上
  const reportMismatch = await api('POST', '/api/report/submit', {
    taskId, reportReason: '订单号不一致的举报应被拒绝。', orderNo: 'GCPT999999'
  }, takerToken);
  check('上报订单号与任务不一致时被拒绝', reportMismatch.code === 409, reportMismatch);
  const handleReport = await api('POST', '/api/report/handle', {
    reportId: report.data.reportId, adminNote: '已处理完毕，对跑腿员进行警告。'
  }, tokenA);
  check('管理员处理举报', handleReport.code === 200, handleReport);

  // ---------------- 举报规则一：任务发布人不能举报自己的任务 ----------------
  const reportOwn = await api('POST', '/api/report/submit', {
    taskId, reportReason: '雇主举报自己的任务应当被后端拒绝。'
  }, tokenA);
  check('任务发布人不能举报自己的任务',
    reportOwn.code === 403 && reportOwn.msg === '不能举报自己发布的任务', reportOwn);
  const detailOwnerAction = await api('GET', `/api/task/${taskId}`, undefined, tokenA);
  const detailOtherAction = await api('GET', `/api/task/${taskId}`, undefined, otherToken);
  check('雇主视角举报入口隐藏（actions.canReport=false）',
    detailOwnerAction.data.task.actions.canReport === false,
    detailOwnerAction.data.task.actions);
  check('非雇主视角举报入口可见（actions.canReport=true）',
    detailOtherAction.data.task.actions.canReport === true,
    detailOtherAction.data.task.actions);

  // ---------------- 举报规则二：同一任务每人半小时最多举报 3 次 ----------------
  // 直接造 3 条「已处理」的历史举报（同一用户 + 同一任务 + 30 分钟内），
  // 再把第 4 条走接口提交，必须被频率限制拦截（避免与「同一任务仅 1 条待处理」规则混淆）
  const otherInfo = await api('GET', '/api/user/info', undefined, otherToken);
  const otherUserId = otherInfo.data.user.userId;
  for (let i = 0; i < 3; i += 1) {
    await db.execute(
      `INSERT INTO report (user_id, task_id, report_reason, report_type, status, created_at)
       VALUES (?, ?, ?, 1, 2, NOW())`,
      [otherUserId, taskId, `举报频率限制测试数据 ${i + 1}`]
    );
  }
  // 跨过后端 3 秒防连点幂等窗口，确保下面命中的是「半小时 3 次」频率限制
  await sleep(3200);
  const reportTooFreq = await api('POST', '/api/report/submit', {
    taskId, reportReason: '半小时内第 4 次举报应当被频率限制拦截。'
  }, otherToken);
  check('同一任务每人半小时最多举报3次',
    reportTooFreq.code === 409 && reportTooFreq.msg === '举报过于频繁，同一任务30分钟内最多举报3次',
    reportTooFreq);
  // 频率限制按「用户 + 任务」维度统计：同一用户举报别的任务不受影响
  const reportOtherTask = await api('POST', '/api/report/submit', {
    taskId: disputeTaskId, reportReason: '同一用户举报其他任务不受该任务频率限制影响。'
  }, otherToken);
  check('举报频率限制按 用户+任务 维度统计',
    reportOtherTask.code === 200, reportOtherTask);

  // ---------------- 封禁管理：搜索同时命中已封禁与未封禁用户 ----------------
  const banSearchBefore = await api('GET', '/api/admin/banList?keyword=13800138002', undefined, tokenA);
  const beforeRow = banSearchBefore.data.list[0];
  check('封禁管理搜索能搜到未被封禁的用户',
    banSearchBefore.code === 200 && banSearchBefore.data.list.length === 1
      && beforeRow.isBanned === false && beforeRow.banStatus === 0,
    banSearchBefore.data.list);
  check('未封禁用户的封禁状态文案取自字典',
    beforeRow.banStatusText === '未封禁', beforeRow.banStatusText);
  const banFromSearch = await api('POST', '/api/admin/banUser', {
    userId: beforeRow.userId, durationType: '5m', reason: '回归测试：搜索结果直接封禁'
  }, tokenA);
  check('可对搜索结果中未封禁的用户直接封禁', banFromSearch.code === 200, banFromSearch);
  const banSearchAfter = await api('GET', '/api/admin/banList?keyword=13800138002', undefined, tokenA);
  const afterRow = banSearchAfter.data.list[0];
  check('封禁后同一搜索结果标记为封禁中',
    afterRow.isBanned === true && afterRow.banStatus === 1 && afterRow.banStatusText === '封禁中',
    afterRow);
  check('封禁中用户带出剩余时长', afterRow.banRemainSeconds > 0, afterRow.banRemainSeconds);
  const banListDefault = await api('GET', '/api/admin/banList?page=1&pageSize=50', undefined, tokenA);
  check('不输关键词时只返回封禁中的用户',
    banListDefault.data.list.every((row) => row.isBanned === true), banListDefault.data.list);
  const unbanFromSearch = await api('POST', '/api/admin/unbanUser', { userId: afterRow.userId }, tokenA);
  check('解封后恢复未封禁状态', unbanFromSearch.code === 200, unbanFromSearch);

  const userList = await api('GET', '/api/admin/userList?page=1&pageSize=20', undefined, tokenA);
  check('管理员获取用户列表', userList.code === 200 && userList.data.total >= 3, userList.data);
  const userListForbidden = await api('GET', '/api/admin/userList', undefined, tokenB);
  check('普通用户访问管理员接口403', userListForbidden.code === 403, userListForbidden);
  const auditForbidden = await api('GET', '/api/audit/adminList', undefined, tokenB);
  check('普通用户不能查看审核后台', auditForbidden.code === 403, auditForbidden);

  title('11.5 邀请码免费代拿权益 + 发布表单强校验');
  // 11.5.1 邀请码不存在 -> 注册直接拦截
  const smsBadInvite = await api('POST', '/api/user/sendSmsCode', { phone: '13800138031' });
  const badInvite = await api('POST', '/api/user/register', {
    phone: '13800138031', password: 'abc123456', smsCode: smsBadInvite.data.code,
    name: '无效邀请码', studentId: '20239031', nickname: '无效邀请码', inviteCode: 'NOT-EXIST-CODE'
  });
  check('邀请码不存在时注册被拦截', badInvite.code === 400 && badInvite.msg.indexOf('邀请码') >= 0, badInvite);

  // 11.5.2 填写有效邀请码注册 -> 获得 7 天内 1 次免费代拿 + 站内消息
  const inviterInfo = await api('GET', '/api/user/info', undefined, tokenA);
  const inviterAccountNo = inviterInfo.data.user.accountNo;
  const smsInvite = await api('POST', '/api/user/sendSmsCode', { phone: '13800138032' });
  const regInvite = await api('POST', '/api/user/register', {
    phone: '13800138032', password: 'abc123456', smsCode: smsInvite.data.code,
    name: '邀请用户', studentId: '20239032', nickname: '邀请用户', inviteCode: inviterInfo.data.user.inviteCode
  });
  check('填写有效邀请码注册成功', regInvite.code === 200, regInvite);
  check('注册即下发免费代拿次数1且可用（7天内）',
    regInvite.data.user.freeDeliveryCount === 1 && regInvite.data.user.freeDeliveryAvailable === true,
    regInvite.data.user);
  const inviteMsg = await api('GET', '/api/message/list?page=1&pageSize=20', undefined, regInvite.data.accessToken);
  check('收到邀请码奖励站内消息（文案含邀请人账号ID）',
    (inviteMsg.data.list || []).some((m) => m.title === '邀请码奖励到账'
      && m.content.indexOf(inviterAccountNo) >= 0 && m.content.indexOf('仅限一件包裹') >= 0),
    inviteMsg.data.list);

  // 11.5.3 给已认证的跑腿员 B 发放一次免费权益（模拟邀请码奖励），验证发布免服务费
  await db.execute(
    'UPDATE users SET free_delivery_count = 1, free_delivery_expire = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE phone = ?',
    ['13800138002']
  );
  const freePublish = await api('POST', '/api/task/createOrder', {
    receiverName: '免费代拿收件人', receiverPhone: '13900139018', deliverAddress: 'X栋X楼A101',
    timeLimitMin: 60, reward: 0.8, img1: '/uploads/test/free.jpg', useFreeDelivery: true
  }, tokenB);
  check('使用免费代拿权益发布成功且服务费为0元',
    freePublish.code === 200 && Number(freePublish.data.serviceFee) === 0
      && freePublish.data.freeDelivery === true, freePublish);
  const freeDetail = await api('GET', `/api/task/${freePublish.data.taskId}`, undefined, tokenB);
  check('免费代拿任务已上架且标记 isFreeDelivery',
    freeDetail.data.task.status === 0 && freeDetail.data.task.isFreeDelivery === true
      && Number(freeDetail.data.task.serviceFee) === 0, freeDetail.data.task);
  const freeBill = await api('GET', '/api/bill/list', undefined, tokenB);
  check('免费代拿任务不生成服务费支出账单',
    !freeBill.data.list.some((b) => b.task_id === freePublish.data.taskId && b.type === 2),
    freeBill.data.list.filter((b) => b.task_id === freePublish.data.taskId));

  const infoBAfterFree = await api('GET', '/api/user/info', undefined, tokenB);
  check('免费次数使用后归零、权益不可用',
    infoBAfterFree.data.user.freeDeliveryCount === 0
      && infoBAfterFree.data.user.freeDeliveryAvailable === false, infoBAfterFree.data.user);
  const freeAgain = await api('POST', '/api/task/createOrder', {
    receiverName: '重复免费', receiverPhone: '13900139021', deliverAddress: 'X栋X楼A102',
    timeLimitMin: 60, reward: 0.8, img1: '/uploads/test/free2.jpg', useFreeDelivery: true
  }, tokenB);
  check('免费次数已用完时再次使用被拦截（409）',
    freeAgain.code === 409 && freeAgain.msg.indexOf('免费代拿') >= 0, freeAgain);

  // 11.5.4 免费权益返还：无人接单撤销 -> 返还；一旦被接单过 -> 永久不返还
  await db.execute(
    'UPDATE users SET free_delivery_count = 1, free_delivery_expire = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE phone = ?',
    ['13800138002']
  );
  const freeTask2 = await api('POST', '/api/task/createOrder', {
    receiverName: '返还用收件人', receiverPhone: '13900139022', deliverAddress: 'X栋X楼A201',
    timeLimitMin: 60, reward: 1.5, img1: '/uploads/test/free3.jpg', useFreeDelivery: true
  }, tokenB);
  check('再次使用免费权益发布成功', freeTask2.code === 200 && freeTask2.data.freeDelivery === true, freeTask2);
  const cancelFreeTask2 = await api('POST', '/api/task/cancel', { taskId: freeTask2.data.taskId }, tokenB);
  check('无人接单撤销后返还免费代拿次数',
    cancelFreeTask2.code === 200 && cancelFreeTask2.data.freeDeliveryReturned === true, cancelFreeTask2);
  const infoBReturn = await api('GET', '/api/user/info', undefined, tokenB);
  check('返还后免费次数恢复为1且可用',
    infoBReturn.data.user.freeDeliveryCount === 1 && infoBReturn.data.user.freeDeliveryAvailable === true,
    infoBReturn.data.user);
  const cancelFreeTask2Again = await api('POST', '/api/task/cancel', { taskId: freeTask2.data.taskId }, tokenB);
  const infoBAfterAgain = await api('GET', '/api/user/info', undefined, tokenB);
  check('重复撤销不会重复返还权益（幂等）',
    cancelFreeTask2Again.code === 200 && cancelFreeTask2Again.data.repeated === true
      && Number(infoBAfterAgain.data.user.freeDeliveryCount) === 1, cancelFreeTask2Again);

  // 被接单过：跑腿员接单后 10 分钟内取消接单，任务回到待接单（once_taken 永久为 1）
  const freeTask3 = await api('POST', '/api/task/createOrder', {
    receiverName: '被接单返还用收件人', receiverPhone: '13900139023', deliverAddress: 'X栋X楼A202',
    timeLimitMin: 60, reward: 1.5, img1: '/uploads/test/free4.jpg', useFreeDelivery: true
  }, tokenB);
  check('第三次使用免费权益发布成功', freeTask3.code === 200 && freeTask3.data.freeDelivery === true, freeTask3);
  const takeFree3 = await api('POST', '/api/task/take', { taskId: freeTask3.data.taskId }, tokenC);
  check('跑腿员接单成功（免费权益任务）', takeFree3.code === 200, takeFree3);
  const cancelTakeFree3 = await api('POST', '/api/task/cancelTake', { taskId: freeTask3.data.taskId }, tokenC);
  check('跑腿员10分钟内取消接单，任务回到待接单', cancelTakeFree3.code === 200, cancelTakeFree3);
  const cancelFreeTask3 = await api('POST', '/api/task/cancel', { taskId: freeTask3.data.taskId }, tokenB);
  check('被接单过的任务撤销后不返还免费代拿次数',
    cancelFreeTask3.code === 200 && cancelFreeTask3.data.freeDeliveryReturned === false, cancelFreeTask3);
  const infoBNoReturn = await api('GET', '/api/user/info', undefined, tokenB);
  check('不返还时免费次数保持为0', Number(infoBNoReturn.data.user.freeDeliveryCount) === 0, infoBNoReturn.data.user);

  // 11.5.5 发布表单强校验：照片必填 + 酬金下限 0.5 元（换用第三个账号，避开「发布任务 1 分钟 5 次」限流）
  const noTaskImg = await api('POST', '/api/task/createOrder', {
    receiverName: '缺图收件人', receiverPhone: '13900139019', deliverAddress: 'X栋X楼A103',
    timeLimitMin: 60, reward: 1
  }, tokenC);
  check('未上传任务图片无法发布', noTaskImg.code === 400 && noTaskImg.msg.indexOf('图片') >= 0, noTaskImg);
  const lowReward = await api('POST', '/api/task/createOrder', {
    receiverName: '低酬金收件人', receiverPhone: '13900139020', deliverAddress: 'X栋X楼A104',
    timeLimitMin: 60, reward: 0.3, img1: '/uploads/test/low.jpg'
  }, tokenC);
  check('酬金低于0.5元无法发布', lowReward.code === 400 && lowReward.msg.indexOf('0.5') >= 0, lowReward);

  title('12. 我的发布 / 我的任务');
  const myPublish = await api('GET', '/api/task/myPublish', undefined, tokenA);
  check('我的发布列表可用', myPublish.code === 200 && myPublish.data.total >= 3, myPublish.data.total);
  check('我的发布状态分组统计', typeof myPublish.data.statusCounts === 'object', myPublish.data.statusCounts);
  const myTake = await api('GET', '/api/task/myTake', undefined, takerToken);
  check('我的任务列表可用', myTake.code === 200 && myTake.data.total >= 1, myTake.data.total);

  title('13. 防暴力破解锁定');
  for (let i = 1; i <= 5; i += 1) {
    /* eslint-disable no-await-in-loop */
    await api('POST', '/api/user/login', { account: '13800138003', password: `bad-${i}` });
  }
  const locked = await api('POST', '/api/user/login', { account: '13800138003', password: 'abc123456' });
  check('连续5次错误后锁定，正确密码也返回锁定', locked.code === 423, locked);
  const lockedById = await api('POST', '/api/user/login', { account: '0003', password: 'abc123456' });
  check('切换登录方式无法绕过锁定', lockedById.code === 423, lockedById);

  title('14. 越权校验');
  const otherDetail = await api('GET', `/api/task/${created2.data.taskId}`, undefined, tokenB);
  check('他人任务详情不返回完整收件人手机号',
    otherDetail.code !== 200 || otherDetail.data.task.receiverPhone === '', otherDetail.data);
  const repayOther = await api('POST', '/api/pay/repay', { taskId: created2.data.taskId }, tokenB);
  check('不能查询/操作他人支付订单', repayOther.code === 403, repayOther);

  title('15. 账号注销（历史记录保留 + 手机号 / 学号释放）');
  const deactPhone = '13800138041';
  // 注册一个一次性注销测试账号；重复执行脚本时该手机号可能被上次的残留账号占用，
  // 此时注册会返回重复错误，但下方会直接查库拿到可用账号，脚本依旧可重复执行。
  await registerUser(deactPhone, '20240041', '注销测试');
  const deactUser = (await db.query(
    'SELECT id, account_no FROM users WHERE phone = ? AND deactivated_at IS NULL', [deactPhone]
  ))[0];
  check('注销测试账号已就绪', !!deactUser, deactUser);

  // 造一条历史任务 + 历史账单，用于验证注销后历史记录仍然保留
  const histTaskId = (await db.execute(
    'INSERT INTO tasks (user_id, receiver_name, receiver_phone, deliver_address, reward, status, order_no)'
      + ' VALUES (?, ?, ?, ?, ?, 3, ?)',
    [deactUser.id, '注销历史收件人', '13900139031', 'X栋X楼A301', 2.5, `GCPT9${Date.now()}`]
  )).insertId;
  await db.execute(
    'INSERT INTO user_bill (user_id, task_id, type, amount, remark) VALUES (?, ?, 1, ?, ?)',
    [deactUser.id, histTaskId, 2.5, '注销前历史账单']
  );

  const deactLogin = await api('POST', '/api/user/login', { account: deactPhone, password: 'abc123456' });
  check('注销前可正常登录', deactLogin.code === 200, deactLogin);
  const deactToken = deactLogin.data.accessToken;

  const adminDeact = await api('POST', '/api/admin/deactivateUser', { userId: deactUser.id }, tokenA);
  check('管理员注销账号成功', adminDeact.code === 200, adminDeact);

  const deactTokenAfter = await api('GET', '/api/user/info', undefined, deactToken);
  check('注销后旧 access_token 立即失效（401）', deactTokenAfter.code === 401, deactTokenAfter);

  const deactLoginAfter = await api('POST', '/api/user/login', { account: deactPhone, password: 'abc123456' });
  check('注销后原手机号无法再登录', deactLoginAfter.code !== 200, deactLoginAfter);

  const histTaskRow = (await db.query('SELECT id, user_id, status FROM tasks WHERE id = ?', [histTaskId]))[0];
  const histBillRow = (await db.query('SELECT id, amount FROM user_bill WHERE task_id = ?', [histTaskId]))[0];
  check('注销后历史任务记录仍保留',
    !!histTaskRow && histTaskRow.user_id === deactUser.id && Number(histTaskRow.status) === 3, histTaskRow);
  check('注销后历史账单记录仍保留', !!histBillRow && Number(histBillRow.amount) === 2.5, histBillRow);

  const deactRowFinal = (await db.query(
    'SELECT account_no, phone, student_id, deactivated_at FROM users WHERE id = ?', [deactUser.id]
  ))[0];
  check('注销后对外账号编号保留（历史记录仍可读）',
    deactRowFinal.account_no === deactUser.account_no && !!deactRowFinal.deactivated_at, deactRowFinal);
  check('注销后手机号与学号被释放为占位值',
    deactRowFinal.phone !== deactPhone && deactRowFinal.student_id !== '20240041', deactRowFinal);

  // 手机号 / 学号已释放：下一个账号可以重新使用同一手机号与学号注册
  // （直接写库一条验证码，避开「同一手机号 60 秒内最多发 1 条」的发送限流）
  await db.execute(
    'INSERT INTO sms_code (phone, code, expire_time) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
    [deactPhone, '654321']
  );
  const reRegister = await api('POST', '/api/user/register', {
    phone: deactPhone, password: 'abc123456', smsCode: '654321',
    name: '注销后重注册', studentId: '20240041', nickname: '注销后重注册'
  });
  const reUser = (await db.query(
    'SELECT id FROM users WHERE phone = ? AND deactivated_at IS NULL', [deactPhone]
  ))[0];
  check('注销后手机号 / 学号可被新账号重新注册使用',
    reRegister.code === 200 && !!reUser && reUser.id !== deactUser.id, { reRegister, reUser });

  console.log(`\n===== 测试结束：通过 ${passCount} 项，失败 ${failCount} 项 =====`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(1);
});
