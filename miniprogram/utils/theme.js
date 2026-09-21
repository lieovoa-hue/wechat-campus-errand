/**
 * =====================================================================
 * 主题（浅色 / 深色）· 全站唯一真值来源
 * ---------------------------------------------------------------------
 * 为什么需要这个文件：
 *   全站颜色都走 app.wxss 里的 CSS 变量（--bg / --surface / --text-1 …），
 *   所以「换主题」本质只有两步：
 *     ① 给页面根节点挂上 .theme-dark 或 .theme-light，变量整体换一套；
 *     ② 把原生外观（导航栏 / tabBar / 窗口底色）同步成同色系。
 *   本文件把这两步收敛到一处，页面只做三件事：
 *     · data 里写上 themeClass（模块加载时同步取值，首帧就是正确主题，不闪白）；
 *     · onShow 里 theme.sync(this)（回到页面时校准，并同步原生外观）；
 *     · onUnload 里 theme.unsync(this)（取消订阅，避免实例被一直持有）。
 *
 * 三档模式（本地缓存 key：themeMode）
 *   auto ：默认值，跟随系统深浅色；系统切了就跟着切；
 *   light / dark：用户手动锁定，优先级最高（「系统深色 + 手动浅色」也能生效）。
 *   注意：媒体查询 prefers-color-scheme 做不到「手动覆盖系统」，所以真值
 *        只在 JS 里算一次，再由页面挂类，全站只有一个判断口径。
 *
 * 系统主题变化
 *   wx.onThemeChange 全局只注册一次（app.js 的 onLaunch 里 theme.init()），
 *   变化时先刷新系统主题缓存，再广播给所有已 sync 的页面实例与原生外观。
 * =====================================================================
 */

/** 三档主题模式 */
const MODES = {
  AUTO: 'auto',
  LIGHT: 'light',
  DARK: 'dark'
};

/** 本地缓存 key（不要改名：改了等于所有老用户的手动偏好被重置） */
const STORAGE_KEY = 'themeMode';

/** 页面根节点上的两个类名，定义见 app.wxss「1.1 暗色主题」 */
const CLASS = {
  LIGHT: 'theme-light',
  DARK: 'theme-dark'
};

/**
 * 原生外观两套值
 * ---------------------------------------------------------------------
 * 必须与 app.json + theme.json 完全一致：
 *   app.json / theme.json 负责「系统主题变化」时的原生外观，
 *   本表负责「用户手动切换」时的原生外观，两者任一不同都会出现
 *   「页面是深色、导航栏还是白色」的割裂感。
 */
const NATIVE = {
  light: {
    navBackground: '#ffffff',
    navFront: '#000000',
    tabBackground: '#ffffff',
    tabBorder: 'black',
    tabColor: '#6b7688',
    tabSelectedColor: '#2b5ce6',
    windowBackground: '#f5f7fa'
  },
  dark: {
    navBackground: '#12151b',
    navFront: '#ffffff',
    tabBackground: '#12151b',
    tabBorder: 'black',
    tabColor: '#8a93a3',
    tabSelectedColor: '#6d8fff',
    windowBackground: '#0f1116'
  }
};

/**
 * 带 tabBar 的页面路由
 * tabBar 只在 4 个根页面存在，非 tab 页调 setTabBarStyle 没有意义（且开发者工具会报警告），
 * 所以这里显式列出，必须与 app.json 的 tabBar.list 保持一致。
 */
const TAB_ROUTES = [
  'pages/index/index',
  'pages/myPublish/myPublish',
  'pages/myTake/myTake',
  'pages/profile/profile'
];

/** 系统是否深色：null 表示还没探测过（探测结果会缓存，切主题时刷新） */
let systemDark = null;
/** wx.onThemeChange 是否已注册（全局只注册一次） */
let listenerReady = false;
/** 已 sync 的页面实例（系统主题变化时广播给它们重新上色） */
const livePages = new Set();

/**
 * 探测系统深浅色
 * ---------------------------------------------------------------------
 * 新基础库用 wx.getAppBaseInfo().theme，老基础库退到 wx.getSystemInfoSync().theme；
 * 都拿不到时按浅色处理（绝大多数机型的默认值），任何异常都不能影响页面渲染。
 * @returns {boolean}
 */
function probeSystemDark() {
  let theme = '';
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const info = wx.getAppBaseInfo();
      if (info && typeof info.theme === 'string') theme = info.theme;
    }
  } catch (err) {
    theme = '';
  }
  if (!theme) {
    try {
      const info = typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null;
      if (info && typeof info.theme === 'string') theme = info.theme;
    } catch (err) {
      theme = '';
    }
  }
  return theme === 'dark';
}

/**
 * 调用一个 wx 原生外观接口
 * 失败一律静默：外观没同步上只是不好看，绝不能让页面逻辑跟着挂掉。
 * @param {string} name wx 上的方法名
 * @param {Object} options 参数
 */
function safeCall(name, options) {
  try {
    if (typeof wx[name] === 'function') {
      wx[name](Object.assign({ fail: () => {} }, options));
    }
  } catch (err) {
    // 忽略：原生外观同步失败不影响业务
  }
}

/** 当前页面是不是带 tabBar 的根页面 */
function isTabRoute() {
  try {
    if (typeof getCurrentPages !== 'function') return false;
    const stack = getCurrentPages() || [];
    const current = stack[stack.length - 1];
    const route = current && current.route ? String(current.route) : '';
    if (route) return TAB_ROUTES.indexOf(route) > -1;
  } catch (err) {
    // 拿不到路由时按「不是 tab 页」处理，最坏情况是这次不刷 tabBar，下次 onShow 会补上
  }
  return false;
}

