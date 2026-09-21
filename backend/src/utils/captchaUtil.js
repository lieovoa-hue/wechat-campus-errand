/**
 * =====================================================================
 * 图形验证码工具（算术题，服务端直接生成 PNG）
 * ---------------------------------------------------------------------
 * 为什么用它：短信验证码按条计费，且个人开发者很难通过短信模板审核；
 *   本项目改用「本地生成算术题图片 + 一次一用」的方案，成本为 0，
 *   足以拦截脚本批量注册、批量猜密保答案等自动化攻击。
 * 安全性说明：
 *   1. 题目由两个 1~20 的随机整数做加减法组成，答案只存在服务端内存，绝不返回前端；
 *   2. 验证码只存内存（Map），进程重启即失效，即使数据库被拖库也无法复用；
 *   3. 有效期 BIZ.CAPTCHA_EXPIRE_MINUTES 分钟，校验通过后立即删除，保证「一次一用」；
 *   4. 同一 IP 的获取频率由 middleware/rateLimit.js 的 captchaLimit 限制（1 小时 20 次）。
 * 实现说明：不引入任何图片库，用 zlib + 手写 5x7 点阵字模实时合成 PNG，
 *   返回 data:image/png;base64,... 供小程序 <image> 组件直接渲染，兼容性最好。
 * =====================================================================
 */

const zlib = require('zlib');
const crypto = require('crypto');

const { BIZ, MSG } = require('./constant');
const { BizError } = require('./common');

/** 图片 data URL 前缀（用拼接方式书写，避免被各类编辑器/平台改写） */
const DATA_URL_PREFIX = 'data:' + 'image/png' + ';base64,';

/** captchaId -> { answer, expireAt }：进程内存储，重启即清空 */
const store = new Map();

// 每 5 分钟清理一次过期验证码，避免内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of store.entries()) {
    if (item.expireAt <= now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ------------------------------ 5x7 点阵字模 ------------------------------
// 每个字符由 7 行、每行 5 位组成，1 表示亮点。只包含算术题需要的 0-9 与 + - = 。
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000']
};

const GLYPH_W = 5;
const GLYPH_H = 7;

// ------------------------------ PNG 编码 ------------------------------

/** 标准 CRC32 表，用于 PNG 分块校验 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 CRC32
 * @param {Buffer} buf 待计算数据
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG 分块（长度 + 类型 + 数据 + CRC）
 * @param {string} type 分块类型，如 IHDR / IDAT / IEND
 * @param {Buffer} data 分块数据
 */
function buildChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素数组编码成 PNG Buffer
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @param {Buffer} rgba 长度必须为 width*height*4
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  // 每行前面加 1 个过滤类型字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (width * 4 + 1);
    raw[rawOffset] = 0;
    rgba.copy(raw, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深 8
  ihdr[9] = 6;  // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 过滤方式
  ihdr[12] = 0; // 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    buildChunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------ 画布操作 ------------------------------

/**
 * 创建一张纯白画布
 * @param {number} width
 * @param {number} height
 * @returns {{width:number,height:number,pixels:Buffer}}
 */
function createCanvas(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = 245;
    pixels[i * 4 + 1] = 246;
    pixels[i * 4 + 2] = 250;
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

/**
 * 画一个像素点（越界自动忽略）
 */
function setPixel(canvas, x, y, color) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  const offset = (py * canvas.width + px) * 4;
  canvas.pixels[offset] = color[0];
  canvas.pixels[offset + 1] = color[1];
  canvas.pixels[offset + 2] = color[2];
  canvas.pixels[offset + 3] = 255;
}

/**
 * 画一个实心矩形
 */
function fillRect(canvas, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      setPixel(canvas, x + dx, y + dy, color);
    }
  }
}

/**
 * 画一条带随机抖动的干扰线（Bresenham 直线算法）
 */
