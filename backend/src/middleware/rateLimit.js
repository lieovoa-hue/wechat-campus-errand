/**
 * =====================================================================
 * 接口限流中间件（内存滑动窗口计数器）
 * 必须限流的接口：登录、注册、发送验证码、发布任务、提交申诉
 * 说明：单机内存实现，若部署多实例可替换为 Redis 版本，接口签名保持一致。
 * =====================================================================
 */

const { fail } = require('../utils/common');
const { BIZ } = require('../utils/constant');

// key -> { count, resetAt }；定期清理过期键
const store = new Map();

// 每 5 分钟清理一次过期记录
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of store.entries()) {
    if (item.resetAt <= now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * 取客户端 IP（兼容反向代理）
 * ---------------------------------------------------------------------
 * 安全要点：X-Forwarded-For 是「客户端可以自行伪造」的请求头。
 *  标准代理（Nginx / cpolar 等）的做法是在转发时把真实来源 IP 「追加到 XFF 末尾」，
 *  因此只有最右侧那一项才是可信的。
 *  ⚠ 已实测的漏洞：早期实现取的是最左侧一项（split(',')[0]），
 *    攻击者只要每次请求都换一个 X-Forwarded-For 值，就能让每个请求落进不同的限流桶，
 *    从公网彻底绕过 IP 维度的限流（实测 65 次伪造 IP 请求 100% 放行）。
 *  现改为取最右侧一项，并对 IP 格式做校验，非法值直接丢弃并回退到 socket 层地址。
 * @param {import('express').Request} req
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    // 从右往左找第一个合法 IP（最右侧 = 最后一跳代理写入的真实来源）
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (isValidIp(parts[i])) return parts[i];
    }
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

/**
 * IP 字面量格式校验（IPv4 / IPv6）
 * 目的：防止把任意字符串（攻击者伪造的超长 XFF）当成限流键写入内存，造成内存膨胀
 * @param {string} value 待校验字符串
 * @returns {boolean}
 */
function isValidIp(value) {
  if (!value || value.length > 45) return false;
  // IPv4：四段 0-255
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((n) => Number(n) <= 255);
  }
  // IPv6：只允许十六进制与冒号（含 :: 缩写与 IPv4 映射写法中的点）
  return /^[0-9a-fA-F:.]+$/.test(value) && value.indexOf(':') >= 0;
}

/**
 * 创建限流中间件
 * @param {object} options
 * @param {number} options.windowMs 时间窗口（毫秒）
 * @param {number} options.max 窗口内最大请求次数
 * @param {string} options.name 限流标识（区分不同接口）
 * @param {string} [options.message] 触发限流时的提示
 * @param {(req)=>string} [options.keyGenerator] 自定义限流维度
 * @returns {import('express').RequestHandler}
 */
function createRateLimit({ windowMs, max, name, message, keyGenerator }) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyGenerator
      ? `${name}:${keyGenerator(req)}`
      : `${name}:${getClientIp(req)}`;
    const now = Date.now();
    const item = store.get(key);

    if (!item || item.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    item.count += 1;
    if (item.count > max) {
      const waitSec = Math.ceil((item.resetAt - now) / 1000);
      res.set('Retry-After', String(waitSec));
      return fail(res, 409, message || `操作过于频繁，请${waitSec}秒后再试`);
    }
    return next();
  };
}

/**
 * 以手机号/账号为维度限流（存在则优先使用，避免多人共用校园网 IP 被误伤）
 */
const byPhoneOrIp = (req) => {
  const body = req.body || {};
  return String(body.phone || body.account || getClientIp(req));
};

// ---------------- 各接口限流规则 ----------------

/** 登录：1 分钟最多 10 次（另有 5 次密码错误锁定账号的强规则） */
const loginLimit = createRateLimit({
  name: 'login',
  windowMs: 60 * 1000,
  max: 10,
  message: '登录尝试过于频繁，请1分钟后再试',
  keyGenerator: byPhoneOrIp
});

/**
 * 注册：同一账号ID 1 小时最多 5 次
 * 说明：注册请求体里的账号标识字段是 accountNo（手机号已改为选填），
 *      所以限流维度取 accountNo -> phone -> IP，既防止对同一个 ID 反复提交注册，
 *      又避免「整个宿舍共用出口 IP」时把正常同学误伤。
 */
const registerLimit = createRateLimit({
  name: 'register',
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: '注册过于频繁，请稍后再试',
  keyGenerator: (req) => {
    const body = req.body || {};
    return String(body.accountNo || body.phone || getClientIp(req)).toUpperCase();
  }
});

