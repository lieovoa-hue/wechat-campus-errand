/**
 * =====================================================================
 * 全局状态映射字典 + 统一接口错误码
 * ---------------------------------------------------------------------
 * 【重要】本文件与前端 miniprogram/utils/constant.js 必须保持完全一致，
 *        任何业务代码中禁止硬编码中文状态文案，必须通过字典读取。
 * =====================================================================
 */

// ---------------------- 头像审核状态 is_avatar_audit ----------------------
const AVATAR_AUDIT = {
  0: '无申请',
  1: '待审核',
  2: '审核通过',
  3: '已驳回'
};

// ---------------------- 校园认证状态 is_campus_audit ----------------------
const CAMPUS_AUDIT = {
  0: '无申请',
  1: '待审核',
  2: '审核通过',
  3: '已驳回'
};

// ---------------------- 任务状态 tasks.status ----------------------
const TASK_STATUS = {
  0: '待接单',
  1: '进行中',
  2: '待雇主确认',
  3: '已完成',
  4: '超时取消',
  5: '雇主主动撤销'
};

// ---------------------- 审核申请状态 audit_apply.status ----------------------
const AUDIT_STATUS = {
  1: '待审核',
  2: '审核通过',
  3: '已驳回'
};

// ---------------------- 申诉状态 appeals.status ----------------------
const APPEAL_STATUS = {
  1: '待处理',
  2: '已回复'
};

// ---------------------- 任务类型 tasks.task_type ----------------------
// 发布任务时选的快捷模板，任务卡与详情页据此显示类型标签，
// 同时决定「取件码 / 帮带物品」哪个是必填项（见 taskController.normalizeTaskForm）
const TASK_TYPE = {
  0: '其他',
  1: '取快递',
  2: '食堂带饭',
  3: '打印资料',
  4: '超市代买'
};
const TASK_TYPE_ENUM = {
  OTHER: 0,
  EXPRESS: 1,
  MEAL: 2,
  PRINT: 3,
  MARKET: 4
};

// ---------------------- 举报状态 report.status ----------------------
const REPORT_STATUS = {
  1: '待处理',
  2: '已处理完毕'
};

// ---------------------- 举报类型 report.report_type ----------------------
// 1 普通举报：任何登录用户都可在任务详情页提交
// 2 恶意超时投诉：仅任务雇主可在「限时任务已超时」时提交，直接送达管理员后台
// 3 雇主举报接单人：任务已被接单后，雇主举报接单人的服务质量（物品损坏 / 态度恶劣等）
const REPORT_TYPE = {
  1: '普通举报',
  2: '恶意超时投诉',
  3: '雇主举报接单人'
};

// ---------------------- 公告展示位置 announcements.scope ----------------------
// 1 跑马灯（首页横向滚动） / 2 全局通知条（各页顶部横幅）
// 两套内容分开维护，管理员在后台分别发布。
const ANNOUNCE_SCOPE = {
  1: '跑马灯',
  2: '全局通知条'
};

const ANNOUNCE_SCOPE_ENUM = {
  MARQUEE: 1,
  NOTICE: 2
};

// ---------------------- 消息类型 messages.msg_type ----------------------
const MSG_TYPE = {
  1: '系统消息',
  2: '管理员消息',
  3: '任务消息',
  4: '雇主消息'
};

// ---------------------- 支付状态 payments.status ----------------------
const PAY_STATUS = {
  0: '待支付',
  1: '支付成功',
  2: '支付失败',
  3: '已退款'
};

// ---------------------- 账单类型 user_bill.type ----------------------
const BILL_TYPE = {
  1: '任务收入',
  2: '服务费支出'
};

// ---------------------- 账号编号规则（对外展示 / 登录使用） ----------------------
// 【重要】数据库主键 id 依旧是 INT AUTO_INCREMENT（全局唯一、并发安全），
//        但对外展示与登录使用 account_no 账号编号：
//          管理员：A + 4位数字，从 A0001 开始
//          普通用户：X + 4位数字，从 X0001 开始按注册顺序递增
//        超过 4 位直接拼接原数字（如 A10000 / X10000），不截断
//        本常量与前端 miniprogram/utils/constant.js 完全一致
const ACCOUNT_NO_RULE = {
  ADMIN_PREFIX: 'A',
  NORMAL_PREFIX: 'X',
  PAD: 4
};

// ---------------------- 任务订单号规则 tasks.order_no ----------------------
// 【重要】每发布一个任务都会生成一个全局唯一的订单号：GCPT + 数字（例如 GCPT000123）。
//        订单号在任务卡片 / 任务详情页展示；用户举报该任务时，
//        会把订单号和「雇主 / 接单人」双方的 账号ID / 学号 / 手机号 一并上报，供管理员核对。
//        数字部分取自任务主键 id（INT AUTO_INCREMENT，全局唯一且并发安全），固定补零到 6 位，
//        超过 6 位直接拼接原数字（如 GCPT1000000），不截断。
//        本常量与前端 miniprogram/utils/constant.js 完全一致。
const TASK_ORDER = {
  PREFIX: 'GCPT',
  PAD: 6
};

