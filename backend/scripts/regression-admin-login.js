const http = require('http');
const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();

// 脚本整体是否出现异常（用于设置退出码；声明在最外层，.then 回调里也能读到）
let failed = false;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: 3000, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers)
    }, (res) => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let p; try { p = JSON.parse(raw); } catch (e) { p = raw; } resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 管理员账号 / 口令统一从 .env 读取（TEST_ADMIN_* / INIT_ADMIN_*），源码里不留真实凭据
const ADMIN_ACCOUNT = process.env.TEST_ADMIN_ACCOUNT || process.env.INIT_ADMIN_STUDENT_ID || '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';

(async () => {
  const out = [];
  const check = (n, p, d) => { out.push(p); console.log((p ? '[通过] ' : '[失败] ') + n + (d ? ' -> ' + d : '')); };

  // 管理员：按学号登录（账号 / 口令见 .env 的 TEST_ADMIN_* / INIT_ADMIN_*）
  const admin = await request('POST', '/api/user/login', { account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD, deviceId: 'admin-dev' });
  check('管理员按学号登录', admin.body.code === 200 && admin.body.data.accessToken, admin.body.msg + ' 账号=' + (admin.body.data && admin.body.data.user && admin.body.data.user.userIdText));
  const token = admin.body.data && admin.body.data.accessToken;

  // 管理员：账号ID A0001 登录（大小写不敏感）
  const admin2 = await request('POST', '/api/user/login', { account: 'a0001', password: ADMIN_PASSWORD, deviceId: 'admin-dev' });
  check('管理员按账号ID登录（小写 a0001）', admin2.body.code === 200 && admin2.body.data.accessToken, admin2.body.msg);

  // 管理员未设密保，但不应被 428 拦截（权限最高）
  const list = await request('GET', '/api/admin/userList?page=1&pageSize=3', null, { Authorization: 'Bearer ' + token });
  check('管理员未设密保仍可访问管理员接口（无 428）', list.body.code === 200, 'code=' + list.body.code + ' 用户数=' + (list.body.data && list.body.data.total));

  const info = await request('GET', '/api/user/info', null, { Authorization: 'Bearer ' + token });
  check('管理员 needSetSecurity=false', info.body.code === 200 && info.body.data.needSetSecurity === false, 'needSetSecurity=' + (info.body.data && info.body.data.needSetSecurity));

  // 管理员：查看单个用户完整资料（小程序举报卡片 / 用户卡片点击后调用；手机号不脱敏）
  const firstUser = list.body.data && list.body.data.list && list.body.data.list[0];
  const detail = await request('GET', '/api/admin/userDetail?userId=' + (firstUser && firstUser.userId), null, { Authorization: 'Bearer ' + token });
  check('管理员查看用户完整资料（含未脱敏手机号）',
    detail.body.code === 200 && !!detail.body.data && detail.body.data.userId === firstUser.userId &&
      !!detail.body.data.phone && typeof detail.body.data.isAdmin === 'boolean',
    'userIdText=' + (detail.body.data && detail.body.data.userIdText) + ' phone=' + (detail.body.data && detail.body.data.phone));

  // 查询不存在的用户：必须 404，不能返回空对象或 500
  const missing = await request('GET', '/api/admin/userDetail?userId=99999999', null, { Authorization: 'Bearer ' + token });
  check('管理员查询不存在用户返回 404', missing.body.code === 404, 'code=' + missing.body.code + ' msg=' + missing.body.msg);

  // 缺少参数：必须 400
  const noParam = await request('GET', '/api/admin/userDetail', null, { Authorization: 'Bearer ' + token });
  check('缺少 userId 参数返回 400', noParam.body.code === 400, 'code=' + noParam.body.code + ' msg=' + noParam.body.msg);

  // ---- 学号 / 手机号 双通道登录定位验证 ----
  // 注意：这里必须用「专用测试账号」，绝不能用真实用户账号试错误密码——
  //      连续 5 次密码错误会触发「锁定账号 15 分钟」，几次回归就会把真人账号锁住。
  const h = require('./_accountHelper');
  // 手机号 / 学号带上「运行时间戳」：即使上一次回归中途失败留下了测试数据，
  // 下一次运行也不会因为手机号 / 学号重复而中断（测试数据本身仍是专用测试号段）
  const runStamp = String(Date.now()).slice(-6);
  const probePhone = h.testPhone(Number(runStamp));
  const probeStudentId = '2025' + runStamp;
  const probe = await h.createUser({ phone: probePhone, password: 'Abcd1234', nickname: '登录定位探针' });
  const probeCert = await h.submitCampusCert(probe.token, {
    name: '登录定位探针', studentId: probeStudentId, phone: probePhone
  });
  if (probeCert.code === 200) await h.handleAudit(await h.adminToken(), probeCert.data.applyId, 2);

  const stu = await request('POST', '/api/user/login', { account: probeStudentId, password: 'Abcd1234', deviceId: 'probe-dev' });
  check('学号登录能定位账号', stu.body.code === 200, stu.body.msg);

  // 11 位手机号兜底登录（老账号兼容：老用户可能只记得手机号）
  const byPhone = await request('POST', '/api/user/login', { account: probePhone, password: 'Abcd1234', deviceId: 'probe-dev' });
  check('11位手机号兜底登录可用', byPhone.body.code === 200, byPhone.body.msg);

  const wrongPwd = await request('POST', '/api/user/login', { account: probe.accountNo, password: 'wrongpwd123', deviceId: 'probe-dev' });
  check('密码错误统一提示（防账号枚举）',
    wrongPwd.body.code === 400 && wrongPwd.body.msg === '账号或密码错误', wrongPwd.body.msg);

  // 越权防护：普通用户（已设密保、状态正常）访问管理员接口必须 403，绝不能因为 is_admin=1 就放行
  const probeAdminList = await request('GET', '/api/admin/userList?page=1&pageSize=1', null, { Authorization: 'Bearer ' + probe.token });
  check('普通用户访问管理员列表被拒 403', probeAdminList.body.code === 403, 'code=' + probeAdminList.body.code + ' msg=' + probeAdminList.body.msg);
  const probeAdminDetail = await request('GET', '/api/admin/userDetail?userId=1', null, { Authorization: 'Bearer ' + probe.token });
  check('普通用户查看他人资料被拒 403', probeAdminDetail.body.code === 403, 'code=' + probeAdminDetail.body.code + ' msg=' + probeAdminDetail.body.msg);

  // ---------------- 管理员订单管理：搜索 / 编辑 / 越权（本轮新增） ----------------
  // 用专用测试账号真实走一遍「发布订单 -> 管理员搜索 -> 编辑 -> 删除」，
  // 全部数据在收尾时由 purgeAccounts 清理，不会污染真实用户数据。
  // 注意：单设备登录规则下，令牌必须用辅助模块最新登录的管理员令牌（本地 token 已被辅助模块的登录顶掉）
  const adminToken = await h.adminToken();
  const orderEmployerPhone = h.testPhone(Number(runStamp) + 7);
  const orderEmployer = await h.createCertifiedUser({
    phone: orderEmployerPhone,
    nickname: '订单回归雇主',
    name: '订单回归',
    studentId: '2026' + runStamp,
    adminToken
  });
  const createdTask = await h.request('POST', '/api/task/createOrder', {
    receiverName: '收件人甲',
    receiverPhone: h.testPhone(4302),
    deliverAddress: '8栋2楼A801',
    detailAddress: '801室',
    timeLimitMin: 60,
    remark: '订单管理回归测试',
    reward: 1.5,
    img1: '/uploads/test/task.jpg'
  }, { token: orderEmployer.token, deviceId: orderEmployer.deviceId });
  check('测试雇主发布任务成功（订单管理回归用）',
    createdTask.code === 200 && !!createdTask.data && !!createdTask.data.taskId, createdTask.msg);
  const orderTaskId = createdTask.data && createdTask.data.taskId;

  // 1) 按雇主账号ID搜索：应能定位到刚发布的订单，并带出双方资料与订单号
  const searchByAccount = await h.request('GET',
    '/api/admin/searchTask?page=1&pageSize=10&keyword=' + encodeURIComponent(orderEmployer.accountNo),
    null, { token: adminToken });
  const foundOrder = ((searchByAccount.data && searchByAccount.data.list) || [])
    .find((item) => item.taskId === orderTaskId);
  check('管理员按账号ID搜索到订单（含订单号与双方资料）',
    searchByAccount.code === 200 && !!foundOrder && /^GCPT\d+$/.test(foundOrder.orderNo || '') &&
      !!foundOrder.owner && foundOrder.owner.phone === orderEmployerPhone,
    foundOrder ? '订单号=' + foundOrder.orderNo + ' 状态=' + foundOrder.statusText : '未搜到');

  // 2) 按订单号精确搜索：必须唯一命中该订单
  const orderNo = foundOrder ? foundOrder.orderNo : '';
  const searchByOrderNo = await h.request('GET',
    '/api/admin/searchTask?page=1&pageSize=10&keyword=' + encodeURIComponent(orderNo),
    null, { token: adminToken });
  check('管理员按订单号精确搜索命中唯一订单',
    searchByOrderNo.code === 200 && searchByOrderNo.data.total === 1 &&
      searchByOrderNo.data.list[0].taskId === orderTaskId,
    'total=' + (searchByOrderNo.data && searchByOrderNo.data.total));

  // 3) 不存在的订单号：必须是空结果，不能报错
  const searchNothing = await h.request('GET',
    '/api/admin/searchTask?page=1&pageSize=10&keyword=GCPT999999', null, { token: adminToken });
  check('搜索不存在的订单号返回空结果',
    searchNothing.code === 200 && searchNothing.data.total === 0,
    'total=' + (searchNothing.data && searchNothing.data.total));

  // 4) 越权：普通用户不能搜索订单、不能编辑订单
  const probeSearch = await h.request('GET', '/api/admin/searchTask?page=1&pageSize=5', null, { token: probe.token, deviceId: probe.deviceId });
  check('普通用户搜索订单被拒 403', probeSearch.code === 403, 'code=' + probeSearch.code + ' msg=' + probeSearch.msg);
  const probeUpdate = await h.request('POST', '/api/admin/updateTask', { taskId: orderTaskId, remark: '越权修改' }, { token: probe.token, deviceId: probe.deviceId });
  check('普通用户编辑订单被拒 403', probeUpdate.code === 403, 'code=' + probeUpdate.code + ' msg=' + probeUpdate.msg);

  // 5) 管理员编辑订单：改备注 + 上调酬金，必须成功并可回读
  const editRes = await h.request('POST', '/api/admin/updateTask', {
    taskId: orderTaskId, remark: '管理员已修改备注', reward: 2.5
  }, { token: adminToken });
  check('管理员编辑订单成功', editRes.code === 200 && Array.isArray(editRes.data.changes) && editRes.data.changes.length === 2,
    editRes.msg + ' 改动字段=' + (editRes.data && editRes.data.changes.length));

  const afterEdit = await h.request('GET',
    '/api/admin/searchTask?page=1&pageSize=5&keyword=' + encodeURIComponent(orderNo), null, { token: adminToken });
  const editedOrder = (afterEdit.data && afterEdit.data.list[0]) || {};
  check('编辑结果已落库（备注 + 酬金）',
    editedOrder.remark === '管理员已修改备注' && Number(editedOrder.reward) === 2.5,
    'remark=' + editedOrder.remark + ' reward=' + editedOrder.reward);

  // 6) 编辑后必须给雇主推送站内消息
  const employerMsg = await h.request('GET', '/api/message/list?page=1&pageSize=20', null,
    { token: orderEmployer.token, deviceId: orderEmployer.deviceId });
  const editedMsg = ((employerMsg.data && employerMsg.data.list) || [])
    .find((item) => (item.title || '').indexOf('订单信息已被管理员修改') >= 0);
  check('编辑订单后雇主收到站内消息通知', employerMsg.code === 200 && !!editedMsg,
    editedMsg ? editedMsg.title : '未收到通知');

  // 7) 酬金低于下限必须被拒绝
  const badReward = await h.request('POST', '/api/admin/updateTask', { taskId: orderTaskId, reward: 0.1 }, { token: adminToken });
  check('管理员把酬金改到低于0.5元被拒 400', badReward.code === 400, 'code=' + badReward.code + ' msg=' + badReward.msg);

  // 8) 无任何改动提交：必须提示「没有任何信息被修改」
  const noChange = await h.request('POST', '/api/admin/updateTask', { taskId: orderTaskId, remark: '管理员已修改备注' }, { token: adminToken });
  check('提交未改动的订单信息被拒 409', noChange.code === 409, 'code=' + noChange.code + ' msg=' + noChange.msg);

  // 9) 已删除的订单不能再编辑（软删除后仍可在订单管理中检索到，并带删除标记）
  const delOrder = await h.request('POST', '/api/admin/deleteTask', { taskId: orderTaskId, reason: '回归测试清理' }, { token: adminToken });
  check('管理员删除待接单订单成功（自动退费）', delOrder.code === 200 && delOrder.data.refund.refunded === true, delOrder.msg);
  const afterDelete = await h.request('GET',
    '/api/admin/searchTask?page=1&pageSize=5&keyword=' + encodeURIComponent(orderNo), null, { token: adminToken });
  const deletedOrder = (afterDelete.data && afterDelete.data.list[0]) || {};
  check('已删除订单仍可检索到并标记 isDeleted', deletedOrder.isDeleted === true && deletedOrder.canEdit === false,
    'isDeleted=' + deletedOrder.isDeleted);
  const editDeleted = await h.request('POST', '/api/admin/updateTask', { taskId: orderTaskId, remark: '删除后再改' }, { token: adminToken });
  check('已删除订单不可再编辑 409', editDeleted.code === 409, 'code=' + editDeleted.code + ' msg=' + editDeleted.msg);

  await h.purgeAccounts([orderEmployer.accountNo]);

  await h.purgeAccounts([orderEmployer.accountNo]);

  await h.purgeAccounts([probe.accountNo]);

  // 清理联调测试账号
  const accountNo = fs.readFileSync(require('path').resolve(__dirname, '..', '..', 'logs', '_e2e_account.txt'), 'utf8').trim();
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });
  const [rows] = await conn.query('SELECT id, account_no FROM users WHERE account_no = ?', [accountNo]);
  if (rows.length) {
    const uid = rows[0].id;
    await conn.query('DELETE FROM user_device WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM messages WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM users WHERE id = ?', [uid]);
    console.log('[清理] 已删除联调测试账号 ' + accountNo + '（id=' + uid + '）');
  }
  const [left] = await conn.query('SELECT COUNT(*) AS c FROM users');
  console.log('[清理] 当前用户总数 = ' + left[0].c);
  await conn.end();

  const pass = out.filter(Boolean).length;
  console.log('\n===== 补充验证：' + pass + ' / ' + out.length + ' 项通过 =====');
})()
  .catch((e) => {
    console.error('异常', e.message);
    failed = true;
  })
  .then(async () => {
    // 辅助模块会创建 MySQL 连接池，必须显式关闭，否则进程会一直挂着不退出
    try {
      await require('../src/db/db').closePool();
    } catch (err) {
      /* 忽略关闭异常 */
    }
    process.exit(failed ? 1 : 0);
  });
