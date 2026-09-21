/**
 * =====================================================================
 * 通用工具方法：统一响应、XSS转义、账号ID格式化、分页、幂等、订单号等
 * =====================================================================
 */

const crypto = require('crypto');
const { CODE_MSG, BIZ, ACCOUNT_NO_RULE, TASK_ORDER, getCodeMsg } = require('./constant');

// ------------------------------ 统一响应 ------------------------------

/**
 * 业务异常：controller 抛出后由统一错误处理转换为友好提示
 * 严禁把数据库堆栈、SQL 报错直接返回给前端
 */
class BizError extends Error {
  /**
   * @param {string} message 面向用户的友好提示
   * @param {number} code 统一错误码，默认 400
   */
  constructor(message, code = 400) {
    super(message || getCodeMsg(code));
    this.name = 'BizError';
    this.code = code;
  }
}

/**
 * 成功响应
 * @param {import('express').Response} res
 * @param {*} data 业务数据
 * @param {string} [msg] 提示文案，默认取状态码字典
 */
function ok(res, data = null, msg = CODE_MSG[200]) {
  return res.json({ code: 200, msg, data });
}

/**
 * 失败响应（只返回友好提示，绝不暴露堆栈 / SQL 细节）
 * @param {import('express').Response} res
 * @param {number} code 统一错误码
 * @param {string} [msg] 友好提示，缺省使用错误码字典文案
 */
/**
 * 统一失败响应
 * @param {import('express').Response} res 响应对象
 * @param {number} code 业务错误码
 * @param {string} msg 友好提示
 * @param {*} [data] 附加数据（可选）
 *   目前唯一的用途：单设备登录被顶下线时，把「新设备名称 / 时间 / IP / 归属地」
 *   一并下发，让被下线的设备能弹窗告知本人（否则用户只会莫名掉线）。
 */
function fail(res, code = 400, msg = '', data = null) {
  return res.json({ code, msg: msg || getCodeMsg(code), data });
}

// ------------------------------ XSS 防御 ------------------------------

/**
 * HTML 特殊字符转义（< > & " '）
 * @param {*} value 任意值
 * @returns {*} 字符串则转义，其它类型原样返回
 */
function escapeHtml(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------ 账号编号 / 账号 ID ------------------------------

/**
 * 生成对外展示的账号编号
 *   管理员：A + 4位补零（A0001）
 *   普通用户：X + 4位补零（X0001），按注册顺序递增
 * 序号超过 4 位时直接拼接原数字（A10000），保证不截断、不重复
 * @param {number} seq 序号（管理员从 1 开始，普通用户从 1 开始）
 * @param {boolean} isAdmin 是否管理员
 * @returns {string} 形如 A0001 / X0001
 */
function buildAccountNo(seq, isAdmin = false) {
  const num = Number(seq);
  if (!Number.isSafeInteger(num) || num < 1) {
    return '';
  }
  const prefix = isAdmin ? ACCOUNT_NO_RULE.ADMIN_PREFIX : ACCOUNT_NO_RULE.NORMAL_PREFIX;
  const text = num > 9999 ? String(num) : String(num).padStart(ACCOUNT_NO_RULE.PAD, '0');
  return prefix + text;
}

/**
 * 账号编号格式化成展示文案
 * 优先级：account_no（A0001 / X0001）> 兜底按主键四位补零
 * 兜底分支用于兼容加列之前的历史数据，避免出现空字符串
 * @param {number|string} id 数据库主键 user_id
 * @param {string} [accountNo] users.account_no 账号编号
 * @returns {string}
 */
function formatUserId(id, accountNo = '') {
  const account = String(accountNo === undefined || accountNo === null ? '' : accountNo).trim();
  if (account) {
    return account.toUpperCase();
  }
  const num = Number(id);
  if (!Number.isFinite(num) || num < 0) {
    return '';
  }
  if (num > 9999) {
    return String(num);
  }
  return String(num).padStart(4, '0');
}

/**
 * 生成任务订单号（对外唯一编号）
 * ---------------------------------------------------------------------
 * 格式：GCPT + 数字，例如 GCPT000123
 *   数字部分取自任务主键 id（INT AUTO_INCREMENT，全局唯一且并发安全），
 *   固定补零到 6 位；超过 6 位直接拼接原数字（GCPT1000000），不截断。
 *   口径与 tasks.order_no 唯一索引、ensureSchema.ensureTaskOrderNoColumn 的回填完全一致。
 * @param {number} taskId 任务主键 id
 * @returns {string} 形如 GCPT000123；id 非法时返回空串
 */
function buildTaskOrderNo(taskId) {
  const num = Number(taskId);
  if (!Number.isSafeInteger(num) || num < 1) {
    return '';
  }
  const limit = 10 ** TASK_ORDER.PAD;
  const text = num >= limit ? String(num) : String(num).padStart(TASK_ORDER.PAD, '0');
  return TASK_ORDER.PREFIX + text;
}

/**
 * 解析用户输入的账号（单一输入框，后端自动识别输入类型）
 *   ① 字母 + 数字      -> 账号编号（A0001 / X0001，大小写不敏感）
 *   ② 11 位纯数字      -> 手机号
 *   ③ 其余纯数字       -> 去掉前导零后按主键 user_id 查询（"0001" / "001" / "1" 均命中 id=1）
 *   ④ 其他             -> unknown（登录接口统一返回「账号或密码错误」）
 * @param {string} account 用户输入的账号
 * @returns {{ type: 'account'|'phone'|'id'|'unknown', value: string|number, raw: string }}
 */
function parseAccount(account) {
  const raw = String(account === undefined || account === null ? '' : account).trim();
  if (!raw) {
    return { type: 'unknown', value: '', raw };
  }
  // ① 账号编号：A0001 / X0001 / a1 等，统一转大写
  if (/^[A-Za-z]\d{1,8}$/.test(raw)) {
    return { type: 'account', value: raw.toUpperCase(), raw };
  }
  // ② 长数字（≥ BIZ.STUDENT_ID_MIN_LEN 位）优先按学号匹配
  //    ③ 短数字去掉前导零后按 user_id 匹配（输入 0001 / 001 / 1 均命中 id=1 的账号）
  if (/^\d+$/.test(raw)) {
    if (raw.length >= BIZ.STUDENT_ID_MIN_LEN) {
      return { type: 'studentId', value: raw, raw };
    }
    const normalized = raw.replace(/^0+/, '');
    const num = Number(normalized === '' ? '0' : normalized);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { type: 'unknown', value: '', raw };
    }
    return { type: 'id', value: num, raw };
  }
  return { type: 'unknown', value: '', raw };
}

