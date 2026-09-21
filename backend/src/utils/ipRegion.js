/**
 * =====================================================================
 * IP 归属地解析工具（省-市）
 * ---------------------------------------------------------------------
 * 【为什么需要】
 *   1) 「我的 - 设备管理」要能一眼看出每台设备是从哪里登录的（如「湖北-随州」）；
 *   2) 账号被新设备顶下线时，要给下线的一方弹出「哪台设备、什么时候、哪个 IP」的提示，
 *      否则用户只会莫名掉线，既无法自证也发现不了盗号。
 *
 * 【数据来源】
 *   默认用 ip-api.com 的中文接口（免注册、免密钥、限 45 次/分钟），
 *   失败时回退到 pconline 的 whois 接口。两者都只返回省市，不涉及精准定位。
 *   可通过 .env 关闭或换成自建服务：
 *     IP_REGION_ENABLE=true/false    总开关（关闭后只显示 IP 不显示归属地）
 *     IP_REGION_API=...              主通道地址模板（含 {ip} 占位符）
 *     IP_REGION_FALLBACK_API=...     备用通道地址模板（含 {ip} 占位符）
 *     IP_REGION_TIMEOUT_MS=1500      单次查询超时（毫秒）
 *
 * 【性能与稳定性】
 *   1) 结果按 IP 缓存 24 小时（命中缓存的登录不会产生任何外部请求）；
 *   2) 查询失败做短时负缓存（10 分钟），避免同一个人反复登录把外部接口打爆；
 *   3) 任何异常都被吞掉并返回空串 —— 归属地只是「锦上添花」，
 *      绝不能因为第三方接口不可用而让用户登录失败。
 * =====================================================================
 */

const http = require('http');
const https = require('https');
const { log } = require('./common');

/** 归属地缓存：ip -> { region, expireAt } */
const regionCache = new Map();
/** 缓存上限（防止被海量伪造 IP 撑爆内存） */
const CACHE_MAX = 1000;
/** 解析成功的缓存时长：24 小时 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 解析失败（空结果）的缓存时长：10 分钟 */
const CACHE_FAIL_TTL_MS = 10 * 60 * 1000;

/** 主通道：ip-api.com 中文接口（免密钥；免费版仅支持 http） */
const DEFAULT_PROVIDER = 'http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,country,regionName,city';
/** 备用通道：pconline whois 接口（只返回国内的省市，作为兜底足够用） */
const DEFAULT_FALLBACK = 'https://whois.pconline.com.cn/ipJson.jsp?ip={ip}&json=true';

/** 是否启用归属地解析（默认启用；可用 .env 关闭） */
function isEnabled() {
  const raw = process.env.IP_REGION_ENABLE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return String(raw).trim().toLowerCase() !== 'false';
}

/** 单次查询超时（毫秒），默认 1500 */
function getTimeout() {
  const value = Number(process.env.IP_REGION_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 300 ? value : 1500;
}

/**
 * 是否为内网 / 保留地址（这类地址查不到归属地，也没有查询的必要）
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  const value = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!value) return true;
  if (value === '::1' || value === 'localhost') return true;
  if (/^127\./.test(value)) return true;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  if (/^169\.254\./.test(value)) return true;
  if (/^(fc|fd|fe80)/i.test(value)) return true;
  return false;
}

/**
 * 归一化行政区名称：去掉「省 / 市 / 自治区 / 自治州 / 地区」等后缀，
 * 让「湖北省黄石市」变成「湖北-黄石」这种用户要求的口径。
 * 例：广西壮族自治区 -> 广西；新疆维吾尔自治区 -> 新疆；随州市 -> 随州
 * @param {string} value 原始名称
 * @returns {string}
 */
function normalizeArea(value) {
  let name = String(value === undefined || value === null ? '' : value).trim();
  if (!name) return '';
  // 乱码兜底：第三方用错编码时会留下 U+FFFD 替换字符，这种字符一旦写库就再也救不回来，
  // 宁可判为「解析失败」（前端显示未知地点），也不要把乱码存进去。
  if (name.indexOf('\uFFFD') >= 0) return '';
  name = name.replace(/(维吾尔|壮族|回族|蒙古族)?(自治区|特别行政区|自治州|省|市|地区|盟)$/u, '');
  return name.trim();
}

/**
 * 拼装「省-市」：
 *   - 省市都有且不同 -> 「湖北-随州」
 *   - 省市相同（北京 / 上海 等直辖市）-> 只显示一次
 *   - 只有其一 -> 显示已有的那个
 * @param {string} province 省 / 直辖市
 * @param {string} city 市
 * @returns {string}
 */
function formatIpRegion(province, city) {
  const p = normalizeArea(province);
  const c = normalizeArea(city);
  if (p && c) return p === c ? p : `${p}-${c}`;
  return p || c || '';
}

/**
 * 从各家接口的返回体里提取省市
 * 兼容两种结构：
 *   ip-api.com ：{ status:'success', regionName:'湖北', city:'随州市' }
 *   pconline   ：{ pro:'湖北省', city:'黄石市' }
 * @param {object} payload 接口返回的 JSON
 * @returns {string} 「省-市」，无法识别时为空串
 */
function parseRegionPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.status && payload.status !== 'success') return '';
  const province = payload.prov || payload.regionName || payload.pro || '';
  const city = payload.city || '';
  return formatIpRegion(province, city);
}