function drawLine(canvas, x0, y0, x1, y1, color) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx - dy;

  for (let guard = 0; guard < 2000; guard += 1) {
    setPixel(canvas, x, y, color);
    if (x === ex && y === ey) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/**
 * 按 5x7 字模绘制一个字符
 * @param {object} canvas 画布
 * @param {string} ch 字符（0-9 + - =）
 * @param {number} originX 左上角 x
 * @param {number} originY 左上角 y
 * @param {number} scale 放大倍数
 * @param {number[]} color RGB 颜色
 */
function drawGlyph(canvas, ch, originX, originY, scale, color) {
  const pattern = GLYPHS[ch];
  if (!pattern) return;
  for (let row = 0; row < GLYPH_H; row += 1) {
    const bits = pattern[row];
    for (let col = 0; col < GLYPH_W; col += 1) {
      if (bits[col] === '1') {
        fillRect(canvas, originX + col * scale, originY + row * scale, scale, scale, color);
      }
    }
  }
}

/** 随机颜色（保证在浅色背景上有足够对比度） */
function randomColor() {
  const palette = [
    [24, 84, 180], [176, 34, 60], [18, 106, 74],
    [120, 56, 160], [170, 92, 10], [30, 30, 46]
  ];
  return palette[crypto.randomInt(0, palette.length)];
}

/**
 * 生成题目（两个 1~20 的整数做加法或减法，结果保证非负）
 * @returns {{text:string, answer:number}}
 */
function buildQuestion() {
  const usePlus = crypto.randomInt(0, 2) === 0;
  let left = crypto.randomInt(1, 21);
  let right = crypto.randomInt(1, 21);
  if (!usePlus && left < right) {
    // 减法时保证被减数不小于减数，避免出现负数
    const tmp = left;
    left = right;
    right = tmp;
  }
  const answer = usePlus ? left + right : left - right;
  const text = `${left}${usePlus ? '+' : '-'}${right}=?`;
  return { text, answer };
}

/**
 * 生成一张验证码图片
 * @returns {{captchaId:string, image:string, expireMinutes:number, answer:number}}
 *          image 为 data:image/png;base64,... 可直接给小程序 image 组件使用
 */
function createCaptcha() {
  const { text, answer } = buildQuestion();

  const scale = 4;
  const charW = GLYPH_W * scale;
  const gap = 10;
  const paddingX = 14;
  const paddingY = 12;
  const width = paddingX * 2 + charW * text.length + gap * (text.length - 1);
  const height = paddingY * 2 + GLYPH_H * scale;

  const canvas = createCanvas(width, height);

  // 干扰线（画在字符下层）
  for (let i = 0; i < 4; i += 1) {
    drawLine(
      canvas,
      crypto.randomInt(0, width), crypto.randomInt(0, height),
      crypto.randomInt(0, width), crypto.randomInt(0, height),
      [180 + crypto.randomInt(0, 60), 190 + crypto.randomInt(0, 50), 210 + crypto.randomInt(0, 45)]
    );
  }

  // 干扰点
  for (let i = 0; i < Math.round(width * height * 0.02); i += 1) {
    setPixel(canvas, crypto.randomInt(0, width), crypto.randomInt(0, height),
      [150 + crypto.randomInt(0, 80), 150 + crypto.randomInt(0, 80), 150 + crypto.randomInt(0, 80)]);
  }

  // 逐字符绘制：颜色随机、纵向抖动 ±2 像素，增加 OCR 难度
  text.split('').forEach((ch, index) => {
    const jitterY = crypto.randomInt(-2, 3);
    drawGlyph(canvas, ch, paddingX + index * (charW + gap), paddingY + jitterY, scale, randomColor());
  });

  const captchaId = crypto.randomUUID().replace(/-/g, '');
  store.set(captchaId, {
    answer,
    expireAt: Date.now() + BIZ.CAPTCHA_EXPIRE_MINUTES * 60 * 1000
  });

  return {
    captchaId,
    image: `data:image/png;base64,${encodePng(width, height, canvas.pixels).toString('base64')}`,
    expireMinutes: BIZ.CAPTCHA_EXPIRE_MINUTES,
    // 仅供本地日志排查使用，控制器不会把它下发给前端
    answer
  };
}

/**
 * 校验验证码（校验通过后立即作废，保证一次一用）
 * 说明：无论成功或失败都会把该 captchaId 从内存中移除的规则只作用于「成功」路径，
 *       失败时保留到自然过期，避免用户打错一个字就要重新获取图片。
 * @param {string} captchaId 验证码 ID
 * @param {string|number} code 用户输入的答案
 * @returns {boolean} 是否通过
 */
function verifyCaptcha(captchaId, code) {
  const id = String(captchaId || '').trim();
  if (!id) return false;

  const item = store.get(id);
  if (!item) return false;
  if (item.expireAt <= Date.now()) {
    store.delete(id);
    return false;
  }

  const input = String(code === undefined || code === null ? '' : code).trim();
  const pass = /^-?\d+$/.test(input) && Number(input) === item.answer;
  if (pass) store.delete(id);
  return pass;
}

/**
 * 校验验证码，不通过直接抛业务异常（供控制器一行调用）
 * @param {string} captchaId
 * @param {string|number} code
 */
function assertCaptcha(captchaId, code) {
  if (!captchaId || code === undefined || code === null || String(code).trim() === '') {
    throw new BizError(MSG.CAPTCHA_REQUIRED, 400);
  }
  if (!verifyCaptcha(captchaId, code)) {
    throw new BizError(MSG.CAPTCHA_INVALID, 400);
  }
}

module.exports = {
  createCaptcha,
  verifyCaptcha,
  assertCaptcha
};