// ---------------------- 认证 / 管理员标识文案 ----------------------
// 统一规则（前后端一致）：管理员显示红色「管理员」标识且不再显示「已认证」；
// 校园认证通过的普通用户显示绿色「已认证」标识；其余用户不显示任何标识。
const CERT_TAG = {
  CERTIFIED: '已认证'
};

// ---------------------- 运营信息（官方 Q 群） ----------------------
// 【只需要改这里】把 QQ_GROUP 换成你自己的 QQ 群号，全站所有页面底部会同步生效。
const OFFICIAL_INFO = {
  QQ_GROUP: '756323608',
  TIP: '使用中如遇到问题加入官方Q群咨询解决'
};

// ---------------------- 未送达申诉标签 undelivered_tag ----------------------
// 雇主在「待雇主确认」阶段点击「未送达」后勾选的标签；
// 选择「其他」时必须自行填写问题原因（前端展示输入框）
const UNDELIVERED_TAG = {
  1: '不是我的商品',
  2: '商品破损',
  3: '送至错误位置',
  4: '其他'
};

// 选择该标签时，前端必须显示输入框让用户自行填写问题原因
const UNDELIVERED_TAG_OTHER = 4;

// 雇主举报接单人的原因标签（report_type = 3，直达管理员后台「举报管理」）；
// 任务被接单后，雇主可从这些维度评价接单人的服务质量，
// 选择「其他」时必须自行填写补充说明（前端展示输入框，后端强制校验 ≥5 字）
const REPORT_TAKER_TAG = {
  1: '物品损坏',
  2: '态度恶劣',
  3: '私自加价',
  4: '虚假送达',
  5: '擅自取消',
  6: '其他'
};

// 选择该标签时，必须填写补充说明
const REPORT_TAKER_TAG_OTHER = 6;

// 任务已被接单后（接单人尚未确认取货），雇主仍可编辑的字段白名单：
// 收件人 / 电话 / 取件码 / 详细地址 / 备注 / 帮带物品 均可更正，
// 但「送达地址」与「限时」被锁死 —— 跑腿员已按原地址和原限时在跑，改动会直接损害接单人利益。
const TAKEN_EDITABLE_FIELDS = [
  'receiver_name', 'receiver_phone', 'pickup_code', 'detail_address', 'remark', 'item_name'
];

// ---------------------- 审核申请类型 audit_apply.apply_type ----------------------
const AUDIT_APPLY_TYPE = {
  1: '头像',
  2: '昵称',
  3: '校园认证'
};

// ---------------------- 账号角色标识（管理员标识对所有用户可见） ----------------------
const ROLE_TAG = {
  0: '普通用户',
  1: '管理员'
};

// ---------------------- 接单封禁状态（管理员后台「封禁管理」展示） ----------------------
// 判定依据只有 users.ban_take_time 这一个字段：
//   NULL 或已过期 -> 0 未封禁 ；大于当前时间 -> 1 封禁中
const BAN_STATUS = {
  0: '未封禁',
  1: '封禁中'
};

const BAN_STATUS_ENUM = {
  NORMAL: 0,  // 未封禁（ban_take_time 为 NULL 或已过期）
  BANNED: 1   // 封禁中（ban_take_time > NOW()）
};

// ---------------------- 管理员封禁时长预设（前后端一致） ----------------------
// 管理员在「管理员后台 - 封禁管理」中对用户封禁接单权限 / 加时时，可选择的时长档位。
// custom 表示自定义：可分别填写 年 / 月 / 日 / 时 / 分 / 秒，
// 每一项最小为 0，留空（不填）即表示该项为 0（不设置该项）。
const BAN_DURATION = [
  { key: '5m', label: '5分钟' },
  { key: '15m', label: '15分钟' },
  { key: '30m', label: '30分钟' },
  { key: '1h', label: '1小时' },
  { key: '2h', label: '2小时' },
  { key: '1d', label: '1天' },
  { key: 'custom', label: '自定义' }
];

// 预设时长枚举（key 与 BAN_DURATION.key 一一对应）
const BAN_DURATION_ENUM = {
  MIN5: '5m',
  MIN15: '15m',
  MIN30: '30m',
  HOUR1: '1h',
  HOUR2: '2h',
  DAY1: '1d',
  CUSTOM: 'custom'
};

// 自定义封禁时长的 6 个时间单位（与前端封禁弹窗输入框一一对应）
const BAN_CUSTOM_UNITS = ['year', 'month', 'day', 'hour', 'minute', 'second'];

// ---------------------- 密保问题题库（前后端完全一致，注册后必须任选 2 道） ----------------------
// 说明：密保答案由用户自行填写并以 bcrypt 哈希落库，数据库中绝不出现明文答案。
//       题库只用于前端下拉选择；用户选中的问题文本会随 users.sec_question1/sec_question2 一起落库，
//       因此后续调整题库不会影响已注册的老账号。
const SECURITY_QUESTIONS = [
  '你的小学班主任姓名是什么？',
  '你母亲的姓名是什么？',
  '你最喜欢的一本书是什么？',
  '你的第一台手机品牌是什么？',
  '你的家乡所在县级行政区名称是什么？',
  '你最喜欢的电影名字是什么？'
];

// ---------------------- 密保设置状态 users.security_set ----------------------
const SECURITY_STATUS = {
  0: '未设置',
  1: '已设置'
};