/**
 * 按接口声明的编码把响应体解成字符串
 * ---------------------------------------------------------------------
 * 为什么必须做：备用通道 whois.pconline.com.cn 返回的是 GBK 字节流。
 * 旧实现统一 res.setEncoding('utf8')，GBK 汉字会被替换成 U+FFFD（），
 * 再写进数据库就彻底救不回来了 —— 这就是「我的设备」里登录地点乱码的根因。
 * 处理顺序：Content-Type 的 charset -> 严格 UTF-8 -> GB18030 兜底。
 * @param {Buffer} buffer 响应体
 * @param {string} contentType 响应头 content-type
 * @returns {string}
 */
function decodeBody(buffer, contentType) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''));
  const ct = String(contentType || '').toLowerCase();
  if (/charset=(gbk|gb2312|gb18030)/.test(ct)) return decodeWith(buf, 'gb18030');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    return decodeWith(buf, 'gb18030');
  }
}

/** 用指定编码解码，环境不支持该编码时退回宽松 UTF-8（绝不抛异常） */
function decodeWith(buffer, encoding) {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch (err) {
    return buffer.toString('utf8');
  }
}

/**
 * 发起一次 GET 请求并解析 JSON（带超时，绝不抛出）
 * @param {string} url 完整地址
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<object|null>}
 */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      done(null);
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'User-Agent': 'campus-errand/1.0', Accept: 'application/json' }
    }, (res) => {
      const rawChunks = [];
      res.on('data', (chunk) => { rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      res.on('end', () => {
        let raw = '';
        try {
          raw = decodeBody(Buffer.concat(rawChunks), res.headers && res.headers['content-type']);
        } catch (err) {
          done(null);
          return;
        }
        try {
          done(JSON.parse(raw));
        } catch (err) {
          done(null);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * 查询 IP 归属地（对外唯一入口，永不抛异常）
 * @param {string} ip 客户端 IP
 * @returns {Promise<string>} 「省-市」；内网 / 查询失败 / 功能关闭时返回空串
 */
async function resolveRegion(ip) {
  const value = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!value || value === 'unknown') return '';
  if (isPrivateIp(value)) return '';
  if (!isEnabled()) return '';

  const cached = regionCache.get(value);
  if (cached && cached.expireAt > Date.now()) return cached.region;

  const timeoutMs = getTimeout();
  const primary = String(process.env.IP_REGION_API || DEFAULT_PROVIDER).replace('{ip}', encodeURIComponent(value));
  const fallback = String(process.env.IP_REGION_FALLBACK_API || DEFAULT_FALLBACK)
    .replace('{ip}', encodeURIComponent(value));

  let region = parseRegionPayload(await httpGetJson(primary, timeoutMs));
  if (!region && fallback) {
    region = parseRegionPayload(await httpGetJson(fallback, timeoutMs));
  }

  // 写入缓存（含负缓存）：命中缓存的后续登录零外部请求
  if (regionCache.size >= CACHE_MAX) regionCache.clear();
  regionCache.set(value, {
    region,
    expireAt: Date.now() + (region ? CACHE_TTL_MS : CACHE_FAIL_TTL_MS)
  });
  if (!region) log('warn', `IP 归属地解析失败（不影响登录）：${value}`);
  return region;
}

module.exports = {
  resolveRegion,
  isPrivateIp,
  normalizeArea,
  formatIpRegion,
  parseRegionPayload,
  isEnabled
};
