/**
 * =====================================================================
 * 视图过滤器：时间格式化、金额格式化、图片地址补全、状态文案
 * 状态文案全部读取 constant.js 字典，业务代码禁止硬编码中文
 * =====================================================================
 */

const {
  TASK_STATUS,
  AVATAR_AUDIT,
  CAMPUS_AUDIT,
  AUDIT_STATUS,
  APPEAL_STATUS,
  REPORT_TYPE,
  MSG_TYPE,
  PAY_STATUS,
  BILL_TYPE,
  ROLE_TAG,
  CERT_TAG,
  USER_ROLE_ENUM,
  AUDIT_APPLY_TYPE,
  TASK_TYPE,
  BIZ,
  getText
} = require('./constant');

const { getBaseUrl } = require('./request');

/**
 * 时间格式化
 * @param {string|Date} value 时间
 * @param {string} fmt 例如 YYYY-MM-DD HH:mm
 */
function formatTime(value, fmt = 'YYYY-MM-DD HH:mm') {
  if (!value) return '';
  // iOS 不支持 'YYYY-MM-DD HH:mm:ss'，需要替换为 '/'
  const date = value instanceof Date ? value : new Date(String(value).replace(/-/g, '/'));
  if (Number.isNaN(date.getTime())) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

/** 相对时间：刚刚 / 5分钟前 / 3小时前 / 2天前 */
function fromNow(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(/-/g, '/'));
  const diff = Date.now() - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}天前`;
  return formatTime(value, 'YYYY-MM-DD');
}

/** 金额格式化：5.5 -> 5.50 */
function price(value) {
  const num = Number(value || 0);
  return num.toFixed(2);
}

/**
 * 把服务端返回的相对图片地址补全为完整 URL
 * 说明：数据库只存相对路径（如 /uploads/202609/a.jpg），
 *      而小程序 <image src="/uploads/..."> 会被解析成「小程序包内路径」导致图片不显示，
 *      因此所有来自服务端的图片在渲染前都要经过这里补全域名。
 * @param {string} path 图片地址（服务端相对路径 / 网络地址 / 本地临时文件）
 * @returns {string} 可直接用于 <image src> 的地址
 */
function imageUrl(path) {
  const value = String(path || '');
  if (!value) return '';
  // 已经是绝对地址的（网络地址、本地临时文件、base64）原样返回
  if (/^[a-z]+:\/\//i.test(value) || value.indexOf('data:') === 0) return value;
  if (value.charAt(0) !== '/') return value;
  return getBaseUrl() + value;
}

/** 批量补全图片地址（过滤空值） */
function imageUrls(list) {
  return (list || []).map(imageUrl).filter(Boolean);
}

/** 任务状态文案 */
function taskStatusText(status) {
  return getText(TASK_STATUS, status, '未知状态');
}

/** 任务状态对应的标签样式 */
function taskStatusClass(status) {
  const map = {
    0: 'tag',
    1: 'tag tag-warn',
    2: 'tag tag-purple',
    3: 'tag tag-success',
    4: 'tag tag-danger',
    5: 'tag tag-gray'
  };
  return map[status] || 'tag';
}

/**
 * 任务卡片左侧状态色条（纯装饰，用于列表里一眼分辨任务所处阶段）
 * 与状态标签同源，保证「标签颜色 = 色条颜色」
 * @param {number} status 任务状态
 * @returns {string} 附加到卡片根节点的类名
 */
function taskAccentClass(status) {
  const map = {
    0: 'accent-0',   // 待接单：品牌蓝
    1: 'accent-1',   // 进行中：橙
    2: 'accent-2',   // 待雇主确认：紫
    3: 'accent-3',   // 已完成：绿
    4: 'accent-4',   // 超时取消：红
    5: 'accent-5'    // 雇主撤销：灰
  };
  return map[Number(status)] || 'accent-0';
}

/**
 * 任务状态在首页牌堆卡（深色底）上的标签样式
 * 复用 taskAccentClass 的颜色槽位，保证「牌堆标签 = 列表标签 = 卡片左侧色条」三处口径一致
 * @param {number} status 任务状态
 * @returns {string} 标签完整类名（含 deck-status 基础类）
 */
function taskDeckStatusClass(status) {
  return 'deck-status deck-status-' + taskAccentClass(status).replace('accent-', '');
}


/** 剩余秒数格式化为 mm:ss */
function countdownText(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * 倒计时是否已归零（用于把「剩余时间」切换成红色「已超时」）
 * @param {number} seconds
 * @returns {boolean}
 */
function isCountdownOver(seconds) {
  return Number(seconds) === 0;
}

/**
 * 超时时长文案（与后端 formatLateText 口径一致）
 * 例如：95 -> 「1分35秒」
 * @param {number} seconds 超时秒数
 * @returns {string}
 */
function lateDurationText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

/**
 * 计算「超时送达」应扣减的酬金（与后端 calcLateDeduct 口径保持一致）
 *   扣减金额 = 酬金 × 5%，不足 0.5 元按 0.5 元，且不超过酬金本身
 * 注意：页面展示一律优先使用接口下发的 lateDeductPreview，这里只作为本地兜底
 * @param {number} reward 任务酬金
 * @returns {{rate:number, deduct:number, remain:number}}
 */
function calcLateDeduct(reward) {
  const base = Math.max(0, Number(reward) || 0);
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

/** 手机号脱敏 */
function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length !== 11) return value;
  return `${value.slice(0, 3)}****${value.slice(7)}`;
}

/** 时间限制展示 */
function timeLimitText(minutes) {
  if (!minutes) return '不限时';
  if (minutes < 60) return `${minutes}分钟`;
  const hour = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hour}小时${rest}分钟` : `${hour}小时`;
}

