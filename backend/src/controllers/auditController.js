/**
 * =====================================================================
 * 审核控制器：头像审核(1) / 昵称审核(2) / 校园认证(3)
 * 规则要点：
 *  - 同一用户同类型只能存在 1 条待审核记录，提交新申请自动撤销旧申请
 *    （旧申请会被打上 is_void 作废标记：管理员审核列表只显示最新的一条，前几次作废不展示，
 *      但记录保留，用户自己的「我的审核记录」仍能看到完整历史）
 *  - 校园认证 4 项必填，7 天内最多提交 3 次，真实学号全局唯一（已认证账号占用则直接驳回）
 *  - 审核通过后更新用户资料并推送站内消息
 * =====================================================================
 */

const db = require('../db/db');
const AuditApply = require('../models/AuditApply');
const User = require('../models/User');
const Message = require('../models/Message');
const {
  BIZ, AUDIT_APPLY_TYPE_ENUM, AUDIT_STATUS_ENUM, CAMPUS_AUDIT_ENUM, AVATAR_AUDIT_ENUM, MSG_TYPE_ENUM, MSG
} = require('../utils/constant');
const {
  ok, BizError, assertParams, parsePage, buildPage, checkIdempotent, hashParams, isPhone, formatDate
} = require('../utils/common');
const { isAdminStudent } = require('../utils/adminUtil');
const wxSecCheck = require('../utils/wxSecCheck');

/**
 * POST /api/audit/submit 提交审核申请
 * 入参：applyType、applyContent（头像图片地址 / 新昵称 / 校园认证截图）
 *      校园认证额外必填：certName、certStudentId、certPhone
 */
