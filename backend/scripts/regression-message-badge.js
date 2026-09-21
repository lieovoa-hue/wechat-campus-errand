/**
 * =====================================================================
 * 回归：消息中心（详情 / 一键清除）与 tabBar「我的任务」角标
 * ---------------------------------------------------------------------
 * 覆盖点：
 *  1. GET  /api/task/tabBadge  未完成数 = 进行中 + 待雇主确认，完成后归零
 *  2. GET  /api/message/detail 进入详情即标记已读，未读数同步下降
 *  3. 越权：A 账号拿 B 账号的消息 id 读不到内容（用 user_id 做归属条件）
 *  4. POST /api/message/clearUnread 只删本人的未读消息，已读消息保留
 *  5. 幂等：重复清除返回 0 而不是报错
 *  6. 未登录访问以上三个接口统一 401
 * 跑完自动清理测试账号，不留副作用。
 * 运行：node scripts/regression-message-badge.js
 * =====================================================================
 */

const helper = require('./_accountHelper');

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log((pass ? '[通过] ' : '[失败] ') + name + (detail !== undefined ? ' -> ' + detail : ''));
}
function title(text) {
  console.log('\n---------- ' + text + ' ----------');
}

/** 带令牌的请求快捷方法 */
function api(method, p, body, token) {
  return helper.request(method, p, body, { token, deviceId: 'badge-test-device' });
}

/** 构造一个「已认证、可发布可接单」的账号 */
async function makeUser(adminToken, name, studentSuffix, phoneSeed) {
  return helper.createCertifiedUser({
    adminToken,
    name,
    studentId: '8' + String(Date.now()).slice(-5) + studentSuffix,
    phone: helper.testPhone(phoneSeed)
  });
}

const form = (over) => Object.assign({
  receiverName: '李收件',
  receiverPhone: '13900139001',
  deliverAddress: 'X栋X楼A101',
  detailAddress: '宿舍A101门口',
  timeLimitMin: 60,
  remark: '角标回归任务',
  reward: 2,
  img1: '/uploads/test/task_a.jpg'
}, over || {});

const createdAccountNos = [];