// ---------------------- 统一接口错误码 ----------------------
const CODE_MSG = {
  200: '成功',
  400: '参数错误',
  401: '登录已失效',
  403: '无权限',
  409: '操作冲突',
  423: '账号已锁定',
  428: '请先设置密保问题',
  500: '服务器内部错误'
};

// ---------------------- 业务枚举常量（代码中禁止出现魔法数字） ----------------------
const TASK_STATUS_ENUM = {
  WAIT_TAKE: 0,      // 待接单
  TAKING: 1,         // 进行中
  WAIT_CONFIRM: 2,   // 待雇主确认
  FINISHED: 3,       // 已完成
  TIMEOUT_CANCEL: 4, // 超时取消
  OWNER_CANCEL: 5    // 雇主主动撤销
};

const AUDIT_STATUS_ENUM = {
  PENDING: 1,   // 待审核
  PASS: 2,      // 审核通过
  REJECT: 3     // 已驳回
};

const CAMPUS_AUDIT_ENUM = {
  NONE: 0,
  PENDING: 1,
  PASS: 2,
  REJECT: 3
};

const AVATAR_AUDIT_ENUM = {
  NONE: 0,
  PENDING: 1,
  PASS: 2,
  REJECT: 3
};

const AUDIT_APPLY_TYPE_ENUM = {
  AVATAR: 1,
  NICKNAME: 2,
  CAMPUS: 3
};

const APPEAL_STATUS_ENUM = {
  PENDING: 1,
  REPLIED: 2
};

const REPORT_STATUS_ENUM = {
  PENDING: 1,
  HANDLED: 2
};

const REPORT_TYPE_ENUM = {
  NORMAL: 1,               // 普通举报
  LATE_TAKEOVER: 2,        // 恶意超时投诉（直达管理员）
  OWNER_REPORT_TAKER: 3    // 雇主举报接单人（任务已被接单后）
};

const MSG_TYPE_ENUM = {
  SYSTEM: 1,   // 系统消息
  ADMIN: 2,    // 管理员消息
  TASK: 3,     // 任务消息
  OWNER: 4     // 雇主消息
};

const PAY_STATUS_ENUM = {
  UNPAID: 0,
  SUCCESS: 1,
  FAIL: 2,
  REFUNDED: 3
};

const BILL_TYPE_ENUM = {
  TASK_INCOME: 1,   // 任务收入
  SERVICE_FEE: 2    // 服务费支出
};

// ---------------------- 发布费用来源 tasks.pay_channel ----------------------
// 发布任务时的 0.1 元信息服务费有三种来源，决定撤销时退什么：
//   FREE   -> 邀请码免费代拿权益，撤销且从未被接单时返还权益次数；
//   CASH   -> 现金支付（模拟支付 / 微信虚拟支付），撤销时返还 1 张发布券；
//   COUPON -> 发布券抵扣，撤销时返还 1 张发布券。
// 为什么现金单也退券而不是退款：微信个人主体虚拟支付不支持退款，
// 统一退「等值发布券」既能让用户不受损失，又能避免平台垫资。
const PAY_CHANNEL_ENUM = {
  FREE: 0,
  CASH: 1,
  COUPON: 2
};

const USER_ROLE_ENUM = {
  NORMAL: 0,   // 普通用户
  ADMIN: 1     // 管理员（权限只认后端学号白名单，is_admin 仅用于前端标识展示）
};