/**
 * 封禁剩余时长文案（管理员后台「封禁管理」用）
 * 由「封禁截止时间」实时计算，不依赖接口下发时的快照值，避免页面停留过久后显示偏差
 * 例：90061 -> 「1天1小时1分」
 * @param {string} endTime 封禁截止时间（YYYY-MM-DD HH:mm:ss）
 * @returns {string}
 */
function banRemainText(endTime) {
  if (!endTime) return '';
  // 兼容两种时间格式：
  //   - ISO 8601（如 2026-09-18T02:20:43.000Z，mysql2 的 DATETIME 经 JSON 序列化后的形态）直接交给引擎解析
  //   - 'YYYY-MM-DD HH:mm:ss'（iOS 不支持该格式）替换为 '/' 后再解析
  const raw = String(endTime).trim();
  const date = /T\d{2}:\d{2}/.test(raw) ? new Date(raw) : new Date(raw.replace(/-/g, '/'));
  if (Number.isNaN(date.getTime())) return '';

  let total = Math.floor((date.getTime() - Date.now()) / 1000);
  if (total <= 0) return '已到期';

  const day = Math.floor(total / 86400);
  total -= day * 86400;
  const hour = Math.floor(total / 3600);
  total -= hour * 3600;
  const minute = Math.floor(total / 60);
  const second = total - minute * 60;

  const parts = [];
  if (day) parts.push(`${day}天`);
  if (hour) parts.push(`${hour}小时`);
  if (minute) parts.push(`${minute}分`);
  // 只剩秒级时也要能看出正在倒计时
  if (!day && !hour) parts.push(`${second}秒`);
  return parts.join('');
}

/**
 * 角色标识文案（管理员标识对所有人可见）
 * 文案统一读取 constant.js 字典，页面里禁止硬编码「管理员」三个字
 * @param {boolean} isAdmin 是否管理员
 * @returns {string}
 */
function roleTag(isAdmin) {
  return getText(ROLE_TAG, isAdmin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL, '');
}

/**
 * 身份标识统一规则（全站唯一出口，页面里禁止各写一套判断）
 *   管理员        -> 红色「管理员」标识（不显示「已认证」）
 *   校园认证通过  -> 绿色「已认证」标识
 *   其余          -> 不显示任何标识
 * @param {boolean} isAdmin 是否管理员（后端按学号白名单判定后下发）
 * @param {boolean} isCertified 是否校园认证通过
 * @returns {{badgeShow:boolean, badgeClass:string, badgeText:string}}
 */
