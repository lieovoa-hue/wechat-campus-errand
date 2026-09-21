/**
 * =====================================================================
 * 定时任务（node-schedule，后台常驻执行，不依赖前端触发）
 *  1. 每分钟：扫描限时任务已超时 -> 自动扣减 5% 酬金（任务不取消，可继续送达）
 *  2. 每分钟：扫描待雇主确认超过 2 小时的任务 -> 自动确认完成 + 生成账单
 *  3. 每分钟：扫描 ban_take_time 到期的用户 -> 自动解禁接单权限
 *  4. 每分钟：扫描 login_lock_time 到期的账号 -> 自动解除登录锁定
 *  5. 每天 00:00：重置当日申诉提交计数（申诉按自然日 created_at 统计，DB 层面自动归零）
 *  6. 每天 01:00：清理 7 天前审核驳回的图片文件
 *  7. 每天 02:00：清零已过期的「邀请码免费代拿」次数（展示口径归零，业务判定始终看有效期）
 *  8. 每天 03:00：清理垃圾文件（孤立上传图片 / 过期日志 / 短信表历史记录）
 *  9. 每天 05:00：数据库全量备份（mysqldump），并清理超过保留天数的旧备份
 *
 * 【重要】接单封禁不再由系统自动执行：
 *   限时任务超时只扣酬金、不封禁，是否封禁由管理员在「管理员后台 - 封禁管理」中决定，
 *   雇主可以通过任务详情页的「举报恶意超时」把投诉直达管理员。
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

const db = require('../db/db');
const Task = require('../models/Task');
const User = require('../models/User');
const Bill = require('../models/Bill');
const Message = require('../models/Message');
const AuditApply = require('../models/AuditApply');
const { BIZ, TASK_STATUS_ENUM, BILL_TYPE_ENUM, MSG_TYPE_ENUM } = require('../utils/constant');
const { log, calcLateDeduct, formatLateText } = require('../utils/common');
const garbageCleaner = require('../utils/garbageCleaner');
const dbBackup = require('../utils/dbBackup');

/** 上传根目录（用于清理驳回图片） */
const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

/** 任务是否正在执行，避免上一次未跑完又被触发 */
const running = {
  timeout: false, autoConfirm: false, unban: false, unlock: false,
  cleanImage: false, cleanCoupon: false, cleanGarbage: false, cleanKick: false, backupDb: false
};

// ---------------------------------------------------------------------
// 1. 限时任务超时：自动扣减 5% 酬金，任务保持「进行中」可继续送达
// ---------------------------------------------------------------------
/**
 * 业务规则（与需求一致，不得简化）：
 *   1) 限时任务超过 time_limit_min 仍未提交送达 -> 系统按当前酬金扣减 5%（不足 0.5 元按 0.5 元）
 *   2) 任务**不再自动取消**（status 保持 1 进行中），跑腿员可以继续送达
 *   3) 系统**不再自动封禁**接单用户，是否封禁由管理员决定
 *   4) 雇主可对「恶意超时」发起投诉（/api/task/reportLateTaker），投诉直达管理员
 * 幂等保证：
 *   - findTimeoutTasks 只捞 is_late_reward_deducted = 0 的任务
 *   - timeoutDeductReward 的乐观锁条件同样带 is_late_reward_deducted = 0
 *   两者叠加后，即使进程重启 / 多个实例并发，同一条任务也只会扣一次款、只推送一次消息。
 */
