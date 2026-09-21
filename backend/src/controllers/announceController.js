/**
 * =====================================================================
 * 公告控制器
 * ---------------------------------------------------------------------
 * 用户端：
 *   GET  /api/announce/active   拉取「跑马灯 + 全局通知条」当前生效中的公告
 * 管理员：
 *   GET  /api/admin/announceList    公告列表（可按展示位置筛选）
 *   POST /api/admin/announceCreate  发布公告（只填正文，标题自动摘取）
 *   POST /api/admin/announceToggle  上架 / 下架
 *   POST /api/admin/announceDelete  批量删除（物理删除）
 * 说明：管理员发布时可勾选「同时推送消息中心」，默认勾选 —— 用户没打开小程序也能在
 *       消息中心看到公告留痕；跑马灯 / 通知条本身是「进页面即拉取」，不需要长连接。
 * =====================================================================
 */

const Announcement = require('../models/Announcement');
const { execute } = require('../db/db');
const { ok, parsePage, buildPage, BizError, toInt } = require('../utils/common');
const { MSG, BIZ, ANNOUNCE_SCOPE, ANNOUNCE_SCOPE_ENUM, MSG_TYPE_ENUM, getText } = require('../utils/constant');
const wxSecCheck = require('../utils/wxSecCheck');

/** 展示位置白名单（1 跑马灯 / 2 通知条），非法值一律拒绝 */
function parseScope(value) {
  const scope = Number(value);
  if (scope !== ANNOUNCE_SCOPE_ENUM.MARQUEE && scope !== ANNOUNCE_SCOPE_ENUM.NOTICE) {
    throw new BizError(MSG.ANNOUNCE_SCOPE_INVALID, 400);
  }
  return scope;
}

/**
 * 正文校验：必填、去首尾空格、长度上限
 * @param {*} value 原始输入
 * @returns {string} 规范化后的正文
 */
function normalizeContent(value) {
  const content = String(value === undefined || value === null ? '' : value).trim();
  if (!content) throw new BizError(MSG.ANNOUNCE_CONTENT_REQUIRED, 400);
  if (content.length > BIZ.ANNOUNCE_MAX_LEN) throw new BizError(MSG.ANNOUNCE_CONTENT_TOO_LONG, 400);
  return content;
}

/**
 * 生效时间校验：结束时间必须晚于开始时间（都允许留空 = 立即 / 长期）
 * @returns {{startAt: string|null, endAt: string|null}}
 */
function normalizeTime(startAt, endAt) {
  const from = startAt ? String(startAt).trim() : '';
  const to = endAt ? String(endAt).trim() : '';
  if (from && to && new Date(to).getTime() <= new Date(from).getTime()) {
    throw new BizError(MSG.ANNOUNCE_TIME_INVALID, 400);
  }
  return { startAt: from || null, endAt: to || null };
}

/**
 * 公告 -> 前端展示对象
 * closable 只对通知条有意义（跑马灯不可关闭，由前端忽略该字段）
 */
function toVO(item) {
  return {
    id: item.id,
    scope: Number(item.scope),
    content: item.content,
    closable: Number(item.is_closable) === 1,
    startAt: item.start_at || null,
    endAt: item.end_at || null,
    createdAt: item.created_at || null
  };
}

/**
 * GET /api/announce/active
 * 返回 { marquee: [...], notice: [...] }：两套内容各取生效中的列表，
 * 前端首页渲染跑马灯、其余页面渲染顶部通知条。
 */
