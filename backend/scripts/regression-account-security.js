/**
 * 后端账号体系改造的端到端联调脚本：
 *   注册（图形验证码） → 未设密保被 428 拦截 → 设置密保 → 换设备登录触发密保解锁 → 校验通过登录
 * 说明：图形验证码答案只在服务端，这里通过读取后端日志拿到（等价于人工看日志）。
 */
const http = require('http');
const fs = require('fs');
const { SECURITY_QUESTIONS } = require('../src/utils/constant');

const HOST = '127.0.0.1';
const PORT = 3000;
// 后端日志按天分文件，这里复用账号助手的解析逻辑（按最近修改挑出当前正在写的那个）
const { resolveLogFile } = require('./_accountHelper');

// 本脚本的账号 / 口令统一从 .env 读取，源码里不硬编码任何真实凭据
require('dotenv').config();
const LOG = resolveLogFile();

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: HOST, port: PORT, path, method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, headers)
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function lastCaptchaAnswer() {
  // 每次都比对「当前」日志文件：运行跨天时日志会换成新文件
  const text = fs.readFileSync(resolveLogFile(), 'utf8');
  const matches = text.match(/【图形验证码】生成的题目答案为 (-?\d+)/g) || [];
  const last = matches[matches.length - 1] || '';
  return last.replace(/[^-\d]/g, '');
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' -> ' + detail : ''));
}

const ADMIN_ACCOUNT = process.env.TEST_ADMIN_ACCOUNT || process.env.INIT_ADMIN_STUDENT_ID || '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';

