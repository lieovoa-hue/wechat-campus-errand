/**
 * =====================================================================
 * 微信小程序「虚拟支付」工具（个人主体 B 方案）
 * ---------------------------------------------------------------------
 * 为什么用虚拟支付：
 *   个人主体无法开通普通微信支付商户号，但可以开通「小程序虚拟支付」，
 *   用「道具直购」的方式卖虚拟商品。本项目只卖一种道具：发布券（0.1 元 / 张）。
 *
 * 与普通支付的关键差异（决定了业务设计）：
 *   1. 虚拟支付**不支持退款**。所以撤销任务退的是「发布券」而不是现金，
 *      详见 taskController.refundServiceFee 与 utils/constant 的 PAY_CHANNEL_ENUM；
 *   2. 没有异步支付回调，只有「发货推送」：用户付款成功后微信推一条 XML 给我们，
 *      我们必须发货并在 5 秒内返回 <ErrCode>0</ErrCode>，否则微信最多重试 15 次；
 *   3. 兜底通道：POST /xpay/query_order 主动查单（定时任务补发货）。
 *
 * 两套签名（微信硬性要求，缺一不可）：
 *   paySig    = HMAC-SHA256(AppKey, 'requestVirtualPayment&' + signData)   —— 证明请求来自商户后台
 *   signature = HMAC-SHA256(sessionKey, signData)                          —— 证明是当前登录用户本人
 *   signData 是后端拼好的 JSON 字符串，原样下发前端再原样回传微信。
 *
 * ⚠️ 当前状态：OfferID / AppKey / 道具 ID 需要开通虚拟支付后才有，
 *    未配置时 isConfigured() 返回 false，业务侧自动退回模拟支付，绝不影响可用性。
 *    开通后请在 .env 填写 XPAY_OFFER_ID / XPAY_APP_KEY / XPAY_COUPON_PRODUCT_ID，
 *    并把 PAY_MODE 改成 virtual。
 * =====================================================================
 */

const crypto = require('crypto');
const { BizError, log } = require('./common');

/** 微信开放接口域名（虚拟支付全部走 api.weixin.qq.com） */
const API_HOST = 'https://api.weixin.qq.com';
/** 请求超时（毫秒） */
const TIMEOUT_MS = 8000;

/** 虚拟支付商户号 OfferID */
function getOfferId() {
  return String(process.env.XPAY_OFFER_ID || '').trim();
}

/** 现网 AppKey（用于 paySig） */
function getAppKey() {
  return String(process.env.XPAY_APP_KEY || '').trim();
}

/** 「发布券」道具 ID */
function getProductId() {
  return String(process.env.XPAY_COUPON_PRODUCT_ID || 'publish_coupon').trim();
}

/** 单张发布券价格（分），默认 10 分 = 0.1 元，必须与虚拟支付后台配置的单价完全一致 */
function getCouponPriceFen() {
  const fen = Number(process.env.XPAY_COUPON_PRICE_FEN);
  return Number.isInteger(fen) && fen > 0 ? fen : 10;
}

/** 现网环境标识：0 = 现网（固定值，不要改） */
function getEnv() {
  return 0;
}

/** 虚拟支付配置是否完整（未开通时整体降级，不影响发布任务） */
function isConfigured() {
  return Boolean(getOfferId() && getAppKey() && getProductId());
}

/** HMAC-SHA256，返回小写十六进制（微信要求） */
function hmacHex(key, message) {
  return crypto.createHmac('sha256', String(key)).update(String(message), 'utf8').digest('hex');
}

/**
 * 构造 signData（JSON 字符串）
 * 字段与顺序固定，paySig / signature 都对「这串字符」做 HMAC，
 * 因此前端必须原样透传，不能自己重新 JSON.stringify。
 * @param {object} params
 * @param {string} params.outTradeNo 商户订单号（本项目用支付流水的 out_trade_no）
 * @param {number} params.buyQuantity 购买数量（发布券固定 1 张）
 * @param {string} params.attach 透传字段（发货推送会原样带回，用 outTradeNo 做幂等）
 * @returns {string} signData
 */
function buildSignData({ outTradeNo, buyQuantity = 1, attach }) {
  const data = {
    offerId: getOfferId(),
    buyQuantity: Number(buyQuantity) || 1,
    env: getEnv(),
    currencyType: 'CNY',
    productId: getProductId(),
    goodsPrice: getCouponPriceFen(),
    outTradeNo: String(outTradeNo),
    attach: String(attach === undefined || attach === null ? '' : attach)
  };
  return JSON.stringify(data);
}

