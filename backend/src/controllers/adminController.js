/**
 * =====================================================================
 * 管理员控制器（管理员后台）
 * ---------------------------------------------------------------------
 * 权限：路由层统一挂载 auth + adminAuth，
 *      管理员身份只认后端 .env ADMIN_STUDENT_IDS 学号白名单（绝不读 users.is_admin）
 * 功能：
 *   1. 用户列表          GET  /api/admin/userList
 *      （管理员可见完整手机号；可对任意用户执行资料修改）
 *   2. 修改用户资料      POST /api/admin/updateUser
 *      （昵称 / 姓名 / 手机号 / 学号 / 校园认证状态 / 头像，改完自动推送站内消息）
 *   3. 重置登录密码      POST /api/admin/resetUserPassword
 *      （可手动指定新密码，留空则由系统生成 8 位随机密码返回给管理员，改完自动推送站内消息）
 *   4. 封禁管理列表      GET  /api/admin/banList
 *      （关键词搜索同时命中「已封禁」与「未封禁」用户，未封禁的也能直接一键封禁）
 *   5. 封禁 / 加时       POST /api/admin/banUser
 *   6. 解除封禁          POST /api/admin/unbanUser
 *   7. 注销账号          POST /api/admin/deactivateUser
 *      （不可恢复：释放手机号 / 学号、清空隐私资料、账号不可再登录，历史任务与账单记录保留）
 *   8. 订单管理          GET  /api/admin/searchTask
 *      （按订单号 / 任务ID / 学号 / 手机号 / 账号ID 搜索订单，返回任务完整详情与双方资料）
 *   9. 编辑订单          POST /api/admin/updateTask
 *      （管理员修正订单资料与酬金；白名单字段、参数化查询、事务 + 乐观锁、改完推送站内消息）
 * =====================================================================
 */

const db = require('../db/db');
const User = require('../models/User');
const Task = require('../models/Task');
const Bill = require('../models/Bill');
const Message = require('../models/Message');
const AuditApply = require('../models/AuditApply');
// 服务费退费复用「任务控制器」中已经过完整测试的退费通道（管理员删除待接单任务时自动退费），
// 避免再写一套退款逻辑导致两条链路口径不一致（正式模式的微信退款接口只在那一处调用）
const { refundServiceFee } = require('./taskController');
const {
  ok, BizError, assertParams, parsePage, buildPage, checkIdempotent, formatUserId, maskPhone, log,
  hashParams, isPhone, generatePassword, parseMoney
} = require('../utils/common');
// 重置密码时同样走 bcrypt 哈希，数据库永远不出现明文密码
const { hashPassword } = require('../utils/bcryptUtil');
const {
  MSG, BIZ, MSG_TYPE_ENUM, BAN_DURATION_ENUM, BAN_CUSTOM_UNITS, TASK_STATUS_ENUM, TASK_STATUS,
  BAN_STATUS, BAN_STATUS_ENUM, CAMPUS_AUDIT, CAMPUS_AUDIT_ENUM,
  AVATAR_AUDIT_ENUM, AUDIT_APPLY_TYPE_ENUM, AUDIT_STATUS_ENUM,
  NICKNAME_COUNT_UNLIMITED, getText, formatText
} = require('../utils/constant');
const { isAdminStudent } = require('../utils/adminUtil');

/**
 * 预设封禁时长 -> 6 个时间单位（年/月/日/时/分/秒）的映射
 * key 与 constant.js 的 BAN_DURATION 一一对应，前端只传 key，具体数值由后端决定
 */
const PRESET_DURATION = {
  [BAN_DURATION_ENUM.MIN5]: { minute: 5 },
  [BAN_DURATION_ENUM.MIN15]: { minute: 15 },
  [BAN_DURATION_ENUM.MIN30]: { minute: 30 },
  [BAN_DURATION_ENUM.HOUR1]: { hour: 1 },
  [BAN_DURATION_ENUM.HOUR2]: { hour: 2 },
  [BAN_DURATION_ENUM.DAY1]: { day: 1 }
};

/**
 * 自定义封禁时长每个单位的允许上限
 * 目的：防止传入超大数值把封禁截止时间算到几百上千年后（属于非法输入）
 */
const CUSTOM_LIMIT = {
  year: 10,
  month: 120,
  day: 3650,
  hour: 87600,
  minute: 5256000,
  second: 315360000
};

/**
 * 归一化并校验封禁时长
 *   1. 预设档位：直接映射为固定时间单位（5分钟/15分钟/30分钟/1小时/2小时/1天）
 *   2. 自定义：年 / 月 / 日 / 时 / 分 / 秒，每一项最小为 0，**不填（留空）即视为 0**，
 *      但至少要有一项大于 0，否则视为非法时长
 * @param {string} durationType 预设档位 key（custom 表示自定义）
 * @param {object} custom 自定义时间单位 { year, month, day, hour, minute, second }
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 * @throws {BizError} 参数非法时抛出友好提示
 */
function normalizeDuration(durationType, custom) {
  const type = String(durationType || '').trim();
  if (!type) throw new BizError(MSG.BAN_DURATION_REQUIRED, 400);

  if (type !== BAN_DURATION_ENUM.CUSTOM) {
    const preset = PRESET_DURATION[type];
    if (!preset) throw new BizError(MSG.BAN_DURATION_INVALID, 400);
    return Object.assign({ year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }, preset);
  }

  const source = custom && typeof custom === 'object' ? custom : {};
  const duration = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  BAN_CUSTOM_UNITS.forEach((unit) => {
    const raw = source[unit];
    // 不填（空串 / null / undefined）=> 该项为 0（即「无」）
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    const value = Number(String(raw).trim());
    if (!Number.isInteger(value) || value < 0) {
      throw new BizError('自定义封禁时长必须为不小于0的整数', 400);
    }
    if (value > CUSTOM_LIMIT[unit]) throw new BizError('自定义封禁时长超出允许范围', 400);
    duration[unit] = value;
  });

  const total = BAN_CUSTOM_UNITS.reduce((sum, unit) => sum + duration[unit], 0);
  if (total <= 0) throw new BizError(MSG.BAN_DURATION_INVALID, 400);
  return duration;
}

/**
 * 解析目标用户：优先使用 userId，其次按 账号ID / 学号 / 手机号 / 昵称 / 姓名 精确定位
 * @param {object} conn 事务连接
 * @param {number|null} userId 用户主键
 * @param {string} keyword 关键词
 * @returns {Promise<object>} 用户行
 */
async function resolveTargetUser(conn, userId, keyword) {
  if (userId) {
    const target = await User.findByIdForUpdate(userId, conn);
    if (!target) throw new BizError(MSG.BAN_USER_NOT_FOUND, 400);
    return target;
  }
  if (!keyword) throw new BizError('请先选择或搜索要操作的用户', 400);
  const rows = await User.findByKeyword(keyword, conn);
  if (!rows.length) throw new BizError(MSG.BAN_USER_NOT_FOUND, 400);
  if (rows.length > 1) throw new BizError('匹配到多个用户，请输入完整的账号ID / 学号 / 手机号', 409);
  return rows[0];
}

/**
 * 管理员视角的用户信息（userList / userDetail 共用，保证两个入口的字段口径完全一致）
 * 与用户端 toSafeUser 的唯一差别：
 *   1) 下发完整手机号（管理员核对身份、联系当事人需要），同时保留 phoneMasked 供脱敏展示；
 *   2) 昵称剩余修改次数按管理员规则下发。
 * @param {object} item users 表整行
 * @returns {object} 可直接下发给前端的用户对象
 */
