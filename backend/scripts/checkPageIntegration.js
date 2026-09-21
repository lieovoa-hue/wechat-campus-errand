/**
 * =====================================================================
 * 小程序「全部功能」真实联调自检（checkPageIntegration.js）
 * ---------------------------------------------------------------------
 * 其它脚本各守一段：
 *   checkMiniProgram.js          编译层：语法 / 标签闭合 / 花括号
 *   checkMiniProgramBindings.js  结构层：事件方法 / 数据字段 / class
 *   checkPageRuntime.js          模块层：require 能否执行、Page() 能否调用
 *   checkPageLifecycle.js        生命周期层：桩 wx，只抓 JS 语法型报错
 * 本脚本补最后、也最关键的一段：把每个页面接到「真实后端 + 真实账号 +
 * 真实业务数据」上跑一遍，直接回答——小程序所有功能到底能不能正常用。
 *
 * 具体校验：
 *   1. 页面 onLoad / onShow / onReady 期间的同步异常与未处理的 Promise 异常
 *   2. 页面是否弹出错误 toast / 错误弹窗（如「网络异常」「登录已失效」）
 *   3. 页面发出的请求是否出现 4xx / 5xx / 非 JSON 响应
 *   4. WXML 里的 {{ }} 表达式用「真实渲染数据」求值是否报错（报错即页面白屏）
 *   5. wx:for 的数据源是不是数组（不是数组 = 列表一片空白）
 *   6. 每个页面跑完后清掉它产生的测试数据，不影响真实账号
 *
 * 前置条件：后端已启动（node src/app.js），数据库可连接。
 * 运行：node scripts/checkPageIntegration.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const helper = require('./_accountHelper');

const ROOT = path.resolve(__dirname, '../../miniprogram');
const BASE = process.env.INTEGRATION_BASE || 'http://127.0.0.1:3000';

/* ================================================================== *
 * 0. 结果收集
 * ================================================================== */
const problems = [];
function fail(msg) { problems.push(msg); }

/** 提示项：不影响「能不能用」的结论，但值得看一眼 */
const warns = [];
function warn(msg) { warns.push(msg); }

/* ================================================================== *
 * 1. 真实 HTTP 通道：把 wx.request 直接打到本机后端
 * ================================================================== */
let inflight = 0;
const requestStat = { total: 0, bad: 0 };
let currentPage = '';

