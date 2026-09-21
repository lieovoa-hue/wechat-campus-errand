/**
 * =====================================================================
 * 微信小程序服务端接口工具
 * ---------------------------------------------------------------------
 * 目前只封装一个能力：code2Session
 *   小程序端 wx.login() 拿到一次性 code -> 服务端用 AppID + AppSecret 换取该用户的 openid。
 *   openid 是「同一个微信号 + 同一个小程序」下的唯一标识，用它来识别「是否本人常用设备」，
 *   比设备指纹可靠得多（清缓存、换手机、重装小程序都不会变），而且微信不收取任何费用。
 *
 * 安全约定：
 *   1. AppSecret 只允许存在于后端 .env，绝不写进小程序代码、绝不打印到日志；
 *   2. 换取失败（网络异常 / code 已使用 / 配置缺失）时返回 null，
 *      调用方回退到设备标识方案，保证登录流程不会因为微信侧抖动而整体不可用；
 *   3. 接口超时 5 秒，避免拖垮登录响应。
 * =====================================================================
 */

const https = require('https');
const querystring = require('querystring');

const { log } = require('./common');

/** 微信开放接口域名 */
const API_HOST = 'api.weixin.qq.com';
/** 请求超时（毫秒） */
const TIMEOUT_MS = 5000;

/** 当前是否已配置 AppID / AppSecret */
function isConfigured() {
  return Boolean(process.env.WX_APPID && process.env.WX_APP_SECRET);
}

/**
 * 发起一次 GET 请求（只用于微信开放接口，内置超时与错误兜底）
 * @param {string} pathname 请求路径（含查询串）
 * @returns {Promise<object|null>} 解析后的 JSON，失败返回 null
 */
function getJson(pathname) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: API_HOST, path: pathname, method: 'GET', timeout: TIMEOUT_MS },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            log('warn', '微信接口返回内容解析失败');
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      log('warn', '微信接口请求超时（code2Session）');
      resolve(null);
    });
    req.on('error', (err) => {
      log('warn', '微信接口请求异常（code2Session）：', err.message);
      resolve(null);
    });
  });
}

/**
 * 用 wx.login 的 code 换取 openid
 * @param {string} code 小程序端 wx.login 返回的临时登录凭证（5 分钟内有效且只能用一次）
 * @returns {Promise<{openid:string, unionid:string, sessionKey:string}|null>}
 *          换取失败或未配置 AppSecret 时返回 null（调用方回退设备标识方案）
 */
async function code2Session(code) {
  const jsCode = String(code || '').trim();
  if (!jsCode) return null;

  if (!isConfigured()) {
    log('warn', '未配置 WX_APPID / WX_APP_SECRET，本次登录跳过微信身份识别（回退设备标识方案）');
    return null;
  }

  const query = querystring.stringify({
    appid: process.env.WX_APPID,
    secret: process.env.WX_APP_SECRET,
    js_code: jsCode,
    grant_type: 'authorization_code'
  });

  const body = await getJson(`/sns/jscode2session?${query}`);
  if (!body) return null;

  // 微信侧错误：errcode 非 0（例如 code 已被使用、AppSecret 不正确）
  if (body.errcode) {
    log('warn', `code2Session 失败：errcode=${body.errcode} errmsg=${body.errmsg || ''}`);
    return null;
  }
  if (!body.openid) {
    log('warn', 'code2Session 未返回 openid');
    return null;
  }

  return {
    openid: String(body.openid),
    unionid: body.unionid ? String(body.unionid) : '',
    sessionKey: body.session_key ? String(body.session_key) : ''
  };
}

/**
 * 发起一次 POST(JSON) 请求（供内容安全等微信开放接口复用）
 * @param {string} pathname 请求路径（含查询串）
 * @param {object} body 请求体对象
 * @returns {Promise<object|null>} 解析后的 JSON，失败返回 null
 */
function postJson(pathname, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = https.request(
      {
        host: API_HOST,
        path: pathname,
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            log('warn', '微信接口返回内容解析失败（POST）');
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); log('warn', '微信接口请求超时（POST）'); resolve(null); });
    req.on('error', (err) => { log('warn', '微信接口请求异常（POST）：', err.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  isConfigured,
  code2Session,
  getJson,
  postJson
};