async function jobTimeoutTasks() {
  if (running.timeout) return;
  running.timeout = true;
  try {
    const tasks = await Task.findTimeoutTasks(200);
    for (const task of tasks) {
      /* eslint-disable no-await-in-loop */
      await db.transaction(async (conn) => {
        // 事务内加行锁重新读取：避免与「雇主加酬金」并发时按过期酬金算错扣减金额
        const fresh = await Task.findByIdForUpdate(task.id, conn);
        if (!fresh) return;
        // 任务已不是「进行中」（已被取消接单 / 已提交送达 / 已撤销）直接跳过
        if (fresh.status !== TASK_STATUS_ENUM.TAKING) return;
        // 已扣减过则跳过（配合乐观锁实现幂等）
        if (Number(fresh.is_late_reward_deducted) === 1) return;

        // 扣减规则唯一出口：酬金 × 5%，不足 0.5 元按 0.5 元，扣减不超过酬金本身
        const { deduct, remain, rate } = calcLateDeduct(fresh.reward);
        const rateText = `${Math.round(rate * 100)}%`;
        const minText = `¥${Number(BIZ.LATE_DEDUCT_MIN).toFixed(2)}`;

        // 超时秒数 = 当前时间 - 截止时间（截止时间 = 接单时间 + 限时分钟）
        const deadline = new Date(fresh.take_time).getTime() + Number(fresh.time_limit_min) * 60 * 1000;
        const lateSeconds = Math.max(0, Math.floor((Date.now() - deadline) / 1000));

        const affected = await Task.timeoutDeductReward(task.id, remain, deduct, lateSeconds, conn);
        if (affected === 0) return;

        // 通知跑腿员：酬金已扣，但任务没取消，可以继续送达
        if (fresh.taker_user_id) {
          await Message.create({
            userId: fresh.taker_user_id,
            msgType: MSG_TYPE_ENUM.TASK,
            title: '限时任务已超时，酬金已扣减',
            content: `任务（编号${task.id}）已超过限时${formatLateText(lateSeconds)}仍未送达，系统已按规则扣减酬金 `
              + `¥${deduct.toFixed(2)}（酬金的${rateText}，不足${minText}按${minText}计算），当前酬金 ¥${remain.toFixed(2)}。`
              + '任务不会被取消，您可以继续送达，请尽快完成后上传送达照片。'
          }, conn);
        }

        // 通知雇主：酬金已自动扣减，并告知可投诉恶意超时
        await Message.create({
          userId: fresh.user_id,
          msgType: MSG_TYPE_ENUM.TASK,
          title: '跑腿员已超时，酬金已自动扣减',
          content: `您的任务（编号${task.id}）已超过限时${formatLateText(lateSeconds)}仍未送达，系统已自动扣减酬金 `
            + `¥${deduct.toFixed(2)}（酬金的${rateText}，不足${minText}按${minText}计算），当前酬金 ¥${remain.toFixed(2)}。`
            + '跑腿员仍可继续送达；若对方长时间恶意超时，您可在任务详情页点击「举报恶意超时」，投诉将直达管理员处理。'
        }, conn);
      });
      log('info', `[定时任务] 任务${task.id} 超时自动扣减酬金（任务保持进行中，未封禁接单用户）`);
    }
  } catch (err) {
    log('error', '[定时任务] 超时任务扫描异常：', err.message);
  } finally {
    running.timeout = false;
  }
}

// ---------------------------------------------------------------------
// 2. 待雇主确认超过 2 小时自动确认完成 + 生成任务收入账单
// ---------------------------------------------------------------------
async function jobAutoConfirm() {
  if (running.autoConfirm) return;
  running.autoConfirm = true;
  try {
    const tasks = await Task.findAutoConfirmTasks(BIZ.AUTO_CONFIRM_HOURS, 200);
    for (const task of tasks) {
      await db.transaction(async (conn) => {
        const affected = await Task.autoConfirmFinish(task.id, conn);
        if (affected === 0) return;

        if (task.taker_user_id) {
          // 记账幂等：同一任务同一类型只生成一条流水
          const exists = await Bill.exists(task.id, task.taker_user_id, BILL_TYPE_ENUM.TASK_INCOME, conn);
          if (!exists) {
            await Bill.create({
              userId: task.taker_user_id,
              taskId: task.id,
              type: BILL_TYPE_ENUM.TASK_INCOME,
              amount: task.reward,
              remark: '跑腿任务收入（超时自动确认）'
            }, conn);
          }
          await Message.create({
            userId: task.taker_user_id,
            msgType: MSG_TYPE_ENUM.SYSTEM,
            title: '任务已自动确认完成',
            content: `任务（编号${task.id}）雇主超过${BIZ.AUTO_CONFIRM_HOURS}小时未确认，系统已自动确认完成，酬金${Number(task.reward).toFixed(2)}元已记入您的账单。`
          }, conn);
        }
      });
      log('info', `[定时任务] 任务${task.id} 超时自动确认完成`);
    }
  } catch (err) {
    log('error', '[定时任务] 自动确认扫描异常：', err.message);
  } finally {
    running.autoConfirm = false;
  }
}

// ---------------------------------------------------------------------
// 3. 接单封禁到期自动解禁（封禁由管理员手动设置，到期后系统自动解禁）
// ---------------------------------------------------------------------
async function jobUnbanTake() {
  if (running.unban) return;
  running.unban = true;
  try {
    const users = await User.findExpiredBanUsers(200);
    if (users.length) {
      await User.clearExpiredBan();
      log('info', `[定时任务] 已自动解禁 ${users.length} 个用户的接单权限`);
    }
  } catch (err) {
    log('error', '[定时任务] 解禁接单异常：', err.message);
  } finally {
    running.unban = false;
  }
}

