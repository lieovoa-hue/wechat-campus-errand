/**
 * =====================================================================
 * 支付控制器
 *  - /api/pay/notify      微信支付回调（无需鉴权，但必须验签 + 解密 + 幂等）
 *  - /api/pay/queryStatus 前端轮询支付结果
 *  - /api/pay/repay       未支付订单重新发起支付
 *  支付成功统一走 markPaymentSuccess：更新流水 + 生成服务费支出账单 + 站内消息
 * =====================================================================
 */

const db = require('../db/db');
const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const Message = require('../models/Message');
const Task = require('../models/Task');
const User = require('../models/User');
const payUtil = require('../utils/payUtil');
const virtualPay = require('../utils/virtualPay');
const { PAY_STATUS_ENUM, BILL_TYPE_ENUM, MSG_TYPE_ENUM, PAY_CHANNEL_ENUM, MSG } = require('../utils/constant');
const { ok, BizError, assertParams, log, formatDate } = require('../utils/common');

/**
 * 支付成功统一处理（幂等）
 * 1. 支付流水：待支付 -> 支付成功（条件更新，重复回调不会重复记账）
 * 2. 为发布者生成「服务费支出」账单，金额 0.1 元
 *    例外：使用「邀请码免费代拿」权益发布的任务应付 0 元，
 *         不收取信息服务费、因此也不生成该条账单（避免账单与实际收支不符）
 * 3. 推送站内消息，提示任务已上架
 * @param {string} outTradeNo 商户订单号
 * @param {string} transactionId 微信支付单号
 * @returns {Promise<{repeated:boolean, taskId:number}>}
 */
async function markPaymentSuccess(outTradeNo, transactionId = '') {
  return db.transaction(async (conn) => {
    // 行锁查询，防止同一订单并发处理
    const payment = await Payment.findByOutTradeNoForUpdate(outTradeNo, conn);
    if (!payment) throw new BizError('支付流水不存在', 400);

    const affected = await Payment.markPaid(outTradeNo, transactionId, conn);
    if (affected === 0) {
      // 已处理过（重复回调 / 重复点击），直接返回，保证幂等
      return { repeated: true, taskId: payment.task_id };
    }

    const task = await Task.findById(payment.task_id, conn);
    // 免费代拿单：应付金额 0 元，跳过服务费账单，消息文案也换成「免费发布」
    const isFreeDelivery = Number(payment.total_fee) <= 0;
    // 发布券抵扣单：实付同为 0 元，但文案与「免费代拿权益」不同（详见 PAY_CHANNEL_ENUM）
    const viaCoupon = !!task && Number(task.pay_channel) === PAY_CHANNEL_ENUM.COUPON;

    // 服务费支出账单（幂等：同一任务同一类型只记一条）
    if (!isFreeDelivery) {
      const billExists = await Bill.exists(payment.task_id, payment.user_id, BILL_TYPE_ENUM.SERVICE_FEE, conn);
      if (!billExists) {
        await Bill.create({
          userId: payment.user_id,
          taskId: payment.task_id,
          type: BILL_TYPE_ENUM.SERVICE_FEE,
          amount: payment.total_fee,
          remark: '发布任务信息服务费'
        }, conn);
      }
    }

    await Message.create({
      userId: payment.user_id,
      msgType: MSG_TYPE_ENUM.SYSTEM,
      title: '任务发布成功',
      content: viaCoupon
        ? `您发布的任务（编号${payment.task_id}）已使用 1 张发布券抵扣信息服务费，任务已上架，等待跑腿员接单。`
        : (isFreeDelivery
          ? `您发布的任务（编号${payment.task_id}）已使用邀请码免费代拿权益发布成功（免信息服务费），任务已上架，等待跑腿员接单。`
          : `您发布的任务（编号${payment.task_id}）已支付信息服务费${payment.total_fee}元，任务已上架，等待跑腿员接单。`)
    }, conn);

    log('info', `支付成功：订单${outTradeNo}，任务${payment.task_id}，金额${payment.total_fee}元`
      + `${viaCoupon ? '（发布券抵扣）' : (isFreeDelivery ? '（免费代拿权益）' : '')}，上架时间${task ? task.publish_time : '-'}`);
    return { repeated: false, taskId: payment.task_id };
  });
}

/**
 * POST /api/pay/notify 微信支付结果回调
 * 必须验签，验签失败直接拒绝；处理成功返回 200，失败返回 500 让微信重试
 */
async function notify(req, res) {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});

    // 1. 回调验签（平台证书 RSA-SHA256 + 防重放时间窗）
    const verified = payUtil.verifyNotifySignature(req.headers, rawBody);
    if (!verified) {
      log('warn', '支付回调验签失败，已拒绝处理');
      return res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
    }

    const body = req.body || {};
    // 2. 报文解密（AES-256-GCM）
    const resource = body.resource ? payUtil.decryptResource(body.resource) : null;
    if (!resource || !resource.out_trade_no) {
      return res.status(400).json({ code: 'FAIL', message: '回调数据不完整' });
    }

    // 3. 仅处理支付成功事件
    if (body.event_type !== 'TRANSACTION.SUCCESS' || resource.trade_state !== 'SUCCESS') {
      log('info', `忽略非成功支付回调：${body.event_type}`);
      return res.status(200).json({ code: 'SUCCESS', message: '已接收' });
    }

    // 4. 幂等处理
    await markPaymentSuccess(resource.out_trade_no, resource.transaction_id || '');
    return res.status(200).json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    log('error', '支付回调处理异常：', err.message);
    // 返回非 200，微信会按策略重试
    return res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
}