function identityBadge(isAdmin, isCertified) {
  if (isAdmin) {
    return { badgeShow: true, badgeClass: 'tag tag-admin', badgeText: roleTag(true) };
  }
  if (isCertified) {
    return { badgeShow: true, badgeClass: 'tag tag-success', badgeText: CERT_TAG.CERTIFIED };
  }
  return { badgeShow: false, badgeClass: 'tag', badgeText: '' };
}

/**
 * 构建「发布者 / 接单者」展示信息：头像、昵称、账号ID、学号、认证标识
 * 任务列表与任务详情统一使用，保证各处展示口径完全一致
 * @param {object} options
 *   label 角色文案（雇主 / 跑腿员）
 *   avatar 头像地址   nickname 昵称   userIdText 账号编号   studentId 学号
 *   userId 内部主键（管理员点击卡片查看用户详情时要用，列表页可为空）
 *   isAdmin 是否管理员   isCertified 是否校园认证通过
 * @returns {object} 可直接在 wxml 里渲染的对象
 */
function personView(options = {}) {
  const badge = identityBadge(!!options.isAdmin, !!options.isCertified);
  return {
    label: options.label || '',
    // 内部主键 userId：用户 mini 卡片点击后据此拉取完整资料（列表接口不下发时兜底为 0）
    userId: Number(options.userId) || 0,
    avatarUrl: imageUrl(options.avatar),
    nickname: options.nickname || '匿名用户',
    userIdText: options.userIdText || '-',
    studentId: options.studentId || '-',
    badgeShow: badge.badgeShow,
    badgeClass: badge.badgeClass,
    badgeText: badge.badgeText,
    // 手机号：只有「发布者 / 接单者」这一对双方能拿到（后端按 isOwner || isTaker 下发，
    // 大厅里的陌生人拿到的是空串）。showPhone 由页面按「当前用户是否当事双方」传入，
    // 陌生人连「手机号」这一行都不会出现，避免号码在无关用户面前暴露。
    phone: options.phone || '',
    showPhone: !!options.showPhone
  };
}

/**
 * 进度条（5 段）固定文案：①已接单 ②已取货 ③已送达 ④待支付 ⑤完成
 * 顺序与后端 computeProgressStep 的返回值一一对应（1~5，0 表示还没人接单）
 */
const PROGRESS_STEP_LABELS = ['已接单', '已取货', '已送达', '待支付', '完成'];

/** 任务类型标签文案（读字典，业务代码禁止硬编码中文） */
function taskTypeText(taskType) {
  return getText(TASK_TYPE, Number(taskType) || 0);
}

/**
 * 任务类型标签配色类名（列表卡 / 详情页共用同一套槽位）
 * 类名必须与 components/taskCard/taskCard.wxss 里的 .tag-type-0~4 完全一致，
 * 否则标签会退化成无底色（改类名时两处要一起改）。
 */
function taskTypeClass(taskType) {
  return 'tag-type-' + (Number(taskType) || 0);
}

/** 第几段进度的文案（0 或越界返回空串） */
function progressLabel(step) {
  const index = Number(step) || 0;
  if (index < 1 || index > PROGRESS_STEP_LABELS.length) return '';
  return PROGRESS_STEP_LABELS[index - 1];
}

/** 进度整句文案：进度 3/5 · 已送达（未接单时为「等待接单」） */
function progressText(step) {
  const index = Math.min(Math.max(Number(step) || 0, 0), PROGRESS_STEP_LABELS.length);
  const label = progressLabel(index);
  return label ? `进度 ${index}/5 · ${label}` : '等待接单';
}

/**
 * 把「第几段」展开成 5 个节点，供 WXML 直接渲染
 * @param {number} step 第几段（0~5）
 * @returns {Array<{key:string,no:number,label:string,state:string}>}
 *   state: done（已走过）/ now（当前这段）/ todo（还没到）
 */
function progressSteps(step) {
  const current = Math.min(Math.max(Number(step) || 0, 0), PROGRESS_STEP_LABELS.length);
  return PROGRESS_STEP_LABELS.map((label, index) => {
    const no = index + 1;
    let state = 'todo';
    if (no < current) state = 'done';
    else if (no === current) state = 'now';
    return { key: 'step' + no, no, label, state };
  });
}

