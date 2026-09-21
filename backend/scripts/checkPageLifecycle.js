/**
 * =====================================================================
 * 小程序页面「生命周期实跑」自检
 *   checkPageRuntime.js 只加载模块 + 执行 Page(config)，能抓到「模块顶层 /
 *   data 字面量」里的未定义引用；但抓不到写在 onLoad / onShow 等生命周期里的
 *   同类问题。本脚本在此基础上进一步：
 *     1) 真实 require 每个页面
 *     2) 用桩 wx / getApp 调用 onLoad / onShow / onReady / onPullDownRefresh /
 *        onReachBottom / onHide / onUnload
 *     3) 捕获同步异常与未处理的 Promise 异常
 *   重点关注 `xxx is not defined`（漏 require / 漏解构）这类致命错误。
 *   运行：node scripts/checkPageLifecycle.js
 * =====================================================================
 */

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../../miniprogram');

/** 收集到的错误 */
const problems = [];
/** 当前正在检查的文件（用于错误归属） */
let currentFile = '';
/** 记录尚未归属的错误数量，用于只统计新增 */
let seenErrors = 0;

/** 链式万能桩：任何属性访问都返回可调用、可继续取属性的代理 */
function chainStub(name, overrides) {
  const fn = function stub() { return proxy; };
  const proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'toString') return () => name;
      if (prop === 'then') return undefined;
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      return proxy;
    },
    apply() { return proxy; }
  });
  return proxy;
}

const storage = {};
global.wx = chainStub('wx', {
  getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667, platform: 'devtools' }),
  getSystemInfo: (opt) => { if (opt && opt.success) opt.success({ statusBarHeight: 20, windowWidth: 375 }); return undefined; },
  createSelectorQuery: () => chainStub('query'),
  showModal: () => Promise.resolve({ confirm: false, cancel: true }),
  showLoading: () => undefined,
  hideLoading: () => undefined,
  showToast: () => undefined,
  stopPullDownRefresh: () => undefined,
  navigateTo: () => undefined,
  switchTab: () => undefined,
  reLaunch: () => undefined
});

global.getApp = () => chainStub('app', { globalData: {} });
global.App = () => undefined;
global.Component = () => undefined;

const capturedPages = [];
global.Page = (config) => { capturedPages.push(config); };

process.on('unhandledRejection', (err) => record(err));

function record(err) {
  seenErrors += 1;
  problems.push({ file: currentFile, message: err && err.message ? err.message : String(err) });
}

/** 逐个页面加载 + 跑生命周期 */
function checkPage(file) {
  currentFile = path.relative(ROOT, file).replace(/\\/g, '/');
  capturedPages.length = 0;
  delete require.cache[require.resolve(file)];
  try {
    require(file);
  } catch (err) {
    record(err);
    return;
  }
  const page = capturedPages[0];
  if (!page) return;
  // 页面实例：必须把 page 上的所有方法挂上来，否则 this.loadXxx 会误报
  const ctx = Object.assign({}, page);
  ctx.data = JSON.parse(JSON.stringify(page.data || {}));
  ctx.setData = function setData(patch) { Object.assign(this.data, patch); };
  ctx.selectComponent = () => null;
  ctx.route = currentFile;
  const hooks = ['onLoad', 'onShow', 'onReady', 'onPullDownRefresh', 'onReachBottom', 'onHide', 'onUnload'];
  for (const hook of hooks) {
    if (typeof page[hook] !== 'function') continue;
    try {
      page[hook].call(ctx, {});
    } catch (err) {
      record(err);
    }
  }
}

/** 递归收集页面 JS */
function collect(dir, out) {
  const fs = require('fs');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js') && entry.name !== 'app.js') out.push(full);
  }
  return out;
}

const files = collect(path.join(ROOT, 'pages'), []).concat(collect(path.join(ROOT, 'components'), []));

for (const file of files) checkPage(file);

setTimeout(() => {
  console.log(`\n共实跑 ${files.length} 个页面/组件\n`);
  if (problems.length === 0) {
    console.log('未发现生命周期运行时错误（失败 0 个）');
    process.exit(0);
  }
  console.log(`发现 ${problems.length} 处运行时错误：`);
  for (const p of problems) console.log(`  [ERR] ${p.file} -> ${p.message}`);
  process.exit(1);
}, 1200);