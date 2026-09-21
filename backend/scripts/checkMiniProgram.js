/**
 * =====================================================================
 * 小程序源码自检脚本
 *  1. 逐个编译 miniprogram 下所有 .js（只编译不执行，提前暴露语法错误）
 *  2. 逐个解析所有 .json（提前暴露 JSON 格式错误）
 *  3. 校验所有 .wxml 的标签闭合是否平衡（防止补丁把文件尾部写坏）
 *  4. 校验所有 .wxss 的花括号是否平衡
 *  5. 校验 <text> 的内容没有另起一行（微信会把该换行渲染成真实空行，撑大文字背景框）
 *  6. 校验 app.json 里声明的页面与 tabBar 图标是否真实存在
 *     （含 darkmode：@主题变量逐个在 theme.json 的 light / dark 里解析后再验，
 *       深色图标漏定义 / 漏文件都会在这里直接失败）
 * 运行：node scripts/checkMiniProgram.js
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../miniprogram');

/** 自闭合标签（不需要闭合标签） */
const VOID_TAGS = new Set([
  'image', 'input', 'icon', 'import', 'include', 'wxs', 'br', 'slot',
  'page-meta', 'navigation-bar', 'rich-text', 'progress', 'textarea', 'checkbox', 'radio', 'switch'
]);

let jsCount = 0;
let jsonCount = 0;
let wxmlCount = 0;
let wxssCount = 0;
let failCount = 0;

function fail(file, message) {
  failCount += 1;
  console.log(`  [FAIL] ${path.relative(ROOT, file)} -> ${message}`);
}

/** 递归收集指定后缀的文件 */
function collect(dir, ext, result = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return;
      collect(full, ext, result);
    } else if (entry.name.endsWith(ext)) {
      result.push(full);
    }
  });
  return result;
}

/** 1. JS 语法编译检查 */
collect(ROOT, '.js').forEach((file) => {
  jsCount += 1;
  const code = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    fail(file, err.message);
  }
});

/** 2. JSON 格式检查 */
collect(ROOT, '.json').forEach((file) => {
  jsonCount += 1;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(file, err.message);
  }
});

/**
 * 2.1 隐藏字符检查（血泪教训）
 * ---------------------------------------------------------------------
 * 曾经有一次 app.wxss 中间混进了一个 U+FEFF（BOM 字节，肉眼完全看不见），
 * 微信开发者工具直接报「app.wxss(170:1): unexpected ? 」，整份全局样式表编译失败：
 * 页面能打开、数据也在，但所有样式全部丢失，看起来像「白屏 / 页面坏了」。
 * 编辑器里看不出来，只有把字节打出来才发现，所以在这里一次性卡死：
 *   · U+FEFF 只允许出现在文件最开头（那是真正的 BOM，属正常编码）；
 *   · 中间的 U+FEFF、以及 U+2028 / U+2029（JS 里的行分隔符）一律视为错误。
 */
const HIDDEN_CHARS = [
  { code: 0xfeff, name: 'U+FEFF（BOM / 零宽不换行空格）' },
  { code: 0x2028, name: 'U+2028（行分隔符，会让编译器当成换行）' },
  { code: 0x2029, name: 'U+2029（段分隔符，同上）' }
];

collect(ROOT, '.js')
  .concat(collect(ROOT, '.json'), collect(ROOT, '.wxml'), collect(ROOT, '.wxss'))
  .forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    HIDDEN_CHARS.forEach((item) => {
      for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) !== item.code) continue;
        if (item.code === 0xfeff && i === 0) continue; // 文件开头的 BOM 允许保留
        const lineNo = text.slice(0, i).split('\n').length;
        fail(file, `第 ${lineNo} 行存在隐藏字符 ${item.name}：它会让微信编译器报「unexpected ?」并整份文件失效，请删掉`);
        break;
      }
    });
  });

/**
 * 3. WXML 标签平衡检查
 * 用栈逐个匹配 <tag ...> / </tag>，自闭合标签与注释直接跳过
 */
function checkWxmlBalance(file, content) {
  // 去掉注释，避免注释里的尖括号干扰
  const text = content.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const reg = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match = reg.exec(text);
  while (match) {
    const isClose = match[1] === '/';
    const tag = match[2];
    const selfClose = match[4] === '/';
    if (!VOID_TAGS.has(tag)) {
      if (isClose) {
        const expect = stack.pop();
        if (expect !== tag) {
          return `标签不匹配：期望 </${expect || '无'}>，实际 </${tag}>（偏移 ${match.index}）`;
        }
      } else if (!selfClose) {
        stack.push(tag);
      }
    }
    match = reg.exec(text);
  }
  if (stack.length) return `存在未闭合标签：<${stack.join('>, <')}>`;
  return '';
}

collect(ROOT, '.wxml').forEach((file) => {
  wxmlCount += 1;
  const error = checkWxmlBalance(file, fs.readFileSync(file, 'utf8'));
  if (error) fail(file, error);
});