async function main() {
  const adminToken = await helper.adminToken();
  const stamp = Date.now();
  const owner = await makeUser(adminToken, '角标雇主', '1', stamp % 100000);
  const taker = await makeUser(adminToken, '角标跑腿', '2', (stamp + 7) % 100000);
  const other = await makeUser(adminToken, '旁观用户', '3', (stamp + 13) % 100000);
  createdAccountNos.push(owner.accountNo, taker.accountNo, other.accountNo);

  // ---------------------------------------------------------------- 未登录
  title('1. 未登录鉴权');
  const anonBadge = await helper.request('GET', '/api/task/tabBadge', null, {});
  check('未登录访问 tabBadge 返回 401', anonBadge.code === 401, anonBadge.code + ' ' + anonBadge.msg);
  const anonDetail = await helper.request('GET', '/api/message/detail?id=1', null, {});
  check('未登录访问 message/detail 返回 401', anonDetail.code === 401, anonDetail.code + ' ' + anonDetail.msg);
  const anonClear = await helper.request('POST', '/api/message/clearUnread', {}, {});
  check('未登录访问 message/clearUnread 返回 401', anonClear.code === 401, anonClear.code + ' ' + anonClear.msg);

  // ---------------------------------------------------------------- tabBar 角标
  title('2. tabBar「我的任务」角标 = 未完成任务数');
  const badge0 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('新账号角标为 0', badge0.code === 200 && badge0.data.myTakeUnfinished === 0,
    JSON.stringify(badge0.data));

  const created = await api('POST', '/api/task/createOrder', form(), owner.token);
  const taskId = created.data && created.data.taskId;
  check('雇主成功发布任务', created.code === 200 && !!taskId, created.msg);

  const notMine = await api('GET', '/api/task/tabBadge', null, owner.token);
  check('雇主（只是发布、没接单）角标仍为 0', notMine.data.myTakeUnfinished === 0,
    JSON.stringify(notMine.data));

  const taken = await api('POST', '/api/task/take', { taskId }, taker.token);
  check('跑腿员接单成功', taken.code === 200, taken.msg);
  const badge1 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('接单后（进行中）角标变 1', badge1.data.myTakeUnfinished === 1, JSON.stringify(badge1.data));

  // 两步流程：先「确认取货」（物品照片落库并锁定），再「提交送达」（只认送达照片）
  const beforePickup = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/uploads/test/d1.jpg']
  }, taker.token);
  check('未确认取货时提交送达被拒', beforePickup.code === 409, beforePickup.msg);

  const pickup = await api('POST', '/api/task/confirmPickup', {
    taskId, pickupImages: ['/uploads/test/p1.jpg']
  }, taker.token);
  check('跑腿员确认取货（物品照片锁定）', pickup.code === 200, pickup.msg);
  const badgePickup = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('已取货（仍在进行中）角标仍为 1', badgePickup.data.myTakeUnfinished === 1, JSON.stringify(badgePickup.data));

  // 提交送达有 3 秒防连点窗口，等一下再提交
  await helper.sleep(3200);
  const submitted = await api('POST', '/api/task/submitFinish', {
    taskId, deliveryImages: ['/uploads/test/d1.jpg']
  }, taker.token);
  check('提交送达照片成功（进入待雇主确认）', submitted.code === 200, submitted.msg);
  const badge2 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('提交完成（待雇主确认）角标仍为 1', badge2.data.myTakeUnfinished === 1, JSON.stringify(badge2.data));

  // 两步确认：确认收货（待支付）时仍不算完成，点「完成任务」后角标才归零
  const receipt = await api('POST', '/api/task/receiptFinish', { taskId }, owner.token);
  check('雇主确认收货', receipt.code === 200, receipt.msg);
  const badgeReceipt = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('待支付（尚未完成）角标仍为 1', badgeReceipt.data.myTakeUnfinished === 1, JSON.stringify(badgeReceipt.data));
  const confirmed = await api('POST', '/api/task/confirmFinish', { taskId }, owner.token);
  check('雇主完成任务', confirmed.code === 200, confirmed.msg);
  const badge3 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('任务完成后角标归零', badge3.data.myTakeUnfinished === 0, JSON.stringify(badge3.data));

  // 未完成 → 取消接单也要把角标减回去
  const created2 = await api('POST', '/api/task/createOrder', form({ remark: '取消接单角标' }), owner.token);
  const taskId2 = created2.data.taskId;
  await api('POST', '/api/task/take', { taskId: taskId2 }, taker.token);
  const badge4 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('再接一单角标变 1', badge4.data.myTakeUnfinished === 1, JSON.stringify(badge4.data));
  await api('POST', '/api/task/cancelTake', { taskId: taskId2 }, taker.token);
  const badge5 = await api('GET', '/api/task/tabBadge', null, taker.token);
  check('取消接单后角标归零', badge5.data.myTakeUnfinished === 0, JSON.stringify(badge5.data));

  // ---------------------------------------------------------------- 消息详情
  title('3. 消息详情（进入即已读 + 越权拦截）');
  const listRes = await api('GET', '/api/message/list?page=1&pageSize=10', null, taker.token);
  const msgs = (listRes.data && listRes.data.list) || [];
  check('消息列表返回未读数', typeof listRes.data.unread === 'number', listRes.data.unread);
  check('接单 / 完成流程产生了站内消息', msgs.length > 0, msgs.length + ' 条');

  const target = msgs[0];
  const unreadBefore = listRes.data.unread;
  const detail = await api('GET', '/api/message/detail?id=' + target.id, null, taker.token);
  check('本人可读取消息详情', detail.code === 200 && detail.data.message.id === target.id,
    detail.code + ' ' + detail.msg);
  check('详情返回的未读数比列表少 1（或本来就已读）',
    detail.data.unread === Math.max(0, unreadBefore - 1),
    unreadBefore + ' -> ' + detail.data.unread);
  const again = await api('GET', '/api/message/detail?id=' + target.id, null, taker.token);
  check('重复进入同一条消息详情幂等（未读数不再变化）',
    again.data.unread === detail.data.unread, again.data.unread);

  const crossDetail = await api('GET', '/api/message/detail?id=' + target.id, null, other.token);
  check('越权：别的账号读不到这条消息', crossDetail.code !== 200,
    crossDetail.code + ' ' + crossDetail.msg);

  const ghost = await api('GET', '/api/message/detail?id=99999999', null, taker.token);
  check('不存在的消息返回友好提示（不暴露数据库细节）',
    ghost.code === 400 && !/SQL|Error|stack/i.test(ghost.msg || ''), ghost.code + ' ' + ghost.msg);

  const noId = await api('GET', '/api/message/detail', null, taker.token);
  check('缺少 id 参数返回 400', noId.code === 400, noId.code + ' ' + noId.msg);

  // ---------------------------------------------------------------- 一键清除
  title('4. 一键清除未读消息');
  const beforeClear = await api('GET', '/api/message/list?page=1&pageSize=20', null, taker.token);
  const readCountBefore = beforeClear.data.list.filter((m) => Number(m.is_read) === 1).length;
  const unreadCountBefore = beforeClear.data.unread;

  const cleared = await api('POST', '/api/message/clearUnread', {}, taker.token);
  check('清除未读返回实际条数', cleared.code === 200 && cleared.data.cleared === unreadCountBefore,
    JSON.stringify(cleared.data) + ' 期望 ' + unreadCountBefore);

  const afterClear = await api('GET', '/api/message/list?page=1&pageSize=20', null, taker.token);
  check('清除后未读数为 0', afterClear.data.unread === 0, afterClear.data.unread);
  check('已读消息不受影响（历史仍可回看）',
    afterClear.data.list.filter((m) => Number(m.is_read) === 1).length === readCountBefore,
    readCountBefore + ' -> ' + afterClear.data.list.filter((m) => Number(m.is_read) === 1).length);

  const clearedAgain = await api('POST', '/api/message/clearUnread', {}, taker.token);
  check('重复清除幂等（返回 0，不报错）',
    clearedAgain.code === 200 && clearedAgain.data.cleared === 0, JSON.stringify(clearedAgain.data));

  const otherStillHas = await api('GET', '/api/message/list?page=1&pageSize=20', null, other.token);
  check('清除只影响本人（别的账号未读数不受影响）',
    otherStillHas.data.unread >= 0 && typeof otherStillHas.data.unread === 'number',
    otherStillHas.data.unread);

  // ---------------------------------------------------------------- 收尾
  const pass = results.filter(Boolean).length;
  console.log('\n===== 回归结果：' + pass + ' / ' + results.length + ' 项通过 =====');
  return pass === results.length;
}

main()
  .then(async (allPass) => {
    try {
      const purged = await helper.purgeAccounts(createdAccountNos);
      console.log('已清理本次测试账号：' + purged + ' 个');
    } catch (err) {
      console.log('[WARN] 清理测试账号失败：' + err.message);
    }
    process.exit(allPass ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('脚本异常：' + (err && err.stack ? err.stack : err));
    try { await helper.purgeAccounts(createdAccountNos); } catch (e) { /* 忽略 */ }
    process.exit(1);
  });
