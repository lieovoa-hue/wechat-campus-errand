/**
 * =====================================================================
 * 微信内容安全检测（UGC 文本）
 * ---------------------------------------------------------------------
 * 为什么需要：
 *   小程序里凡是「用户可自由填写」的文本，微信审核都要求接入内容安全能力，
 *   否则可能以「存在违规内容传播风险」驳回。
 *
 * 已覆盖的 UGC 入口（新增入口时必须在这里补一行，否则等于漏检）：
 *   1) 发布 / 编辑任务：收件人姓名、送达地址、详细地址、帮带物品、取件码、任务备注；
 *   2) 头像 / 昵称 / 校园认证审核申请（auditController）；
 *   3) 举报原因与补充说明：用户举报、恶意超时投诉、雇主未送达申诉（reportController、
 *      taskController 的 reportTaker / reportLateTaker / rejectFinish）；
 *   4) 用户申诉正文（appealController）；
 *   5) 管理员公告正文（announceController）。管理员虽是白名单，但公告会推送给全部用户，
 *      误发违规内容代价更大，因此同样过检。
 *
 * 设计约定（与项目其它工具保持一致）：
 *   1. 默认关闭：SEC_CHECK_ENABLE 不为 true 时所有检测直接放行，
 *      本地调试与自动化回归不依赖外网接口，行为与接入前完全一致；
 *   2. 凭据复用 .env 的 WX_APPID / WX_APP_SECRET，access_token 走内存缓存并提前续期；
 *   3. 微信侧异常（超时 / 网络错误 / token 重试后仍失败）按 SEC_CHECK_FAIL_MODE 处理：
 *        open   = 放行并记 warn 日志（默认，优先保证业务可用）
 *        closed = 拦截并提示用户稍后重试（内容安全要求更严格的场景）
 *   4. 业务层只拿到 { pass, reason }，不感知微信原始返回，方便以后更换实现。
 *
 * 启用方式（.env）：
 *   SEC_CHECK_ENABLE=true
 *   SEC_CHECK_FAIL_MODE=closed   # 生产建议拦截，宁可让用户重试也不放过违规内容
 *
 * 注意：图片内容安全（mediaCheckAsync 异步检测）需要公网回调地址，本项目暂未接入，
 *       上线前请按 README「上线检查清单」确认是否需要补充。
 * =====================================================================
 */

const wxUtil = require('./wxUtil');
const { query } = require('../db/db');
const { log } = require('./common');
const { MSG } = require('./constant');

/** 微信单次检测的文本长度上限（接口上限 2500 字，这里留出余量） */
const TEXT_MAX = 2000;
/** access_token 提前续期窗口（毫秒） */
const TOKEN_SAFE_GAP_MS = 5 * 60 * 1000;

/** access_token 内存缓存（模块级，进程内共享） */
const tokenCache = { value: '', expireAt: 0 };

/** 是否启用内容安全检测 */
function isEnabled() {
  return String(process.env.SEC_CHECK_ENABLE || '').toLowerCase() === 'true';
}

/** 微信侧不可用时的兜底策略：open = 放行（默认），closed = 拦截 */
function isFailClosed() {
  return String(process.env.SEC_CHECK_FAIL_MODE || 'open').toLowerCase() === 'closed';
}

/**
 * 获取 access_token（内存缓存 + 提前 5 分钟续期）
 * @returns {Promise<string>} 为空表示当前不可用（未配置 / 微信侧失败）
 */
async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expireAt) return tokenCache.value;
  if (!wxUtil.isConfigured()) return '';
  const appid = encodeURIComponent(process.env.WX_APPID || '');
  const secret = encodeURIComponent(process.env.WX_APP_SECRET || '');
  const body = await wxUtil.getJson('/cgi-bin/token?grant_type=client_credential&appid=' + appid + '&secret=' + secret);
  if (!body || !body.access_token) {
    log('warn', '[内容安全] 获取 access_token 失败：' + ((body && body.errcode) || '无响应'));
    return '';
  }
  const expiresIn = Number(body.expires_in) || 7200;
  tokenCache.value = String(body.access_token);
  tokenCache.expireAt = Date.now() + expiresIn * 1000 - TOKEN_SAFE_GAP_MS;
  return tokenCache.value;
}

/** 清空 token 缓存（token 失效时调用，下次重新获取） */
function resetToken() {
  tokenCache.value = '';
  tokenCache.expireAt = 0;
}

/**
 * 用户 openid 内存缓存（从 user_device 表取，5 分钟内复用同一条，避免每次检测都查库）
 * 为什么需要：内容安全 v2 接口必须带本小程序用户的真实 openid，否则返回 40003。
 */
const openidCache = new Map();
const OPENID_CACHE_MS = 5 * 60 * 1000;

/**
 * 取用户在本小程序的 openid
 * @param {object|string} actor req.user 对象，或直接传 openid 字符串
 * @returns {Promise<string>} 取不到时返回空串（调用方会退回 v1 接口）
 */
async function resolveOpenid(actor) {
  if (!actor) return '';
  if (typeof actor === 'string') return actor;
  const userId = Number(actor.id) || 0;
  if (!userId) return '';
  const hit = openidCache.get(userId);
  if (hit && Date.now() < hit.expireAt) return hit.openid;
  let openid = '';
  try {
    const rows = await query(
      'SELECT openid FROM user_device WHERE user_id = ? AND openid <> ? ORDER BY id DESC LIMIT 1',
      [userId, '']
    );
    openid = (rows[0] && rows[0].openid) || '';
  } catch (err) {
    openid = '';
  }
  openidCache.set(userId, { openid, expireAt: Date.now() + OPENID_CACHE_MS });
  return openid;
}

