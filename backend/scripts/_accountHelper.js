/**
 * =====================================================================
 * 测试账号辅助模块（新版账号体系专用）
 * ---------------------------------------------------------------------
 * 新版注册流程比旧版多了两道门槛，脚本必须一起走完：
 *   ① 图形验证码（服务端本地生成，答案只写在日志里，等价于人工看日志）
 *   ② 账号ID 由用户自选（X + 1~4 位数字），不再由后端自动递增
 *   ③ 注册后必须先设置密保问题，否则其它业务接口统一返回 428
 * 并且：姓名 / 学号改为「校园认证」阶段才采集，所以要让一个测试账号能发布、接单，
 *      必须再走一遍「提交校园认证 -> 管理员审核通过」。
 *
 * 用法：
 *   const helper = require('./_accountHelper');
 *   const admin = await helper.adminToken();            // 已存在的管理员账号令牌
 *   const u = await helper.createCertifiedUser({ adminToken: admin, name: '测试雇主', studentId: '20259101' });
 *   u.token / u.accountNo / u.userId / u.phone
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { SECURITY_QUESTIONS } = require('../src/utils/constant');
const db = require('../src/db/db');

// 本脚本的账号 / 口令统一从 .env 读取，源码里不硬编码任何真实凭据
require('dotenv').config();

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

/** 后端上传根目录（与 src/app.js 的 UPLOAD_DIR 保持一致） */
const UPLOAD_ROOT = path.resolve(__dirname, '../uploads');

/**
 * 一张最小的合法 JPEG（1x1 像素，文件头 FF D8 FF，约 300 字节）
 * 仅用于让测试造出来的「校园认证截图」在磁盘上真实存在。
 */
const MIN_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

/**
 * 确保「测试用的校园认证截图」在磁盘上真实存在
 * ---------------------------------------------------------------------
 * 审核接口只校验 `/uploads/...` 相对路径的格式，并不校验文件是否真的落盘；
 * 但如果数据库引用指向一个不存在的文件，会产生两个后果：
 *   1) 测试库与磁盘处于不一致状态（清理残留数据时容易误判）；
 *   2) 「垃圾清理器」回归里的「引用保护」断言（抽查库中引用的图片是否仍在磁盘上）
 *      会因为找不到文件而失败 —— 而它本来是想验证「被引用的文件绝不被回收」。
 * 所以这里在把引用写进数据库之前，先把文件落盘。
 * @param {string} relativePath 形如 /uploads/test/cert_20259101.jpg
 */
function ensureTestImage(relativePath) {
  if (!relativePath || relativePath.indexOf('/uploads/test/') !== 0) return relativePath;
  const full = path.join(UPLOAD_ROOT, relativePath.replace('/uploads/', ''));
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) fs.writeFileSync(full, MIN_JPEG);
  } catch (err) {
    // 落盘失败不阻断接口调用（接口本身不校验文件），仅提示，避免测试脚本直接中断
    console.warn('[warn] 测试图片落盘失败：' + full + ' -> ' + err.message);
  }
  return relativePath;
}

/**
 * 递归扫描请求体，把所有 `/uploads/test/...` 路径对应的文件补落盘
 * ---------------------------------------------------------------------
 * 回归脚本会直接写死一批测试图片路径（任务图片 img1~img3、送达照片 deliveryImages 等），
 * 逐个改脚本既啰嗦又容易漏。统一在发请求前扫一遍请求体：
 * 只要值是以 `/uploads/test/` 开头的字符串，就保证磁盘上有对应文件。
 * 这样「数据库引用 <=> 磁盘文件」永远一致，垃圾清理器的引用保护断言才有意义。
 * @param {*} value 任意请求体片段
 * @param {number} [depth] 递归深度保护，避免异常结构导致栈溢出
 */