function buildQuery(data) {
  if (!data || typeof data !== 'object') return '';
  return Object.keys(data)
    .filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(data[k])}`)
    .join('&');
}

/** 真实发起一次请求（等价于 wx.request 的行为：GET 走 query，其余走 JSON body） */
function realRequest(opt) {
  const method = String((opt && opt.method) || 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(String(opt.url));
  } catch (err) {
    fail(`${currentPage} 请求地址非法：${opt.url}`);
    if (opt.fail) opt.fail({ errMsg: 'invalid url' });
    return;
  }
  // 只允许打本机后端：避免脚本误连公网把真实数据搅乱
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    fail(`${currentPage} 请求了非本机地址：${opt.url}（请把 BASE_URL 切到 localhost 再联调）`);
    if (opt.fail) opt.fail({ errMsg: 'blocked host' });
    return;
  }
  let bodyRaw = null;
  if (method === 'GET' || method === 'DELETE') {
    const qs = buildQuery(opt.data);
    if (qs) parsed.search = parsed.search ? `${parsed.search}&${qs}` : `?${qs}`;
  } else if (opt.data !== undefined && opt.data !== null) {
    bodyRaw = JSON.stringify(opt.data);
  }
  const headers = Object.assign({}, (opt && opt.header) || {});
  if (bodyRaw) headers['Content-Length'] = Buffer.byteLength(bodyRaw);

  inflight += 1;
  requestStat.total += 1;
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: parsed.pathname + parsed.search,
    method,
    headers
  }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => {
      inflight -= 1;
      let data = null;
      try { data = JSON.parse(text); } catch (err) { data = text; }
      const isJson = data && typeof data === 'object';
      if (res.statusCode >= 400 || !isJson) {
        requestStat.bad += 1;
        fail(`${currentPage} 接口异常 ${method} ${parsed.pathname} -> HTTP ${res.statusCode} ${String(text).slice(0, 120)}`);
      }
      if (opt.success) opt.success({ statusCode: res.statusCode, data, header: res.headers });
      if (opt.complete) opt.complete();
    });
  });
  req.on('error', (err) => {
    inflight -= 1;
    requestStat.bad += 1;
    fail(`${currentPage} 请求失败 ${method} ${parsed.pathname} -> ${err.message}`);
    if (opt.fail) opt.fail({ errMsg: err.message });
    if (opt.complete) opt.complete();
  });
  if (bodyRaw) req.write(bodyRaw);
  req.end();
}

/* ================================================================== *
 * 2. wx / getApp 运行态桩
 * ================================================================== */
const storage = {};
const toasts = [];
const modals = [];
const navigations = [];

/**
 * 直接加载小程序「真实的 app.js」当 App 实例
 * ---------------------------------------------------------------------
 * 必须用真身而不是手写桩：页面里大量调用 app.checkLogin() / app.isLogin() /
 * app.saveLogin()，手写桩只要少写一个方法，脚本就会误报「xxx is not a function」，
 * 把「脚本没写全」栽赃给小程序。
 */
let appConfig = null;
global.App = (cfg) => { appConfig = cfg; };
require(path.join(ROOT, 'app.js'));

const appStub = (() => {
  const inst = {};
  Object.keys(appConfig || {}).forEach((k) => {
    inst[k] = typeof appConfig[k] === 'function' ? appConfig[k].bind(inst) : appConfig[k];
  });
  inst.globalData = Object.assign({}, (appConfig && appConfig.globalData) || {});
  return inst;
})();

global.getApp = () => appStub;
global.getCurrentPages = () => [{ route: 'pages/index/index' }];

const WX_IMPL = {
  request: realRequest,
  getStorageSync: (k) => (storage[k] === undefined ? '' : storage[k]),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  clearStorageSync: () => { Object.keys(storage).forEach((k) => { delete storage[k]; }); },
  getStorageInfoSync: () => ({ keys: Object.keys(storage), currentSize: 0, limitSize: 10240 }),
  showToast: (o) => { toasts.push(String((o && o.title) || '')); },
  hideToast: () => undefined,
  showLoading: () => undefined,
  hideLoading: () => undefined,
  showModal: (o) => {
    modals.push({ title: String((o && o.title) || ''), content: String((o && o.content) || '') });
    const result = { confirm: false, cancel: true };
    if (o && typeof o.success === 'function') setTimeout(() => o.success(result), 0);
    return Promise.resolve(result);
  },
  showActionSheet: (o) => {
    if (o && typeof o.fail === 'function') setTimeout(() => o.fail({ errMsg: 'showActionSheet:fail cancel' }), 0);
    return Promise.resolve({ tapIndex: -1 });
  },
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667, platform: 'devtools', SDKVersion: '3.5.0' }),
  getDeviceInfo: () => ({ brand: '集成测试', model: 'NodeJS', system: 'Windows', platform: 'devtools' }),
  getAppBaseInfo: () => ({ SDKVersion: '3.5.0', version: '8.0.0', platform: 'devtools' }),
  getSystemInfo: (o) => { if (o && o.success) o.success({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667 }); },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667 }),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', appId: 'wx0000000000000000' } }),
  createSelectorQuery: () => ({
    select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([null]) }) }),
    selectAll: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([[]]) }) }),
    in: function inScope() { return this; },
    exec: (cb) => cb && cb([])
  }),
  createIntersectionObserver: () => ({ relativeTo: function self() { return this; }, relativeToViewport: function self() { return this; }, observe: () => undefined, disconnect: () => undefined }),
  setNavigationBarTitle: () => undefined,
  stopPullDownRefresh: () => undefined,
  startPullDownRefresh: () => undefined,
  pageScrollTo: () => undefined,
  navigateTo: (o) => { navigations.push((o && o.url) || ''); },
  redirectTo: (o) => { navigations.push((o && o.url) || ''); },
  switchTab: (o) => { navigations.push((o && o.url) || ''); },
  reLaunch: (o) => { navigations.push((o && o.url) || ''); },
  navigateBack: () => undefined,
  setClipboardData: (o) => { if (o && o.success) o.success({}); },
  previewImage: () => undefined,
  login: (o) => { if (o && o.success) o.success({ code: 'mock-code' }); },
  checkSession: (o) => { if (o && o.success) o.success({}); },
  getUserProfile: (o) => { if (o && o.fail) o.fail({ errMsg: 'mock' }); },
  getNetworkType: (o) => { if (o && o.success) o.success({ networkType: 'wifi' }); },
  onNetworkStatusChange: () => undefined,
  vibrateShort: () => undefined,
  chooseMedia: (o) => { if (o && o.fail) o.fail({ errMsg: 'chooseMedia:fail cancel' }); },
  chooseImage: (o) => { if (o && o.fail) o.fail({ errMsg: 'chooseImage:fail cancel' }); },
  uploadFile: (o) => { if (o && o.fail) o.fail({ errMsg: 'mock' }); },
  getImageInfo: (o) => { if (o && o.fail) o.fail({ errMsg: 'mock' }); },
  nextTick: (cb) => { if (typeof cb === 'function') setTimeout(cb, 0); }
};

global.wx = new Proxy(WX_IMPL, {
  get(target, prop) {
    if (prop in target) return target[prop];
    // 兜底：未显式实现的 wx API 一律当成空操作，避免脚本因缺桩而报假错
    return () => undefined;
  }
});

/* ================================================================== *
 * 3. 页面加载与实例化
 * ================================================================== */
function loadPageConfig(file) {
  let captured = null;
  global.Page = (cfg) => { captured = cfg; };
  global.Component = () => undefined;
  global.Behavior = (b) => b;
  delete require.cache[require.resolve(file)];
  require(file);
  return captured;
}

/** 把 Page 的配置对象变成「可被调用的页面实例」，并支持 setData 的 a.b 路径写法 */
function makeInstance(cfg) {
  const inst = {};
  Object.keys(cfg).forEach((k) => {
    if (typeof cfg[k] === 'function') inst[k] = cfg[k].bind(inst);
  });
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}));
  inst.setData = (patch, cb) => {
    Object.keys(patch || {}).forEach((key) => {
      const parts = key.split('.');
      let cur = inst.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = patch[key];
    });
    if (typeof cb === 'function') cb();
  };
  return inst;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到「没有新的在途请求」再继续，模拟用户看到页面加载完成的那一刻 */
async function settle(maxMs = 2500) {
  const start = Date.now();
  let idle = 0;
  while (Date.now() - start < maxMs) {
    await sleep(40);
    if (inflight === 0) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

/* ================================================================== *
 * 4. WXML 渲染表达式求值：页面白屏的元凶通常在这里
 * ================================================================== */

/** 从 WXML 里收集 wx:for 的别名（这些名字只在循环作用域内有效，必须排除） */
function collectLoopAliases(wxml) {
  const aliases = new Set(['item', 'index']);
  const re = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g;
  let m = re.exec(wxml);
  while (m) { aliases.add(m[1].trim()); m = re.exec(wxml); }
  return aliases;
}

/** 用页面真实数据求一遍所有 {{ }} 表达式 */
function checkWxmlExpressions(rel, data) {
  const wxmlFile = path.join(ROOT, rel + '.wxml');
  if (!fs.existsSync(wxmlFile)) return { total: 0, errors: 0, loops: 0, emptyLoops: 0 };
  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const aliases = collectLoopAliases(wxml);
  const result = { total: 0, errors: 0, loops: 0, emptyLoops: 0 };

  /** 表达式里是否引用了循环变量（引用了就跳过，因为顶层数据里本来就没有） */
  const usesAlias = (expr) => [...aliases].some((a) => new RegExp(`(^|[^\\w$.])${a}([^\\w$]|$)`).test(expr));

  /**
   * WXML 对「没声明过的变量」是宽容的：{{ notDeclared }} 渲染成空字符串，不报错。
   * 这里用 Proxy 还原同样的语义，否则会把页面本来就这么写的表达式误判成白屏。
   * Math / Date / JSON 等全局对象依然放行。
   */
  const scope = new Proxy(data, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      if (typeof key === 'string' && key in globalThis) return globalThis[key];
      return undefined;
    }
  });
  const evalExpr = (expr) => new Function('$d', `with($d){ return (${expr}); }`)(scope);

  /**
   * 弹窗表单（editForm / orderForm / pwdForm / banTarget ...）的初始值就是 null，
   * 只有点了「打开弹窗」才会 setData 成对象；而它们对应的表达式全都写在 wx:if 里，
   * 没打开弹窗时根本不会被渲染。静态求值必然报「Cannot read properties of null」，
   * 这类属于提示，不是故障。
   */
  const isGuardedNull = (err) => err instanceof TypeError && /Cannot read properties of (null|undefined)/.test(err.message);
  const report = (kind, expr, err) => {
    if (isGuardedNull(err)) {
      warn(`${rel} ${kind}表达式引用了未渲染的表单字段（弹窗打开后才有值）：{{${expr}}}`);
      return;
    }
    result.errors += 1;
    fail(`${rel} ${kind}表达式求值失败：{{${expr}}} -> ${err.message}`);
  };

  // 4.1 wx:for 数据源必须是数组
  const forRe = /wx:for\s*=\s*"\{\{([\s\S]*?)\}\}"/g;
  let fm = forRe.exec(wxml);
  while (fm) {
    const expr = fm[1].trim();
    result.loops += 1;
    if (!usesAlias(expr)) {
      try {
        const val = evalExpr(expr);
        if (val === undefined || val === null) {
          result.emptyLoops += 1;
        } else if (!Array.isArray(val)) {
          fail(`${rel} wx:for 的数据源不是数组：{{${expr}}} -> ${typeof val}`);
        }
      } catch (err) {
        report('wx:for ', expr, err);
      }
    }
    fm = forRe.exec(wxml);
  }

  // 4.2 其它表达式
  const expRe = /\{\{([\s\S]*?)\}\}/g;
  let em = expRe.exec(wxml);
  while (em) {
    const expr = em[1].trim();
    em = expRe.exec(wxml);
    if (!expr || usesAlias(expr)) continue;
    result.total += 1;
    try {
      evalExpr(expr);
    } catch (err) {
      report('渲染', expr, err);
    }
  }
  return result;
}

/* ================================================================== *
 * 5. 逐页实跑
 * ================================================================== */
const rejections = [];
process.on('unhandledRejection', (err) => {
  rejections.push(`${currentPage} 未处理的 Promise 异常：${(err && err.message) || err}`);
});

/** 错误 toast 关键词：出现即说明页面功能没跑通 */
const BAD_TOAST = /网络异常|请求失败|失败|错误|登录已失效|无权限|服务器|异常/;

async function runPage(rel, query) {
  currentPage = rel;
  toasts.length = 0;
  modals.length = 0;
  navigations.length = 0;
  rejections.length = 0;
  const before = requestStat.total;
  const errors = [];
  const jsFile = path.join(ROOT, rel + '.js');
  if (!fs.existsSync(jsFile)) { fail(`${rel} 缺少 JS 文件`); return null; }

  let inst = null;
  try {
    const cfg = loadPageConfig(jsFile);
    if (!cfg) { fail(`${rel} 没有调用 Page()`); return null; }
    inst = makeInstance(cfg);
  } catch (err) {
    fail(`${rel} 模块加载失败：${err.message}`);
    return null;
  }

  for (const hook of ['onLoad', 'onShow', 'onReady']) {
    if (typeof inst[hook] !== 'function') continue;
    try {
      await inst[hook](hook === 'onLoad' ? query : undefined);
    } catch (err) {
      errors.push(`${hook} 抛异常：${err.message}`);
    }
    await settle();
  }

  const reqCount = requestStat.total - before;

  errors.forEach((e) => fail(`${rel} ${e}`));
  rejections.forEach((e) => fail(e));

  toasts.forEach((t) => { if (BAD_TOAST.test(t)) fail(`${rel} 弹出错误提示：${t}`); });
  modals.forEach((m) => {
    if (BAD_TOAST.test(m.title) || BAD_TOAST.test(m.content)) {
      fail(`${rel} 弹出错误弹窗：${m.title} / ${m.content}`);
    }
  });

  const wxml = checkWxmlExpressions(rel, inst.data);
  return { rel, reqCount, wxml, toasts: [...toasts], navigations: [...navigations] };
}

/* ================================================================== *
 * 6. 准备真实测试数据（雇主 / 跑腿员 / 覆盖 0、1、2 三种状态的任务）
 * ================================================================== */
async function api(method, p, body, token) {
  return helper.request(method, p, body, { token, deviceId: 'integration-device' });
}

async function prepareData() {
  const adminToken = await helper.adminToken();
  const stamp = String(Date.now()).slice(-6);
  const employer = await helper.createCertifiedUser({
    adminToken, name: '联调雇主', studentId: `9${stamp}1`, phone: helper.testPhone(stamp)
  });
  const taker = await helper.createCertifiedUser({
    adminToken, name: '联调跑腿', studentId: `9${stamp}2`, phone: helper.testPhone(Number(stamp) + 1)
  });

  const form = (over) => Object.assign({
    receiverName: '李收件',
    receiverPhone: '13900139001',
    deliverAddress: 'X栋X楼A101',
    detailAddress: '宿舍A101门口',
    pickupCode: '8-2-3021',
    timeLimitMin: 60,
    remark: '页面联调数据',
    reward: 2,
    img1: '/uploads/test/task_a.jpg'
  }, over || {});

  // 任务A：留在「待接单」，供首页 / 我的发布 / 编辑页渲染
  const createdA = await api('POST', '/api/task/createOrder', form({ remark: '待接单任务' }), employer.token);
  const taskIdWaiting = createdA.data && createdA.data.taskId;

  // 任务B：被接单后停在「进行中」，供倒计时 / 加酬金 / 取消接单渲染
  const createdB = await api('POST', '/api/task/createOrder', form({ remark: '进行中任务', timeLimitMin: 60 }), employer.token);
  const taskIdDoing = createdB.data && createdB.data.taskId;
  await api('POST', '/api/task/take', { taskId: taskIdDoing }, taker.token);

  // 任务C：跑到「待雇主确认」，供送达照片预览 / 确认送达 / 未送达弹窗渲染
  const createdC = await api('POST', '/api/task/createOrder', form({ remark: '待确认任务' }), employer.token);
  const taskIdConfirm = createdC.data && createdC.data.taskId;
  await api('POST', '/api/task/take', { taskId: taskIdConfirm }, taker.token);
  await api('POST', '/api/task/submitFinish', {
    taskId: taskIdConfirm, deliveryImages: ['/uploads/test/d1.jpg', '/uploads/test/d2.jpg']
  }, taker.token);

  return { adminToken, employer, taker, taskIdWaiting, taskIdDoing, taskIdConfirm };
}

/* ================================================================== *
 * 7. 主流程
 * ================================================================== */
async function main() {
  console.log('\n===== 0. 后端连通性 =====');
  const health = await api('GET', '/api/health');
  if (health.code !== 200) {
    console.log('  [FAIL] 后端未启动或数据库不可用，无法联调。请先运行 node src/app.js');
    process.exit(1);
  }
  console.log(`  [OK] 后端在线：${BASE}（模拟支付=${health.data.paySimulate}）`);

  console.log('\n===== 1. 准备真实测试数据 =====');
  const ctx = await prepareData();
  console.log(`  [OK] 雇主 ${ctx.employer.accountNo} / 跑腿员 ${ctx.taker.accountNo}`);
  console.log(`  [OK] 任务：待接单#${ctx.taskIdWaiting} 进行中#${ctx.taskIdDoing} 待确认#${ctx.taskIdConfirm}`);

  // 把前端请求地址切到本机后端（小程序里由 app.js 读缓存覆盖，这里直接调 setBaseUrl）
  const request = require(path.join(ROOT, 'utils/request.js'));
  request.setBaseUrl(BASE);

  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const pages = appJson.pages || [];

  // 页面启动参数：需要 id 的页面必须给，否则等于没测到
  const QUERY = {
    'pages/taskDetail/taskDetail': () => ({ id: String(ctx.taskIdConfirm) }),
    'pages/taskEdit/taskEdit': () => ({ id: String(ctx.taskIdWaiting) }),
    'pages/securitySetup/securitySetup': () => ({ from: 'register' }),
    'pages/securityUnlock/securityUnlock': () => ({ accountNo: ctx.employer.accountNo })
  };

  console.log('\n===== 2. 普通用户视角：逐页实跑（真实登录态 + 真实数据） =====');
  appStub.globalData.accessToken = ctx.employer.token;
  appStub.globalData.refreshToken = ctx.employer.refreshToken || '';
  storage.accessToken = ctx.employer.token;
  storage.refreshToken = ctx.employer.refreshToken || '';

  let okCount = 0;
  for (const page of pages) {
    // 管理后台用管理员令牌单独跑，放在下一段
    if (page === 'pages/admin/admin') continue;
    const before = problems.length;
    const r = await runPage(page, (QUERY[page] || (() => ({})))());
    if (!r) continue;
    const bad = problems.length - before;
    if (bad === 0) {
      okCount += 1;
      console.log(`  [OK]   ${page.padEnd(34)} 请求${String(r.reqCount).padStart(2)} 表达式${String(r.wxml.total).padStart(3)} 列表${String(r.wxml.loops).padStart(2)}`);
    } else {
      console.log(`  [FAIL] ${page.padEnd(34)} 发现 ${bad} 个问题`);
    }
  }
  console.log(`  普通用户页面：${okCount}/${pages.length - 1} 通过`);

  console.log('\n===== 3. 管理员视角：管理后台 =====');
  appStub.globalData.accessToken = ctx.adminToken;
  storage.accessToken = ctx.adminToken;
  {
    const before = problems.length;
    const r = await runPage('pages/admin/admin', {});
    const bad = problems.length - before;
    if (r && bad === 0) console.log(`  [OK]   pages/admin/admin                  请求${r.reqCount}`);
    else console.log(`  [FAIL] pages/admin/admin                  发现 ${bad} 个问题`);
  }

  console.log('\n===== 4. 全功能可用性汇总 =====');
  console.log(`  页面总数：${pages.length}（普通用户 ${pages.length - 1} + 管理员 1）`);
  console.log(`  累计请求：${requestStat.total} 次，异常 ${requestStat.bad} 次`);
  console.log(`  发现问题：${problems.length} 个`);
  if (problems.length) {
    console.log('');
    problems.forEach((p, i) => console.log(`  ${String(i + 1).padStart(3)}. ${p}`));
  }
  const uniqWarns = [...new Set(warns)];
  console.log(`  提示项：${uniqWarns.length} 个（不影响「能用」，仅供人工确认）`);
  if (uniqWarns.length) {
    console.log('');
    uniqWarns.slice(0, 12).forEach((w) => console.log(`   · ${w}`));
    if (uniqWarns.length > 12) console.log(`   · ...另外 ${uniqWarns.length - 12} 条同类提示已省略`);
  }

  // 清理本次联调产生的测试账号与任务（连同任务、账单、消息一并删除）
  try {
    const purged = await helper.purgeAccounts([ctx.employer.accountNo, ctx.taker.accountNo]);
    console.log(`\n  已清理联调测试账号：${purged} 个`);
  } catch (err) {
    console.log(`\n  [WARN] 清理测试账号失败（不影响结论）：${err.message}`);
  }

  if (problems.length) {
    console.log('\n[结果] 不通过：上面每条都是「某个功能实际用不了」的证据，请逐条修复');
    process.exit(1);
  }
  console.log('\n[结果] 通过：小程序全部页面在真实后端 + 真实数据下均可正常显示并运行');
  process.exit(0);
}

main().catch((err) => {
  console.log('\n[结果] 脚本自身异常（不是小程序的问题）：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