async function active(req, res, next) {
  try {
    const [marqueeRows, noticeRows] = await Promise.all([
      Announcement.listActive(ANNOUNCE_SCOPE_ENUM.MARQUEE),
      Announcement.listActive(ANNOUNCE_SCOPE_ENUM.NOTICE)
    ]);
    return ok(res, {
      marquee: marqueeRows.map(toVO),
      notice: noticeRows.map(toVO)
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/admin/announceList 公告列表（管理员）
 * 入参：scope（可选，1/2；不传=全部）、page、pageSize
 */
async function adminList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const scope = req.query.scope === undefined || req.query.scope === ''
      ? null : parseScope(req.query.scope);
    const { list, total } = await Announcement.listAdmin({ scope, offset, limit: pageSize });
    return ok(res, buildPage(list.map((item) => Object.assign(toVO(item), {
      isActive: Number(item.is_active) === 1,
      sort: Number(item.sort) || 0,
      scopeText: getText(ANNOUNCE_SCOPE, Number(item.scope), ''),
      pushCount: Number(item.push_count) || 0,
      creatorId: item.creator_id || null
    })), total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/announceCreate 发布公告
 * 请求体：scope（1/2）、content（正文）、startAt / endAt（可选，'YYYY-MM-DD HH:mm:ss'）、
 *        isClosable（通知条是否可关闭，默认 true）、pushMessage（是否推送消息中心，默认 true）
 * 设计：标题不单独填写，自动摘取正文前 ANNOUNCE_TITLE_LEN 个字符。
 */
async function adminCreate(req, res, next) {
  try {
    const scope = parseScope(req.body.scope);
    const content = normalizeContent(req.body.content);
    // 内容安全：公告会推送给全部用户，即使发布者是管理员也照样过检
    // （SEC_CHECK_ENABLE 未开启时直接放行，不影响本地开发与回归）
    const sec = await wxSecCheck.checkJoined([{ label: '公告正文', text: content }], req.user);
    if (!sec.pass) throw new BizError(sec.reason);
    const { startAt, endAt } = normalizeTime(req.body.startAt, req.body.endAt);
    const isClosable = req.body.isClosable === undefined ? 1 : (req.body.isClosable ? 1 : 0);
    const sort = Math.max(0, Math.min(BIZ.ANNOUNCE_SORT_MAX, toInt(req.body.sort, 0)));
    const pushMessage = req.body.pushMessage === undefined ? true : Boolean(req.body.pushMessage);

    const id = await Announcement.create({
      scope, content, sort, startAt, endAt, isClosable, creatorId: req.user.id
    });

    // 可选：同步写入所有正常账号的消息中心（一条 INSERT ... SELECT，按用户数返回条数）
    let pushed = 0;
    if (pushMessage) {
      // 标题统一用「平台公告」，正文即公告内容：消息列表里一眼能看出是公告，不重复堆文字
      const result = await execute(
        'INSERT INTO messages (user_id, msg_type, title, content, is_read)'
        + ' SELECT id, ?, ?, ?, 0 FROM users WHERE deactivated_at IS NULL',
        [MSG_TYPE_ENUM.ADMIN, MSG.ANNOUNCE_MESSAGE_TITLE, content]
      );
      pushed = result ? Number(result.affectedRows || 0) : 0;
      if (pushed > 0) await Announcement.setPushCount(id, pushed);
    }

    return ok(res, { id, pushed }, '公告已发布');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/announceToggle 上架 / 下架
 * 请求体：id、isActive（true 上架 / false 下架）
 */
async function adminToggle(req, res, next) {
  try {
    const id = toInt(req.body.id, 0);
    if (!id) throw new BizError(MSG.PARAM_ERROR, 400);
    const exist = await Announcement.findById(id);
    if (!exist) throw new BizError(MSG.ANNOUNCE_NOT_FOUND, 404);
    const isActive = req.body.isActive ? 1 : 0;
    await Announcement.updateFields(id, { is_active: isActive });
    return ok(res, { id, isActive }, isActive ? '公告已上架' : '公告已下架');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/announceDelete 批量删除公告（物理删除，不可恢复）
 * 请求体：ids（公告 id 数组，最多 BIZ.BATCH_DELETE_MAX 条）
 */
async function adminDelete(req, res, next) {
  try {
    const raw = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = raw.map((item) => toInt(item, 0)).filter((item) => item > 0);
    if (!ids.length) throw new BizError(MSG.BATCH_DELETE_EMPTY, 400);
    if (ids.length > BIZ.BATCH_DELETE_MAX) throw new BizError(MSG.BATCH_DELETE_LIMITED, 400);
    const deleted = await Announcement.deleteByIds(ids);
    return ok(res, { deleted }, MSG.ANNOUNCE_DELETED);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  active,
  adminList,
  adminCreate,
  adminToggle,
  adminDelete
};
