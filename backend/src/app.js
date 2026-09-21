/**
 * =====================================================================
 * 校园跑腿后端服务入口
 * 中间件顺序：JSON解析(捕获rawBody) -> XSS转义 -> 静态资源 -> 路由 -> 404 -> 统一错误处理
 * =====================================================================
 */

// 必须最先加载环境变量，后续模块读取 .env 时才拿得到值
require('dotenv').config();

// 密钥强度自检：JWT_SECRET / MEDIA_SIGN_SECRET 过弱直接拒绝启动（fail fast）
// 详见 utils/secretGuard.js —— 弱密钥可被离线爆破进而伪造任意用户（含管理员）的令牌
const { assertSecretsStrong } = require('./utils/secretGuard');
assertSecretsStrong();

const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('./db/db');
const scheduleTask = require('./schedule');
const xssFilter = require('./middleware/xssFilter');
const { signResponseMedia, mediaGuard, normalizeIncomingMedia } = require('./middleware/mediaGuard');
const { getClientIp } = require('./middleware/rateLimit');
const { ok, fail, log, BizError } = require('./utils/common');
const { CODE_MSG, MSG, BIZ } = require('./utils/constant');

const userRoutes = require('./routes/userRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/auditRoutes');
const appealRoutes = require('./routes/appealRoutes');
const messageRoutes = require('./routes/messageRoutes');
const reportRoutes = require('./routes/reportRoutes');
const payRoutes = require('./routes/payRoutes');
const billRoutes = require('./routes/billRoutes');
const adminRoutes = require('./routes/adminRoutes');
const announceRoutes = require('./routes/announceRoutes');

const app = express();

// 反向代理（cpolar / nginx）下获取真实客户端 IP，用于限流
app.set('trust proxy', true);
app.disable('x-powered-by');
// 关闭 ETag：接口若返回 304，真机上小程序可能拿不到响应体而误报「网络异常」
app.set('etag', false);

// 上传目录
const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ------------------------------ 基础中间件 ------------------------------

// 解析 JSON，同时保留原始报文字符串（微信支付回调验签必须使用原始报文）
// 备用图片上传通道（base64）请求体偏大（2MB 图片 base64 后约 2.8MB），这里单独放宽限制；
// 必须放在全局 JSON 解析之前：body-parser 解析过一次后，全局解析会自动跳过
app.use('/api/user/uploadImageBase64', express.json({ limit: '8mb' }));
// 微信虚拟支付「发货推送」报文是 XML，body-parser 的 json 解析器不认，
// 这里单独挂文本解析器把原始 XML 原样交给 payController.notifyVirtual。
// 同样必须放在全局 JSON 解析之前（同一请求体只能被解析一次）。
app.use('/api/pay/xpayNotify', express.text({ type: () => true, limit: '1mb' }));
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// XSS 防御：所有入参字符串做 HTML 特殊字符转义
app.use(xssFilter);

// 入参归一化：前端会把「上传接口返回的带签名地址」原样回传（img1 / deliveryImages / applyContent 等），
// 这里统一剥掉签名参数，保证数据库里永远只存 /uploads/xxx.jpg 相对路径。
// 否则库里会存下一个带过期时间的 URL，签名一过期历史图片全部 403 打不开。
app.use(normalizeIncomingMedia);

// 图片签名：把响应体里所有 /uploads 地址自动改写成带签名的短时链接。
// 必须挂在业务路由之前，所有接口才能统一下发可访问的地址（无需逐个控制器改造）。
app.use(signResponseMedia);

// 上传目录：不再对外公开直出。
// 校园认证截图包含真实姓名 / 学号 / 手机号，若挂成公开静态目录，
// 任何人拿到链接即可在未登录状态下查看（敏感文件未授权访问）。
// 现在必须先通过 mediaGuard 验签（签名在 URL 上，因为小程序 <image> 无法带 Authorization 头），
// 无签名 / 签名错误 / 已过期一律 403；express.static 只负责真正读文件。
app.use(
  '/uploads',
  mediaGuard,
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    // 文件名带随机串、内容不会原地覆盖，配合签名 URL 可安全使用强缓存
    immutable: true,
    // 关闭目录索引与点文件访问，避免目录被列举或读取隐藏文件
    index: false,
    dotfiles: 'deny'
  })
);

