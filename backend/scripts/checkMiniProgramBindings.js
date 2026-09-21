/**
 * =====================================================================
 * 小程序「能不能正常显示并运行」深度自检
 * ---------------------------------------------------------------------
 * 与 checkMiniProgram.js 互补：
 *   checkMiniProgram.js   管「编译能否通过」（语法 / 标签闭合 / 花括号 / <text> 换行）
 *   本脚本                管「编译能过、但一进页面就点不动 / 显示空白」
 *
 * 具体校验 5 件事：
 *   A. 页面四件套（js / wxml / json / wxss）是否齐全
 *   B. WXML 里的事件绑定（bindtap / catchtap / bindinput / bindconfirm / bindchange ...）
 *      在对应的 JS 里是否真的存在同名方法 —— 漏了方法，微信只会静默不响应，不报错
 *   C. WXML 里用到的数据字段是否在 JS 的 data / setData 里出现过
 *   D. WXSS 的 @import 目标文件是否存在（路径写错会导致整页样式丢失）
 *   E. WXML 用到的 class 是否能在「app.wxss + 被 @import 的公共样式 + 本页 wxss」里查到定义
 *
 * 运行：node scripts/checkMiniProgramBindings.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../miniprogram');

/* ------------------------------------------------------------------ *
 * 0. 桩环境：真实 require 每个 JS，拿到真实的 Page / Component 定义对象
 * ------------------------------------------------------------------ */
const storage = {};
global.wx = new Proxy({}, {
  get(target, prop) {
    if (prop === 'getSystemInfoSync') return () => ({ platform: 'devtools', SDKVersion: '3.0.0' });
    if (prop === 'getStorageSync') return (k) => storage[k];
    if (prop === 'setStorageSync') return (k, v) => { storage[k] = v; };
    if (prop === 'removeStorageSync') return (k) => { delete storage[k]; };
    if (prop === 'getAccountInfoSync') return () => ({ miniProgram: { envVersion: 'develop' } });
    if (prop === 'createSelectorQuery') {
      return () => ({ select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([null]) }) }) });
    }
    return () => ({});
  }
});

/** 收集到的定义：key = js 文件绝对路径 */
const definitions = new Map();

global.Page = (obj) => { definitions.set(currentFile, { type: 'page', obj }); };
global.Component = (obj) => { definitions.set(currentFile, { type: 'component', obj }); };
global.Behavior = (obj) => obj;
global.App = () => {};
global.getApp = () => ({
  globalData: { userInfo: null, openid: '', sessionId: '' },
  isLogin: () => false,
  refreshUserInfo: () => Promise.resolve()
});

let currentFile = '';
let loadFailCount = 0;
const loadFails = [];

/** 递归收集指定后缀的文件 */
function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = walk(ROOT, '.js');
const wxmlFiles = walk(ROOT, '.wxml');
const wxssFiles = walk(ROOT, '.wxss');

for (const file of jsFiles) {
  currentFile = file;
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } catch (err) {
    loadFailCount += 1;
    loadFails.push(`${path.relative(ROOT, file)} -> ${err.message}`);
    console.log(`  [FAIL] JS 加载失败 ${path.relative(ROOT, file)} -> ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

/**
 * 从 WXML 中提取 class 名
 * - 只认真正的 class 属性，排除 hover-class / data-class 等
 * - {{ a ? 'x' : 'y' }} 里的字面量算 class
 * - {{ tab === 'audit' }} 里的比较操作数不算 class（否则会大量误报）
 */
function extractClasses(wxml) {
  const out = new Set();
  const re = /(?:^|[\s"'])class="([^"]*)"/g;
  let m = re.exec(wxml);
  while (m) {
    // 先抹掉紧贴 {{ }} 的半截类名：class="msg-tag-{{item.typeClass}}" 里的 "msg-tag-"
    // 是拼一半的字符串，真实类名要等运行时才知道，不能当成「未定义 class」报出来
    const raw = m[1]
      .replace(/[A-Za-z][\w-]*(?=\{\{)/g, ' ')
      .replace(/(?<=\}\})[A-Za-z][\w-]*/g, ' ');
    const expanded = raw.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
      const cmp = expr
        .replace(/(['"])(?:[^'\\]|\\.)*\1\s*(?:===|!==|==|!=)\s*/g, ' ')
        .replace(/(?:===|!==|==|!=)\s*(['"])(?:[^'\\]|\\.)*\1/g, ' ');
      const literals = cmp.match(/['"]([a-zA-Z][\w-]*)['"]/g) || [];
      return ` ${literals.map((s) => s.slice(1, -1)).join(' ')} `;
    });
    expanded.split(/\s+/).forEach((c) => {
      const name = c.trim();
      if (name && /^[a-zA-Z][\w-]*$/.test(name)) out.add(name);
    });
    m = re.exec(wxml);
  }
  return out;
}

/** 从 WXSS 中提取所有 .class 选择器的类名 */
function extractDefinedClasses(wxss) {
  const out = new Set();
  const text = wxss.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m = re.exec(text);
  while (m) {
    out.add(m[1]);
    m = re.exec(text);
  }
  return out;
}

/** 递归解析一个 WXSS 文件及其 @import 的公共样式，汇总所有类名 */
function collectWxssClasses(file, seen = new Set()) {
  const out = new Set();
  if (!fs.existsSync(file) || seen.has(file)) return out;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  const importRe = /@import\s+['"]([^'"]+)['"]\s*;/g;
  let m = importRe.exec(text);
  while (m) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) {
      out.add(`#MISSING_IMPORT:${m[1]}`);
    } else {
      collectWxssClasses(target, seen).forEach((c) => out.add(c));
    }
    m = importRe.exec(text);
  }
  extractDefinedClasses(text).forEach((c) => out.add(c));
  return out;
}