/**
 * 调用一次 msg_sec_check
 * ------------------------------------------------------------------
 * version 2 是当前推荐版本，但**必须带本小程序用户的真实 openid**，否则返回 40003；
 * 拿不到 openid（例如管理员账号没走过 wx.login）时退回 v1，v1 不需要 openid。
 * @param {string} token access_token
 * @param {string} text 待检测文本
 * @param {string} openid 用户 openid（为空则走 v1）
 */
async function callSecCheck(token, text, openid) {
  const url = '/wxa/msg_sec_check?access_token=' + encodeURIComponent(token);
  if (!openid) return wxUtil.postJson(url, { content: text });
  return wxUtil.postJson(url, { content: text, version: 2, scene: 2, openid: String(openid) });
}

/**
 * 微信侧不可用时的统一兜底
 * @param {string} why 失败原因（只进日志）
 */
function handleWxFailure(why) {
  log('warn', '[内容安全] ' + why + '，按 SEC_CHECK_FAIL_MODE=' + (isFailClosed() ? 'closed（拦截）' : 'open（放行）') + ' 处理');
  if (isFailClosed()) return { pass: false, reason: MSG.CONTENT_CHECK_UNAVAILABLE };
  return { pass: true, degraded: true };
}

/**
 * 检测一段用户填写的文本是否合规
 * @param {string} content 待检测文本
 * @param {object|string} [actor] req.user 对象（内部会取 openid），或直接传 openid 字符串
 * @returns {Promise<{pass:boolean, reason?:string, skipped?:boolean, degraded?:boolean}>}
 *   pass=false 时 reason 是可直接展示给用户的中文文案
 */
async function checkText(content, actor) {
  const text = String(content || '').trim();
  if (!isEnabled() || !text) return { pass: true, skipped: true };

  const userId = (actor && typeof actor === 'object' && Number(actor.id)) || 0;
  let openid = await resolveOpenid(actor);

  let token = await getAccessToken();
  if (!token) return handleWxFailure('获取 access_token 失败');

  let body = await callSecCheck(token, text.slice(0, TEXT_MAX), openid);

  // token 过期（40001 / 42001）：清缓存重试一次
  if (body && (body.errcode === 40001 || body.errcode === 42001)) {
    resetToken();
    token = await getAccessToken();
    if (token) body = await callSecCheck(token, text.slice(0, TEXT_MAX), openid);
  }

  // 40003：openid 无效（缓存脏数据 / 用户换过微信号）→ 丢掉缓存并退回 v1 重试一次
  if (body && body.errcode === 40003 && openid) {
    if (userId) openidCache.delete(userId);
    openid = '';
    body = await callSecCheck(token, text.slice(0, TEXT_MAX), '');
  }

  if (!body) return handleWxFailure('微信内容安全接口无响应');

  if (body.errcode === 0) {
    // v2 会返回 result.suggest（pass / review / risky）；v1 没有 result 字段，errcode=0 即视为通过
    const suggest = (body.result && body.result.suggest) || '';
    if (!body.result || suggest === 'pass') return { pass: true };
    const label = (body.result && body.result.label) || '';
    log('info', '[内容安全] 文本未通过：suggest=' + (suggest || '未知') + ' label=' + label);
    return { pass: false, reason: MSG.CONTENT_RISKY };
  }

  // 87014：内容含有违法违规内容（老版本接口的返回码）
  if (body.errcode === 87014) {
    log('info', '[内容安全] 文本命中违规词（87014）');
    return { pass: false, reason: MSG.CONTENT_RISKY };
  }

  return handleWxFailure('微信内容安全接口返回 errcode=' + body.errcode);
}

/**
 * 把多个字段拼成一段，只调 1 次微信接口完成批量检测
 * ------------------------------------------------------------------
 * 为什么合并：发布任务有 6 个自由文本字段，逐个调用会让「发布」多等 1~2 秒，
 * 拼成一段后只发 1 次请求（接口上限 2500 字，6 个字段最长合计约 400 字，远未触顶）。
 * 代价：命中违规时无法定位到具体字段，因此提示语里列出涉及的字段名，让用户自己逐个检查。
 * @param {Array<{label:string,text:string}>} items 待检测字段（label 用于拼提示语）
 * @param {object|string} [actor] req.user 对象（内部会取 openid），或直接传 openid 字符串
 * @returns {Promise<{pass:boolean, reason?:string, labels?:string}>}
 */
async function checkJoined(items, actor) {
  const parts = (items || [])
    .map((item) => ({
      label: String((item && item.label) || '').trim(),
      text: String((item && item.text) || '').trim()
    }))
    .filter((item) => item.text);
  if (!parts.length) return { pass: true, skipped: true };

  const joined = parts.map((item) => item.text).join('\n');
  const result = await checkText(joined, actor);
  if (result.pass) return result;
  return {
    pass: false,
    reason: result.reason,
    labels: parts.map((item) => item.label).filter(Boolean).join('、')
  };
}

module.exports = {
  isEnabled,
  isFailClosed,
  getAccessToken,
  checkText,
  checkJoined,
  resolveOpenid
};
