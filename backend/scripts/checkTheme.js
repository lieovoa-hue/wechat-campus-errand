/**
 * =====================================================================
 * 暗色主题接线自检
 * ---------------------------------------------------------------------
 * 背景：主题是「全局变量 + 页面挂类」的架构，任何一环漏接都不会报错，
 *      只会表现为「某个页面在深色下还是白的」，肉眼很难逐页发现。
 *      所以这里把接线规则写成可执行断言，新增页面漏接会直接失败。
 *
 * 校验 6 件事：
 *   A. 每个页面 JS 都 require 了 utils/theme，data 里都有 themeClass，
 *      onShow 调用了 theme.sync(this)，onUnload 调用了 theme.unsync(this)
 *   B. 每个页面 WXML 的根节点都挂了 {{themeClass}}
 *   C. app.json 开启了 darkmode 且 themeLocation 指向真实存在的 theme.json
 *   D. app.json 里所有 "@变量" 都在 theme.json 的 light / dark 两套里都有定义
 *   E. theme.json 的 light / dark 键集合完全一致（少一个键＝某个页面会白屏错误）
 *   F. theme.js 的原生外观表（NATIVE）与 theme.json 的取值完全一致
 *      —— 两处不一致时，手切主题会出现「页面深色、导航栏白色」的割裂
 *   G. 8 张暗色 tabBar 图标真实存在
 *
 * 运行：node scripts/checkTheme.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../miniprogram');
let failCount = 0;

function fail(where, message) {
  failCount += 1;
  console.log(`  [FAIL] ${where} -> ${message}`);
}

function ok(message) {
  console.log(`  [OK]   ${message}`);
}

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const themeJsonPath = path.join(ROOT, appJson.themeLocation || 'theme.json');

/* ------------------------------------------------------------------ *
 * A + B：逐页检查接线
 * ------------------------------------------------------------------ */
const pages = appJson.pages || [];

