/**
 * =====================================================================
 * 定时任务行为测试脚本
 *  直接调用 src/schedule/index.js 导出的任务函数，逐条验证 6 个定时任务的真实行为：
 *   1. 限时任务超时自动扣减 5% 酬金（任务不取消、不封禁，可继续送达）
 *   1.5 雇主举报接单人恶意超时（投诉直达管理员）
 *   2. 管理员封禁生效 + 封禁到期自动解禁
 *   3. 待雇主确认超 2 小时自动确认完成 + 自动记账（幂等）
 *   4. 登录锁定到期自动解锁
 *   5. 每日 00:00 申诉计数重置
 *   6. 每天 01:00 清理 7 天前审核驳回的图片文件
 *  运行：node scripts/scheduleTest.js   （需先启动后端服务）
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/db/db');
const jobs = require('../src/schedule');
const Task = require('../src/models/Task');
const { TASK_STATUS_ENUM } = require('../src/utils/constant');
// 新版账号体系辅助模块：注册要过图形验证码、注册后必须设密保、姓名/学号要到校园认证阶段才采集
const h = require('./_accountHelper');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

// 测试账号的手机号（注册时选填、只用于人工联系），随机生成避免与真实用户冲突
const OWNER_PHONE = h.testPhone(2001);
const TAKER_PHONE = h.testPhone(2002);
const LOCK_PHONE = h.testPhone(2003);
const TEST_PASSWORD = 'abc123456';

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

/** 统一请求方法 */
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': 'sched-device' };
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

/**
 * 保证账号存在且已完成校园认证，返回 access_token
 * 新版流程：已存在则按学号登录；不存在则「注册（图形验证码）-> 设置密保 -> 提交校园认证 -> 管理员审核通过」
 * @param {string} phone 手机号（选填项，仅用于人工联系）
 * @param {string} studentId 学号
 * @param {string} name 姓名
 * @param {string} adminToken 管理员令牌（用于审核通过）
 */