// ---------------------------------------------------------------------
// 4. 登录锁定到期自动解锁
// ---------------------------------------------------------------------
async function jobUnlockLogin() {
  if (running.unlock) return;
  running.unlock = true;
  try {
    const users = await User.findExpiredLockUsers(200);
    if (users.length) {
      await User.clearExpiredLoginLock();
      log('info', `[定时任务] 已自动解除 ${users.length} 个账号的登录锁定`);
    }
    // 密保锁定与登录锁定相互独立：连续答错密保 5 次同样锁定 15 分钟，到期必须自动解除
    const securityUsers = await User.findExpiredSecurityLockUsers(200);
    if (securityUsers.length) {
      await User.clearExpiredSecurityLock();
      log('info', `[定时任务] 已自动解除 ${securityUsers.length} 个账号的密保验证锁定`);
    }
  } catch (err) {
    log('error', '[定时任务] 解除登录锁定异常：', err.message);
  } finally {
    running.unlock = false;
  }
}

// ---------------------------------------------------------------------
// 5. 每天 00:00 重置当日申诉提交计数
//    申诉次数在业务层按 DATE(created_at) = CURDATE() 统计，跨天后自然归零，
//    此处同步重置内存态计数并输出日志，保证与业务规则一致。
// ---------------------------------------------------------------------
function jobResetAppealCount() {
  try {
    dailyAppealCounter.count = 0;
    dailyAppealCounter.date = new Date().toISOString().slice(0, 10);
    log('info', '[定时任务] 当日申诉提交计数已重置（每日最多2条）');
  } catch (err) {
    log('error', '[定时任务] 重置申诉计数异常：', err.message);
  }
}

/** 内存态当日申诉计数（业务判定以数据库自然日统计为准） */
const dailyAppealCounter = { date: new Date().toISOString().slice(0, 10), count: 0 };

// ---------------------------------------------------------------------
// 6. 每天 01:00 清理 7 天前审核驳回的图片文件
// ---------------------------------------------------------------------
async function jobCleanRejectedImages() {
  if (running.cleanImage) return;
  running.cleanImage = true;
  try {
    const rows = await AuditApply.findRejectedImagesBefore(7, 500);
    let cleaned = 0;
    for (const row of rows) {
      if (!row.apply_content || !row.apply_content.startsWith('/uploads/')) continue;

      const relative = row.apply_content.replace('/uploads/', '');
      const filePath = path.resolve(UPLOAD_ROOT, relative);
      // 安全校验：解析后的绝对路径必须仍位于 uploads 目录内，防止路径穿越
      if (!filePath.startsWith(UPLOAD_ROOT)) {
        log('warn', `[定时任务] 跳过非法图片路径：${row.apply_content}`);
        continue;
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleaned += 1;
      }
      // 清空数据库中的失效引用
      await AuditApply.clearContent(row.id);
    }
    log('info', `[定时任务] 驳回图片清理完成，共删除 ${cleaned} 个文件`);
  } catch (err) {
    log('error', '[定时任务] 清理驳回图片异常：', err.message);
  } finally {
    running.cleanImage = false;
  }
}

/** 已注册的任务句柄，便于优雅停止 */
const jobs = [];

// ---------------------------------------------------------------------
// 7. 每天 02:00 清零已过期的「邀请码免费代拿」次数
// ---------------------------------------------------------------------
/**
 * 业务规则：
 *   使用邀请码注册赠送的「快递免费代拿」权益有效期为 7 天，过期即失效。
 *   本任务把过期账号的剩余次数统一清零，保证个人中心 / 发布页展示的
 *   「免费代拿次数」与真实可用状态一致。
 * 安全说明：
 *   核销接口（User.consumeFreeDelivery）的 WHERE 条件本身就带
 *   `free_delivery_expire > NOW()`，就算本任务因故未执行，
 *   过期权益也绝对不可能被核销，本任务只承担「展示口径归零」的职责。
 * @returns {Promise<void>}
 */
async function jobCleanExpiredFreeDelivery() {
  if (running.cleanCoupon) return;
  running.cleanCoupon = true;
  try {
    const cleared = await User.clearExpiredFreeDelivery();
    if (cleared > 0) {
      log('info', `[定时任务] 免费代拿权益清理完成，共清零 ${cleared} 个已过期账号`);
    }
  } catch (err) {
    log('error', '[定时任务] 清理过期免费代拿权益异常：', err.message);
  } finally {
    running.cleanCoupon = false;
  }
}

// ---------------------------------------------------------------------
// 8. 每天 03:00 清理垃圾文件
// ---------------------------------------------------------------------
/**
 * 清理三类「只用不删」的东西（逐项规则见 utils/garbageCleaner.js 头部注释）：
 *   1. 孤立上传图片：用户放弃提交的上传、换头像后的旧图、注销账号留下的截图、
 *      被管理员删除任务后的照片 —— 统一先移入 uploads/.trash 回收站，滞留期满才真删
 *   2. 日志文件：超过保留天数的直接删除；当天日志超限时只保留尾部若干行
 *      （正在被 cmd 重定向占用的日志删不掉，会跳过并在日志里记录原因）
 *   3. 短信验证码表 sms_code 的过期 / 已用历史记录
 * 安全保证：只认白名单目录与白名单扩展名，只处理「数据库无任何引用且超过保留期」的图片，
 *          任何一步校验不过就跳过，绝不触碰源码 / 配置 / 小程序 / 证书等核心文件。
 * @returns {Promise<void>}
 */
