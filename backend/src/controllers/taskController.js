/**
 * =====================================================================
 * 任务控制器【核心业务】
 *  - 发布任务：校验校园认证 -> 创建任务与支付订单 -> 支付成功后上架
 *  - 接单：事务 + 乐观锁（UPDATE ... WHERE id=? AND status=0）
 *  - 取消接单：接单后 10 分钟内可取消，不触发封禁
 *  - 编辑 / 加酬金：状态校验 + 3 分钟频率限制 + 酬金只升不降
 *  - 提交完成：必须上传至少 1 张送达照片（最多 3 张）
  *  - 确认送达：乐观锁 + 自动记「任务收入」账单
  *  - 未送达申诉：雇主勾选标签提交后停止自动确认收货（倒计时不再判定该任务）
  *  - 限时倒计时：接单后按 time_limit_min 倒计时，双方列表与详情页同步展示
  *  - 超时送达扣酬金：超时送达的任务雇主可一次性扣减酬金（5%，不足 0.5 元按 0.5 元）
  *  - 雇主撤销 / 退费：符合条件自动原路退还 0.1 元服务费
 * =====================================================================
 */

const db = require('../db/db');
const Task = require('../models/Task');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const Message = require('../models/Message');
const Report = require('../models/Report');
const payController = require('./payController');
const payUtil = require('../utils/payUtil');
const wxSecCheck = require('../utils/wxSecCheck');
const wxSubscribe = require('../utils/wxSubscribe');
const virtualPay = require('../utils/virtualPay');
const {
  BIZ, MSG, TASK_STATUS_ENUM, BILL_TYPE_ENUM, MSG_TYPE_ENUM, PAY_STATUS_ENUM, CAMPUS_AUDIT_ENUM,
  PAY_CHANNEL_ENUM,
  UNDELIVERED_TAG, UNDELIVERED_TAG_OTHER, REPORT_TYPE_ENUM, TASK_TYPE, TASK_TYPE_ENUM,
  REPORT_TAKER_TAG, REPORT_TAKER_TAG_OTHER
} = require('../utils/constant');
const {
  ok, BizError, assertParams, parsePage, buildPage, parseMoney,
  checkIdempotent, hashParams, generateOutTradeNo, diffMinutes, diffHours, isPhone, log, formatDate,
  formatUserId, calcLateDeduct, formatLateText, formatStudentId
} = require('../utils/common');
// 管理员标识：管理员的校园认证由后端白名单自动开通，标识需要展示给所有查看者
const { isAdminStudent, roleTagOf, displayNickname } = require('../utils/adminUtil');

/** 信息服务费（元），固定 0.1 元，可通过环境变量覆盖 */
function getServiceFee() {
  const fee = Number(process.env.SERVICE_FEE);
  return Number.isFinite(fee) && fee > 0 ? fee : BIZ.SERVICE_FEE;
}

