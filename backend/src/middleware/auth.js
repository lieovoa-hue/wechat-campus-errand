/**
 * =====================================================================
 * 鉴权中间件
 *   auth        ：校验 access_token + 单设备登录校验
 *   adminAuth   ：管理员权限校验（后端硬编码学号白名单，绝不依赖 users.is_admin）
 *   identifyAccount：登录页专用的账号识别（手机号 / 账号ID）
 * =====================================================================
 */

require('dotenv').config();

const jwtUtil = require('../utils/jwtUtil');
const { fail, log } = require('../utils/common');
// 顶号提示：被新设备顶下线时，把「新设备名称 / 时间 / IP / 归属地」一并告知旧设备
const { buildKickNotice } = require('../utils/kickUtil');
const { CODE_MSG, MSG } = require('../utils/constant');
// 管理员白名单统一由 utils/adminUtil.js 维护，禁止在本文件重复实现
const { getAdminStudentIds, isAdminStudent, roleTagOf } = require('../utils/adminUtil');

/**
 * 未设置密保问题时仍可访问的接口白名单（完整路径）
 * 为什么要放行这些：用户正处于「注册成功 → 还未设置密保」的过渡态，
 * 必须能查看个人信息、进入密保设置页、上传头像、查看消息、注销账号，
 * 否则用户会被自己的账号彻底锁死。
 * 其余全部业务接口（发布 / 接单 / 认证 / 申诉 / 举报 / 账单…）统一返回 428，前端据此跳转设置页。
 */
const SECURITY_EXEMPT_PATHS = [
  '/api/user/info',
  '/api/user/setSecurity',
  '/api/user/devices',
  '/api/user/unbindDevice',
  '/api/user/deactivate',
  '/api/user/uploadImage',
  '/api/user/uploadImageBase64',
  '/api/message/list',
  '/api/message/readAll',
  '/api/message/unreadCount',
  '/api/message/deleteAll',
  '/api/message/clearUnread',
  // 公告是全员可见的运营信息，未设密保的过渡态也应能看到（否则首页会缺一块）
  '/api/announce/active'
];

/**
 * 判断当前请求是否属于「未设置密保也可访问」的白名单接口
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSecurityExemptPath(req) {
  const fullPath = String((req.baseUrl || '') + (req.path || ''));
  return SECURITY_EXEMPT_PATHS.indexOf(fullPath) >= 0;
}

/**
 * 从请求中提取 Bearer Token
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header) return '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : String(header).trim();
}

/**
 * 登录鉴权中间件
 * 1. 校验 access_token 合法性与有效期
 * 2. 查询用户，校验账号是否存在
 * 3. 单设备登录校验：token 中 deviceId 必须与 users.login_device_id 一致，
 *    新设备登录后旧设备 token 立即失效
 */
async function auth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return fail(res, 401, CODE_MSG[401]);
    }

    const payload = jwtUtil.verifyAccessToken(token);
    if (!payload || !payload.userId) {
      return fail(res, 401, CODE_MSG[401]);
    }

    // 延迟 require 避免循环依赖
    const User = require('../models/User');
    const user = await User.findById(payload.userId);
    if (!user) {
      return fail(res, 401, CODE_MSG[401]);
    }

    // 已注销账号：立即拦截，旧 token 同时失效。
    // 说明：注销时会把 login_device_id 清空，仅靠单设备校验无法拦截旧 token，
    //      因此这里必须显式判断 deactivated_at，保证注销后所有存量 token 全部作废。
    if (User.isDeactivatedUser(user)) {
      return fail(res, 401, MSG.ACCOUNT_DEACTIVATED);
    }

    // 管理员账号自动认证：命中白名单的账号自动标记为「校园认证通过 + 管理员标识」。
    // 内部按需 UPDATE（已是目标状态则直接返回，非管理员账号无任何额外写操作），
    // 保证任意接口拿到的用户对象权限口径完全一致。
    await User.autoCertifyAdmin(user);

    // 单设备登录校验：设备标识不一致说明账号已在别处登录，旧 token 立即失效
    const currentDevice = String(user.login_device_id || '');
    if (currentDevice && payload.deviceId && currentDevice !== payload.deviceId) {
      // 被顶下线的一方必须收到明确提示（哪台设备 / 什么时候 / 哪个 IP），
      // 否则用户只会莫名掉线，既无法自证也发现不了盗号；
      //
      // ⚠ 这里刻意「不」把记录标记为已读：
      //   前端拿到 401 后先会自动尝试刷新令牌，这一跳会消费掉提示，
      //   等真正弹窗时记录已读、内容变成一串「未知」，用户反而更困惑。
      //   记录的生命周期改为：该设备下次成功登录时由 clearDeviceKicks 统一清掉；
      //   由于前端弹窗后会立刻清理登录态并回到登录页，不会出现反复弹窗。
      let kickData = null;
      try {
        const kick = await User.findLatestUnreadKick(user.id, payload.deviceId);
        if (kick) kickData = buildKickNotice(kick);
      } catch (err) {
        log('error', '顶号提示读取失败：', err.message);
      }
      // 没有有效的顶号记录（例如 token 自然过期）：不伪造提示，前端按普通登录失效处理
      return fail(res, 401, MSG.KICKED_BY_NEW_DEVICE, kickData || undefined);
    }

    // 账号处于登录锁定期内，直接拦截，避免绕过
    if (user.login_lock_time && new Date(user.login_lock_time).getTime() > Date.now()) {
      return fail(res, 423, MSG.ACCOUNT_LOCKED);
    }

    // 密保设置校验：注册后必须先设置密保问题才能使用小程序。
    // 管理员账号权限最高，不受该限制；白名单接口（见 SECURITY_EXEMPT_PATHS）始终放行。
    if (!User.hasSecurity(user) && !isAdminStudent(user.student_id) && !isSecurityExemptPath(req)) {
      return fail(res, 428, MSG.NEED_SET_SECURITY);
    }

    req.user = user;
    req.tokenPayload = payload;
    req.deviceId = payload.deviceId || '';
    return next();
  } catch (err) {
    log('error', '鉴权中间件异常：', err.message);
    return fail(res, 500, MSG.SERVER_ERROR);
  }
}

/**
 * 管理员鉴权中间件：必须登录 + 学号命中后端白名单
 */
function adminAuth(req, res, next) {
  const user = req.user;
  if (!user) {
    return fail(res, 401, CODE_MSG[401]);
  }
  if (!isAdminStudent(user.student_id)) {
    return fail(res, 403, MSG.NO_PERMISSION);
  }
  req.isAdmin = true;
  return next();
}

module.exports = {
  auth,
  adminAuth,
  getAdminStudentIds,
  isAdminStudent,
  roleTagOf,
  extractToken
};