// ------------------------------ 分页 ------------------------------

/**
 * 解析分页参数
 * @param {object} query express req.query
 * @returns {{page:number,pageSize:number,offset:number}}
 */
function parsePage(query = {}) {
  let page = parseInt(query.page, 10);
  let pageSize = parseInt(query.pageSize, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = BIZ.PAGE_SIZE_DEFAULT;
  if (pageSize > BIZ.PAGE_SIZE_MAX) pageSize = BIZ.PAGE_SIZE_MAX;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 组装分页返回结构
 */
function buildPage(list, total, page, pageSize) {
  return {
    list,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total
  };
}

// ------------------------------ 幂等控制 ------------------------------

// 内存幂等表：key -> 过期时间戳。用于拦截瞬时重复提交（前端连点、网络重试）
const idempotentMap = new Map();

/**
 * 幂等校验：首次调用返回 true 并登记，重复调用返回 false
 * 结合数据库 WHERE status=? 条件更新，双保险防止重复提交
 * @param {string} key 幂等键（建议：userId:action:业务标识）
 * @param {number} ttlMs 有效期（毫秒）
 * @returns {boolean} 是否允许继续执行
 */
function checkIdempotent(key, ttlMs = 3000) {
  const now = Date.now();
  // 顺带清理过期键，避免内存无限增长
  for (const [k, expire] of idempotentMap.entries()) {
    if (expire <= now) idempotentMap.delete(k);
  }
  if (idempotentMap.has(key)) {
    return false;
  }
  idempotentMap.set(key, now + ttlMs);
  return true;
}

/**
 * 生成请求参数指纹（MD5 前16位）
 * 用途：让幂等键区分「内容完全相同的重复提交」与「内容不同的两次正常请求」，
 *       避免用户连续发布两个不同任务时被误判为重复提交。
 * @param {*} params 参与指纹计算的参数
 * @returns {string} 16位十六进制指纹
 */
function hashParams(params) {
  const source = JSON.stringify(params === undefined ? null : params);
  return crypto.createHash('md5').update(source, 'utf8').digest('hex').slice(0, 16);
}

// ------------------------------ 随机 / 编号 ------------------------------

/**
 * 生成 6 位数字验证码
 */
function generateSmsCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * 生成专属邀请码（8位大写字母+数字）
 */
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

/**
 * 生成商户订单号（32位以内，微信要求 6-32 位）
 * 格式：CE + yyyyMMddHHmmss + 10位随机
 */
function generateOutTradeNo() {
  const time = formatDate(new Date(), 'YYYYMMDDHHmmss');
  const rand = String(crypto.randomInt(1000000000, 9999999999));
  return `CE${time}${rand}`;
}

/**
 * 生成随机昵称
 */
function randomNickname() {
  return `用户${crypto.randomInt(100000, 999999)}`;
}

/**
 * 生成随机登录密码（管理员「重置密码」选择自动生成时使用）
 * 字符集刻意剔除了容易看错的 0/O、1/l/I，避免管理员口头/截图转达时出错。
 * @param {number} length 长度（默认 8 位，符合 6-20 位密码规则）
 * @returns {string}
 */
function generatePassword(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const size = Math.min(20, Math.max(6, Number(length) || 8));
  let password = '';
  for (let i = 0; i < size; i += 1) {
    password += chars[crypto.randomInt(0, chars.length)];
  }
  return password;
}

// ------------------------------ 时间 ------------------------------

/**
 * 日期格式化
 * @param {Date|string|number} date
 * @param {string} fmt 支持 YYYY MM DD HH mm ss
 */
function formatDate(date, fmt = 'YYYY-MM-DD HH:mm:ss') {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
}

/**
 * 计算两个时间相差的分钟数（a - b）
 */
function diffMinutes(a, b) {
  return (new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

/**
 * 计算两个时间相差的小时数（a - b）
 */
function diffHours(a, b) {
  return (new Date(a).getTime() - new Date(b).getTime()) / 3600000;
}

// ------------------------------ 其它 ------------------------------

/**
 * 手机号脱敏：138****8888
 */
function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length !== 11) return p;
  return `${p.slice(0, 3)}****${p.slice(7)}`;
}

/**
 * 学号展示值：注销账号的学号在 deactivate 时被改写成占位符（DX + 8 位 user_id，
 * 见 models/User.js deactivate），占位符对用户没有任何意义，
 * 统一改写为「已注销」，避免历史任务 / 账单里出现 DX00000818 这类内部占位串。
 */
function formatStudentId(studentId) {
  const sid = String(studentId || '');
  return /^DX\d{8}$/.test(sid) ? '已注销' : sid;
}

/**
 * 校验手机号格式（中国大陆 11 位）
 */
function isPhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || ''));
}