function toAdminUserVO(item) {
  const isAdmin = isAdminStudent(item.student_id);
  const vo = User.toSafeUser(item, isAdmin);
  // 【管理员后台专用】这里下发完整手机号，方便管理员核对身份、联系当事人。
  // 用户端接口（/api/user/info 等）依旧走 toSafeUser 的 maskPhone 脱敏，两者互不影响。
  vo.phoneMasked = vo.phone;
  // 已注销账号的手机号在注销时已被改写为占位值，这里不回传占位值，统一留空
  vo.phone = vo.isDeactivated ? '' : item.phone;
  // 昵称剩余修改次数：管理员账号不受次数限制，统一下发 NICKNAME_COUNT_UNLIMITED(-1) 供前端展示为「不限」
  vo.nicknameModifyCount = isAdmin ? NICKNAME_COUNT_UNLIMITED : Number(item.nickname_modify_count || 0);
  return vo;
}

/**
 * GET /api/admin/userList 获取全部用户列表（支持关键词搜索）
 */
async function userList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
    // 已注销账号默认隐藏：列表只保留正常账号，需要追溯时前端打开「显示已注销」开关
    const includeDeactivated = String(req.query.includeDeactivated || '') === 'true'
      || String(req.query.includeDeactivated || '') === '1';
    const { list, total } = await User.listUsers({ keyword, includeDeactivated, offset, limit: pageSize });
    return ok(res, buildPage(list.map(toAdminUserVO), total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/admin/userDetail 查看指定用户的完整信息（管理员专用）
 * ---------------------------------------------------------------------
 * 场景：举报 / 审核 / 封禁等列表里点击「用户 mini 卡片」，直接看到该用户的全部信息，
 *      不必再切到「用户管理」页重新搜索。字段与 userList 共用同一映射函数，口径完全一致。
 * 入参：userId（内部主键 user_id）
 * 说明：本接口只读；任何修改仍然必须走 updateUser / banUser 等既有通道（同样有管理员白名单校验）。
 */
async function userDetail(req, res, next) {
  try {
    assertParams(req.query, [{ name: 'userId', label: '用户ID' }]);
    const userId = Number(req.query.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new BizError(MSG.PARAM_ERROR, 400);
    const user = await User.findById(userId);
    if (!user) throw new BizError(MSG.ADMIN_USER_NOT_FOUND, 404);
    return ok(res, toAdminUserVO(user), '获取成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/admin/banList 封禁管理列表
 *   - 关键词搜索：账号ID / 学号 / 手机号 / 昵称 / 姓名 / 主键ID（模糊匹配，全部参数化）
 *     搜索时**同时返回被封禁与未被封禁的用户**，管理员可直接对搜索结果里任意一个
 *     用户执行封禁（未封禁的人也能一键封禁），封禁中的排在前面；
 *   - 不输关键词：只返回正在封禁中的用户（即「当前封禁名单」）
 *   - 排序：封禁中的按封禁截止时间倒序（剩余时长最长的排在最前面，一行一排）
 *   - 封禁状态与剩余封禁时长均由后端统一计算下发，避免前端各算一套导致显示不一致
 */
async function banList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
    const { list, total } = await User.listBanManage({ keyword, offset, limit: pageSize });

    const bans = list.map((item) => {
      const banned = User.isBannedFromTaking(item);
      const banStatus = banned ? BAN_STATUS_ENUM.BANNED : BAN_STATUS_ENUM.NORMAL;
      return {
        userId: item.id,
        accountNo: item.account_no || '',
        userIdText: formatUserId(item.id, item.account_no),
        nickname: item.nickname,
        name: item.name,
        studentId: item.student_id,
        phone: maskPhone(item.phone),
        isAdmin: isAdminStudent(item.student_id),
        // 封禁状态：0 未封禁 / 1 封禁中（前端据此决定展示「封禁」还是「加时 / 解封」）
        isBanned: banned,
        banStatus,
        banStatusText: getText(BAN_STATUS, banStatus),
        banReason: item.ban_reason || '',
        banOperatorId: item.ban_operator_id || null,
        banCreatedAt: item.ban_created_at || null,
        banEndTime: item.ban_take_time || null,
        banRemainSeconds: banned ? User.banRemainSeconds(item) : 0
      };
    });

    return ok(res, buildPage(bans, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/banUser 封禁 / 加时
 * ---------------------------------------------------------------------
 * 请求体：
 *   userId       目标用户主键（与 keyword 二选一）
 *   keyword      账号ID / 学号 / 手机号（与 userId 二选一）
 *   durationType 预设档位：5m / 15m / 30m / 1h / 2h / 1d / custom
 *   custom       自定义时长：{ year, month, day, hour, minute, second }（空 = 0 = 该项不设置）
 *   reason       封禁原因（可选，最长 200 字）
 * 加时语义：若该用户当前已在封禁中，则在「原封禁截止时间」上继续累加（由模型层 SQL 保证）
 * 幂等：同一管理员 3 秒内对同一用户重复提交返回 409
 */
async function banUser(req, res, next) {
  try {
    const admin = req.user;
    const rawUserId = req.body.userId;
    const userId = rawUserId === undefined || rawUserId === null || String(rawUserId).trim() === ''
      ? null : Number(rawUserId);
    if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
      throw new BizError('用户ID不合法', 400);
    }
    const keyword = req.body.keyword ? String(req.body.keyword).trim() : '';
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    const duration = normalizeDuration(req.body.durationType, req.body.custom);

    // 防连点：同一个管理员 + 同一目标用户 + 同一时长档位，3 秒内只允许提交一次
    // 说明：放在参数校验之后，保证「参数非法」先返回 400，不会被幂等键掩盖成 409
    if (!checkIdempotent(`banUser:${admin.id}:${userId || keyword}:${req.body.durationType}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const target = await resolveTargetUser(conn, userId, keyword);

      // 安全红线：管理员账号不允许被封禁（权限判定始终以学号白名单为准）
      if (isAdminStudent(target.student_id) || target.id === admin.id) {
        throw new BizError(MSG.BAN_ADMIN_SELF, 403);
      }

      const isExtension = !!target.ban_take_time && new Date(target.ban_take_time).getTime() > Date.now();

      await User.banTakeByDuration(target.id, duration, {
        adminUserId: admin.id,
        reason: reason || (isExtension ? '管理员加时' : '管理员封禁')
      }, conn);

      const fresh = await User.findById(target.id, conn);
      const remainSeconds = User.banRemainSeconds(fresh);

      // 站内消息：告知被操作用户封禁结果与解禁时间
      await Message.create({
        userId: target.id,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: isExtension ? '接单封禁已加时' : '接单权限已被封禁',
        content: `管理员${isExtension ? '延长了您的接单封禁时间' : '封禁了您的接单权限'}，`
          + `解禁时间：${fresh.ban_take_time}（约剩余${Math.ceil(remainSeconds / 60)}分钟）。`
          + (reason ? `原因：${reason}` : '')
          + '封禁期间无法接单，如有疑问可在「申诉」中提交申诉。'
      }, conn);

      return {
        userId: target.id,
        userIdText: formatUserId(target.id, target.account_no),
        nickname: target.nickname,
        studentId: target.student_id,
        isExtension,
        banEndTime: fresh.ban_take_time,
        banRemainSeconds: remainSeconds
      };
    });

    log('info', `[管理员操作] ${admin.id} ${result.isExtension ? '加时封禁' : '封禁'}用户 ${result.userId}，解禁时间 ${result.banEndTime}`);
    return ok(res, result, result.isExtension ? '已加时' : '封禁成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/unbanUser 解除封禁
 * 幂等：用户当前不在封禁中时返回 409 友好提示，不做任何写入
 */
async function unbanUser(req, res, next) {
  try {
    assertParams(req.body, [{ name: 'userId', label: '用户ID' }]);
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new BizError('用户ID不合法', 400);

    const result = await db.transaction(async (conn) => {
      const target = await User.findByIdForUpdate(userId, conn);
      if (!target) throw new BizError(MSG.BAN_USER_NOT_FOUND, 400);
      if (!target.ban_take_time || new Date(target.ban_take_time).getTime() <= Date.now()) {
        throw new BizError(MSG.BAN_RECORD_NOT_FOUND, 409);
      }

      await User.unbanUser(userId, conn);
      await Message.create({
        userId,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '接单权限已解禁',
        content: '管理员已解除您的接单封禁，现在可以正常接单了。'
      }, conn);

      return { userId, userIdText: formatUserId(userId, target.account_no) };
    });

    log('info', `[管理员操作] ${req.user.id} 解封用户 ${userId}`);
    return ok(res, result, '已解封');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/updateUser 管理员直接修改任意用户的账号资料
 * ---------------------------------------------------------------------
 * 请求体（按需传，不传的字段一律不改）：
 *   userId          目标用户主键（必填）
 *   nickname        昵称（1-30 字，管理员直接生效，不消耗「昵称修改次数」）
 *   name            真实姓名（1-20 字）
 *   phone           登录手机号（11 位，全局唯一）
 *   studentId       学号（4-20 位字母/数字，全局唯一；不允许占用管理员白名单学号）
 *   isCampusAudit   校园认证状态 0无申请 / 1待审核 / 2通过 / 3已驳回
 *   avatar          头像图片地址（管理员直接指定，视为审核通过）
 *
 * 【安全设计】
 *   1. 权限只认路由层 adminAuth 的学号白名单，本函数不读任何前端传入的身份字段；
 *   2. 所有校验与写入都在同一个事务 + 行锁内完成，避免并发改出脏数据；
 *   3. 字段写入走 User.ADMIN_EDITABLE_FIELDS 固定白名单，参数化查询，杜绝 SQL 注入；
 *   4. 【防提权红线】任何账号的学号都不允许被改成管理员白名单里的学号，
 *      否则等于凭空制造出一个管理员；管理员账号自身的学号同样锁定不可改；
 *   5. 修改成功后自动向该用户推送「管理员修改了某项信息」的站内消息，全程留痕可追溯。
 */
async function updateUser(req, res, next) {
  try {
    const admin = req.user;
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new BizError('用户ID不合法', 400);

    // 幂等：同一管理员 3 秒内提交完全相同的修改内容视为连点，直接拦截
    if (!checkIdempotent(`adminUpdateUser:${admin.id}:${userId}:${hashParams(req.body)}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // ---------------- 1. 逐字段清洗（写库前完成全部格式校验，拒绝脏数据进库） ----------------
    const fields = {};

    if (req.body.nickname !== undefined) {
      const nickname = String(req.body.nickname).trim();
      if (!nickname || nickname.length > 30) throw new BizError(MSG.NICKNAME_INVALID, 400);
      fields.nickname = nickname;
    }
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name || name.length > 20) throw new BizError(MSG.NAME_INVALID, 400);
      fields.name = name;
    }
    if (req.body.phone !== undefined) {
      const phone = String(req.body.phone).trim();
      if (!isPhone(phone)) throw new BizError(MSG.PHONE_INVALID, 400);
      fields.phone = phone;
    }
    if (req.body.studentId !== undefined) {
      const studentId = String(req.body.studentId).trim();
      if (!/^[A-Za-z0-9]{4,20}$/.test(studentId)) throw new BizError(MSG.STUDENT_ID_INVALID, 400);
      if (isAdminStudent(studentId)) throw new BizError(MSG.STUDENT_ID_RESERVED, 403);
      fields.student_id = studentId;
    }
    if (req.body.isCampusAudit !== undefined && String(req.body.isCampusAudit).trim() !== '') {
      const status = Number(req.body.isCampusAudit);
      if (![CAMPUS_AUDIT_ENUM.NONE, CAMPUS_AUDIT_ENUM.PENDING, CAMPUS_AUDIT_ENUM.PASS, CAMPUS_AUDIT_ENUM.REJECT].includes(status)) {
        throw new BizError('校园认证状态不合法', 400);
      }
      fields.is_campus_audit = status;
    }
    if (req.body.avatar !== undefined) {
      const avatar = String(req.body.avatar).trim();
      if (avatar.length > 255) throw new BizError(MSG.AVATAR_INVALID, 400);
      // 只接受「本地上传目录的相对地址」或「http(s) 绝对地址」，防止写入任意脚本字符串
      if (avatar && avatar.indexOf('/uploads/') !== 0 && !/^https?:\/\//.test(avatar)) {
        throw new BizError(MSG.AVATAR_INVALID, 400);
      }
      fields.avatar = avatar;
      // 管理员直接指定头像 = 免审核，同时把头像审核状态置为「审核通过」
      fields.is_avatar_audit = avatar ? AVATAR_AUDIT_ENUM.PASS : AVATAR_AUDIT_ENUM.NONE;
    }

    const result = await db.transaction(async (conn) => {
      // 行锁读取目标用户，避免与用户本人的操作并发交叉
      const target = await User.findByIdForUpdate(userId, conn);
      if (!target) throw new BizError(MSG.ADMIN_USER_NOT_FOUND, 400);

      // 管理员账号的学号是权限锚点，改掉会直接丢失管理员权限，因此单独锁定
      if (isAdminStudent(target.student_id)
        && fields.student_id !== undefined && fields.student_id !== target.student_id) {
        throw new BizError(MSG.ADMIN_STUDENT_ID_LOCKED, 403);
      }

      // 变更明细：既用于生成站内消息，也用于「没有任何修改」的拦截
      const changes = [];

      // ---- 手机号唯一性 ----
      if (fields.phone !== undefined && fields.phone !== target.phone) {
        const occupiedPhone = await User.findByPhoneExcept(fields.phone, userId, conn);
        if (occupiedPhone) throw new BizError(MSG.PHONE_ALREADY_USED, 409);
        changes.push({ field: 'phone', label: '手机号', before: target.phone, after: fields.phone });
      }

      // 修改完成后的校园认证状态（可能本次没改，沿用原值参与学号唯一性判断）
      const finalCampusAudit = fields.is_campus_audit === undefined
        ? Number(target.is_campus_audit) : Number(fields.is_campus_audit);

      // ---- 学号唯一性：认证通过的账号之间不允许学号重复 ----
      if (fields.student_id !== undefined && fields.student_id !== target.student_id) {
        if (finalCampusAudit === CAMPUS_AUDIT_ENUM.PASS) {
          const occupiedStudent = await User.findCertifiedByStudentId(fields.student_id, userId, conn);
          if (occupiedStudent) throw new BizError(MSG.STUDENT_ID_CERTIFIED, 409);
        }
        changes.push({ field: 'studentId', label: '学号', before: target.student_id, after: fields.student_id });
      }

      if (fields.nickname !== undefined && fields.nickname !== target.nickname) {
        changes.push({ field: 'nickname', label: '昵称', before: target.nickname, after: fields.nickname });
      }
      if (fields.name !== undefined && fields.name !== target.name) {
        changes.push({ field: 'name', label: '姓名', before: target.name, after: fields.name });
      }
      if (fields.is_campus_audit !== undefined && Number(target.is_campus_audit) !== finalCampusAudit) {
        changes.push({
          field: 'isCampusAudit',
          label: '校园认证状态',
          before: getText(CAMPUS_AUDIT, target.is_campus_audit),
          after: getText(CAMPUS_AUDIT, finalCampusAudit)
        });
      }
      if (fields.avatar !== undefined && fields.avatar !== (target.avatar || '')) {
        changes.push({
          field: 'avatar',
          label: '头像',
          before: target.avatar ? '原头像' : '未设置',
          after: fields.avatar ? '新头像' : '已清空'
        });
      }

      if (!changes.length) throw new BizError(MSG.ADMIN_USER_NO_CHANGE, 409);

      // 管理员直改校园认证状态时，同步收尾该用户遗留的「待审核」认证申请，保持审核列表与用户状态一致
      if (fields.is_campus_audit !== undefined) {
        if (finalCampusAudit === CAMPUS_AUDIT_ENUM.PASS) {
          await AuditApply.resolvePending(
            userId, AUDIT_APPLY_TYPE_ENUM.CAMPUS, AUDIT_STATUS_ENUM.PASS, '', conn
          );
        } else if (finalCampusAudit === CAMPUS_AUDIT_ENUM.REJECT) {
          await AuditApply.resolvePending(
            userId, AUDIT_APPLY_TYPE_ENUM.CAMPUS, AUDIT_STATUS_ENUM.REJECT, '管理员直接驳回', conn
          );
        }
      }

      await User.updateProfileByAdmin(userId, fields, conn);

      // 站内消息：逐项列出被修改的内容，让用户第一时间知晓账号变动
      const detail = changes.map((item) => `${item.label}「${item.before}」→「${item.after}」`).join('；');
      await Message.create({
        userId,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '账号信息已被管理员修改',
        content: (`管理员修改了您的${changes.map((item) => item.label).join('、')}。`
          + `修改明细：${detail}。如非本人操作或有疑问，可在「申诉」中提交反馈。`).slice(0, 500)
      }, conn);

      return {
        userId,
        userIdText: formatUserId(userId, target.account_no),
        changes
      };
    });

    log('info', `[管理员操作] ${admin.id} 修改用户 ${result.userId} 资料：`
      + result.changes.map((item) => item.label).join('、'));
    return ok(res, result, '已保存，并已通知该用户');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/resetUserPassword 管理员重置任意用户的登录密码
 * ---------------------------------------------------------------------
 * 请求体：
 *   userId       目标用户主键（必填）
 *   newPassword  新密码（选填，6-20 位）
 *                - 不传或传空：后端自动生成一个 8 位随机密码并在响应里返回，方便管理员转达给用户
 *                - 传了：按管理员指定的密码重置
 *
 * 【安全设计】
 *   1. 权限只认路由层 adminAuth 的学号白名单，本函数不读任何前端传入的身份字段；
 *   2. 密码先 bcrypt 哈希再进事务写库，数据库绝不出现明文密码（哈希在事务外完成，避免长时间持锁）；
 *   3. 重置的同时清零密码错误次数 + 解除登录锁定 + 清空设备标识，
 *      因此旧设备上的 access_token 会立即失效，必须用新密码重新登录（与「忘记密码」同一套收尾动作）；
 *   4. 幂等：同一管理员 3 秒内提交完全相同的请求视为连点，直接拦截；
 *   5. 随机密码只在响应里返回给操作的管理员，绝不写日志、绝不下发给其他用户。
 */
async function resetUserPassword(req, res, next) {
  try {
    const admin = req.user;
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new BizError('用户ID不合法', 400);

    // 幂等：防止管理员连点导致密码被反复重置
    if (!checkIdempotent(`adminResetPwd:${admin.id}:${userId}:${hashParams(req.body)}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // 是否由管理员手动指定密码（留空则自动生成）
    const raw = req.body.newPassword === undefined || req.body.newPassword === null
      ? '' : String(req.body.newPassword);
    const manual = raw.trim() !== '';
    const password = manual ? raw : generatePassword(8);
    if (manual && (password.length < 6 || password.length > 20)) {
      throw new BizError(MSG.PASSWORD_INVALID, 400);
    }

    // 哈希放在事务外：bcrypt 约需几十毫秒，避免长时间占用行锁
    const passwordHash = await hashPassword(password);

    const result = await db.transaction(async (conn) => {
      const target = await User.findByIdForUpdate(userId, conn);
      if (!target) throw new BizError(MSG.ADMIN_USER_NOT_FOUND, 400);

      await User.resetPasswordByAdmin(userId, passwordHash, conn);

      // 站内消息：明确告知「密码被管理员重置」，并指引自助改密入口
      await Message.create({
        userId,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '登录密码已被管理员重置',
        content: '管理员重置了您的登录密码。为保障账号安全，您当前的所有设备已退出登录，'
          + '请使用管理员提供的新密码重新登录；如需自行修改，可在登录页点击「忘记密码」，'
          + '通过手机号 + 短信验证码重新设置。如非本人申请，请在「申诉」中提交反馈。'
      }, conn);

      return {
        userId,
        userIdText: formatUserId(userId, target.account_no),
        nickname: target.nickname,
        // 返回给操作管理员，用于转达给该用户；自动生成时前端会提示复制
        password,
        autoGenerated: !manual
      };
    });

    // 日志只记录「谁重置了谁的密码」，绝不记录密码内容
    log('info', `[管理员操作] ${admin.id} 重置用户 ${result.userId} 的登录密码（${manual ? '手动指定' : '系统随机生成'}）`);
    return ok(res, result, '密码已重置，并已通知该用户');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/deactivateUser 管理员注销任意用户账号（不可恢复）
 * ---------------------------------------------------------------------
 * 请求体：userId 目标用户主键（必填）
 *
 * 【安全设计】
 *   1. 权限只认路由层 adminAuth 的学号白名单，本函数不读任何前端传入的身份字段；
 *   2. 禁止注销管理员账号（白名单学号账号），避免把系统管理入口注销后无人可管；
 *   3. 禁止管理员注销自己（即使将来出现多个管理员，也要换一个管理员操作，避免误伤）；
 *   4. 幂等：同一管理员 3 秒内对同一用户重复提交直接拦截。
 *
 * 【注销效果】见 models/User.deactivate()：
 *   手机号 / 学号释放、密码失效、隐私资料清空、旧 token 立即失效；
 *   历史任务 / 账单 / 举报记录保留，供对方当事人继续查看。
 *
 * 【为什么不下发站内消息】
 *   账号注销后已无法登录，消息中心也再不可达；此处仅记录服务端日志作为审计留痕，
 *   避免在数据库里写入永远不会被读取的死数据。
 */
async function deactivateUser(req, res, next) {
  try {
    const admin = req.user;
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || userId <= 0) throw new BizError('用户ID不合法', 400);

    // 幂等：防止管理员连点导致重复处理
    if (!checkIdempotent(`adminDeactivate:${admin.id}:${userId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      const target = await User.findByIdForUpdate(userId, conn);
      if (!target) throw new BizError(MSG.ADMIN_USER_NOT_FOUND, 400);
      if (User.isDeactivatedUser(target)) throw new BizError(MSG.ACCOUNT_DEACTIVATED_ALREADY, 409);
      if (isAdminStudent(target.student_id)) throw new BizError(MSG.DEACTIVATE_ADMIN_FORBIDDEN, 403);
      if (target.id === admin.id) throw new BizError(MSG.DEACTIVATE_SELF_FORBIDDEN, 403);

      const snapshot = {
        userId: target.id,
        userIdText: formatUserId(target.id, target.account_no),
        nickname: target.nickname,
        studentId: target.student_id
      };

      const affected = await User.deactivate(target.id, conn);
      if (!affected) throw new BizError(MSG.ACCOUNT_DEACTIVATED_ALREADY, 409);
      return snapshot;
    });

    log('info', `[管理员操作] ${admin.id} 注销用户 ${result.userId}（${result.userIdText} / ${result.studentId}）`);
    return ok(res, result, '账号已注销');
  } catch (err) {
    return next(err);
  }
}

/**
 * 管理员删除任务时的服务费结算（必须在删除事务内调用）
 * ---------------------------------------------------------------------
 * 规则：删除「待接单」任务时自动退费。
 *   1. 仅 status = 0（待接单）的任务自动退费：
 *      进行中 / 待雇主确认 / 已完成 / 已撤销的任务，平台服务已经实际发生，不自动退费；
 *   2. 退费复用 taskController.refundServiceFee 的既有通道：正式模式会调用微信退款接口，
 *      成功后退款流水置为「已退款」、任务 is_refunded = 1，与雇主自助退费口径完全一致；
 *      额外传 skipEligibility = true —— 管理员属于强制下架，不受「24 小时 / 曾被接单」限制，
 *      但「已退费不重复退」「免费代拿未实际付费无需退」两条底线依然生效；
 *   3. 免费代拿权益：任务用免费代拿权益发布（service_fee = 0）且从未被任何人接单时，
 *      删除任务的同时把 1 次免费代拿次数返还到账号（与雇主主动撤销的处理口径一致）。
 * @param {object} conn 事务连接
 * @param {object} task 任务行（事务内加锁读到的原始行）
 * @returns {Promise<{refund:{refunded:boolean, amount?:number, reason?:string}, freeDeliveryReturned:boolean}>}
 */
async function settleServiceFeeOnDelete(conn, task) {
  // 非待接单任务：不自动退费，原因会写入站内消息，管理员在响应里也能看到
  if (Number(task.status) !== TASK_STATUS_ENUM.WAIT_TAKE) {
    return {
      refund: { refunded: false, reason: '任务不是待接单状态，服务费不退回' },
      freeDeliveryReturned: false
    };
  }

  // 免费代拿权益返还：乐观锁占位成功后再给账号加次数，两步在同一事务内完成。
  // 条件：用了免费权益发布 + 从未被任何人接单（once_taken=0）+ 尚未返还过；
  // 只要有人接过单，once_taken 已永久为 1，此处必然占位失败 -> 不返还。
  let freeDeliveryReturned = false;
  if (Number(task.is_free_delivery) === 1) {
    const marked = await Task.markFreeDeliveryReturned(task.id, conn);
    if (marked > 0) {
      await User.returnFreeDelivery(task.user_id, conn);
      freeDeliveryReturned = true;
    }
  }

  const refund = await refundServiceFee(conn, task, '管理员删除待接单任务自动退费', {
    skipEligibility: true
  });
  return { refund, freeDeliveryReturned };
}

/**
 * POST /api/admin/deleteTask 管理员删除任务（软删除，用于处置有问题 / 违规的任务）
 * ---------------------------------------------------------------------
 * 【权限】放在管理员路由组下，路由层统一挂载 auth + adminAuth，
 *   管理员身份只认后端 .env ADMIN_STUDENT_IDS 硬编码学号白名单（绝不读 users.is_admin）；
 *   普通用户（包括该任务的雇主与接单人）无论前端怎么改都调不到本接口。
 *
 * 【删除效果】见 models/Task.softDelete：
 *   1. tasks.is_deleted = 1，任务从「任务大厅 / 我的发布 / 我的任务」全部消失；
 *   2. 全部流转操作（接单 / 取消接单 / 编辑 / 加酬金 / 送达 / 确认 / 扣酬金 / 投诉 /
 *      撤销 / 退费）都会被 assertTaskNotDeleted 拦截，删除即冻结，
 *      不会出现「已经删掉了但还在被接单 / 还在跑」的中间态；
 *   3. 数据保留：支付流水、账单、举报记录与任务本身都不物理删除，
 *      管理员处置留痕可追溯；账单点进详情仍能看到该任务与「已被管理员删除」提示。
 *
 * 【消息通知】强制下架必须让当事人知情，删除成功后同事务推送站内消息：
 *   - 雇主（任务发布人）：告知任务已被删除 + 删除原因（若有）+ 可通过申诉联系管理员；
 *   - 接单人（若任务已被接单）：告知无需继续配送。
 *   消息类型使用「管理员消息」（msgType = 2），消息中心可按分类查看。
 *
 * 【幂等】checkIdempotent 防连点 + softDelete 的 WHERE is_deleted = 0 乐观锁双重保证：
 *   同一任务重复删除时，第二次直接返回 409「该任务已被管理员删除，请勿重复操作」。
 *
 * 【自动退费】删除「待接单」任务时服务费自动原路退回（详见 settleServiceFeeOnDelete）：
 *   - 仅 status = 0 待接单的任务退费；进行中 / 待确认 / 已完成的任务服务已实际发生，不退；
 *   - 复用雇主自助退费的同一通道（正式模式含微信退款接口调用、流水置为已退款、任务标记已退费），
 *     但管理员属于强制下架，不受「24 小时 / 曾被接单」限制，
 *     「已退费不重复退」「免费代拿未实际付费无需退」两条底线依然生效；
 *   - 用免费代拿权益发布的待接单任务，删除时自动返还 1 次免费代拿次数。
 *   （雇主主动撤销仍走「任务详情 - 撤销 - 申请退费」的正常通道，两条链路互不影响。）
 */
async function deleteTask(req, res, next) {
  try {
    const admin = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法', 400);
    // 删除原因选填：统一截断到字典规定的长度上限，避免超出 tasks.delete_reason 列宽
    const reason = String(req.body.reason || '').trim().slice(0, BIZ.TASK_DELETE_REASON_MAX);

    // 防连点：同一管理员 3 秒内对同一任务重复提交直接拦截
    if (!checkIdempotent(`adminDeleteTask:${admin.id}:${taskId}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    const result = await db.transaction(async (conn) => {
      // 加行锁读取：与「删除」写操作同事务，避免并发下重复删除
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      if (Number(task.is_deleted) === 1) throw new BizError(MSG.TASK_ALREADY_DELETED, 409);

      // 乐观锁：WHERE id = ? AND is_deleted = 0，0 行表示已被其他管理员删除
      const affected = await Task.softDelete(taskId, admin.id, reason, conn);
      if (affected === 0) throw new BizError(MSG.TASK_ALREADY_DELETED, 409);

      const orderNo = task.order_no || '';
      const reasonText = reason ? `删除原因：${reason}。` : '';

      // ---------------- 待接单任务自动退费 ----------------
      // 任务被强制下架，雇主并没有享受到平台服务，因此服务费自动原路退回；
      // 非待接单任务不自动退费，原因写进返回值与站内消息，避免出现「钱去哪了」的疑问。
      const settlement = await settleServiceFeeOnDelete(conn, task);
      const refundText = settlement.refund.refunded
        ? `本次信息服务费${settlement.refund.amount}元已原路退回。`
        : (settlement.freeDeliveryReturned
          ? '本次使用的 1 次免费代拿权益已返还到您的账号。'
          : `本次未产生退费（${settlement.refund.reason}）。`);

      // 通知雇主（任务发布人）
      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '任务已被管理员删除',
        content: `您发布的订单号${orderNo}的任务已被管理员删除并下架。${reasonText}${refundText}`
          + '如有疑问，可在「我的 - 申诉」中提交申诉联系管理员。'
      }, conn);

      // 通知接单人（任务被删除时若已有人接单，跑腿员无需继续配送）
      if (task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.ADMIN,
          title: '任务已被管理员删除',
          content: `您接单的订单号${orderNo}的任务已被管理员删除，无需继续配送。`
            + '如有疑问，可在「我的 - 申诉」中提交申诉联系管理员。'
        }, conn);
      }

      return {
        taskId,
        orderNo,
        ownerUserId: task.user_id,
        takerUserId: task.taker_user_id || null,
        taskStatus: task.status,
        refund: settlement.refund,
        freeDeliveryReturned: settlement.freeDeliveryReturned
      };
    });

    log('info', `[管理员操作] ${admin.id} 删除任务 ${taskId}（订单号 ${result.orderNo}，`
      + `退费 ${result.refund.refunded ? result.refund.amount + ' 元' : '无'}）`);
    return ok(res, result, result.refund.refunded ? '任务已删除，信息服务费已原路退回' : '任务已删除');
  } catch (err) {
    return next(err);
  }
}

// ==================== 订单管理（搜索 / 编辑 / 处罚 / 删除） ====================

/**
 * 计算进行中限时任务的剩余秒数（订单管理卡片上的倒计时）
 *   - 仅「进行中 + 设置了限时 + 已接单」的任务才有倒计时，其余返回 null；
 *   - 返回负数表示已经超时，负数绝对值即超时秒数；
 *   - 倒计时由后端按统一口径下发，避免前端各算一套出现时间偏差。
 * @param {object} task 任务行
 * @returns {number|null}
 */
function computeTaskRemainSeconds(task) {
  if (!task || Number(task.status) !== TASK_STATUS_ENUM.TAKING) return null;
  if (!task.time_limit_min || !task.take_time) return null;
  const deadline = new Date(task.take_time).getTime() + Number(task.time_limit_min) * 60 * 1000;
  return Math.floor((deadline - Date.now()) / 1000);
}

/**
 * 管理员视角的订单详情视图对象
 * ---------------------------------------------------------------------
 * 搜索列表、编辑后回显、删除确认共用同一份结构，保证各处展示口径完全一致。
 * 与用户端 toTaskVO 的差别：
 *   1) 下发雇主 / 接单人**未脱敏的手机号**（管理员处罚、联系当事人时必须看到）；
 *   2) 下发 is_deleted / delete_reason / delete_time 等处置留痕字段；
 *   3) 下发 canEdit / canDelete 供前端决定按钮是否可点（前端不自行判断权限）。
 * @param {object} task tasks 联表结果（含 owner_* / taker_* / pay_status）
 * @returns {object|null}
 */
function toAdminTaskVO(task) {
  if (!task) return null;

  const buildPerson = (id, nickname, avatar, accountNo, studentId, campusAudit, phone) => {
    if (!id) return null;
    return {
      userId: Number(id),
      accountNo: accountNo || '',
      userIdText: formatUserId(Number(id), accountNo),
      nickname: nickname || '',
      avatar: avatar || '',
      studentId: studentId || '',
      phone: phone || '',
      isAdmin: isAdminStudent(studentId),
      isCertified: Number(campusAudit) === CAMPUS_AUDIT_ENUM.PASS
    };
  };

  const remainSeconds = computeTaskRemainSeconds(task);
  const isDeleted = Number(task.is_deleted) === 1;

  return {
    taskId: task.id,
    orderNo: task.order_no || '',
    status: Number(task.status),
    statusText: getText(TASK_STATUS, task.status, ''),
    // 雇主 / 接单人（接单人未接单时为 null，前端整块不渲染）
    owner: buildPerson(
      task.user_id, task.owner_nickname, task.owner_avatar, task.owner_account_no,
      task.owner_student_id, task.owner_campus_audit, task.owner_phone
    ),
    taker: buildPerson(
      task.taker_user_id, task.taker_nickname, task.taker_avatar, task.taker_account_no,
      task.taker_student_id, task.taker_campus_audit, task.taker_phone
    ),
    // 订单内容
    receiverName: task.receiver_name || '',
    receiverPhone: task.receiver_phone || '',
    pickupCode: task.pickup_code || '',
    deliverAddress: task.deliver_address || '',
    detailAddress: task.detail_address || '',
    timeLimitMin: task.time_limit_min === null || task.time_limit_min === undefined
      ? null : Number(task.time_limit_min),
    remark: task.remark || '',
    reward: Number(task.reward),
    serviceFee: Number(task.service_fee),
    isFreeDelivery: Number(task.is_free_delivery) === 1,
    // 状态与资金
    isRefunded: Number(task.is_refunded) === 1,
    onceTaken: Number(task.once_taken) === 1,
    isDisputed: Number(task.is_disputed) === 1,
    disputeReason: task.dispute_reason || '',
    isLateDelivery: Number(task.is_late_delivery) === 1,
    lateDeduct: Number(task.late_reward_deduct || 0),
    payStatus: task.pay_status === null || task.pay_status === undefined
      ? null : Number(task.pay_status),
    // 处置留痕
    isDeleted,
    deleteReason: task.delete_reason || '',
    deleteTime: task.delete_time || null,
    // 图片
    images: [task.img1, task.img2, task.img3].filter(Boolean),
    deliveryImages: Task.getDeliveryImages(task),
    // 时间轴
    publishTime: task.publish_time || null,
    takeTime: task.take_time || null,
    submitFinishTime: task.submit_finish_time || null,
    lastEditTime: task.last_edit_time || null,
    // 倒计时（null 表示不限时 / 未进行中；负数表示已超时）
    remainSeconds,
    isOvertime: remainSeconds !== null && remainSeconds < 0,
    // 可执行操作（权限统一由后端判定）
    canEdit: !isDeleted,
    canDelete: !isDeleted,
    canPunishOwner: !isDeleted && !isAdminStudent(task.owner_student_id),
    canPunishTaker: !isDeleted && !!task.taker_user_id && !isAdminStudent(task.taker_student_id)
  };
}

/**
 * GET /api/admin/searchTask 订单管理：搜索订单
 * ---------------------------------------------------------------------
 * 入参（query）：
 *   keyword  订单号 / 任务ID / 学号 / 手机号 / 账号ID / 收件人手机号（选填，不填返回全部订单）
 *   page / pageSize  分页
 * 返回：订单详情（含双方完整资料、图片、倒计时、可执行操作标记）
 * 说明：本接口只读；修改订单必须走 updateTask（同样有管理员白名单硬校验）。
 */
async function searchTask(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
    const { list, total } = await Task.searchForAdmin({ keyword, offset, limit: pageSize });
    return ok(res, buildPage(list.map(toAdminTaskVO), total, page, pageSize), '获取成功');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/updateTask 管理员编辑订单
 * ---------------------------------------------------------------------
 * 请求体（按需传，不传的字段一律不改）：
 *   taskId           目标订单主键（必填）
 *   receiverName     收件人姓名（1-20 字）
 *   receiverPhone    收件人手机号（11 位）
 *   pickupCode       取件码（选填，最长 20 字）
 *   deliverAddress   送达地址（1-100 字）
 *   detailAddress    详细地址（选填，最长 100 字）
 *   timeLimitMin     限时分钟（1-1440；传空串 / null 表示改为「不限时」）
 *   remark           任务备注（最长 200 字）
 *   reward           跑腿酬金（0.5 - 999.99 元）
 *   img1 / img2 / img3  任务图片地址（管理员可直接替换，最多 3 张）
 *
 * 【安全设计】
 *   1. 权限只认路由层 adminAuth 的学号白名单，本函数不读任何前端传入的身份字段；
 *   2. 字段写入走 Task.ADMIN_EDITABLE_FIELDS 固定白名单 + 参数化查询，
 *      status / is_deleted / once_taken / is_refunded 等流转与资金字段不可被改写；
 *   3. 事务 + 行锁：先 SELECT ... FOR UPDATE 再 UPDATE，避免并发编辑互相覆盖；
 *   4. 乐观锁：UPDATE ... WHERE id = ? AND is_deleted = 0，已被删除的订单不允许再编辑；
 *   5. 幂等：同一管理员 3 秒内提交完全相同的请求视为连点，直接拦截；
 *   6. 改完自动向雇主（以及被改到酬金时的接单人）推送站内消息；
 *   7. 若修正的是**已完成**订单的酬金，同步该订单的「任务收入」账单金额，保证对账一致。
 */
async function updateTask(req, res, next) {
  try {
    const admin = req.user;
    assertParams(req.body, [{ name: 'taskId', label: '任务ID' }]);
    const taskId = Number(req.body.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BizError('任务ID不合法', 400);

    // 幂等：同一管理员 3 秒内提交完全相同的编辑请求直接拦截（防连点导致重复推送消息）
    if (!checkIdempotent(`adminUpdateTask:${admin.id}:${taskId}:${hashParams(req.body)}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    // ---------- 1. 参数归一化与合法性校验（全部在事务外完成，避免长时间持锁） ----------
    const fields = {};
    const labels = {
      receiver_name: '收件人姓名',
      receiver_phone: '收件人手机号',
      pickup_code: '取件码',
      deliver_address: '送达地址',
      detail_address: '详细地址',
      time_limit_min: '限时',
      remark: '任务备注',
      reward: '酬金',
      img1: '任务图片',
      img2: '任务图片',
      img3: '任务图片'
    };

    if (req.body.receiverName !== undefined) {
      const value = String(req.body.receiverName || '').trim();
      if (!value || value.length > 20) throw new BizError(MSG.ADMIN_TASK_RECEIVER_INVALID, 400);
      fields.receiver_name = value;
    }
    if (req.body.receiverPhone !== undefined) {
      const value = String(req.body.receiverPhone || '').trim();
      if (!isPhone(value)) throw new BizError(MSG.ADMIN_TASK_RECEIVER_PHONE_INVALID, 400);
      fields.receiver_phone = value;
    }
    if (req.body.pickupCode !== undefined) {
      const value = String(req.body.pickupCode || '').trim();
      if (value.length > BIZ.PICKUP_CODE_MAX) throw new BizError(MSG.PICKUP_CODE_TOO_LONG, 400);
      fields.pickup_code = value;
    }
    if (req.body.deliverAddress !== undefined) {
      const value = String(req.body.deliverAddress || '').trim();
      if (!value || value.length > 100) throw new BizError(MSG.ADMIN_TASK_ADDRESS_INVALID, 400);
      fields.deliver_address = value;
    }
    if (req.body.detailAddress !== undefined) {
      const value = String(req.body.detailAddress || '').trim();
      if (value.length > BIZ.DETAIL_ADDRESS_MAX) throw new BizError(MSG.DETAIL_ADDRESS_TOO_LONG, 400);
      fields.detail_address = value;
    }
    if (req.body.timeLimitMin !== undefined) {
      const raw = req.body.timeLimitMin;
      if (raw === null || String(raw).trim() === '') {
        // 留空 = 不限时（time_limit_min 允许为 NULL）
        fields.time_limit_min = null;
      } else {
        const minutes = Number(String(raw).trim());
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new BizError(MSG.ADMIN_TASK_TIME_LIMIT_INVALID, 400);
        }
        fields.time_limit_min = minutes;
      }
    }
    if (req.body.remark !== undefined) {
      const value = String(req.body.remark || '').trim();
      if (value.length > 200) throw new BizError(MSG.ADMIN_TASK_REMARK_TOO_LONG, 400);
      fields.remark = value;
    }
    if (req.body.reward !== undefined) {
      const value = parseMoney(req.body.reward);
      if (value === null) throw new BizError(MSG.REWARD_FORMAT_ERROR, 400);
      if (value < BIZ.REWARD_MIN) throw new BizError(MSG.REWARD_TOO_LOW, 400);
      if (value > BIZ.REWARD_MAX) throw new BizError(MSG.REWARD_TOO_HIGH, 400);
      fields.reward = value;
    }
    // 任务图片：允许管理员逐张替换（不做"至少 1 张"的强制，仅做条数与长度兜底）
    ['img1', 'img2', 'img3'].forEach((key) => {
      if (req.body[key] === undefined) return;
      fields[key] = String(req.body[key] || '').trim().slice(0, 255);
    });

    if (!Object.keys(fields).length) throw new BizError(MSG.ADMIN_TASK_NO_CHANGE, 409);

    // ---------- 2. 事务内比对差异并写库 ----------
    const result = await db.transaction(async (conn) => {
      const task = await Task.findByIdForUpdate(taskId, conn);
      if (!task) throw new BizError(MSG.TASK_NOT_FOUND, 400);
      if (Number(task.is_deleted) === 1) throw new BizError(MSG.TASK_ALREADY_DELETED, 409);

      // 逐字段比对，只提交真正发生变化的字段（并生成给用户的改动明细）
      const changed = {};
      const changes = [];
      const formatValue = (key, value) => {
        if (key === 'time_limit_min') return value === null ? '不限时' : `${value}分钟`;
        if (key === 'reward') return `${Number(value).toFixed(2)}元`;
        if (key.indexOf('img') === 0) return value ? '新图片' : '已清空';
        return value === '' ? '（空）' : String(value);
      };

      Object.keys(fields).forEach((key) => {
        const before = task[key];
        const after = fields[key];
        // 图片字段只比较"是否变化"，避免把长 URL 写进消息里
        const isSame = key.indexOf('img') === 0
          ? String(before || '') === String(after || '')
          : String(before === null ? '' : before) === String(after === null ? '' : after);
        if (isSame) return;
        changed[key] = after;
        changes.push({
          field: key,
          label: labels[key],
          before: formatValue(key, before === undefined ? '' : before),
          after: formatValue(key, after)
        });
      });

      if (!changes.length) throw new BizError(MSG.ADMIN_TASK_NO_CHANGE, 409);

      const affected = await Task.updateByAdmin(taskId, changed, conn);
      if (!affected) throw new BizError(MSG.TASK_ALREADY_DELETED, 409);

      const orderNo = task.order_no || '';
      const detail = changes.map((item) => `${item.label}「${item.before}」→「${item.after}」`).join('；');
      const rewardChange = changes.find((item) => item.field === 'reward');

      // 通知雇主（订单发布人）
      await Message.create({
        userId: task.user_id,
        msgType: MSG_TYPE_ENUM.ADMIN,
        title: '订单信息已被管理员修改',
        content: (`管理员修改了您发布的订单号${orderNo}的订单信息。修改明细：${detail}。`
          + '如非本人申请或有疑问，可在「申诉」中提交反馈。').slice(0, 500)
      }, conn);

      // 酬金发生变动时，同步通知接单人（跑腿员最关心劳务酬金）
      if (rewardChange && task.taker_user_id) {
        await Message.create({
          userId: task.taker_user_id,
          msgType: MSG_TYPE_ENUM.ADMIN,
          title: '订单酬金已被管理员修改',
          content: (`您接单的订单号${orderNo}的跑腿酬金已由 ${rewardChange.before} 调整为 ${rewardChange.after}。`
            + '如有疑问，可在「申诉」中提交反馈。').slice(0, 500)
        }, conn);
      }

      // 已完成订单的酬金被修正时，同步「任务收入」账单金额，保证账单与订单对账一致
      let billSynced = false;
      if (rewardChange && Number(task.status) === TASK_STATUS_ENUM.FINISHED && task.taker_user_id) {
        const billAffected = await Bill.updateTaskIncomeAmount(
          taskId, task.taker_user_id, changed.reward, conn
        );
        billSynced = billAffected > 0;
      }

      return {
        taskId,
        orderNo,
        ownerUserId: task.user_id,
        takerUserId: task.taker_user_id || null,
        taskStatus: Number(task.status),
        changes,
        billSynced
      };
    });

    log('info', `[管理员操作] ${admin.id} 编辑订单 ${taskId}（订单号 ${result.orderNo}）：`
      + result.changes.map((item) => item.label).join('、'));
    return ok(res, result, '订单已更新，并已通知相关用户');
  } catch (err) {
    return next(err);
  }
}

/**
 * =====================================================================
 * 批量删除（管理员后台「列表清理」）
 * ---------------------------------------------------------------------
 * 为什么要有：订单 / 举报 / 申诉 / 审核 / 封禁 / 已注销账号这些列表在长期运营后
 *   会堆到几千条，逐条删除不现实，需要一个「勾选 → 全选 → 一键删除」的出口。
 * 安全约束（重要）：
 *   1. 模块白名单：只认下列 6 个模块，其它值一律 400；
 *   2. 只删「已结束」的记录：待处理 / 进行中 / 封禁中的记录一律跳过，避免误删正在流转的业务；
 *   3. 单次上限 BIZ.BATCH_DELETE_MAX 条，全部参数化查询，写操作走事务；
 *   4. 返回 done / skipped / reason，前端据此提示「删了几条、跳过了几条、为什么」。
 * =====================================================================
 */

/** 批量删除支持的模块（与管理员后台各 Tab 的「一键删除」按钮一一对应） */
const BATCH_DELETE_MODULES = ['audit', 'appeal', 'report', 'order', 'ban', 'user'];

/** 生成 IN (?, ?, ...) 占位符（ids 已在上层过滤为正整数，不存在注入风险） */
function placeholdersOf(ids) {
  return ids.map(() => '?').join(', ');
}

/**
 * 各模块的删除实现
 * 约定：返回 { done, skipped, reason }，reason 为跳过原因（无跳过时为空串）
 */
const BATCH_DELETE_HANDLERS = {
  /** 审核申请：仅删除「已通过 / 已驳回 / 已作废」的历史申请 */
  async audit(ids) {
    const result = await db.execute(
      'DELETE FROM audit_apply WHERE id IN (' + placeholdersOf(ids) + ') AND (status IN (2, 3) OR is_void = 1)',
      ids
    );
    const done = Number((result && result.affectedRows) || 0);
    return { done, skipped: ids.length - done, reason: done === 0 ? MSG.BATCH_DELETE_NONE_DONE : '' };
  },

  /** 申诉：仅删除「已回复」的申诉 */
  async appeal(ids) {
    const result = await db.execute(
      'DELETE FROM appeals WHERE id IN (' + placeholdersOf(ids) + ') AND status = 2',
      ids
    );
    const done = Number((result && result.affectedRows) || 0);
    return { done, skipped: ids.length - done, reason: done === 0 ? MSG.BATCH_DELETE_NONE_DONE : '' };
  },

  /** 举报：仅删除「已处理」的举报 */
  async report(ids) {
    const result = await db.execute(
      'DELETE FROM report WHERE id IN (' + placeholdersOf(ids) + ') AND status = 2',
      ids
    );
    const done = Number((result && result.affectedRows) || 0);
    return { done, skipped: ids.length - done, reason: done === 0 ? MSG.BATCH_DELETE_NONE_DONE : '' };
  },

  /**
   * 订单：仅删除「已完成 / 超时取消 / 雇主撤销」的订单
   * 物理删除前先清掉引用该任务的从表（账单 / 支付流水 / 举报），否则外键会拒绝删除。
   */
  async order(ids) {
    return db.transaction(async (conn) => {
      const [rows] = await conn.execute(
        'SELECT id FROM tasks WHERE id IN (' + placeholdersOf(ids) + ') AND status IN (?, ?, ?)',
        ids.concat([TASK_STATUS_ENUM.FINISHED, TASK_STATUS_ENUM.TIMEOUT_CANCEL, TASK_STATUS_ENUM.OWNER_CANCEL])
      );
      const targetIds = rows.map((row) => Number(row.id));
      if (!targetIds.length) {
        return { done: 0, skipped: ids.length, reason: MSG.BATCH_DELETE_TASK_UNFINISHED };
      }
      const ph = placeholdersOf(targetIds);
      await conn.execute('DELETE FROM user_bill WHERE task_id IN (' + ph + ')', targetIds);
      await conn.execute('DELETE FROM payments WHERE task_id IN (' + ph + ')', targetIds);
      await conn.execute('DELETE FROM report WHERE task_id IN (' + ph + ')', targetIds);
      const [result] = await conn.execute('DELETE FROM tasks WHERE id IN (' + ph + ')', targetIds);
      const done = Number(result.affectedRows || 0);
      return {
        done,
        skipped: ids.length - done,
        reason: ids.length - done > 0 ? MSG.BATCH_DELETE_TASK_UNFINISHED : ''
      };
    });
  },

  /**
   * 封禁记录：封禁状态保存在 users 表的字段上，没有独立记录表，
   * 因此这里的「删除」= 解除封禁并抹掉封禁原因 / 操作人 / 时间。
   */
  async ban(ids) {
    const result = await db.execute(
      "UPDATE users SET ban_take_time = NULL, ban_reason = '', ban_operator_id = NULL, ban_created_at = NULL"
      + ' WHERE id IN (' + placeholdersOf(ids) + ') AND ban_take_time IS NOT NULL',
      ids
    );
    const done = Number((result && result.affectedRows) || 0);
    return { done, skipped: ids.length - done, reason: done === 0 ? MSG.BATCH_DELETE_NONE_DONE : '' };
  },

  /**
   * 用户：仅允许删除「已注销」账号，且必须没有关联任务
   * （有关联任务的账号一旦物理删除，对方的订单历史会一起消失，因此跳过并提示）。
   */
  async user(ids) {
    const rows = await db.query(
      'SELECT id FROM users WHERE id IN (' + placeholdersOf(ids) + ') AND deactivated_at IS NOT NULL',
      ids
    );
    const deactivatedIds = rows.map((row) => Number(row.id));
    // 勾选里混入的「未注销」账号数量：给结果提示提供跳过原因
    const notDeactivated = ids.length - deactivatedIds.length;
    if (!deactivatedIds.length) {
      return { done: 0, skipped: ids.length, reason: MSG.BATCH_DELETE_USER_NOT_DEACTIVATED };
    }
    const withTasks = await User.findIdsWithTasks(deactivatedIds);
    const deletable = deactivatedIds.filter((id) => !withTasks.has(id));
    if (!deletable.length) {
      return { done: 0, skipped: ids.length, reason: MSG.BATCH_DELETE_USER_HAS_TASK };
    }
    const done = await db.transaction((conn) => User.hardDeleteUsers(deletable, conn));
    // 有跳过时给出具体原因（按优先级：有关联任务 > 未注销），避免出现「跳过N条（）」的空括号提示
    let reason = '';
    if (withTasks.size > 0) reason = MSG.BATCH_DELETE_USER_HAS_TASK;
    else if (notDeactivated > 0) reason = MSG.BATCH_DELETE_USER_NOT_DEACTIVATED;
    return { done, skipped: ids.length - done, reason };
  }
};

/**
 * POST /api/admin/batchDelete 批量删除（列表清理）
 * 请求体：{ module: 'audit'|'appeal'|'report'|'order'|'ban'|'user', ids: [id, ...] }
 */
async function batchDelete(req, res, next) {
  try {
    const module = String(req.body.module || '').trim();
    if (BATCH_DELETE_MODULES.indexOf(module) < 0) throw new BizError(MSG.BATCH_DELETE_MODULE_INVALID, 400);

    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = rawIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
    if (!ids.length) throw new BizError(MSG.BATCH_DELETE_EMPTY, 400);
    if (ids.length > BIZ.BATCH_DELETE_MAX) throw new BizError(MSG.BATCH_DELETE_LIMITED, 400);

    const result = await BATCH_DELETE_HANDLERS[module](ids);
    // 只有「确有跳过且能说明原因」时才拼接原因，否则用不带括号的模板
    const msg = result.skipped > 0 && result.reason
      ? formatText(MSG.BATCH_DELETE_RESULT_REASON, {
        done: result.done, skipped: result.skipped, reason: result.reason
      })
      : formatText(MSG.BATCH_DELETE_RESULT, { done: result.done, skipped: result.skipped });
    return ok(res, result, msg);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  userList,
  userDetail,
  updateUser,
  resetUserPassword,
  deactivateUser,
  deleteTask,
  searchTask,
  updateTask,
  banList,
  banUser,
  unbanUser,
  batchDelete
};
