/**
 * 小程序页面运行时加载自检：
 * 用桩替换 wx / Page / Component / App / getApp，真实 require 每个页面 JS，
 * 抓出「编译能过、但一进页面就抛异常」的问题（例如模块级代码报错）。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../../miniprogram');
const storage = {};

global.wx = new Proxy({}, {
  get(target, prop) {
    if (prop === 'getSystemInfoSync') return () => ({ platform: 'devtools', SDKVersion: '3.0.0' });
    if (prop === 'getStorageSync') return (k) => storage[k];
    if (prop === 'setStorageSync') return (k, v) => { storage[k] = v; };
    if (prop === 'removeStorageSync') return (k) => { delete storage[k]; };
    if (prop === 'getAccountInfoSync') return () => ({ miniProgram: { envVersion: 'develop' } });
    if (prop === 'showToast' || prop === 'showModal' || prop === 'hideLoading' || prop === 'showLoading') return () => {};
    return () => ({});
  }
});

const pages = [];
const errors = [];
global.Page = (obj) => pages.push(obj);
global.Component = () => {};
global.App = () => {};
global.getApp = () => ({ globalData: { userInfo: null }, isLogin: () => false });

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  });
  return out;
}

walk(ROOT).forEach((file) => {
  try {
    delete require.cache[require.resolve(file)];
    require(file);
    console.log(`  [OK]   ${path.relative(ROOT, file)}`);
  } catch (err) {
    errors.push(`${path.relative(ROOT, file)} -> ${err.message}`);
    console.log(`  [FAIL] ${path.relative(ROOT, file)} -> ${err.message}`);
  }
});

console.log(`\n共加载 ${pages.length} 个页面定义，失败 ${errors.length} 个`);
errors.forEach((e) => console.log('  ' + e));
process.exit(errors.length ? 1 : 0);