/**
 * 安全取整
 */
function toInt(value, defaultValue = 0) {
  const num = parseInt(value, 10);
  return Number.isInteger(num) ? num : defaultValue;
}

/**
 * 金额安全解析（保留两位小数），非法返回 null
 */
function parseMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100) / 100;
}

/**
 * 计算「超时送达」应扣减的酬金（规则唯一出口，禁止在控制器里硬编码 5% / 0.5）
 *   规则：扣减金额 = 酬金 × 5%；不足 0.5 元时按 0.5 元计算；且扣减不超过酬金本身
 * @param {number} reward 任务当前酬金
 * @returns {{rate:number, deduct:number, remain:number}} 扣减比例 / 扣减金额 / 扣减后酬金
 */
function calcLateDeduct(reward) {
  const base = Math.max(0, Number(reward) || 0);
  // 先按比例算，再按「不足 0.5 元按 0.5 元」兜底，最后保证不会把酬金扣成负数
  const byRate = Math.round(base * BIZ.LATE_DEDUCT_RATE * 100) / 100;
  let deduct = Math.max(byRate, BIZ.LATE_DEDUCT_MIN);
  if (deduct > base) deduct = base;
  deduct = Math.round(deduct * 100) / 100;
  return {
    rate: BIZ.LATE_DEDUCT_RATE,
    deduct,
    remain: Math.round((base - deduct) * 100) / 100
  };
}

/**
 * 秒数格式化为「x分y秒」文案（超时时长展示的唯一出口，定时任务与控制器共用）
 * 例：95 -> 「1分35秒」；40 -> 「40秒」
 * @param {number} seconds 超时秒数
 * @returns {string}
 */
function formatLateText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

/**
 * 统一日志输出（带时间戳与级别）
 */
/**
 * 必填参数校验（只做存在性与空值校验，格式校验由业务层负责）
 * @param {object} source 来源对象（一般为 req.body）
 * @param {Array<{name:string,label:string}>} rules 校验规则
 * @throws {BizError} 参数缺失时抛出 400 友好提示
 */
function assertParams(source, rules) {
  const src = source || {};
  for (const rule of rules) {
    const name = typeof rule === 'string' ? rule : rule.name;
    const label = typeof rule === 'string' ? rule : (rule.label || rule.name);
    const value = src[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new BizError(`${label}不能为空`, 400);
    }
  }
}

function log(level, ...args) {
  const prefix = `[${formatDate(new Date())}][${String(level).toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

module.exports = {
  BizError,
  ok,
  fail,
  escapeHtml,
  buildAccountNo,
  formatUserId,
  buildTaskOrderNo,
  parseAccount,
  parsePage,
  buildPage,
  checkIdempotent,
  hashParams,
  generateSmsCode,
  generateInviteCode,
  generateOutTradeNo,
  randomNickname,
  generatePassword,
  formatDate,
  diffMinutes,
  diffHours,
  maskPhone,
  formatStudentId,
  isPhone,
  toInt,
  parseMoney,
  calcLateDeduct,
  formatLateText,
  assertParams,
  log
};