async function jobCleanGarbage() {
  if (running.cleanGarbage) return;
  running.cleanGarbage = true;
  try {
    await garbageCleaner.runAll();
  } catch (err) {
    log('error', '[定时任务] 垃圾文件清理异常：', err.message);
  } finally {
    running.cleanGarbage = false;
  }
}

// ---------------------------------------------------------------------
// 9. 每天 04:00 清理历史顶号提示记录
// ---------------------------------------------------------------------
/**
 * 顶号提示（user_kick）现在不再"读过即删"：
 *   为了让被顶下线的设备每次都能看到「新设备名称 / 时间 / IP / 归属地」的完整信息，
 *   记录会一直保留到该设备下次成功登录（由 clearDeviceKicks 标记已读）。
 * 因此这里按自然时间做一次归档清理，避免表无限增长：
 *   只删除「30 天前且已读」的记录 —— 未读记录一律保留，绝不误删用户还没看到的提示。
 * @returns {Promise<void>}
 */
async function jobCleanKickRecords() {
  if (running.cleanKick) return;
  running.cleanKick = true;
  try {
    const removed = await User.purgeOldKicks(30);
    if (removed > 0) {
      log('info', `[定时任务] 顶号提示记录清理完成，共删除 ${removed} 条（保留最近 30 天）`);
    }
  } catch (err) {
    log('error', '[定时任务] 清理顶号提示记录异常：', err.message);
  } finally {
    running.cleanKick = false;
  }
}

// ---------------------------------------------------------------------
// 10. 每天 05:00 数据库全量备份
// ---------------------------------------------------------------------
/**
 * 用 mysqldump 做逻辑备份，备份文件落在 BACKUP_DIR，自动清理超过保留天数的旧备份。
 * 实现细节（密码走环境变量、先写 .tmp 再改名、0 字节视为失败等）见 utils/dbBackup.js。
 * @returns {Promise<void>}
 */
async function jobBackupDb() {
  if (running.backupDb) return;
  running.backupDb = true;
  try {
    await dbBackup.jobBackupDb();
  } catch (err) {
    log('error', '[定时任务] 数据库备份异常：', err.message);
  } finally {
    running.backupDb = false;
  }
}
/**
 * 启动全部定时任务
 */
function start() {
  // 每分钟执行的任务（cron: 每分钟第 0 秒）
  jobs.push(schedule.scheduleJob('0 * * * * *', jobTimeoutTasks));
  jobs.push(schedule.scheduleJob('10 * * * * *', jobAutoConfirm));
  jobs.push(schedule.scheduleJob('20 * * * * *', jobUnbanTake));
  jobs.push(schedule.scheduleJob('30 * * * * *', jobUnlockLogin));

  // 每天 00:00 重置申诉计数
  jobs.push(schedule.scheduleJob('0 0 0 * * *', jobResetAppealCount));

  // 每天 01:00 清理驳回图片
  jobs.push(schedule.scheduleJob('0 0 1 * * *', jobCleanRejectedImages));

  // 每天 02:00 清零过期的免费代拿次数
  jobs.push(schedule.scheduleJob('0 0 2 * * *', jobCleanExpiredFreeDelivery));

  // 每天 03:00 清理垃圾文件（孤立图片 / 过期日志 / 短信表历史记录）
  jobs.push(schedule.scheduleJob('0 0 3 * * *', jobCleanGarbage));

  // 每天 04:00 清理 30 天前「已读」的顶号提示记录
  jobs.push(schedule.scheduleJob('0 0 4 * * *', jobCleanKickRecords));

  // 每天 05:00 数据库全量备份（错开 03:00 的垃圾清理，避免同一时刻抢磁盘 IO）
  jobs.push(schedule.scheduleJob('0 0 5 * * *', jobBackupDb));

  log('info', '定时任务已启动：超时扣酬金 / 自动确认 / 解禁接单 / 解除登录与密保锁定 / 申诉计数重置 / 驳回图片清理 / 免费代拿过期清理 / 垃圾文件清理 / 顶号提示归档 / 数据库备份');
}

/**
 * 停止全部定时任务
 */
function stop() {
  jobs.forEach((job) => job && job.cancel());
  jobs.length = 0;
  log('info', '定时任务已停止');
}

module.exports = {
  start,
  stop,
  // 供测试或手动触发
  jobTimeoutTasks,
  jobAutoConfirm,
  jobUnbanTake,
  jobUnlockLogin,
  jobResetAppealCount,
  jobCleanRejectedImages,
  jobCleanExpiredFreeDelivery,
  jobBackupDb
};