function ensureTestImagesDeep(value, depth) {
  const level = depth || 0;
  if (level > 5 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    ensureTestImage(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => ensureTestImagesDeep(item, level + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach((key) => ensureTestImagesDeep(value[key], level + 1));
  }
}
/**
 * 解析「当前后端日志文件」路径
 * ---------------------------------------------------------------------
 * 后端日志现在按天分文件（backend/logs/server-yyyyMMdd.out.log）：
 * cmd 的 ">>" 重定向会把文件独占锁定，只有按天换文件，
 * 重启后旧文件才会被释放、进而被每天的垃圾清理任务回收。
 * 图形验证码答案只写在日志里，测试脚本必须找到「当前正在写」的那一个，
 * 所以这里按「最近修改时间」挑选，并兼容旧的单文件路径与 BACKEND_LOG 环境变量。
 * @returns {string} 日志文件绝对路径
 */
function resolveLogFile() {
  if (process.env.BACKEND_LOG) return process.env.BACKEND_LOG;
  const logDir = 'D:/miniprogram123/backend/logs';
  try {
    const newest = fs
      .readdirSync(logDir)
      .filter((name) => /^server-.*\.out\.log$/.test(name))
      .map((name) => {
        const full = path.join(logDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) return newest.full;
  } catch (err) {
    // 目录不存在（例如仍是旧部署）则回退到旧路径
  }
  return 'D:/miniprogram123/backend/server.out.log';
}
/** 测试账号统一密码：满足「8-20 位且同时包含字母和数字」的强度要求 */
const DEFAULT_PASSWORD = process.env.TEST_PASSWORD || 'abc123456';
/** 管理员账号（学号命中 .env ADMIN_STUDENT_IDS 白名单） */
const ADMIN_ACCOUNT = process.env.TEST_ADMIN_ACCOUNT || process.env.INIT_ADMIN_STUDENT_ID || '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';
/** 测试账号统一密保答案：第 1 题自定义、第 2 题固定用 mymother */
const ANSWER_1 = 'ceshidaiima1';
const ANSWER_2 = 'mymother';

let seq = 0;

/** 生成测试请求用的唯一设备标识 */
function nextDeviceId(prefix) {
  seq += 1;
  return `${prefix || 'test'}-dev-${Date.now()}-${seq}`;
}

/**
 * 统一请求方法（http/https 通吃，兼容指向 cpolar 域名的场景）
 * @param {string} method HTTP 方法
 * @param {string} p 以 / 开头的路径
 * @param {object|null} body 请求体
 * @param {object} [options] { token, deviceId, deviceName, headers }
 */
async function request(method, p, body, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  headers['X-Device-Id'] = options.deviceId || 'helper-device';
  // HTTP 头只允许 ASCII：中文设备名（如「测试机B（新设备）」）必须 URL 编码，
  // 与小程序 utils/request.js 的做法保持一致，后端会 decodeURIComponent 还原
  if (options.deviceName) headers['X-Device-Name'] = encodeURIComponent(options.deviceName);

  // 发请求前先把请求体里出现的测试图片路径补落盘，保证库引用与磁盘一致
  ensureTestImagesDeep(body);

  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  const url = new URL(BASE + p);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(payload) }, headers)
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try {
          data = JSON.parse(raw);
        } catch (err) {
          data = { code: -1, msg: 'JSON解析失败', raw };
        }
        resolve(Object.assign({ status: res.statusCode }, data));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从后端日志里读取「本次请求之后」新写入的图形验证码答案
 * @param {number} offset 请求前的日志字节偏移量
 */
async function readCaptchaAnswer(offset) {
  // 一次解析、全程复用：避免在 40 次重试里反复读目录
  const logFile = resolveLogFile();
  for (let i = 0; i < 40; i += 1) {
    /* eslint-disable no-await-in-loop */
    let text = '';
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > offset) {
        const fd = fs.openSync(logFile, 'r');
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        text = buf.toString('utf8');
      }
    } catch (err) {
      text = '';
    }
    const matched = text.match(/生成的题目答案为 (-?\d+)/);
    if (matched) return matched[1];
    await sleep(50);
  }
  throw new Error(`未能从日志 ${logFile} 读到图形验证码答案（请确认后端已启动且日志路径正确）`);
}

/**
 * 获取一张图形验证码（返回 captchaId 与答案）
 * 说明：答案是通过读取后端日志拿到的，与人工「看着图片输入」等价，不改变服务端安全模型。
 */
async function captcha() {
  let offset = 0;
  try {
    offset = fs.statSync(resolveLogFile()).size;
  } catch (err) {
    offset = 0;
  }
  const res = await request('GET', '/api/user/captcha');
  if (res.code !== 200) throw new Error('获取图形验证码失败：' + (res.msg || res.code));
  const answer = await readCaptchaAnswer(offset);
  return { captchaId: res.data.captchaId, answer };
}

/** 随机生成一个未被占用的账号ID */
async function randomAccountNo() {
  const res = await request('GET', '/api/user/randomAccountNo');
  if (res.code !== 200) throw new Error('随机账号ID失败：' + (res.msg || res.code));
  return res.data.accountNo;
}

/** 校验账号ID是否可用 */
async function checkAccountNo(accountNo) {
  const res = await request('POST', '/api/user/checkAccountNo', { accountNo });
  return Boolean(res.data && res.data.available);
}

/**
 * 本地随机生成一个候选账号ID（X + 1~9999）
 * 说明：注册接口本身就是「账号ID 是否可用」的权威判定（唯一索引兜底），
 *      所以测试时本地造 ID + 撞车重试即可，不必批量调用「随机ID」接口（那个接口有 IP 限流）。
 */
function localAccountNo() {
  const n = Math.floor(Math.random() * 9999) + 1;
  return 'X' + String(n).padStart(4, '0');
}

/** 注册（自动带图形验证码与协议勾选；本地随机账号ID 撞车时自动换一个重试） */
async function register(options = {}) {
  const attempts = options.accountNo ? 1 : 4;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    /* eslint-disable no-await-in-loop */
    const cap = await captcha();
    const accountNo = options.accountNo || localAccountNo();
    const password = options.password || DEFAULT_PASSWORD;
    const deviceId = options.deviceId || nextDeviceId('reg');
    const body = {
      accountNo,
      password,
      captchaId: cap.captchaId,
      captchaCode: cap.answer,
      agreeProtocol: true,
      phone: options.phone || '',
      inviteCode: options.inviteCode || '',
      nickname: options.nickname || '',
      deviceId,
      deviceName: options.deviceName || '自动化测试机'
    };
    const res = await request('POST', '/api/user/register', body);
    last = { res, accountNo, password, deviceId };
    // 只有「账号ID 被占用」才换一个重试，其它错误（弱密码 / 手机号重复等）直接返回
    const takenConflict = res.code === 409 && /账号ID/.test(res.msg || '');
    if (res.code === 200 || options.accountNo || !takenConflict) return last;
  }
  return last;
}

