/**
 * =====================================================================
 * 用户控制器：注册 / 登录 / 新设备解锁 / 密保设置 / 找回密码 / 刷新令牌 / 个人信息 / 图片上传
 * 业务规则要点：
 *  - 注册时用户自选账号ID（前缀固定 X + 1~4 位数字，可点「随机生成」），不再采集姓名与学号，
 *    姓名 / 学号在校园认证通过后写入 users 表
 *  - 短信验证码已整体下线（按条计费且个人开发者难以通过模板审核），改用「本地生成的算术图形验证码」防刷，成本为 0
 *  - 手机号改为选填联系方式，仅用于管理员人工联系，不参与登录与身份验证
 *  - 单一输入框双登录方式（账号ID 或 学号），后端自动识别；老账号仍可按手机号登录做兼容兜底
 *  - 注册后必须设置密保问题才能使用小程序（后端统一 428 拦截，前端引导跳转设置页）
 *  - 登录保护：常用设备（微信 openid / 设备指纹）直接放行，换设备必须答对 2 道密保才能登录
 *  - 单设备登录：新设备登录自动顶掉旧设备
 *  - 防暴力破解：连续错误 5 次锁定 15 分钟，错误提示不区分账号不存在/密码错误
 *  - 密码 bcrypt 哈希存储，数据库绝不出现明文
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../db/db');
const User = require('../models/User');
const Message = require('../models/Message');
const { hashPassword, comparePassword } = require('../utils/bcryptUtil');
const jwtUtil = require('../utils/jwtUtil');
const wxUtil = require('../utils/wxUtil');
const captchaUtil = require('../utils/captchaUtil');
const { isAdminStudent } = require('../middleware/auth');
// 客户端真实 IP（与限流中间件共用同一套取值逻辑，避免两处口径不一致）
const { getClientIp } = require('../middleware/rateLimit');
// IP 归属地（省-市）：设备管理展示 + 顶号提示中的「登录地点」
const { resolveRegion } = require('../utils/ipRegion');
// 顶号站内消息文案（字典模板 + 占位符填充）
const {
  buildKickMessage, buildKickNotice, normalizeIpForDisplay, resolveRegionLabel
} = require('../utils/kickUtil');
const {
  BIZ, MSG, CODE_MSG, CAMPUS_AUDIT_ENUM, MSG_TYPE_ENUM, SECURITY_QUESTIONS, ACCOUNT_NO_RULE
} = require('../utils/constant');
const {
  ok, fail, BizError, parseAccount, isPhone, assertParams,
  generateInviteCode, randomNickname, log, buildPage, parsePage,
  checkIdempotent, formatUserId, hashParams, buildAccountNo
} = require('../utils/common');

/** 上传根目录 */
const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

/**
 * 获取设备标识（单设备登录依据）
 * 优先取请求体，其次取请求头 x-device-id，都没有则生成一个
 */
function getDeviceId(req) {
  const raw = (req.body && req.body.deviceId) || req.headers['x-device-id'] || '';
  return String(raw).trim().slice(0, 100) || crypto.randomUUID();
}

/**
 * 获取设备名称（仅用于个人中心「设备管理」展示，不参与任何安全判定）
 * @param {import('express').Request} req
 * @returns {string}
 */
function getDeviceName(req) {
  // 请求体里的 deviceName 是 JSON 字符串，原样使用；
  // 请求头只能放 ASCII，前端用 encodeURIComponent 编码过中文，这里需要还原。
  const bodyName = req.body && req.body.deviceName;
  if (bodyName) return String(bodyName).trim().slice(0, 100);
  const headerName = req.headers['x-device-name'];
  if (!headerName) return '';
  try {
    return decodeURIComponent(String(headerName)).trim().slice(0, 100);
  } catch (err) {
    // 非法编码（第三方直接调用接口）时退回原始值，绝不让解析异常影响登录
    return String(headerName).trim().slice(0, 100);
  }
}

/**
 * 解析本次请求对应的微信 openid
 * @param {import('express').Request} req
 * @returns {Promise<string>} openid；未传 code / 换取失败时返回空串（自动回退设备指纹方案）
 */
async function resolveOpenid(req) {
  const code = (req.body && req.body.code) || req.headers['x-wx-code'] || '';
  const session = await wxUtil.code2Session(code);
  return session ? session.openid : '';
}

/**
 * 校验并规范化密码强度
 * 规则：8-20 位，且必须同时包含字母和数字（去掉短信后密码是第一道门，强度必须提高）
 * @param {string} password 明文密码
 * @returns {string} 校验通过的密码
 */
function assertPasswordStrength(password) {
  const pwd = String(password === undefined || password === null ? '' : password);
  if (pwd.length < BIZ.PASSWORD_MIN_LEN || pwd.length > BIZ.PASSWORD_MAX_LEN) {
    throw new BizError(MSG.PASSWORD_TOO_WEAK, 400);
  }
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) {
    throw new BizError(MSG.PASSWORD_TOO_WEAK, 400);
  }
  return pwd;
}

/**
 * 规范化密保答案（比对与存储都使用同一口径）
 * 规则：去掉所有空白字符 + 转小写，避免用户因为大小写 / 多打空格而反复失败
 * @param {string} value 用户输入的答案
 * @returns {string}
 */