/** 编辑频率限制（分钟） */
function getEditInterval() {
  const minutes = Number(process.env.EDIT_INTERVAL_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : BIZ.EDIT_INTERVAL_MINUTES;
}

/** 接单后可取消时间（分钟） */
function getCancelTakeMinutes() {
  const minutes = Number(process.env.CANCEL_TAKE_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : BIZ.CANCEL_TAKE_MINUTES;
}

/**
 * 校园认证校验：发布任务、接单均必须认证通过
 * @param {object} user 当前用户
 */
function ensureCampusCertified(user) {
  if (!user || user.is_campus_audit !== 2) {
    throw new BizError(MSG.NEED_CAMPUS_CERT, 403);
  }
}

/**
 * 禁止接单期校验
 * @param {object} user
 */
function ensureNotBanned(user) {
  if (User.isBannedFromTaking(user)) {
    throw new BizError(`您正处于禁止接单期，解禁时间：${formatDate(user.ban_take_time, 'MM-DD HH:mm')}`, 403);
  }
}

/**
 * 规范化任务类型（快捷模板标识）
 * 只接受 0~4 的整数；非法值一律归入「其他」，避免脏数据把类型标签与必填规则带偏。
 * @param {*} value 前端提交的 taskType
 * @returns {number} 0其他 1取快递 2食堂带饭 3打印资料 4超市代买
 */
function normalizeTaskType(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || !TASK_TYPE[num]) return TASK_TYPE_ENUM.OTHER;
  return num;
}

/**
 * 校验并规范化任务表单数据
 * @param {object} body 请求体
 * @returns {object} 规范化后的字段
 */
async function normalizeTaskForm(body, actor) {
  const receiverName = String(body.receiverName || '').trim();
  const receiverPhone = String(body.receiverPhone || '').trim();
  const deliverAddress = String(body.deliverAddress || '').trim();
  const remark = String(body.remark || '').trim();
  // 选填项：取件码（跑腿员凭码取件）、详细地址（门牌 / 房间号 / 工位等）
  const pickupCode = String(body.pickupCode || '').trim();
  const detailAddress = String(body.detailAddress || '').trim();
  // 本轮新增：任务类型（快捷模板）与帮带物品
  //   任务类型决定「取件码 / 帮带物品」哪一个必填：
  //     取快递(1)         -> 取件码必填（跑腿员凭码取件，没有码根本取不到）
  //     带饭/打印/代买    -> 帮带物品必填（跑腿员要知道买什么 / 带什么）
  //     其他/自定义(0)    -> 两项都选填
  const taskType = normalizeTaskType(body.taskType);
  const itemName = String(body.itemName || '').trim();

  if (!receiverName || receiverName.length > 20) throw new BizError('收件人姓名不能为空且不超过20字');
  if (!isPhone(receiverPhone)) throw new BizError('收件人手机号格式不正确');
  if (!deliverAddress || deliverAddress.length > 100) throw new BizError('送达地址不能为空且不超过100字');
  if (remark.length > 200) throw new BizError('任务备注不能超过200字');
  // 取件码 / 详细地址为选填项，仅做长度上限校验（长度口径取自 constant.js 的 BIZ，前后端一致）
  if (pickupCode.length > BIZ.PICKUP_CODE_MAX) throw new BizError(MSG.PICKUP_CODE_TOO_LONG);
  if (detailAddress.length > BIZ.DETAIL_ADDRESS_MAX) throw new BizError(MSG.DETAIL_ADDRESS_TOO_LONG);
  if (itemName.length > BIZ.ITEM_NAME_MAX) throw new BizError(MSG.ITEM_NAME_TOO_LONG);
  // 内容安全：上面六个字段全是用户自由填写、且会被其他用户看到的文本，必须过检。
  // 拼成一段只调 1 次微信接口，避免「发布」多等 1~2 秒；SEC_CHECK_ENABLE 未开启时直接放行，
  // 本地开发与自动化回归不依赖外网。
  const sec = await wxSecCheck.checkJoined([
    { label: '收件人姓名', text: receiverName },
    { label: '送达地址', text: deliverAddress },
    { label: '详细地址', text: detailAddress },
    { label: '帮带物品', text: itemName },
    { label: '取件码', text: pickupCode },
    { label: '任务备注', text: remark }
  ], actor);
  if (!sec.pass) throw new BizError((sec.labels || '填写内容') + '：' + sec.reason);
  // 必填规则按任务类型收敛（不允许绕过：前端只是提前提示，最终口径在这里）
  if (taskType === TASK_TYPE_ENUM.EXPRESS && !pickupCode) throw new BizError(MSG.NEED_PICKUP_CODE);
  if (taskType !== TASK_TYPE_ENUM.EXPRESS && taskType !== TASK_TYPE_ENUM.OTHER && !itemName) {
    throw new BizError(MSG.NEED_ITEM_NAME);
  }

  // 酬金：必填项，前端默认填充 0.8 元；可填更低但不能低于 0.5 元（REWARD_MIN），上限 999.99 元
  const reward = parseMoney(body.reward);
  if (reward === null) throw new BizError(MSG.REWARD_FORMAT_ERROR);
  if (reward < BIZ.REWARD_MIN) throw new BizError(MSG.REWARD_TOO_LOW);
  if (reward > BIZ.REWARD_MAX) throw new BizError(MSG.REWARD_TOO_HIGH);

  let timeLimitMin = null;
  if (body.timeLimitMin !== undefined && body.timeLimitMin !== null && String(body.timeLimitMin) !== '') {
    const minutes = parseInt(body.timeLimitMin, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BizError('限时时间需为1-1440分钟');
    }
    timeLimitMin = minutes;
  }

  // 任务图片：必填，至少 1 张、最多 3 张（前端同样校验，后端强制兜底）
  const images = [body.img1, body.img2, body.img3]
    .map((item) => (item ? String(item).trim() : ''))
    .filter(Boolean)
    .slice(0, BIZ.TASK_IMG_MAX);
  if (images.length < BIZ.TASK_IMG_MIN) throw new BizError(MSG.NEED_TASK_IMAGE);

  return {
    receiver_name: receiverName,
    receiver_phone: receiverPhone,
    pickup_code: pickupCode,
    item_name: itemName,
    task_type: taskType,
    deliver_address: deliverAddress,
    detail_address: detailAddress,
    time_limit_min: timeLimitMin,
    remark,
    reward,
    img1: images[0] || '',
    img2: images[1] || '',
    img3: images[2] || ''
  };
}

/**
 * POST /api/task/createOrder 创建发布任务订单
 * ---------------------------------------------------------------------
 * 发布费用的三种来源（写入 tasks.pay_channel，决定撤销时退什么）：
 *   1. 邀请码免费代拿权益：本次 0 元，撤销且从未被接单时返还权益次数；
 *   2. 发布券：账号里有券就优先用券抵扣（1 张券 = 1 次发布），撤销时返还 1 张券；
 *   3. 现金支付：0.1 元。模拟模式直接标记成功；虚拟支付模式下发
 *      wx.requestVirtualPayment 参数，由微信「发货推送」确认后上架。
 * 特别说明：虚拟支付不支持退款，所以第 2、3 种情况撤销时统一返还「发布券」而不是现金。
 */
async function createOrder(req, res, next) {
  try {
    const user = req.user;
    ensureCampusCertified(user);
    ensureNotBanned(user);

    const form = await normalizeTaskForm(req.body, user);
    // 是否使用「邀请码免费代拿」权益（前端点击「取快递」快捷模板时自动带上）：
    // 使用后本次发布免缴平台信息服务费，仅限一件包裹、一个账号仅一次
    const useFreeDelivery = !!req.body.useFreeDelivery;
    // 发布费用来源在事务内可能被改写成「发布券」（扣券成功时），因此用 let
    let payChannel = useFreeDelivery ? PAY_CHANNEL_ENUM.FREE : PAY_CHANNEL_ENUM.CASH;
    let serviceFee = useFreeDelivery ? 0 : getServiceFee();

    // 幂等：防止连点重复下单。
    // 幂等键带上表单指纹，只有「同一用户 + 完全相同表单」在 3 秒内重复提交才拦截，
    // 连续发布两个内容不同的任务不会被误伤。
    if (!checkIdempotent(`createOrder:${user.id}:${hashParams({ ...form, free: useFreeDelivery })}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // 事务：核销权益/发布券 + 任务与支付流水同时创建，保证一致性
    const { taskId, outTradeNo } = await db.transaction(async (conn) => {
      // 核销免费代拿权益：条件更新（剩余次数>0 且未过期）保证并发下只会成功一次；
      // 返回 0 说明权益已用完/已过期/已被并发的另一次发布抢用，直接回滚整个事务
      if (useFreeDelivery) {
        const consumed = await User.consumeFreeDelivery(user.id, conn);
        if (consumed === 0) throw new BizError(MSG.FREE_DELIVERY_NONE, 409);
      } else {
        // 有发布券就优先用券抵扣（撤销任务返还的券在这里花掉）；
        // 扣券失败（余额为 0）是正常情况，回退到现金支付 0.1 元
        const couponUsed = await User.consumePublishCoupon(user.id, conn);
        if (couponUsed > 0) {
          payChannel = PAY_CHANNEL_ENUM.COUPON;
          serviceFee = 0;
        }
      }

      const newTaskId = await Task.create({
        ...form,
        user_id: user.id,
        service_fee: serviceFee,
        is_free_delivery: useFreeDelivery ? 1 : 0,
        pay_channel: payChannel
      }, conn);
      const newOutTradeNo = generateOutTradeNo();
      await Payment.create({
        userId: user.id,
        taskId: newTaskId,
        outTradeNo: newOutTradeNo,
        totalFee: serviceFee
      }, conn);
      return { taskId: newTaskId, outTradeNo: newOutTradeNo, payChannel, serviceFee };
    });

    // 模拟支付模式 / 免费代拿单 / 发布券抵扣单（应收 0 元，无需真实支付）：
    // 直接标记支付成功，任务立即上架
    if (payUtil.isSimulate() || serviceFee <= 0) {
      const transactionId = serviceFee <= 0
        ? (payChannel === PAY_CHANNEL_ENUM.COUPON ? `COUPON${Date.now()}` : `FREE${Date.now()}`)
        : `SIMULATE${Date.now()}`;
      await payController.markPaymentSuccess(outTradeNo, transactionId);
      const tip = payChannel === PAY_CHANNEL_ENUM.COUPON ? '发布券抵扣成功，任务已上架'
        : (useFreeDelivery ? '免费发布成功' : '发布成功');
      return ok(res, {
        paid: true,
        taskId,
        outTradeNo,
        serviceFee,
        payChannel,
        freeDelivery: useFreeDelivery,
        couponUsed: payChannel === PAY_CHANNEL_ENUM.COUPON
      }, tip);
    }

    // 微信小程序虚拟支付（个人主体 B 方案）：下发 requestVirtualPayment 参数，
    // 用户付款后由微信「发货推送」通知后端发货（payController.notifyVirtual）
    if (payUtil.isVirtual()) {
      const session = await payUtil.getLoginSession(req.body.code);
      const payParams = virtualPay.buildOrderParams({
        outTradeNo,
        sessionKey: session.sessionKey,
        attach: 'T' + taskId
      });
      return ok(res, {
        paid: false,
        taskId,
        outTradeNo,
        serviceFee,
        payChannel,
        payMode: 'virtual',
        payParams
      }, '订单创建成功，请完成支付');
    }

    // 备用：微信支付 API v3（企业商户号方案，当前未启用）
    const openid = await payUtil.getOpenidByCode(req.body.code);
    const prepayId = await payUtil.createJsapiPrepay({
      outTradeNo,
      description: `校园跑腿信息服务费-任务${taskId}`,
      totalFeeYuan: serviceFee,
      openid
    });

    return ok(res, {
      paid: false,
      taskId,
      outTradeNo,
      serviceFee,
      payChannel,
      payParams: payUtil.buildMiniProgramPayParams(prepayId)
    }, '订单创建成功，请完成支付');
  } catch (err) {
    return next(err);
  }
}

/**
 * 计算限时任务剩余秒数（倒计时唯一出口，列表与详情共用同一口径）
 *  - 仅「进行中(1)」且设置了限时(time_limit_min) 且已接单(take_time) 的任务才有倒计时
 *  - 截止时间 = 接单时间 + 限时分钟数；已超时返回 0
 * @param {object} task 任务行
 * @returns {number|null} 剩余秒数，不适用时返回 null
 */
function computeRemainSeconds(task) {
  if (!task) return null;
  if (task.status !== TASK_STATUS_ENUM.TAKING) return null;
  if (!task.time_limit_min || !task.take_time) return null;
  const deadline = new Date(task.take_time).getTime() + Number(task.time_limit_min) * 60 * 1000;
  return Math.max(0, Math.floor((deadline - Date.now()) / 1000));
}

/**
 * 计算「超时送达」信息（是否超时 + 超时秒数 + 应扣减的酬金）
 *  - 判定口径：提交送达时间 晚于 接单时间 + 限时分钟数
 *  - 不限时任务永远不算超时
 * @param {object} task 任务行
 * @returns {{isLate:boolean, lateSeconds:number, deduct:object|null}}
 */
function getLateDeliveryInfo(task) {
  if (!task || !task.time_limit_min || !task.take_time || !task.submit_finish_time) {
    return { isLate: false, lateSeconds: 0, deduct: null };
  }
  const deadline = new Date(task.take_time).getTime() + Number(task.time_limit_min) * 60 * 1000;
  const lateSeconds = Math.floor((new Date(task.submit_finish_time).getTime() - deadline) / 1000);
  if (lateSeconds <= 0) return { isLate: false, lateSeconds: 0, deduct: null };
  return { isLate: true, lateSeconds, deduct: calcLateDeduct(task.reward) };
}

/**
 * 计算「超时状态」（限时任务超时后仍然继续，可继续送达）
 *  - 进行中(1)：当前时间已超过「接单时间 + 限时分钟」即为超时，
 *    系统已按规则自动扣减 5% 酬金，任务不会取消，跑腿员可继续送达
 *  - 待雇主确认(2)：以提交送达时落库的 is_late_delivery / late_delivery_seconds 为准
 *  - 不限时任务、未接单任务永远不算超时
 * @param {object} task 任务行
 * @returns {{isOvertime:boolean, overtimeSeconds:number}}
 */
function computeOvertimeInfo(task) {
  if (!task || !task.time_limit_min || !task.take_time) {
    return { isOvertime: false, overtimeSeconds: 0 };
  }
  if (task.status === TASK_STATUS_ENUM.TAKING) {
    const deadline = new Date(task.take_time).getTime() + Number(task.time_limit_min) * 60 * 1000;
    const seconds = Math.floor((Date.now() - deadline) / 1000);
    return seconds > 0
      ? { isOvertime: true, overtimeSeconds: seconds }
      : { isOvertime: false, overtimeSeconds: 0 };
  }
  if (task.status === TASK_STATUS_ENUM.WAIT_CONFIRM && Number(task.is_late_delivery) === 1) {
    return { isOvertime: true, overtimeSeconds: Number(task.late_delivery_seconds) || 0 };
  }
  return { isOvertime: false, overtimeSeconds: 0 };
}

/**
 * 计算任务当前走到第几段进度（前端进度条的唯一出口，列表 / 详情口径一致）
 * ---------------------------------------------------------------------
 * 1 已被接单 → 2 已取货 → 3 已送达（待雇主确认）→ 4 待支付（雇主已确认收货）→ 5 完成
 *   · 已取货：取决于 pickup_confirm_time（接单人点「确认取货」并锁定物品照片）
 *   · 待支付：取决于 owner_receipt_time（雇主点「确认收货」，页面提示线下转账）
 *   · 超时取消 / 雇主撤销属于「中止」：按已经走过的节点回显，前端再加中止提示，
 *     这样跑腿员回头还能看到「这一单我当时已经取到货了」的事实。
 * @param {object} task 任务行
 * @returns {number} 0（还没人接单）~ 5（完成）
 */
function computeProgressStep(task) {
  if (!task) return 0;
  const status = Number(task.status);
  const picked = !!task.pickup_confirm_time;
  const receipted = !!task.owner_receipt_time;
  if (status === TASK_STATUS_ENUM.WAIT_TAKE) return 0;
  if (status === TASK_STATUS_ENUM.TAKING) return picked ? 2 : 1;
  if (status === TASK_STATUS_ENUM.WAIT_CONFIRM) return receipted ? 4 : 3;
  if (status === TASK_STATUS_ENUM.FINISHED) return 5;
  if (status === TASK_STATUS_ENUM.TIMEOUT_CANCEL) return picked ? 2 : 1;
  if (status === TASK_STATUS_ENUM.OWNER_CANCEL) return picked ? 2 : 0;
  return 0;
}

/**
 * 校验任务未被管理员删除（所有流转操作的统一前置校验）
 * ---------------------------------------------------------------------
 * 管理员删除任务后，任务会从任务大厅 / 我的发布 / 我的任务中全部消失，
 * 但仍保留在数据库里作为处置留痕。为防止「已删除的任务继续被接单 / 编辑 / 送达」，
 * 每个流转接口在事务内锁行读到任务后，第一时间调用本函数拦截。
 * @param {object} task 任务行（t.* 结构，含 is_deleted 标记）
 */
function assertTaskNotDeleted(task) {
  if (Number(task.is_deleted) === 1) throw new BizError(MSG.TASK_DELETED, 409);
}

/**
 * 任务视图对象：统一输出任务信息并计算当前用户可执行的操作（双视角适配）
 * @param {object} task 任务行
 * @param {object} user 当前登录用户
 */
function toTaskVO(task, user) {
  if (!task) return null;
  const isOwner = task.user_id === user.id;
  const isTaker = task.taker_user_id === user.id;
  const certified = user.is_campus_audit === 2;
  const banned = User.isBannedFromTaking(user);
  const paid = task.pay_status === PAY_STATUS_ENUM.SUCCESS;
  const editIntervalMin = getEditInterval();
  const canEditNow = !task.last_edit_time || diffMinutes(new Date(), task.last_edit_time) >= editIntervalMin;
  // 管理员标识（对所有查看者可见）：判定只认后端学号白名单，不读数据库 is_admin 字段
  const ownerIsAdmin = isAdminStudent(task.owner_student_id);
  const takerIsAdmin = isAdminStudent(task.taker_student_id);
  // 限时倒计时：接单时间 + 限时分钟 = 截止时间
  const remainSeconds = computeRemainSeconds(task);
  // 超时送达：优先以提交送达时落库的标记为准（老数据没有标记时按时间实时判定）
  const lateInfo = Number(task.is_late_delivery) === 1
    ? { isLate: true, lateSeconds: Number(task.late_delivery_seconds) || 0, deduct: calcLateDeduct(task.reward) }
    : getLateDeliveryInfo(task);
  const lateDeducted = Number(task.is_late_reward_deducted) === 1;
  // 超时状态（进行中已超时 / 超时送达）：雇主可据此举报「恶意超时」
  const overtime = computeOvertimeInfo(task);

  // 是否已被管理员删除（软删除：数据保留但全平台下架）
  const deleted = Number(task.is_deleted) === 1;
  // 当前查看者是否管理员：只认后端 .env ADMIN_STUDENT_IDS 硬编码学号白名单
  const isAdminViewer = isAdminStudent(user.student_id);

  const vo = {
    id: task.id,
    // 任务订单号（GCPT+数字）：卡片 / 详情页展示，举报任务时随举报一起上报给管理员
    orderNo: task.order_no || '',
    userId: task.user_id,
    ownerUserIdText: formatUserId(task.user_id, task.owner_account_no),
    ownerNickname: task.owner_nickname || '',
    ownerAvatar: task.owner_avatar || '',
    // 学号：任务卡片与详情页都需要标注发布者 / 接单者的学号
    ownerStudentId: formatStudentId(task.owner_student_id),
    ownerIsAdmin,
    ownerRoleTag: roleTagOf(ownerIsAdmin),
    // 管理员账号自动认证，因此管理员恒定展示为「已认证」
    ownerIsCertified: ownerIsAdmin || Number(task.owner_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,
    takerUserIdText: task.taker_user_id ? formatUserId(task.taker_user_id, task.taker_account_no) : '',
    takerNickname: task.taker_nickname || '',
    takerAvatar: task.taker_avatar || '',
    takerStudentId: formatStudentId(task.taker_student_id),
    takerIsAdmin,
    takerRoleTag: roleTagOf(takerIsAdmin),
    takerIsCertified: takerIsAdmin || Number(task.taker_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,
    receiverName: task.receiver_name,
    // 隐私保护：仅雇主与接单者可见完整手机号
    receiverPhone: isOwner || isTaker ? task.receiver_phone : '',
    receiverPhoneMask: task.receiver_phone ? task.receiver_phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '',
    // ---------------- 双方联系方式（仅雇主 / 接单人可见） ----------------
    // 任务被接单后，详情页「相关人员」需要展示双方姓名与手机号以便互相联系；
    // 大厅里的陌生用户拿不到手机号（与 receiverPhone / pickupCode 同一套隐私口径）
    ownerName: task.owner_name || '',
    ownerPhone: isOwner || isTaker ? (task.owner_phone || '') : '',
    takerName: task.taker_name || '',
    takerPhone: isOwner || isTaker ? (task.taker_phone || '') : '',
    // 取件码：与手机号同级保护，仅雇主与接单者可见。
    // 跑腿员凭码取件，若在大厅公开，任何人都能凭码冒领包裹。
    pickupCode: isOwner || isTaker ? (task.pickup_code || '') : '',
    deliverAddress: task.deliver_address,
    // 详细地址：送达地址的补充说明（门牌 / 房间号 / 工位），与送达地址同级，公开可见
    detailAddress: task.detail_address || '',
    timeLimitMin: task.time_limit_min,
    // ---------------- 任务类型与帮带物品 ----------------
    // taskType：发布时选的快捷模板（0其他/1取快递/2食堂带饭/3打印资料/4超市代买）
    // taskTypeText：前端标签直接取用，避免前后端各维护一份字典导致文案不一致
    taskType: Number(task.task_type) || 0,
    taskTypeText: TASK_TYPE[Number(task.task_type) || 0] || TASK_TYPE[TASK_TYPE_ENUM.OTHER],
    // itemName：需要跑腿员帮带的物品（取快递任务为空，取件码在下面 pickupCode）
    itemName: task.item_name || '',
    remark: task.remark || '',
    reward: task.reward,
    serviceFee: task.service_fee,
    // 是否使用「邀请码免费代拿」权益发布（该任务免收 0.1 元信息服务费）
    isFreeDelivery: Number(task.is_free_delivery) === 1,
    // 免费代拿次数是否已返还（撤销时若从未被接单则返还 1 次）
    isFreeDeliveryReturned: Number(task.is_free_delivery_returned) === 1,
    images: [task.img1, task.img2, task.img3].filter(Boolean),
    deliveryImages: Task.getDeliveryImages(task),
    // 物品照片：接单人拿到 / 买到物品的凭证（与送达照片一起构成提交完成的必要材料）
    pickupImages: Task.getPickupImages(task),
    status: task.status,
    takerUserId: task.taker_user_id,
    takeTime: task.take_time,
    // 确认取货 / 确认收货时间：进度条第 2 段与第 4 段的唯一依据
    pickupConfirmTime: task.pickup_confirm_time || null,
    ownerReceiptTime: task.owner_receipt_time || null,
    // 进度条第几段（0=待接单 1=已接单 2=已取货 3=已送达 4=待支付 5=完成）
    // 与列表 / 详情页共用同一个出口，避免两处口径不一致
    progressStep: computeProgressStep(task),
    publishTime: task.publish_time,
    submitFinishTime: task.submit_finish_time,
    lastEditTime: task.last_edit_time,
    isRefunded: task.is_refunded,
    onceTaken: task.once_taken,
    // 未送达申诉：提交后系统不再自动确认收货
    isDisputed: Number(task.is_disputed) === 1,
    disputeReason: task.dispute_reason || '',
    disputeTime: task.dispute_time || null,
    payStatus: task.pay_status === undefined ? null : task.pay_status,
    isOwner,
    isTaker,
    // ---------------- 管理员删除任务 ----------------
    // isDeleted：任务已被管理员删除（前端展示「已从平台下架」提示并隐藏全部按钮）
    // deleteReason：删除原因，仅管理员可见（普通用户只知道任务被删除即可）
    isDeleted: deleted,
    deleteReason: isAdminViewer ? (task.delete_reason || '') : '',
    deleteTime: isAdminViewer ? (task.delete_time || null) : null,
    // 限时倒计时：进行中且设置了限时的任务才有值（null 表示不限时/不在进行中）
    // 前端拿这个秒数本地每秒递减即可，避免手机本地时间与服务端时间不一致
    remainSeconds,
    // 超时送达信息（提交送达时已按截止时间判定并落库）
    isLateDelivery: lateInfo.isLate,
    lateDeliverySeconds: lateInfo.lateSeconds,
    isLateRewardDeducted: lateDeducted,
    lateRewardDeduct: Number(task.late_reward_deduct) || 0,
    // 超时状态（进行中已超时 / 超时送达）与超时自动扣减标记
    isOvertime: overtime.isOvertime,
    overtimeSeconds: overtime.overtimeSeconds,
    timeoutDeducted: lateDeducted,
    lateDeductAmount: Number(task.late_reward_deduct) || 0,
    // 本次可扣减的金额预览（前端弹窗直接展示，保证与后端算出来的完全一致）
    lateDeductPreview: lateInfo.deduct,
    // 前端按钮可用性由后端统一计算，避免前后端规则不一致
    actions: {
      canPay: isOwner && !paid,
      // 可编辑：待接单(0)，或 进行中(1)
      // 注意：接单人确认取货后**仍然可以编辑**（联系电话 / 详细地址 / 备注改了要能同步给跑腿员），
      //      被关闭的只有「撤销任务」入口，两者互不影响。
      canEdit: isOwner && !task.is_refunded && canEditNow
        && (task.status === TASK_STATUS_ENUM.WAIT_TAKE
          || task.status === TASK_STATUS_ENUM.TAKING),
      // 接单后编辑：前端据此把入口切成「编辑任务」，并锁定送达地址 / 限时两个字段
      canEditAfterTake: isOwner && task.status === TASK_STATUS_ENUM.TAKING && canEditNow,
      // 可撤销：待接单(0)，或 进行中(1) 且接单人尚未确认取货；
      // 接单人一旦确认取货（物品照片已锁定为凭证），撤销入口永久关闭
      canCancel: isOwner && !task.is_refunded
        && (task.status === TASK_STATUS_ENUM.WAIT_TAKE
          || (task.status === TASK_STATUS_ENUM.TAKING && !task.pickup_confirm_time)),
      // 退费两步流程：先撤销任务(status=5)，再到「我的发布 - 已撤销」申请退费
      canApplyRefund: isOwner && task.status === TASK_STATUS_ENUM.OWNER_CANCEL
        && checkRefundEligible(task) === '',
      // 已撤销但不可退费时的原因（前端直接展示，避免前后端规则不一致）
      refundDisabledReason: isOwner && task.status === TASK_STATUS_ENUM.OWNER_CANCEL && !task.is_refunded
        ? checkRefundEligible(task) : '',
      canAdjustReward: isOwner && task.status === TASK_STATUS_ENUM.TAKING && canEditNow,
      // 确认收货（第 3 段 → 第 4 段待支付）：雇主确认收到物品，页面提示线下支付酬金
      canReceipt: isOwner && task.status === TASK_STATUS_ENUM.WAIT_CONFIRM
        && !task.owner_receipt_time,
      // 完成任务（第 4 段 → 第 5 段）：必须先确认收货，避免跳过线下支付环节
      canConfirmFinish: isOwner && task.status === TASK_STATUS_ENUM.WAIT_CONFIRM
        && !!task.owner_receipt_time,
      // 结束「已超时」的限时任务：仅雇主、任务仍进行中、且确实已超过限时
      // 确认后任务置为「超时取消」，双方任务列表都不再显示为进行中（不生成收入账单）
      canEndOvertime: isOwner && task.status === TASK_STATUS_ENUM.TAKING && overtime.isOvertime,
      // 未送达申诉：仅雇主、待确认状态、且尚未提交过时可提交
      canRejectFinish: isOwner && task.status === TASK_STATUS_ENUM.WAIT_CONFIRM
        && Number(task.is_disputed) !== 1,
      // 超时送达扣酬金：仅雇主、待确认状态、确实超时送达、且尚未扣减过
      canDeductLateReward: isOwner && task.status === TASK_STATUS_ENUM.WAIT_CONFIRM
        && lateInfo.isLate && !lateDeducted,
      // 举报恶意超时：仅任务雇主、任务有接单人、且确实已经超时（投诉直达管理员后台）
      canReportLateTaker: isOwner && !!task.taker_user_id && overtime.isOvertime,
      // 举报该任务：发布人不能举报自己的任务（雇主视角隐藏入口）；
      // 其余登录用户均可举报，且「同一任务每人半小时最多 3 次」由后端硬校验
      canReport: !isOwner,
      // 雇主举报接单人：任务已被接单，且仍在进行中 / 待确认 / 超时取消
      // （已完成的单请走申诉中心；恶意超时另有独立入口 canReportLateTaker）
      canReportTaker: isOwner && !!task.taker_user_id
        && (task.status === TASK_STATUS_ENUM.TAKING
          || task.status === TASK_STATUS_ENUM.WAIT_CONFIRM
          || task.status === TASK_STATUS_ENUM.TIMEOUT_CANCEL),
      canTake: !isOwner && task.status === TASK_STATUS_ENUM.WAIT_TAKE && certified && !banned && paid,
      // 接单人确认取货后（物品照片已锁定为凭证），不再允许取消接单，避免「拿走了东西再弃单」
      canCancelTake: isTaker && task.status === TASK_STATUS_ENUM.TAKING && !task.pickup_confirm_time
        && diffMinutes(new Date(), task.take_time) <= getCancelTakeMinutes(),
      // 确认取货（第 1 段 → 第 2 段）：接单人上传物品照片并点「确认取货」，
      // 确认后照片与按钮同时锁定（不可再改、不可再撤单）
      canConfirmPickup: isTaker && task.status === TASK_STATUS_ENUM.TAKING && !task.pickup_confirm_time,
      // 送达上传区块是否展示：进行中就一直展示，未确认取货时按钮置灰并给出提示
      showFinishBlock: isTaker && task.status === TASK_STATUS_ENUM.TAKING,
      // 未确认取货时不允许提交送达（后端同样硬校验，前端据此置灰按钮）
      needPickupConfirm: isTaker && task.status === TASK_STATUS_ENUM.TAKING && !task.pickup_confirm_time,
      canSubmitFinish: isTaker && task.status === TASK_STATUS_ENUM.TAKING && !!task.pickup_confirm_time,
      needCampusCert: !isOwner && task.status === TASK_STATUS_ENUM.WAIT_TAKE && !certified,
      // 不能接单时的具体原因（前端直接展示）：
      // 避免出现「按钮点了才报错」或「按钮消失但用户不知道为什么」两种情况
      takeDisabledReason: ''
    }
  };

  // 待接单任务但当前不可接单：把真实原因下发给前端（未认证由 needCampusCert 引导，不重复说明）
  if (!deleted && !isOwner && task.status === TASK_STATUS_ENUM.WAIT_TAKE) {
    if (!paid) {
      vo.actions.takeDisabledReason = '该任务尚未完成支付，暂不可接单';
    } else if (banned) {
      vo.actions.takeDisabledReason = `您正处于禁止接单期，解禁时间：${formatDate(user.ban_take_time, 'MM-DD HH:mm')}`;
    } else if (!certified) {
      vo.actions.takeDisabledReason = MSG.NEED_CAMPUS_CERT;
    }
  }

  // 管理员已删除的任务：全部操作入口一律冻结（后端每个流转接口另有硬校验，
  // 前端这里只是不展示按钮，避免用户点了才报错）
  if (deleted) {
    Object.keys(vo.actions).forEach((key) => {
      vo.actions[key] = false;
    });
    // 该字段是文案而不是布尔开关，被抹成 false 会让前端兜底文案失去上下文
    vo.actions.takeDisabledReason = MSG.TASK_DELETED_NOTICE;
  }
  // 删除任务入口：仅管理员可见；任务已删除时不再重复提供
  vo.actions.canDeleteTask = isAdminViewer && !deleted;

  return vo;
}

/**
 * GET /api/task/list 任务大厅列表（分页、排序、筛选）
 */
/**
 * 解析查询串里的可选金额参数（最低/最高酬金）
 * 说明：前端未填写时会传空字符串，必须归一化成 null；
 *      否则 parseMoney('') 会得到 0，SQL 会变成「酬金 >= 0 AND 酬金 <= 0」把任务全部筛掉。
 * @param {*} value 查询参数原始值
 * @returns {number|null} 合法金额（>=0）或 null（表示该条件不参与筛选）
 */
function parseOptionalMoney(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return parseMoney(value);
}
async function list(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const { keyword, sort, minReward, maxReward } = req.query;
    const { list: rows, total } = await Task.listHall({
      keyword: keyword ? String(keyword) : '',
      sort: sort ? String(sort) : 'time_desc',
      minReward: parseOptionalMoney(minReward),
      maxReward: parseOptionalMoney(maxReward),
      offset,
      limit: pageSize
    });
    const voList = rows.map((item) => toTaskVO(item, req.user));
    return ok(res, buildPage(voList, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/task/:id 任务详情（双视角：雇主 / 接单者）
 */
async function detail(req, res, next) {
  try {
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');

    const task = await Task.findById(taskId);
    if (!task) throw new BizError('任务不存在或已下架', 400);

    // 待支付状态的任务仅雇主本人可见
    if (task.pay_status !== PAY_STATUS_ENUM.SUCCESS && task.user_id !== req.user.id
      && task.status !== TASK_STATUS_ENUM.FINISHED && task.taker_user_id !== req.user.id) {
      throw new BizError('任务不存在或已下架', 400);
    }

    const vo = toTaskVO(task, req.user);
    // 进行中任务的剩余时间（与列表口径完全一致：接单时间 + 限时分钟）
    return ok(res, { task: vo, remainSeconds: vo.remainSeconds });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/take 接单
 * 前置校验：校园认证通过、不在禁止接单期、不能接自己发布的任务
 * 并发控制：事务 + 乐观锁，更新失败返回「任务已被他人接单」
 */
async function take(req, res, next) {
  try {
    const user = req.user;
    ensureCampusCertified(user);
    ensureNotBanned(user);
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);

    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');
    if (!checkIdempotent(`take:${user.id}:${taskId}`, 2000)) throw new BizError(MSG.REPEAT_SUBMIT, 409);

    const result = await db.transaction(async (conn) => {
      // 行锁读取，防止并发下单
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在或已下架', 400);
      assertTaskNotDeleted(task);
      if (task.user_id === user.id) throw new BizError('不能接自己发布的任务', 403);
      if (task.is_refunded) throw new BizError('该任务已退费下架', 409);

      const paid = await Payment.hasPaid(taskId, conn);
      if (!paid) throw new BizError('该任务尚未完成支付，暂不可接单', 409);
      if (task.status !== TASK_STATUS_ENUM.WAIT_TAKE) throw new BizError(MSG.TASK_TAKEN, 409);

      // 乐观锁更新：status=0 才可接单，affectedRows=0 说明已被他人抢先
      const affected = await Task.takeTask(taskId, user.id, conn);
      if (affected === 0) throw new BizError(MSG.TASK_TAKEN, 409);

      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.TASK,
        title: '任务已被接单',
        content: `您的任务（编号${taskId}）已被用户${displayNickname(user.nickname, user.student_id)}接单，请保持电话畅通。`
      }, conn);

      return { taskId, ownerId: task.user_id, orderNo: task.order_no || '' };
    });

    // 订阅消息（尽力而为，失败静默降级，不影响接单结果）：通知发布者「已被接单」
    wxSubscribe.sendOrderProgress({
      userId: result.ownerId,
      status: 'TAKEN',
      orderNo: result.orderNo,
      tip: '跑腿员已接单，请保持电话畅通'
    });

    return ok(res, result, '接单成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/cancelTake 取消接单
 * 规则：接单后 10 分钟内可主动取消，任务回到待接单并清空接单信息；
 *       主动取消不触发 30 分钟禁止接单封禁
 */
async function cancelTake(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.taker_user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.status !== TASK_STATUS_ENUM.TAKING) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);
      // 已确认取货 = 物品照片已锁定为取货凭证，接单人不能再取消接单。
      // 前端只是隐藏按钮，真正的拦截必须在后端：否则任务会带着已锁定的物品照片退回大厅，
      // 下一个接单人既无法重新「确认取货」，又可能拿着上一任的照片冒充取货凭证。
      if (task.pickup_confirm_time) throw new BizError(MSG.CANCEL_TAKE_LOCKED, 409);

      const cancelMinutes = getCancelTakeMinutes();
      if (diffMinutes(new Date(), task.take_time) > cancelMinutes) {
        throw new BizError(`接单已超过${cancelMinutes}分钟，无法取消，请与雇主协商`, 409);
      }

      const affected = await Task.cancelTake(taskId, conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.TASK,
        title: '跑腿员取消了接单',
        content: `您的任务（编号${taskId}）已被跑腿员取消接单，任务已重新上架，等待其他跑腿员接单。`
      }, conn);
    });

    return ok(res, null, '已取消接单，任务重新上架');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/edit 编辑待接单任务
 * 规则：仅 status=0 可编辑全量字段；酬金只能提高或不变；
 *       两次编辑间隔至少 3 分钟；乐观锁校验任务状态
 */
async function edit(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.is_refunded) throw new BizError('该任务已退费，不可编辑', 409);

      // 可编辑的两种情形（与 toTaskVO.actions.canEdit 完全一致）：
      //   1) 待接单(0)：全量字段可改
      //   2) 进行中(1)：只可更正联系信息类字段（确认取货之后同样可以改）
      const waitTake = task.status === TASK_STATUS_ENUM.WAIT_TAKE;
      const takenEditable = task.status === TASK_STATUS_ENUM.TAKING;
      if (!waitTake && !takenEditable) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      const interval = getEditInterval();

      // 接单后「送达地址」与「限时」锁死：跑腿员已按原地址、原限时在路上跑，
      // 中途改动等于让接单人白跑，因此只允许更正联系信息类字段
      if (takenEditable) {
        if (req.body.deliverAddress !== undefined
          && String(req.body.deliverAddress).trim() !== String(task.deliver_address || '').trim()) {
          throw new BizError(MSG.TAKEN_FIELD_LOCKED, 409);
        }
        if (req.body.timeLimitMin !== undefined
          && Number(req.body.timeLimitMin) !== Number(task.time_limit_min)) {
          throw new BizError(MSG.TAKEN_FIELD_LOCKED, 409);
        }
      }

      // 未提交的字段沿用原值，提交的字段覆盖
      const merged = {
        receiverName: req.body.receiverName === undefined ? task.receiver_name : req.body.receiverName,
        receiverPhone: req.body.receiverPhone === undefined ? task.receiver_phone : req.body.receiverPhone,
        pickupCode: req.body.pickupCode === undefined ? task.pickup_code : req.body.pickupCode,
        taskType: req.body.taskType === undefined ? task.task_type : req.body.taskType,
        itemName: req.body.itemName === undefined ? task.item_name : req.body.itemName,
        deliverAddress: req.body.deliverAddress === undefined ? task.deliver_address : req.body.deliverAddress,
        detailAddress: req.body.detailAddress === undefined ? task.detail_address : req.body.detailAddress,
        timeLimitMin: req.body.timeLimitMin === undefined ? task.time_limit_min : req.body.timeLimitMin,
        remark: req.body.remark === undefined ? task.remark : req.body.remark,
        reward: req.body.reward === undefined ? task.reward : req.body.reward,
        img1: req.body.img1 === undefined ? task.img1 : req.body.img1,
        img2: req.body.img2 === undefined ? task.img2 : req.body.img2,
        img3: req.body.img3 === undefined ? task.img3 : req.body.img3
      };
      const fields = await normalizeTaskForm(merged, user);

      // 待接单任务酬金仅可提高或保持不变，禁止降低
      if (fields.reward < Number(task.reward)) throw new BizError(MSG.REWARD_NO_DOWN, 400);

      // 幂等：同一用户对同一任务提交「完全相同的内容」在 2 秒内重复触发视为连点
      if (!checkIdempotent(`edit:${user.id}:${taskId}:${hashParams(fields)}`, 2000)) {
        throw new BizError(MSG.REPEAT_SUBMIT, 409);
      }

      // 频率限制放在业务校验之后：先告诉用户「酬金不能降」，再谈操作过于频繁，提示更准确
      if (task.last_edit_time && diffMinutes(new Date(), task.last_edit_time) < interval) {
        throw new BizError(`${MSG.EDIT_TOO_FREQ}（间隔${interval}分钟）`, 409);
      }

      // 乐观锁条件随编辑场景切换：待接单改「status=0」，接单后改「status=1」
      const affected = await Task.updateByOwner(
        taskId,
        fields,
        conn,
        takenEditable ? [TASK_STATUS_ENUM.TAKING] : [TASK_STATUS_ENUM.WAIT_TAKE]
      );
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 接单后编辑：必须通知接单人，否则跑腿员照着旧取件码 / 旧电话白跑一趟
      if (takenEditable && task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '雇主修改了任务信息',
          content: `您接取的任务（编号${task.order_no || taskId}）雇主修改了任务信息，`
            + '请打开任务详情核对最新的取件码 / 收件人电话 / 备注后再继续配送。'
        }, conn);
      }
    });

    return ok(res, null, '修改成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/adjustReward 进行中任务单独调整酬金
 * 规则：仅 status=1 且酬金必须严格大于原酬金；两次调整间隔至少 3 分钟；
 *       调整成功后推送站内消息通知接单者
 */
async function adjustReward(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [
      { name: 'taskId', label: '任务ID' },
      { name: 'reward', label: '新酬金' }
    ]);
    const taskId = Number(req.body.taskId);
    const newReward = parseMoney(req.body.reward);
    if (newReward === null || newReward <= 0 || newReward > 999.99) throw new BizError('酬金需为0.01-999.99元');

    await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.status !== TASK_STATUS_ENUM.TAKING) {
        throw new BizError('仅进行中的任务可单独调整酬金', 409);
      }

      const interval = getEditInterval();
      if (newReward <= Number(task.reward)) throw new BizError(MSG.REWARD_MUST_UP, 400);
      if (task.last_edit_time && diffMinutes(new Date(), task.last_edit_time) < interval) {
        throw new BizError(`${MSG.EDIT_TOO_FREQ}（间隔${interval}分钟）`, 409);
      }

      const affected = await Task.adjustReward(taskId, newReward, conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 通知接单者酬金已提高
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.OWNER,
          title: '雇主提高了酬金',
          content: `任务（编号${taskId}）的酬金已由${Number(task.reward).toFixed(2)}元提高到${newReward.toFixed(2)}元，请尽快完成配送。`
        }, conn);
      }
    });

    return ok(res, null, '酬金调整成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * 规范化照片数组（统一去掉空白项、只保留有效地址）
 * @param {Array} images 原始数组
 * @returns {string[]} 有效图片地址
 */
function normalizeImages(images) {
  return (Array.isArray(images) ? images : [])
    .map((item) => (item ? String(item).trim() : ''))
    .filter(Boolean);
}

/**
 * 规范化送达照片（支持数组或 img1/img2/img3 两种入参形式）
 */
function normalizeDeliveryImages(body) {
  let images = [];
  if (Array.isArray(body.deliveryImages)) {
    images = body.deliveryImages;
  } else {
    images = [body.deliveryImg1, body.deliveryImg2, body.deliveryImg3];
  }
  return normalizeImages(images);
}

/**
 * 规范化「物品照片」（接单人拿到 / 买到物品的凭证）
 * 支持数组或 pickupImg1/2/3 两种入参形式
 */
function normalizePickupImages(body) {
  let images = [];
  if (Array.isArray(body.pickupImages)) {
    images = body.pickupImages;
  } else {
    images = [body.pickupImg1, body.pickupImg2, body.pickupImg3];
  }
  return normalizeImages(images);
}

/**
 * POST /api/task/submitFinish 跑腿员提交任务完成（进度第 2 段 → 第 3 段已送达）
 * ---------------------------------------------------------------------
 * 前置条件：必须先调用 /api/task/confirmPickup 完成「确认取货」。
 *   物品照片在确认取货时已落库并锁定，本接口不再接收前端上传的物品照片，
 *   只接收送达照片 —— 否则接单人可以在送达环节把物品凭证掉包成别的照片。
 * 照片要求：送达照片 1~3 张，缺少直接驳回（前端按钮同样置灰，避免点下去才报错）。
 */
async function submitFinish(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    // 物品照片已在「确认取货」时落库并锁定，这里不再接收前端上传的物品照片，
    // 只收送达照片（否则可以在送达环节把物品凭证掉包成别的照片）
    const deliveryImages = normalizeDeliveryImages(req.body);
    if (deliveryImages.length === 0) throw new BizError(MSG.NEED_DELIVERY_IMG, 400);
    if (deliveryImages.length > BIZ.MAX_DELIVERY_IMG) throw new BizError(`送达照片最多${BIZ.MAX_DELIVERY_IMG}张`, 400);

    // 落库的物品照片快照（事务内赋值，用于响应回显）
    let pickupImages = [];
    // 订阅消息所需的任务快照（事务内赋值，事务提交后使用）
    let notifyInfo = null;

    if (!checkIdempotent(`submitFinish:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.taker_user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.status === TASK_STATUS_ENUM.WAIT_CONFIRM) throw new BizError('任务已提交，请等待雇主确认', 409);
      if (task.status !== TASK_STATUS_ENUM.TAKING) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 超时送达判定：提交时间（NOW）晚于「接单时间 + 限时分钟」即为超时送达
      const lateSeconds = task.time_limit_min && task.take_time
        ? Math.floor((Date.now() - (new Date(task.take_time).getTime() + Number(task.time_limit_min) * 60 * 1000)) / 1000)
        : 0;
      const isLate = lateSeconds > 0;

      // 必须先「确认取货」（物品照片落库并锁定），否则等于跳过取货环节直接送达
      if (!task.pickup_confirm_time) throw new BizError(MSG.PICKUP_CONFIRM_FIRST, 409);
      pickupImages = Task.getPickupImages(task);
      if (pickupImages.length === 0) throw new BizError(MSG.PICKUP_PHOTO_NEEDED, 409);

      const affected = await Task.submitFinish(taskId, pickupImages, deliveryImages, isLate, Math.max(0, lateSeconds), conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 超时送达：告知雇主可在确认前按规则扣减酬金（扣减比例与下限统一由 calcLateDeduct 计算）
      const deduct = isLate ? calcLateDeduct(task.reward) : null;
      const lateTip = isLate
        ? `该任务已超时送达${formatLateText(lateSeconds)}，您可先「按超时扣减酬金」（扣 ¥${deduct.deduct.toFixed(2)}，扣后 ¥${deduct.remain.toFixed(2)}）再确认送达。`
        : '';
      notifyInfo = { ownerId: task.user_id, orderNo: task.order_no || '', late: isLate };

      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.TASK,
        title: isLate ? '跑腿员超时送达' : '跑腿员已送达',
        content: `您的任务（编号${taskId}）跑腿员已提交送达照片，请在2小时内确认，超时将自动确认完成。${lateTip}`
      }, conn);
    });

    // 订阅消息：通知发布者「跑腿员已送达」（限时单超时送达时文案同步变化）
    if (notifyInfo) {
      wxSubscribe.sendOrderProgress({
        userId: notifyInfo.ownerId,
        status: 'DELIVERED',
        orderNo: notifyInfo.orderNo,
        tip: notifyInfo.late ? '已超时送达，请尽快确认' : '跑腿员已送达，请尽快确认'
      });
    }

    return ok(res, { pickupImages, deliveryImages }, '提交成功，等待雇主确认');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/confirmPickup 接单人「确认取货」（进度第 1 段 → 第 2 段已取货）
 * ---------------------------------------------------------------------
 * 业务链路：
 *   1. 接单人上传物品照片（1~3 张，证明自己已经拿到 / 买到东西）；
 *   2. 点击「确认取货」并经过前端 3 秒确认提示；
 *   3. 本接口把照片写入 pickup_img1~3 并落 pickup_confirm_time，照片与按钮同时锁定。
 * 锁定后的连锁效果（均为后端硬校验）：
 *   · 物品照片不可再改：submitFinish 只认库里这份快照；
 *   · 接单人不能再「取消接单」；
 *   · 雇主不能再「撤销任务」，只能走举报或联系管理员。
 * 幂等：乐观锁 WHERE pickup_confirm_time IS NULL，重复提交返回 0 行。
 */
async function confirmPickup(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError(MSG.PARAM_ERROR, 400);

    const pickupImages = normalizePickupImages(req.body);
    if (pickupImages.length === 0) throw new BizError(MSG.PICKUP_PHOTO_NEEDED, 400);
    if (pickupImages.length > BIZ.MAX_DELIVERY_IMG) {
      throw new BizError(`物品照片最多${BIZ.MAX_DELIVERY_IMG}张`, 400);
    }

    // 防连点：同一接单人对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`confirmPickup:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      assertTaskNotDeleted(task);
      if (task.taker_user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.pickup_confirm_time) throw new BizError(MSG.PICKUP_ALREADY_CONFIRMED, 409);
      if (task.status !== TASK_STATUS_ENUM.TAKING) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      const affected = await Task.confirmPickup(taskId, pickupImages, conn);
      if (affected === 0) throw new BizError(MSG.PICKUP_ALREADY_CONFIRMED, 409);

      // 通知雇主：跑腿员已取到货，进度推进到「已取货」
      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.TASK,
        title: '跑腿员已取货',
        content: `您的任务（编号${task.order_no || taskId}）跑腿员已确认取到物品并上传了物品照片，正在送往目的地。`
      }, conn);

      return { taskId, pickupImages, ownerId: task.user_id, orderNo: task.order_no || '' };
    });

    // 订阅消息：通知发布者「跑腿员已取货」
    wxSubscribe.sendOrderProgress({
      userId: result.ownerId,
      status: 'PICKED',
      orderNo: result.orderNo,
      tip: '跑腿员已取到物品，正在配送中'
    });

    return ok(res, result, '已确认取货，物品照片已锁定');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/endOvertime 雇主结束「已超时」的限时任务
 * ---------------------------------------------------------------------
 * 业务规则：
 *  1. 仅任务雇主本人可操作，且任务未被管理员删除
 *  2. 任务必须是「进行中」(status=1)，并且已经超过限时
 *     （限时截止 = 接单时间 + time_limit_min，不限时任务永远不满足）
 *  3. 结束后任务置为「超时取消」(status=4)：雇主与接单者双方的任务列表
 *     都不再显示为进行中，本单流程正式结束
 *  4. 不生成任务收入账单：跑腿员并没有送达，平台不凭空记账
 *     （超时扣减的 5% 酬金此前已由定时任务落库，与本次结束互不影响）
 *  5. 幂等：checkIdempotent 防连点 + 乐观锁 WHERE status=1，重复提交返回 0 行
 *  6. 结束后给雇主与接单者各推送一条站内消息
 */
