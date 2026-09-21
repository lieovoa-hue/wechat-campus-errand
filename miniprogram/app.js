/**
 * =====================================================================
 * 小程序入口
 *  - 全局保存登录态（access_token / refresh_token / 用户信息 / 设备标识）
 *  - 提供登录校验、跳转登录页等公共方法
 * =====================================================================
 */

const { request, setBaseUrl } = require('./utils/request');
const { MSG } = require('./utils/constant');
// 公告缓存（退出登录 / 切账号时要清掉，避免把上个账号看到的公告带过来）
const announce = require('./utils/announce');

/**
 * 底部 tabBar 下标
 * ---------------------------------------------------------------------
 * tabBar 顺序：0 首页 / 1 我的发布 / 2 我的任务 / 3 我的。
 * 角标必须按下标设置，所以这里的顺序必须与 app.json 的 tabBar.list 保持一致。
 *   · 我的发布：待雇主确认的订单数（只有雇主本人能处理）
 *   · 我的任务：进行中 + 待雇主确认（未完成）
 */
const TAB_PUBLISH_INDEX = 1;
const TAB_TAKE_INDEX = 2;

/**
 * 角标文本：超过 99 显示 99+，避免长数字把角标撑破
 * @param {number} count
 * @returns {string}
 */
function badgeText(count) {
  return count > 99 ? MSG.BADGE_OVERFLOW : String(count);
}

/**
 * 本地错误日志的缓存 key（保留最近 20 条，用于真机排障）
 * 真机上用户看不到控制台，出问题时可以让他在「我的」页连续点击版本号把日志取出来。
 */
const ERR_LOG_KEY = 'appErrorLog';

