/**
 * =====================================================================
 * 上传图片（/uploads/**）访问签名工具
 * ---------------------------------------------------------------------
 * 【为什么要做这件事】
 *   uploads 目录里存的是校园认证截图、头像、任务照片、送达照片。
 *   其中「校园认证截图」包含真实姓名、学号、手机号、宿舍等强隐私信息。
 *   若把它挂成公开静态目录（app.use('/uploads', express.static(...))），
 *   任何人只要拿到 URL（或遍历猜到文件名）就能在【未登录】状态下查看，
 *   属于典型的「敏感文件未授权访问」漏洞。
 *
 * 【方案：带签名的短时链接】
 *   1. 后端下发到前端的所有图片字符串，统一由 res.json 拦截器改写成：
 *        /uploads/202609/xxx.jpg?e=<过期时间戳>&s=<HMAC-SHA256 签名>
 *   2. /uploads 前面的守卫中间件验签通过后，才把文件交给静态中间件；
 *      没带签名 / 签名错误 / 已过期，一律 403。
 *   3. 因为小程序 <image> 标签无法携带 Authorization 请求头，
 *      只能把凭证放在 URL 上，这也是云存储「签名 URL」的通用做法。
 *
 * 【为什么用「时间窗」而不是「当前时间 + N 小时」】
 *   如果每次都按 Date.now() 生成过期时间，同一张图每次刷新都会得到
 *   不同的 URL，微信小程序的图片缓存会彻底失效（每次重新下载，费流量）。
 *   这里把过期时间对齐到 WINDOW 的整数倍、并额外多给一个窗口：
 *     - 同一窗口内生成的 URL 完全一致  -> 缓存友好
 *     - 任意时刻生成的 URL 至少还有 1 个窗口的有效期 -> 不会刚生成就过期
 *   即以 6 小时为窗口时：有效期最短 6 小时、最长 12 小时。
 *
 * 【密钥从哪来】
 *   优先读 MEDIA_SIGN_SECRET，没配则回退到 JWT_SECRET。
 *   两者用途不同，这里用 HMAC 做「域分离」派生出一把独立的子密钥，
 *   避免直接用 JWT 签名密钥去签图片地址（同一份密钥材料跨用途使用是坏习惯）。
 * =====================================================================
 */

const crypto = require('crypto');

/** 签名有效期窗口：默认 6 小时（可用 .env 的 MEDIA_URL_WINDOW_HOURS 覆盖） */
function getWindowMs() {
  const hours = Number(process.env.MEDIA_URL_WINDOW_HOURS || 6);
  // 容错：配置成非正数时回退到默认，避免窗口为 0 导致签名立刻过期
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
  return safeHours * 60 * 60 * 1000;
}

/** 签名长度（十六进制字符数）：32 个 hex 字符 = 128 bit，足够抗暴力枚举 */
const SIG_LENGTH = 32;

/** 域分离标签：改动此值会让所有已下发的图片链接立即失效（等于强制刷新缓存） */
const DOMAIN_TAG = 'campus-errand:media-url:v1';

/**
 * 取签名密钥材料（缺少配置直接抛错，绝不用空密钥裸签）
 * @returns {string}
 */
function getSecretSource() {
  const secret = process.env.MEDIA_SIGN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('MEDIA_SIGN_SECRET / JWT_SECRET 均未配置，无法为图片生成访问签名');
  }
  return secret;
}

/**
 * 派生实际的签名密钥（带域分离，与 JWT 签名密钥互不影响）
 * @returns {Buffer}
 */
function getSignKey() {
  return crypto.createHmac('sha256', getSecretSource()).update(DOMAIN_TAG).digest();
}

/**
 * 把请求路径归一化成「签名用的标准形式」
 *  - 去掉查询串（签名只覆盖文件路径，不覆盖参数）
 *  - 解码百分号转义，保证 /uploads/a%2Db.jpg 与 /uploads/a-b.jpg 一致
 *  - 统一去掉结尾多余的 /
 * @param {string} rawUrl 原始地址（可以是 req.originalUrl，也可以是数据库里的相对路径）
 * @returns {string} 形如 /uploads/202609/xxx.jpg；非法输入返回空串
 */