/**
 * POST /api/pay/xpayNotify 微信虚拟支付「道具发货推送」
 * ---------------------------------------------------------------------
 * 与普通支付回调的区别（务必留意）：
 *   1. 报文是 **XML**（不是 JSON），且没有签名头，微信只做「推给你、你 ACK」；
 *   2. 必须返回 <ErrCode>0</ErrCode> 才算发货成功，否则微信按策略最多重试 15 次；
 *   3. 幂等由 markPaymentSuccess 内部的条件更新保证：同一条流水重复推送只会发货一次。
 *
 * 安全：报文里的 OutTradeNo 是我们自己生成的 26 位订单号，只用于定位本地支付流水，
 *   不参与任何 SQL 拼接；即使被人伪造推送，也只能把「一条已存在的未支付流水」标记为已支付，
 *   而该流水对应的任务本来就只有该用户可见，不存在越权风险。
 */
async function notifyVirtual(req, res) {
  const rawXml = typeof req.body === 'string' ? req.body : (req.rawBody || '');
  try {
    const info = virtualPay.parseDeliverNotify(rawXml);
    // 只处理「道具发货」事件，其它事件原样应答，避免微信反复重试
    if (info.event && info.event !== 'xpay_goods_deliver_notify') {
      log('info', '忽略非发货事件的虚拟支付推送：' + info.event);
      return res.type('application/xml').send(virtualPay.buildDeliverAck());
    }
    if (!info.outTradeNo) {
      log('warn', '虚拟支付发货推送缺少 OutTradeNo，已应答但未发货');
      return res.type('application/xml').send(virtualPay.buildDeliverFail('missing outTradeNo'));
    }

    const result = await markPaymentSuccess(info.outTradeNo, info.wxOrderId || ('XPAY' + Date.now()));
    log('info', '虚拟支付发货完成：订单' + info.outTradeNo + '，任务' + result.taskId
      + (result.repeated ? '（重复推送，已幂等忽略）' : ''));
    return res.type('application/xml').send(virtualPay.buildDeliverAck());
  } catch (err) {
    // 返回非 0 让微信重试：可能是数据库瞬时不可用，重试比直接丢弃稳妥
    log('error', '虚拟支付发货推送处理失败：', err.message);
    return res.status(500).type('application/xml').send(virtualPay.buildDeliverFail('server error'));
  }
}
/**
 * GET /api/pay/queryStatus/:taskId 查询任务支付状态（前端支付后轮询）
 */
async function queryStatus(req, res, next) {
  try {
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法');

    const task = await Task.findById(taskId);
    if (!task) throw new BizError('任务不存在', 400);
    // 越权校验：仅任务发布者本人可查询支付状态
    if (task.user_id !== req.user.id) throw new BizError(MSG.NO_PERMISSION, 403);

    const payment = await Payment.findByTaskId(taskId);
    return ok(res, {
      taskId,
      status: payment ? payment.status : null,
      outTradeNo: payment ? payment.out_trade_no : '',
      totalFee: payment ? payment.total_fee : 0,
      paid: !!payment && payment.status === PAY_STATUS_ENUM.SUCCESS
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/pay/repay 未支付订单重新发起支付
 */
async function repay(req, res, next) {
  try {
    const { taskId, code } = req.body;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);

    const task = await Task.findById(Number(taskId));
    if (!task) throw new BizError('任务不存在', 400);
    if (task.user_id !== req.user.id) throw new BizError(MSG.NO_PERMISSION, 403);

    const payment = await Payment.findByTaskId(task.id);
    if (!payment) throw new BizError('支付流水不存在', 400);
    if (payment.status === PAY_STATUS_ENUM.SUCCESS) throw new BizError('该订单已支付', 409);
    if (payment.status === PAY_STATUS_ENUM.REFUNDED) throw new BizError('该订单已退款', 409);

    if (payUtil.isSimulate()) {
      // 模拟支付模式：点击支付直接标记成功
      const result = await markPaymentSuccess(payment.out_trade_no, `SIMULATE${Date.now()}`);
      return ok(res, { paid: true, taskId: task.id, repeated: result.repeated }, '支付成功');
    }

    // 虚拟支付（个人主体 B 方案）：重新下发 requestVirtualPayment 参数
    if (payUtil.isVirtual()) {
      const session = await payUtil.getLoginSession(code);
      const payParams = virtualPay.buildOrderParams({
        outTradeNo: payment.out_trade_no,
        sessionKey: session.sessionKey,
        attach: 'T' + task.id
      });
      return ok(res, {
        paid: false,
        taskId: task.id,
        outTradeNo: payment.out_trade_no,
        payMode: 'virtual',
        payParams
      }, '订单创建成功，请完成支付');
    }

    const openid = await payUtil.getOpenidByCode(code);
    const prepayId = await payUtil.createJsapiPrepay({
      outTradeNo: payment.out_trade_no,
      description: `校园跑腿信息服务费-任务${task.id}`,
      totalFeeYuan: payment.total_fee,
      openid
    });
    return ok(res, {
      paid: false,
      taskId: task.id,
      outTradeNo: payment.out_trade_no,
      payParams: payUtil.buildMiniProgramPayParams(prepayId)
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  notify,
  notifyVirtual,
  queryStatus,
  repay,
  markPaymentSuccess
};