async function endOvertime(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError(MSG.PARAM_ERROR, 400);

    // 防连点：同一用户对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`endOvertime:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      if (task.user_id !== user.id) throw new BizError(MSG.NOT_OWN_TASK, 403);
      assertTaskNotDeleted(task);
      if (task.status !== TASK_STATUS_ENUM.TAKING) throw new BizError(MSG.NOT_TASK_TAKING, 409);

      // 超时判定与详情页展示口径完全一致（同一个 computeOvertimeInfo）
      const overtime = computeOvertimeInfo(task);
      if (!overtime.isOvertime) throw new BizError(MSG.NOT_TIMEOUT_TASK, 409);

      const affected = await Task.ownerEndOvertime(taskId, conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      const noText = task.order_no || String(taskId);

      // 通知雇主本人：留一条记录，便于日后在消息中心回溯
      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.TASK,
        title: '任务已结束',
        content: `您已结束任务（编号${noText}）：该任务超过限时仍未送达，已按「超时取消」处理，`
          + '不会生成跑腿收入账单。如与跑腿员存在纠纷，可在申诉中心提交申诉。'
      }, conn);

      // 通知跑腿员：明确告知任务已被结束，避免对方还在继续送
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '任务已被雇主结束',
          content: `您接取的任务（编号${noText}）超过限时仍未送达，已被雇主结束，本单不计入跑腿收入。`
            + '请后续留意限时要求，按时送达并通过「物品照片 + 送达照片」提交完成。'
        }, conn);
      }
    });

    return ok(res, { taskId }, '任务已结束');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/confirmFinish 雇主「完成任务」（进度第 4 段待支付 → 第 5 段完成）
 * ---------------------------------------------------------------------
 * 两步确认的第二步：必须先「确认收货」（见 receiptFinish），
 * 页面在线下转账支付酬金后再点本按钮，避免雇主跳过支付环节直接关单。
 * 确认后任务变为已完成，并为接单者生成一条「任务收入」账单。
 * 幂等：条件更新 WHERE status=2 AND owner_receipt_time IS NOT NULL，重复确认不会重复记账。
 */
