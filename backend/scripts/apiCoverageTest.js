/**
 * =====================================================================
 * 【已停用】本脚本基于旧账号体系（手机号 + 短信验证码）编写。
 *   短信验证码已整体下线，注册改为「图形验证码 + 自选账号ID」，
 *   重置密码改为「账号ID + 学号 + 姓名 + 2 道密保」，因此本脚本已无法直接运行，请改用：
 *     node scripts/regression-business-flow.js   # 业务全流程回归（102 项）
 *     node scripts/regression-account-security.js # 账号体系 / 密保 / 换设备解锁（26 项）
 *   如确需运行旧脚本，请设置环境变量 FORCE_LEGACY_SMS_TEST=1（预期大量失败）。
 *
 * 接口覆盖测试脚本（逐一调用「完整接口清单」中的每个接口，输出覆盖结果）
 * 运行：node scripts/apiCoverageTest.js   （需先启动后端服务）
 * 说明：smokeTest.js 覆盖核心业务主流程，本脚本补齐其余接口：
 *       刷新令牌 / 重置密码 / 图片上传 / 取消接单 / 支付回调验签 /
 *       支付状态查询 / 我的审核记录 / 我的申诉记录 / 一键已读
 * =====================================================================
 */

const db = require('../src/db/db');

// 旧脚本保护：默认直接提示并退出，避免跑出一堆与「短信接口已下线」相关的误导性失败
if (process.env.FORCE_LEGACY_SMS_TEST !== '1') {
  console.error('[已停用] apiCoverageTest.js 基于旧「手机号 + 短信验证码」账号体系，接口已下线。');
  console.error('请改用：node scripts/regression-business-flow.js（业务全流程回归）');
  console.error('        node scripts/regression-account-security.js（账号体系回归）');
  console.error('如确需运行旧脚本，请设置环境变量 FORCE_LEGACY_SMS_TEST=1。');
  process.exit(1);
}

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

let passCount = 0;
let failCount = 0;
const covered = [];

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