// ---------------------- 业务固定参数 ----------------------
const BIZ = {
  SERVICE_FEE: 0.1,              // 信息服务费固定 0.1 元
  MAX_UPLOAD_SIZE: 2 * 1024 * 1024, // 单张图片最大 2MB
  ALLOW_IMG_EXT: ['jpg', 'jpeg', 'png', 'webp'],
  ANNOUNCE_MAX_LEN: 200,          // 公告正文最大字数
  ANNOUNCE_TITLE_LEN: 20,         // 公告推送到消息中心时的标题字数（自动摘取正文前若干字）
  ANNOUNCE_SORT_MAX: 9999,        // 公告排序值上限
  BATCH_DELETE_MAX: 200,          // 批量删除单次上限（防止一次删太多锁表）
  LOGIN_FAIL_LIMIT: 5,           // 连续密码错误 5 次锁定
  LOGIN_LOCK_MINUTES: 15,        // 锁定 15 分钟
  BAN_TAKE_MINUTES: 30,          // 超时取消后禁止接单 30 分钟
  CANCEL_TAKE_MINUTES: 10,       // 接单后 10 分钟内可取消
  EDIT_INTERVAL_MINUTES: 3,      // 同一任务两次编辑间隔 3 分钟
  REFUND_LIMIT_HOURS: 24,        // 发布后 24 小时内可申请退费
  AUTO_CONFIRM_HOURS: 2,         // 待确认超过 2 小时自动确认
  CAMPUS_APPLY_LIMIT: 3,         // 校园认证 7 天内最多提交 3 次
  CAMPUS_APPLY_DAYS: 7,
  APPEAL_DAILY_LIMIT: 2,         // 单用户每日最多提交 2 条申诉
  SMS_INTERVAL_SEC: 60,          // 同手机号 60 秒内最多 1 条
  SMS_HOURLY_LIMIT: 5,           // 同手机号 1 小时最多 5 条
  SMS_EXPIRE_MINUTES: 5,         // 验证码有效期 5 分钟
  MAX_DELIVERY_IMG: 3,           // 送达照片最多 3 张
  PENDING_CONFIRM_COUNTDOWN: 3,  // 前端确认送达按钮倒计时（秒），前后端约定
  LATE_DEDUCT_RATE: 0.05,        // 超时送达：酬金扣减比例 5%
  LATE_DEDUCT_MIN: 0.5,          // 超时送达：扣减金额不足 0.5 元时按 0.5 元计算
  REWARD_DEFAULT: 0.8,           // 发布任务：酬金默认值（元），前端表单默认填充
  REWARD_MIN: 0.5,               // 发布任务：酬金下限（元），低于该值不允许发布
  REWARD_MAX: 999.99,            // 发布任务：单笔酬金上限（元）
  TASK_IMG_MIN: 1,               // 发布任务：任务图片最少张数（必填）
  TASK_IMG_MAX: 3,               // 发布任务：任务图片最多张数
  // 帮带物品名称长度上限（发布任务表单与后端校验共用同一口径）
  ITEM_NAME_MAX: 60,
  PICKUP_CODE_MAX: 20,           // 发布任务：取件码最长字符数（选填项）
  DETAIL_ADDRESS_MAX: 100,       // 发布任务：详细地址最长字符数（选填项）
  REPORT_WINDOW_MINUTES: 30,     // 举报频率限制：同一任务每人 30 分钟为一个统计窗口
  REPORT_MAX_PER_TASK: 3,        // 举报频率限制：一个窗口内，同一任务每人最多举报 3 次
  TASK_DELETE_REASON_MAX: 200,   // 管理员删除任务：删除原因最长字符数（与 tasks.delete_reason 列一致）
  FREE_DELIVERY_COUNT: 1,        // 邀请码注册奖励：快递免费代拿次数
  FREE_DELIVERY_DAYS: 7,         // 邀请码注册奖励：免费代拿权益有效期（天）
  // ---------------- 账号体系（自选账号ID + 密保 + 图形验证码，短信通道已下线） ----------------
  ACCOUNT_NO_SUFFIX_MIN: 1,      // 注册自选账号ID：后缀最少 1 位数字
  ACCOUNT_NO_SUFFIX_MAX: 4,      // 注册自选账号ID：后缀最多 4 位数字（超过 9999 不再补零）
  STUDENT_ID_MIN_LEN: 6,         // 登录输入框：纯数字达到该长度时优先按学号匹配
  PASSWORD_MIN_LEN: 8,           // 密码长度下限（同时必须同时包含字母和数字）
  PASSWORD_MAX_LEN: 20,          // 密码长度上限
  CAPTCHA_EXPIRE_MINUTES: 5,     // 图形验证码有效期（分钟），校验通过后立即作废
  CAPTCHA_HOURLY_LIMIT: 60,      // 同一 IP 1 小时最多获取 60 次图形验证码（可用 .env 覆盖）
  ACCOUNT_HELPER_HOURLY_LIMIT: 120, // 账号ID随机/校验接口：同一 IP 1 小时最多 120 次（可用 .env 覆盖）
  REGISTER_IP_HOURLY_LIMIT: 100,  // 注册接口 IP 兜底限流：同一 IP 1 小时最多 100 次（可用 .env 覆盖）
  SECURITY_HOURLY_LIMIT: 60,      // 密保相关接口：同一 IP 1 小时最多 60 次（可用 .env 覆盖）
  SECURITY_QUESTION_COUNT: 2,    // 注册时必须设置的密保问题数量
  SECURITY_QUESTION_MIN_LEN: 2,  // 自定义密保问题最短字符数
  SECURITY_QUESTION_MAX_LEN: 30, // 自定义密保问题最长字符数（users.sec_question1/2 为 VARCHAR(50)，留足余量）
  SECURITY_ANSWER_MIN_LEN: 2,    // 密保答案最短字符数
  SECURITY_FAIL_LIMIT: 5,        // 密保答案连续答错 5 次锁定
  SECURITY_LOCK_MINUTES: 15,     // 密保锁定 15 分钟
  SECURITY_UNLOCK_TICKET_MINUTES: 10, // 新设备解锁票据有效期（分钟）
  DEVICE_BIND_MAX: 5,            // 单账号最多绑定设备数
  RESET_PWD_LIMIT_HOURS: 24,     // 同一账号 24 小时内最多重置 1 次密码
  PAGE_SIZE_DEFAULT: 10,
  PAGE_SIZE_MAX: 50
};

// ---------------------- 昵称修改次数 ----------------------
// 管理员账号权限最高，不受「昵称修改次数」限制；
// 接口下发 NICKNAME_COUNT_UNLIMITED(-1) 表示「不限」，前端据此展示为「不限」而不是数字。
const NICKNAME_COUNT_UNLIMITED = -1;

