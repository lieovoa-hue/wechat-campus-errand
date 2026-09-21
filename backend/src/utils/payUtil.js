/**
 * =====================================================================
 * 微信支付工具（API v3）
 * ---------------------------------------------------------------------
 *  .env PAY_SIMULATE=true  ：模拟支付模式，点击支付直接标记成功，不调用微信接口
 *  .env PAY_SIMULATE=false ：正式模式，调用微信支付 API v3 下单，由 /api/pay/notify 回调确认
 *
 *  实现内容：
 *   1. 商户私钥签名（WECHATPAY2-SHA256-RSA2048）
 *   2. JSAPI 下单 + 小程序 wx.requestPayment 参数签名
 *   3. 支付回调验签（平台证书 RSA-SHA256）
 *   4. 回调报文 AES-256-GCM 解密
 *   5. 申请退款 / 查询订单
 * =====================================================================
 */

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BizError, log } = require('./common');

// 兼容旧配置：PAY_MODE 未显式设置时，按老的 PAY_SIMULATE 开关推导
const LEGACY_SIMULATE = String(process.env.PAY_SIMULATE || 'true').toLowerCase() === 'true';

// 微信支付 / 微信开放接口域名
const MCH_BASE_URL = 'https://api.mch.weixin.qq.com';
const WX_BASE_URL = 'https://api.weixin.qq.com';

/**
 * 当前支付模式（唯一的模式判定出口）
 * ------------------------------------------------------------------
 *   simulate : 模拟支付 —— 点「支付」直接标记成功，不调任何微信接口。
 *              本地开发与自动化回归用，正式上线必须切走。
 *   virtual  : 微信小程序「虚拟支付」（个人主体 B 方案）—— 卖「发布券」道具，
 *              不支持退款，撤销任务改为返还发布券（见 virtualPay.js）。
 *   api_v3   : 微信支付 API v3（企业商户号方案，当前未启用，代码保留备用）。
 * 兼容：未设置 PAY_MODE 时按旧的 PAY_SIMULATE 开关推导。
 * @returns {'simulate'|'virtual'|'api_v3'}
 */
function getPayMode() {
  const mode = String(process.env.PAY_MODE || '').trim().toLowerCase();
  if (mode === 'simulate' || mode === 'virtual' || mode === 'api_v3') return mode;
  return LEGACY_SIMULATE ? 'simulate' : 'api_v3';
}

/** 当前是否模拟支付模式 */
function isSimulate() {
  return getPayMode() === 'simulate';
}

/** 当前是否微信虚拟支付模式（个人主体 B 方案） */
function isVirtual() {
  return getPayMode() === 'virtual';
}

/** 当前是否微信支付 API v3 模式（企业商户号方案，备用） */
function isApiV3() {
  return getPayMode() === 'api_v3';
}

/** 元转分（微信金额单位为分） */
function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

/** 读取密钥/证书文件（带友好报错） */
function readFileSafe(filePath, label) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new BizError(`${label}文件不存在，请检查 .env 配置：${filePath}`, 500);
  }
  return fs.readFileSync(abs, 'utf8');
}

let cachedPrivateKey = null;
let cachedPlatformCert = null;

/** 商户 API 私钥 */
function getPrivateKey() {
  if (!cachedPrivateKey) {
    cachedPrivateKey = readFileSafe(process.env.WX_KEY_PATH || './cert/apiclient_key.pem', '微信支付商户私钥');
  }
  return cachedPrivateKey;
}

/** 微信支付平台证书（用于回调验签） */
function getPlatformCert() {
  if (!cachedPlatformCert) {
    cachedPlatformCert = readFileSafe(process.env.WX_PLATFORM_CERT_PATH || './cert/wechatpay_platform_cert.pem', '微信支付平台证书');
  }
  return cachedPlatformCert;
}

/**
 * 构造请求签名头 Authorization
 * 签名串：METHOD\nURL_PATH\ntimestamp\nnonce_str\nbody\n
 * @param {string} method 请求方法
 * @param {string} urlPath 带 query 的路径，如 /v3/pay/transactions/jsapi
 * @param {string} body 请求体字符串（GET 传空串）
 * @returns {string} Authorization 头
 */