async function submit(req, res, next) {
  try {
    const user = req.user;
    const applyType = Number(req.body.applyType);
    if (![1, 2, 3].includes(applyType)) throw new BizError('审核类型不合法');
    assertParams(req.body, [{ name: 'applyContent', label: '申请内容' }]);
    // 幂等键带上提交内容指纹：同内容 3 秒内重复提交视为连点，内容不同属于正常的新申请
    if (!checkIdempotent(`auditSubmit:${user.id}:${applyType}:${hashParams(req.body)}`, 3000)) {
      throw new BizError(MSG.REPEAT_SUBMIT, 409);
    }

    let certName = '';
    let certStudentId = '';
    let certPhone = '';

    // ---------------- 校园认证：额外校验 ----------------
    if (applyType === AUDIT_APPLY_TYPE_ENUM.CAMPUS) {
      assertParams(req.body, [
        { name: 'certName', label: '真实姓名' },
        { name: 'certStudentId', label: '真实学号' },
        { name: 'certPhone', label: '可联系手机号' }
      ]);
      certName = String(req.body.certName).trim();
      certStudentId = String(req.body.certStudentId).trim();
      certPhone = String(req.body.certPhone).trim();

      // 管理员账号由后端白名单自动完成校园认证，禁止重复提交申请
      // （否则会把已通过的 is_campus_audit 改写成「待审核」，造成权限短暂丢失）
      if (isAdminStudent(user.student_id)) {
        throw new BizError('管理员账号已自动完成校园认证，无需重复提交', 409);
      }

      if (certName.length > 20) throw new BizError('真实姓名不能超过20字');
      if (!/^[A-Za-z0-9]{4,20}$/.test(certStudentId)) throw new BizError('学号格式不正确');
      if (!isPhone(certPhone)) throw new BizError('可联系手机号格式不正确');

      // 频率限制：同一账号 7 天内最多提交 3 次校园认证
      const times = await AuditApply.countCampusApplyWithinDays(user.id, BIZ.CAMPUS_APPLY_DAYS);
      if (times >= BIZ.CAMPUS_APPLY_LIMIT) {
        throw new BizError(`${BIZ.CAMPUS_APPLY_DAYS}天内最多提交${BIZ.CAMPUS_APPLY_LIMIT}次校园认证申请`, 409);
      }

      // 唯一性校验：若已有其他账号认证通过且使用该学号，则直接驳回本次申请
      const occupied = await User.findCertifiedByStudentId(certStudentId, user.id);
      if (occupied) {
        await db.transaction(async (conn) => {
          await AuditApply.cancelPending(user.id, applyType, '已有新的认证申请', conn);
          await AuditApply.create({
            user_id: user.id,
            apply_type: applyType,
            apply_content: String(req.body.applyContent),
            cert_name: certName,
            cert_student_id: certStudentId,
            cert_phone: certPhone,
            status: AUDIT_STATUS_ENUM.REJECT,
            reject_reason: '该学号已被其他账号完成认证'
          }, conn);
          await User.setCampusAuditStatus(user.id, CAMPUS_AUDIT_ENUM.REJECT, conn);
          await Message.create({
            userId: user.id,
            msgType: MSG_TYPE_ENUM.SYSTEM,
            title: '校园认证已驳回',
            content: '该学号已被其他账号完成认证，请核对后重新提交。'
          }, conn);
        });
        throw new BizError('该学号已被其他账号完成认证，认证申请已驳回', 409);
      }
    }

    // ---------------- 昵称修改：剩余修改次数校验 ----------------
    if (applyType === AUDIT_APPLY_TYPE_ENUM.NICKNAME) {
      const nickname = String(req.body.applyContent).trim();
      if (!nickname || nickname.length > 30) throw new BizError(MSG.NICKNAME_INVALID, 400);
      // 内容安全：昵称会在任务大厅、详情页公开展示，需要过微信内容安全检测
      // （SEC_CHECK_ENABLE 未开启时该调用直接放行）
      const nicknameSec = await wxSecCheck.checkText(nickname, user);
      if (!nicknameSec.pass) throw new BizError(nicknameSec.reason, 400);
      // 管理员账号权限最高，不受「昵称修改次数」限制（普通用户仍按剩余次数校验）
      if (!isAdminStudent(user.student_id) && Number(user.nickname_modify_count) <= 0) {
        throw new BizError('昵称修改次数已用完，无法再次申请', 403);
      }
      req.body.applyContent = nickname;
    }

    // ---------------- 头像：二维码 / 图片地址长度校验 ----------------
    if (applyType === AUDIT_APPLY_TYPE_ENUM.AVATAR) {
      const img = String(req.body.applyContent).trim();
      if (img.length > 255) throw new BizError('头像地址过长');
    }

    // 事务：撤销旧待审核申请 -> 创建新申请 -> 更新用户审核状态
    const applyId = await db.transaction(async (conn) => {
      await AuditApply.cancelPending(user.id, applyType, '已被新申请覆盖', conn);
      const id = await AuditApply.create({
        user_id: user.id,
        apply_type: applyType,
        apply_content: String(req.body.applyContent),
        cert_name: certName,
        cert_student_id: certStudentId,
        cert_phone: certPhone,
        status: AUDIT_STATUS_ENUM.PENDING
      }, conn);

      if (applyType === AUDIT_APPLY_TYPE_ENUM.CAMPUS) {
        await User.setCampusAuditStatus(user.id, CAMPUS_AUDIT_ENUM.PENDING, conn);
      } else if (applyType === AUDIT_APPLY_TYPE_ENUM.AVATAR) {
        await User.setAvatarAuditStatus(user.id, AVATAR_AUDIT_ENUM.PENDING, conn);
      }
      return id;
    });

    // 校园认证：把「7 天最多 3 次」的用量与剩余次数一并返回给前端，
    // 提交成功后前端要弹窗告知用户还剩多少次（数字全部由后端计算，避免前后端口径不一致）
    let campusApply = null;
    if (applyType === AUDIT_APPLY_TYPE_ENUM.CAMPUS) {
      const usedTimes = await AuditApply.countCampusApplyWithinDays(user.id, BIZ.CAMPUS_APPLY_DAYS);
      campusApply = {
        days: BIZ.CAMPUS_APPLY_DAYS,
        limit: BIZ.CAMPUS_APPLY_LIMIT,
        usedTimes,
        // 本次提交已计入 usedTimes，因此 remainTimes 是「提交完之后还能再提交几次」
        remainTimes: Math.max(0, BIZ.CAMPUS_APPLY_LIMIT - usedTimes)
      };
    }

    return ok(res, { applyId, campusApply }, '申请已提交，请等待管理员审核');
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/audit/myList 我的审核记录
 */
async function myList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const applyType = req.query.applyType === undefined || req.query.applyType === ''
      ? null : Number(req.query.applyType);
    const { list, total } = await AuditApply.listByUser({
      userId: req.user.id, applyType, offset, limit: pageSize
    });
    return ok(res, buildPage(list, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/audit/adminList 管理员审核列表
 */
async function adminList(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const status = req.query.status === undefined || req.query.status === '' ? null : Number(req.query.status);
    const applyType = req.query.applyType === undefined || req.query.applyType === ''
      ? null : Number(req.query.applyType);
    const { list, total } = await AuditApply.listForAdmin({ status, applyType, offset, limit: pageSize });
    return ok(res, buildPage(list, total, page, pageSize));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/audit/handle 管理员通过 / 驳回申请
 * 入参：applyId、status（2通过 / 3驳回）、rejectReason（驳回必填）
 * 幂等：仅待审核状态可被处理，重复处理直接提示
 */
async function handle(req, res, next) {
  try {
    assertParams(req.body, [
      { name: 'applyId', label: '申请ID' },
      { name: 'status', label: '处理结果' }
    ]);
    const applyId = Number(req.body.applyId);
    const status = Number(req.body.status);
    const rejectReason = String(req.body.rejectReason || '').trim().slice(0, 200);

    if (![AUDIT_STATUS_ENUM.PASS, AUDIT_STATUS_ENUM.REJECT].includes(status)) {
      throw new BizError('处理结果不合法');
    }
    if (status === AUDIT_STATUS_ENUM.REJECT && !rejectReason) throw new BizError('驳回原因不能为空');

    const result = await db.transaction(async (conn) => {
      // 行锁读取，防止管理员重复处理
      const apply = await AuditApply.findByIdForUpdate(applyId, conn);
      if (!apply) throw new BizError('审核申请不存在', 400);
      if (apply.status !== AUDIT_STATUS_ENUM.PENDING) throw new BizError('该申请已处理完毕', 409);

      const affected = await AuditApply.handle(applyId, status, rejectReason, conn);
      if (affected === 0) throw new BizError('该申请已处理完毕', 409);

      const targetUser = await User.findById(apply.user_id, conn);
      if (!targetUser) throw new BizError('申请用户不存在', 400);
      const passed = status === AUDIT_STATUS_ENUM.PASS;

      // ---------------- 校园认证 ----------------
      if (apply.apply_type === AUDIT_APPLY_TYPE_ENUM.CAMPUS) {
        if (passed) {
          await User.updateCampusCert(
            apply.user_id, apply.cert_name, apply.cert_student_id, apply.apply_content, conn
          );
          await Message.create({
            userId: apply.user_id,
            msgType: MSG_TYPE_ENUM.SYSTEM,
            title: '校园认证通过',
            content: '恭喜！您的校园认证已通过，已解锁全部任务发布与接单权限。'
          }, conn);
        } else {
          await User.setCampusAuditStatus(apply.user_id, CAMPUS_AUDIT_ENUM.REJECT, conn);
          await Message.create({
            userId: apply.user_id,
            msgType: MSG_TYPE_ENUM.SYSTEM,
            title: '校园认证被驳回',
            content: `您的校园认证申请被驳回，原因：${rejectReason}。已发布的待接单任务保留，但暂时无法发布新任务与接单。`
          }, conn);
        }
      }

      // ---------------- 头像审核 ----------------
      if (apply.apply_type === AUDIT_APPLY_TYPE_ENUM.AVATAR) {
        if (passed) {
          await User.updateAvatar(apply.user_id, apply.apply_content, conn);
          await User.setAvatarAuditStatus(apply.user_id, AVATAR_AUDIT_ENUM.PASS, conn);
        } else {
          await User.setAvatarAuditStatus(apply.user_id, AVATAR_AUDIT_ENUM.REJECT, conn);
        }
        await Message.create({
          userId: apply.user_id,
          msgType: MSG_TYPE_ENUM.SYSTEM,
          title: passed ? '头像审核通过' : '头像审核被驳回',
          content: passed ? '您的新头像已生效。' : `您的头像申请被驳回，原因：${rejectReason}`
        }, conn);
      }

      // ---------------- 昵称审核（驳回不扣次数，通过才消耗） ----------------
      if (apply.apply_type === AUDIT_APPLY_TYPE_ENUM.NICKNAME) {
        if (passed) {
          await User.updateNickname(apply.user_id, apply.apply_content, conn);
        }
        await Message.create({
          userId: apply.user_id,
          msgType: MSG_TYPE_ENUM.SYSTEM,
          title: passed ? '昵称修改成功' : '昵称修改被驳回',
          content: passed ? `您的昵称已修改为「${apply.apply_content}」。` : `您的昵称修改申请被驳回，原因：${rejectReason}（未消耗修改次数）`
        }, conn);
      }

      return { applyId, status };
    });

    return ok(res, result, status === AUDIT_STATUS_ENUM.PASS ? '已通过' : '已驳回');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  submit,
  myList,
  adminList,
  handle
};