/**
 * 限时倒计时条状态（首页深色卡 / 详情页共用，保证两处配色与文案完全一致）
 * ---------------------------------------------------------------------
 * 配色规则（与设计稿一致）：
 *   待接单      ：灰蓝满格 + 「接单后开始计时」（保持满格是为了卡片高度不跳）
 *   剩余 > 50%  ：绿
 *   剩余 20~50% ：橙
 *   剩余 < 20%  ：红
 *   已超时      ：亮红、进度归零
 * @param {object} task 接口下发的任务对象
 * @returns {{ratio:number, percent:number, className:string, text:string}}
 */
function limitBarState(task = {}) {
  const status = Number(task.status) || 0;
  const remain = typeof task.remainSeconds === 'number' ? task.remainSeconds : null;
  const limitMin = Number(task.timeLimitMin) || 0;
  // 待接单：还没开始计时，保持满格灰蓝，避免卡片高度跳动
  if (status === 0) return buildBar(1, 'pending', '接单后开始计时');
  if (task.isOvertime || (remain !== null && remain <= 0)) {
    const overSeconds = Number(task.overtimeSeconds) || 0;
    return buildBar(0, 'over', overSeconds > 0 ? `已超时 ${lateDurationText(overSeconds)}` : '已超时');
  }
  if (remain !== null && limitMin > 0) {
    const ratio = Math.max(0, Math.min(1, remain / (limitMin * 60)));
    let className = 'safe';
    if (ratio <= 0.2) className = 'danger';
    else if (ratio <= 0.5) className = 'warm';
    return buildBar(ratio, className, `剩余 ${countdownText(remain)}`);
  }
  // 不限时的进行中任务：条子保持满格灰蓝，文案直接说明「不限时」
  if (status === 1) return buildBar(1, 'pending', '不限时');
  // 待雇主确认(2) 及之后：不再倒计时，改成说明当前卡在哪一步
  const step = Number(task.progressStep) || 0;
  // 已完成（状态 3，进度第 5 段）：不能再提示「待支付」，否则已完成的任务还催用户转账
  if (status === 3 || step >= 5) return buildBar(1, 'safe', '已完成');
  // 待支付（进度第 4 段）：雇主已确认收货，只剩线下转账
  if (step === 4) return buildBar(1, 'safe', '待支付 · 请线下转账');
  if (status === 2) return buildBar(1, 'safe', '已送达 · 等待雇主确认');
  return buildBar(0, 'over', progressLabel(step) ? `已中止于「${progressLabel(step)}」` : '任务已中止');
}

/** 组装倒计时条的展示字段（内部工具，避免上面重复写四遍） */
function buildBar(ratio, className, text) {
  const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  return { ratio: safeRatio, percent: Math.round(safeRatio * 100), className, text };
}

module.exports = {
  formatTime,
  fromNow,
  price,
  imageUrl,
  imageUrls,
  taskStatusText,
  taskStatusClass,
  taskTypeText,
  taskTypeClass,
  progressLabel,
  progressText,
  progressSteps,
  limitBarState,
  taskAccentClass,
  taskDeckStatusClass,
  countdownText,
  isCountdownOver,
  lateDurationText,
  calcLateDeduct,
  maskPhone,
  timeLimitText,
  banRemainText,
  roleTag,
  identityBadge,
  personView,
  // 字典文案读取
  avatarAuditText: (v) => getText(AVATAR_AUDIT, v, ''),
  campusAuditText: (v) => getText(CAMPUS_AUDIT, v, ''),
  auditStatusText: (v) => getText(AUDIT_STATUS, v, ''),
  appealStatusText: (v) => getText(APPEAL_STATUS, v, ''),
  reportTypeText: (v) => getText(REPORT_TYPE, v, ''),
  msgTypeText: (v) => getText(MSG_TYPE, v, ''),
  payStatusText: (v) => getText(PAY_STATUS, v, ''),
  billTypeText: (v) => getText(BILL_TYPE, v, ''),
  auditApplyTypeText: (v) => getText(AUDIT_APPLY_TYPE, v, '')
};
