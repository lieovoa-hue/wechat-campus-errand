/**
 * =====================================================================
 * 申诉控制器
 * 规则：单用户每日最多提交 2 条（每日 0 点自然重置），管理员回复后推送站内消息
 * =====================================================================
 */

const db = require('../db/db');
const Appeal = require('../models/Appeal');
const Message = require('../models/Message');
const { BIZ, MSG_TYPE_ENUM, MSG } = require('../utils/constant');
const {
  ok, BizError, assertParams, parsePage, buildPage, checkIdempotent, hashParams
} = require('../utils/common');
const { isAdminStudent } = require('../utils/adminUtil');
const wxSecCheck = require('../utils/wxSecCheck');

/**
 * POST /api/appeal/submit 提交申诉
 */
async function submit(req, res, next) {
  try {
    const user = req.user;
    assertParams(req.body, [{ name: 'content', label: '申诉内容' }]);
    const content = String(req.body.content).trim();
    if (content.length < 5 || content.length > 200) throw new BizError('申诉内容需为5-200字');
    // 内容安全：申诉正文是用户自由填写的文本，必须过检（SEC_CHECK_ENABLE 未开启时直接放行）
    const sec = await wxSecCheck.checkText(content, user);
    if (!sec.pass) throw new BizError(sec.reason);

    // 幂等：防止连点重复提交
    // 幂等键带上内容指纹：同内容 3 秒内重复提交视为连点，不同内容属于正常的新申诉
    if (!checkIdempotent(`appeal:${user.id}:${hashParams(content)}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // 每日限制：单用户每日最多 2 条（管理员账号权限最高，不受该限制）
    const todayCount = await Appeal.countTodayByUser(user.id);
    if (!isAdminStudent(user.student_id) && todayCount >= BIZ.APPEAL_DAILY_LIMIT) {
      throw new BizError(`每日最多提交${BIZ.APPEAL_DAILY_LIMIT}条申诉，请明日再试`, 409);
    }

    const appealId = await db.transaction(async (conn) => {
      const id = await Appeal.create({ userId: user.id, content }, conn);
      await Message.create({
        userId: user.id,
        msgType: MSG_TYPE_ENUM.SYSTEM,
        title: '申诉已提交',
        content: `您的申诉（编号${id}）已提交，管理员会尽快处理并回复。`
      }, conn);
      return id;
    });

    return ok(res, { appealId }, '申诉提交成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/appeal/myList 我的申诉记录
 */
async function myList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === undefined || req.query.status === '' ? null : Number(req.query.status);
    const { list, total } = await Appeal.listByUser({ userId: req.user.id, status, offset, limit: pageSize });
    return ok(res, buildPage(list, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/appeal/adminList 管理员申诉列表
 */
async function adminList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === undefined || req.query.status === '' ? null : Number(req.query.status);
    const { list, total } = await Appeal.listForAdmin({ status, offset, limit: pageSize });
    return ok(res, buildPage(list, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/appeal/reply 管理员回复申诉（幂等：仅待处理可回复）
 */
async function reply(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'appealId', label: '申诉ID' },
      { name: 'adminReply', label: '回复内容' }
    ]);
    const appealId = Number(req.body.appealId);
    const adminReply = String(req.body.adminReply).trim().slice(0, 200);
    if (!adminReply) throw new BizError('回复内容不能为空');

    await db.transaction(async (conn) => {
      const appeal = await Appeal.findByIdForUpdate(appealId, conn);
      if (!appeal) throw new BizError('申诉记录不存在', 400);
      if (appeal.status !== 1) throw new BizError('该申诉已回复', 409);

      const affected = await Appeal.reply(appealId, adminReply, conn);
      if (affected === 0) throw new BizError('该申诉已回复', 409);

      await Message.create({
        userId: appeal.user_id,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '申诉已回复',
        content: `您的申诉（编号${appealId}）管理员已回复：${adminReply}`
      }, conn);
    });

    return ok(res, null, '回复成功');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  submit,
  myList,
  adminList,
  reply
};