/** 设置密保问题（注册后的强制步骤；更换密保时需要传当前答案） */
async function setSecurity(token, options = {}) {
  const questions = options.questions || [SECURITY_QUESTIONS[0], SECURITY_QUESTIONS[1]];
  const answers = options.answers || [ANSWER_1, ANSWER_2];
  const body = { questions, answers };
  if (options.currentAnswers) body.currentAnswers = options.currentAnswers;
  return request('POST', '/api/user/setSecurity', body, { token, deviceId: options.deviceId });
}

/**
 * 新设备登录解锁（用统一密保答案）
 * @param {string} unlockTicket 登录接口下发的解锁票据
 * @param {Array<string>} [answers] 两道密保答案
 * @param {object} [options] { deviceId, deviceName } 必须与发起登录时的一致，
 *        否则后端会把「解锁设备」当成另一台新设备，顶号提示里的设备名也会丢
 */
async function securityUnlock(unlockTicket, answers, options = {}) {
  return request('POST', '/api/user/securityUnlock', {
    unlockTicket,
    answer1: (answers && answers[0]) || ANSWER_1,
    answer2: (answers && answers[1]) || ANSWER_2
  }, { deviceId: options.deviceId, deviceName: options.deviceName });
}

/**
 * 登录（自动处理「新设备需要密保解锁」）
 * @returns {Promise<object>} 登录接口返回体（成功时含 accessToken）
 */