// ---------------------- 账号注销状态 users.deactivated_at ----------------------
// 0 正常账号；1 已注销。
// 注销后：手机号 / 学号被释放（可用于重新注册）、个人资料清空、账号不可登录且不可恢复，
//        但历史任务 / 账单 / 举报记录仍然保留，供对方当事人继续查看。
const ACCOUNT_STATUS = {
  0: '正常',
  1: '已注销'
};

// 账号注销后昵称 / 姓名的统一展示文案（个人隐私数据不再保留）
const DEACTIVATED_NAME = '已注销用户';

// ---------------------- 限时任务倒计时文案（前后端一致的展示口径） ----------------------
const COUNTDOWN = {
  LABEL: '剩余时间',   // 倒计时标签
  OVER: '已超时'       // 倒计时归零后的展示文案
};

// ---------------------- 友好提示文案（统一维护，禁止散落在业务代码里） ----------------------
const MSG = {
  PARAM_ERROR: CODE_MSG[400],
  LOGIN_FAILED: '账号或密码错误',
  // 登录页底部两个入口（登录 / 注册 / 忘记密码已拆成三个独立页面）
  LOGIN_GO_REGISTER: '还没账号？去注册',
  LOGIN_FORGET_PASSWORD: '忘记密码',
  ACCOUNT_LOCKED: '账号已被锁定，请15分钟后再试',
  TOKEN_INVALID: CODE_MSG[401],
  NO_PERMISSION: CODE_MSG[403],
  SERVER_ERROR: CODE_MSG[500],
  NEED_CAMPUS_CERT: '请先完成校园认证后再操作',
  TASK_TAKEN: '任务已被他人接单',
  NEED_DELIVERY_IMG: '请先上传送达照片',
  NEED_PICKUP_IMG: '请先上传物品照片',
  NEED_BOTH_IMG: '请先上传物品照片和送达照片',
  // 内容安全（UGC 文本检测，实现在 src/utils/wxSecCheck.js）
  CONTENT_RISKY: '内容涉嫌违规，请修改后重试',
  CONTENT_CHECK_UNAVAILABLE: '内容校验服务暂时不可用，请稍后重试',
  // ---------------- 雇主结束「已超时」的限时任务 ----------------
  NOT_TIMEOUT_TASK: '该任务尚未超时，无法结束',
  TIMEOUT_TASK_ENDED: '该任务已结束，请刷新后查看',
  NOT_OWN_TASK: '只有任务发布者可以操作',
  REWARD_NO_DOWN: '酬金仅可提高，不可降低',
  REWARD_MUST_UP: '酬金必须高于原酬金',
  EDIT_TOO_FREQ: '操作过于频繁，两次编辑间隔至少3分钟',
  TASK_STATUS_CHANGED: '任务状态已变更，请刷新后重试',
  ALREADY_DISPUTED: '该任务已提交过未送达申诉，系统不会自动确认收货',
  NOT_WAIT_CONFIRM: '该任务当前不是「待雇主确认」状态',
  NOT_LATE_DELIVERY: '该任务不是超时送达，无法扣减酬金',
  LATE_DEDUCT_DONE: '该任务已按超时送达扣减过酬金',
  REPEAT_SUBMIT: '请勿重复提交',
  // ---------------- 超时自动扣酬金（限时任务超时后仍可继续送达） ----------------
  NOT_TASK_TAKING: '该任务当前不是「进行中」状态',
  NOT_TIMEOUT_YET: '该任务尚未超时，无法投诉恶意超时',
  TIMEOUT_DEDUCT_DONE: '该任务已按超时自动扣减过酬金',
  // ---------------- 管理员封禁管理 ----------------
  BAN_USER_NOT_FOUND: '未找到该用户，请检查账号ID / 学号 / 手机号',
  BAN_DURATION_INVALID: '请选择封禁时长（自定义时长至少填写一项且大于0）',
  BAN_DURATION_REQUIRED: '请选择封禁时长',
  BAN_RECORD_NOT_FOUND: '该用户当前不在封禁中',
  BAN_ADMIN_SELF: '不能封禁管理员账号',
  // ---------------- 任务订单号 ----------------
  ORDER_NO_MISMATCH: '订单号与任务不匹配，请刷新页面后重试',
  ORDER_NO_EMPTY: '该任务的订单号异常，请联系管理员',
  // ---------------- 举报规则（发布人不能举报自己的任务 + 频率限制） ----------------
  REPORT_OWN_TASK: '不能举报自己发布的任务',
  REPORT_TOO_FREQ: '举报过于频繁，同一任务30分钟内最多举报3次',
  // ---------------- 管理员直接修改用户资料 ----------------
  ADMIN_USER_NOT_FOUND: '未找到该用户，请刷新列表后重试',
  ADMIN_USER_NO_CHANGE: '没有任何信息被修改，请先编辑后再提交',
  NICKNAME_INVALID: '昵称不能为空且不超过30字',
  NAME_INVALID: '姓名不能为空且不超过20字',
  STUDENT_ID_INVALID: '学号格式不正确（4-20位字母或数字）',
  PHONE_INVALID: '手机号格式不正确',
  PHONE_ALREADY_USED: '该手机号已被其他账号使用',
  STUDENT_ID_RESERVED: '该学号属于管理员白名单，不允许被占用',
  STUDENT_ID_CERTIFIED: '该学号已被其他账号完成校园认证',
  ADMIN_STUDENT_ID_LOCKED: '管理员账号的学号与权限白名单绑定，不可修改',
  AVATAR_INVALID: '头像地址不合法，请重新上传',
  // ---------------- 密码 ----------------
  PASSWORD_INVALID: '密码长度需为6-20位',
  // ---------------- 邀请码免费代拿 ----------------
  INVITE_CODE_INVALID: '邀请码不存在，请核对后重新填写',
  FREE_DELIVERY_NONE: '免费代拿次数已用完或已过期，本次将正常收取平台信息服务费',
  FREE_DELIVERY_CONFLICT: '免费代拿权益确认失败，请刷新页面后重试',
  // ---------------- 发布任务表单校验 ----------------
  NEED_TASK_IMAGE: '请至少上传1张任务图片',
  REWARD_TOO_LOW: '酬金不能低于0.5元',
  REWARD_TOO_HIGH: '单笔酬金不能超过999.99元',
  REWARD_FORMAT_ERROR: '酬金格式不正确',
  PICKUP_CODE_TOO_LONG: '取件码不能超过20字',
  ITEM_NAME_TOO_LONG: '帮带物品不能超过60字',
  NEED_PICKUP_CODE: '取快递任务必须填写取件码',
  NEED_ITEM_NAME: '请填写需要跑腿员帮带的物品',
  // ---------------- 确认取货 / 确认收货（本轮新增的两步流转） ----------------
  PICKUP_PHOTO_NEEDED: '请先上传至少1张物品照片，再点「确认取货」',
  PICKUP_ALREADY_CONFIRMED: '物品照片已确认取货并锁定，不能再修改',
  PICKUP_CONFIRM_FIRST: '请先点「确认取货」，再提交送达照片',
  OWNER_RECEIPT_FIRST: '请先点「确认收货」，再完成任务',
  OWNER_RECEIPT_DONE: '已确认收货，请线下支付酬金后点「完成任务」',
  TAKEN_FIELD_LOCKED: '任务已被接单，送达地址与限时不可修改',
  CANCEL_TAKEN_DISABLED: '接单人已确认取货，不能再撤销任务，请走举报或联系管理员',
  // 接单人自己「取消接单」的锁定文案：与上面雇主撤销的提示分开，避免指向错误的人
  CANCEL_TAKE_LOCKED: '您已确认取货并锁定物品照片，不能再取消接单；请继续完成配送，如遇特殊情况请联系雇主或管理员',
  // ---------------- 雇主举报接单人 ----------------
  REPORT_TAKER_NO_TAKER: '该任务还没有接单人，无法举报接单人',
  REPORT_TAKER_STATUS: '仅进行中 / 待确认 / 超时取消的任务可举报接单人',
  REPORT_TAKER_TAG_NEEDED: '请至少选择一个举报原因',
  REPORT_TAKER_REASON_SHORT: '补充说明需不少于5个字',
  DETAIL_ADDRESS_TOO_LONG: '详细地址不能超过100字',
  // ---------------- 账号注销 ----------------
  ACCOUNT_DEACTIVATED: '该账号已注销，无法登录',
  ACCOUNT_DEACTIVATED_ALREADY: '该账号已注销，无需重复操作',
  DEACTIVATE_ADMIN_FORBIDDEN: '管理员账号不可注销',
  DEACTIVATE_SELF_FORBIDDEN: '不能注销自己的账号，请用其他管理员账号操作',
  DEACTIVATE_PASSWORD_WRONG: '密码不正确，无法注销账号',
  // ---------------- 管理员删除任务（仅管理员可操作，删除后任务从平台下架） ----------------
  TASK_NOT_FOUND: '任务不存在或已下架',
  TASK_ALREADY_DELETED: '该任务已被管理员删除，请勿重复操作',
  TASK_DELETED: '该任务已被管理员删除，无法继续操作',
  TASK_DELETED_NOTICE: '该任务已被管理员删除，已从平台下架',
  // ---------------- 管理员订单管理（搜索 / 编辑订单） ----------------
  ADMIN_TASK_NO_CHANGE: '没有任何信息被修改，请先编辑后再提交',
  ADMIN_TASK_RECEIVER_INVALID: '收件人姓名不能为空且不超过20字',
  ADMIN_TASK_RECEIVER_PHONE_INVALID: '收件人手机号格式不正确',
  ADMIN_TASK_ADDRESS_INVALID: '送达地址不能为空且不超过100字',
  ADMIN_TASK_TIME_LIMIT_INVALID: '限时需为1-1440分钟的整数，留空表示不限时',
  ADMIN_TASK_REMARK_TOO_LONG: '任务备注不能超过200字',
  // ---------------- 单设备登录：顶号提示（被顶下线的设备弹窗告知） ----------------
  KICKED_BY_NEW_DEVICE: '账号已在其他设备登录，当前设备已被强制下线',
  KICK_NOTICE_TITLE: '账号已在其他设备登录',
  KICK_NOTICE_UNKNOWN_DEVICE: '未知设备',
  KICK_NOTICE_UNKNOWN_TIME: '未知时间',
  KICK_NOTICE_UNKNOWN_REGION: '未知地点',
  KICK_NOTICE_UNKNOWN_IP: '未知IP',
  // 内网 / 回环地址（本机调试、局域网直连）无法做归属地解析，
  // 明确标注为「局域网」，比含糊的「未知地点」更准确地描述了实际情况
  KICK_NOTICE_LOCAL_REGION: '局域网',
  // 占位符：{device} 新设备名称 / {time} 登录时间 / {region} 登录地点 / {ip} 登录IP
  KICK_NOTICE_TEMPLATE: '您的账号在另一台设备「{device}」于 {time} 登录（登录地点：{region}，IP：{ip}），当前设备已被强制下线。若非本人操作，请立即联系管理员，并及时修改密保设置与登录密码。',
  // 站内消息（同账号新设备可见，作为弹窗之外的留痕）
  KICK_MESSAGE_TITLE: '账号已在其他设备登录',
  KICK_MESSAGE_TEMPLATE: '您的账号于 {time} 在一台设备上登录（设备：{device}，登录地点：{region}，IP：{ip}），其他设备已自动下线。若非本人操作，请立即联系管理员，并及时修改密保设置与登录密码。',
  // ---------------- 校园认证提交结果提示（提交成功后弹窗告知 7 天 3 次限制） ----------------
  // 说明：CAMPUS_APPLY_TIP 中的 {days} / {limit} / {remain} 为占位符，
  //       由前端用 formatText() 填入字典里的天数、次数上限与剩余次数，
  //       保证「7 天 3 次」这类带数字的规则文案只维护在字典里。
  CAMPUS_SUBMIT_TITLE: '认证申请已提交',
  CAMPUS_SUBMIT_CONTENT: '请耐心等待管理员审核，审核结果会通过站内消息通知你。',
  CAMPUS_APPLY_TIP: '{days}天内仅限提交{limit}次认证信息，你还可以提交{remain}次',
  // ---------------- 注册：账号ID（自选 + 随机生成） ----------------
  ACCOUNT_NO_REQUIRED: '请填写账号ID',
  ACCOUNT_NO_INVALID: '账号ID格式不正确（X开头 + 1-4位数字，如X0001）',
  ACCOUNT_NO_TAKEN: '此ID已被其他用户注册，请更换ID注册',
  ACCOUNT_NO_RANDOM_FAILED: '随机生成失败，请稍后重试或手动填写',
  NEED_PROTOCOL_AGREE: '请先阅读并同意《用户服务协议》与《隐私政策》',
  // ---------------- 图形验证码（替代短信验证码，零成本防刷） ----------------
  CAPTCHA_REQUIRED: '请填写图形验证码',
  CAPTCHA_INVALID: '图形验证码错误或已过期',
  CAPTCHA_TOO_FREQ: '验证码获取过于频繁，请稍后再试',
  // ---------------- 密保问题（注册后必须设置，否则无法使用小程序） ----------------
  NEED_SET_SECURITY: '请先设置密保问题后再使用小程序',
  SECURITY_ALREADY_SET: '密保问题已设置，如需更换请通过密保验证后修改',
  SECURITY_QUESTION_INVALID: '请选择2道密保问题',
  SECURITY_QUESTION_TOO_SHORT: '密保问题至少2个字符',
  SECURITY_QUESTION_TOO_LONG: '密保问题不能超过30个字符',
  SECURITY_CUSTOM_QUESTION: '自定义问题（自行填写）',
  SECURITY_CUSTOM_QUESTION_REQUIRED: '请填写自定义密保问题',
  SECURITY_QUESTION_DUPLICATE: '两道密保问题不能相同',
  SECURITY_ANSWER_REQUIRED: '请填写两道密保答案',
  SECURITY_CURRENT_ANSWER_REQUIRED: '请先填写当前密保答案',
  SECURITY_ANSWER_TOO_SHORT: '密保答案至少2个字符',
  SECURITY_ANSWER_SAME_AS_QUESTION: '密保答案不能与问题内容相同',
  SECURITY_ANSWER_WRONG: '密保答案不正确',
  SECURITY_LOCKED: '密保验证错误次数过多，请15分钟后再试',
  // ---------------- 新设备登录保护（常用设备免验证，换设备需答密保） ----------------
  NEED_SECURITY_UNLOCK: '检测到新设备登录，请先完成密保验证',
  UNLOCK_TICKET_INVALID: '安全验证已过期，请重新登录',
  DEVICE_NOT_FOUND: '未找到该绑定设备',
  DEVICE_UNBIND_LAST_FORBIDDEN: '至少保留一个绑定设备，否则将无法登录',
  // ---------------- 忘记密码（账号ID + 密保答案；已认证账号另需学号+姓名） ----------------
  RESET_ACCOUNT_FAILED: '账号信息校验失败，请核对后重试',
  RESET_TOO_FREQ: '该账号24小时内仅可重置一次密码，请稍后再试',
  // ---------------- 密码强度 ----------------
  PASSWORD_TOO_WEAK: '密码需8-20位，且同时包含字母和数字',
  // ---------------- 学号登录 ----------------
  STUDENT_ID_MULTI: '该学号对应多个账号，请使用账号ID登录',
  // ---------------- 公告（跑马灯 / 全局通知条） ----------------
  ANNOUNCE_CONTENT_REQUIRED: '请填写公告内容',
  ANNOUNCE_CONTENT_TOO_LONG: '公告内容不能超过200字',
  ANNOUNCE_SCOPE_INVALID: '公告展示位置不正确，请刷新页面后重试',
  ANNOUNCE_NOT_FOUND: '公告不存在或已被删除',
  ANNOUNCE_TIME_INVALID: '生效结束时间必须晚于开始时间',
  ANNOUNCE_MESSAGE_TITLE: '平台公告',
  ANNOUNCE_DELETED: '公告已删除',
  // ---------------- 管理员批量删除（列表清理） ----------------
  BATCH_DELETE_EMPTY: '请先勾选要删除的记录',
  BATCH_DELETE_MODULE_INVALID: '不支持的删除类型',
  BATCH_DELETE_LIMITED: '最多一次删除200条，请分批操作',
  BATCH_DELETE_NONE_DONE: '没有可删除的记录（进行中的记录不允许删除）',
  BATCH_DELETE_USER_NOT_DEACTIVATED: '仅「已注销」账号允许删除',
  BATCH_DELETE_USER_HAS_TASK: '该账号存在关联任务',
  BATCH_DELETE_TASK_UNFINISHED: '仅「已完成 / 超时取消 / 雇主撤销」的订单允许删除',
  // 批量删除结果模板：{done} 成功条数 / {skipped} 跳过条数 / {reason} 跳过原因
  BATCH_DELETE_RESULT: '已删除{done}条，跳过{skipped}条',
  BATCH_DELETE_RESULT_REASON: '已删除{done}条，跳过{skipped}条（{reason}）',
  // ---------------- 站内消息：全部删除 ----------------
  MESSAGE_DELETE_ALL_NONE: '当前没有可删除的消息',
  MESSAGE_DELETE_ALL_DONE: '已删除全部消息',
};