function normalizeAnswer(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

/**
 * 校验密保答案是否符合收录要求
 * @param {string} question 密保问题
 * @param {string} answer 密保答案
 * @returns {string} 规范化后的答案
 */
function assertAnswerValid(question, answer) {
  const normalized = normalizeAnswer(answer);
  if (normalized.length < BIZ.SECURITY_ANSWER_MIN_LEN) {
    throw new BizError(MSG.SECURITY_ANSWER_TOO_SHORT, 400);
  }
  if (normalizeAnswer(question) === normalized) {
    throw new BizError(MSG.SECURITY_ANSWER_SAME_AS_QUESTION, 400);
  }
  return normalized;
}

/**
 * 规范化注册时用户自填的账号ID
 * 规则：前缀锁定为普通用户前缀 X，后缀 1-4 位数字；
 *      统一补零到 4 位（输入 x1 / X01 / X0001 都存成 X0001），超过 9999 不再补零。
 * @param {string} input 用户输入
 * @returns {string} 规范化后的账号ID
 */
function normalizeRegisterAccountNo(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim().toUpperCase();
  if (!raw) throw new BizError(MSG.ACCOUNT_NO_REQUIRED, 400);

  const prefix = ACCOUNT_NO_RULE.NORMAL_PREFIX;
  const pattern = new RegExp('^' + prefix + '(\\d{' + BIZ.ACCOUNT_NO_SUFFIX_MIN + ',' + BIZ.ACCOUNT_NO_SUFFIX_MAX + '})$');
  const matched = raw.match(pattern);
  if (!matched) throw new BizError(MSG.ACCOUNT_NO_INVALID, 400);

  const seq = Number(matched[1]);
  // 序号必须 ≥ 1：X0000 属于非法编号，避免与「空编号」产生歧义
  if (!Number.isSafeInteger(seq) || seq < 1) throw new BizError(MSG.ACCOUNT_NO_INVALID, 400);
  return buildAccountNo(seq, false);
}

/**
 * 按学号定位唯一账号（学号登录 / 数字输入兜底共用）
 * 学号在「校园认证通过」后才全局唯一，因此这里对多命中情况直接拒绝登录，
 * 提示改用账号ID，避免登入他人账号。
 * @param {string} studentId 学号
 * @returns {Promise<object|null>} 唯一命中的账号；未命中返回 null
 */
async function pickUniqueByStudentId(studentId) {
  const list = await User.findAllByStudentId(studentId);
  if (list.length > 1) throw new BizError(MSG.STUDENT_ID_MULTI, 400);
  return list[0] || null;
}

/**
 * 从题库中随机取 n 道互不重复的密保问题
 * 用途：忘记密码第一步在「账号不存在或未设密保」时返回随机题目，
 *      让攻击者无法通过题目差异判断账号是否存在（防账号枚举）。
 * @param {number} n 数量
 * @returns {string[]}
 */
function pickRandomQuestions(n) {
  const pool = SECURITY_QUESTIONS.slice();
  const picked = [];
  while (picked.length < n && pool.length) {
    const index = crypto.randomInt(0, pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/**
 * 登录 / 解锁成功后统一收尾：刷新最后登录时间、设备标识（顶掉旧设备）并绑定设备
 * ---------------------------------------------------------------------
 * 单设备登录下，新设备登录会让旧设备「静默失效」。旧设备的用户只会莫名掉线，
 * 既无法自证也发现不了盗号，因此这里补齐三件事：
 *   1) 记录本次登录的 IP 与归属地（「我的 - 设备管理」据此展示登录地点）；
 *   2) 若换了一台设备登录（顶号），为「被顶下线的旧设备」写一条提示记录，
 *      旧设备下次请求时会拿到「新设备名称 + 时间 + IP + 归属地」并弹窗告知本人；
 *   3) 同时推送一条站内消息留痕（用户当时不在设备前也能事后看到）。
 * @param {object} user 账号行
 * @param {object} context { deviceId, deviceName, openid, ip }
 * @returns {Promise<object>} 最新的账号行
 */
async function finishLogin(user, context) {
  const { deviceId, deviceName, openid, ip } = context;
  // IP 归属地解析：带 24 小时缓存、内网地址直接跳过、失败不影响登录（只显示 IP）
  const region = await resolveRegion(ip);

  const newDeviceId = String(deviceId || '');
  const previousDeviceId = String(user.login_device_id || '');
  // 只有「本次登录的设备与账号当前登录设备不同」才算顶号
  const isKick = !!previousDeviceId && previousDeviceId !== newDeviceId;
  let previousDeviceName = '';
  if (isKick) {
    const previous = await User.findDevice(user.id, previousDeviceId);
    previousDeviceName = (previous && previous.device_name) || '';
  }

  let kickId = 0;
  // 事务：更新账号登录态 + 绑定设备记录 + 顶号留痕，保证同时生效或同时不生效
  await db.transaction(async (conn) => {
    await User.updateLoginSuccess(user.id, deviceId, conn);
    await User.bindDevice({ userId: user.id, openid, deviceId, deviceName, ip, region }, conn);
    // 本设备重新登录成功：它历史上「未提示的顶号记录」已无意义，直接标记已读，避免旧提示又弹一次
    await User.clearDeviceKicks(user.id, newDeviceId, conn);
    if (isKick) {
      kickId = await User.createKick({
        userId: user.id,
        deviceId: previousDeviceId,
        deviceName: previousDeviceName,
        newDeviceId,
        newDeviceName: deviceName,
        ip,
        region
      }, conn);
    }
  });

  const freshUser = await User.findById(user.id);
  // 管理员白名单账号登录即自动认证（校园认证通过 + 管理员标识），无需再提交认证申请
  await User.autoCertifyAdmin(freshUser);

  // 站内消息留痕：放在事务之外，消息写入失败绝不能影响用户登录
  if (isKick && kickId) {
    try {
      const kick = await User.findKickById(kickId);
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: MSG.KICK_MESSAGE_TITLE,
        content: buildKickMessage(kick || {})
      });
    } catch (err) {
      log('error', '顶号站内消息写入失败：', err.message);
    }
  }
  return freshUser;
}

/**
 * 判断本次登录是否需要一个「新设备安全解锁」
 * 规则：
 *   1. 未设置密保 -> 放行（登录后由前端强制跳转设置密保页），否则用户会永久无法登录；
 *   2. 账号还没有任何绑定设备 -> 视为首次绑定，直接放行并记录；
 *   3. 微信 openid 或设备标识命中已绑定记录 -> 常用设备，直接放行；
 *   4. 其余情况 -> 需要答密保解锁。
 * @param {object} user 账号行
 * @param {{deviceId:string, openid:string}} context
 * @returns {Promise<boolean>} true = 需要密保解锁
 */
async function needSecurityUnlock(user, context) {
  if (!User.hasSecurity(user)) return false;
  if (context.openid && (await User.findDeviceByOpenid(user.id, context.openid))) return false;
  if (await User.findDevice(user.id, context.deviceId)) return false;
  if ((await User.countDevices(user.id)) === 0) return false;
  return true;
}

/**
 * 生成唯一邀请码（唯一索引冲突时重试）
 */
async function generateUniqueInviteCode(conn) {
  for (let i = 0; i < 5; i += 1) {
    const code = generateInviteCode();
    const rows = await conn.execute('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [code]);
    if (!rows[0].length) return code;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
}

/**
 * POST /api/user/register 注册
 * ---------------------------------------------------------------------
 * 入参：
 *   accountNo      账号ID（必填，用户自选，格式 X + 1~4 位数字，如 X0001）
 *   password       密码（必填，8-20 位且同时包含字母和数字）
 *   captchaId      图形验证码 ID（必填，由 GET /api/user/captcha 获取）
 *   captchaCode    图形验证码答案（必填）
 *   agreeProtocol  是否已勾选《用户服务协议》与《隐私政策》（必填）
 *   phone          手机号（选填，仅作联系方式，不参与身份验证）
 *   nickname       昵称（选填，不填则随机生成）
 *   inviteCode     邀请码（选填，填写后可获赠 7 天内 1 次快递免费代拿权益）
 *   deviceId / deviceName / code  设备信息（可选；code 为 wx.login 临时凭证，用于取 openid）
 * 说明：姓名与学号不在注册阶段采集，等校园认证通过后再写入 users 表；
 *      短信验证码通道已下线，注册改为「图形验证码 + 账号ID唯一性校验」防刷。
 */
async function register(req, res, next) {
  try {
    const { password, phone } = req.body;
    assertParams(req.body, [
      { name: 'accountNo', label: '账号ID' },
      { name: 'password', label: '密码' },
      { name: 'captchaId', label: '图形验证码' },
      { name: 'captchaCode', label: '验证码答案' }
    ]);

    // 必须勾选用户协议与隐私政策（前端可能传布尔值或字符串）
    const agreed = req.body.agreeProtocol === true || String(req.body.agreeProtocol) === 'true';
    if (!agreed) throw new BizError(MSG.NEED_PROTOCOL_AGREE, 400);

    // 幂等：3 秒内内容完全相同的重复提交（连点）直接拦截，避免同一账号被创建两次
    const idempotentKey = 'userRegister:' + hashParams({
      accountNo: String(req.body.accountNo || '').trim().toUpperCase(),
      phone: String(phone || '').trim(),
      password: String(password || '')
    });
    if (!checkIdempotent(idempotentKey, 3000)) throw new BizError(MSG.REPEAT_SUBMIT, 409);

    // 图形验证码：一次一用，校验通过后立即作废
    captchaUtil.assertCaptcha(req.body.captchaId, req.body.captchaCode);

    const accountNo = normalizeRegisterAccountNo(req.body.accountNo);
    const pwd = assertPasswordStrength(password);

    // 账号ID全局唯一（数据库唯一索引兜底，这里提前给出友好提示）
    if (await User.isAccountNoTaken(accountNo)) throw new BizError(MSG.ACCOUNT_NO_TAKEN, 409);

    // 手机号选填：填了就必须是合法 11 位手机号，且未被其他账号占用
    const phoneInput = String(phone === undefined || phone === null ? '' : phone).trim();
    let phoneValue = '';
    if (phoneInput) {
      if (!isPhone(phoneInput)) throw new BizError(MSG.PHONE_INVALID, 400);
      if (await User.findByPhone(phoneInput)) throw new BizError(MSG.PHONE_ALREADY_USED, 409);
      phoneValue = phoneInput;
    }

    // 邀请码（选填）：填写后注册即获赠「7 天内 1 次快递免费代拿」权益。
    // 校验放在事务外（只读查询），事务内只做「写」操作，缩短事务持有时间。
    const inviteCodeInput = String(req.body.inviteCode || '').trim().toUpperCase();
    let inviter = null;
    if (inviteCodeInput) {
      inviter = await User.findByInviteCode(inviteCodeInput);
      if (!inviter) throw new BizError(MSG.INVITE_CODE_INVALID, 400);
    }

    const passwordHash = await hashPassword(pwd);
    const nickname = (req.body.nickname && String(req.body.nickname).trim().slice(0, 30)) || randomNickname();

    // 事务：创建账号 + 生成邀请码 + 发放邀请奖励 + 站内消息，保证一致性
    const userId = await db.transaction(async (conn) => {
      const inviteCode = await generateUniqueInviteCode(conn);
      const newUserId = await User.create(
        {
          account_no: accountNo,
          // 姓名 / 学号不在注册阶段采集：统一写空串，等校园认证通过后由认证流程写入真实值
          student_id: '',
          name: '',
          password_hash: passwordHash,
          phone: phoneValue,
          nickname,
          invite_code: inviteCode
        },
        conn
      );

      // 填写了有效邀请码：记录邀请关系 + 赠送免费代拿次数（有效期 7 天，由数据库时间计算）
      if (inviter) {
        await User.grantInviteReward({
          userId: newUserId,
          inviterId: inviter.id,
          inviteCode: inviter.invite_code,
          count: BIZ.FREE_DELIVERY_COUNT,
          days: BIZ.FREE_DELIVERY_DAYS
        }, conn);

        // 站内消息文案与需求保持一致：写明邀请人的账号 ID
        await Message.create({
          userId: newUserId,
          msgType: MSG_TYPE_ENUM.SYSTEM,
          title: '邀请码奖励到账',
          content: `你成功填写了${inviter.account_no || inviter.id}的邀请码获得7天内快递免费代拿次数*1，仅限一件包裹`
        }, conn);
      }
      return newUserId;
    });

    // 注册即登录：绑定设备并签发双令牌（此时密保尚未设置，前端会强制跳转「设置密保」页面）
    const deviceId = getDeviceId(req);
    const openid = await resolveOpenid(req);
    const user = await finishLogin(
      { id: userId, student_id: '' },
      { deviceId, deviceName: getDeviceName(req), openid, ip: getClientIp(req) }
    );
    const tokens = jwtUtil.signTokenPair(userId, deviceId);

    return ok(res, {
      user: User.toSafeUser(user, isAdminStudent(user.student_id)),
      deviceId,
      ...tokens,
      // 明确告知前端：注册成功后必须先设置密保问题才能使用小程序
      needSetSecurity: true
    }, '注册成功');
  } catch (err) {
    // 并发场景：两个请求同时通过了「账号ID未占用」检查，唯一索引会拦下后到的那个，
    // 这里把数据库报错翻译成友好提示，绝不把 SQL 细节暴露给前端。
    if (err && err.code === 'ER_DUP_ENTRY') {
      const message = String(err.sqlMessage || err.message || '');
      if (message.indexOf('phone') >= 0) return next(new BizError(MSG.PHONE_ALREADY_USED, 409));
      if (message.indexOf('account_no') >= 0) return next(new BizError(MSG.ACCOUNT_NO_TAKEN, 409));
      return next(new BizError(MSG.ACCOUNT_NO_TAKEN, 409));
    }
    return next(err);
  }
}

/**
 * POST /api/user/login 登录（账号ID / 学号 双方式）
 * ---------------------------------------------------------------------
 * 入参：account（账号ID 或 学号）、password、deviceId / deviceName / code（可选）
 * 返回：
 *   1) 常规成功   ：{ user, deviceId, accessToken, refreshToken, needSetSecurity }
 *   2) 检测到新设备：{ needUnlock: true, unlockTicket, questions: [问题一, 问题二] }
 *      —— 此时不下发任何令牌，必须调用 /api/user/securityUnlock 答对密保后才能登录
 * 安全要点：账号不存在与密码错误统一返回「账号或密码错误」，防止账号枚举。
 */
async function login(req, res, next) {
  try {
    const { account, password } = req.body;
    assertParams(req.body, [{ name: 'account', label: '账号' }, { name: 'password', label: '密码' }]);

    // 后端自动识别输入类型，多条通道最终都定位到同一个 user_id：
    //   ① 账号编号（A0001 / X0001，大小写不敏感）
    //   ② 纯数字：6 位及以上优先当学号；1~5 位按主键 id（输入 0001 / 001 / 1 均命中 id=1 的账号）
    //   ③ 首选通道未命中时自动尝试另一条通道，兼容短学号（如学号 2333）与老账号手机号
    const parsed = parseAccount(account);
    let user = null;
    if (parsed.type === 'account') {
      user = await User.findByAccountNo(parsed.value);
    } else if (parsed.type === 'studentId') {
      user = await pickUniqueByStudentId(parsed.value);
      if (!user) {
        const num = Number(String(parsed.value).replace(/^0+/, ''));
        if (Number.isSafeInteger(num) && num > 0) user = await User.findById(num);
      }
      // 兼容老账号：11 位纯数字仍允许按手机号兜底（老用户可能只记得手机号）
      if (!user && parsed.raw.length === 11) user = await User.findByPhone(parsed.raw);
    } else if (parsed.type === 'id') {
      user = await User.findById(parsed.value);
      // 兼容短学号：例如学号为 2333 的账号，输入 2333 会先被当成内部编号
      if (!user) user = await pickUniqueByStudentId(parsed.raw);
    }

    // 账号不存在与密码错误统一提示，防止账号枚举
    if (!user) throw new BizError(MSG.LOGIN_FAILED, 400);

    // 已注销账号：直接拒绝登录（注销不可恢复）。
    // 注销时手机号 / 学号已被释放，只有本人记得的账号编号能定位到该账号，因此不存在账号枚举风险。
    if (User.isDeactivatedUser(user)) throw new BizError(MSG.ACCOUNT_DEACTIVATED, 423);

    // 锁定期内无论密码正确与否，统一返回锁定提示
    if (User.isLoginLocked(user)) throw new BizError(MSG.ACCOUNT_LOCKED, 423);

    const match = await comparePassword(password, user.password_hash);
    if (!match) {
      const failCount = await User.increaseLoginFail(user.id);
      if (failCount >= BIZ.LOGIN_FAIL_LIMIT) {
        await User.lockLogin(user.id, BIZ.LOGIN_LOCK_MINUTES);
        log('warn', `账号 ${user.id} 连续密码错误${failCount}次，已锁定${BIZ.LOGIN_LOCK_MINUTES}分钟`);
        throw new BizError(MSG.ACCOUNT_LOCKED, 423);
      }
      throw new BizError(MSG.LOGIN_FAILED, 400);
    }

    const deviceId = getDeviceId(req);
    const deviceName = getDeviceName(req);
    const openid = await resolveOpenid(req);

    // 新设备保护：常用设备（openid 或设备指纹命中）直接放行；
    // 换设备必须答对 2 道密保，避免密码泄漏后被陌生人直接登录。
    if (await needSecurityUnlock(user, { deviceId, openid })) {
      if (User.isSecurityLocked(user)) throw new BizError(MSG.SECURITY_LOCKED, 423);
      // 密码已经证明正确，顺手清零连续错误次数与登录锁定
      await User.unlockLogin(user.id);
      const unlockTicket = jwtUtil.signUnlockTicket(user.id, deviceId, openid);
      return ok(res, {
        needUnlock: true,
        unlockTicket,
        expireMinutes: BIZ.SECURITY_UNLOCK_TICKET_MINUTES,
        // 只下发密保问题文本，答案哈希绝不外泄
        questions: [user.sec_question1 || '', user.sec_question2 || '']
      }, MSG.NEED_SECURITY_UNLOCK);
    }

    // 登录成功：清零错误计数、解除锁定、更新设备标识（顶掉旧设备）并绑定本设备
    const freshUser = await finishLogin(user, { deviceId, deviceName, openid, ip: getClientIp(req) });
    const tokens = jwtUtil.signTokenPair(user.id, deviceId);

    return ok(res, {
      user: User.toSafeUser(freshUser, isAdminStudent(freshUser.student_id)),
      deviceId,
      ...tokens,
      // 未设置密保时提示前端强制跳转「设置密保」页面
      needSetSecurity: !User.hasSecurity(freshUser) && !isAdminStudent(freshUser.student_id)
    }, '登录成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/refreshToken 刷新令牌
 * access_token 过期后用 refresh_token 换取新的双令牌
 */
async function refreshToken(req, res, next) {
  try {
    const refresh = req.body.refreshToken || req.headers['x-refresh-token'];
    assertParams({ refreshToken: refresh }, [{ name: 'refreshToken', label: '刷新令牌' }]);

    const payload = jwtUtil.verifyRefreshToken(refresh);
    if (!payload || !payload.userId) throw new BizError(CODE_MSG[401], 401);

    const user = await User.findById(payload.userId);
    if (!user) throw new BizError(CODE_MSG[401], 401);
    // 已注销账号不允许再刷新令牌，保证注销后存量 refresh_token 一并作废
    if (User.isDeactivatedUser(user)) throw new BizError(MSG.ACCOUNT_DEACTIVATED, 401);
    if (User.isLoginLocked(user)) throw new BizError(MSG.ACCOUNT_LOCKED, 423);

    // 单设备登录：刷新令牌的设备必须仍是当前登录设备
    if (user.login_device_id && payload.deviceId && user.login_device_id !== payload.deviceId) {
      // 被新设备顶下线：把「新设备名称 / 时间 / IP / 归属地」一并返回，
      // 前端收到后弹窗告知本人。
      // ⚠ 与 auth.js 保持一致：不在这里标记已读，否则前端链路（先刷新令牌再弹窗）
      //   会把提示提前消费掉，最终只弹出一段全「未知」的无意义内容。
      let kickData = null;
      try {
        const kick = await User.findLatestUnreadKick(user.id, payload.deviceId);
        if (kick) kickData = buildKickNotice(kick);
      } catch (err) {
        log('error', '顶号提示读取失败：', err.message);
      }
      return fail(res, 401, MSG.KICKED_BY_NEW_DEVICE, kickData || undefined);
    }

    const tokens = jwtUtil.signTokenPair(user.id, payload.deviceId || '');
    return ok(res, { ...tokens }, '刷新成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/user/info 获取当前登录用户信息
 */
async function info(req, res, next) {
  try {
    const user = req.user;
    const isAdmin = isAdminStudent(user.student_id);
    // 管理员账号自动认证，与普通用户认证通过后的权限完全一致
    const certified = isAdmin || user.is_campus_audit === CAMPUS_AUDIT_ENUM.PASS;
    const unread = await Message.countUnread(user.id);
    return ok(res, {
      user: User.toSafeUser(user, isAdmin),
      unreadCount: unread,
      // 未设置密保的普通账号：前端必须强制跳转「设置密保」页面（后端其它业务接口同步 428 拦截）
      needSetSecurity: !isAdmin && !User.hasSecurity(user),
      canPublish: certified,
      canTake: certified && !User.isBannedFromTaking(user)
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/user/captcha 获取图形验证码（无需登录）
 * ---------------------------------------------------------------------
 * 短信验证码已整体下线，改用服务端本地生成的算术题图片（PNG，直接给小程序 image 组件渲染）：
 *   1) 成本为 0，不依赖任何第三方服务与账号资质；
 *   2) 答案只存服务端内存，不返回前端；
 *   3) 有效期 5 分钟、一次一用，接口层另有 IP 限流（1 小时 20 次）。
 * 使用场景：注册、忘记密码（两步都校验）、新设备解锁不必重复获取。
 */
function captcha(req, res, next) {
  try {
    const result = captchaUtil.createCaptcha();
    // 本地调试便利：把答案打到服务端日志，方便在终端直接看到题目答案
    log('info', `【图形验证码】生成的题目答案为 ${result.answer}`);
    return ok(res, {
      captchaId: result.captchaId,
      image: result.image,
      expireMinutes: result.expireMinutes
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/user/randomAccountNo 注册页「随机生成」按钮
 * 返回一个未被占用的账号ID（X + 4 位数字），与用户手填走完全相同的格式与唯一性校验。
 */
async function randomAccountNo(req, res, next) {
  try {
    const accountNo = await User.randomAvailableAccountNo();
    if (!accountNo) throw new BizError(MSG.ACCOUNT_NO_RANDOM_FAILED, 500);
    return ok(res, { accountNo });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/checkAccountNo 注册页实时校验账号ID是否可注册
 * 入参：accountNo
 * 返回：{ available: boolean, accountNo: '规范化后的账号ID' }
 * 说明：这里只需要「账号ID是否被占用」这一条信息，不涉及任何隐私数据，因此允许匿名调用（带限流）。
 */
async function checkAccountNo(req, res, next) {
  try {
    assertParams(req.body, [{ name: 'accountNo', label: '账号ID' }]);
    const accountNo = normalizeRegisterAccountNo(req.body.accountNo);
    const taken = await User.isAccountNoTaken(accountNo);
    return ok(res, { available: !taken, accountNo });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/securityQuestions 忘记密码第一步：取该账号的 2 道密保问题
 * ---------------------------------------------------------------------
 * 入参：account（账号ID）、captchaId、captchaCode
 * 返回：{ questions: [问题一, 问题二], needIdentity, resetTicket, expireMinutes }
 *   needIdentity = true 表示该账号已通过校园认证，第二步必须额外填写学号与姓名
 * 防账号枚举：账号不存在或未设置密保时，同样返回题库中随机挑的 2 道题（前端无感知），
 *            真正的校验在第二步统一失败，攻击者无法通过题目差异判断账号是否存在。
 * 流程串联：本接口签发 10 分钟有效的 reset_ticket，第二步凭票据提交，避免重复暴露账号信息。
 */
async function securityQuestions(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'account', label: '账号ID' },
      { name: 'captchaId', label: '图形验证码' },
      { name: 'captchaCode', label: '验证码答案' }
    ]);

    // 图形验证码：一次一用，防止脚本批量试探密保问题
    captchaUtil.assertCaptcha(req.body.captchaId, req.body.captchaCode);

    const accountNo = String(req.body.account || '').trim().toUpperCase();
    const user = await User.findByAccountNo(accountNo);

    let questions;
    let needIdentity;
    if (user && User.hasSecurity(user)) {
      questions = [user.sec_question1 || '', user.sec_question2 || ''];
      // 已通过校园认证的账号：学号与姓名已写入 users 表，重置时必须一并核对
      needIdentity = Number(user.is_campus_audit) === CAMPUS_AUDIT_ENUM.PASS;
    } else {
      // 账号不存在 / 未设置密保：返回随机题目，避免泄漏账号存在性
      questions = pickRandomQuestions(BIZ.SECURITY_QUESTION_COUNT);
      needIdentity = false;
    }

    return ok(res, {
      questions,
      needIdentity,
      resetTicket: jwtUtil.signResetTicket(user && User.hasSecurity(user) ? user.id : 0, needIdentity),
      expireMinutes: 10
    }, '请回答密保问题');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/resetPassword 忘记密码第二步：校验密保并重置密码
 * ---------------------------------------------------------------------
 * 入参：
 *   resetTicket  第一步返回的一次性票据（10 分钟有效）
 *   answer1/answer2  两道密保答案
 *   studentId/name   已认证账号必填，必须与库中真实学号 / 姓名完全一致
 *   newPassword      新密码（8-20 位且同时包含字母和数字）
 *   captchaId/captchaCode 第二步同样校验图形验证码，防止脚本爆破密保答案
 * 安全设计：
 *   1) 所有失败场景统一返回「账号信息校验失败」，不区分账号不存在 / 密保错误 / 学号姓名不符；
 *   2) 密保答案连续答错 5 次锁定 15 分钟（与登录锁定相互独立）；
 *   3) 同一账号 24 小时内只能重置一次密码；
 *   4) 重置成功后清空设备标识，所有旧设备令牌立即失效，并推送站内消息提醒。
 */
async function resetPassword(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'resetTicket', label: '安全校验票据' },
      { name: 'answer1', label: '密保答案一' },
      { name: 'answer2', label: '密保答案二' },
      { name: 'newPassword', label: '新密码' },
      { name: 'captchaId', label: '图形验证码' },
      { name: 'captchaCode', label: '验证码答案' }
    ]);

    captchaUtil.assertCaptcha(req.body.captchaId, req.body.captchaCode);

    const ticket = jwtUtil.verifyResetTicket(req.body.resetTicket);
    if (!ticket) throw new BizError(MSG.UNLOCK_TICKET_INVALID, 400);

    const newPwd = assertPasswordStrength(req.body.newPassword);

    // 幂等：3 秒内完全相同的重复提交直接拦截
    if (!checkIdempotent('userResetPwd:' + hashParams({
      userId: ticket.userId,
      answer1: String(req.body.answer1 || ''),
      answer2: String(req.body.answer2 || '')
    }), 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const user = ticket.userId ? await User.findById(ticket.userId) : null;
    if (!user || !User.hasSecurity(user)) throw new BizError(MSG.RESET_ACCOUNT_FAILED, 400);

    // 密保锁定期内直接拒绝（无论答案对错）
    if (User.isSecurityLocked(user)) throw new BizError(MSG.SECURITY_LOCKED, 423);

    // 24 小时内只能重置一次
    const lastReset = await User.getResetPwdTime(user.id);
    if (lastReset
      && Date.now() - new Date(lastReset).getTime() < BIZ.RESET_PWD_LIMIT_HOURS * 60 * 60 * 1000) {
      throw new BizError(MSG.RESET_TOO_FREQ, 409);
    }

    // 两道密保答案都校验（不短路，避免通过响应耗时推测哪一道答对）
    const pass1 = await comparePassword(normalizeAnswer(req.body.answer1), user.sec_answer1_hash);
    const pass2 = await comparePassword(normalizeAnswer(req.body.answer2), user.sec_answer2_hash);

    // 已认证账号：额外核对真实学号 + 姓名
    let identityPass = true;
    if (ticket.needIdentity) {
      const studentId = String(req.body.studentId || '').trim();
      const name = String(req.body.name || '').trim();
      identityPass = Boolean(studentId)
        && Boolean(name)
        && studentId === String(user.student_id || '').trim()
        && name === String(user.name || '').trim();
    }

    if (!pass1 || !pass2 || !identityPass) {
      const failCount = await User.increaseSecurityFail(user.id);
      if (failCount >= BIZ.SECURITY_FAIL_LIMIT) {
        await User.lockSecurity(user.id, BIZ.SECURITY_LOCK_MINUTES);
        log('warn', `账号 ${user.id} 密保验证连续错误${failCount}次，已锁定${BIZ.SECURITY_LOCK_MINUTES}分钟`);
        throw new BizError(MSG.SECURITY_LOCKED, 423);
      }
      // 统一失败提示，不区分具体哪一项不正确
      throw new BizError(MSG.RESET_ACCOUNT_FAILED, 400);
    }

    const passwordHash = await hashPassword(newPwd);
    // 事务：更新密码 + 清空设备标识（强制所有设备重新登录） + 站内消息提醒
    await db.transaction(async (conn) => {
      await User.resetPasswordBySecurity(user.id, passwordHash, conn);
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '密码重置成功',
        content: '你的账号已通过密保问题重置密码，所有设备需重新登录。如非本人操作，请立即联系管理员。'
      }, conn);
    });

    log('info', `账号 ${user.id}（${user.account_no}）通过密保问题重置了密码`);
    return ok(res, null, '密码重置成功，请用新密码登录');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/setSecurity 设置 / 更换密保问题（需登录）
 * ---------------------------------------------------------------------
 * 入参：
 *   questions  [问题一, 问题二]  必填，可选题库内置题，也可自行填写自定义问题，两道不能相同
 *   answers    [答案一, 答案二]  必填，每个答案至少 2 个字符，不能与问题内容相同
 *   currentAnswers [当前答案一, 当前答案二] 已设置过密保时必填，用于验证身份后再更换
 * 说明：
 *   1) 注册后必须完成设置才能使用小程序（后端其它业务接口统一返回 428 拦截）；
 *   2) 答案统一「去空格 + 转小写」后 bcrypt 哈希存储，数据库绝不出现明文；
 *   3) 更换密保属于高风险操作，必须先通过当前密保验证，防止令牌被盗后直接换绑；
 *   4) 自定义问题属于用户输入，写库前已由全局 xssFilter 完成 HTML 转义（< > & " '），
 *      这里只做「转义后」的长度与重复校验，保证落库文本既能安全回显、又不会超出字段长度。
 */
async function setSecurity(req, res, next) {
  try {
    const user = req.user;
    // 全局 xssFilter 已对 body 中的字符串做 HTML 转义，这里只做 trim 规范化，绝不二次转义（避免 &amp;lt; 之类的双重转义）
    const questions = Array.isArray(req.body.questions)
      ? req.body.questions.map((q) => String(q).trim())
      : [];
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (questions.length !== BIZ.SECURITY_QUESTION_COUNT
      || answers.length !== BIZ.SECURITY_QUESTION_COUNT) {
      throw new BizError(MSG.SECURITY_QUESTION_INVALID, 400);
    }
    if (questions[0] === questions[1]) throw new BizError(MSG.SECURITY_QUESTION_DUPLICATE, 400);
    // 逐题校验：命中题库的题直接放行；非题库的题视为用户自定义问题，按长度上下限约束
    // 注意：长度校验必须在 HTML 转义之后进行（转义会让 & < > " ' 变长），否则可能溢出 users.sec_question1 VARCHAR(50)
    questions.forEach((question) => {
      if (!question) throw new BizError(MSG.SECURITY_QUESTION_INVALID, 400);
      // 题库内置题：文本固定且远短于上限，无需再做长度判断
      if (SECURITY_QUESTIONS.indexOf(question) >= 0) return;
      if (question.length < BIZ.SECURITY_QUESTION_MIN_LEN) {
        throw new BizError(MSG.SECURITY_QUESTION_TOO_SHORT, 400);
      }
      if (question.length > BIZ.SECURITY_QUESTION_MAX_LEN) {
        throw new BizError(MSG.SECURITY_QUESTION_TOO_LONG, 400);
      }
    });

    const answer1 = assertAnswerValid(questions[0], answers[0]);
    const answer2 = assertAnswerValid(questions[1], answers[1]);
    if (answer1 === answer2) throw new BizError(MSG.SECURITY_ANSWER_SAME_AS_QUESTION, 400);

    // 已有密保：必须先通过现有密保验证（防止令牌被盗后直接换绑密保）
    if (User.hasSecurity(user)) {
      if (User.isSecurityLocked(user)) throw new BizError(MSG.SECURITY_LOCKED, 423);
      const current = Array.isArray(req.body.currentAnswers) ? req.body.currentAnswers : [];
      const currentPass1 = current.length > 0
        && await comparePassword(normalizeAnswer(current[0]), user.sec_answer1_hash);
      const currentPass2 = current.length > 1
        && await comparePassword(normalizeAnswer(current[1]), user.sec_answer2_hash);
      if (!currentPass1 || !currentPass2) {
        const failCount = await User.increaseSecurityFail(user.id);
        if (failCount >= BIZ.SECURITY_FAIL_LIMIT) {
          await User.lockSecurity(user.id, BIZ.SECURITY_LOCK_MINUTES);
          throw new BizError(MSG.SECURITY_LOCKED, 423);
        }
        throw new BizError(MSG.SECURITY_ANSWER_WRONG, 400);
      }
    }

    // 幂等：3 秒内完全相同的重复提交直接拦截
    if (!checkIdempotent(`userSetSecurity:${user.id}:${hashParams({ questions, answers })}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const [answer1Hash, answer2Hash] = await Promise.all([
      hashPassword(answer1),
      hashPassword(answer2)
    ]);

    await User.setSecurity(user.id, {
      question1: questions[0],
      answer1Hash,
      question2: questions[1],
      answer2Hash
    });

    return ok(res, {
      questions,
      securitySet: 1
    }, User.hasSecurity(user) ? '密保问题已更新' : '密保问题设置成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/securityUnlock 新设备登录解锁（无需登录，凭登录时下发的 unlockTicket）
 * ---------------------------------------------------------------------
 * 入参：unlockTicket（登录接口在检测到新设备时下发）、answer1、answer2
 * 返回：正式双令牌 + 用户信息（解锁成功后本设备自动成为常用设备）
 * 安全设计：
 *   1) 票据 10 分钟过期、一次性使用（解锁成功后票据对应的账号设备绑定即完成，重复提交无副作用）；
 *   2) 两道密保答案都校验，任一错误即累计失败次数，连续 5 次锁定 15 分钟；
 *   3) 不解锁任何账号信息，避免攻击者通过响应对比探测答案。
 */
async function securityUnlock(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'unlockTicket', label: '安全验证票据' },
      { name: 'answer1', label: '密保答案一' },
      { name: 'answer2', label: '密保答案二' }
    ]);

    const ticket = jwtUtil.verifyUnlockTicket(req.body.unlockTicket);
    if (!ticket || !ticket.userId) throw new BizError(MSG.UNLOCK_TICKET_INVALID, 400);

    const user = await User.findById(ticket.userId);
    if (!user || !User.hasSecurity(user)) throw new BizError(MSG.UNLOCK_TICKET_INVALID, 400);
    if (User.isDeactivatedUser(user)) throw new BizError(MSG.ACCOUNT_DEACTIVATED, 423);
    if (User.isSecurityLocked(user)) throw new BizError(MSG.SECURITY_LOCKED, 423);

    // 幂等：3 秒内的重复提交直接拦截
    if (!checkIdempotent(`securityUnlock:${user.id}:${hashParams({
      answer1: String(req.body.answer1 || ''),
      answer2: String(req.body.answer2 || '')
    })}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const pass1 = await comparePassword(normalizeAnswer(req.body.answer1), user.sec_answer1_hash);
    const pass2 = await comparePassword(normalizeAnswer(req.body.answer2), user.sec_answer2_hash);
    if (!pass1 || !pass2) {
      const failCount = await User.increaseSecurityFail(user.id);
      if (failCount >= BIZ.SECURITY_FAIL_LIMIT) {
        await User.lockSecurity(user.id, BIZ.SECURITY_LOCK_MINUTES);
        log('warn', `账号 ${user.id} 新设备解锁连续错误${failCount}次，已锁定${BIZ.SECURITY_LOCK_MINUTES}分钟`);
        throw new BizError(MSG.SECURITY_LOCKED, 423);
      }
      throw new BizError(MSG.SECURITY_ANSWER_WRONG, 400);
    }

    // 解锁成功：清零密保错误次数，绑定本设备并签发正式令牌
    await User.clearSecurityFail(user.id);
    const deviceId = ticket.deviceId || getDeviceId(req);
    const freshUser = await finishLogin(user, {
      deviceId,
      deviceName: getDeviceName(req),
      openid: ticket.openid || await resolveOpenid(req),
      ip: getClientIp(req)
    });
    const tokens = jwtUtil.signTokenPair(user.id, deviceId);

    // 站内消息提醒：让账号主人知道有新设备登录（无法识别时应尽快改密码）
    await Message.create({
      userId: user.id,
      msgType: MSG_TYPE_ENUM.SYSTEM,
      title: '新设备登录提醒',
      content: `你的账号在新设备上通过密保验证登录了${getDeviceName(req) ? '（' + getDeviceName(req) + '）' : ''}，如非本人操作请立即修改密码。`
    });

    return ok(res, {
      user: User.toSafeUser(freshUser, isAdminStudent(freshUser.student_id)),
      deviceId,
      ...tokens,
      needSetSecurity: false
    }, '安全验证通过，登录成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/user/devices 我绑定的设备列表（个人中心「设备管理」）
 * 说明：返回设备名称、最近登录时间与「登录地点（省-市）」，
 *       openid 不返回（避免敏感标识外泄）；登录 IP 一并下发，便于用户识别陌生设备。
 */
async function deviceList(req, res, next) {
  try {
    const rows = await User.listDevices(req.user.id);
    const currentDeviceId = req.deviceId || '';
    const list = rows.map((row) => {
      const region = String(row.login_region || '').trim();
      // IP 剥掉 IPv6 映射前缀（::ffff:），归属地在解析失败时给出「局域网 / 未知地点」，
      // 保证「我的 - 设备管理」展示的一定是可直接理解的内容
      const ip = normalizeIpForDisplay(row.login_ip);
      return {
        id: row.id,
        // 设备标识：前端本地也存着一份，这里一并下发，便于「哪台是本机」的判断与自动化测试定位
        deviceId: row.device_id || '',
        deviceName: row.device_name || '未知设备',
        // 当前设备打标，前端展示为「本机」且不允许解绑
        isCurrent: String(row.device_id) === String(currentDeviceId),
        // 登录地点：省-市（如「湖北-随州」）/ 局域网 / 未知地点
        loginRegion: resolveRegionLabel(region, ip),
        loginIp: ip,
        lastLoginTime: row.last_login_time,
        createdAt: row.created_at
      };
    });
    return ok(res, { list, total: list.length });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/unbindDevice 解绑设备
 * 入参：deviceRowId（user_device 主键）
 * 规则：只能解绑自己的设备；至少保留 1 台，否则账号将无法在本机直接登录（必须答密保）。
 */
async function unbindDevice(req, res, next) {
  try {
    assertParams(req.body, [{ name: 'deviceRowId', label: '设备记录ID' }]);
    const deviceRowId = Number(req.body.deviceRowId);
    if (!Number.isSafeInteger(deviceRowId) || deviceRowId <= 0) {
      throw new BizError(MSG.DEVICE_NOT_FOUND, 400);
    }

    const total = await User.countDevices(req.user.id);
    if (total <= 1) throw new BizError(MSG.DEVICE_UNBIND_LAST_FORBIDDEN, 409);

    const result = await User.deleteDevice(req.user.id, deviceRowId);
    if (!result.affectedRows) throw new BizError(MSG.DEVICE_NOT_FOUND, 404);

    return ok(res, null, '设备已解绑');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/deactivate 注销当前登录账号（不可恢复）
 * ---------------------------------------------------------------------
 * 请求体：password（必填，当前账号的登录密码，用于二次身份确认）
 *
 * 【业务规则】
 *   1. 仅能注销「当前登录账号」本身，不接受任何他人 userId（天然防越权）；
 *   2. 必须校验登录密码：防止 access_token 泄漏后被第三方恶意注销；
 *   3. 管理员账号不可注销（权限与白名单学号绑定），需要先由运维调整 .env 白名单；
 *   4. 注销后手机号 / 学号被释放，可被新账号重新注册使用；历史任务 / 账单记录保留；
 *   5. 幂等：3 秒内完全相同的请求视为连点，直接返回冲突提示。
 *
 * 【数据一致性】
 *   多字段原子写操作，统一放在事务内完成（bcrypt 校验在事务外，避免长时间持有行锁）。
 */
async function deactivate(req, res, next) {
  try {
    const current = req.user;
    const password = req.body.password === undefined || req.body.password === null
      ? '' : String(req.body.password);
    assertParams({ password }, [{ name: 'password', label: '登录密码' }]);

    // 幂等：同一账号 3 秒内提交「完全相同」的请求视为连点，直接拦截。
    // 幂等键必须带上密码摘要：否则用户第一次输错密码（返回 400）后，
    // 紧接着输对密码会被误判为重复提交，导致合法用户无法注销。
    if (!checkIdempotent(`userDeactivate:${current.id}:${hashParams({ password })}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // 密码校验放在事务外：bcrypt 约几十毫秒，避免长时间占用行锁
    const match = await comparePassword(password, current.password_hash);
    if (!match) throw new BizError(MSG.DEACTIVATE_PASSWORD_WRONG, 400);

    const result = await db.transaction(async (conn) => {
      const target = await User.findByIdForUpdate(current.id, conn);
      if (!target) throw new BizError(CODE_MSG[401], 401);
      if (User.isDeactivatedUser(target)) throw new BizError(MSG.ACCOUNT_DEACTIVATED_ALREADY, 409);
      if (isAdminStudent(target.student_id)) throw new BizError(MSG.DEACTIVATE_ADMIN_FORBIDDEN, 403);

      const affected = await User.deactivate(target.id, conn);
      if (!affected) throw new BizError(MSG.ACCOUNT_DEACTIVATED_ALREADY, 409);

      return {
        userId: target.id,
        userIdText: formatUserId(target.id, target.account_no)
      };
    });

    log('info', `用户 ${result.userId}（${result.userIdText}）主动注销账号`);
    return ok(res, result, '账号已注销，感谢使用');
  } catch (err) {
    return next(err);
  }
}

/**
 * 校验图片文件头（防止伪造后缀上传非法文件）
 * @param {Buffer} buf 文件内容
 * @returns {'jpg'|'png'|'webp'|null}
 */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * POST /api/user/uploadImage 上传图片
 * 限制：单张最大 2MB，仅支持 jpg / png / webp，且必须通过文件头校验
 */
/**
 * 校验并保存图片二进制内容（multipart 与 base64 两条上传通道共用）
 *  - 大小上限：UPLOAD_MAX_SIZE（默认 2MB）
 *  - 格式校验：读文件头（magic number），不信任文件名后缀
 *  - 存储：uploads/YYYYMM/时间戳_随机串.扩展名
 * @param {Buffer} buffer 图片二进制内容
 * @returns {string} 可访问的相对地址，如 /uploads/202609/xxx.png
 */
function saveImageBuffer(buffer) {
  if (!buffer || !buffer.length) throw new BizError('请选择要上传的图片');

  const maxSize = Number(process.env.UPLOAD_MAX_SIZE || BIZ.MAX_UPLOAD_SIZE);
  if (buffer.length > maxSize) throw new BizError('图片大小不能超过2MB');

  const ext = detectImageType(buffer);
  if (!ext) throw new BizError('仅支持 jpg / png / webp 格式的图片');

  // 按月分目录存储，文件名使用时间戳 + 随机串，避免冲突与目录遍历
  const now = new Date();
  const monthDir = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(UPLOAD_ROOT, monthDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);

  return `/uploads/${monthDir}/${fileName}`;
}

/**
 * POST /api/user/uploadImage 上传图片（主通道：multipart/form-data）
 * 限制：单张最大 2MB，仅支持 jpg / png / webp，且必须通过文件头校验
 */
async function uploadImage(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) throw new BizError('请选择要上传的图片');
    const url = saveImageBuffer(req.file.buffer);
    return ok(res, { url, fullUrl: `${req.protocol}://${req.get('host')}${url}` }, '上传成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/user/uploadImageBase64 上传图片（备用通道：base64 + JSON）
 * 场景：小程序端 wx.uploadFile 被微信拦截（例如域名未加入 uploadFile 合法域名）时，
 *      前端会自动降级走 wx.request 通道，保证图片仍然可以上传成功。
 * 参数：{ base64: '图片 base64（可带 data:image/png;base64, 前缀）' }
 */
async function uploadImageBase64(req, res, next) {
  try {
    const raw = String((req.body && (req.body.base64 || req.body.data)) || '');
    if (!raw) throw new BizError('请选择要上传的图片');

    // 兼容 dataURL 前缀写法：data:image/png;base64,xxxxx
    const base64 = raw.indexOf('base64,') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw;

    // 严格校验 base64 字符集，防止把任意字符串解成脏数据写入磁盘
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new BizError('图片数据格式不正确');

    const buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64');
    const url = saveImageBuffer(buffer);
    return ok(res, { url, fullUrl: `${req.protocol}://${req.get('host')}${url}` }, '上传成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/admin/userList 管理员获取全部用户列表
 */async function userList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const keyword = req.query.keyword ? String(req.query.keyword) : '';
    const { list, total } = await User.listUsers({ keyword, offset, limit: pageSize });
    const users = list.map((item) => User.toSafeUser(item, isAdminStudent(item.student_id)));
    return ok(res, buildPage(users, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  register,
  login,
  securityUnlock,
  setSecurity,
  securityQuestions,
  captcha,
  randomAccountNo,
  checkAccountNo,
  deviceList,
  unbindDevice,
  refreshToken,
  info,
  deactivate,
  resetPassword,
  uploadImage,
  uploadImageBase64,
  saveImageBuffer,
  userList,
  detectImageType
};
