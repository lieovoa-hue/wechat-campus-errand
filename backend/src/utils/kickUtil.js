/**
 * =====================================================================
 * 顶号提示工具（单设备登录）
 * ---------------------------------------------------------------------
 * 背景：新设备登录会立即顶掉旧设备的登录态，但旧设备只是「静默失效」，
 *   用户本人完全无感。万一账号是被别人登录的，用户连发生了什么都看不到。
 * 因此后端把「新设备名称 + 登录时间 + 登录 IP + 归属地」统一渲染成一段提示，
 * 由被顶下线的设备在下次请求时取走并弹窗展示。
 * 说明：提示文案统一维护在 utils/constant.js 字典里（前后端一致），
 *   本文件只负责「取字段 + 填占位符」，不写死任何中文。
 * =====================================================================
 */

const { MSG, formatText } = require('./constant');
const { isPrivateIp } = require('./ipRegion');

/**
 * 规范化用于展示的 IP
 * Node 在双栈监听下会把 IPv4 映射成 IPv6 形式（::ffff:1.2.3.4），
 * 直接把这一串甩给用户看很难理解，这里剥掉映射前缀。
 * @param {string} ip
 * @returns {string} 展示用 IP
 */
function normalizeIpForDisplay(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

/**
 * 解析「登录地点」展示文案
 *   公网 IP + 解析成功 → 「湖北-随州」
 *   内网 / 回环地址   → 「局域网」（归属地库对内网地址没有意义）
 *   公网 IP 解析失败  → 「未知地点」（如实说明拿不到，不编造）
 * @param {string} region 已解析的归属地
 * @param {string} ip 原始 IP
 * @returns {string}
 */
function resolveRegionLabel(region, ip) {
  const value = String(region || '').trim();
  if (value) return value;
  return isPrivateIp(ip) ? MSG.KICK_NOTICE_LOCAL_REGION : MSG.KICK_NOTICE_UNKNOWN_REGION;
}

/** 时间补零 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 格式化时间为「YYYY-MM-DD HH:mm:ss」
 * @param {Date|string} value 时间
 * @returns {string}
 */
function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value).replace(/-/g, '/'));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 构造顶号提示对象（下发给前端直接展示）
 * ---------------------------------------------------------------------
 * ⚠ 关键：查不到顶号记录时必须返回 null，不能"兜底渲染"成一段全是「未知」的提示。
 *   之前这里对空对象也照常套模板，结果前端弹出：
 *   「您的账号在另一台设备「未知设备」于未知时间登录（登录地点：未知地点，IP：未知IP）…」
 *   这种提示既没有信息量，又会让用户以为账号被盗，是典型的"错误的确定性"。
 * @param {object} kick user_kick 表行；为空/无主键时返回 null
 * @returns {{kicked:boolean, title:string, content:string, deviceName:string, time:string, ip:string, region:string}|null}
 */
function buildKickNotice(kick) {
  const row = kick || {};
  // 没有真实记录（或记录缺少主键）→ 调用方应回退到「普通的登录失效」流程
  if (!row.id) return null;

  const deviceName = String(row.new_device_name || '').trim() || MSG.KICK_NOTICE_UNKNOWN_DEVICE;
  const time = formatDateTime(row.kick_time) || '';
  const rawIp = normalizeIpForDisplay(row.login_ip);
  const ip = rawIp || MSG.KICK_NOTICE_UNKNOWN_IP;
  const region = resolveRegionLabel(row.login_region, rawIp);
  return {
    kicked: true,
    title: MSG.KICK_NOTICE_TITLE,
    content: formatText(MSG.KICK_NOTICE_TEMPLATE, { device: deviceName, time, region, ip }),
    deviceName,
    time,
    ip,
    region
  };
}

/**
 * 构造顶号站内消息内容（弹窗之外的留痕，用户下次进消息中心也能看到）
 * @param {object} kick user_kick 表行
 * @returns {string}
 */
function buildKickMessage(kick) {
  const row = kick || {};
  const deviceName = String(row.new_device_name || '').trim() || MSG.KICK_NOTICE_UNKNOWN_DEVICE;
  const time = formatDateTime(row.kick_time) || '';
  const rawIp = normalizeIpForDisplay(row.login_ip);
  const ip = rawIp || MSG.KICK_NOTICE_UNKNOWN_IP;
  const region = resolveRegionLabel(row.login_region, rawIp);
  return formatText(MSG.KICK_MESSAGE_TEMPLATE, {
    device: deviceName, time, region, ip
  }).slice(0, 500);
}

module.exports = {
  buildKickNotice,
  buildKickMessage,
  formatDateTime,
  normalizeIpForDisplay,
  resolveRegionLabel
};
