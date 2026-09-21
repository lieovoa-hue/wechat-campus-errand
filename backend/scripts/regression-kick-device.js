/**
 * =====================================================================
 * 回归脚本：顶号提示 + 设备登录地点 + 已删除任务拦截
 * ---------------------------------------------------------------------
 * 覆盖本次需求的三条关键规则：
 *   1) 单设备登录顶号：旧设备下一次请求必须拿到 401 + data.kicked=true，
 *      且 content 里带上「新设备名称 / 时间 / IP / 归属地」，供前端弹窗告知本人；
 *   2) 「我的 - 设备管理」每台设备都要有登录 IP 与「省-市」归属地；
 *   3) 管理员删除（下架）的任务：详情返回 isDeleted=true 且 actions 全部为 false，
 *      前端据此隐藏「立即接单」，后端 assertTaskNotDeleted 另有硬校验。
 * 用法：node scripts/regression-kick-device.js
 * =====================================================================
 */

const helper = require('./_accountHelper');
const db = require('../src/db/db');
const { MSG } = require('../src/utils/constant');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' -> ' + detail : ''));
}

/** 造一个唯一手机号（注册时选填，但填了会走唯一校验） */
function uniquePhone(seed) {
  return helper.testPhone(seed);
}

(async () => {
  // ---------- 1. 健康检查 ----------
  const health = await helper.request('GET', '/api/health');
  check('后端健康检查', health.code === 200 && health.data && health.data.status === 'ok', JSON.stringify(health.data));

  // ---------- 2. 造一个已设密保的账号（同时绑定设备 A） ----------
  const user = await helper.createUser({
    phone: uniquePhone(Date.now() % 1000000000),
    nickname: '顶号测试号',
    deviceId: 'kick-test-devA',
    deviceName: '测试机A（旧设备）'
  });
  check('创建测试账号（已设密保）', !!user.token && !!user.accountNo, user.accountNo + ' / id=' + user.userId);

  // ---------- 3. 新设备 B 登录：应触发密保解锁并被助手自动解锁，同时顶掉设备 A ----------
  const loginB = await helper.login(user.accountNo, user.password, {
    deviceId: 'kick-test-devB',
    deviceName: '测试机B（新设备）'
  });
  check('新设备登录成功（密保解锁后）', loginB.code === 200 && !!loginB.data.accessToken, loginB.code + ' ' + loginB.msg);
  const tokenB = loginB.data.accessToken;

  // ---------- 4. 旧设备 A 请求：必须拿到 401 + kick 提示 ----------
  const oldReq = await helper.request('GET', '/api/user/info', null, {
    token: user.token,
    deviceId: 'kick-test-devA'
  });
  check('旧设备令牌已被顶下线（401）', oldReq.code === 401, oldReq.code + ' ' + oldReq.msg);
  check('旧设备返回顶号标识 data.kicked=true', !!(oldReq.data && oldReq.data.kicked === true), JSON.stringify(oldReq.data));
  const kickContent = (oldReq.data && oldReq.data.content) || '';
  check('顶号提示包含新设备名称', kickContent.indexOf('测试机B（新设备）') >= 0, kickContent);
  check('顶号提示包含时间信息', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(kickContent), kickContent);
  check('顶号提示包含 IP / 归属地字段', /IP/.test(kickContent), kickContent);
  check('顶号提示带结构化字段（设备名/时间/IP）',
    !!(oldReq.data && oldReq.data.deviceName && oldReq.data.time && oldReq.data.ip !== undefined),
    JSON.stringify(oldReq.data && { d: oldReq.data.deviceName, t: oldReq.data.time, ip: oldReq.data.ip, r: oldReq.data.region }));

  // ---------- 5. 顶号提示只弹一次（已读后不再下发） ----------
  const tokenBShort = tokenB;
  const devList = await helper.request('GET', '/api/user/devices', null, { token: tokenBShort, deviceId: 'kick-test-devB' });
  check('设备列表接口可用', devList.code === 200 && Array.isArray(devList.data.list), devList.code + ' ' + devList.msg);
  const rows = (devList.data && devList.data.list) || [];
  check('设备列表返回登录 IP 字段', rows.every((r) => Object.prototype.hasOwnProperty.call(r, 'loginIp')), JSON.stringify(rows.map((r) => r.loginIp)));
  // 曾经的 Bug：注册 / 登录两处调用 finishLogin 时漏传 ip，导致 user_device.login_ip 永远是空串，
  // 「设备管理」里看不到登录 IP，顶号提示也会退化成「未知IP」。这里把「登录 IP 必须落库」钉死。
  const currentRow = rows.find((r) => r.deviceId === 'kick-test-devB');
  check('登录 IP 已落库（不能是空串）', !!(currentRow && String(currentRow.loginIp || '').trim()), JSON.stringify(currentRow && currentRow.loginIp));
  check('设备列表返回登录归属地字段（省-市）', rows.every((r) => Object.prototype.hasOwnProperty.call(r, 'loginRegion')), JSON.stringify(rows.map((r) => r.loginRegion)));
  check('设备列表包含新旧两台设备', rows.length >= 2, '共 ' + rows.length + ' 台');

  // ---------- 5.1 顶号提示不被提前消费：旧设备重复请求仍能拿到完整内容 ----------
  // 说明：前端 401 后会自动先刷新令牌再弹窗，若第一次 401 就把记录标记已读，
  //       真正弹窗时内容会退化成「未知设备 / 未知时间 / 未知地点 / 未知IP」。
  const oldReqAgain = await helper.request('GET', '/api/user/info', null, {
    token: user.token,
    deviceId: 'kick-test-devA'
  });
  const kickContentAgain = (oldReqAgain.data && oldReqAgain.data.content) || '';
  check('旧设备重复请求仍返回完整顶号提示（记录未被提前消费）',
    oldReqAgain.code === 401 && oldReqAgain.data && oldReqAgain.data.kicked === true
      && kickContentAgain.indexOf('测试机B（新设备）') >= 0,
    kickContentAgain);
  // IP 一定拿得到（服务端从 socket / XFF 取），提示里不该再出现「未知IP」
  check('顶号提示包含真实 IP（非「未知IP」）', kickContentAgain.indexOf('未知IP') < 0, kickContentAgain);
  // 归属地：本机回环地址无法解析（后端会如实标注「局域网」）；
  //          公网 IP 必须解析成「省-市」，绝不能退化成「未知地点」。
  const isLocalRun = /IP：(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(kickContentAgain);
  check('顶号提示地点解析正确（公网必须解析出省-市，局域网标注局域网）',
    isLocalRun ? kickContentAgain.indexOf('局域网') >= 0 : kickContentAgain.indexOf('未知地点') < 0,
    kickContentAgain);

  // ---------- 6. 站内消息留痕：顶号会写入一条系统消息 ----------
  const msgList = await helper.request('GET', '/api/message/list?page=1&pageSize=20', null, { token: tokenBShort, deviceId: 'kick-test-devB' });
  const msgs = (msgList.data && (msgList.data.list || msgList.data.rows)) || [];
  check('顶号写入站内消息留痕',
    msgList.code === 200 && msgs.some((m) => /登录设备的变更提醒|新设备/.test(m.title || '')),
    JSON.stringify(msgs.slice(0, 3).map((m) => m.title)));

  // ---------- 7. 已删除任务：详情 isDeleted=true 且 actions 全 false ----------
  // 前置数据固定自造，不依赖上一次运行 / 人工测试留下的脏数据。
  // 注意视角：管理员下架会顺带把信息服务费原路退回，退款后该任务的支付状态不再是「成功」，
  // 详情接口的可见性规则只放行「雇主 / 接单人」（陌生人一律 400），
  // 所以这里必须用「雇主本人」的令牌去看详情，才能命中 isDeleted 分支。
  const adminForDelete = await helper.adminToken();
  const publisher = await helper.createCertifiedUser({
    adminToken: adminForDelete,
    name: '下架测试雇主',
    studentId: '20240020',
    phone: uniquePhone((Date.now() % 99999999) + 3)
  });
  const extraAccountNos = [publisher.accountNo];
  const created = await helper.request('POST', '/api/task/createOrder', {
    receiverName: '李收件', receiverPhone: '13900139001', deliverAddress: 'X栋X楼A101',
    detailAddress: '宿舍A101门口', pickupCode: '8-2-3021', timeLimitMin: 60,
    remark: '管理员下架回归任务', reward: 1.5, img1: '/uploads/test/task_a.jpg'
  }, { token: publisher.token, deviceId: publisher.deviceId });
  const deletedTaskId = created.data && created.data.taskId;
  const del = await helper.request('POST', '/api/admin/deleteTask', {
    taskId: deletedTaskId, reason: '回归测试：验证下架拦截'
  }, { token: adminForDelete, deviceId: 'helper-admin-device' });
  check('现发布一张任务并由管理员下架', created.code === 200 && del.code === 200, created.msg + ' / ' + del.msg);
  const deletedRows = deletedTaskId ? [{ id: deletedTaskId }] : [];
  if (deletedRows.length) {
    const detail = await helper.request('GET', '/api/task/' + deletedRows[0].id, null, { token: publisher.token, deviceId: publisher.deviceId });
    // 详情接口统一返回 { task: vo, remainSeconds }，任务本身在 data.task 里
    const vo = (detail.data && detail.data.task) || {};
    const actions = vo.actions || {};
    // 注意：takeDisabledReason 是「文案字段」而不是布尔开关，
    // 已删除任务下它会被替换成下架提示，这里要单独排除，其余字段必须全部为 false
    const booleanKeys = Object.keys(actions).filter((k) => k !== 'takeDisabledReason');
    const allFalse = booleanKeys.length > 0 && booleanKeys.every((k) => actions[k] === false);
    check('已删除任务详情 isDeleted=true', detail.code === 200 && vo.isDeleted === true, detail.code + ' isDeleted=' + vo.isDeleted);
    check('已删除任务 actions 全部为 false（接单入口被冻结）', allFalse, JSON.stringify(actions));
    check('已删除任务下架提示文案正确', actions.takeDisabledReason === MSG.TASK_DELETED_NOTICE, actions.takeDisabledReason);
  } else {
    check('库中存在已删除任务供校验', false, '未找到 is_deleted=1 的任务');
  }

  // ---------- 收尾：清理测试账号 ----------
  const purged = await helper.purgeAccounts([user.accountNo].concat(extraAccountNos));
  console.log('已清理测试账号：' + [user.accountNo].concat(extraAccountNos).join('、') + '（' + purged + ' 个）');

  const passCount = results.filter((r) => r.pass).length;
  console.log('\n===== 回归结果：' + passCount + ' / ' + results.length + ' 项通过 =====');
  if (passCount !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log('  - ' + r.name + ' -> ' + r.detail));
  }
  await db.closePool();
  process.exit(passCount === results.length ? 0 : 1);
})().catch(async (err) => {
  console.error('脚本异常', err);
  try { await db.closePool(); } catch (e) { /* ignore */ }
  process.exit(1);
});