function buildAuthorization(method, urlPath, body = '') {
  const mchid = process.env.WX_MCH_ID;
  const serialNo = process.env.WX_MCH_SERIAL_NO;
  if (!mchid || !serialNo) {
    throw new BizError('微信支付配置不完整：缺少 WX_MCH_ID 或 WX_MCH_SERIAL_NO', 500);
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = crypto.randomBytes(16).toString('hex').toUpperCase();
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(message)
    .sign(getPrivateKey(), 'base64');

  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

/**
 * 调用微信支付接口
 * @param {string} urlPath 路径（含 query）
 * @param {string} method 方法
 * @param {object|null} payload 请求体对象
 * @returns {Promise<object>} 响应 JSON
 */
async function requestWxPay(urlPath, method = 'GET', payload = null) {
  const body = payload ? JSON.stringify(payload) : '';
  const headers = {
    Authorization: buildAuthorization(method, urlPath, body),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'campus-errand-server/1.0'
  };

  let resp;
  try {
    resp = await fetch(`${MCH_BASE_URL}${urlPath}`, {
      method,
      headers,
      body: method === 'GET' || method === 'DELETE' ? undefined : body
    });
  } catch (err) {
    log('error', '微信支付接口网络异常：', err.message);
    throw new BizError('支付服务暂时不可用，请稍后重试', 500);
  }

  const text = await resp.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { raw: text };
    }
  }

  if (resp.status !== 200 && resp.status !== 204) {
    log('error', `微信支付接口返回异常 status=${resp.status}`, text);
    throw new BizError((data && data.message) || '支付请求失败，请稍后重试', 500);
  }
  return data;
}

/**
 * JSAPI 下单
 * @param {object} params
 * @param {string} params.outTradeNo 商户订单号
 * @param {string} params.description 商品描述
 * @param {number} params.totalFeeYuan 金额（元）
 * @param {string} params.openid 用户 openid
 * @returns {Promise<string>} prepay_id
 */
async function createJsapiPrepay({ outTradeNo, description, totalFeeYuan, openid }) {
  if (!openid) {
    throw new BizError('缺少微信 openid，无法发起支付', 400);
  }
  const body = {
    appid: process.env.WX_APPID,
    mchid: process.env.WX_MCH_ID,
    description,
    out_trade_no: outTradeNo,
    notify_url: process.env.WX_NOTIFY_URL,
    amount: { total: yuanToFen(totalFeeYuan), currency: 'CNY' },
    payer: { openid }
  };
  const data = await requestWxPay('/v3/pay/transactions/jsapi', 'POST', body);
  if (!data.prepay_id) {
    log('error', 'JSAPI 下单返回缺少 prepay_id', JSON.stringify(data));
    throw new BizError('发起支付失败，请稍后重试', 500);
  }
  return data.prepay_id;
}

/**
 * 生成小程序 wx.requestPayment 所需参数
 * 签名串：appId\ntimeStamp\nnonceStr\npackage\n
 * @param {string} prepayId
 * @returns {{timeStamp:string, nonceStr:string, package:string, signType:string, paySign:string}}
 */
function buildMiniProgramPayParams(prepayId) {
  const appId = process.env.WX_APPID;
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = crypto.randomBytes(16).toString('hex').toUpperCase();
  const packageStr = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`;
  const paySign = crypto.createSign('RSA-SHA256').update(message).sign(getPrivateKey(), 'base64');

  return {
    timeStamp,
    nonceStr,
    package: packageStr,
    signType: 'RSA',
    paySign
  };
}

/**
 * 通过 wx.login 的 code 换取登录会话（openid + session_key）
 * ------------------------------------------------------------------
 * session_key 是虚拟支付「用户态签名」必须的：signature = HMAC-SHA256(sessionKey, signData)。
 * 普通支付只需要 openid，这里统一返回两者，避免同一份 code 被消费两次
 * （code 只能用一次，重复换会直接失败）。
 * @param {string} code wx.login 返回的临时登录凭证
 * @returns {Promise<{openid:string, sessionKey:string}>}
 */
async function getLoginSession(code) {
  const appId = process.env.WX_APPID;
  const secret = process.env.WX_APP_SECRET;
  if (!appId || !secret) {
    throw new BizError('微信配置不完整：缺少 WX_APPID 或 WX_APP_SECRET', 500);
  }
  const url = `${WX_BASE_URL}/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.openid) {
    log('error', '换取 openid 失败：', JSON.stringify(data));
    throw new BizError('微信授权失败，请重试', 400);
  }
  return { openid: data.openid, sessionKey: data.session_key ? String(data.session_key) : '' };
}