/** 从 WXML 中提取所有事件绑定里的处理函数名 */
function extractHandlers(wxml) {
  const out = new Set();
  // 支持 bindtap / bind:tap / catchtap / capture-bind:tap / mut-bind:tap
  const re = /(?:^|[\s"'])(?:capture-)?(?:mut-)?(?:bind|catch)[-:]?[a-zA-Z][\w-]*\s*=\s*"([^"]*)"/g;
  let m = re.exec(wxml);
  while (m) {
    const value = m[1].trim();
    // 动态绑定（{{ ... }}）无法静态校验，跳过；空值表示只是为了阻止冒泡
    if (value && !value.includes('{{') && /^[a-zA-Z_$][\w$]*$/.test(value)) out.add(value);
    m = re.exec(wxml);
  }
  return out;
}

/**
 * 从单个 {{ }} 表达式里提取「根标识符」
 * 剔除：字符串字面量、属性访问（a.b 里的 b）、对象字面量的键（{a: 1} 里的 a）
 * 保留：三元分支、数组元素、方法参数等真正来自 data / properties 的变量
 * 例：{{ item.deliverAddress || '待定' }} -> 只提取 item
 */
function extractRootIdentifiersFromExpr(expr) {
  // 1) 字符串字面量替换成等长空白，避免把文案当成字段名
  const clean = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (s) => ' '.repeat(s.length));
  // 2) 记录每个字符位置所处的「最内层未闭合括号」，用于判断对象字面量的键
  const stack = [];
  const bracketAt = new Array(clean.length).fill('');
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '}' || ch === ']' || ch === ')') stack.pop();
    bracketAt[i] = stack[stack.length - 1] || '';
    if (ch === '{' || ch === '[' || ch === '(') stack.push(ch);
  }
  // 3) 逐个 token 判断是否为根标识符
  const out = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let t = re.exec(clean);
  while (t) {
    const name = t[0];
    const prevChar = (clean.slice(0, t.index).match(/\S\s*$/) || [''])[0].trim();
    const nextChar = (clean.slice(t.index + name.length).match(/^\s*(\S)/) || ['', ''])[1];
    const isProperty = prevChar === '.';                                 // a.b 里的 b 不是字段
    const isObjectKey = bracketAt[t.index] === '{' && nextChar === ':';  // {b: 1} 里的 b 是键
    if (!isProperty && !isObjectKey) out.push(name);
    t = re.exec(clean);
  }
  return out;
}

/** WXML 里所有 {{ }} 表达式中被当作「根标识符」使用的名字 */
function extractRootIdentifiers(wxml) {
  const out = new Set();
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m = re.exec(wxml);
  while (m) {
    extractRootIdentifiersFromExpr(m[1]).forEach((n) => out.add(n));
    m = re.exec(wxml);
  }
  return out;
}

/** 表达式里允许出现的语言关键字 / 内置对象 / 循环别名 */
const EXPR_BUILTINS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'Math', 'Date', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'parseInt', 'parseFloat', 'item', 'index', 'value', 'key'
]);

