/**
 * =====================================================================
 * 站内消息控制器
 * 普通用户只能查看本人的消息（越权校验由 userId 条件天然保证）
 * =====================================================================
 */

const Message = require('../models/Message');
const { ok, parsePage, buildPage, BizError, toInt } = require('../utils/common');
const { MSG } = require('../utils/constant');

/**
 * GET /api/message/list 消息列表（可按 msgType 分类筛选，时间倒序）
 */
async function list(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const msgType = req.query.msgType === undefined || req.query.msgType === ''
      ? null : Number(req.query.msgType);

    const { list: rows, total } = await Message.listByUser({
      userId: req.user.id, msgType, offset, limit: pageSize
    });
    const unread = await Message.countUnread(req.user.id);
    // 各分类未读数：消息中心分类 Tab 上的角标直接用它，避免前端按分类再请求四次
    const unreadByType = await Message.countUnreadByType(req.user.id);

    return ok(res, { ...buildPage(rows, total, page, pageSize), unread, unreadByType });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/message/readAll 全部标记已读（幂等）
 */
async function readAll(req, res, next) {
  try {
    await Message.markAllRead(req.user.id);
    return ok(res, null, '已全部标记为已读');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/message/unreadCount 未读消息总数（「我的」页消息入口角标 / 启动时刷新用）
 * 轻量：一条 COUNT，不含列表数据。
 */
async function unreadCount(req, res, next) {
  try {
    const unread = await Message.countUnread(req.user.id);
    return ok(res, { unread });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/message/deleteAll 全部删除（含已读，物理删除，不可恢复）
 * ---------------------------------------------------------------------
 * 消息中心「全部删除」按钮：用户主动清空收件箱。
 * 与「清除未读」的区别：后者只删未读，本接口连已读历史一起删掉。
 * 幂等：没有消息时返回 0，不报错。
 */
async function deleteAll(req, res, next) {
  try {
    const deleted = await Message.deleteAll(req.user.id);
    return ok(res, { deleted }, deleted > 0 ? MSG.MESSAGE_DELETE_ALL_DONE : MSG.MESSAGE_DELETE_ALL_NONE);
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/message/detail?id=xx 消息详情
 * ---------------------------------------------------------------------
 * 进入详情页即视为「看过这条消息」，顺手标记为已读（幂等，重复进入不会有副作用）。
 * 用 user_id 做归属条件，取不到就是不属于本人 —— 统一报「消息不存在」，
 * 不区分「不存在」与「不是你的」，避免被人拿来探测别人的消息 id。
 */
async function detail(req, res, next) {
  try {
    const id = toInt(req.query.id, 0);
    if (!id) throw new BizError('参数错误', 400);

    const message = await Message.findById(req.user.id, id);
    if (!message) throw new BizError('消息不存在或已被清除', 400);

    if (Number(message.is_read) === 0) {
      await Message.markRead(req.user.id, id);
      message.is_read = 1;
    }
    const unread = await Message.countUnread(req.user.id);
    return ok(res, { message, unread });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/message/clearUnread 清除全部未读消息
 * ---------------------------------------------------------------------
 * 与「一键已读」不同：这里是把未读消息直接删掉（用户主动清理，防红点堆积）。
 * 已读消息不受影响，历史仍可回看。
 * 幂等：没有未读时返回 0，不会报错。
 */
async function clearUnread(req, res, next) {
  try {
    const cleared = await Message.clearUnread(req.user.id);
    return ok(res, { cleared }, cleared > 0 ? `已清除 ${cleared} 条未读消息` : '没有未读消息');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  readAll,
  detail,
  clearUnread,
  unreadCount,
  deleteAll
};
