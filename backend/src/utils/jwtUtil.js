/**
 * =====================================================================
 * JWT 双令牌工具
 *  access_token  ：有效期 2 小时（由 .env JWT_ACCESS_EXPIRES 控制）
 *  refresh_token ：有效期 7 天（由 .env JWT_REFRESH_EXPIRES 控制）
 * 载荷中携带设备标识 deviceId，用于「单设备登录」，新设备登录顶掉旧设备。
 * 另外提供两类短时效的一次性票据（不用于业务接口鉴权，只用于登录流程串联）：
 *  unlock_ticket ：新设备登录时下发，10 分钟内凭「密保答案」换取正式令牌
 *  reset_ticket  ：忘记密码第一步下发，10 分钟内凭「密保答案 + 学号姓名」重置密码
 * =====================================================================
 */

require('dotenv').config();

const jwt = require('jsonwebtoken');

/** 解锁 / 重置票据有效期（10 分钟，足够用户从容作答，又不会长期留疤） */
const TICKET_EXPIRES = '10m';

/** access_token 有效期（默认 2 小时） */
function getAccessExpires() {
  return process.env.JWT_ACCESS_EXPIRES || '2h';
}

/** refresh_token 有效期（默认 7 天） */
function getRefreshExpires() {
  return process.env.JWT_REFRESH_EXPIRES || '7d';
}

/**
 * 获取签名密钥（缺少配置直接抛错，避免用默认密钥裸奔）
 */
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET 未配置，请在 .env 中设置');
  }
  return secret;
}

/**
 * 生成 access_token
 * @param {number} userId
 * @param {string} deviceId 设备标识
 */
function signAccessToken(userId, deviceId) {
  return jwt.sign(
    { userId, deviceId, type: 'access' },
    getSecret(),
    { expiresIn: getAccessExpires() }
  );
}

/**
 * 生成 refresh_token
 * @param {number} userId
 * @param {string} deviceId 设备标识
 */
function signRefreshToken(userId, deviceId) {
  return jwt.sign(
    { userId, deviceId, type: 'refresh' },
    getSecret(),
    { expiresIn: getRefreshExpires() }
  );
}

/**
 * 一次性生成双令牌
 * @param {number} userId
 * @param {string} deviceId
 * @returns {{accessToken:string, refreshToken:string, accessExpiresIn:string, refreshExpiresIn:string}}
 */
function signTokenPair(userId, deviceId) {
  return {
    accessToken: signAccessToken(userId, deviceId),
    refreshToken: signRefreshToken(userId, deviceId),
    accessExpiresIn: getAccessExpires(),
    refreshExpiresIn: getRefreshExpires()
  };
}

/**
 * 生成「新设备解锁票据」
 * 载荷里带上本次登录的设备标识与微信 openid：解锁成功后直接把该设备绑定为常用设备，
 * 避免用户答完密保又要重新登录一次。
 * @param {number} userId 账号主键
 * @param {string} deviceId 本次登录的设备标识
 * @param {string} openid 本次登录的微信 openid（可能为空）
 * @returns {string} unlock_ticket
 */
function signUnlockTicket(userId, deviceId, openid) {
  return jwt.sign(
    { userId, deviceId, openid: openid || '', type: 'unlock' },
    getSecret(),
    { expiresIn: TICKET_EXPIRES }
  );
}

/**
 * 校验「新设备解锁票据」
 * @param {string} token
 * @returns {object|null}
 */
function verifyUnlockTicket(token) {
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'unlock') return null;
  return payload;
}

/**
 * 生成「忘记密码重置票据」
 * needIdentity 为 true 表示该账号已通过校园认证，重置时必须额外校验学号与姓名。
 * userId 为 0 表示第一步传入的账号不存在（仍签发票据，保证前端体验一致、不泄漏账号是否存在）。
 * @param {number} userId 账号主键（不存在时为 0）
 * @param {boolean} needIdentity 是否需要额外校验学号 + 姓名
 * @returns {string} reset_ticket
 */
function signResetTicket(userId, needIdentity) {
  return jwt.sign(
    { userId: userId || 0, needIdentity: !!needIdentity, type: 'reset' },
    getSecret(),
    { expiresIn: TICKET_EXPIRES }
  );
}

/**
 * 校验「忘记密码重置票据」
 * @param {string} token
 * @returns {{userId:number,needIdentity:boolean}|null}
 */
function verifyResetTicket(token) {
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'reset') return null;
  return { userId: Number(payload.userId || 0), needIdentity: !!payload.needIdentity };
}

/**
 * 校验 token（不区分类型）
 * @param {string} token
 * @returns {object|null} 解析后的载荷，失败返回 null
 */
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getSecret());
  } catch (err) {
    return null;
  }
}

/**
 * 校验 access_token
 */
function verifyAccessToken(token) {
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'access') return null;
  return payload;
}

/**
 * 校验 refresh_token
 */
function verifyRefreshToken(token) {
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'refresh') return null;
  return payload;
}

/**
 * 解析 token 的过期时间（毫秒时间戳），失败返回 0
 */
function getExpireAt(token) {
  const payload = verifyToken(token);
  return payload && payload.exp ? payload.exp * 1000 : 0;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signTokenPair,
  signUnlockTicket,
  verifyUnlockTicket,
  signResetTicket,
  verifyResetTicket,
  verifyToken,
  verifyAccessToken,
  verifyRefreshToken,
  getExpireAt
};