/**
 * 注册的第二道闸门：同一 IP 1 小时最多 30 次
 * 说明：账号级限流能挡住「死磕一个 ID」，但换 ID 就能绕过，因此再加一层宽松的 IP 兜底；
 *      真正卡住批量注册的是图形验证码（IP 级 1 小时 60 次），三层叠加后成本极高。
 */
const registerIpLimit = createRateLimit({
  name: 'registerIp',
  windowMs: 60 * 60 * 1000,
  // 可用 .env 的 REGISTER_IP_HOURLY_LIMIT 覆盖（cpolar 内网穿透下所有用户可能共用一个出口 IP）
  max: Number(process.env.REGISTER_IP_HOURLY_LIMIT || BIZ.REGISTER_IP_HOURLY_LIMIT),
  message: '注册过于频繁，请稍后再试'
});

/**
 * 获取图形验证码：1 小时最多 20 次
 * 说明：图形验证码完全本地生成、零成本，但仍必须限流，否则脚本可以无限刷新图片做 OCR 训练。
 */
const captchaLimit = createRateLimit({
  name: 'captcha',
  windowMs: 60 * 60 * 1000,
  // 可用 .env 的 CAPTCHA_HOURLY_LIMIT 覆盖：校园网 + cpolar 内网穿透场景下，
  // 大量用户可能共用同一个出口 IP，阈值过低会把整栋楼的同学一起限流。
  max: Number(process.env.CAPTCHA_HOURLY_LIMIT || BIZ.CAPTCHA_HOURLY_LIMIT),
  message: '验证码获取过于频繁，请稍后再试'
});

/**
 * 注册辅助接口（随机生成账号ID / 校验账号ID是否可用）：1 小时最多 30 次
 * 说明：这两个接口只暴露「账号ID是否被占用」，不会泄漏任何隐私数据，限流目的仅是防穷举。
 */
const accountHelperLimit = createRateLimit({
  name: 'accountHelper',
  windowMs: 60 * 60 * 1000,
  // 可用 .env 的 ACCOUNT_HELPER_HOURLY_LIMIT 覆盖：注册页「随机生成」按钮会调用该接口，
  // 校园网 / cpolar 内网穿透下大量用户共用出口 IP，阈值过低会让随机按钮直接失效。
  max: Number(process.env.ACCOUNT_HELPER_HOURLY_LIMIT || BIZ.ACCOUNT_HELPER_HOURLY_LIMIT),
  message: '操作过于频繁，请稍后再试'
});

/**
 * 密保相关接口（取密保问题 / 重置密码 / 新设备解锁）：1 小时最多 10 次
 * 说明：这三个接口是「猜密保答案」的主要入口，限流必须比普通接口更严；
 *      更细的「连续答错 5 次锁定 15 分钟」规则在业务层按账号统计。
 */
const securityLimit = createRateLimit({
  name: 'security',
  windowMs: 60 * 60 * 1000,
  // 可用 .env 的 SECURITY_HOURLY_LIMIT 覆盖：同 IP 下可能有多个用户（宿舍共用出口 / cpolar 穿透），
  // 单账号的暴力猜测由「连续答错 5 次锁定 15 分钟」兜底，IP 维度只做宽松的频率兜底。
  max: Number(process.env.SECURITY_HOURLY_LIMIT || BIZ.SECURITY_HOURLY_LIMIT),
  message: '安全校验过于频繁，请稍后再试'
});

/** 发布任务：1 分钟最多 5 次 */
const publishLimit = createRateLimit({
  name: 'publish',
  windowMs: 60 * 1000,
  max: 5,
  message: '发布过于频繁，请稍后再试',
  keyGenerator: (req) => String(req.user ? req.user.id : getClientIp(req))
});

/** 提交申诉：1 天最多 5 次（更细的每日 2 条规则在业务层按天统计） */
const appealLimit = createRateLimit({
  name: 'appeal',
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: '申诉提交过于频繁，请稍后再试',
  keyGenerator: (req) => String(req.user ? req.user.id : getClientIp(req))
});

/** 通用写接口限流：1 分钟 60 次 */
const commonWriteLimit = createRateLimit({
  name: 'write',
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => String(req.user ? req.user.id : getClientIp(req))
});

module.exports = {
  createRateLimit,
  loginLimit,
  registerLimit,
  registerIpLimit,
  captchaLimit,
  accountHelperLimit,
  securityLimit,
  publishLimit,
  appealLimit,
  commonWriteLimit,
  getClientIp
};