// 轻量 CORS（小程序请求不需要，但便于浏览器/H5 调试）
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Refresh-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// 请求日志（仅记录方法、路径、状态码、耗时、来源 IP，不打印请求体等敏感数据）
// 来源 IP 与限流中间件使用同一套取值逻辑（rateLimit.getClientIp），便于排查「限流误伤/被绕过」
app.use((req, res, next) => {
  const startAt = Date.now();
  // 图片地址的签名参数藏在 query 里，写日志前先剥掉，
  // 避免把「可直接访问的带签名链接」长期留在日志文件中（日志被转发/截图即等于链接泄漏）
  const logUrl = req.originalUrl.indexOf('/uploads/') === 0
    ? req.originalUrl.split('?')[0]
    : req.originalUrl;
  res.on('finish', () => {
    log('info', `${req.method} ${logUrl} ${res.statusCode} ${Date.now() - startAt}ms ip=${getClientIp(req)}`);
  });
  next();
});

// ------------------------------ 业务路由 ------------------------------

app.get('/api/health', (req, res) => ok(res, {
  status: 'ok',
  time: new Date().toISOString(),
  // 支付模式：simulate=模拟支付 / virtual=微信虚拟支付（B 方案）/ api_v3=微信支付APIv3（备用）
  payMode: require('./utils/payUtil').getPayMode(),
  paySimulate: require('./utils/payUtil').isSimulate(),
  // 短信验证码已下线：登录体系改为「账号ID/学号 + 图形验证码 + 密保问题」
  captchaEnabled: true,
  wxLoginEnabled: Boolean(process.env.WX_APPID && process.env.WX_APP_SECRET)
}));