/**
 * 通过 wx.login 的 code 换取 openid
 * @param {string} code
 * @returns {Promise<string>} openid
 */
async function getOpenidByCode(code) {
  const appId = process.env.WX_APPID;
  const secret = process.env.WX_APP_SECRET;
  if (!appId || !secret) {
    throw new BizError('微信配置不完整：缺少 WX_APPID 或 WX_APP_SECRET', 500);
  }
  const url = `${WX_BASE_URL}/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.openid) {
    log('error', '换取 openid 失败：', JSON.stringify(data));
    throw new BizError('微信授权失败，请重试', 400);
  }
  return data.openid;
}

/**
 * 支付回调验签
 * 验签串：timestamp\nnonce\nbody\n
 * @param {object} headers express req.headers
 * @param {string} rawBody 原始请求体字符串
 * @returns {boolean} 是否验签通过
 */
function verifyNotifySignature(headers, rawBody) {
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  if (!timestamp || !nonce || !signature) {
    return false;
  }
  // 防重放：回调时间与当前时间相差超过 5 分钟视为非法
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    log('warn', '支付回调时间戳超出允许范围，疑似重放攻击');
    return false;
  }

  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  try {
    return crypto
      .createVerify('RSA-SHA256')
      .update(message)
      .verify(getPlatformCert(), signature, 'base64');
  } catch (err) {
    log('error', '支付回调验签异常：', err.message);
    return false;
  }
}

/**
 * 解密回调报文中的 resource（AES-256-GCM）
 * @param {{ciphertext:string, nonce:string, associated_data:string}} resource
 * @returns {object} 解密后的业务 JSON
 */
function decryptResource(resource) {
  const apiV3Key = process.env.WX_API_V3_KEY;
  if (!apiV3Key) {
    throw new BizError('缺少 WX_API_V3_KEY 配置', 500);
  }
  try {
    const key = Buffer.from(apiV3Key, 'utf8');
    const nonce = Buffer.from(resource.nonce, 'utf8');
    const aad = Buffer.from(resource.associated_data || '', 'utf8');
    const buf = Buffer.from(resource.ciphertext, 'base64');
    const authTag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(aad);
    const decoded = decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    log('error', '支付回调报文解密失败：', err.message);
    throw new BizError('回调报文解密失败', 500);
  }
}

/**
 * 申请退款（原路退回信息服务费）
 * @param {object} params
 * @param {string} params.outTradeNo 原商户订单号
 * @param {string} params.outRefundNo 退款单号
 * @param {number} params.totalFeeYuan 原订单金额（元）
 * @param {number} params.refundFeeYuan 退款金额（元）
 * @param {string} params.reason 退款原因
 * @returns {Promise<object>} 微信退款结果
 */
async function refundOrder({ outTradeNo, outRefundNo, totalFeeYuan, refundFeeYuan, reason }) {
  const body = {
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: reason || '任务撤销退费',
    notify_url: process.env.WX_NOTIFY_URL,
    amount: {
      refund: yuanToFen(refundFeeYuan),
      total: yuanToFen(totalFeeYuan),
      currency: 'CNY'
    }
  };
  return requestWxPay('/v3/refund/domestic/refunds', 'POST', body);
}

/**
 * 查询订单（按商户订单号）
 * @param {string} outTradeNo
 * @returns {Promise<object>}
 */
async function queryOrder(outTradeNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(process.env.WX_MCH_ID || '')}`;
  return requestWxPay(urlPath, 'GET');
}

module.exports = {
  getPayMode,
  isSimulate,
  isVirtual,
  isApiV3,
  getLoginSession,
  yuanToFen,
  buildAuthorization,
  createJsapiPrepay,
  buildMiniProgramPayParams,
  getOpenidByCode,
  verifyNotifySignature,
  decryptResource,
  refundOrder,
  queryOrder
};