async function confirmFinish(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      assertTaskNotDeleted(task);

      // 已完成：幂等返回，不重复记账
      if (task.status === TASK_STATUS_ENUM.FINISHED) {
        return { repeated: true, taskId };
      }
      if (task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);
      // 两步确认：没确认收货就不允许「完成任务」，前端同样只展示一个按钮
      if (!task.owner_receipt_time) throw new BizError(MSG.OWNER_RECEIPT_FIRST, 409);

      const affected = await Task.confirmFinish(taskId, conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 自动记账：为接单者生成「任务收入」流水（幂等校验，避免重复生成）
      if (task.taker_user_id) {
        const billExists = await Bill.exists(taskId, task.taker_user_id, BILL_TYPE_ENUM.TASK_INCOME, conn);
        if (!billExists) {
          await Bill.create({
            userId: task.taker_user_id,
            taskId,
            type: BILL_TYPE_ENUM.TASK_INCOME,
            amount: task.reward,
            remark: '跑腿任务收入（线下转账结算）'
          }, conn);
        }
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '任务已完成',
          content: `任务（编号${taskId}）雇主已确认送达，酬金${Number(task.reward).toFixed(2)}元已记入您的账单，请与雇主线下结算。`
        }, conn);
      }

      return { repeated: false, taskId, takerId: task.taker_user_id, orderNo: task.order_no || '' };
    });

    // 订阅消息：通知接单者「任务已完成」（重复确认时不再重复推送）
    if (!result.repeated && result.takerId) {
      wxSubscribe.sendOrderProgress({
        userId: result.takerId,
        status: 'FINISHED',
        orderNo: result.orderNo,
        page: 'pages/myTake/myTake',
        tip: '任务已完成，酬金已计入账单'
      });
    }

    return ok(res, result, '确认成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/receiptFinish 雇主「确认收货」（进度第 3 段已送达 → 第 4 段待支付）
 * ---------------------------------------------------------------------
 * 业务链路（与前端进度条一一对应）：
 *   1. 接单人提交送达照片 -> 进度 3「已送达」，任务进入待雇主确认；
 *   2. 雇主核对送达照片无误，点「确认收货」-> 进度 4「待支付」，
 *      页面提示「请与跑腿员线下转账结算酬金」；
 *   3. 雇主支付完成后再点「完成任务」-> 进度 5「完成」并生成跑腿收入账单。
 * 为什么拆成两步：酬金是线下转账，平台无法代扣，
 * 一次性「确认送达」会让雇主在没付钱的情况下把单关掉，跑腿员拿不到钱。
 * 幂等：乐观锁 WHERE status=2 AND owner_receipt_time IS NULL，重复点击返回 0 行。
 */
async function receiptFinish(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError(MSG.PARAM_ERROR, 400);

    // 防连点：同一雇主对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`receiptFinish:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);
      if (task.owner_receipt_time) throw new BizError(MSG.OWNER_RECEIPT_DONE, 409);

      const affected = await Task.markOwnerReceipt(taskId, conn);
      if (affected === 0) throw new BizError(MSG.OWNER_RECEIPT_DONE, 409);

      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '已确认收货，请线下结算',
        content: `任务（编号${task.order_no || taskId}）已确认收货，请与跑腿员线下转账结算酬金（金额以任务详情页显示为准），结算完成后回到任务详情点「完成任务」即可关单。`
      }, conn);

      // 通知接单人：可以去找雇主要钱了（进度已推进到待支付）
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.OWNER,
          title: '雇主已确认收货，请结算酬金',
          content: `任务（编号${task.order_no || taskId}）雇主已确认收货，请与雇主线下结算酬金。`
        }, conn);
      }

      return { taskId };
    });

    return ok(res, result, MSG.OWNER_RECEIPT_DONE);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/deductLateReward 雇主对「超时送达」任务扣减酬金
 * ---------------------------------------------------------------------
 * 业务规则：
 *  1. 仅任务雇主本人可操作，且任务必须处于「待雇主确认」(status=2)
 *  2. 必须是「超时送达」的任务（提交送达时间晚于「接单时间 + 限时分钟」）
 *  3. 扣减金额 = 酬金 × 5%，不足 0.5 元按 0.5 元计算（calcLateDeduct 是唯一计算出口）
 *  4. 一次性：is_late_reward_deducted 置 1 后不可再次扣减（乐观锁 + 幂等）
 *  5. 扣减只改 tasks.reward：雇主确认送达与「超时 2 小时自动确认」都读取 tasks.reward，
 *     因此接单者的「任务收入」账单会自动按扣减后的金额记账，无需额外改动
 *  6. 扣减成功后推送站内消息通知跑腿员
 */