function normalizePath(rawUrl) {
  const value = String(rawUrl || '');
  if (!value) return '';
  // 先截掉查询串与锚点，再做解码
  let pathname = value.split('#')[0].split('?')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (err) {
    // 非法转义序列（如单独的 %）保持原样，后续验签自然失败
  }
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * 判断一个字符串是否是「需要签名」的本地上传图片地址
 * @param {*} value
 * @returns {boolean}
 */
function isUploadPath(value) {
  if (typeof value !== 'string') return false;
  if (value.indexOf('/uploads/') !== 0) return false;
  // 已经带签名的地址不重复处理，避免嵌套签名
  return value.indexOf('?') === -1;
}

/**
 * 计算签名
 * @param {string} pathname 归一化后的路径
 * @param {number} exp 过期时间戳（毫秒）
 * @returns {string} 十六进制签名字符串
 */
function calcSignature(pathname, exp) {
  return crypto
    .createHmac('sha256', getSignKey())
    .update(`${pathname}|${exp}`)
    .digest('hex')
    .slice(0, SIG_LENGTH);
}

/**
 * 为图片相对路径生成带签名的可访问地址
 * @param {string} path 形如 /uploads/202609/xxx.jpg
 * @param {number} [now] 当前时间戳（便于测试注入）
 * @returns {string} 原路径 + ?e=过期时间 &s=签名
 */
function buildSignedUrl(path, now) {
  const pathname = normalizePath(path);
  if (!pathname || pathname.indexOf('/uploads/') !== 0) return path;
  const windowMs = getWindowMs();
  const base = Number.isFinite(now) ? now : Date.now();
  // 对齐到下下个窗口：保证 URL 在同一窗口内稳定，且至少还有 1 个完整窗口有效
  const exp = (Math.floor(base / windowMs) + 2) * windowMs;
  return `${pathname}?e=${exp}&s=${calcSignature(pathname, exp)}`;
}

/**
 * 校验图片访问签名
 * @param {string} pathname 请求路径（内部会归一化）
 * @param {number|string} exp 请求带来的过期时间戳
 * @param {string} sig 请求带来的签名
 * @returns {boolean} 是否放行
 */
function verifySignature(pathname, exp, sig) {
  const normalized = normalizePath(pathname);
  if (!normalized || normalized.indexOf('/uploads/') !== 0) return false;
  if (!isUploadPath(normalized)) return false; // 归一化后仍带 ? 说明路径本身异常

  const expNum = Number(exp);
  const sigStr = String(sig || '');
  if (!Number.isFinite(expNum) || expNum <= 0) return false;
  if (sigStr.length !== SIG_LENGTH) return false;
  // 过期即拒绝：签名只保证「内容未被篡改 + 在有效期内」，不保证永久可用
  if (expNum < Date.now()) return false;

  const expect = calcSignature(normalized, expNum);
  // 定长比较 + timingSafeEqual，避免通过响应耗时逐字节猜签名
  const a = Buffer.from(sigStr, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 递归改写响应体里所有未签名的 /uploads 地址
 * 说明：直接原地修改对象，避免深拷贝带来的额外开销；
 *      响应对象都是本次请求现场构造的 VO，不会被其它请求复用。
 * @param {*} node 任意响应数据
 * @param {number} [now] 当前时间戳（便于测试注入）
 */
function rewriteInPlace(node, now) {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') return; // 字符串本身不可原地替换，由父级处理

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const item = node[i];
      if (isUploadPath(item)) {
        node[i] = buildSignedUrl(item, now);
      } else if (item && typeof item === 'object') {
        rewriteInPlace(item, now);
      }
    }
    return;
  }

  if (typeof node === 'object') {
    // Date / Buffer 等内置对象不参与改写
    if (node instanceof Date || Buffer.isBuffer(node)) return;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const value = node[key];
      if (isUploadPath(value)) {
        node[key] = buildSignedUrl(value, now);
      } else if (value && typeof value === 'object') {
        rewriteInPlace(value, now);
      }
    }
  }
}

module.exports = {
  SIG_LENGTH,
  DOMAIN_TAG,
  getWindowMs,
  normalizePath,
  isUploadPath,
  buildSignedUrl,
  verifySignature,
  rewriteInPlace
};