/**
 * 安全读取字典文案（找不到时返回兜底值，避免出现 undefined）
 * @param {Object} map 字典对象
 * @param {number|string} key 状态值
 * @param {string} fallback 兜底文案
 * @returns {string}
 */
function getText(map, key, fallback = '') {
  if (map && Object.prototype.hasOwnProperty.call(map, key)) {
    return map[key];
  }
  return fallback;
}

/**
 * 读取统一错误码文案
 * @param {number} code
 * @returns {string}
 */
function getCodeMsg(code) {
  return getText(CODE_MSG, code, MSG.SERVER_ERROR);
}

/**
 * 文案模板占位符替换（把 {key} 替换为 params 中的值）
 * ---------------------------------------------------------------------
 * 用途：像「7天内仅限提交3次认证信息，你还可以提交{remain}次」这类
 *      带数字的规则文案，统一维护在字典里，业务代码只传参数、不写死中文。
 * 例：formatText(MSG.CAMPUS_APPLY_TIP, { days: 7, limit: 3, remain: 2 })
 * @param {string} template 文案模板
 * @param {Object} [params] 占位符取值（缺失的占位符保持原样，便于排查）
 * @returns {string}
 */
function formatText(template, params = {}) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

module.exports = {
  // 字典
  AVATAR_AUDIT,
  CAMPUS_AUDIT,
  TASK_STATUS,
  TASK_TYPE,
  AUDIT_STATUS,
  APPEAL_STATUS,
  REPORT_STATUS,
  REPORT_TYPE,
  MSG_TYPE,
  ANNOUNCE_SCOPE,
  ANNOUNCE_SCOPE_ENUM,
  PAY_STATUS,
  BILL_TYPE,
  ACCOUNT_NO_RULE,
  TASK_ORDER,
  CERT_TAG,
  OFFICIAL_INFO,
    COUNTDOWN,
    NICKNAME_COUNT_UNLIMITED,
    ACCOUNT_STATUS,
    DEACTIVATED_NAME,
    UNDELIVERED_TAG,
  UNDELIVERED_TAG_OTHER,
  REPORT_TAKER_TAG,
  REPORT_TAKER_TAG_OTHER,
  TAKEN_EDITABLE_FIELDS,
  ROLE_TAG,
  BAN_STATUS,
  BAN_STATUS_ENUM,
  BAN_DURATION,
  BAN_DURATION_ENUM,
  BAN_CUSTOM_UNITS,
  SECURITY_QUESTIONS,
  SECURITY_STATUS,
  AUDIT_APPLY_TYPE,
  CODE_MSG,
  MSG,
  BIZ,
  // 枚举
  TASK_STATUS_ENUM,
  TASK_TYPE_ENUM,
  AUDIT_STATUS_ENUM,
  CAMPUS_AUDIT_ENUM,
  AVATAR_AUDIT_ENUM,
  AUDIT_APPLY_TYPE_ENUM,
  APPEAL_STATUS_ENUM,
  REPORT_STATUS_ENUM,
  REPORT_TYPE_ENUM,
  MSG_TYPE_ENUM,
  PAY_STATUS_ENUM,
  BILL_TYPE_ENUM,
  PAY_CHANNEL_ENUM,
  USER_ROLE_ENUM,
  // 方法
  getText,
  getCodeMsg,
  formatText
};