async function deductLateReward(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');

    // 防连点：同一用户对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`deductLateReward:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM) throw new BizError(MSG.NOT_WAIT_CONFIRM, 409);
      if (Number(task.is_late_reward_deducted) === 1) throw new BizError(MSG.LATE_DEDUCT_DONE, 409);

      const lateInfo = getLateDeliveryInfo(task);
      if (!lateInfo.isLate) throw new BizError(MSG.NOT_LATE_DELIVERY, 409);

      const { deduct, remain, rate } = lateInfo.deduct;
      // 乐观锁：WHERE status=2 AND is_late_delivery=1 AND is_late_reward_deducted=0
      const affected = await Task.deductLateReward(taskId, remain, deduct, conn);
      if (affected === 0) throw new BizError(MSG.LATE_DEDUCT_DONE, 409);

      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '超时送达已扣减酬金',
          content: `任务（编号${taskId}）超过限时${formatLateText(lateInfo.lateSeconds)}才送达，雇主按规则扣减酬金 ¥${deduct.toFixed(2)}`
            + `（酬金的 ${Math.round(rate * 100)}%，不足 ¥${Number(BIZ.LATE_DEDUCT_MIN).toFixed(2)} 按 ¥${Number(BIZ.LATE_DEDUCT_MIN).toFixed(2)} 计算），`
            + `扣减后酬金 ¥${remain.toFixed(2)}，请与雇主线下结算。`
        }, conn);
      }

      return { taskId, deduct, reward: remain, lateSeconds: lateInfo.lateSeconds, rate };
    });

    return ok(res, result, `已按超时送达扣减酬金 ¥${Number(result.deduct).toFixed(2)}`);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/rejectFinish 雇主提交「未送达」申诉
 * ---------------------------------------------------------------------
 * 业务场景：跑腿员提交送达后，雇主核对发现「不是我的商品 / 商品破损 / 送至错误位置 / 其他」等问题。
 * 业务规则：
 *  1. 仅任务雇主本人可提交，且任务必须处于「待雇主确认」（status=2）
 *  2. 必须勾选至少 1 个标签；勾选「其他」时必须自行填写问题原因
 *  3. 提交成功后 tasks.is_disputed=1，该任务**不再参与**「超过2小时自动确认完成」的定时判定，
 *     即提交申诉后倒计时自动收货失效，必须由雇主手动确认送达或管理员介入处理
 *  4. 同步生成一条举报记录（管理员后台「举报处理」可跟进）并给跑腿员推送站内消息
 * 幂等：条件更新 WHERE status=2 AND is_disputed=0，重复提交直接返回 409
 */
