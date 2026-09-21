/**
 * =====================================================================
 * 举报控制器
 * 任务详情页可提交举报，管理员后台处理；同一用户对同一任务只能有 1 条待处理举报
 * =====================================================================
 */

const db = require('../db/db');
const Report = require('../models/Report');
const Task = require('../models/Task');
const Message = require('../models/Message');
const {
  MSG_TYPE_ENUM, REPORT_TYPE_ENUM, REPORT_STATUS_ENUM,
  REPORT_TYPE, REPORT_STATUS, MSG, BIZ, getText, CAMPUS_AUDIT_ENUM
} = require('../utils/constant');
// 管理员身份只认 .env 学号白名单（与鉴权中间件同一套判定）
const { isAdminStudent } = require('../utils/adminUtil');
const wxSecCheck = require('../utils/wxSecCheck');
const {
  ok, BizError, assertParams, parsePage, buildPage, checkIdempotent, formatUserId
} = require('../utils/common');

/**
 * POST /api/report/submit 提交举报
 */
async function submit(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [
      { name: 'taskId', label: '任务ID' },
      { name: 'reportReason', label: '举报原因' }
    ]);
    const taskId = Number(req.body.taskId);
    const reportReason = String(req.body.reportReason).trim();
    if (reportReason.length < 5 || reportReason.length > 200) throw new BizError('举报原因需为5-200字');
    // 内容安全：举报原因是用户自由填写的文本，必须过检（SEC_CHECK_ENABLE 未开启时直接放行）
    const sec = await wxSecCheck.checkText(reportReason, user);
    if (!sec.pass) throw new BizError(sec.reason);

    if (!checkIdempotent(`report:${user.id}:${taskId}`, 3000)) throw new BizError(MSG.REPEAT_SUBMIT, 409);

    const task = await Task.findById(taskId);
    if (!task) throw new BizError('被举报的任务不存在', 400);

    // 【规则一】任务发布人不能举报自己的任务
    // 说明：举报是「其他人对这条任务的违规行为进行反馈」，雇主自己举报自己既无意义，
    //      也会白占管理员后台的待处理队列；这里按 tasks.user_id 做硬校验（越权校验），
    //      前端同时隐藏雇主视角的举报入口，但后端始终以本条校验为准。
    if (task.user_id === user.id) throw new BizError(MSG.REPORT_OWN_TASK, 403);

    // 【规则二】每条任务每人（除雇主外）半小时内最多举报 3 次
    // 说明：统计窗口内所有状态（含已处理）的普通举报条数，超过上限直接拦截，
    //      防止同一用户反复刷举报骚扰对方 / 淹没管理员后台；窗口与阈值统一走 constant.js 字典。
    const recentCount = await Report.countRecentByUserAndTask(
      user.id, taskId, BIZ.REPORT_WINDOW_MINUTES
    );
    if (recentCount >= BIZ.REPORT_MAX_PER_TASK) throw new BizError(MSG.REPORT_TOO_FREQ, 409);

    // 订单号校验：前端从任务详情页拿到订单号后随举报一起上报，
    // 后端始终以 tasks.order_no 为准（客户端传的只做一致性校验，防止报错单）
    const orderNo = task.order_no || '';
    if (!orderNo) throw new BizError(MSG.ORDER_NO_EMPTY, 409);
    const clientOrderNo = String(req.body.orderNo || '').trim().toUpperCase();
    if (clientOrderNo && clientOrderNo !== orderNo) {
      throw new BizError(MSG.ORDER_NO_MISMATCH, 409);
    }

    // 同一任务避免重复举报
    const pending = await Report.findPendingByUserAndTask(user.id, taskId);
    if (pending) throw new BizError('您已举报过该任务，管理员正在处理中', 409);

    // 举报快照：订单号 + 雇主 / 接单人双方的 账号ID、学号、手机号 一并落库，
    // 管理员在后台「举报管理」里能直接看到是哪一单、涉及哪两个人
    const snapshot = Report.buildTaskSnapshot(task);
    const reportId = await db.transaction(async (conn) => {
      const id = await Report.create({
        userId: user.id,
        taskId,
        reportReason,
        reportType: REPORT_TYPE_ENUM.NORMAL,
        ...snapshot
      }, conn);
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '举报已提交',
        content: `您对任务（订单号${orderNo}）的举报已提交，管理员会尽快核实处理。`
      }, conn);
      return id;
    });

    return ok(res, { reportId, orderNo }, '举报提交成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/report/adminList 管理员举报列表
 */
/**
 * 管理员举报视图：把「举报快照」与「实时联表数据」合并成一份统一口径的下发结构
 *   1. 订单号：优先用举报时落库的快照，历史举报回退到任务当前订单号
 *   2. 雇主 / 接单人：快照优先（举报当时的账号、学号、手机号），缺失时才回退实时数据，
 *      保证管理员看到的始终是「举报那一刻」的双方信息，不会因为对方改资料而失真
 * @param {object} row Report.listForAdmin 返回的原始行
 * @returns {object} 下发给管理员的举报对象
 */
function toAdminReportVO(row) {
  const reportType = Number(row.report_type) || REPORT_TYPE_ENUM.NORMAL;
  const ownerUserId = Number(row.owner_user_id) || Number(row.task_owner_id) || null;
  const takerUserId = Number(row.snap_taker_user_id) || Number(row.taker_user_id) || null;

  return {
    id: row.id,
    taskId: row.task_id,
    // 订单号（GCPT+数字）：管理员据此定位到具体任务
    orderNo: row.order_no || row.task_order_no || '',
    reportReason: row.report_reason,
    reportType,
    reportTypeText: getText(REPORT_TYPE, reportType),
    isLateReport: reportType === REPORT_TYPE_ENUM.LATE_TAKEOVER,
    status: row.status,
    statusText: getText(REPORT_STATUS, row.status),
    adminNote: row.admin_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    // 举报人
    reporterUserId: row.user_id,
    reporterUserIdText: formatUserId(row.user_id, row.reporter_account_no),
    reporterNickname: row.reporter_nickname || '',
    reporterStudentId: row.reporter_student_id || '',
    reporterPhone: row.reporter_phone || '',

    // 雇主（发布任务的人）
    ownerUserId,
    ownerUserIdText: ownerUserId ? formatUserId(ownerUserId, row.owner_live_account_no) : '',
    ownerNickname: row.owner_live_nickname || '',
    ownerStudentId: row.owner_student_id || row.owner_live_student_id || '',
    ownerPhone: row.owner_phone || row.owner_live_phone || '',

    // 接单人（可能为空：任务还没被接单时被举报）
    takerUserId,
    takerUserIdText: takerUserId ? formatUserId(takerUserId, row.taker_account_no) : '',
    takerNickname: row.taker_nickname || '',
    takerStudentId: row.snap_taker_student_id || row.taker_student_id || '',
    takerPhone: row.snap_taker_phone || row.taker_phone || '',
    takerBanTakeTime: row.taker_ban_take_time || null,
    // 是否可一键封禁接单人（待处理 + 有接单人）
    canBanTaker: !!takerUserId && Number(row.status) === REPORT_STATUS_ENUM.PENDING,

    // ---------------- 用户 mini 卡片所需的头像与身份标识 ----------------
    // 展示口径与任务列表/详情完全一致：
    //   管理员（.env 学号白名单） -> 红色「管理员」标识
    //   校园认证通过             -> 绿色「已认证」标识
    //   其余                     -> 不显示标识
    // 头像与认证状态由 Report.listForAdmin 一并 JOIN 出来，避免前端再逐个补请求。
    reporterAvatar: row.reporter_avatar || '',
    reporterIsAdmin: isAdminStudent(row.reporter_student_id),
    reporterIsCertified: Number(row.reporter_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,

    ownerAvatar: row.owner_live_avatar || '',
    ownerIsAdmin: isAdminStudent(row.owner_live_student_id || row.owner_student_id),
    ownerIsCertified: Number(row.owner_live_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,

    takerAvatar: row.taker_avatar || '',
    takerIsAdmin: isAdminStudent(row.taker_student_id || row.snap_taker_student_id),
    takerIsCertified: Number(row.taker_campus_audit) === CAMPUS_AUDIT_ENUM.PASS,

    // 任务概要
    deliverAddress: row.deliver_address || '',
    taskStatus: row.task_status,
    taskReward: row.task_reward,
    taskTimeLimitMin: row.task_time_limit_min
  };
}

async function adminList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === undefined || req.query.status === '' ? null : Number(req.query.status);
    // 举报类型筛选：1 普通举报 / 2 恶意超时投诉（空表示全部）
    const reportType = req.query.reportType === undefined || req.query.reportType === ''
      ? null : Number(req.query.reportType);
    const { list, total } = await Report.listForAdmin({ status, reportType, offset, limit: pageSize });
    return ok(res, buildPage(list.map(toAdminReportVO), total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/report/handle 管理员处理举报（幂等：仅待处理可处理）
 */
async function handle(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'reportId', label: '举报ID' },
      { name: 'adminNote', label: '处理说明' }
    ]);
    const reportId = Number(req.body.reportId);
    const adminNote = String(req.body.adminNote).trim().slice(0, 200);

    await db.transaction(async (conn) => {
      const report = await Report.findById(reportId, conn);
      if (!report) throw new BizError('举报记录不存在', 400);
      if (report.status !== 1) throw new BizError('该举报已处理完毕', 409);

      const affected = await Report.handle(reportId, adminNote, conn);
      if (affected === 0) throw new BizError('该举报已处理完毕', 409);

      await Message.create({
        userId: report.user_id,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '举报处理结果',
        content: `您对任务（编号${report.task_id}）的举报已处理完毕：${adminNote}`
      }, conn);
    });

    return ok(res, null, '处理完成');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  submit,
  adminList,
  handle
};