async function login(account, password, options = {}) {
  const deviceId = options.deviceId || nextDeviceId('login');
  const res = await request('POST', '/api/user/login', {
    account,
    password: password || DEFAULT_PASSWORD,
    deviceId,
    deviceName: options.deviceName || '自动化测试机'
  });
  if (res.code === 200 && res.data && res.data.needUnlock) {
    const unlocked = await securityUnlock(res.data.unlockTicket, options.answers, {
      deviceId,
      deviceName: options.deviceName || '自动化测试机'
    });
    if (unlocked.code === 200) {
      unlocked.data = Object.assign({}, unlocked.data, { deviceId });
      return unlocked;
    }
    return unlocked;
  }
  if (res.code === 200 && res.data) res.data.deviceId = deviceId;
  return res;
}

/** 提交校园认证申请（姓名 / 学号 / 手机号 / 截图） */
async function submitCampusCert(token, options) {
  // 自动生成的截图路径要先把文件真正落盘，保证「数据库引用 <=> 磁盘文件」一致
  const applyContent = ensureTestImage(
    options.img || `/uploads/test/cert_${options.studentId}.jpg`
  );
  return request('POST', '/api/audit/submit', {
    applyType: 3,
    certName: options.name,
    certStudentId: String(options.studentId),
    certPhone: options.phone,
    applyContent
  }, { token, deviceId: options.deviceId });
}

/** 管理员审核申请（status: 2 通过 / 3 驳回） */
async function handleAudit(adminToken, applyId, status, rejectReason) {
  return request('POST', '/api/audit/handle', {
    applyId,
    status: status === undefined ? 2 : status,
    rejectReason: rejectReason || ''
  }, { token: adminToken, deviceId: 'helper-admin' });
}

let cachedAdmin = null;
/** 取管理员令牌（真实库里的白名单管理员账号，账号 / 口令见 .env 的 TEST_ADMIN_*） */
async function adminToken() {
  if (cachedAdmin) return cachedAdmin;
  const res = await login(ADMIN_ACCOUNT, ADMIN_PASSWORD, { deviceId: 'helper-admin-device' });
  if (res.code !== 200 || !res.data.accessToken) {
    throw new Error(`管理员登录失败：${res.code} ${res.msg}（请确认 .env ADMIN_STUDENT_IDS 与账号 ${ADMIN_ACCOUNT} 的密码）`);
  }
  cachedAdmin = res.data.accessToken;
  return cachedAdmin;
}

/**
 * 创建一个「已注册 + 已设密保」的普通账号
 * @param {object} options { phone, accountNo, password, nickname, deviceId, setSecurity }
 */
async function createUser(options = {}) {
  const reg = await register(options);
  if (reg.res.code !== 200) throw new Error('注册失败：' + reg.res.msg + '（账号ID ' + reg.accountNo + '）');
  const token = reg.res.data.accessToken;
  if (options.setSecurity !== false) {
    const setRes = await setSecurity(token, { deviceId: reg.deviceId });
    if (setRes.code !== 200) throw new Error('设置密保失败：' + setRes.msg);
  }
  return {
    accountNo: reg.accountNo,
    password: reg.password,
    deviceId: reg.deviceId,
    userId: reg.res.data.user.userId,
    token,
    user: reg.res.data.user
  };
}

/**
 * 创建一个「已完成校园认证」的账号（可直接发布 / 接单）
 * @param {object} options { adminToken, name, studentId, phone, ... }
 */
async function createCertifiedUser(options = {}) {
  const user = await createUser(options);
  const apply = await submitCampusCert(user.token, {
    name: options.name || '测试用户',
    studentId: options.studentId,
    phone: options.phone || '',
    deviceId: user.deviceId
  });
  if (apply.code !== 200) throw new Error('提交校园认证失败：' + apply.msg);
  const admin = options.adminToken || await adminToken();
  const handled = await handleAudit(admin, apply.data.applyId, 2);
  if (handled.code !== 200) throw new Error('管理員审核失败：' + handled.msg);
  const info = await request('GET', '/api/user/info', null, { token: user.token, deviceId: user.deviceId });
  user.certApplyId = apply.data.applyId;
  user.info = info.data;
  return user;
}