/**
 * 3.1 <text> 内容换行检查
 * ---------------------------------------------------------------------
 * 微信小程序会把 <text> 内「真实的换行符」渲染成一整行换行（官方支持 \n 换行），
 * 于是 <text ...>\n  内容\n</text> 这种写法会比预期多出一个空行的高度：
 *   - 带背景色的标签（如个人中心「校园认证」的 tag）背景框会「凭空大一圈」，文字被挤到底部；
 *   - 行内数值（如倒计时）会被往下推，与左侧标签不在同一条基线上。
 * 因此规定：<text> 里的内容必须与起始标签写在同一行。
 */
collect(ROOT, '.wxml').forEach((file) => {
  // 去掉注释，避免注释里的换行误报
  const text = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const reg = /<text\b[^>]*>[ \t]*\r?\n/g;
  let match = reg.exec(text);
  while (match) {
    const lineNo = text.slice(0, match.index).split('\n').length;
    fail(file, `第 ${lineNo} 行 <text> 的内容另起一行：微信会把该换行渲染成空行，导致背景框变高/文字下移，请把内容与 <text> 标签写在同一行`);
    match = reg.exec(text);
  }
});

/**
 * 4. WXSS 花括号平衡检查（少一个「}」会让整页样式失效，甚至报编译错误）
 */
collect(ROOT, '.wxss').forEach((file) => {
  wxssCount += 1;
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth < 0) break;
    }
  }
  if (depth !== 0) fail(file, `花括号不平衡（差值 ${depth}）`);
});

/**
 * 5. app.json 页面路径 / tabBar 图标是否存在
 */
try {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  (appJson.pages || []).forEach((page) => {
    ['.js', '.wxml', '.json'].forEach((ext) => {
      const target = path.join(ROOT, page + ext);
      if (!fs.existsSync(target)) fail(path.join(ROOT, 'app.json'), `页面文件缺失：${page}${ext}`);
    });
  });
  /**
   * 5.1 主题变量解析（app.json 的 darkmode + themeLocation）
   * ---------------------------------------------------------------------
   * app.json 里写成 "@xxx" 的值全部由 theme.json 的 light / dark 两套变量解析，
   * 常见事故是「浅色里定义了、深色里漏了」——微信在编译期就会直接报错，
   * 所以在自检里按两套主题各验一遍，并把变量缺失 / 图标缺失说得明明白白。
   */
  const appJsonPath = path.join(ROOT, 'app.json');
  const themes = {};
  let themePath = '';
  if (appJson.darkmode) {
    if (!appJson.themeLocation) {
      fail(appJsonPath, '开启了 darkmode 但没有配置 themeLocation');
    } else {
      themePath = path.join(ROOT, appJson.themeLocation);
      if (!fs.existsSync(themePath)) {
        fail(appJsonPath, `theme.json 不存在：${appJson.themeLocation}`);
      } else {
        const raw = JSON.parse(fs.readFileSync(themePath, 'utf8'));
        ['light', 'dark'].forEach((mode) => {
          if (!raw[mode] || typeof raw[mode] !== 'object') {
            fail(themePath, `缺少 ${mode} 主题变量`);
          } else {
            themes[mode] = raw[mode];
          }
        });
      }
    }
  }

  /**
   * 校验一个「可能是主题变量」的值
   * @param {string} label 报错时的中文说明
   * @param {string} value 原始值（"@变量名" 或普通路径）
   * @param {boolean} isImage 是否按图片文件校验存在性
   */
  function checkThemedAsset(label, value, isImage) {
    if (!value) return;
    if (value.charAt(0) !== '@') {
      if (isImage && !fs.existsSync(path.join(ROOT, value))) {
        fail(appJsonPath, `${label}缺失：${value}`);
      }
      return;
    }
    const name = value.slice(1);
    ['light', 'dark'].forEach((mode) => {
      const real = themes[mode] ? themes[mode][name] : undefined;
      if (typeof real !== 'string' || !real) {
        fail(themePath || appJsonPath, `主题变量 ${name} 在 ${mode} 主题下没有定义（被 ${label} 引用）`);
      } else if (isImage && !fs.existsSync(path.join(ROOT, real))) {
        fail(themePath, `${label}（${mode} 主题）图标缺失：${real}`);
      }
    });
  }

  checkThemedAsset('导航栏底色', appJson.window && appJson.window.navigationBarBackgroundColor, false);
  checkThemedAsset('窗口底色', appJson.window && appJson.window.backgroundColor, false);

  const tabBar = appJson.tabBar || {};
  (tabBar.list || []).forEach((tab) => {
    checkThemedAsset('tabBar 图标', tab.iconPath, true);
    checkThemedAsset('tabBar 选中图标', tab.selectedIconPath, true);
    if (tab.pagePath && (appJson.pages || []).indexOf(tab.pagePath) === -1) {
      fail(appJsonPath, `tabBar 页面未在 pages 中声明：${tab.pagePath}`);
    }
  });
} catch (err) {
  fail(path.join(ROOT, 'app.json'), err.message);
}

console.log(`小程序自检完成：JS ${jsCount} / JSON ${jsonCount} / WXML ${wxmlCount} / WXSS ${wxssCount}，失败 ${failCount} 个`);
process.exit(failCount ? 1 : 0);