async function rejectFinish(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [
      { name: 'taskId', label: '任务ID' },
      { name: 'tags', label: '未送达原因' }
    ]);

    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');

    // 标签校验：只接受字典内的合法标签，去重后按字典顺序拼接中文文案
    const rawTags = Array.isArray(req.body.tags) ? req.body.tags : [req.body.tags];
    const tagKeys = Array.from(new Set(rawTags.map((value) => Number(value))))
      .filter((key) => Object.prototype.hasOwnProperty.call(UNDELIVERED_TAG, key))
      .sort((a, b) => a - b);
    if (!tagKeys.length) throw new BizError('请至少选择一项未送达原因');

    // 「其他」必须填写问题原因（前端选择其他后会显示聊天窗让用户自行输入）
    const otherText = String(req.body.otherText || '').trim().slice(0, 200);
    if (tagKeys.includes(UNDELIVERED_TAG_OTHER) && otherText.length < 2) {
      throw new BizError('选择「其他」时请填写问题原因（不少于2个字）');
    }
    // 内容安全：问题说明是自由文本，填了就要过检（留空时 checkText 直接放行）
    const otherSec = await wxSecCheck.checkText(otherText, user);
    if (!otherSec.pass) throw new BizError(otherSec.reason);

    // 防连点：同一用户对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`rejectFinish:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const tagText = tagKeys.map((key) => UNDELIVERED_TAG[key]).join('、');
    const reason = otherText ? `${tagText}；问题说明：${otherText}` : tagText;

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (Number(task.is_disputed) === 1) throw new BizError(MSG.ALREADY_DISPUTED, 409);
      if (task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM) throw new BizError(MSG.NOT_WAIT_CONFIRM, 409);

      // 乐观锁更新：写入申诉原因、申诉时间，并把 is_disputed 置 1（关闭自动确认）
      const affected = await Task.markDisputed(taskId, reason, conn);
      if (affected === 0) throw new BizError(MSG.ALREADY_DISPUTED, 409);

      // 生成举报记录，管理员可在「管理员后台 - 举报处理」中查看并回复处理结果
      await Report.create({
        userId: user.id,
        taskId,
        reportReason: `【雇主未送达申诉】${reason}`.slice(0, 200)
      }, conn);

      // 站内消息：通知跑腿员尽快与雇主联系核实
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.OWNER,
          title: '雇主反馈未送达',
          content: `任务（编号${taskId}）雇主反馈未正常收到：${reason}。请尽快与雇主联系核实，该任务已停止自动确认收货。`
        }, conn);
      }
      // 站内消息：给雇主回执，说明不再倒计时自动收货
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '未送达申诉已提交',
        content: `任务（编号${taskId}）未送达申诉已提交，系统已停止自动确认收货；问题解决后可回到任务详情手动「确认送达」，管理员也会介入核实。`
      }, conn);

      return { taskId, reason, autoConfirmBlocked: true };
    });

    return ok(res, result, '未送达申诉已提交，系统不会自动确认收货');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/reportLateTaker 雇主举报接单人「恶意超时」
 * ---------------------------------------------------------------------
 * 业务背景（与需求一致）：
 *   限时任务超时后**不再自动取消任务、也不再由系统自动封禁接单人**，
 *   只自动扣减 5% 酬金（不足 0.5 元按 0.5 元），跑腿员可以继续送达；
 *   为了约束长期恶意超时，雇主可以提交「恶意超时投诉」，投诉记录直接进入管理员后台，
 *   同时给全部管理员账号推送站内消息（投诉直达管理员），由管理员决定是否封禁接单人。
 * 校验（全部为强制校验）：
 *   1. 仅任务雇主本人可提交（越权校验）
 *   2. 任务必须已有接单人
 *   3. 任务必须确实已经超时：进行中已超时，或已超时送达（待雇主确认）
 *   4. 同一雇主对同一任务只允许存在 1 条待处理投诉（防重复刷投诉）
 * 记录：report.report_type = 2（恶意超时投诉），管理员后台「举报管理」按类型区分展示
 */