/** 生成一个不会与真实用户冲突的测试手机号（11 位、1 开头） */
function testPhone(seed) {
  const s = seed === undefined ? Date.now() : seed;
  // 第 2 位取 3~9（符合 /^1[3-9]\d{9}$/ 校验），后 9 位用种子补零，保证同一批测试不重复
  const tail = String(s).padStart(9, '0').slice(-9);
  return '1' + (3 + (Number(s) % 7)) + tail;
}

/**
 * 清理测试账号（连同其任务、账单、消息、审核、设备记录一并删除）
 * 仅供本地测试收尾使用：按外键依赖顺序删除，避免触发约束错误。
 * @param {Array<string>} accountNos 账号ID列表，例如 ['X8001','X8002']
 */
async function purgeAccounts(accountNos) {
  if (!accountNos || !accountNos.length) return 0;
  const placeholders = accountNos.map(() => '?').join(',');
  const rows = await db.query(`SELECT id FROM users WHERE account_no IN (${placeholders})`, accountNos);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  const idPh = ids.map(() => '?').join(',');

  const tasks = await db.query(`SELECT id FROM tasks WHERE user_id IN (${idPh}) OR taker_user_id IN (${idPh})`, ids.concat(ids));
  const taskIds = tasks.map((t) => t.id);
  const taskPh = taskIds.length ? taskIds.map(() => '?').join(',') : null;

  await db.transaction(async (conn) => {
    if (taskIds.length) {
      await conn.execute(`DELETE FROM report WHERE task_id IN (${taskPh}) OR user_id IN (${idPh})`, taskIds.concat(ids));
      await conn.execute(`DELETE FROM user_bill WHERE task_id IN (${taskPh})`, taskIds);
      await conn.execute(`DELETE FROM payments WHERE task_id IN (${taskPh})`, taskIds);
    } else {
      await conn.execute(`DELETE FROM report WHERE user_id IN (${idPh})`, ids);
    }
    await conn.execute(`DELETE FROM user_bill WHERE user_id IN (${idPh})`, ids);
    await conn.execute(`DELETE FROM payments WHERE user_id IN (${idPh})`, ids);
    await conn.execute(`DELETE FROM messages WHERE user_id IN (${idPh})`, ids);
    await conn.execute(`DELETE FROM appeals WHERE user_id IN (${idPh})`, ids);
    await conn.execute(`DELETE FROM audit_apply WHERE user_id IN (${idPh})`, ids);
    // 顶号提示记录（user_kick）持有 users 外键，必须在删除用户之前清掉
    await conn.execute(`DELETE FROM user_kick WHERE user_id IN (${idPh})`, ids);
    await conn.execute(`DELETE FROM user_device WHERE user_id IN (${idPh})`, ids);
    if (taskIds.length) await conn.execute(`DELETE FROM tasks WHERE id IN (${taskPh})`, taskIds);
    await conn.execute(`DELETE FROM tasks WHERE user_id IN (${idPh}) OR taker_user_id IN (${idPh})`, ids.concat(ids));
    await conn.execute(`DELETE FROM users WHERE id IN (${idPh})`, ids);
  });
  return ids.length;
}

module.exports = {
  BASE,
  resolveLogFile,
  DEFAULT_PASSWORD,
  ANSWER_1,
  ANSWER_2,
  ADMIN_ACCOUNT,
  ADMIN_PASSWORD,
  request,
  sleep,
  captcha,
  localAccountNo,
  randomAccountNo,
  checkAccountNo,
  register,
  setSecurity,
  securityUnlock,
  login,
  submitCampusCert,
  handleAudit,
  adminToken,
  createUser,
  createCertifiedUser,
  testPhone,
  nextDeviceId,
  purgeAccounts
};
