/**
 * =====================================================================
 * 公告数据层（首页跑马灯 + 全局通知条共用）
 * ---------------------------------------------------------------------
 *  · 一次拉取，模块级缓存 60 秒：多个页面 / 多个组件同时挂载时只打一次接口；
 *  · 并发去重：同一时刻多次调用共用同一个请求，不会重复打后端；
 *  · 「关闭通知条」只记录在本次小程序生命周期内（内存 Set），
 *    用户重进小程序会再次看到 —— 关闭表示「这次不想看」，不是永久屏蔽；
 *  · 任何失败都静默降级为空列表：公告拿不到绝不能影响页面其它功能。
 * =====================================================================
 */

const { get } = require('./request');

/** 缓存有效期：60 秒（同一分钟内多个页面打开只请求一次） */
const TTL = 60 * 1000;

/** 缓存的生效公告 { at, marquee, notice } */
let cache = null;
/** 进行中的请求（并发去重） */
let pending = null;
/** 本次小程序生命周期内被用户关闭的通知条 id */
const closedNoticeIds = new Set();

/**
 * 拉取当前生效中的公告（跑马灯 + 通知条）
 * @param {boolean} [force] 忽略缓存强制刷新
 * @returns {Promise<{marquee:Array, notice:Array}>}
 */
async function fetchActive(force) {
  const app = typeof getApp === 'function' ? getApp() : null;
  if (app && typeof app.isLogin === 'function' && !app.isLogin()) {
    return { marquee: [], notice: [] };
  }
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL) {
    return { marquee: cache.marquee, notice: cache.notice };
  }
  if (!pending) {
    pending = get('/api/announce/active', {})
      .then((res) => {
        const data = (res && res.data) || {};
        cache = { at: Date.now(), marquee: data.marquee || [], notice: data.notice || [] };
        return { marquee: cache.marquee, notice: cache.notice };
      })
      .catch(() => (cache
        ? { marquee: cache.marquee, notice: cache.notice }
        : { marquee: [], notice: [] }))
      .then((result) => {
        pending = null;
        return result;
      });
  }
  return pending;
}

/** 记录用户关闭了某条通知条（本次小程序生命周期内不再展示） */
function closeNotice(id) {
  closedNoticeIds.add(Number(id));
}

/** 该通知条是否已被用户关闭 */
function isNoticeClosed(id) {
  return closedNoticeIds.has(Number(id));
}

/** 清空缓存与关闭记录（退出登录 / 切换账号时调用） */
function reset() {
  cache = null;
  pending = null;
  closedNoticeIds.clear();
}

module.exports = { fetchActive, closeNotice, isNoticeClosed, reset };