async function reportLateTaker(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');

    // 雇主可补充说明（可空），统一截断到 150 字，避免超出 report_reason 长度上限
    const extra = String(req.body.reason || '').trim().slice(0, 150);
    // 内容安全：补充说明是自由文本，填了就要过检（留空时 checkText 直接放行）
    const extraSec = await wxSecCheck.checkText(extra, user);
    if (!extraSec.pass) throw new BizError(extraSec.reason);

    // 防连点：同一雇主对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`reportLateTaker:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (!task.taker_user_id) throw new BizError('该任务暂无接单人，无法投诉', 409);

      // 超时判定：进行中要求「当前时间 > 接单时间 + 限时分钟」；待确认要求提交送达时已超时
      const overtime = computeOvertimeInfo(task);
      if (task.status !== TASK_STATUS_ENUM.TAKING && task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM) {
        throw new BizError(MSG.NOT_TASK_TAKING, 409);
      }
      if (!overtime.isOvertime) throw new BizError(MSG.NOT_TIMEOUT_YET, 409);

      // 同一雇主 + 同一任务 + 同一类型只允许 1 条待处理投诉
      const pending = await Report.findPendingByUserAndTask(
        user.id, taskId, REPORT_TYPE_ENUM.LATE_TAKEOVER, conn
      );
      if (pending) throw new BizError('您已提交过该任务的恶意超时投诉，管理员正在处理中', 409);

      const reason = `【恶意超时投诉】已超时${formatLateText(overtime.overtimeSeconds)}`
        + (extra ? `；补充说明：${extra}` : '');

      // 举报快照：订单号 + 雇主 / 接单人双方的 账号ID、学号、手机号 一并落库。
      // 注意：上面为了并发安全是用 SELECT ... FOR UPDATE 锁的行（只含 tasks 本表字段），
      //      这里再取一次联表结果，才能拿到双方的账号 / 学号 / 手机号做快照。
      const taskView = await Task.findById(taskId, conn);
      const reportId = await Report.create({
        userId: user.id,
        taskId,
        reportReason: reason.slice(0, 200),
        reportType: REPORT_TYPE_ENUM.LATE_TAKEOVER,
        ...Report.buildTaskSnapshot(taskView)
      }, conn);

      // 投诉直达管理员：给全部管理员账号（后端硬编码学号白名单）推送站内消息
      const admins = await User.findAdminUsers(conn);
      for (const admin of admins) {
        /* eslint-disable no-await-in-loop */
        await Message.create({
          userId: admin.id,
          msgType: MSG_TYPE_ENUM.ADMIN,
          title: '恶意超时投诉待处理',
          content: `订单${taskView.order_no || taskId}（任务编号${taskId}）被雇主投诉接单人恶意超时${formatLateText(overtime.overtimeSeconds)}，`
            + `接单人账号 ${formatUserId(task.taker_user_id, taskView.taker_account_no || '')}`
            + `（学号${taskView.taker_student_id || '未填'}，手机号${taskView.taker_phone || '未填'}）。`
            + '请到「管理员后台 - 举报管理」查看，确认恶意后可在「封禁管理」中封禁该用户。'
        }, conn);
      }

      // 通知接单人：已被投诉，请尽快说明或尽快送达
      await Message.create({
        userId: task.taker_user_id,
        msgType: MSG_TYPE_ENUM.OWNER,
        title: '雇主已投诉恶意超时',
        content: `任务（订单号${taskView.order_no || taskId}）雇主已就超时提交「恶意超时投诉」，管理员会介入核实。`
          + '若您仍在配送，请尽快完成并上传送达照片，避免被管理员封禁接单权限。'
      }, conn);

      // 给雇主回执
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '恶意超时投诉已提交',
        content: `您对任务（订单号${taskView.order_no || taskId}）接单人的恶意超时投诉已提交，已直达管理员账号，管理员核实后会决定是否封禁该用户。`
      }, conn);

      return { reportId, lateSeconds: overtime.overtimeSeconds, adminCount: admins.length };
    });

    return ok(res, result, '恶意超时投诉已提交，将直达管理员处理');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/reportTaker 雇主举报接单人（服务质量类，report_type = 3）
 * ---------------------------------------------------------------------
 * 与「恶意超时投诉」(report_type = 2) 的区别：
 *   · 本接口面向服务质量：物品损坏 / 态度恶劣 / 私自加价 / 虚假送达 / 擅自取消 / 其他；
 *   · 可举报的任务状态更宽：进行中(1) / 待确认(2) / 超时取消(4) 都可举报；
 *   · 两者互不冲突，恶意超时仍有独立入口（超时未到也可能已经出现上述问题）。
 * 校验（全部为强制校验）：
 *   1. 仅任务雇主本人可提交（越权校验）；
 *   2. 任务必须已有接单人；
 *   3. 举报标签必须来自后端白名单，且至少选 1 个；
 *   4. 勾选「其他」时必须填写补充说明（不少于 5 个字）；
 *   5. 同一雇主对同一任务只允许存在 1 条待处理举报（防刷）。
 * 记录：report.report_type = 3，管理员后台「举报管理」按类型区分展示，
 *       同时给全部管理员账号推送站内消息（举报直达管理员）。
 */