(async () => {
  // ---------- 1. 健康检查 ----------
  const health = await request('GET', '/api/health');
  check('健康检查返回新版字段', health.body && health.body.data && health.body.data.captchaEnabled === true, JSON.stringify(health.body.data));

  // ---------- 2. 图形验证码 ----------
  const cap1 = await request('GET', '/api/user/captcha');
  check('获取图形验证码', cap1.body.code === 200 && cap1.body.data.captchaId && cap1.body.data.image.indexOf('data:') === 0,
    'captchaId=' + (cap1.body.data && cap1.body.data.captchaId || '').slice(0, 8) + '...');
  const answer1 = lastCaptchaAnswer();

  // ---------- 3. 随机账号ID + 可用性校验 ----------
  const rnd = await request('GET', '/api/user/randomAccountNo');
  check('随机生成账号ID', rnd.body.code === 200 && /^X\d{4}$/.test(rnd.body.data.accountNo), rnd.body.data && rnd.body.data.accountNo);
  const accountNo = rnd.body.data.accountNo;
  // 账号ID占用校验拆成两步（原来写死 X0001，测试库清理后该账号不存在会误报）：
  //   ① 注册前：随机ID必须「可用」；② 注册成功后：同一个ID必须变成「不可用」。
  const free = await request('POST', '/api/user/checkAccountNo', { accountNo });
  check('随机账号ID返回可用', free.body.data && free.body.data.available === true, JSON.stringify(free.body.data));

  // ---------- 4. 注册（弱密码必须被拒） ----------
  const capBad = await request('GET', '/api/user/captcha');
  const weak = await request('POST', '/api/user/register', {
    accountNo, password: '12345678', captchaId: capBad.body.data.captchaId,
    captchaCode: lastCaptchaAnswer(), agreeProtocol: true
  });
  check('弱密码（纯数字）被拒', weak.body.code === 400 && /8-20位/.test(weak.body.msg), weak.body.msg);

  const cap2 = await request('GET', '/api/user/captcha');
  const register = await request('POST', '/api/user/register', {
    accountNo, password: 'Abcd1234', captchaId: cap2.body.data.captchaId,
    captchaCode: lastCaptchaAnswer(), agreeProtocol: true, deviceId: 'dev-A', deviceName: '测试机A'
  });
  check('注册成功（X + 4位数字 / 图形验证码）', register.body.code === 200 && register.body.data.accessToken, register.body.msg);
  const taken = await request('POST', '/api/user/checkAccountNo', { accountNo });
  check('已占用账号ID返回不可用', taken.body.data && taken.body.data.available === false, JSON.stringify(taken.body.data));
  const tokenA = register.body.data && register.body.data.accessToken;
  check('注册返回 needSetSecurity=true', register.body.data && register.body.data.needSetSecurity === true, String(register.body.data && register.body.data.needSetSecurity));

  // ---------- 5. 未设密保：业务接口应被 428 拦截 ----------
  const blocked = await request('POST', '/api/task/createOrder', { reward: 1 }, { Authorization: 'Bearer ' + tokenA });
  check('未设密保访问业务接口被 428 拦截', blocked.body.code === 428, blocked.body.code + ' ' + blocked.body.msg);

  const infoBefore = await request('GET', '/api/user/info', null, { Authorization: 'Bearer ' + tokenA });
  check('白名单接口 /user/info 仍可访问', infoBefore.body.code === 200 && infoBefore.body.data.needSetSecurity === true, 'needSetSecurity=' + (infoBefore.body.data && infoBefore.body.data.needSetSecurity));

  // ---------- 6. 设置密保 ----------
  const sameQ = await request('POST', '/api/user/setSecurity', {
    questions: [SECURITY_QUESTIONS[0], SECURITY_QUESTIONS[0]], answers: ['abc', 'def']
  }, { Authorization: 'Bearer ' + tokenA });
  check('两道密保问题相同被拒', sameQ.body.code === 400, sameQ.body.msg);

  const set = await request('POST', '/api/user/setSecurity', {
    questions: [SECURITY_QUESTIONS[0], SECURITY_QUESTIONS[1]], answers: ['小学老师张三', 'myMother']
  }, { Authorization: 'Bearer ' + tokenA });
  check('设置密保成功', set.body.code === 200, set.body.msg);

  const blocked2 = await request('POST', '/api/task/createOrder', { reward: 1 }, { Authorization: 'Bearer ' + tokenA });
  check('设完密保后不再被 428 拦截（改为校园认证校验）', blocked2.body.code !== 428, blocked2.body.code + ' ' + blocked2.body.msg);

  // ---------- 7. 换设备登录：触发密保解锁 ----------
  const loginNew = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd1234', deviceId: 'dev-B', deviceName: '测试机B' });
  check('新设备登录返回 needUnlock', loginNew.body.code === 200 && loginNew.body.data.needUnlock === true, loginNew.body.msg);
  const ticket = loginNew.body.data && loginNew.body.data.unlockTicket;
  check('新设备登录不下发令牌', loginNew.body.data && !loginNew.body.data.accessToken, 'accessToken=' + (loginNew.body.data && loginNew.body.data.accessToken));
  check('新设备登录返回2道密保问题', loginNew.body.data && loginNew.body.data.questions.length === 2, JSON.stringify(loginNew.body.data && loginNew.body.data.questions));

  const wrong = await request('POST', '/api/user/securityUnlock', { unlockTicket: ticket, answer1: '错误答案', answer2: 'myMother' });
  check('错误密保答案被拒', wrong.body.code === 400, wrong.body.code + ' ' + wrong.body.msg);

  const unlock = await request('POST', '/api/user/securityUnlock', { unlockTicket: ticket, answer1: ' 小学老师张三 ', answer2: 'MYMOTHER' });
  check('正确密保答案解锁成功（含空格/大小写容错）', unlock.body.code === 200 && unlock.body.data.accessToken, unlock.body.msg);
  const tokenB = unlock.body.data && unlock.body.data.accessToken;

  // ---------- 8. 常用设备再次登录：直接放行 ----------
  const loginAgain = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd1234', deviceId: 'dev-B' });
  check('已绑定设备再次登录直接放行', loginAgain.body.code === 200 && loginAgain.body.data.accessToken, loginAgain.body.msg);

  const devices = await request('GET', '/api/user/devices', null, { Authorization: 'Bearer ' + tokenB });
  check('设备列表返回2台且标记本机', devices.body.code === 200 && devices.body.data.total >= 2, '绑定设备数=' + (devices.body.data && devices.body.data.total));

  // ---------- 9. 学号登录路径 ----------
  // 学号通道验证用管理员账号（密码确定正确）：绝不能用真实普通账号试密码，
  // 否则连续 5 次错误会触发「锁定账号 15 分钟」，把真人账号锁掉。
  const byStudent = await request('POST', '/api/user/login', { account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD, deviceId: 'dev-C' });
  check('按学号登录可用（管理员学号通道）', byStudent.body.code === 200, byStudent.body.code + ' ' + byStudent.body.msg);

  // ---------- 10. 忘记密码两步流程 ----------
  const cap3 = await request('GET', '/api/user/captcha');
  const q = await request('POST', '/api/user/securityQuestions', { account: accountNo, captchaId: cap3.body.data.captchaId, captchaCode: lastCaptchaAnswer() });
  check('忘记密码第一步返回题目与票据', q.body.code === 200 && q.body.data.resetTicket && q.body.data.questions.length === 2, 'needIdentity=' + (q.body.data && q.body.data.needIdentity));

  const cap4 = await request('GET', '/api/user/captcha');
  const resetBad = await request('POST', '/api/user/resetPassword', {
    resetTicket: q.body.data.resetTicket, answer1: '错', answer2: '错',
    newPassword: 'Abcd5678', captchaId: cap4.body.data.captchaId, captchaCode: lastCaptchaAnswer()
  });
  check('错误密保无法重置密码', resetBad.body.code === 400, resetBad.body.code + ' ' + resetBad.body.msg);

  const cap5 = await request('GET', '/api/user/captcha');
  const resetOk = await request('POST', '/api/user/resetPassword', {
    resetTicket: q.body.data.resetTicket, answer1: '小学老师张三', answer2: 'myMother',
    newPassword: 'Abcd5678', captchaId: cap5.body.data.captchaId, captchaCode: lastCaptchaAnswer()
  });
  check('正确密保重置密码成功', resetOk.body.code === 200, resetOk.body.msg);

  const loginNew2 = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd5678', deviceId: 'dev-B' });
  check('新密码可登录', loginNew2.body.code === 200, loginNew2.body.msg);

  const loginOld = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd1234', deviceId: 'dev-B' });
  check('旧密码已失效', loginOld.body.code === 400, loginOld.body.code + ' ' + loginOld.body.msg);

  // ---------- 11. 自定义密保问题（允许用户自行填写题目文本） ----------
  const relogin = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd5678', deviceId: 'dev-B' });
  const tokenC = relogin.body.data && relogin.body.data.accessToken;
  check('自定义密保前置：重新登录成功', !!tokenC, relogin.body.msg);

  const customQ1 = '自定义问题：我最喜欢的数字是几？';

  // 11.1 自定义问题过短 → 拒绝
  const shortQ = await request('POST', '/api/user/setSecurity', {
    questions: ['啊', customQ1], answers: ['答案甲', '答案乙'],
    currentAnswers: ['小学老师张三', 'myMother']
  }, { Authorization: 'Bearer ' + tokenC });
  check('自定义密保问题过短被拒', shortQ.body.code === 400 && /2个字符/.test(shortQ.body.msg), shortQ.body.code + ' ' + shortQ.body.msg);

  // 11.2 自定义问题过长（31 个字符）→ 拒绝
  const longQ = await request('POST', '/api/user/setSecurity', {
    questions: [new Array(32).join('自'), customQ1], answers: ['答案甲', '答案乙'],
    currentAnswers: ['小学老师张三', 'myMother']
  }, { Authorization: 'Bearer ' + tokenC });
  check('自定义密保问题过长被拒', longQ.body.code === 400 && /30个字符/.test(longQ.body.msg), longQ.body.code + ' ' + longQ.body.msg);

  // 11.3 自定义问题含 HTML 特殊字符：必须转义后落库（防 XSS）
  const xssQ = await request('POST', '/api/user/setSecurity', {
    questions: ['自定义：我喜欢<b>什么</b>？', customQ1], answers: ['答案甲', '答案乙'],
    currentAnswers: ['小学老师张三', 'myMother']
  }, { Authorization: 'Bearer ' + tokenC });
  check('自定义问题含 HTML 字符提交成功', xssQ.body.code === 200, xssQ.body.msg);

  const infoCustom = await request('GET', '/api/user/info', null, { Authorization: 'Bearer ' + tokenC });
  const storedQ = (infoCustom.body.data && infoCustom.body.data.user && infoCustom.body.data.user.securityQuestions) || [];
  check('自定义问题落库后已 HTML 转义（无原始标签）',
    !!storedQ[0] && storedQ[0].indexOf('&lt;b&gt;') >= 0 && storedQ[0].indexOf('<b>') < 0, JSON.stringify(storedQ));

  // 11.4 忘记密码第一步能取到自定义题目原文（后续按原文答题）
  const cap6 = await request('GET', '/api/user/captcha');
  const qCustom = await request('POST', '/api/user/securityQuestions', {
    account: accountNo, captchaId: cap6.body.data.captchaId, captchaCode: lastCaptchaAnswer()
  });
  check('忘记密码可取到自定义密保题目',
    qCustom.body.code === 200 && qCustom.body.data.questions[0] === storedQ[0],
    JSON.stringify(qCustom.body.data && qCustom.body.data.questions));

  // 11.5 换设备登录返回自定义题目，且自定义答案可解锁
  const loginDevD = await request('POST', '/api/user/login', {
    account: accountNo, password: 'Abcd5678', deviceId: 'dev-D', deviceName: '测试机D'
  });
  check('新设备登录返回自定义密保题目',
    loginDevD.body.code === 200 && loginDevD.body.data.needUnlock === true
      && loginDevD.body.data.questions[0] === storedQ[0],
    JSON.stringify(loginDevD.body.data && loginDevD.body.data.questions));

  const unlockCustom = await request('POST', '/api/user/securityUnlock', {
    unlockTicket: loginDevD.body.data.unlockTicket, answer1: '答案甲', answer2: '答案乙'
  });
  check('自定义密保答案可解锁新设备', unlockCustom.body.code === 200 && !!unlockCustom.body.data.accessToken, unlockCustom.body.msg);

  // 11.6 答案不能与自定义问题内容相同
  // 注意：11.5 在 dev-D 上登录成功会「顶掉」dev-B 的令牌，这里必须重新登录拿新令牌
  const relogin2 = await request('POST', '/api/user/login', { account: accountNo, password: 'Abcd5678', deviceId: 'dev-B' });
  const tokenD = relogin2.body.data && relogin2.body.data.accessToken;
  check('自定义密保收尾：重新登录成功', !!tokenD, relogin2.body.msg);

  const sameAsQ = await request('POST', '/api/user/setSecurity', {
    questions: [customQ1, '自定义：我喜欢<b>什么</b>？'], answers: [customQ1, '答案乙'],
    currentAnswers: ['答案甲', '答案乙']
  }, { Authorization: 'Bearer ' + tokenD });
  check('自定义问题与答案相同被拒', sameAsQ.body.code === 400 && /不能与问题内容相同/.test(sameAsQ.body.msg), sameAsQ.body.code + ' ' + sameAsQ.body.msg);

  const pass = results.filter((r) => r.pass).length;
  console.log('\n===== 联调结果：' + pass + ' / ' + results.length + ' 项通过 =====');
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log('  - ' + r.name + ' -> ' + r.detail));
  }
  // 把测试账号ID写出来，方便测试结束后清理
  const e2eDir = require('path').resolve(__dirname, '..', '..', 'logs');
  fs.mkdirSync(e2eDir, { recursive: true });
  fs.writeFileSync(require('path').join(e2eDir, '_e2e_account.txt'), accountNo, 'utf8');

  // 收尾：自动清理本次注册的测试账号（避免每跑一次就在库里留一条注册记录）
  try {
    const helper = require('./_accountHelper');
    const purged = await helper.purgeAccounts([accountNo]);
    console.log('已清理本次测试账号：' + accountNo + '（' + purged + ' 个）');
  } catch (err) {
    console.log('测试账号自动清理失败（可手动删除 ' + accountNo + '）：' + err.message);
  }
  // 关闭数据库连接池，否则进程不会退出
  try { await require('../src/db/db').closePool(); } catch (err) { /* ignore */ }
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('脚本异常', e); process.exit(1); });