/** 从 JS 源码里粗略抓出 setData 的一级键名 */
function extractSetDataKeys(src) {
  const out = new Set();
  const re = /setData\s*\(\s*\{([\s\S]*?)\}\s*[),]/g;
  let m = re.exec(src);
  while (m) {
    const body = m[1];
    const keyRe = /(?:^|[,{\s])(?:['"]?)([A-Za-z_$][\w$]*)(?:['"]?)\s*:/g;
    let k = keyRe.exec(body);
    while (k) {
      out.add(k[1]);
      k = keyRe.exec(body);
    }
    m = re.exec(src);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A. 页面四件套是否齐全
 * ------------------------------------------------------------------ */
console.log('\n===== A. 页面四件套文件检查 =====');
let fileIssue = 0;

let appJson = null;
try {
  appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
} catch (err) {
  console.log(`  [FAIL] app.json 解析失败 -> ${err.message}`);
  fileIssue += 1;
}

const declaredPages = (appJson && appJson.pages) || [];
declaredPages.forEach((page) => {
  const missing = ['.js', '.wxml', '.json', '.wxss'].filter(
    (ext) => !fs.existsSync(path.join(ROOT, page + ext))
  );
  if (missing.length) {
    console.log(`  [FAIL] ${page} 缺少 ${missing.join(' / ')}`);
    fileIssue += 1;
  }
});

/** app.json 声明但磁盘上不存在的 wxml（漏声明会导致页面打不开） */
const wxmlPagePaths = wxmlFiles
  .filter((f) => f.includes(`${path.sep}pages${path.sep}`))
  .map((f) => path.relative(ROOT, f).replace(/\\/g, '/').replace(/\.wxml$/, ''));
wxmlPagePaths.forEach((page) => {
  if (declaredPages.indexOf(page) === -1) {
    console.log(`  [FAIL] ${page} 存在于磁盘但未在 app.json 的 pages 中声明（页面无法访问）`);
    fileIssue += 1;
  }
});

if (!fileIssue) console.log(`  [OK] ${declaredPages.length} 个页面四件套齐全，磁盘与 app.json 声明一致`);

/* ------------------------------------------------------------------ *
 * B / C / E：逐页面（含组件）校验
 * ------------------------------------------------------------------ */
/* 五段检查结果先收集，循环结束后按段输出，避免「标题全打完、内容堆在后面」 */
const bLines = [];
const cLines = [];
const dLines = [];
const eLines = [];

let handlerIssue = 0;
let dataIssue = 0;
let importIssue = 0;
let classIssue = 0;
let checkedTargets = 0;

for (const wxmlFile of wxmlFiles) {
  const base = wxmlFile.replace(/\.wxml$/, '');
  const jsFile = base + '.js';
  const wxssFile = base + '.wxss';
  const relWxml = path.relative(ROOT, wxmlFile);
  const wxml = fs.readFileSync(wxmlFile, 'utf8');

  /* ---- B / C：需要 JS 定义 ---- */
  const def = definitions.get(jsFile);
  if (!jsFile || !fs.existsSync(jsFile)) {
    bLines.push(`  [WARN] ${relWxml} 没有同名 JS，跳过绑定与字段检查`);
  } else if (!def) {
    bLines.push(`  [FAIL] ${relWxml} 的 JS 未注册页面/组件（加载失败或没有调用 Page/Component）`);
    loadFailCount += 1;
    loadFails.push(`${path.relative(ROOT, jsFile)} -> 未调用 Page/Component`);
  } else {
    checkedTargets += 1;
    const src = fs.readFileSync(jsFile, 'utf8');
    // 组件的方法在 methods 里，页面的方法在顶层
    const methodOwner = def.type === 'component' ? (def.obj.methods || {}) : def.obj;
    const methodNames = new Set(Object.keys(methodOwner).filter((k) => typeof methodOwner[k] === 'function'));
    // 组件还有 lifetimes / pageLifetimes，页面还有生命周期函数，一并视为可绑定
    ['lifetimes', 'pageLifetimes'].forEach((k) => {
      Object.keys(def.obj[k] || {}).forEach((name) => methodNames.add(name));
    });

    /* B. 事件处理函数 */
    const handlers = extractHandlers(wxml);
    const missingHandlers = [...handlers].filter((h) => !methodNames.has(h));
    if (missingHandlers.length) {
      bLines.push(`  [FAIL] ${relWxml} 绑定了不存在的处理函数：${missingHandlers.join(', ')}`);
      handlerIssue += missingHandlers.length;
    }

    /* C. 数据字段 */
    const dataKeys = new Set(Object.keys(def.obj.data || {}));
    extractSetDataKeys(src).forEach((k) => dataKeys.add(k));
    // 组件 properties 也算可用字段
    Object.keys(def.obj.properties || {}).forEach((k) => dataKeys.add(k));

    // wx:for 的别名（wx:for-item / wx:for-index）会引入新的作用域变量，需要排除
    const aliases = new Set(['item', 'index']);
    const aliasRe = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g;
    let am = aliasRe.exec(wxml);
    while (am) {
      aliases.add(am[1].trim());
      am = aliasRe.exec(wxml);
    }

    // setData 的入参不是字面量对象时（setData(res) / setData(data)），字段无法静态推断
    const dynamicSetData = /\bsetData\s*\(\s*(?!\{)/.test(src);

    const roots = extractRootIdentifiers(wxml);
    const missingData = [...roots].filter(
      (name) => !dataKeys.has(name) && !EXPR_BUILTINS.has(name) && !aliases.has(name)
    );
    if (missingData.length) {
      if (dynamicSetData) {
        cLines.push(`  [跳过] ${relWxml} 存在动态 setData，字段无法静态校验（候选：${missingData.join(', ')}）`);
      } else {
        cLines.push(`  [FAIL] ${relWxml} 用到了 JS 里没出现过的字段：${missingData.join(', ')}`);
        dataIssue += missingData.length;
      }
    }
  }

  /* ---- D. @import 目标 ---- */
  if (fs.existsSync(wxssFile)) {
    const wxss = fs.readFileSync(wxssFile, 'utf8');
    const importRe = /@import\s+['"]([^'"]+)['"]\s*;/g;
    let im = importRe.exec(wxss);
    while (im) {
      const target = path.resolve(path.dirname(wxssFile), im[1]);
      if (!fs.existsSync(target)) {
        dLines.push(`  [FAIL] ${path.relative(ROOT, wxssFile)} @import 目标不存在：${im[1]}`);
        importIssue += 1;
      }
      im = importRe.exec(wxss);
    }
  }

  /* ---- E. class 定义 ---- */
  const reachable = collectWxssClasses(path.join(ROOT, 'app.wxss'));
  collectWxssClasses(wxssFile).forEach((c) => reachable.add(c));
  const missingClasses = [...extractClasses(wxml)].filter((c) => !reachable.has(c));
  if (missingClasses.length) {
    eLines.push(`  [WARN] ${relWxml} 使用了未定义的 class（不会有样式，但不会报错）：${missingClasses.join(', ')}`);
    classIssue += missingClasses.length;
  }
}

/* app.wxss 自身的 @import 也要查 */
{
  const appWxss = path.join(ROOT, 'app.wxss');
  if (fs.existsSync(appWxss)) {
    const text = fs.readFileSync(appWxss, 'utf8');
    const importRe = /@import\s+['"]([^'"]+)['"]\s*;/g;
    let m = importRe.exec(text);
    while (m) {
      if (!fs.existsSync(path.resolve(ROOT, m[1]))) {
        dLines.push(`  [FAIL] app.wxss @import 目标不存在：${m[1]}`);
        importIssue += 1;
      }
      m = importRe.exec(text);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 按段输出 B / C / D / E 的检查结果
 * ------------------------------------------------------------------ */
console.log('\n===== B. 事件处理函数绑定检查 =====');
if (bLines.length) bLines.forEach((l) => console.log(l));
else console.log(`  [OK] ${checkedTargets} 个 WXML 绑定的事件方法在 JS 里全部存在`);
if (handlerIssue) console.log(`  [说明] 缺失的处理函数微信不会报错，只会「点了没反应」，必须补齐`);

console.log('\n===== C. WXML 数据字段检查 =====');
if (cLines.length) cLines.forEach((l) => console.log(l));
else console.log('  [OK] WXML 用到的数据字段在 JS 的 data / setData / properties 中全部有定义');

console.log('\n===== D. WXSS @import 检查 =====');
if (dLines.length) dLines.forEach((l) => console.log(l));
else console.log(`  [OK] ${wxssFiles.length} 个 wxss 的 @import 引用均有效`);

console.log('\n===== E. WXML class 定义检查 =====');
if (eLines.length) eLines.forEach((l) => console.log(l));
else console.log('  [OK] WXML 用到的 class 均有样式定义');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('\n===== 汇总 =====');
console.log(`  页面/组件定义加载：${definitions.size} 个，失败 ${loadFailCount} 个`);
console.log(`  事件绑定检查：${checkedTargets} 个 WXML 完成，缺失处理函数 ${handlerIssue} 个`);
console.log(`  数据字段检查：缺失字段 ${dataIssue} 个`);
console.log(`  @import 检查：失效引用 ${importIssue} 个`);
console.log(`  class 定义检查：未定义 class ${classIssue} 个（仅提示，不影响运行）`);

const fatal = loadFailCount + fileIssue + handlerIssue + dataIssue + importIssue;
if (fatal === 0) {
  console.log('\n[结果] 通过：小程序可以正常显示并运行（脚本可访问的范围内未发现问题）');
} else {
  console.log(`\n[结果] 不通过：存在 ${fatal} 个会导致「点了没反应 / 页面空白」的问题，请逐条修复`);
}
loadFails.forEach((e) => console.log('  ' + e));
process.exit(fatal ? 1 : 0);