async function ensureUser(phone, studentId, name, adminToken) {
  const loginRes = await h.login(studentId, TEST_PASSWORD);
  if (loginRes.code === 200 && loginRes.data.accessToken) return loginRes.data.accessToken;

  const reg = await h.register({ phone, password: TEST_PASSWORD, nickname: name });
  if (reg.res.code !== 200) throw new Error(`注册失败：${reg.res.msg}`);
  const token = reg.res.data.accessToken;

  const setSecurity = await h.setSecurity(token);
  if (setSecurity.code !== 200) throw new Error(`设置密保失败：${setSecurity.msg}`);

  const apply = await h.submitCampusCert(token, { name, studentId, phone });
  if (apply.code === 200) {
    await h.handleAudit(adminToken, apply.data.applyId, 2);
  }
  return token;
}
async function main() {
  title('0. 准备账号（管理员 + 雇主 + 跑腿员 + 锁定测试账号）');
  const adminToken = await h.adminToken();
  check('管理员登录成功（.env 白名单管理员账号）', !!adminToken, adminToken ? '令牌已获取' : '失败');

  const ownerToken = await ensureUser(OWNER_PHONE, '20240010', '定时雇主', adminToken);
  const takerToken = await ensureUser(TAKER_PHONE, '20240011', '定时跑腿', adminToken);
  await ensureUser(LOCK_PHONE, '20240012', '锁定测试', adminToken);

  const infoOwner = await api('GET', '/api/user/info', undefined, ownerToken);
  const infoTaker = await api('GET', '/api/user/info', undefined, takerToken);
  check('雇主已完成校园认证（可发布）', infoOwner.data.canPublish === true, infoOwner.data);
  check('跑腿员已完成校园认证（可接单）', infoTaker.data.canTake === true, infoTaker.data);

  // ---------------- 1. 超时自动扣酬金（不取消任务、不封禁） ----------------
  title('1. 限时任务超时自动扣减5%酬金（任务不取消、不封禁、可继续送达）');
  const t1 = await api('POST', '/api/task/createOrder', {
    receiverName: '超时收件人', receiverPhone: '13900139010', deliverAddress: '东区9号楼',
    timeLimitMin: 5, reward: 3, img1: '/uploads/test/g1.jpg'
  }, ownerToken);
  check('限时任务发布并支付成功', t1.code === 200, t1);
  const take1 = await api('POST', '/api/task/take', { taskId: t1.data.taskId }, takerToken);
  check('跑腿员接单成功', take1.code === 200, take1);

  await db.execute('UPDATE tasks SET take_time = DATE_SUB(NOW(), INTERVAL 30 MINUTE) WHERE id = ?', [t1.data.taskId]);
  await jobs.jobTimeoutTasks();

  const row1 = (await db.query(
    'SELECT status, reward, is_late_delivery, is_late_reward_deducted, late_reward_deduct FROM tasks WHERE id = ?',
    [t1.data.taskId]
  ))[0];
  check('超时后任务仍为进行中（status=1，不再自动取消）', Number(row1.status) === TASK_STATUS_ENUM.TAKING, row1);
  check('超时后任务被标记为超时送达', Number(row1.is_late_delivery) === 1, row1);
  check('超时自动扣减5%酬金（3元×5%不足0.5按0.5，扣后2.50元）',
    Number(row1.reward) === 2.5 && Number(row1.late_reward_deduct) === 0.5, row1);
  check('扣减标记已落库（用于防重复扣款）', Number(row1.is_late_reward_deducted) === 1, row1);

  // 幂等：再跑一次定时任务不应重复扣款
  await jobs.jobTimeoutTasks();
  const row1Again = (await db.query('SELECT reward, late_reward_deduct FROM tasks WHERE id = ?', [t1.data.taskId]))[0];
  check('重复执行不重复扣酬金（幂等）',
    Number(row1Again.reward) === 2.5 && Number(row1Again.late_reward_deduct) === 0.5, row1Again);

  const takerRow = (await db.query('SELECT id, ban_take_time FROM users WHERE phone = ?', [TAKER_PHONE]))[0];
  check('系统不再自动封禁接单人（ban_take_time 为空）', takerRow.ban_take_time === null, takerRow);
  const ownerRow = (await db.query('SELECT id FROM users WHERE phone = ?', [OWNER_PHONE]))[0];

  const takerMsg = await db.query('SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND title = ?',
    [takerRow.id, '限时任务已超时，酬金已扣减']);
  check('已推送超时扣酬金消息给跑腿员', Number(takerMsg[0].total) >= 1, takerMsg[0]);
  const ownerMsg = await db.query('SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND title = ?',
    [ownerRow.id, '跑腿员已超时，酬金已自动扣减']);
  check('已推送超时扣酬金消息给雇主', Number(ownerMsg[0].total) >= 1, ownerMsg[0]);

  // 超时后仍可继续送达：两步流程（先「确认取货」把物品照片锁定为凭证，再提交送达照片）
  const pickupLate = await api('POST', '/api/task/confirmPickup', {
    taskId: t1.data.taskId,
    pickupImages: ['/uploads/test/p_late.jpg']
  }, takerToken);
  check('超时后仍可确认取货（物品照片锁定）', pickupLate.code === 200, pickupLate);
  const submitLate = await api('POST', '/api/task/submitFinish', {
    taskId: t1.data.taskId,
    deliveryImages: ['/uploads/test/d_late.jpg']
  }, takerToken);
  check('超时后仍可继续送达（提交送达成功）', submitLate.code === 200, submitLate);
  const row1Done = (await db.query('SELECT status, is_late_delivery, is_late_reward_deducted FROM tasks WHERE id = ?', [t1.data.taskId]))[0];
  check('超时送达提交后状态为待雇主确认（status=2）且不重复扣款',
    Number(row1Done.status) === TASK_STATUS_ENUM.WAIT_CONFIRM && Number(row1Done.is_late_reward_deducted) === 1, row1Done);

  // 雇主举报恶意超时：投诉直达管理员
  const lateReport = await api('POST', '/api/task/reportLateTaker', {
    taskId: t1.data.taskId, reason: '联系不上接单人'
  }, ownerToken);
  check('雇主可举报接单人恶意超时', lateReport.code === 200, lateReport);
  const lateReportRow = (await db.query('SELECT report_type, status FROM report WHERE task_id = ?', [t1.data.taskId]))[0];
  check('投诉已落库且类型为2（恶意超时投诉）',
    !!lateReportRow && Number(lateReportRow.report_type) === 2, lateReportRow);
  const lateReportAgain = await api('POST', '/api/task/reportLateTaker', { taskId: t1.data.taskId }, ownerToken);
  check('重复投诉被拦截（409）', lateReportAgain.code === 409, lateReportAgain);
  const adminMsg = await db.query('SELECT COUNT(*) AS total FROM messages WHERE title = ?', ['恶意超时投诉待处理']);
  check('投诉已直达管理员账号（管理员收到站内消息）', Number(adminMsg[0].total) >= 1, adminMsg[0]);

  // ---------------- 2. 管理员封禁生效 + 到期自动解禁 ----------------
  title('2. 接单封禁生效与到期自动解禁（封禁由管理员设置）');
  const tBan = await api('POST', '/api/task/createOrder', {
    receiverName: '封禁测试收件人', receiverPhone: '13900139014', deliverAddress: '南区5号楼',
    timeLimitMin: 30, reward: 2, img1: '/uploads/test/g5.jpg'
  }, ownerToken);
  check('封禁测试任务发布成功', tBan.code === 200, tBan);

  await db.execute("UPDATE users SET ban_take_time = DATE_ADD(NOW(), INTERVAL 10 MINUTE), ban_reason = '恶意超时' WHERE phone = ?",
    [TAKER_PHONE]);
  const takeBanned = await api('POST', '/api/task/take', { taskId: tBan.data.taskId }, takerToken);
  check('封禁期内无法接单（403）', takeBanned.code === 403, takeBanned);

  await db.execute('UPDATE users SET ban_take_time = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE phone = ?', [TAKER_PHONE]);
  await jobs.jobUnbanTake();
  const takerAfter = (await db.query('SELECT ban_take_time FROM users WHERE phone = ?', [TAKER_PHONE]))[0];
  check('封禁到期后自动解禁', takerAfter.ban_take_time === null, takerAfter);
  // ---------------- 3. 超时自动确认 + 自动记账 ----------------
  title('3. 待雇主确认超2小时自动确认完成 + 自动记账');
  const t2 = await api('POST', '/api/task/createOrder', {
    receiverName: '自动确认收件人', receiverPhone: '13900139011', deliverAddress: '西区8号楼',
    timeLimitMin: 60, reward: 6, img1: '/uploads/test/g2.jpg'
  }, ownerToken);
  check('任务发布并支付成功', t2.code === 200, t2);
  const take2 = await api('POST', '/api/task/take', { taskId: t2.data.taskId }, takerToken);
  check('跑腿员接单成功', take2.code === 200, take2);
  const pickup2 = await api('POST', '/api/task/confirmPickup', {
    taskId: t2.data.taskId,
    pickupImages: ['/uploads/test/p_auto.jpg']
  }, takerToken);
  check('确认取货成功（物品照片锁定）', pickup2.code === 200, pickup2);
  const sub2 = await api('POST', '/api/task/submitFinish', {
    taskId: t2.data.taskId,
    deliveryImages: ['/uploads/test/d_auto.jpg']
  }, takerToken);
  check('提交送达成功（status=2）', sub2.code === 200, sub2);

  await db.execute('UPDATE tasks SET submit_finish_time = DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE id = ?', [t2.data.taskId]);
  await jobs.jobAutoConfirm();

  const row2 = (await db.query('SELECT status FROM tasks WHERE id = ?', [t2.data.taskId]))[0];
  check('任务被自动确认完成（status=3）', row2.status === TASK_STATUS_ENUM.FINISHED, row2);

  const bill2 = await db.query('SELECT amount, type FROM user_bill WHERE task_id = ? AND type = 1', [t2.data.taskId]);
  check('自动生成任务收入账单', bill2.length === 1 && Number(bill2[0].amount) === 6, bill2);

  await jobs.jobAutoConfirm();
  const billAgain = await db.query('SELECT COUNT(*) AS total FROM user_bill WHERE task_id = ? AND type = 1', [t2.data.taskId]);
  check('重复执行不产生重复账单（幂等）', Number(billAgain[0].total) === 1, billAgain[0]);

  // ---------------- 3.5 未送达申诉阻断自动确认 ----------------
  title('3.5 雇主提交「未送达」申诉后不再自动确认收货');
  const t3 = await api('POST', '/api/task/createOrder', {
    receiverName: '申诉收件人', receiverPhone: '13900139013', deliverAddress: '北区6号楼',
    timeLimitMin: 60, reward: 9, img1: '/uploads/test/g3.jpg'
  }, ownerToken);
  check('申诉用任务发布并支付成功', t3.code === 200, t3);
  const take3 = await api('POST', '/api/task/take', { taskId: t3.data.taskId }, takerToken);
  check('跑腿员接单成功', take3.code === 200, take3);
  const pickup3 = await api('POST', '/api/task/confirmPickup', {
    taskId: t3.data.taskId,
    pickupImages: ['/uploads/test/p_dispute.jpg']
  }, takerToken);
  check('确认取货成功（物品照片锁定）', pickup3.code === 200, pickup3);
  const sub3 = await api('POST', '/api/task/submitFinish', {
    taskId: t3.data.taskId,
    deliveryImages: ['/uploads/test/d_dispute.jpg']
  }, takerToken);
  check('提交送达成功（status=2）', sub3.code === 200, sub3);

  const reject3 = await api('POST', '/api/task/rejectFinish', {
    taskId: t3.data.taskId, tags: [1, 2], otherText: ''
  }, ownerToken);
  check('雇主勾选标签直接发送成功', reject3.code === 200 && reject3.data.autoConfirmBlocked === true, reject3);

  // 把提交时间改到 3 小时前，模拟「已超过2小时」，再跑自动确认
  await db.execute('UPDATE tasks SET submit_finish_time = DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE id = ?', [t3.data.taskId]);
  const autoConfirmCandidates = await Task.findAutoConfirmTasks();
  check('申诉任务不会进入自动确认扫描结果',
    !autoConfirmCandidates.some((row) => row.id === t3.data.taskId), autoConfirmCandidates.length);
  await jobs.jobAutoConfirm();

  const row3 = (await db.query('SELECT status, is_disputed FROM tasks WHERE id = ?', [t3.data.taskId]))[0];
  check('申诉任务超时后仍为待雇主确认（status=2）', Number(row3.status) === TASK_STATUS_ENUM.WAIT_CONFIRM, row3);
  check('申诉标记已落库', Number(row3.is_disputed) === 1, row3);
  const bill3 = await db.query('SELECT COUNT(*) AS total FROM user_bill WHERE task_id = ? AND type = 1', [t3.data.taskId]);
  check('申诉任务不会自动生成任务收入账单', Number(bill3[0].total) === 0, bill3[0]);

  // ---------------- 4. 登录锁定到期解锁 ----------------
  title('4. 登录锁定到期自动解锁');
  await db.execute(
    'UPDATE users SET login_fail_count = 5, login_lock_time = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE phone = ?',
    [LOCK_PHONE]
  );
  const stillLocked = await api('POST', '/api/user/login', { account: LOCK_PHONE, password: TEST_PASSWORD });
  check('锁定期内正确密码也返回锁定（423）', stillLocked.code === 423, stillLocked);

  await db.execute('UPDATE users SET login_lock_time = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE phone = ?', [LOCK_PHONE]);
  await jobs.jobUnlockLogin();

  const unlockRow = (await db.query('SELECT login_fail_count, login_lock_time FROM users WHERE phone = ?', [LOCK_PHONE]))[0];
  check('锁定到期后自动解锁并清零错误次数',
    unlockRow.login_lock_time === null && Number(unlockRow.login_fail_count) === 0, unlockRow);

  const loginAfter = await api('POST', '/api/user/login', { account: LOCK_PHONE, password: TEST_PASSWORD });
  check('解锁后可正常登录', loginAfter.code === 200, loginAfter);

  // ---------------- 5. 申诉计数重置 ----------------
  title('5. 每日00:00 申诉提交计数重置');
  let resetOk = true;
  try {
    jobs.jobResetAppealCount();
  } catch (err) {
    resetOk = false;
  }
  check('申诉计数重置任务执行成功', resetOk);
  const appealCount = await db.query('SELECT COUNT(*) AS total FROM appeals WHERE DATE(created_at) = CURDATE()');
  check('当日申诉计数按自然日统计（0点自动归零）', Number(appealCount[0].total) >= 0, appealCount[0]);
  // ---------------- 6. 清理7天前驳回图片 ----------------
  title('6. 每天01:00 清理7天前审核驳回的图片文件');
  const testDir = path.resolve(__dirname, '../uploads/test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const fileName = `rejected_${Date.now()}.jpg`;
  const filePath = path.join(testDir, fileName);
  fs.writeFileSync(filePath, 'fake-image-bytes');

  const ownerId = (await db.query('SELECT id FROM users WHERE phone = ?', [OWNER_PHONE]))[0].id;
  const inserted = await db.execute(
    `INSERT INTO audit_apply (user_id, apply_type, apply_content, status, reject_reason, created_at, updated_at)
     VALUES (?, 1, ?, 3, ?, DATE_SUB(NOW(), INTERVAL 8 DAY), DATE_SUB(NOW(), INTERVAL 8 DAY))`,
    [ownerId, `/uploads/test/${fileName}`, '测试用驳回申请']
  );
  const applyId = inserted.insertId;
  check('已造出8天前的驳回图片记录', !!applyId, applyId);

  await jobs.jobCleanRejectedImages();

  check('7天前驳回的图片文件已被删除', !fs.existsSync(filePath), filePath);
  const applyRow = (await db.query('SELECT apply_content FROM audit_apply WHERE id = ?', [applyId]))[0];
  check('失效图片引用已从数据库清空', applyRow && applyRow.apply_content === '', applyRow);

  // 清理测试数据
  await db.execute('DELETE FROM audit_apply WHERE id = ?', [applyId]);

  // 清理本次创建的测试账号（连同其任务 / 账单 / 消息），避免污染正式库；
  // 想保留账号用于手工验证时，设置环境变量 KEEP_TEST_ACCOUNTS=1 再运行
  if (process.env.KEEP_TEST_ACCOUNTS !== '1') {
    const testUsers = await db.query(
      'SELECT account_no FROM users WHERE phone IN (?, ?, ?)', [OWNER_PHONE, TAKER_PHONE, LOCK_PHONE]
    );
    const purged = await h.purgeAccounts(testUsers.map((row) => row.account_no));
    console.log(`已清理测试账号 ${purged} 个（如需保留请设置 KEEP_TEST_ACCOUNTS=1）`);
  }

  console.log(`\n===== 定时任务测试结束：通过 ${passCount} 项，失败 ${failCount} 项 =====`);
  await db.closePool();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('定时任务测试脚本异常：', err);
  try {
    await db.closePool();
  } catch (closeErr) {
    // 忽略关闭异常
  }
  process.exit(1);
});