/**
 * 同步原生外观（导航栏 / 窗口底色 / tabBar）
 * @param {boolean} dark 是否深色
 */
function applyNative(dark) {
  const cfg = dark ? NATIVE.dark : NATIVE.light;

  safeCall('setNavigationBarColor', {
    frontColor: cfg.navFront,
    backgroundColor: cfg.navBackground
  });

  // 窗口底色：控制下拉「橡皮筋」区域露出的颜色，不设的话深色下会闪一条白边
  safeCall('setBackgroundColor', {
    backgroundColor: cfg.windowBackground,
    backgroundColorTop: cfg.windowBackground,
    backgroundColorBottom: cfg.windowBackground
  });

  if (isTabRoute()) {
    safeCall('setTabBarStyle', {
      color: cfg.tabColor,
      selectedColor: cfg.tabSelectedColor,
      backgroundColor: cfg.tabBackground,
      borderStyle: cfg.tabBorder
    });
  }
}

/** 读取用户设定的模式（只认 light / dark，其余一律 auto） */
function getMode() {
  let saved = '';
  try {
    saved = wx.getStorageSync(STORAGE_KEY);
  } catch (err) {
    saved = '';
  }
  if (saved === MODES.LIGHT || saved === MODES.DARK) return saved;
  return MODES.AUTO;
}

/**
 * 当前是否深色（唯一判断口径）
 * @param {string} [mode] 不传则读缓存里的模式
 * @returns {boolean}
 */
function isDark(mode) {
  const target = mode || getMode();
  if (target === MODES.DARK) return true;
  if (target === MODES.LIGHT) return false;
  if (systemDark === null) systemDark = probeSystemDark();
  return systemDark;
}

/**
 * 当前主题类名（页面 data 初始化用，模块加载时同步调用，保证首帧不闪）
 * @returns {string} 'theme-dark' 或 'theme-light'
 */
function getClass(mode) {
  return isDark(mode) ? CLASS.DARK : CLASS.LIGHT;
}

/** 是否「跟随系统」（首页开关文案的判断依据：跟随系统时开关只反映系统状态） */
function isAuto() {
  return getMode() === MODES.AUTO;
}

/** 给单个页面实例上色（只在类名真的变了才 setData，避免每次 onShow 白刷一次视图） */
function paint(target, dark) {
  if (!target || typeof target.setData !== 'function') return;
  const cls = dark ? CLASS.DARK : CLASS.LIGHT;
  if (target.data && target.data.themeClass === cls) return;
  try {
    target.setData({ themeClass: cls });
  } catch (err) {
    // 页面已销毁时 setData 会失败，忽略
  }
}

/**
 * 设置主题模式并立即生效（写入缓存 + 全部在线页面重新上色 + 原生外观同步）
 * @param {string} mode auto / light / dark
 * @returns {boolean} 设置后是否为深色
 */
function setMode(mode) {
  const next = mode === MODES.LIGHT || mode === MODES.DARK ? mode : MODES.AUTO;
  try {
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (err) {
    // 缓存写失败（极少见）时依旧按本次选择渲染，只是下次进小程序会回到系统主题
  }
  const dark = isDark(next);
  livePages.forEach((page) => paint(page, dark));
  applyNative(dark);
  return dark;
}

/**
 * 切换浅色 / 深色（首页开关用）
 * 当前是深色就切浅色，当前是浅色（或跟随系统且系统为浅色）就切深色。
 * @returns {{mode: string, dark: boolean}} 切换后的模式与结果
 */
function toggle() {
  const next = isDark() ? MODES.LIGHT : MODES.DARK;
  return { mode: next, dark: setMode(next) };
}

/**
 * 页面 / 组件接入：登记实例 + 校准主题 + 同步原生外观
 * 约定写在 onShow 里（每次回到页面都会校准，包括从后台切回来的场景）。
 * @param {Object} target 页面实例（this）
 * @returns {boolean} 当前是否深色
 */
function sync(target) {
  if (target) livePages.add(target);
  const dark = isDark();
  if (target) paint(target, dark);
  applyNative(dark);
  return dark;
}

/** 取消登记（写在 onUnload 里，避免已销毁的页面实例被长期持有） */
function unsync(target) {
  if (target) livePages.delete(target);
}

/**
 * 全局初始化（只由 app.js 的 onLaunch 调用一次）
 * 注册系统主题变化监听：变化后重算唯一真值再广播，
 * 手动锁定模式的页面重算结果不变，paint 因类名相同直接跳过，不存在多余渲染。
 */
function init() {
  systemDark = probeSystemDark();
  if (listenerReady) return;
  listenerReady = true;
  try {
    if (typeof wx.onThemeChange === 'function') {
      wx.onThemeChange((res) => {
        systemDark = !!(res && res.theme === 'dark');
        const dark = isDark();
        livePages.forEach((page) => paint(page, dark));
        applyNative(dark);
      });
    }
  } catch (err) {
    // 老基础库没有 onThemeChange：手动开关仍然可用，只是不再自动跟随系统
  }
}

module.exports = {
  MODES,
  STORAGE_KEY,
  TAB_ROUTES,
  init,
  getMode,
  setMode,
  isDark,
  isAuto,
  getClass,
  toggle,
  sync,
  unsync,
  applyNative
};