App({
  globalData: {
    // 用户信息（包含 userIdText 账号编号：管理员 A0001、普通用户 X0001）
    userInfo: null,
    // 登录令牌
    accessToken: '',
    refreshToken: '',
    // 设备标识，用于单设备登录校验
    deviceId: '',
    systemInfo: null
  },

  onLaunch() {
    this.initDeviceId();
    this.restoreToken();
    this.loadSystemInfo();

    // 若在 utils/request.js 中未配置，可通过本地缓存覆盖后端地址（cpolar 域名）
    const customBase = wx.getStorageSync('BASE_URL');
    if (customBase) {
      setBaseUrl(customBase);
    }

    // 已登录但尚未设置密保：引导到设置页（后端会拦截其它业务接口，这里提前引导体验更顺）
    if (this.isLogin()) {
      setTimeout(() => this.ensureSecuritySetup(), 800);
    }
  },

  /** 初始化设备标识（卸载重装会变化，用于单设备登录判定） */
  initDeviceId() {
    let deviceId = wx.getStorageSync('deviceId');
    if (!deviceId) {
      deviceId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      wx.setStorageSync('deviceId', deviceId);
    }
    this.globalData.deviceId = deviceId;
  },

  /** 从本地缓存恢复登录态 */
  restoreToken() {
    const accessToken = wx.getStorageSync('accessToken') || '';
    const refreshToken = wx.getStorageSync('refreshToken') || '';
    const userInfo = wx.getStorageSync('userInfo') || null;
    this.globalData.accessToken = accessToken;
    this.globalData.refreshToken = refreshToken;
    this.globalData.userInfo = userInfo;
  },

  /**
   * 全局错误收集（上线排障用）
   * ---------------------------------------------------------------------
   * 小程序在真机上出错时开发者看不到控制台，这里统一做两件事：
   *   1. 打印到控制台（开发者工具 / 真机调试仍可见）；
   *   2. 把最近 20 条错误摘要写入本地缓存（key: appErrorLog）。
   * 只记录「时间 + 类型 + 页面路径 + 错误摘要」，不记录任何用户隐私数据。
   */
  onError(err) {
    this.recordError('error', err);
  },

  /** 未处理的 Promise 异常（如忘了 catch 的异步请求） */
  onUnhandledRejection(res) {
    this.recordError('promise', (res && res.reason) || '未处理的 Promise 异常');
  },

  /**
   * 页面不存在时的兜底
   * ---------------------------------------------------------------------
   * 旧版本分享链接 / 路径改名后仍可能被打开，默认只会白屏，
   * 这里统一回首页，用户至少不会卡在空白页。
   */
  onPageNotFound(res) {
    console.error('[onPageNotFound]', res && res.path);
    wx.switchTab({ url: '/pages/index/index' });
  },

  /**
   * 记录一条错误到本地环形日志（最多 20 条）
   * @param {string} type error / promise
   * @param {*} err 错误对象或字符串
   */
  recordError(type, err) {
    try {
      const msg = typeof err === 'string' ? err : ((err && (err.message || err.errMsg)) || String(err));
      const stack = (err && err.stack) ? String(err.stack).slice(0, 500) : '';
      const pages = getCurrentPages() || [];
      const route = pages.length ? pages[pages.length - 1].route : '';
      const list = wx.getStorageSync(ERR_LOG_KEY) || [];
      list.push({ t: Date.now(), type, route, msg: String(msg).slice(0, 300), stack });
      wx.setStorageSync(ERR_LOG_KEY, list.slice(-20));
      console.error('[app:' + type + ']', route, msg);
    } catch (e) {
      // 记录错误的过程本身不能再抛错，否则会无限递归
    }
  },

  /**
   * 回到前台时主动探测一次登录态
   * ---------------------------------------------------------------------
   * 单设备登录下「被顶下线」的旧设备不会收到任何服务端推送，
   * 如果用户一直停留在某个页面不动，就只会看到「莫名掉线」。
   * 这里在小程序每次回到前台时打一次轻量请求：
   *   · 令牌正常 → 顺带刷新用户信息；
   *   · 已被顶下线 → 后端返回 401 + data.kicked，
   *     由 utils/request.js 统一弹出「新设备 / 时间 / IP」提示并回到登录页。
   */
  onShow() {
    if (!this.isLogin()) {
      // 未登录时清掉可能残留的角标（例如上个账号退出前留下的数字）
      this.clearTabBadge();
      return;
    }
    this.refreshUserInfo();
    // 回到前台顺手校准一次角标：期间任务状态可能在别的页面 / 别的设备上变了
    this.refreshTakeBadge();
  },

  /** 保存登录态 */
  saveLogin(data) {
    const { accessToken, refreshToken, user } = data || {};
    if (accessToken) {
      this.globalData.accessToken = accessToken;
      wx.setStorageSync('accessToken', accessToken);
    }
    if (refreshToken) {
      this.globalData.refreshToken = refreshToken;
      wx.setStorageSync('refreshToken', refreshToken);
    }
    if (user) {
      this.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);
    }
  },

  /** 清除登录态 */
  clearLogin() {
    this.globalData.accessToken = '';
    this.globalData.refreshToken = '';
    this.globalData.userInfo = null;
    wx.removeStorageSync('accessToken');
    wx.removeStorageSync('refreshToken');
    wx.removeStorageSync('userInfo');
    // 退出登录后必须把 tabBar 角标也清掉，否则下次打开会看到别人的未完成数
    this.clearTabBadge();
    // 公告缓存同理：清掉缓存与「已关闭」记录，切账号后重新拉取
    announce.reset();
  },

  /**
   * 刷新底部「我的任务」角标
   * ---------------------------------------------------------------------
   * 角标数字 = 我接的任务里「未完成」的数量（进行中 + 待雇主确认）。
   * 设计取舍：
   *   · 数据由后端一条 COUNT 查出（GET /api/task/tabBadge），前端不做本地累加，
   *     避免多处改状态后算出错误的数字；
   *   · 角标只是锦上添花，任何失败都静默忽略（比如未登录 / 网络抖动），
   *     绝不能因为一次请求失败就弹错误提示打断用户；
   *   · 超过 99 显示 99+，避免角标被长数字撑破。
   * 调用时机：4 个 tab 页的 onShow、以及会改变任务状态的操作之后。
   * @returns {Promise<void>}
   */
  async refreshTakeBadge() {
    if (!this.isLogin()) {
      this.clearTabBadge();
      return;
    }
    try {
      const res = await request({ url: '/api/task/tabBadge', method: 'GET' });
      const data = res.data || {};
      this.setTabBadge(TAB_PUBLISH_INDEX, Number(data.myPublishPending || 0));
      this.setTabBadge(TAB_TAKE_INDEX, Number(data.myTakeUnfinished || 0));
    } catch (err) {
      // 静默失败：角标拿不到不影响任何功能
    }
  },

  /**
   * 设置 / 移除某个 tabBar 角标
   * 失败静默：tabBar 尚未渲染完成时调用会 fail，属于正常情况，不需要提示用户。
   * @param {number} index tabBar 下标
   * @param {number} count 数量，<= 0 时移除角标
   */
  setTabBadge(index, count) {
    if (count > 0) {
      wx.setTabBarBadge({ index, text: badgeText(count), fail: () => {} });
    } else {
      wx.removeTabBarBadge({ index, fail: () => {} });
    }
  },

  /**
   * 移除所有 tabBar 角标（未登录 / 退出登录时调用）
   * 否则下次打开会看到上个账号留下的数字。
   */
  clearTabBadge() {
    [TAB_PUBLISH_INDEX, TAB_TAKE_INDEX].forEach((index) => {
      wx.removeTabBarBadge({ index, fail: () => {} });
    });
  },

  /** 是否已登录 */
  isLogin() {
    return !!this.globalData.accessToken;
  },

  /**
   * 检查是否已完成密保设置，未完成则跳转「设置密保」页面
   * @returns {Promise<boolean>} true = 已完成（或无需设置，如管理员账号）
   */
  async ensureSecuritySetup() {
    if (!this.isLogin()) return true;
    const data = await this.refreshUserInfo();
    if (!data) return true;
    // 管理员账号权限最高，不受密保设置限制
    if (data.user && data.user.isAdmin) return true;
    if (data.needSetSecurity) {
      wx.navigateTo({ url: '/pages/securitySetup/securitySetup' });
      return false;
    }
    return true;
  },

  /**
   * 校验登录，未登录时跳转登录页
   * @returns {boolean}
   */
  checkLogin() {
    if (this.isLogin()) return true;
    wx.navigateTo({ url: '/pages/login/login' });
    return false;
  },

  /** 拉取最新用户信息并写入全局 */
  async refreshUserInfo() {
    if (!this.isLogin()) return null;
    try {
      const res = await request({ url: '/api/user/info', method: 'GET' });
      this.globalData.userInfo = res.data.user;
      wx.setStorageSync('userInfo', res.data.user);
      return res.data;
    } catch (err) {
      return null;
    }
  },

  /** 获取系统信息（用于自定义导航等） */
  loadSystemInfo() {
    try {
      this.globalData.systemInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (err) {
      this.globalData.systemInfo = null;
    }
  },

  /**
   * 设备名称（仅用于「我的 → 设备管理」展示，不参与任何安全判定）
   * @returns {string} 形如 iPhone 13 / 微信开发者工具
   */
  getDeviceName() {
    try {
      const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      const brand = String((info && info.brand) || '').trim();
      const model = String((info && info.model) || '').trim();
      const system = String((info && info.system) || '').trim();
      const name = `${brand} ${model}`.trim() || system || '未知设备';
      return name.slice(0, 60);
    } catch (err) {
      return '未知设备';
    }
  },

  /**
   * 获取 wx.login 的临时登录凭证 code
   * 后端用它换取 openid，实现「常用设备免验证、换设备必须答密保」。
   * 失败时返回空串（后端自动回退到设备指纹方案），绝不阻断登录流程。
   * @returns {Promise<string>}
   */
  getWxCode() {
    return new Promise((resolve) => {
      try {
        wx.login({
          success: (res) => resolve((res && res.code) || ''),
          fail: () => resolve('')
        });
      } catch (err) {
        resolve('');
      }
    });
  },

  /**
   * 组装登录 / 注册 / 解锁接口需要的设备信息
   * @returns {Promise<{deviceId:string, deviceName:string, code:string}>}
   */
  async getDevicePayload() {
    const code = await this.getWxCode();
    return {
      deviceId: this.globalData.deviceId || '',
      deviceName: this.getDeviceName(),
      code
    };
  }
});