/** 统一请求方法 */
async function api(method, p, body, token, deviceId = 'coverage-device') {
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': deviceId };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${p}`, {
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

/** 记录已覆盖接口 */
function mark(name) {
  covered.push(name);
}

/** 登录 */
async function login(account, password = 'abc123456', deviceId = 'coverage-device') {
  return api('POST', '/api/user/login', { account, password }, undefined, deviceId);
}
async function main() {
  title('1. 准备：管理员 + 跑腿员登录');
  const adminLogin = await login('13800138001');
  check('POST /api/user/login（管理员）', adminLogin.code === 200, adminLogin);
  mark('POST /api/user/login');
  const adminToken = adminLogin.data.accessToken;

  // 通过账号ID登录，验证去前导零
  const idLogin = await login('0001');
  check('POST /api/user/login（账号ID 0001）', idLogin.code === 200, idLogin);

  const takerLogin = await login('13800138011');
  check('POST /api/user/login（跑腿员）', takerLogin.code === 200, takerLogin);
  const takerToken = takerLogin.data.accessToken;

  // ---------------- 刷新令牌 ----------------
  title('2. POST /api/user/refreshToken 刷新令牌');
  const refreshed = await api('POST', '/api/user/refreshToken',
    { refreshToken: takerLogin.data.refreshToken }, undefined, 'coverage-device');
  check('刷新令牌成功并返回新的双令牌',
    refreshed.code === 200 && !!refreshed.data.accessToken && !!refreshed.data.refreshToken, refreshed);
  mark('POST /api/user/refreshToken');
  const newTokenWorks = await api('GET', '/api/user/info', undefined, refreshed.data.accessToken);
  check('刷新得到的新 access_token 可用', newTokenWorks.code === 200, newTokenWorks);
  const badRefresh = await api('POST', '/api/user/refreshToken', { refreshToken: 'invalid.token.here' });
  check('非法 refresh_token 被拒绝（401）', badRefresh.code === 401, badRefresh);

  // ---------------- 个人信息 ----------------
  const info = await api('GET', '/api/user/info', undefined, adminToken);
  check('GET /api/user/info', info.code === 200 && !!info.data.user, info);
  mark('GET /api/user/info');

  // ---------------- 上传图片（multipart） ----------------
  title('3. POST /api/user/uploadImage 图片上传');
  const jpgBytes = new Uint8Array(64);
  jpgBytes[0] = 0xff; jpgBytes[1] = 0xd8; jpgBytes[2] = 0xff; jpgBytes[3] = 0xe0;
  const form = new FormData();
  form.append('file', new Blob([jpgBytes], { type: 'image/jpeg' }), 'test.jpg');
  const uploadResp = await fetch(`${BASE}/api/user/uploadImage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${takerToken}`, 'X-Device-Id': 'coverage-device' },
    body: form
  });
  const uploadData = await uploadResp.json().catch(() => ({ code: -1 }));
  check('合法 jpg 文件头上传成功', uploadData.code === 200 && !!uploadData.data.url, uploadData);
  mark('POST /api/user/uploadImage');

  const badForm = new FormData();
  badForm.append('file', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5, 6, 7, 8])], { type: 'application/pdf' }), 'bad.pdf');
  const badResp = await fetch(`${BASE}/api/user/uploadImage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${takerToken}`, 'X-Device-Id': 'coverage-device' },
    body: badForm
  });
  const badData = await badResp.json().catch(() => ({ code: -1 }));
  check('伪造文件头被拒绝', badData.code === 400, badData);
  // ---------------- 取消接单 ----------------
  title('4. POST /api/task/cancelTake 取消接单（10分钟内）');
  const t3 = await api('POST', '/api/task/createOrder', {
    receiverName: '取消接单收件人', receiverPhone: '13900139012', deliverAddress: '北区5号楼',
    timeLimitMin: 30, reward: 4, img1: '/uploads/test/g3.jpg'
  }, adminToken);
  check('任务发布并支付成功', t3.code === 200, t3);
  mark('POST /api/task/createOrder');

  const take3 = await api('POST', '/api/task/take', { taskId: t3.data.taskId }, takerToken);
  check('接单成功', take3.code === 200, take3);
  mark('POST /api/task/take');

  const cancelTake = await api('POST', '/api/task/cancelTake', { taskId: t3.data.taskId }, takerToken);
  check('10分钟内取消接单成功', cancelTake.code === 200, cancelTake);
  mark('POST /api/task/cancelTake');

  const row3 = (await db.query('SELECT status, taker_user_id, once_taken FROM tasks WHERE id = ?', [t3.data.taskId]))[0];
  check('任务回到待接单且清空接单信息', row3.status === 0 && row3.taker_user_id === null, row3);
  check('once_taken 仍为1（永久关闭退费）', Number(row3.once_taken) === 1, row3);

  const takerRow3 = (await db.query('SELECT ban_take_time FROM users WHERE phone = ?', ['13800138011']))[0];
  check('主动取消不触发封禁', takerRow3.ban_take_time === null, takerRow3);

  // ---------------- 未送达申诉 ----------------
  title('4.5 POST /api/task/rejectFinish 雇主提交未送达申诉');
  const t4 = await api('POST', '/api/task/createOrder', {
    receiverName: '申诉收件人', receiverPhone: '13900139013', deliverAddress: '西区7号楼',
    timeLimitMin: 30, reward: 6, img1: '/uploads/test/g4.jpg'
  }, adminToken);
  check('申诉用任务发布并支付成功', t4.code === 200, t4);
  const take4 = await api('POST', '/api/task/take', { taskId: t4.data.taskId }, takerToken);
  check('跑腿员接单成功', take4.code === 200, take4);
  const submit3 = await api('POST', '/api/task/submitFinish', {
    taskId: t4.data.taskId, deliveryImages: ['/uploads/test/d_cover.jpg']
  }, takerToken);
  check('提交送达成功（status=2）', submit3.code === 200, submit3);
  const rejectNoTag = await api('POST', '/api/task/rejectFinish', { taskId: t4.data.taskId, tags: [] }, adminToken);
  check('未勾选标签被拦截', rejectNoTag.code === 400, rejectNoTag);
  const rejectCover = await api('POST', '/api/task/rejectFinish', {
    taskId: t4.data.taskId, tags: [4], otherText: '包裹被送到了隔壁楼栋，需要重新配送'
  }, adminToken);
  check('POST /api/task/rejectFinish（选其他需填写原因）',
    rejectCover.code === 200 && rejectCover.data.autoConfirmBlocked === true, rejectCover);
  const row4 = (await db.query('SELECT status, is_disputed FROM tasks WHERE id = ?', [t4.data.taskId]))[0];
  check('申诉后任务仍为待雇主确认且已打申诉标记',
    Number(row4.status) === 2 && Number(row4.is_disputed) === 1, row4);
  mark('POST /api/task/rejectFinish');

  // ---------------- 超时送达扣酬金 ----------------
  title('4.6 POST /api/task/deductLateReward 超时送达扣酬金');
  const t5 = await api('POST', '/api/task/createOrder', {
    receiverName: '超时收件人', receiverPhone: '13900139014', deliverAddress: '南区1号楼',
    timeLimitMin: 1, reward: 10, img1: '/uploads/test/g5.jpg'
  }, adminToken);
  check('超时用任务发布并支付成功', t5.code === 200, t5);
  const take5 = await api('POST', '/api/task/take', { taskId: t5.data.taskId }, takerToken);
  check('跑腿员接单成功', take5.code === 200, take5);
  // 把接单时间往前拨 5 分钟，制造「超过限时才送达」
  await db.execute('UPDATE tasks SET take_time = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [t5.data.taskId]);
  const sub5 = await api('POST', '/api/task/submitFinish', {
    taskId: t5.data.taskId, deliveryImages: ['/uploads/test/d_late.jpg']
  }, takerToken);
  check('超时后提交送达成功（status=2）', sub5.code === 200, sub5);
  const deduct5 = await api('POST', '/api/task/deductLateReward', { taskId: t5.data.taskId }, adminToken);
  check('POST /api/task/deductLateReward（10 元的 5% 正好等于 0.5 元下限）',
    deduct5.code === 200 && Number(deduct5.data.deduct) === 0.5 && Number(deduct5.data.reward) === 9.5, deduct5);
  mark('POST /api/task/deductLateReward');

  // ---------------- 恶意超时投诉（直达管理员） ----------------
  title('4.7 POST /api/task/reportLateTaker 恶意超时投诉');
  const t6 = await api('POST', '/api/task/createOrder', {
    receiverName: '恶意超时收件人', receiverPhone: '13900139016', deliverAddress: '南区2号楼',
    timeLimitMin: 1, reward: 8, img1: '/uploads/test/g6.jpg'
  }, adminToken);
  check('投诉用任务发布并支付成功', t6.code === 200, t6);
  const take6 = await api('POST', '/api/task/take', { taskId: t6.data.taskId }, takerToken);
  check('跑腿员接单成功', take6.code === 200, take6);
  // 把接单时间往前拨 20 分钟：任务已超过 1 分钟限时
  await db.execute('UPDATE tasks SET take_time = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE id = ?', [t6.data.taskId]);

  const report6 = await api('POST', '/api/task/reportLateTaker', {
    taskId: t6.data.taskId, reason: '接单人恶意拖延'
  }, adminToken);
  check('雇主举报接单人恶意超时成功', report6.code === 200, report6);
  mark('POST /api/task/reportLateTaker');

  const report6Row = (await db.query('SELECT report_type FROM report WHERE task_id = ?', [t6.data.taskId]))[0];
  check('投诉已落库且类型为2（恶意超时投诉）',
    !!report6Row && Number(report6Row.report_type) === 2, report6Row);

  const reportByTaker = await api('POST', '/api/task/reportLateTaker', { taskId: t6.data.taskId }, takerToken);
  check('非雇主提交投诉被拒绝（403）', reportByTaker.code === 403, reportByTaker);

  // 未超时的进行中任务不允许投诉
  const t7 = await api('POST', '/api/task/createOrder', {
    receiverName: '未超时收件人', receiverPhone: '13900139017', deliverAddress: '南区3号楼',
    timeLimitMin: 60, reward: 3, img1: '/uploads/test/g7.jpg'
  }, adminToken);
  check('未超时用任务发布并支付成功', t7.code === 200, t7);
  const take7 = await api('POST', '/api/task/take', { taskId: t7.data.taskId }, takerToken);
  check('跑腿员接单成功（未超时任务）', take7.code === 200, take7);
  const report7 = await api('POST', '/api/task/reportLateTaker', { taskId: t7.data.taskId }, adminToken);
  check('尚未超时的任务无法投诉（409）', report7.code === 409, report7);

  // ---------------- 管理员封禁管理 ----------------
  title('4.8 管理员封禁管理（列表 / 封禁 / 加时 / 解封）');
  const takerUser = (await db.query('SELECT id, account_no FROM users WHERE phone = ?', ['13800138002']))[0];

  const banList0 = await api('GET', '/api/admin/banList?page=1&pageSize=10', undefined, adminToken);
  check('GET /api/admin/banList 返回封禁列表', banList0.code === 200 && Array.isArray(banList0.data.list), banList0);
  mark('GET /api/admin/banList');

  const ban1 = await api('POST', '/api/admin/banUser', {
    userId: takerUser.id, durationType: '5m', reason: '恶意超时（覆盖测试）'
  }, adminToken);
  check('POST /api/admin/banUser 封禁5分钟成功',
    ban1.code === 200 && Number(ban1.data.banRemainSeconds) > 0 && ban1.data.isExtension === false, ban1);
  mark('POST /api/admin/banUser');

  const banList1 = await api('GET', `/api/admin/banList?keyword=${takerUser.account_no}`, undefined, adminToken);
  check('搜索账号ID可定位被封禁人',
    banList1.code === 200 && banList1.data.list.length === 1
      && Number(banList1.data.list[0].banRemainSeconds) > 0, banList1);

  const banBad = await api('POST', '/api/admin/banUser', {
    userId: takerUser.id, durationType: 'custom',
    custom: { year: '', month: '', day: '', hour: '', minute: '', second: '' }
  }, adminToken);
  check('自定义时长全为空时被拒绝（400）', banBad.code === 400, banBad);

  const ban2 = await api('POST', '/api/admin/banUser', {
    userId: takerUser.id, durationType: 'custom', custom: { minute: 1, second: 30 }
  }, adminToken);
  check('自定义时长加时成功（1分30秒，isExtension=true）',
    ban2.code === 200 && ban2.data.isExtension === true && Number(ban2.data.banRemainSeconds) > 300, ban2);

  const adminSelf = (await db.query('SELECT id FROM users WHERE phone = ?', ['13800138001']))[0];
  const banAdmin = await api('POST', '/api/admin/banUser', { userId: adminSelf.id, durationType: '5m' }, adminToken);
  check('管理员账号不可被封禁（403）', banAdmin.code === 403, banAdmin);

  const banNoAuth = await api('GET', '/api/admin/banList', undefined, takerToken);
  check('普通用户访问封禁接口被拒绝（403）', banNoAuth.code === 403, banNoAuth);

  const unban1 = await api('POST', '/api/admin/unbanUser', { userId: takerUser.id }, adminToken);
  check('POST /api/admin/unbanUser 解封成功', unban1.code === 200, unban1);
  mark('POST /api/admin/unbanUser');

  const unbanAgain = await api('POST', '/api/admin/unbanUser', { userId: takerUser.id }, adminToken);
  check('重复解封被拦截（409）', unbanAgain.code === 409, unbanAgain);

  const banList2 = await api('GET', `/api/admin/banList?keyword=${takerUser.account_no}`, undefined, adminToken);
  // 新行为：搜索会同时命中「已封禁」与「未封禁」用户（未封禁的也能直接封禁），
  //         所以解封后不是从列表里消失，而是以 isBanned=false 的未封禁状态出现
  check('解封后搜索到的是未封禁状态',
    banList2.code === 200 && banList2.data.list.length === 1
    && banList2.data.list[0].isBanned === false && banList2.data.list[0].banStatus === 0, banList2);
  const banListDefault = await api('GET', '/api/admin/banList?page=1&pageSize=50', undefined, adminToken);
  check('解封后不再出现在「当前封禁名单」中',
    banListDefault.code === 200
    && !banListDefault.data.list.some((row) => row.userId === takerUser.id), banListDefault.data.list);

  // ---------------- 管理员直接修改用户资料 ----------------
  title('4.9 管理员修改用户资料（昵称 / 姓名 / 手机号 / 学号 / 校园认证状态 / 头像）');
  const editTarget = (await db.query(
    'SELECT id, nickname, name, phone, student_id FROM users WHERE phone = ?', ['13800138002']
  ))[0];

  // 1) 管理员用户列表下发完整手机号（便于核对身份 / 联系当事人）
  const userListFull = await api('GET', '/api/admin/userList?page=1&pageSize=50', undefined, adminToken);
  const targetRow = (userListFull.data.list || []).find((row) => row.userId === editTarget.id);
  check('管理员用户列表下发完整手机号',
    userListFull.code === 200 && !!targetRow && targetRow.phone === editTarget.phone, targetRow);

  // 2) 修改昵称 / 姓名 / 校园认证状态 / 头像
  //    注意：该账号在 smokeTest 中已通过校园认证（is_campus_audit=2），
  //    这里改成「已驳回(3)」才会产生真实变更，用于验证认证状态也能被管理员直接改写
  const edit1 = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id,
    nickname: '管理员改的昵称',
    name: '管理员改的姓名',
    isCampusAudit: 3,
    avatar: '/uploads/test/admin-set-avatar.jpg'
  }, adminToken);
  check('管理员修改昵称/姓名/认证状态/头像成功',
    edit1.code === 200 && Array.isArray(edit1.data.changes) && edit1.data.changes.length >= 4, edit1);
  mark('POST /api/admin/updateUser');

  const editedRow = (await db.query(
    'SELECT nickname, name, is_campus_audit, avatar, is_avatar_audit FROM users WHERE id = ?', [editTarget.id]
  ))[0];
  check('修改已落库（昵称/姓名/认证状态/头像审核=通过）',
    editedRow.nickname === '管理员改的昵称' && editedRow.name === '管理员改的姓名'
    && Number(editedRow.is_campus_audit) === 3 && editedRow.avatar === '/uploads/test/admin-set-avatar.jpg'
    && Number(editedRow.is_avatar_audit) === 2, editedRow);

  // 3) 修改后自动推送站内消息
  const editMsg = (await db.query(
    'SELECT title, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1', [editTarget.id]
  ))[0];
  check('修改后自动推送「账号信息已被管理员修改」站内消息',
    !!editMsg && editMsg.title === '账号信息已被管理员修改'
    && editMsg.content.indexOf('昵称') >= 0 && editMsg.content.indexOf('校园认证状态') >= 0, editMsg);

  // 3.1) 再改回「审核通过」，验证认证状态可双向改写
  const editBack = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id, isCampusAudit: 2
  }, adminToken);
  const editBackRow = (await db.query('SELECT is_campus_audit FROM users WHERE id = ?', [editTarget.id]))[0];
  check('管理员可将校园认证状态改回「审核通过」',
    editBack.code === 200 && Number(editBackRow.is_campus_audit) === 2, editBackRow);

  // 4) 手机号唯一性：改成管理员已占用的手机号必须被拒绝
  const editPhoneDup = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id, phone: '13800138001'
  }, adminToken);
  check('改成已被占用的手机号被拒绝（409）', editPhoneDup.code === 409, editPhoneDup);

  // 5) 防提权红线：不允许把任何账号的学号改成管理员白名单学号
  const editAdminStudent = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id, studentId: '20240001'
  }, adminToken);
  check('学号不允许占用管理员白名单学号（403）', editAdminStudent.code === 403, editAdminStudent);

  // 6) 管理员账号自身的学号被锁定不可改
  const adminSelfRow = (await db.query('SELECT id FROM users WHERE phone = ?', ['13800138001']))[0];
  const editAdminSelf = await api('POST', '/api/admin/updateUser', {
    userId: adminSelfRow.id, studentId: '20240099'
  }, adminToken);
  check('管理员账号学号被锁定（403）', editAdminSelf.code === 403, editAdminSelf);

  // 7) 没有任何实际变化时被拦截，避免产生无意义的「资料已被修改」通知
  const editNoChange = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id, nickname: '管理员改的昵称'
  }, adminToken);
  check('没有任何修改时被拦截（409）', editNoChange.code === 409, editNoChange);

  // 8) 普通用户调用该接口被拒绝（越权校验）
  const editNoAuth = await api('POST', '/api/admin/updateUser', {
    userId: editTarget.id, nickname: '越权改昵称'
  }, takerToken);
  check('普通用户调用修改接口被拒绝（403）', editNoAuth.code === 403, editNoAuth);

  // ---------------- 支付接口 ----------------
  title('5. 支付接口（状态查询 + 回调验签）');
  const paidTask = (await db.query(
    'SELECT task_id FROM payments WHERE user_id = (SELECT id FROM users WHERE phone = ?) ORDER BY id DESC LIMIT 1',
    ['13800138001']
  ))[0];
  const queryStatus = await api('GET', `/api/pay/queryStatus/${paidTask.task_id}`, undefined, adminToken);
  check('GET /api/pay/queryStatus/:taskId', queryStatus.code === 200 && queryStatus.data.paid === true, queryStatus);
  mark('GET /api/pay/queryStatus/:taskId');

  const otherQuery = await api('GET', `/api/pay/queryStatus/${paidTask.task_id}`, undefined, takerToken);
  check('他人订单支付状态不可查询（403）', otherQuery.code === 403, otherQuery);

  const notifyResp = await fetch(`${BASE}/api/pay/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Wechatpay-Signature': 'forged' },
    body: JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { ciphertext: 'x' } })
  });
  const notifyBody = await notifyResp.json().catch(() => ({}));
  check('POST /api/pay/notify 伪造签名被拒绝（401）',
    notifyResp.status === 401 && notifyBody.code === 'FAIL', { status: notifyResp.status, notifyBody });
  mark('POST /api/pay/notify');
  // ---------------- 我的审核记录 / 我的申诉记录 ----------------
  title('6. 我的审核记录 / 我的申诉记录');
  const myAudit = await api('GET', '/api/audit/myList?page=1&pageSize=10', undefined, adminToken);
  check('GET /api/audit/myList', myAudit.code === 200 && Array.isArray(myAudit.data.list), myAudit);
  mark('GET /api/audit/myList');

  const myAppeal = await api('GET', '/api/appeal/myList?page=1&pageSize=10', undefined, takerToken);
  check('GET /api/appeal/myList', myAppeal.code === 200 && Array.isArray(myAppeal.data.list), myAppeal);
  mark('GET /api/appeal/myList');

  // ---------------- 消息中心 ----------------
  title('7. 消息中心（列表 + 一键已读）');
  const msgList = await api('GET', '/api/message/list?page=1&pageSize=10', undefined, adminToken);
  check('GET /api/message/list', msgList.code === 200 && Array.isArray(msgList.data.list), msgList);
  mark('GET /api/message/list');

  const unreadBefore = Number(msgList.data.unreadCount || 0);
  const readAll = await api('POST', '/api/message/readAll', {}, adminToken);
  check('POST /api/message/readAll', readAll.code === 200, readAll);
  mark('POST /api/message/readAll');
  const infoAfterRead = await api('GET', '/api/user/info', undefined, adminToken);
  check('一键已读后未读数归零', Number(infoAfterRead.data.unreadCount) === 0, {
    before: unreadBefore, after: infoAfterRead.data.unreadCount
  });

  // ---------------- 忘记密码重置 ----------------
  title('8. POST /api/user/resetPassword 忘记密码重置');
  const targetPhone = '13800138012';
  const targetUser = (await db.query('SELECT id FROM users WHERE phone = ?', [targetPhone]))[0];
  if (!targetUser) {
    const sms0 = await api('POST', '/api/user/sendSmsCode', { phone: targetPhone });
    await api('POST', '/api/user/register', {
      phone: targetPhone, password: 'abc123456', smsCode: sms0.data.code,
      name: '重置测试', studentId: '20240012', nickname: '重置测试'
    });
  }

  // 直接写入一条验证码，避免触发「同一手机号60秒内最多1条」的发送限流
  await db.execute(
    'INSERT INTO sms_code (phone, code, expire_time) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
    [targetPhone, '654321']
  );
  const reset = await api('POST', '/api/user/resetPassword',
    { phone: targetPhone, smsCode: '654321', newPassword: 'newpass123' });
  check('POST /api/user/resetPassword 重置成功', reset.code === 200, reset);
  mark('POST /api/user/resetPassword');

  const loginNewPwd = await login(targetPhone, 'newpass123');
  check('新密码可正常登录', loginNewPwd.code === 200, loginNewPwd);
  const loginOldPwd = await login(targetPhone, 'abc123456');
  check('旧密码已失效', loginOldPwd.code !== 200, loginOldPwd);

  const usedCode = await api('POST', '/api/user/resetPassword',
    { phone: targetPhone, smsCode: '654321', newPassword: 'another123' });
  check('验证码使用一次后立即作废', usedCode.code === 400, usedCode);

  // 还原为测试统一密码，方便重复执行
  await db.execute(
    'INSERT INTO sms_code (phone, code, expire_time) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
    [targetPhone, '111222']
  );
  const restore = await api('POST', '/api/user/resetPassword',
    { phone: targetPhone, smsCode: '111222', newPassword: 'abc123456' });
  check('密码已还原为统一测试密码', restore.code === 200, restore);

  // ---------------- 管理员重置用户登录密码 ----------------
  // 注意：重置密码会把该用户所有设备踢下线，因此放在所有依赖 takerToken 的用例之后
  title('8.1 POST /api/admin/resetUserPassword 管理员重置用户密码');
  const resetTarget = (await db.query('SELECT id FROM users WHERE phone = ?', ['13800138002']))[0];

  // 1) 自动生成随机密码
  const pwdAuto = await api('POST', '/api/admin/resetUserPassword', { userId: resetTarget.id }, adminToken);
  check('管理员重置密码（自动生成 8 位随机密码）',
    pwdAuto.code === 200 && /^[A-Za-z0-9]{8}$/.test(pwdAuto.data.password || '')
    && pwdAuto.data.autoGenerated === true, pwdAuto);
  mark('POST /api/admin/resetUserPassword');

  const loginByGenerated = await login('13800138002', pwdAuto.data.password, 'coverage-device-pwd');
  check('用新密码登录成功', loginByGenerated.code === 200, loginByGenerated);

  const oldPwdLogin = await login('13800138002', 'abc123456', 'coverage-device-old');
  check('重置后旧密码立即失效', oldPwdLogin.code !== 200, oldPwdLogin);

  // 2) 手动指定的密码长度非法时被拒绝
  const pwdBad = await api('POST', '/api/admin/resetUserPassword', {
    userId: resetTarget.id, newPassword: '123'
  }, adminToken);
  check('手动指定过短密码被拒绝（400）', pwdBad.code === 400, pwdBad);

  // 3) 手动指定密码；同时验证「错误次数清零 + 登录锁定解除 + 设备标识清空」
  await db.execute(
    'UPDATE users SET login_fail_count = 5, login_lock_time = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ?',
    [resetTarget.id]
  );
  const pwdManual = await api('POST', '/api/admin/resetUserPassword', {
    userId: resetTarget.id, newPassword: 'abc123456'
  }, adminToken);
  check('管理员手动指定密码重置成功（顺带还原测试统一密码）',
    pwdManual.code === 200 && pwdManual.data.autoGenerated === false
    && pwdManual.data.password === 'abc123456', pwdManual);

  const resetRow = (await db.query(
    'SELECT login_fail_count, login_lock_time, login_device_id FROM users WHERE id = ?', [resetTarget.id]
  ))[0];
  check('重置后错误次数清零、登录锁定解除、设备标识清空（旧 token 失效）',
    Number(resetRow.login_fail_count) === 0 && resetRow.login_lock_time === null
    && (resetRow.login_device_id || '') === '', resetRow);

  const loginRestored = await login('13800138002', 'abc123456', 'coverage-device');
  check('被锁定的账号重置后可直接登录', loginRestored.code === 200, loginRestored);

  // 4) 越权校验：普通用户不能调用该接口
  const pwdNoAuth = await api('POST', '/api/admin/resetUserPassword',
    { userId: resetTarget.id }, loginRestored.data.accessToken);
  check('普通用户调用重置密码接口被拒绝（403）', pwdNoAuth.code === 403, pwdNoAuth);

  // ---------------- 账号注销（用户自助 + 管理员操作） ----------------
  title('8.2 账号注销（POST /api/user/deactivate + POST /api/admin/deactivateUser）');
  const selfPhone = '13800138031';

  /**
   * 造一个一次性注销测试账号
   * 直接写库一条验证码，避开「同一手机号60秒内最多1条」的发送限流；
   * 若该手机号已被占用（重复执行脚本），则直接复用已存在的账号。
   */
  const mkUser = async (phone, studentId) => {
    await db.execute(
      'INSERT INTO sms_code (phone, code, expire_time) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [phone, '654321']
    );
    await api('POST', '/api/user/register', {
      phone, password: 'abc123456', smsCode: '654321',
      name: '注销测试', studentId, nickname: '注销测试', deviceId: `dev-${phone}`
    });
    return (await db.query('SELECT * FROM users WHERE phone = ? AND deactivated_at IS NULL', [phone]))[0] || null;
  };

  const selfDevice = `dev-${selfPhone}`;
  const selfUser = await mkUser(selfPhone, '20240031');
  check('注销测试账号注册成功', !!selfUser, selfUser && selfUser.id);

  const selfLogin = await login(selfPhone, 'abc123456', selfDevice);
  check('注销测试账号登录成功', selfLogin.code === 200, selfLogin);
  const selfToken = selfLogin.data.accessToken;

  // 1) 密码错误时拒绝注销
  const deactivateWrongPwd = await api('POST', '/api/user/deactivate',
    { password: 'wrong-password' }, selfToken, selfDevice);
  check('注销时登录密码错误被拒绝（400）', deactivateWrongPwd.code === 400, deactivateWrongPwd);

  // 2) 密码正确 -> 注销成功
  const deactivateSelf = await api('POST', '/api/user/deactivate',
    { password: 'abc123456' }, selfToken, selfDevice);
  check('POST /api/user/deactivate 用户自助注销成功', deactivateSelf.code === 200, deactivateSelf);
  mark('POST /api/user/deactivate');

  // 3) 注销后旧 token 立即失效
  const selfAfter = await api('GET', '/api/user/info', undefined, selfToken, selfDevice);
  check('注销后旧 access_token 立即失效（401）', selfAfter.code === 401, selfAfter);

  // 4) 注销后按账号编号也无法登录
  const selfLoginAgain = await login(selfUser.account_no, 'abc123456', selfDevice);
  check('注销后账号无法再登录（423）', selfLoginAgain.code === 423, selfLoginAgain);

  // 5) 数据库落库结果：手机号 / 学号释放、密码与隐私资料清空、旧设备标识失效
  const selfRow = (await db.query(
    'SELECT phone, student_id, password_hash, name, nickname, avatar, campus_cert_img,'
    + ' deactivated_at, login_device_id, invite_code, is_campus_audit FROM users WHERE id = ?',
    [selfUser.id]
  ))[0];
  check('注销后手机号 / 学号被释放为占位值（可重新注册）',
    selfRow.phone !== selfPhone && selfRow.student_id !== '20240031', selfRow);
  check('注销后密码哈希被改写为不可用串（数据库无明文密码）',
    String(selfRow.password_hash).indexOf('DEACTIVATED#') === 0, selfRow.password_hash);
  check('注销后隐私资料清空（姓名/昵称改为字典文案）',
    selfRow.avatar === '' && selfRow.campus_cert_img === ''
    && selfRow.name === '已注销用户' && selfRow.nickname === '已注销用户', selfRow);
  check('注销后设备标识清空并记录注销时间',
    (selfRow.login_device_id || '') === '' && !!selfRow.deactivated_at, selfRow);

  // 6) 手机号 / 学号释放后，可被新账号重新注册使用
  const reusedUser = await mkUser(selfPhone, '20240031');
  check('注销后手机号与学号可被新账号重新注册使用',
    !!reusedUser && reusedUser.id !== selfUser.id, reusedUser);

  // 7) 管理员注销任意普通用户
  const adminDeactivate = await api('POST', '/api/admin/deactivateUser',
    { userId: reusedUser.id }, adminToken);
  check('POST /api/admin/deactivateUser 管理员注销用户成功', adminDeactivate.code === 200, adminDeactivate);
  mark('POST /api/admin/deactivateUser');

  const reusedRow = (await db.query(
    'SELECT deactivated_at, phone FROM users WHERE id = ?', [reusedUser.id]
  ))[0];
  check('管理员注销后账号已标记注销时间且手机号被释放',
    !!reusedRow.deactivated_at && reusedRow.phone !== selfPhone, reusedRow);

  // 8) 越权与边界：普通用户不可注销他人、管理员账号不可被注销、管理员不可注销自己
  const deactivateNoAuth = await api('POST', '/api/admin/deactivateUser',
    { userId: resetTarget.id }, loginRestored.data.accessToken);
  check('普通用户调用管理端注销接口被拒绝（403）', deactivateNoAuth.code === 403, deactivateNoAuth);

  const deactivateAdmin = await api('POST', '/api/admin/deactivateUser',
    { userId: adminSelfRow.id }, adminToken);
  check('管理员账号不可被注销（403）', deactivateAdmin.code === 403, deactivateAdmin);

  const deactivateMissing = await api('POST', '/api/admin/deactivateUser',
    { userId: 99999999 }, adminToken);
  check('注销不存在的用户被拒绝（400）', deactivateMissing.code === 400, deactivateMissing);

  const deactivateBadId = await api('POST', '/api/admin/deactivateUser',
    { userId: 0 }, adminToken);
  check('注销参数不合法被拒绝（400）', deactivateBadId.code === 400, deactivateBadId);

  // ---------------- 管理员删除任务（软删除） ----------------
  title('8.3 POST /api/admin/deleteTask 管理员删除任务（软删除 + 冻结流转）');
  // 复用 4.7 发布的「进行中」任务 t7：它同时出现在管理员的「我的发布」和跑腿员的「我的任务」中
  const delTaskId = t7.data.taskId;
  const delOrderNo = (await db.query('SELECT order_no FROM tasks WHERE id = ?', [delTaskId]))[0].order_no;

  const pubBefore = await api('GET', '/api/task/myPublish?page=1&pageSize=50', undefined, adminToken);
  check('删除前任务在雇主的「我的发布」列表中',
    pubBefore.code === 200 && pubBefore.data.list.some((t) => t.id === delTaskId), pubBefore.data.total);
  const takeBefore = await api('GET', '/api/task/myTake?page=1&pageSize=50', undefined, takerToken);
  check('删除前任务在接单人的「我的任务」列表中',
    takeBefore.code === 200 && takeBefore.data.list.some((t) => t.id === delTaskId), takeBefore.data.total);

  // 1) 越权校验：普通用户调用删除接口必须被拒绝（权限只认后端学号白名单）
  const delNoAuth = await api('POST', '/api/admin/deleteTask',
    { taskId: delTaskId }, loginRestored.data.accessToken);
  check('普通用户调用删除任务接口被拒绝（403）', delNoAuth.code === 403, delNoAuth);

  // 2) 参数校验
  const delBadId = await api('POST', '/api/admin/deleteTask', { taskId: 0 }, adminToken);
  check('删除任务参数不合法被拒绝（400）', delBadId.code === 400, delBadId);

  // 3) 管理员删除成功
  const delOk = await api('POST', '/api/admin/deleteTask',
    { taskId: delTaskId, reason: '任务内容涉嫌违规，管理员下架' }, adminToken);
  check('管理员删除任务成功', delOk.code === 200 && delOk.data.orderNo === delOrderNo, delOk);
  mark('POST /api/admin/deleteTask');

  // 4) 重复删除被拦截（防连点幂等 + 乐观锁）
  const delAgain = await api('POST', '/api/admin/deleteTask', { taskId: delTaskId }, adminToken);
  check('重复删除同一任务被拦截（409）', delAgain.code === 409, delAgain);

  // 5) 删除后：任务从「我的发布 / 我的任务 / 任务大厅」全部消失
  const pubAfter = await api('GET', '/api/task/myPublish?page=1&pageSize=50', undefined, adminToken);
  check('删除后任务不再出现在「我的发布」',
    !pubAfter.data.list.some((t) => t.id === delTaskId), pubAfter.data.list.length);
  const takeAfter = await api('GET', '/api/task/myTake?page=1&pageSize=50', undefined, takerToken);
  check('删除后任务不再出现在「我的任务」',
    !takeAfter.data.list.some((t) => t.id === delTaskId), takeAfter.data.list.length);
  const hallAfter = await api('GET', '/api/task/list?page=1&pageSize=50', undefined, takerToken);
  check('删除后任务不再出现在任务大厅',
    !hallAfter.data.list.some((t) => t.id === delTaskId), hallAfter.data.list.length);

  // 6) 数据保留：列表隐藏但详情仍可打开（账单 / 旧链接点进来能看到下架提示）
  const delDetail = await api('GET', `/api/task/${delTaskId}`, undefined, adminToken);
  check('已删除任务详情仍可查看且标记 isDeleted',
    delDetail.code === 200 && delDetail.data.task.isDeleted === true, delDetail);
  check('已删除任务的全部操作入口被冻结',
    Object.keys(delDetail.data.task.actions).every((key) => delDetail.data.task.actions[key] === false),
    delDetail.data.task.actions);
  check('管理员查看已删除任务可见删除原因',
    delDetail.data.task.deleteReason === '任务内容涉嫌违规，管理员下架', delDetail.data.task.deleteReason);
  check('管理员查看已删除任务不再显示删除入口',
    delDetail.data.task.actions.canDeleteTask === false, delDetail.data.task.actions.canDeleteTask);

  const delDetailTaker = await api('GET', `/api/task/${delTaskId}`, undefined, takerToken);
  check('普通用户查看已删除任务看不到删除原因',
    delDetailTaker.code === 200 && delDetailTaker.data.task.deleteReason === '',
    delDetailTaker.data.task.deleteReason);

  // 7) 流转冻结：已删除任务不能再被接单 / 提交完成
  //    说明：接单接口自带 2 秒防连点幂等窗口，4.7 节刚用同一账号接过这条任务，
  //    这里先等过窗口，确保命中的是「任务已被管理员删除」而不是「请勿重复提交」
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const delTake = await api('POST', '/api/task/take', { taskId: delTaskId }, takerToken);
  check('已删除任务无法被接单（409）',
    delTake.code === 409 && delTake.msg === '该任务已被管理员删除，无法继续操作', delTake);
  const delFinish = await api('POST', '/api/task/submitFinish',
    { taskId: delTaskId, deliveryImages: ['/uploads/test/del-finish.jpg'] }, takerToken);
  check('已删除任务无法提交送达（409）',
    delFinish.code === 409 && delFinish.msg === '该任务已被管理员删除，无法继续操作', delFinish);

  // 8) 删除后自动推送站内消息：雇主与接单人各收到一条
  const ownerMsg = await api('GET', '/api/message/list?page=1&pageSize=50', undefined, adminToken);
  check('删除任务后雇主收到站内消息',
    ownerMsg.data.list.some((m) => m.title === '任务已被管理员删除' && m.content.indexOf(delOrderNo) >= 0),
    ownerMsg.data.total);
  const takerMsg = await api('GET', '/api/message/list?page=1&pageSize=50', undefined, takerToken);
  check('删除任务后接单人收到站内消息',
    takerMsg.data.list.some((m) => m.title === '任务已被管理员删除' && m.content.indexOf(delOrderNo) >= 0),
    takerMsg.data.total);

  // 9) 删除「待接单」任务自动退费
  //    直接造数据（而不是走发布接口），避免触发发布接口「1 分钟 5 次」的限流影响用例稳定性
  const refundIns = await db.execute(
    `INSERT INTO tasks (user_id, receiver_name, receiver_phone, deliver_address, time_limit_min,
                        remark, reward, service_fee, status, publish_time, order_no)
     VALUES (?, '退费收件人', '13900139019', '南区5号楼', 60, '删除待接单任务自动退费测试', 5.00, 0.10, 0, NOW(), ?)`,
    [adminSelfRow.id, 'GCPT_TMP_REFUND']
  );
  const refundTaskId = refundIns.insertId;
  await db.execute("UPDATE tasks SET order_no = CONCAT('GCPT', LPAD(id, 6, '0')) WHERE id = ?", [refundTaskId]);
  await db.execute(
    `INSERT INTO payments (user_id, task_id, out_trade_no, total_fee, pay_type, status)
     VALUES (?, ?, ?, 0.10, 1, 1)`,
    [adminSelfRow.id, refundTaskId, `TMP_REFUND_${refundTaskId}`]
  );

  const delRefund = await api('POST', '/api/admin/deleteTask',
    { taskId: refundTaskId, reason: '违规任务下架' }, adminToken);
  check('删除待接单任务时信息服务费自动原路退回',
    delRefund.code === 200 && delRefund.data.refund.refunded === true
      && Number(delRefund.data.refund.amount) === 0.1, delRefund);
  check('删除待接单任务的提示语包含退费结果',
    delRefund.code === 200 && delRefund.msg.indexOf('原路退回') >= 0, delRefund.msg);

  const refundPaymentRow = (await db.query(
    'SELECT status, refund_fee, refund_time FROM payments WHERE task_id = ?', [refundTaskId]
  ))[0];
  check('退费后支付流水置为「已退款」并写入退款金额与时间',
    Number(refundPaymentRow.status) === 3 && Number(refundPaymentRow.refund_fee) === 0.1
      && !!refundPaymentRow.refund_time, refundPaymentRow);

  const refundTaskRow = (await db.query('SELECT is_refunded FROM tasks WHERE id = ?', [refundTaskId]))[0];
  check('退费后任务被标记为已退费', Number(refundTaskRow.is_refunded) === 1, refundTaskRow);

  const refundMsg = await api('GET', '/api/message/list?page=1&pageSize=50', undefined, adminToken);
  check('雇主收到「任务已删除 + 服务费已退回」站内消息',
    refundMsg.data.list.some((m) => m.title === '任务已被管理员删除'
      && m.content.indexOf('元已原路退回') >= 0),
    refundMsg.data.total);

  // 10) 非待接单任务（上面删除的 t7 是进行中）删除时不动服务费
  check('删除进行中的任务不自动退费', delOk.data.refund.refunded === false, delOk.data.refund);
  const t7PaymentRow = (await db.query('SELECT status FROM payments WHERE task_id = ?', [delTaskId]))[0];
  check('非待接单任务删除后支付流水保持「支付成功」',
    !!t7PaymentRow && Number(t7PaymentRow.status) === 1, t7PaymentRow);

  // ---------------- 审核申请：多次提交只保留最新一条 ----------------
  title('8.4 校园认证多次提交：旧申请作废不展示 + 剩余次数提示');
  const voidPhone = '13900139088';
  const voidStudentId = '20240088';
  const voidUser = await mkUser(voidPhone, voidStudentId);
  check('多次提交测试账号注册成功', !!voidUser, voidUser && voidUser.id);
  const voidLogin = voidUser
    ? await login(voidPhone, 'abc123456', 'coverage-device-void')
    : { data: null };
  const voidToken = voidLogin.data ? voidLogin.data.accessToken : null;

  const voidSubmit1 = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '作废甲', certStudentId: voidStudentId, certPhone: voidPhone,
    applyContent: '/uploads/test/void_1.jpg'
  }, voidToken);
  check('第1次校园认证提交成功并返回「剩余2次」',
    voidSubmit1.code === 200 && voidSubmit1.data && !!voidSubmit1.data.campusApply
      && voidSubmit1.data.campusApply.remainTimes === 2, voidSubmit1);

  const voidSubmit2 = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '作废乙', certStudentId: voidStudentId, certPhone: voidPhone,
    applyContent: '/uploads/test/void_2.jpg'
  }, voidToken);
  check('第2次校园认证提交成功并返回「剩余1次」',
    voidSubmit2.code === 200 && voidSubmit2.data && !!voidSubmit2.data.campusApply
      && voidSubmit2.data.campusApply.remainTimes === 1, voidSubmit2);

  const voidRow1 = (await db.query(
    'SELECT status, is_void, reject_reason FROM audit_apply WHERE id = ?', [voidSubmit1.data.applyId]
  ))[0];
  check('被覆盖的旧申请自动作废（status=3 且 is_void=1）',
    Number(voidRow1.status) === 3 && Number(voidRow1.is_void) === 1, voidRow1);

  const adminAuditList = await api(
    'GET', '/api/audit/adminList?page=1&pageSize=50&applyType=3', undefined, adminToken
  );
  const voidUserRows = adminAuditList.data.list.filter(
    (row) => row.user_id === (voidUser ? voidUser.id : -1)
  );
  check('管理员审核列表只显示该用户最新一条申请（旧申请不展示）',
    voidUserRows.length === 1 && voidUserRows[0].id === voidSubmit2.data.applyId, voidUserRows);

  const myAuditList = await api(
    'GET', '/api/audit/myList?page=1&pageSize=10&applyType=3', undefined, voidToken
  );
  check('用户自己的审核记录仍保留完整历史（2 条）',
    myAuditList.data.list.filter((row) => row.cert_student_id === voidStudentId).length === 2,
    myAuditList.data.total);

  const voidSubmit3 = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '作废丙', certStudentId: voidStudentId, certPhone: voidPhone,
    applyContent: '/uploads/test/void_3.jpg'
  }, voidToken);
  check('第3次校园认证提交成功并返回「剩余0次」',
    voidSubmit3.code === 200 && voidSubmit3.data && !!voidSubmit3.data.campusApply
      && voidSubmit3.data.campusApply.remainTimes === 0, voidSubmit3);

  const voidSubmit4 = await api('POST', '/api/audit/submit', {
    applyType: 3, certName: '作废丁', certStudentId: voidStudentId, certPhone: voidPhone,
    applyContent: '/uploads/test/void_4.jpg'
  }, voidToken);
  check('7 天内第 4 次提交被拦截（409）',
    voidSubmit4.code === 409 && voidSubmit4.msg.indexOf('7天内最多提交3次') >= 0, voidSubmit4);

  // ---------------- 汇总 ----------------
  title('9. 接口覆盖清单汇总');
  const ALL_ENDPOINTS = [
    'POST /api/user/register',
    'POST /api/user/login',
    'POST /api/user/refreshToken',
    'GET /api/user/info',
    'POST /api/user/deactivate',
    'POST /api/user/sendSmsCode',
    'POST /api/user/resetPassword',
    'POST /api/user/uploadImage',
    'POST /api/task/createOrder',
    'GET /api/task/list',
    'GET /api/task/:id',
    'POST /api/task/take',
    'POST /api/task/cancelTake',
    'POST /api/task/rejectFinish',
    'POST /api/task/deductLateReward',
    'POST /api/task/reportLateTaker',
    'POST /api/task/edit',
    'POST /api/task/adjustReward',
    'POST /api/task/submitFinish',
    'POST /api/task/confirmFinish',
    'POST /api/task/cancel',
    'POST /api/task/applyRefund',
    'GET /api/task/myPublish',
    'GET /api/task/myTake',
    'POST /api/pay/notify',
    'GET /api/pay/queryStatus/:taskId',
    'POST /api/audit/submit',
    'GET /api/audit/myList',
    'GET /api/audit/adminList',
    'POST /api/audit/handle',
    'POST /api/appeal/submit',
    'GET /api/appeal/myList',
    'GET /api/appeal/adminList',
    'POST /api/appeal/reply',
    'POST /api/report/submit',
    'GET /api/report/adminList',
    'POST /api/report/handle',
    'GET /api/message/list',
    'POST /api/message/readAll',
    'GET /api/bill/list',
    'GET /api/admin/userList',
    'POST /api/admin/updateUser',
    'POST /api/admin/resetUserPassword',
    'POST /api/admin/deactivateUser',
    'POST /api/admin/deleteTask',
    'GET /api/admin/banList',
    'POST /api/admin/banUser',
    'POST /api/admin/unbanUser'
  ];
  const MARKED_ELSEWHERE = [
    'POST /api/user/register', 'POST /api/user/sendSmsCode',
    'GET /api/task/list', 'GET /api/task/:id', 'POST /api/task/edit',
    'POST /api/task/adjustReward', 'POST /api/task/submitFinish',
    'POST /api/task/confirmFinish', 'POST /api/task/cancel',
    'POST /api/task/applyRefund', 'GET /api/task/myPublish', 'GET /api/task/myTake',
    'POST /api/audit/submit', 'GET /api/audit/adminList', 'POST /api/audit/handle',
    'POST /api/appeal/submit', 'GET /api/appeal/adminList', 'POST /api/appeal/reply',
    'POST /api/report/submit', 'GET /api/report/adminList', 'POST /api/report/handle',
    'GET /api/bill/list', 'GET /api/admin/userList'
  ];
  const allCovered = ALL_ENDPOINTS.filter(
    (e) => covered.includes(e) || MARKED_ELSEWHERE.includes(e)
  );
  ALL_ENDPOINTS.forEach((e) => {
    const done = allCovered.includes(e);
    console.log(`  ${done ? '[已覆盖]' : '[缺失]'} ${e}`);
  });
  check(`接口清单全部覆盖（${allCovered.length}/${ALL_ENDPOINTS.length}）`,
    allCovered.length === ALL_ENDPOINTS.length,
    ALL_ENDPOINTS.filter((e) => !allCovered.includes(e)));

  console.log(`\n===== 接口覆盖测试结束：通过 ${passCount} 项，失败 ${failCount} 项 =====`);
  await db.closePool();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('接口覆盖测试脚本异常：', err);
  try {
    await db.closePool();
  } catch (closeErr) {
    // 忽略关闭异常
  }
  process.exit(1);
});
