/**
 * =====================================================================
 * 主题模式（跟随系统 / 手动覆盖）真值表自检
 * ---------------------------------------------------------------------
 * utils/theme.js 的取值口径：
 *   手动偏好（light / dark）> 系统深浅色 > 浅色兜底
 * 这条口径没法靠肉眼看页面验证（模拟器的系统主题不一定能随便切），
 * 所以这里用 mock 的 wx 把四个组合跑一遍，断言：
 *   1) 四个组合的 isDark / getClass 结果正确；
 *   2) 缓存里只认 light / dark，其余一律回落 auto；
 *   3) 系统主题变化时，auto 模式跟着变、手动模式不受影响；
 *   4) 原生外观（导航栏 / tabBar / 窗口底色）跟着同一个真值走。
 *
 * 运行：node scripts/checkThemeMode.js
 * =====================================================================
 */

const path = require('path');

const THEME_PATH = path.resolve(__dirname, '../../miniprogram/utils/theme');

let failCount = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  [OK]   ' + label + ' = ' + a);
  } else {
    failCount += 1;
    console.log('  [FAIL] ' + label + ' = ' + a + '，期望 ' + e);
  }
}

/**
 * 造一个最小可用的 wx 环境
 * @param {Object} opts { storage, systemTheme }
 */
function makeEnv(opts) {
  const storage = Object.assign({}, opts.storage || {});
  const calls = [];
  const themeHandlers = [];
  const env = {
    storage,
    calls,
    themeHandlers,
    fireThemeChange: function (theme) {
      themeHandlers.forEach(function (cb) { cb({ theme: theme }); });
    }
  };
  global.wx = {
    getStorageSync: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''; },
    setStorageSync: function (key, value) { storage[key] = value; },
    removeStorageSync: function (key) { delete storage[key]; },
    getAppBaseInfo: function () { return { theme: opts.systemTheme || 'light' }; },
    getSystemInfoSync: function () { return { theme: opts.systemTheme || 'light' }; },
    onThemeChange: function (cb) { themeHandlers.push(cb); },
    setNavigationBarColor: function (o) { calls.push({ api: 'setNavigationBarColor', o: o }); },
    setTabBarStyle: function (o) { calls.push({ api: 'setTabBarStyle', o: o }); },
    setBackgroundColor: function (o) { calls.push({ api: 'setBackgroundColor', o: o }); }
  };
  global.getCurrentPages = function () { return [{ route: 'pages/index/index' }]; };
  return env;
}

/** 每个用例都要拿到「全新的模块状态」（theme.js 里缓存了 systemDark） */
function freshTheme() {
  delete require.cache[require.resolve(THEME_PATH)];
  return require(THEME_PATH);
}

const cases = [
  { label: 'A 无偏好 + 系统浅色 -> 浅色', storage: {}, systemTheme: 'light', dark: false, mode: 'auto' },
  { label: 'B 无偏好 + 系统深色 -> 深色', storage: {}, systemTheme: 'dark', dark: true, mode: 'auto' },
  { label: 'C 手动深色 + 系统浅色 -> 深色', storage: { themeMode: 'dark' }, systemTheme: 'light', dark: true, mode: 'dark' },
  { label: 'D 手动浅色 + 系统深色 -> 浅色', storage: { themeMode: 'light' }, systemTheme: 'dark', dark: false, mode: 'light' },
  { label: 'E 缓存脏值 abc -> 回落跟随系统', storage: { themeMode: 'abc' }, systemTheme: 'dark', dark: true, mode: 'auto' }
];

console.log('=== 1. 真值表（手动偏好 > 系统 > 浅色） ===');
cases.forEach(function (item) {
  const env = makeEnv(item);
  const theme = freshTheme();
  theme.init();
  check(item.label + ' · isDark', theme.isDark(), item.dark);
  check(item.label + ' · getClass', theme.getClass(), item.dark ? 'theme-dark' : 'theme-light');
  check(item.label + ' · getMode', theme.getMode(), item.mode);
  // 原生外观在 sync / setMode 时统一同步，见第 2 节断言
});

console.log('=== 2. 原生外观跟着同一个真值 ===');
[
  { label: '深色', storage: { themeMode: 'dark' }, systemTheme: 'light', wantNav: '#12151b', wantTab: '#6d8fff' },
  { label: '浅色', storage: { themeMode: 'light' }, systemTheme: 'dark', wantNav: '#ffffff', wantTab: '#2b5ce6' }
].forEach(function (item) {
  const env = makeEnv(item);
  const theme = freshTheme();
  theme.init();
  theme.sync({ data: {}, setData: function () {} });
  const nav = env.calls.filter(function (c) { return c.api === 'setNavigationBarColor'; }).pop();
  const tab = env.calls.filter(function (c) { return c.api === 'setTabBarStyle'; }).pop();
  const bg = env.calls.filter(function (c) { return c.api === 'setBackgroundColor'; }).pop();
  check(item.label + ' · 导航栏底色', nav && nav.o.backgroundColor, item.wantNav);
  check(item.label + ' · tabBar 选中色', tab && tab.o.selectedColor, item.wantTab);
  check(item.label + ' · 窗口底色', bg && bg.o.backgroundColor, item.label === '深色' ? '#0f1116' : '#f5f7fa');
});

console.log('=== 3. 系统主题变化时的广播 ===');
{
  const env = makeEnv({ storage: {}, systemTheme: 'light' });
  const theme = freshTheme();
  theme.init();
  const page = {
    data: { themeClass: 'theme-light' },
    setData: function (patch) { this.data = Object.assign({}, this.data, patch); }
  };
  theme.sync(page);
  check('auto · 系统浅色时页面类名', page.data.themeClass, 'theme-light');
  env.fireThemeChange('dark');
  check('auto · 系统转深色后页面类名', page.data.themeClass, 'theme-dark');
  check('auto · 系统转深色后 isDark', theme.isDark(), true);
}
{
  const env = makeEnv({ storage: { themeMode: 'light' }, systemTheme: 'light' });
  const theme = freshTheme();
  theme.init();
  const page = {
    data: { themeClass: 'theme-light' },
    setData: function (patch) { this.data = Object.assign({}, this.data, patch); }
  };
  theme.sync(page);
  env.fireThemeChange('dark');
  check('手动浅色 · 系统转深色后仍是浅色', page.data.themeClass, 'theme-light');
  check('手动浅色 · isDark', theme.isDark(), false);
}

console.log('=== 4. 开关切换与长按恢复跟随系统 ===');
{
  const env = makeEnv({ storage: {}, systemTheme: 'light' });
  const theme = freshTheme();
  theme.init();
  const first = theme.toggle();
  check('浅色下点击开关 -> 深色', [first.mode, first.dark], ['dark', true]);
  check('切换后写入缓存', env.storage.themeMode, 'dark');
  const second = theme.toggle();
  check('再点一次 -> 浅色', [second.mode, second.dark], ['light', false]);
  theme.setMode('auto');
  check('长按恢复跟随系统', [env.storage.themeMode, theme.isAuto()], ['auto', true]);
}

console.log('\n主题模式自检结束：失败 ' + failCount + ' 个');
process.exit(failCount ? 1 : 0);