async function reportTaker(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError(MSG.PARAM_ERROR, 400);

    // 举报标签：只认后端白名单编号，前端传中文文案同样会被拦下
    const rawTags = Array.isArray(req.body.tags) ? req.body.tags : [];
    const tags = [];
    for (const item of rawTags) {
      const tagId = Number(item);
      if (!REPORT_TAKER_TAG[tagId]) throw new BizError(MSG.REPORT_TAKER_TAG_NEEDED, 400);
      if (!tags.includes(tagId)) tags.push(tagId);
    }
    if (tags.length === 0) throw new BizError(MSG.REPORT_TAKER_TAG_NEEDED, 400);

    // 勾选「其他」必须补充说明（少于 5 个字对管理员毫无参考价值）
    const extra = String(req.body.reason || '').trim().slice(0, 150);
    // 内容安全：补充说明是自由文本，填了就要过检（留空时 checkText 直接放行）
    const extraSec = await wxSecCheck.checkText(extra, user);
    if (!extraSec.pass) throw new BizError(extraSec.reason);
    if (tags.includes(REPORT_TAKER_TAG_OTHER) && extra.length < 5) {
      throw new BizError(MSG.REPORT_TAKER_REASON_SHORT, 400);
    }

    // 防连点：同一雇主对同一任务 3 秒内只允许提交一次
    if (!checkIdempotent(`reportTaker:${user.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      if (!task.taker_user_id) throw new BizError(MSG.REPORT_TAKER_NO_TAKER, 409);
      if (task.status !== TASK_STATUS_ENUM.TAKING
        && task.status !== TASK_STATUS_ENUM.WAIT_CONFIRM
        && task.status !== TASK_STATUS_ENUM.TIMEOUT_CANCEL) {
        throw new BizError(MSG.REPORT_TAKER_STATUS, 409);
      }

      // 同一雇主 + 同一任务 + 同一类型只允许 1 条待处理举报
      const pending = await Report.findPendingByUserAndTask(
        user.id, taskId, REPORT_TYPE_ENUM.OWNER_REPORT_TAKER, conn
      );
      if (pending) throw new BizError('您已提交过该接单人的举报，管理员正在处理中', 409);

      const tagText = tags.map((id) => REPORT_TAKER_TAG[id]).join('、');
      const reason = `【举报接单人】${tagText}` + (extra ? `；补充说明：${extra}` : '');

      // 举报快照：订单号 + 双方账号 / 学号 / 手机号一并落库，便于管理员核实
      // （上面锁行读到的是 tasks 本表字段，这里再取一次联表结果补齐人员信息）
      const taskView = await Task.findById(taskId, conn);
      const reportId = await Report.create({
        userId: user.id,
        taskId,
        reportReason: reason.slice(0, 200),
        reportType: REPORT_TYPE_ENUM.OWNER_REPORT_TAKER,
        ...Report.buildTaskSnapshot(taskView)
      }, conn);

      // 举报直达管理员：给全部管理员账号（后端硬编码学号白名单）推送站内消息
      const admins = await User.findAdminUsers(conn);
      for (const admin of admins) {
        /* eslint-disable no-await-in-loop */
        await Message.create({
          userId: admin.id,
          msgType: MSG_TYPE_ENUM.ADMIN,
          title: '雇主举报接单人待处理',
          content: `订单${taskView.order_no || taskId}（任务编号${taskId}）雇主举报接单人：${tagText}`
            + `。被举报人账号 ${formatUserId(task.taker_user_id, taskView.taker_account_no || '')}`
            + `（学号${taskView.taker_student_id || '未填'}，手机号${taskView.taker_phone || '未填'}）。`
            + '请到「管理员后台 - 举报管理」查看并核实。'
        }, conn);
      }

      // 通知接单人：已被举报，请尽快说明情况
      await Message.create({
        userId: task.taker_user_id,
        msgType: MSG_TYPE_ENUM.OWNER,
        title: '雇主已举报您',
        content: `任务（订单号${taskView.order_no || taskId}）雇主提交了对您的举报（${tagText}），`
          + '管理员会介入核实。如有异议请尽快与雇主沟通说明。'
      }, conn);

      // 给雇主回执
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '举报已提交',
        content: `您对该任务接单人的举报（${tagText}）已提交，已直达管理员账号，管理员核实后会作出处理。`
      }, conn);

      return { reportId, tags, adminCount: admins.length };
    });

    return ok(res, result, '举报已提交，将直达管理员处理');
  } catch (err) {
    return next(err);
  }
}

/**
 * 判断任务是否满足服务费退费条件（不查库，仅依据任务行判断）
 * 退费条件：从未被接单（once_taken=0）+ 发布未超过 24 小时 + 未退费
 * @param {object} task 任务行
 * @returns {string} 空字符串表示可以退费；非空字符串为不可退费的原因
 */
function checkRefundEligible(task) {
  // 先过两条底线（已退费 / 未实际付费），再叠加雇主自助退费的额外限制
  const baseline = checkRefundBaseline(task);
  if (baseline) return baseline;
  if (Number(task.once_taken) === 1) return '任务曾被接单，不满足退费条件';
  if (diffHours(new Date(), task.publish_time) >= BIZ.REFUND_LIMIT_HOURS) {
    return `发布已超过${BIZ.REFUND_LIMIT_HOURS}小时，不满足退费条件`;
  }
  return '';
}

/**
 * 退费「底线」校验（管理员强制退费路径使用）
 * ---------------------------------------------------------------------
 * 只保留两条不可逾越的底线：
 *   1. 已退费的任务不重复退（防止重复打款）；
 *   2. 未实际支付服务费的任务（用免费代拿权益发布，service_fee = 0）无需退。
 * 不再限制「24 小时」与「once_taken（曾被接单）」：
 *   管理员删除任务属于平台强制下架，雇主并没有享受到平台的服务，
 *   因此服务费照退；这两条限制只用于约束雇主自助退费（防止「先白用一次再全额退费」）。
 * @param {object} task 任务行
 * @returns {string} 空字符串表示可以退费；非空字符串为不可退费的原因
 */
function checkRefundBaseline(task) {
  if (Number(task.is_refunded) === 1) return '该任务已退费';
  // 免费代拿权益单：没花钱也没花券，撤销时走「返还权益次数」而不是退券
  if (Number(task.is_free_delivery) === 1) return '本次发布使用了免费代拿权益，未支付信息服务费，无需退费';
  // 发布券单：实付 0 元但要退券，不能按「未支付无需退」拦掉
  if (Number(task.pay_channel) === PAY_CHANNEL_ENUM.COUPON) return '';
  if (Number(task.service_fee) <= 0) return '本次发布未支付信息服务费，无需退费';
  return '';
}

/**
 * 服务费退费（B 方案下实际是「退券」）：符合条件时返还 1 张发布券并更新流水状态
 * 【为什么退券不退款】微信个人主体虚拟支付不支持退款，统一返还等值发布券（0.1 元/张）。
 * 退费条件：任务已被雇主撤销（status=5）+ 从未被接单（once_taken=0）+ 发布未超过 24 小时 + 未退费
 * @param {object} conn 事务连接
 * @param {object} task 任务行
 * @param {string} reason 退费原因
 * @param {object} [options] 可选参数
 * @param {boolean} [options.skipEligibility] 是否跳过「24 小时 / 曾被接单」限制
 *   （管理员删除任务时传 true：走 checkRefundBaseline 底线校验，其余情况一律走完整校验）
 * @returns {Promise<{refunded:boolean, amount?:number, reason?:string, couponReturned?:boolean}>}
 */
async function refundServiceFee(conn, task, reason, options = {}) {
  const payment = await Payment.findByTaskId(task.id, conn);
  if (!payment || payment.status !== PAY_STATUS_ENUM.SUCCESS) {
    return { refunded: false, reason: '未找到可退款的支付流水' };
  }
  const ineligible = options.skipEligibility ? checkRefundBaseline(task) : checkRefundEligible(task);
  if (ineligible) return { refunded: false, reason: ineligible };

  // 先占位：把流水置为「已退款」，affectedRows=0 说明已被并发的另一次退费处理过
  const affected = await Payment.markRefunded(payment.id, payment.total_fee, conn);
  if (affected === 0) return { refunded: false, reason: '退款流水状态已变更' };

  await Task.markRefunded(task.id, conn);

  // 退券：虚拟支付不支持退款，因此无论本单是「现金支付」还是「发布券抵扣」，
  // 一律返还 1 张发布券（价值等同 0.1 元），用户下次发布时可直接抵扣，
  // 既不让用户受损失，也避免平台垫资退款。详见 utils/constant 的 PAY_CHANNEL_ENUM。
  await User.returnPublishCoupon(task.user_id, conn);
  log('info', `退券完成：任务${task.id}，原因：${reason}，已返还 1 张发布券给用户${task.user_id}`);

  return { refunded: true, amount: payment.total_fee, couponReturned: true };
}

/**
 * POST /api/task/cancel 雇主主动撤销待接单任务
 * 撤销后：status=5，立即从任务大厅下架，保留历史记录，不可再次编辑
 * 免费代拿权益：若该任务使用免费权益发布且「从未被任何人接单」，撤销时自动返还 1 次；
 *              一旦有人接单过（once_taken=1，哪怕随后取消了接单）则不再返还。
 * 说明：撤销本身「不自动退费」，雇主需再到「我的发布 - 已撤销」中单独申请退费，
 *       避免出现「服务费已退但任务还挂在大厅」的脏状态
 */
async function cancel(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      // 幂等：重复撤销直接返回已撤销结果，不再重复写消息
      if (task.status === TASK_STATUS_ENUM.OWNER_CANCEL) {
        return {
          repeated: true,
          canApplyRefund: checkRefundEligible(task) === '',
          freeDeliveryReturned: Number(task.is_free_delivery_returned) === 1
        };
      }
      // 可撤销的两种情形：待接单(0)，或 进行中(1) 且接单人尚未确认取货。
      // 接单人一旦确认取货（物品照片已锁定为凭证），撤销入口永久关闭：
      // 跑腿员很可能已经垫钱买到东西，此时单方面撤销等于让人白干。
      const waitTakeCancel = task.status === TASK_STATUS_ENUM.WAIT_TAKE;
      const takenCancelable = task.status === TASK_STATUS_ENUM.TAKING && !task.pickup_confirm_time;
      if (!waitTakeCancel && !takenCancelable) {
        if (task.status === TASK_STATUS_ENUM.TAKING && task.pickup_confirm_time) {
          throw new BizError(MSG.CANCEL_TAKEN_DISABLED, 409);
        }
        throw new BizError('仅待接单或接单人未取货的任务可以撤销', 409);
      }

      const affected = await Task.ownerCancel(taskId, conn);
      if (affected === 0) throw new BizError(MSG.TASK_STATUS_CHANGED, 409);

      // 免费代拿权益返还：乐观锁占位成功后再给账号加次数，两步在同一事务内完成。
      // 条件：用了免费权益发布 + 从未被任何人接单（once_taken=0）+ 尚未返还过；
      // 只要有人接过单，once_taken 已永久为 1，此处必然占位失败 -> 不返还。
      let freeDeliveryReturned = false;
      if (Number(task.is_free_delivery) === 1) {
        const marked = await Task.markFreeDeliveryReturned(taskId, conn);
        if (marked > 0) {
          await User.returnFreeDelivery(user.id, conn);
          freeDeliveryReturned = true;
        }
      }

      const refundReason = checkRefundEligible(task);
      const canApplyRefund = refundReason === '';

      // 撤销提示文案：优先说明「免费权益 / 服务费」的去向
      let content = `任务（编号${taskId}）已撤销并从任务大厅下架。`;
      if (freeDeliveryReturned) {
        content += '本次使用的 1 次免费代拿权益已返还到您的账号，可在「发布任务」页重新使用。';
      } else if (canApplyRefund) {
        content += '可前往「我的发布 - 已撤销」申请退券（返还 1 张发布券，价值 0.1 元，下次发布可直接抵扣）。';
      } else {
        content += refundReason;
      }

      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '任务已撤销',
        content
      }, conn);

      // 进行中撤销：必须第一时间告知接单人「别送了」，否则跑腿员白跑一趟
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '雇主已撤销任务',
          content: `您接取的任务（编号${task.order_no || taskId}）已被雇主撤销，本单不再需要配送，请勿继续跑单。`
            + '如您已经垫付费用，请与雇主协商解决，协商不成可在任务详情提交申诉或举报。'
        }, conn);
      }

      return { repeated: false, canApplyRefund, refundDisabledReason: refundReason, freeDeliveryReturned };
    });

    const msg = result.repeated
      ? '任务已撤销'
      : (result.freeDeliveryReturned
        ? '撤销成功，免费代拿次数已返还'
        : (result.canApplyRefund ? '撤销成功，可在「我的发布-已撤销」中申请退费' : '撤销成功'));
    return ok(res, result, msg);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/task/applyRefund 申请退券
 * 条件：任务已由雇主撤销（status=5）且 从未被接单（once_taken=0）且 发布未超过 24 小时 且 未退费
 * 说明：无独立审核表，符合条件即自动通过并返还 1 张发布券。
 *      虚拟支付不支持退款，因此退还的是「券」而不是现金（PAY_CHANNEL_ENUM 注释有完整说明）。
 */
async function applyRefund(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);

    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError('任务不存在', 400);
      assertTaskNotDeleted(task);
      if (task.user_id !== user.id) throw new BizError(MSG.NO_PERMISSION, 403);
      // 必须先撤销：只有「已撤销」的任务才允许申请退费
      if (task.status !== TASK_STATUS_ENUM.OWNER_CANCEL) {
        throw new BizError('请先撤销任务，再到「我的发布-已撤销」申请退费', 409);
      }
      if (Number(task.is_refunded) === 1) throw new BizError('该任务已退费，不可重复申请', 409);

      const reason = checkRefundEligible(task);
      if (reason) throw new BizError(reason, 403);

      const refund = await refundServiceFee(conn, task, '雇主申请退券');
      if (!refund.refunded) throw new BizError(refund.reason || '退费失败', 409);

      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '退券成功',
        content: `任务（编号${taskId}）已返还 1 张发布券（价值 0.1 元），下次发布任务时会自动抵扣信息服务费。`
      }, conn);

      return refund;
    });

    return ok(res, result, '退券成功，发布券已返还到您的账号');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/task/myPublish 我发布的任务（支持状态筛选 + 状态分组统计）
 */
async function myPublish(req, res, next) {
  try {
    const user = req.user;
    const { page, pageSize, offset } = parsePage(req.query);
    // 状态筛选：支持单状态（status=1）与多状态（status=0,1,2，首页「未完成任务」牌堆用），
    // 具体解析与参数化交给 Task.buildStatusClause，避免这里出现任何字符串拼接
    const status = req.query.status === undefined || req.query.status === '' ? null : req.query.status;

    const { list, total } = await Task.listByOwner({ userId: user.id, status, offset, limit: pageSize });
    const groups = await Task.countByOwnerGroup(user.id);
    const statusCounts = {};
    groups.forEach((item) => { statusCounts[item.status] = Number(item.total); });

    return ok(res, {
      ...buildPage(list.map((item) => toTaskVO(item, user)), total, page, pageSize),
      statusCounts
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/task/myTake 我接的任务
 */
async function myTake(req, res, next) {
  try {
    const user = req.user;
    const { page, pageSize, offset } = parsePage(req.query);
    // 状态筛选：支持单状态（status=1）与多状态（status=0,1,2），见 Task.buildStatusClause
    const status = req.query.status === undefined || req.query.status === '' ? null : req.query.status;

    const { list, total } = await Task.listByTaker({ userId: user.id, status, offset, limit: pageSize });
    return ok(res, buildPage(list.map((item) => toTaskVO(item, user)), total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/task/tabBadge 底部 tabBar 角标数字
 * ---------------------------------------------------------------------
 *   myTakeUnfinished  「我的任务」：进行中(1) + 待雇主确认(2)
 *   myPublishPending  「我的发布」：待雇主确认(2)，即只有雇主本人能处理的订单
 *   unread            「我的」：未读站内消息数（消息中心入口角标）
 * 前端每次切 tab 都会调用，所以这里必须是几条轻量 COUNT，
 * 不能顺手把任务列表带出来，否则切一次 tab 就是一次全表扫描。
 * 未登录时前端压根不会调（返回 401 由统一鉴权中间件处理）。
 */
async function tabBadge(req, res, next) {
  try {
    const [myTakeUnfinished, myPublishPending, unread] = await Promise.all([
      Task.countUnfinishedByTaker(req.user.id),
      Task.countPendingConfirmByOwner(req.user.id),
      Message.countUnread(req.user.id)
    ]);
    return ok(res, { myTakeUnfinished, myPublishPending, unread });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createOrder,
  list,
  detail,
  take,
  cancelTake,
  edit,
  adjustReward,
  submitFinish,
  confirmPickup,
  endOvertime,
  confirmFinish,
  receiptFinish,
  deductLateReward,
  rejectFinish,
  reportLateTaker,
  reportTaker,
  cancel,
  applyRefund,
  myPublish,
  myTake,
  tabBadge,
  toTaskVO,
  refundServiceFee,
  ensureCampusCertified
};