/**
 * 生成小程序 wx.requestVirtualPayment 所需的全部参数
 * @param {object} params
 * @param {string} params.outTradeNo 商户订单号
 * @param {string} params.sessionKey 该用户 code2Session 拿到的 session_key（用户态签名用）
 * @param {string} [params.attach] 透传字段
 * @returns {{signData:string, paySig:string, signature:string, mode:string}}
 */
function buildOrderParams({ outTradeNo, sessionKey, attach }) {
  if (!isConfigured()) {
    throw new BizError('虚拟支付未配置（缺少 XPAY_OFFER_ID / XPAY_APP_KEY），请先在虚拟支付后台开通并填写 .env', 500);
  }
  if (!sessionKey) {
    throw new BizError('缺少微信会话密钥，无法发起虚拟支付，请重新登录后再试', 400);
  }
  const signData = buildSignData({ outTradeNo, attach: attach || outTradeNo });
  return {
    signData,
    paySig: hmacHex(getAppKey(), 'requestVirtualPayment&' + signData),
    signature: hmacHex(sessionKey, signData),
    mode: 'short_series_goods'
  };
}

/**
 * 极简 XML 取值（发货推送是 XML，不引第三方依赖）
 * 兼容 <Tag><![CDATA[值]]></Tag> 与 <Tag>值</Tag> 两种写法
 * @param {string} xml 原始报文
 * @param {string} tag 标签名
 * @returns {string} 取不到返回空串
 */
function pickXml(xml, tag) {
  const re = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>');
  const m = re.exec(String(xml || ''));
  return m ? String(m[1]).trim() : '';
}

/**
 * 解析「发货推送」报文
 * @param {string} xml 原始 XML
 * @returns {{outTradeNo:string, wxOrderId:string, openid:string, event:string, productId:string, buyQuantity:number, raw:string}}
 */
function parseDeliverNotify(xml) {
  return {
    // 我们的商户订单号：用它把发货结果写回 payments 流水
    outTradeNo: pickXml(xml, 'OutTradeNo') || pickXml(xml, 'outTradeNo'),
    // 微信平台单号：作为 transaction_id 落库（幂等键之一）
    wxOrderId: pickXml(xml, 'MchOrderNo') || pickXml(xml, 'mchOrderNo'),
    openid: pickXml(xml, 'OpenId') || pickXml(xml, 'openid'),
    event: pickXml(xml, 'Event') || pickXml(xml, 'event'),
    productId: pickXml(xml, 'ProductId') || pickXml(xml, 'productId'),
    buyQuantity: Number(pickXml(xml, 'BuyQuantity') || pickXml(xml, 'buyQuantity') || 1),
    raw: String(xml || '')
  };
}

/**
 * 构造发货推送的成功应答（必须原样返回，否则微信会重试最多 15 次）
 * @returns {string} XML
 */
function buildDeliverAck() {
  return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>';
}

/** 构造发货推送的失败应答（让微信按策略重试） */
function buildDeliverFail(message) {
  return '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[' + String(message || 'fail') + ']]></ErrMsg></xml>';
}

/**
 * 服务端接口统一请求（带 pay_sig 头）
 * @param {string} urlPath 形如 /xpay/query_order
 * @param {object} payload 请求体
 * @returns {Promise<object>} 响应 JSON
 */
async function requestXpay(urlPath, payload) {
  const accessToken = await require('./wxSecCheck').getAccessToken();
  if (!accessToken) throw new BizError('获取 access_token 失败，请稍后重试', 500);

  const body = JSON.stringify(payload || {});
  const paySig = hmacHex(getAppKey(), urlPath + '&' + body);

  let resp;
  try {
    resp = await fetch(API_HOST + urlPath + '?access_token=' + encodeURIComponent(accessToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pay-Sig': paySig, 'X-Pay-Signature': paySig },
      body
    });
  } catch (err) {
    log('error', '虚拟支付接口网络异常：', err.message);
    throw new BizError('支付服务暂时不可用，请稍后重试', 500);
  }

  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }
  if (data.errcode && data.errcode !== 0) {
    log('warn', '虚拟支付接口返回异常：' + JSON.stringify(data));
  }
  return data;
}

/**
 * 主动查单（发货推送丢失时的兜底，定时任务调用）
 * @param {object} params { outTradeNo, openid }
 * @returns {Promise<object>} 微信返回的订单状态
 */
function queryOrder({ outTradeNo, openid }) {
  return requestXpay('/xpay/query_order', {
    offerId: getOfferId(),
    outTradeNo: String(outTradeNo),
    openid: String(openid || ''),
    env: getEnv()
  });
}

module.exports = {
  isConfigured,
  getOfferId,
  getAppKey,
  getProductId,
  getCouponPriceFen,
  buildSignData,
  buildOrderParams,
  parseDeliverNotify,
  buildDeliverAck,
  buildDeliverFail,
  queryOrder,
  hmacHex
};