app.use('/api/user', userRoutes.router);
// 管理员接口：用户管理 + 封禁管理（鉴权与管理员白名单校验在路由内部统一处理）
app.use('/api/admin', adminRoutes);
app.use('/api/task', taskRoutes);
app.use('/api/pay', payRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/appeal', appealRoutes);
app.use('/api/message', messageRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/bill', billRoutes);
// 公告：用户端拉取「跑马灯 + 全局通知条」生效中的内容（登录后调用）
app.use('/api/announce', announceRoutes);

// ------------------------------ 兜底处理 ------------------------------

// 404
app.use((req, res) => fail(res, 404, '接口不存在'));

/**
 * 统一错误处理：对外只返回友好提示，绝不暴露数据库堆栈与代码细节
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 业务异常：直接返回友好提示
  if (err instanceof BizError) {
    return fail(res, err.code, err.message);
  }

  // 上传相关异常
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(Number(process.env.UPLOAD_MAX_SIZE || BIZ.MAX_UPLOAD_SIZE) / 1024 / 1024);
      return fail(res, 400, `图片大小不能超过${mb}MB`);
    }
    return fail(res, 400, '图片上传失败，请重试');
  }

  // 请求体解析异常 / 体积超限
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return fail(res, 400, '请求数据过大');
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return fail(res, 400, CODE_MSG[400]);
  }

  // 其它未知异常：记录日志，对外只给统一提示
  log('error', '未处理异常：', err && (err.stack || err.message));
  return fail(res, 500, MSG.SERVER_ERROR);
});

// ------------------------------ 启动服务 ------------------------------

const PORT = Number(process.env.PORT || 3000);

/**
 * 启动流程：检测数据库 -> 启动定时任务 -> 监听端口
 */
/**
 * 上线配置自检
 * ---------------------------------------------------------------------
 * 这些配置在本地调试时是必需的（例如模拟支付、本机弱口令），
 * 但一旦原样上线会直接造成损失（用户不真实付款 / 数据库可被撞库）。
 * 只提示、不阻断启动：既不打扰本地开发，又能保证部署时一眼看见。
 * @returns {string[]} 需要处理的配置项说明（空数组表示没有调试配置残留）
 */
function checkReleaseConfig() {
  const warns = [];

  if (String(process.env.NODE_ENV || 'development') !== 'production') {
    warns.push('NODE_ENV 当前是 ' + (process.env.NODE_ENV || 'development') + '，线上建议设为 production');
  }
  const payMode = require('./utils/payUtil').getPayMode();
  if (payMode === 'simulate') {
    warns.push('PAY_MODE=simulate：点「支付」直接成功、用户不会真实付款，正式上线前必须改成 virtual（个人主体虚拟支付）');
  }
  if (payMode === 'virtual' && !require('./utils/virtualPay').isConfigured()) {
    warns.push('PAY_MODE=virtual 但 XPAY_OFFER_ID / XPAY_APP_KEY 未配置：用户点支付会直接失败，请先填写虚拟支付参数');
  }
  const pwd = String(process.env.DB_PASSWORD || '');
  const weakPwd = ['123456', 'root', 'password', '12345678', 'mysql', 'admin'];
  if (pwd.length < 8 || weakPwd.indexOf(pwd.toLowerCase()) !== -1) {
    warns.push('DB_PASSWORD 过弱（短于 8 位或命中常见口令），数据库上公网前请换成强密码');
  }
  if (!process.env.ADMIN_STUDENT_IDS) {
    warns.push('ADMIN_STUDENT_IDS 未配置：将没有任何账号能进入管理后台');
  }
  if (String(process.env.SEC_CHECK_ENABLE || 'false') !== 'true') {
    warns.push('SEC_CHECK_ENABLE=false：UGC 文本（任务备注 / 昵称）未做微信内容安全校验，建议上线时开启');
  }

  return warns;
}

async function bootstrap() {
  try {
    await db.testConnection();
    log('info', `数据库连接成功：${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  } catch (err) {
    log('error', '数据库连接失败，请检查 .env 配置与 MySQL 服务状态：', err.message);
    process.exit(1);
  }

  // 定时任务随服务常驻启动，不依赖前端触发
  scheduleTask.start();

  // 数据库结构自愈（全新库为空操作）：
  //   1) users.account_no 账号编号列（缺失则补齐并按 id 回填）
  //   2) tasks 未送达申诉相关列（is_disputed / dispute_reason / dispute_time）
  //   3) tasks 超时送达 / 超时扣酬金相关列
  //   4) users 管理员封禁相关列（ban_reason / ban_operator_id / ban_created_at）
  //   5) report 举报类型列（report_type：1 普通举报 / 2 恶意超时投诉）
  //   6) tasks 任务订单号列（order_no：GCPT+数字，缺失则按 id 回填并补唯一索引）
  //   7) report 举报快照列（订单号 + 雇主/接单人 账号ID、学号、手机号）
  //   8) 邀请码免费代拿相关列（users 权益四列 + tasks.is_free_delivery）
   //   9) users 账号注销列（deactivated_at）
   //  10) tasks 取件码 / 详细地址列（pickup_code / detail_address，均为选填）
   //  11) 账号安全体系：users 密保相关列 + user_device 设备绑定表 + users.phone 改为允许为空
   //  12) 设备登录 IP / 归属地列 + user_kick 顶号提示表（被顶下线的设备弹窗告知）
   //  13) tasks 物品照片列（pickup_img1~3，接单者提交完成时的「拿到物品」凭证）
  const {
    ensureAccountNoColumn, ensureTaskDisputeColumns, ensureTaskLateDeliveryColumns,
    ensureUserBanColumns, ensureReportColumns, ensureTaskOrderNoColumn, ensureInviteCouponColumns,
    ensureUserDeactivateColumn, ensureTaskExtraColumns, ensureTaskDeletedColumns,
    ensureAuditVoidColumn, ensureUserSecuritySchema, ensureDeviceIpAndKickSchema,
    ensureTaskPickupImages, ensureAnnounceSchema, ensureTaskFlowColumns,
    ensurePublishCouponSchema
  } = require('./db/ensureSchema');

  /*
   * 注意：这里必须「每一步各自 try/catch」，不能把十几步塞进同一个 try。
   * 历史事故：ensureDeviceIpAndKickSchema 忘记导出时抛错，导致后面所有自愈步骤
   * （含 tasks 物品照片列）全部被跳过，提交完成接口直接报 Unknown column。
   * 单步失败只记账、不中断，保证后面的列 / 表一定有机会补上。
   */
  const schemaSteps = [
    ['账号自增编号列', ensureAccountNoColumn],
    // 账号安全体系（密保列 + 设备绑定表 + 手机号改为选填）优先执行，其它自愈逻辑依赖 users 新列
    ['账号安全体系（密保 / 设备）', ensureUserSecuritySchema],
    ['任务争议列', ensureTaskDisputeColumns],
    ['任务超时送达列', ensureTaskLateDeliveryColumns],
    ['用户封禁列', ensureUserBanColumns],
    // 订单号回填必须在举报快照回填之前，否则老举报拿不到任务订单号
    ['任务订单号列', ensureTaskOrderNoColumn],
    ['举报快照列', ensureReportColumns],
    ['邀请码免费代拿列', ensureInviteCouponColumns],
    ['注销账号列', ensureUserDeactivateColumn],
    ['任务扩展列（取件码 / 详细地址）', ensureTaskExtraColumns],
    ['任务软删除列', ensureTaskDeletedColumns],
    ['审核作废列', ensureAuditVoidColumn],
    ['登录设备 IP / 顶号提示表', ensureDeviceIpAndKickSchema],
    ['任务物品照片列', ensureTaskPickupImages],
  ['任务类型 / 帮带物品 / 确认取货 / 确认收货列', ensureTaskFlowColumns],
    ['公告表（跑马灯 / 通知条）', ensureAnnounceSchema],
    ['发布券 / 支付渠道列（虚拟支付）', ensurePublishCouponSchema]
  ];
  for (const [stepName, step] of schemaSteps) {
    if (typeof step !== 'function') {
      // 导出缺失时立刻暴露出来，而不是静默跳过（否则业务接口才会炸出 Unknown column）
      log('error', '数据库结构自愈步骤「' + stepName + '」未正确导出，已跳过');
      continue;
    }
    try {
      await step();
    } catch (err) {
      log('error', '数据库结构自愈步骤「' + stepName + '」失败：', err.message);
    }
  }

  // 管理员账号自动认证：启动即把白名单学号账号标记为「校园认证通过 + 管理员标识」，
  // 无需等待管理员本人登录，其他人打开任务列表 / 详情就能看到管理员标识
  try {
    const User = require('./models/User');
    const affected = await User.syncAdminAccounts();
    log('info', `管理员账号同步完成，本次修正 ${affected} 个账号（白名单：${process.env.ADMIN_STUDENT_IDS || '未配置'}）`);
  } catch (err) {
    log('error', '管理员账号同步失败：', err.message);
  }

  // 上线自检：把「仅适合本地调试」的配置一次性列清楚，避免带着模拟支付 / 弱口令上线
  const releaseWarns = checkReleaseConfig();
  if (releaseWarns.length) {
    log('warn', '【上线自检】发现 ' + releaseWarns.length + ' 项仅适合本地调试的配置，正式部署前请逐项处理：');
    releaseWarns.forEach((item, i) => log('warn', '  ' + (i + 1) + ') ' + item));
  } else {
    log('info', '【上线自检】未发现调试配置残留，可直接部署');
  }

  const server = app.listen(PORT, () => {
    log('info', `校园跑腿后端服务已启动：http://localhost:${PORT}`);
    log('info', '支付模式：' + require('./utils/payUtil').getPayMode() + '（发布券：' + require('./utils/virtualPay').getCouponPriceFen() + '分/张）；'
      + '验证码：图形验证码（本地生成，零成本）'
      + `；微信身份识别：${process.env.WX_APPID && process.env.WX_APP_SECRET ? '已启用（openid 绑定）' : '未启用（回退设备指纹）'}`);
  });

  // 端口占用等致命错误直接退出进程，避免多个实例同时运行定时任务
  server.on('error', (err) => {
    const reason = err.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用` : err.message;
    log('error', `服务启动失败：${reason}`);
    process.exit(1);
  });
}

// 进程级异常兜底，避免服务静默退出
process.on('uncaughtException', (err) => {
  log('error', '未捕获异常：', err && (err.stack || err.message));
});
process.on('unhandledRejection', (reason) => {
  log('error', '未处理的 Promise 拒绝：', reason);
});

bootstrap();

module.exports = app;