pages.forEach((page) => {
  const jsPath = path.join(ROOT, page + '.js');
  const wxmlPath = path.join(ROOT, page + '.wxml');
  const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
  const wxml = fs.existsSync(wxmlPath) ? fs.readFileSync(wxmlPath, 'utf8') : '';

  if (!/require\('.*utils\/theme'\)/.test(js)) {
    fail(page, 'JS 没有 require utils/theme');
  }
  if (!/themeClass:\s*theme\.getClass\(\)/.test(js)) {
    fail(page, 'JS 的 data 里没有 themeClass: theme.getClass()（首帧会闪一下浅色）');
  }
  // onShow 里必须真的调用，且必须在 onShow 方法体内（简单起见按「文件中出现且属于 onShow 之后」判断）
  const showIdx = js.search(/\n  onShow\(\) \{/);
  if (showIdx < 0) {
    fail(page, 'JS 缺少 onShow（主题无法在回到页面时校准）');
  } else {
    const showBody = js.slice(showIdx, showIdx + 500);
    // 首页把主题同步包了一层（syncTheme 里顺带刷开关状态与刷新指示器颜色），
    // 所以这里认两种写法：直接调 theme.sync(this)，或调页面自己的 this.syncTheme()
    if (!showBody.includes('theme.sync(this)') && !showBody.includes('this.syncTheme(')) {
      fail(page, 'onShow 里没有调用 theme.sync(this)（或页面的 this.syncTheme()）');
    }
  }
  const unloadIdx = js.search(/\n  onUnload\(\) \{/);
  if (unloadIdx < 0) {
    fail(page, 'JS 缺少 onUnload（页面实例不会被主题模块释放）');
  } else if (!js.slice(unloadIdx, unloadIdx + 300).includes('theme.unsync(this)')) {
    fail(page, 'onUnload 里没有调用 theme.unsync(this)');
  }

  if (!/<view[^>]*class="[^"]*\{\{themeClass\}\}/.test(wxml)) {
    fail(page, 'WXML 根节点没有挂 {{themeClass}}（深色下这一页会保持浅色）');
  }
});

if (!failCount) ok(`${pages.length} 个页面的主题接线齐全（require / data / onShow / onUnload / 根节点类）`);

/* ------------------------------------------------------------------ *
 * C：darkmode + themeLocation
 * ------------------------------------------------------------------ */
if (appJson.darkmode !== true) fail('app.json', '没有开启 darkmode');
if (!appJson.themeLocation) fail('app.json', '没有配置 themeLocation');
if (!fs.existsSync(themeJsonPath)) {
  fail('app.json', `themeLocation 指向的文件不存在：${appJson.themeLocation}`);
  

console.log(`\n主题自检结束：失败 ${failCount} 个`);
  process.exit(1);
}
const themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
const light = themeJson.light || {};
const dark = themeJson.dark || {};

/* ------------------------------------------------------------------ *
 * D：app.json 里的 "@变量" 必须两套都定义
 * ------------------------------------------------------------------ */
const appJsonText = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
const vars = Array.from(new Set((appJsonText.match(/"@([A-Za-z0-9_]+)"/g) || [])
  .map((item) => item.slice(2, -1))));
vars.forEach((name) => {
  if (!Object.prototype.hasOwnProperty.call(light, name) || !Object.prototype.hasOwnProperty.call(dark, name)) {
    fail('theme.json', `变量 ${name} 没有同时在 light / dark 里定义`);
  }
});
if (vars.length) ok(`app.json 引用的 ${vars.length} 个主题变量在 light / dark 两套里都有定义`);

/* ------------------------------------------------------------------ *
 * E：两套键集合必须一致
 * ------------------------------------------------------------------ */
const lightKeys = Object.keys(light).sort();
const darkKeys = Object.keys(dark).sort();
const onlyLight = lightKeys.filter((k) => darkKeys.indexOf(k) === -1);
const onlyDark = darkKeys.filter((k) => lightKeys.indexOf(k) === -1);
if (onlyLight.length) fail('theme.json', `只有 light 定义：${onlyLight.join(', ')}`);
if (onlyDark.length) fail('theme.json', `只有 dark 定义：${onlyDark.join(', ')}`);
if (!onlyLight.length && !onlyDark.length) ok(`theme.json 的 light / dark 各有 ${lightKeys.length} 个变量，键集合一致`);

/* ------------------------------------------------------------------ *
 * F：theme.js 的 NATIVE 表与 theme.json 必须一致
 * --------------------------------------------------------------------- */
const themeJs = fs.readFileSync(path.join(ROOT, 'utils/theme.js'), 'utf8');
const nativeBlock = themeJs.slice(themeJs.indexOf('const NATIVE = {'), themeJs.indexOf('const TAB_ROUTES'));
const expect = {
  light: {
    navBackground: light.navBgColor,
    navFront: light.navTxtStyle === 'black' ? '#000000' : '#ffffff',
    tabBackground: light.tabBgColor,
    tabColor: light.tabColor,
    tabSelectedColor: light.tabSelColor,
    windowBackground: light.bgColor
  },
  dark: {
    navBackground: dark.navBgColor,
    navFront: dark.navTxtStyle === 'black' ? '#000000' : '#ffffff',
    tabBackground: dark.tabBgColor,
    tabColor: dark.tabColor,
    tabSelectedColor: dark.tabSelColor,
    windowBackground: dark.bgColor
  }
};

['light', 'dark'].forEach((mode) => {
  const start = nativeBlock.indexOf(mode + ': {');
  const block = nativeBlock.slice(start, nativeBlock.indexOf('}', start));
  Object.keys(expect[mode]).forEach((key) => {
    const want = expect[mode][key];
    const re = new RegExp(key + ":\\s*'([^']+)'");
    const m = block.match(re);
    if (!m) {
      fail('utils/theme.js', `NATIVE.${mode} 缺少 ${key}`);
    } else if (m[1].toLowerCase() !== String(want).toLowerCase()) {
      fail('utils/theme.js', `NATIVE.${mode}.${key} = ${m[1]}，theme.json 是 ${want}（手切主题会出现割裂）`);
    }
  });
});
if (!failCount) ok('utils/theme.js 的原生外观表与 theme.json 取值一致');

/* ------------------------------------------------------------------ *
 * G：暗色 tabBar 图标
 * ------------------------------------------------------------------ */
(appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).forEach((tab) => {
  const iconVar = String(tab.iconPath || '').replace('@', '');
  const activeVar = String(tab.selectedIconPath || '').replace('@', '');
  const iconPath = dark[iconVar];
  const activePath = dark[activeVar];
  if (iconPath && !fs.existsSync(path.join(ROOT, iconPath))) {
    fail(tab.pagePath, `暗色常态图标缺失：${iconPath}`);
  }
  if (activePath && !fs.existsSync(path.join(ROOT, activePath))) {
    fail(tab.pagePath, `暗色选中图标缺失：${activePath}`);
  }
});

/* ------------------------------------------------------------------ *
 * H：根节点之外的「顶层兄弟节点」也必须挂主题类
 * ---------------------------------------------------------------------
 * 页面里写在根节点外面的固定底栏（发布任务的 .pub-foot）和弹窗遮罩
 * （首页筛选 .sheet / 任务详情 6 个 .mask）不在 .theme-dark 的子树里，
 * 拿不到深色令牌，会回落成浅色 —— 表现就是「深色页面底部突然白了一块」。
 * 这里逐个页面扫顶层节点，漏挂直接失败。
 * --------------------------------------------------------------------- */
/* 覆盖层类名：这些节点挂主题类只是为了拿到深色令牌，绝不能挂 .theme-root
   —— 它们自身是 position:fixed 的整屏遮罩 / 贴底弹层 / 固定底栏，
   一旦吃到 min-height:100vh 就会被拉成整屏，把页面正文整页盖住。 */
const OVERLAY_CLASSES = ['mask', 'sheet', 'sheet-mask', 'pub-foot'];

pages.forEach((page) => {
  const wxmlPath = path.join(ROOT, page + '.wxml');
  if (!fs.existsSync(wxmlPath)) return;
  const raw = fs.readFileSync(wxmlPath, 'utf8');
  // 注释替换成等长空白，避免注释里的尖括号干扰，同时保住行号
  const text = raw.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const reg = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const missing = [];
  const wrongRoot = [];
  let match = reg.exec(text);
  let depth = 0;
  while (match) {
    const isClose = match[1] === '/';
    const tag = match[2];
    const attrs = match[3];
    const selfClose = match[4] === '/';
    if (!isClose) {
      if (depth === 0) {
        const cls = (attrs.match(/class="([^"]*)"/) || [])[1];
        const lineNo = text.slice(0, match.index).split('\n').length;
        if (!cls || cls.indexOf('{{themeClass}}') === -1) {
          missing.push(`<${tag}> 第 ${lineNo} 行${cls ? '（class="' + cls + '"）' : '（没有 class 属性）'}`);
        } else {
          // 顶层节点分两类，规则刚好相反：
          //   · 页面根节点 → 必须挂 .theme-root（否则内容不足一屏时露出 page 的浅色底）；
          //   · 遮罩 / 底部弹层 / 固定底栏 → 绝对不能挂 .theme-root：
          //     它们挂 theme-dark 只是为了拿到深色令牌，一旦被 min-height:100vh 拉成整屏，
          //     就会把整页正文盖住（发布页固定底栏踩过：底栏 887px 高，整页只剩底栏）。
          const plain = cls.replace('{{themeClass}}', '');
          const isOverlay = OVERLAY_CLASSES.some((name) => new RegExp('(^|\\s)' + name + '(\\s|$)').test(plain));
          const hasRoot = cls.indexOf('theme-root') !== -1;
          if (isOverlay && hasRoot) {
            wrongRoot.push(`<${tag}> 第 ${lineNo} 行（${OVERLAY_CLASSES.join(' / ')} 这类覆盖层不能挂 .theme-root）`);
          }
          if (!isOverlay && !hasRoot) {
            wrongRoot.push(`<${tag}> 第 ${lineNo} 行${cls ? '（class="' + cls + '"）' : ''}`);
          }
        }
      }
      if (!selfClose) depth += 1;
    } else {
      depth -= 1;
    }
    match = reg.exec(text);
  }
  // 标签必须闭合：属性写到引号外面（class="a" theme-root"> 这种）会让 WXML 解析错位，
  // 轻则顶层节点判定失效，重则整块内容不渲染 —— 这里直接断言拦截。
  if (depth !== 0) {
    fail(page, `WXML 标签不闭合（结束时 depth=${depth}，说明多出或少掉了闭合标签，常见原因是属性写到了引号外面）`);
  }
  if (missing.length) {
    fail(page, `顶层节点没挂 {{themeClass}}（固定底栏 / 弹窗遮罩在深色下会保持浅色）：${missing.join('；')}`);
  }
  if (wrongRoot.length) {
    fail(page, `顶层节点没按「根节点铺满 / 覆盖层不铺满」挂类：${wrongRoot.join('；')}`);
  }
});
if (!failCount) ok('所有页面的顶层节点（含固定底栏与弹窗遮罩）都挂了主题类');
console.log(`\n主题自检结束：失败 ${failCount} 个`);
process.exit(failCount ? 1 : 0);
