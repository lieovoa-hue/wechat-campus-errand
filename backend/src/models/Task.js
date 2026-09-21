/**
 * =====================================================================
 * 跑腿任务数据访问层（tasks）【核心业务表】
 * 关键更新语句全部使用「状态条件 + 乐观锁」的方式，
 * UPDATE ... WHERE id = ? AND status = ?，通过 affectedRows 判断是否成功，
 * 从而保证并发接单 / 重复提交只有一次生效。
 * =====================================================================
 */

const { query, execute } = require('../db/db');
const { TASK_STATUS_ENUM, PAY_CHANNEL_ENUM } = require('../utils/constant');
const { buildTaskOrderNo } = require('../utils/common');

/**
 * 执行 SQL 的统一入口
 * @param {object|null} conn 事务连接
 */
async function run(conn, sql, params = []) {
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return query(sql, params);
}

/** 允许雇主编辑的字段白名单（防止批量赋值漏洞） */
const EDITABLE_FIELDS = [
  'receiver_name',
  'receiver_phone',
  'pickup_code',
  'item_name',
  'task_type',
  'deliver_address',
  'detail_address',
  'time_limit_min',
  'remark',
  'reward',
  'img1',
  'img2',
  'img3'
];

/**
 * 管理员编辑订单允许修改的字段白名单
 * ---------------------------------------------------------------------
 * 与雇主可编辑字段保持同一集合（避免出现「管理员能改、雇主不能改」的字段口径）；
 * 采用白名单的另一层意义是安全：status / is_deleted / once_taken / is_refunded 等
 * 流转与资金字段永远无法被批量赋值改写，管理员只能更正订单资料本身。
 */
const ADMIN_EDITABLE_FIELDS = EDITABLE_FIELDS.slice();

/**
 * 创建任务（发布任务时与支付流水同事务创建）
 * 注意：任务只有在支付成功后才会出现在任务大厅（列表查询关联 payments.status = 1）
 * 订单号：任务主键是 INT AUTO_INCREMENT（全局唯一、并发安全），
 *   因此订单号必须在插入拿到 insertId 之后再回写：GCPT + 6 位补零 id。
 *   两步写操作在同一个事务里完成，保证「有任务必有订单号」。
 * @returns {Promise<number>} 任务 id
 */
async function create(data, conn = null) {
  const sql = `INSERT INTO tasks
      (user_id, receiver_name, receiver_phone, pickup_code, item_name, deliver_address, detail_address,
       time_limit_min, remark, task_type,
       reward, service_fee, is_free_delivery, pay_channel, img1, img2, img3, status, publish_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
  const params = [
    data.user_id,
    data.receiver_name,
    data.receiver_phone,
    // 取件码 / 详细地址均为选填，未填写时落库为空串
    data.pickup_code || '',
    // 帮带物品：取快递时是选填的包裹描述，其他模板为主填写项
    data.item_name || '',
    data.deliver_address,
    data.detail_address || '',
    data.time_limit_min === undefined ? null : data.time_limit_min,
    data.remark || '',
    // 任务类型（快捷模板）：0其他 1取快递 2食堂带饭 3打印资料 4超市代买
    Number(data.task_type) || 0,
    data.reward,
    data.service_fee,
    // 是否使用「邀请码免费代拿」权益发布：1 时 service_fee 为 0（免信息服务费）
    data.is_free_delivery ? 1 : 0,
    // 发布费用来源：0免费代拿权益，1现金支付0.1元，2发布券抵扣（见 utils/constant 的 PAY_CHANNEL_ENUM）
    // 注意：免费权益是 0，不能用 `Number(x) || 默认值` 兜底（0 会被当成假值误判为现金单）
    data.pay_channel === undefined || data.pay_channel === null
      ? PAY_CHANNEL_ENUM.CASH
      : Number(data.pay_channel),
    data.img1 || '',
    data.img2 || '',
    data.img3 || '',
    TASK_STATUS_ENUM.WAIT_TAKE
  ];
  const orderNoSql = 'UPDATE tasks SET order_no = ? WHERE id = ?';
  if (conn) {
    const [result] = await conn.execute(sql, params);
    const newId = result.insertId;
    await conn.execute(orderNoSql, [buildTaskOrderNo(newId), newId]);
    return newId;
  }
  const result = await execute(sql, params);
  const newId = result.insertId;
  await execute(orderNoSql, [buildTaskOrderNo(newId), newId]);
  return newId;
}

/** 按主键查询任务（联表带出雇主昵称头像与支付状态） */
async function findById(id, conn = null) {
  const rows = await run(
    conn,
    `SELECT t.*,
            u.nickname AS owner_nickname, u.avatar AS owner_avatar,
            u.account_no AS owner_account_no,
            u.student_id AS owner_student_id, u.is_campus_audit AS owner_campus_audit,
            u.phone AS owner_phone, u.name AS owner_name,
            tk.nickname AS taker_nickname, tk.avatar AS taker_avatar,
            tk.account_no AS taker_account_no,
            tk.student_id AS taker_student_id, tk.is_campus_audit AS taker_campus_audit,
            tk.phone AS taker_phone, tk.name AS taker_name,
            (SELECT p.status FROM payments p WHERE p.task_id = t.id ORDER BY p.id DESC LIMIT 1) AS pay_status
       FROM tasks t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users tk ON tk.id = t.taker_user_id
      WHERE t.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/** 按主键加行锁查询（事务内防止并发修改） */
async function findByIdForUpdate(id, conn) {
  const [rows] = await conn.execute('SELECT * FROM tasks WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
  return rows[0] || null;
}

/**
 * 接单：数据库事务 + 乐观锁
 * UPDATE tasks SET status=1, taker_user_id=?, take_time=NOW(), once_taken=1
 *  WHERE id=? AND status=0
 * @returns {Promise<number>} 受影响行数，0 表示任务已被他人接单
 */
async function takeTask(taskId, takerUserId, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET status = ?, taker_user_id = ?, take_time = NOW(), once_taken = 1
      WHERE id = ? AND status = ?`,
    [TASK_STATUS_ENUM.TAKING, takerUserId, taskId, TASK_STATUS_ENUM.WAIT_TAKE]
  );
  return result.affectedRows;
}

/**
 * 取消接单：10 分钟内主动取消，任务回到待接单并清空接单信息
 * once_taken 保持为 1（一经接单永久置 1，退费永久关闭）
 * 特别说明：若该任务在接单期间已被「限时超时自动扣减酬金」，
 *   取消接单后任务回到待接单状态，必须把酬金原样还原，否则会拿降低后的酬金重新挂到任务大厅。
 * @returns {Promise<number>} 受影响行数
 */
async function cancelTake(taskId, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET status = ?, taker_user_id = NULL, take_time = NULL, submit_finish_time = NULL,
            pickup_img1 = '', pickup_img2 = '', pickup_img3 = '', pickup_confirm_time = NULL,
            reward = reward + CASE WHEN is_late_reward_deducted = 1 THEN late_reward_deduct ELSE 0 END,
            is_late_delivery = 0, late_delivery_seconds = 0,
            is_late_reward_deducted = 0, late_reward_deduct = 0.00
      WHERE id = ? AND status = ? AND pickup_confirm_time IS NULL`,
    [TASK_STATUS_ENUM.WAIT_TAKE, taskId, TASK_STATUS_ENUM.TAKING]
  );
  return result.affectedRows;
}

/**
 * 雇主编辑任务（字段来自白名单，值全部参数化）
 * 使用乐观锁：WHERE id = ? AND status IN (...)，任务状态已变更则编辑失败
 * ---------------------------------------------------------------------
 * 允许编辑的状态：
 *   待接单(0) —— 全量字段可改
 *   进行中(1) —— 本轮新增：接单人没取货前可以改内容（送达地址 / 限时由控制层拒绝变更，
 *                酬金只允许「加酬金」那条路径提高，避免雇主临时压价坑跑腿员）
 * @param {number} taskId 任务ID
 * @param {object} fields 需要更新的字段（键必须是白名单内的列名）
 * @param {object} conn 事务连接（调用方保证已对任务行加锁）
 * @param {number[]} [statuses] 允许编辑的状态，默认仅「待接单」
 * @returns {Promise<number>} 受影响行数
 */
async function updateByOwner(taskId, fields, conn, statuses = [TASK_STATUS_ENUM.WAIT_TAKE]) {
  const keys = Object.keys(fields).filter((key) => EDITABLE_FIELDS.includes(key));
  if (!keys.length) return 0;
  const setSql = keys.map((key) => `${key} = ?`).join(', ');
  const params = keys.map((key) => fields[key]);
  const placeholders = statuses.map(() => '?').join(', ');
  params.push(taskId, ...statuses);

  const [result] = await conn.execute(
    `UPDATE tasks SET ${setSql}, last_edit_time = NOW() WHERE id = ? AND status IN (${placeholders})`,
    params
  );
  return result.affectedRows;
}

/**
 * 管理员编辑订单（字段来自 ADMIN_EDITABLE_FIELDS 白名单，值全部参数化）
 * ---------------------------------------------------------------------
 * 与雇主编辑 updateByOwner 的区别：
 *   1. 不加 status = 0 条件 —— 管理员权限最高，任何状态下的订单资料都可被更正；
 *   2. 仍然带 is_deleted = 0 乐观锁 —— 已被删除的订单不允许再编辑（保留处置留痕）；
 *   3. 不受「两次编辑间隔 3 分钟」限制 —— 该限制是防雇主刷单，不适用于管理员；
 *   4. 依旧写 last_edit_time，方便审计追溯管理员最后一次改动时间。
 * @param {number} taskId 任务ID
 * @param {object} fields 需要更新的字段（键必须是白名单内的列名）
 * @param {object} conn 事务连接（调用方保证已对任务行加锁）
 * @returns {Promise<number>} 受影响行数，0 表示任务不存在或已被删除
 */
async function updateByAdmin(taskId, fields, conn) {
  const keys = Object.keys(fields).filter((key) => ADMIN_EDITABLE_FIELDS.includes(key));
  if (!keys.length) return 0;
  const setSql = keys.map((key) => `${key} = ?`).join(', ');
  const params = keys.map((key) => fields[key]);
  params.push(taskId);

  const [result] = await conn.execute(
    `UPDATE tasks SET ${setSql}, last_edit_time = NOW() WHERE id = ? AND is_deleted = 0`,
    params
  );
  return result.affectedRows;
}

/**
 * 进行中任务单独调整酬金（仅提高）
 * 乐观锁：WHERE id = ? AND status = 1
 * @returns {Promise<number>} 受影响行数
 */
async function adjustReward(taskId, reward, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET reward = ?, last_edit_time = NOW()
      WHERE id = ? AND status = ?`,
    [reward, taskId, TASK_STATUS_ENUM.TAKING]
  );
  return result.affectedRows;
}

/**
 * 跑腿员提交完成：写入「物品照片 + 送达照片」并置为待雇主确认
 * 乐观锁：WHERE id = ? AND status = 1
 * 同时写入「是否超时送达」：超过 time_limit_min 才提交即视为超时送达，
 *   雇主随后可在确认前对酬金做一次性超时扣减（扣减金额与超时秒数一并落库）。
 * @param {number} taskId 任务ID
 * @param {string[]} pickupImages 物品照片（已规范化，1~3 张），证明接单人已拿到 / 买到物品
 * @param {string[]} deliveryImages 送达照片（已规范化，1~3 张）
 * @param {boolean} isLate 是否超时送达
 * @param {number} lateSeconds 超时秒数（未超时为 0）
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function submitFinish(taskId, pickupImages, deliveryImages, isLate, lateSeconds, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET status = ?,
            pickup_img1 = ?, pickup_img2 = ?, pickup_img3 = ?,
            delivery_img1 = ?, delivery_img2 = ?, delivery_img3 = ?,
            submit_finish_time = NOW(),
            is_late_delivery = ?, late_delivery_seconds = ?
      WHERE id = ? AND status = ?`,
    [
      TASK_STATUS_ENUM.WAIT_CONFIRM,
      pickupImages[0] || '',
      pickupImages[1] || '',
      pickupImages[2] || '',
      deliveryImages[0] || '',
      deliveryImages[1] || '',
      deliveryImages[2] || '',
      isLate ? 1 : 0,
      Math.max(0, Number(lateSeconds) || 0),
      taskId,
      TASK_STATUS_ENUM.TAKING
    ]
  );
  return result.affectedRows;
}

/**
 * 雇主对「超时送达」任务扣减酬金（一次性，幂等）
 * 乐观锁条件：
 *   status = 2                     任务必须处于「待雇主确认」
 *   is_late_delivery = 1           必须是超时送达
 *   is_late_reward_deducted = 0    必须尚未扣减过（重复调用返回 0 行）
 * @param {number} taskId 任务ID
 * @param {number} newReward 扣减后的酬金
 * @param {number} deductAmount 本次扣减金额
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示状态已变更或已扣减过
 */
async function deductLateReward(taskId, newReward, deductAmount, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET reward = ?, is_late_reward_deducted = 1, late_reward_deduct = ?, last_edit_time = NOW()
      WHERE id = ? AND status = ? AND is_late_delivery = 1 AND is_late_reward_deducted = 0`,
    [newReward, deductAmount, taskId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return result.affectedRows;
}

/**
 * 雇主「完成任务」（进度第 5 段：完成）
 * ---------------------------------------------------------------------
 * 本轮新增为两步确认：
 *   第 1 步「确认收货」写 owner_receipt_time，进度进入第 4 段「待支付」；
 *   第 2 步「完成任务」才把状态置为已完成（此函数）。
 * 因此乐观锁条件里必须带 owner_receipt_time IS NOT NULL ——
 * 没确认收货就点完成任务会被挡下，前端提示「请先确认收货」，
 * 避免雇主跳过收货确认直接结单（跑腿员还没拿到钱就被系统记账）。
 * 幂等：status = 2 且已确认收货才生效，重复提交返回 0 行。
 * @returns {Promise<number>} 受影响行数
 */
async function confirmFinish(taskId, conn) {
  const [result] = await conn.execute(
    'UPDATE tasks SET status = ? WHERE id = ? AND status = ? AND owner_receipt_time IS NOT NULL',
    [TASK_STATUS_ENUM.FINISHED, taskId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return result.affectedRows;
}

/**
 * 雇主「确认收货」（进度第 3 段 → 第 4 段待支付）
 * 乐观锁：status = 2 且 owner_receipt_time IS NULL，重复确认返回 0 行（幂等）
 * @returns {Promise<number>} 受影响行数
 */
async function markOwnerReceipt(taskId, conn) {
  const [result] = await conn.execute(
    'UPDATE tasks SET owner_receipt_time = NOW() WHERE id = ? AND status = ? AND owner_receipt_time IS NULL',
    [taskId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return result.affectedRows;
}

/**
 * 接单人「确认取货」（进度第 1 段 → 第 2 段已取货）
 * ---------------------------------------------------------------------
 * 写入物品照片 + pickup_confirm_time，一步完成「凭证落库 + 锁定」：
 *   · pickup_confirm_time 非空后，物品照片不可再改（submitFinish 会用库里这份）；
 *   · 接单人不能再「取消接单」，雇主也不能再「撤销任务」（控制层按该字段判定）；
 *   · 乐观锁条件带 pickup_confirm_time IS NULL，重复点击返回 0 行（幂等）。
 * @param {number} taskId 任务ID
 * @param {string[]} pickupImages 物品照片（1~3 张）
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数
 */
async function confirmPickup(taskId, pickupImages, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET pickup_img1 = ?, pickup_img2 = ?, pickup_img3 = ?, pickup_confirm_time = NOW()
      WHERE id = ? AND status = ? AND pickup_confirm_time IS NULL`,
    [
      pickupImages[0] || '',
      pickupImages[1] || '',
      pickupImages[2] || '',
      taskId,
      TASK_STATUS_ENUM.TAKING
    ]
  );
  return result.affectedRows;
}

/**
 * 定时任务：超过 2 小时未确认，自动确认完成
 * @returns {Promise<number>} 受影响行数
 */
async function autoConfirmFinish(taskId, conn = null) {
  const rows = await run(
    conn,
    // owner_receipt_time 必须一起补上：进度第 4 段「待支付」与第 5 段「完成」全靠它区分，
    // 自动确认若不写，状态已是「完成」而进度仍停在「待支付」，前后端口径打架。
    // COALESCE 保证雇主已手动确认过时不覆盖原时间。
    'UPDATE tasks SET status = ?, owner_receipt_time = COALESCE(owner_receipt_time, NOW()) WHERE id = ? AND status = ?',
    [TASK_STATUS_ENUM.FINISHED, taskId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return rows.affectedRows;
}

/**
 * 雇主主动撤销任务
 * ---------------------------------------------------------------------
 * 可撤销的两种情形（乐观锁，其余状态一律拒绝）：
 *   1) 待接单(0)：还没人接，随时可撤；
 *   2) 进行中(1) 且 接单人尚未确认取货（pickup_confirm_time IS NULL）：
 *      本轮新增。接单人一旦确认取货（物品照片已锁定为凭证），撤销入口即永久关闭，
 *      避免雇主在跑腿员白跑一趟后单方面撤单。
 * @returns {Promise<number>} 受影响行数
 */
async function ownerCancel(taskId, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks SET status = ?
      WHERE id = ? AND (status = ? OR (status = ? AND pickup_confirm_time IS NULL))`,
    [
      TASK_STATUS_ENUM.OWNER_CANCEL,
      taskId,
      TASK_STATUS_ENUM.WAIT_TAKE,
      TASK_STATUS_ENUM.TAKING
    ]
  );
  return result.affectedRows;
}

/**
 * 定时任务：限时任务超时取消
 * @returns {Promise<number>} 受影响行数
 */
async function timeoutCancel(taskId, conn = null) {
  const rows = await run(
    conn,
    'UPDATE tasks SET status = ? WHERE id = ? AND status = ?',
    [TASK_STATUS_ENUM.TIMEOUT_CANCEL, taskId, TASK_STATUS_ENUM.TAKING]
  );
  return rows.affectedRows;
}

/**
 * 限时任务超时：由系统一次性扣减酬金（超时后任务不取消，跑腿员可继续送达）
 * ---------------------------------------------------------------------
 * 乐观锁：WHERE id = ? AND status = 1 AND is_late_reward_deducted = 0
 *   1) status 必须仍是「进行中」：已被接单者取消 / 已提交送达 / 已撤销的任务不会被扣
 *   2) is_late_reward_deducted = 0：保证同一条任务只扣一次
 *      （定时任务每分钟扫描一次，该条件就是「不重复扣款、不重复推送消息」的幂等依据）
 * 扣减后同步打上「超时送达」标记，任务详情页可直接展示「已超时 + 已扣减酬金」。
 * @param {number} taskId 任务ID
 * @param {number} newReward 扣减后的酬金
 * @param {number} deductAmount 本次扣减的金额
 * @param {number} lateSeconds 超时秒数（定时任务触发瞬间计算：当前时间 - 截止时间）
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示状态已变更或已扣减过
 */
async function timeoutDeductReward(taskId, newReward, deductAmount, lateSeconds, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET reward = ?, is_late_delivery = 1, late_delivery_seconds = ?,
            is_late_reward_deducted = 1, late_reward_deduct = ?, last_edit_time = NOW()
      WHERE id = ? AND status = ? AND is_late_reward_deducted = 0`,
    [
      newReward,
      Math.max(0, Number(lateSeconds) || 0),
      deductAmount,
      taskId,
      TASK_STATUS_ENUM.TAKING
    ]
  );
  return result.affectedRows;
}

/** 标记任务已退费 */
function markRefunded(taskId, conn = null) {
  return run(conn, 'UPDATE tasks SET is_refunded = 1 WHERE id = ?', [taskId]);
}

/**
 * 管理员删除任务（软删除 + 乐观锁去重）
 * ---------------------------------------------------------------------
 * 【为什么是软删除】
 *   tasks 已被 payments（支付流水）/ user_bill（账单）/ report（举报）通过外键引用，
 *   物理删除会破坏上述记录（也会丢掉管理员处置留痕）。因此这里只打删除标记：
 *   任务从任务大厅 / 我的发布 / 我的任务中隐藏，所有流转操作一并冻结，
 *   但数据完整保留，账单点进详情仍能看到该任务与「已被管理员删除」提示。
 * 【并发与幂等】
 *   WHERE id = ? AND is_deleted = 0 为乐观锁条件：
 *   两个管理员同时删除同一条任务时，只有一个人能拿到 affectedRows = 1，
 *   另一个人拿到 0，调用方据此提示「该任务已被管理员删除，请勿重复操作」。
 * @param {number} taskId 任务ID
 * @param {number} adminId 执行删除的管理员 user_id（审计留痕）
 * @param {string} reason 删除原因（选填，仅管理员可见）
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示任务不存在或已被删除
 */
async function softDelete(taskId, adminId, reason = '', conn = null) {
  const rows = await run(
    conn,
    `UPDATE tasks
        SET is_deleted = 1, delete_reason = ?, delete_time = NOW(), delete_admin_id = ?
      WHERE id = ? AND is_deleted = 0`,
    [reason, adminId, taskId]
  );
  return rows.affectedRows;
}

// ------------------------------ 列表查询 ------------------------------

/** 排序白名单：防止 ORDER BY 注入 */
const SORT_MAP = {
  time_desc: 't.publish_time DESC, t.id DESC',
  time_asc: 't.publish_time ASC, t.id ASC',
  reward_desc: 't.reward DESC, t.id DESC',
  reward_asc: 't.reward ASC, t.id ASC'
};

/**
 * 归一化可选数值参数（空串 / undefined / 非法值统一返回 null）
 * @param {*} value 原始值
 * @returns {number|null}
 */
function toOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 任务大厅列表（仅已支付且待接单的任务）
 * @param {object} options { keyword, minReward, maxReward, sort, offset, limit }
 */
async function listHall({ keyword = '', minReward = null, maxReward = null, sort = 'time_desc', offset = 0, limit = 10 }) {
  const where = [
    't.status = ?',
    't.is_refunded = 0',
    // 管理员已删除的任务不再出现在任务大厅
    't.is_deleted = 0',
    // 只有支付成功（payments.status = 1）的任务才正式上架
    'EXISTS (SELECT 1 FROM payments p WHERE p.task_id = t.id AND p.status = 1)'
  ];
  const params = [TASK_STATUS_ENUM.WAIT_TAKE];

  if (keyword) {
    where.push('(t.deliver_address LIKE ? OR t.remark LIKE ? OR t.receiver_name LIKE ?)');
    const like = '%' + keyword + '%';
    params.push(like, like, like);
  }
  // 防御式归一化：空串 / undefined / 非法值一律视为「不筛选」，避免把大厅列表筛空
  const min = toOptionalNumber(minReward);
  const max = toOptionalNumber(maxReward);
  if (min !== null) {
    where.push('t.reward >= ?');
    params.push(min);
  }
  if (max !== null) {
    where.push('t.reward <= ?');
    params.push(max);
  }

  const whereSql = ' WHERE ' + where.join(' AND ');
  const orderSql = SORT_MAP[sort] || SORT_MAP.time_desc;

  const list = await query(
    `SELECT t.*, u.nickname AS owner_nickname, u.avatar AS owner_avatar,
            u.account_no AS owner_account_no,
            u.student_id AS owner_student_id, u.is_campus_audit AS owner_campus_audit
       FROM tasks t
       LEFT JOIN users u ON u.id = t.user_id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query(`SELECT COUNT(*) AS total FROM tasks t ${whereSql}`, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 状态筛选条件构造：单个状态 / 多状态统一成一段 SQL
 * ---------------------------------------------------------------------
 * 为什么需要多状态：首页「未完成任务」牌堆要同时收 待接单(0) + 进行中(1) + 待确认(2)，
 * 单值 status 参数不够用，所以这里统一支持三种写法：
 *   · 数字 3         → status = 3
 *   · 字符串 '0,1,2' → status IN (0, 1, 2)
 *   · 数组 [0, 1, 2] → status IN (0, 1, 2)
 * 安全：只接受 0~5 的整数状态，非法值直接丢弃；值一律走 ? 占位符参数化，绝不拼接进 SQL。
 * @param {number|string|Array} status 状态筛选值，空值表示不筛选
 * @param {string} column 状态列名（含表别名，如 t.status），由调用方以常量传入
 * @returns {{sql: string, params: Array<number>}} sql 为空串表示「不加这个条件」
 */
function buildStatusClause(status, column = 'status') {
  if (status === null || status === undefined || status === '') return { sql: '', params: [] };
  const raw = Array.isArray(status) ? status : String(status).split(',');
  const values = raw
    .map((item) => String(item).trim())
    // 先剔掉空片段：Number('') === 0，留着会被误判成「待接单(0)」而不是「不筛选」
    .filter((item) => item !== '')
    .map(Number)
    .filter((num) => Number.isInteger(num) && num >= 0 && num <= 5);
  if (!values.length) return { sql: '', params: [] };
  if (values.length === 1) return { sql: `${column} = ?`, params: [values[0]] };
  return { sql: `${column} IN (${values.map(() => '?').join(', ')})`, params: values };
}

/**
 * 我发布的任务
 * @param {object} options { userId, status, offset, limit }
 *   status 支持单状态与多状态（如 '0,1,2'），见 buildStatusClause
 */
async function listByOwner({ userId, status = null, offset = 0, limit = 10 }) {
  // 管理员已删除的任务不再展示在「我的发布」中（雇主会收到站内消息告知原因）
  const where = ['t.user_id = ?', 't.is_deleted = 0'];
  const params = [userId];
  const statusClause = buildStatusClause(status, 't.status');
  if (statusClause.sql) {
    where.push(statusClause.sql);
    params.push(...statusClause.params);
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    `SELECT t.*, u.nickname AS taker_nickname, u.avatar AS taker_avatar,
            u.account_no AS taker_account_no,
            u.student_id AS taker_student_id, u.is_campus_audit AS taker_campus_audit,
            (SELECT p.status FROM payments p WHERE p.task_id = t.id ORDER BY p.id DESC LIMIT 1) AS pay_status
       FROM tasks t
       LEFT JOIN users u ON u.id = t.taker_user_id
       ${whereSql}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query(`SELECT COUNT(*) AS total FROM tasks t ${whereSql}`, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/** 我发布的任务：按状态统计数量（前端状态分组角标） */
function countByOwnerGroup(userId) {
  return query(
    'SELECT status, COUNT(*) AS total FROM tasks WHERE user_id = ? AND is_deleted = 0 GROUP BY status',
    [userId]
  );
}

/**
 * 我发布的任务里「等雇主确认收货」的数量（status = 2）
 * ---------------------------------------------------------------------
 * 用于底部 tabBar「我的发布」角标：待雇主确认是唯一必须由雇主本人操作的状态
 * （超时后系统会自动确认），所以只有它值得提醒。
 * 管理员已删除的任务不计入。
 * @param {number} userId 当前登录用户 id
 * @returns {Promise<number>} 待确认数量
 */
async function countPendingConfirmByOwner(userId) {
  const rows = await query(
    'SELECT COUNT(*) AS total FROM tasks WHERE user_id = ? AND is_deleted = 0 AND status = ?',
    [userId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * 我接的任务里「还没结束」的数量
 * ---------------------------------------------------------------------
 * 用于底部 tabBar「我的任务」上的角标：进行中(1) + 待雇主确认(2) 都算未完成，
 * 已完成(3) / 超时取消(4) / 雇主撤销(5) 不算。
 * 管理员已删除的任务（is_deleted = 1）不计入，避免出现「角标有数字但列表是空的」。
 * @param {number} userId 当前登录用户 id
 * @returns {Promise<number>} 未完成任务数量
 */
async function countUnfinishedByTaker(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS total FROM tasks
      WHERE taker_user_id = ? AND is_deleted = 0 AND status IN (?, ?)`,
    [userId, TASK_STATUS_ENUM.TAKING, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * 我接的任务
 * @param {object} options { userId, status, offset, limit }
 */
async function listByTaker({ userId, status = null, offset = 0, limit = 10 }) {
  // 管理员已删除的任务不再展示在「我的任务」中（接单人会收到站内消息告知已删除）
  const where = ['t.taker_user_id = ?', 't.is_deleted = 0'];
  const params = [userId];
  const statusClause = buildStatusClause(status, 't.status');
  if (statusClause.sql) {
    where.push(statusClause.sql);
    params.push(...statusClause.params);
  }
  const whereSql = ' WHERE ' + where.join(' AND ');
  const list = await query(
    `SELECT t.*, u.nickname AS owner_nickname, u.avatar AS owner_avatar,
            u.account_no AS owner_account_no,
            u.student_id AS owner_student_id, u.is_campus_audit AS owner_campus_audit
       FROM tasks t
       LEFT JOIN users u ON u.id = t.user_id
       ${whereSql}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query(`SELECT COUNT(*) AS total FROM tasks t ${whereSql}`, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * 管理员订单搜索（订单管理）
 * ---------------------------------------------------------------------
 * 支持的关键词（全部 LIKE 模糊匹配 + 数值精确匹配，参数化查询，绝无字符串拼接）：
 *   1. 订单号 order_no（如 GCPT000123，可只输入片段）
 *   2. 任务主键 id —— 纯数字关键词时额外做一次精确命中（输入 12 / #12 都能定位任务 #12）
 *   3. 收件人姓名 / 收件人手机号 / 送达地址
 *   4. 雇主与接单人的 账号ID / 学号 / 手机号 / 昵称
 * 说明：
 *   - 不传关键词时返回全部订单（按 id 倒序），便于管理员直接翻看最新订单；
 *   - **包含已被管理员软删除的订单**（前端会标注「已删除」），方便追溯历史处置记录；
 *   - JOIN 带出雇主 / 接单人完整资料（管理员可见完整手机号），供前端渲染 mini 卡片。
 * @param {object} options { keyword, offset, limit }
 * @returns {Promise<{list: Array, total: number}>}
 */
async function searchForAdmin({ keyword = '', offset = 0, limit = 10 }) {
  // 允许管理员直接粘贴「#12」这种带井号的写法
  const kw = String(keyword === undefined || keyword === null ? '' : keyword).trim().replace(/^#/, '');
  const where = [];
  const params = [];

  if (kw) {
    const like = '%' + kw + '%';
    const conds = [
      't.order_no LIKE ?',
      't.receiver_name LIKE ?',
      't.receiver_phone LIKE ?',
      't.deliver_address LIKE ?',
      'u.account_no LIKE ?',
      'u.student_id LIKE ?',
      'u.phone LIKE ?',
      'u.nickname LIKE ?',
      'tk.account_no LIKE ?',
      'tk.student_id LIKE ?',
      'tk.phone LIKE ?',
      'tk.nickname LIKE ?'
    ];
    params.push(like, like, like, like, like, like, like, like, like, like, like, like);

    // 纯数字：额外按任务主键精确匹配，保证「搜 12 一定命中任务 #12」
    if (/^\d+$/.test(kw)) {
      conds.push('t.id = ?');
      params.push(Number(kw));
    }
    where.push('(' + conds.join(' OR ') + ')');
  }

  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const list = await query(
    `SELECT t.*,
            u.nickname AS owner_nickname, u.avatar AS owner_avatar,
            u.account_no AS owner_account_no,
            u.student_id AS owner_student_id, u.is_campus_audit AS owner_campus_audit,
            u.phone AS owner_phone,
            tk.nickname AS taker_nickname, tk.avatar AS taker_avatar,
            tk.account_no AS taker_account_no,
            tk.student_id AS taker_student_id, tk.is_campus_audit AS taker_campus_audit,
            tk.phone AS taker_phone,
            (SELECT p.status FROM payments p WHERE p.task_id = t.id ORDER BY p.id DESC LIMIT 1) AS pay_status
       FROM tasks t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users tk ON tk.id = t.taker_user_id
       ${whereSql}
       ORDER BY t.id DESC
       LIMIT ? OFFSET ?`,
    params.concat([Number(limit), Number(offset)])
  );
  const countRows = await query(`SELECT COUNT(*) AS total FROM tasks t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users tk ON tk.id = t.taker_user_id ${whereSql}`, params);
  return { list, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

// ------------------------------ 定时任务查询 ------------------------------

/**
 * 扫描「已超时但尚未按超时扣减酬金」的限时任务
 * 条件：进行中 + 设置了限时 + 接单时间 + 限时分钟 < 当前时间 + 尚未扣减过
 * 说明：超时后任务**不再自动取消**，而是由系统一次性扣减 5% 酬金（不足 0.5 元按 0.5 元），
 *      任务保持「进行中」，跑腿员可以继续送达；
 *      is_late_reward_deducted = 0 这个条件同时承担「去重」职责，
 *      避免每分钟扫描时对同一条任务重复扣减、重复推送消息。
 */
function findTimeoutTasks(limit = 200) {
  return query(
    `SELECT id, user_id, taker_user_id, take_time, time_limit_min, reward
      FROM tasks
      WHERE status = ?
        AND is_late_reward_deducted = 0
        AND is_deleted = 0
        AND time_limit_min IS NOT NULL
        AND take_time IS NOT NULL
        AND DATE_ADD(take_time, INTERVAL time_limit_min MINUTE) <= NOW()
      LIMIT ?`,
    [TASK_STATUS_ENUM.TAKING, limit]
  );
}

/**
 * 扫描待雇主确认超过 2 小时的任务（自动确认完成 + 生成账单）
 * 注意：雇主已提交「未送达」申诉（is_disputed = 1）的任务会被排除，
 *      即提交申诉后不再触发倒计时自动确认，必须由雇主手动确认或管理员介入。
 */
function findAutoConfirmTasks(hours = 2, limit = 200) {
  return query(
    `SELECT id, taker_user_id, reward FROM tasks
      WHERE status = ?
        AND is_disputed = 0
        AND is_deleted = 0
        AND submit_finish_time IS NOT NULL
        AND DATE_ADD(submit_finish_time, INTERVAL ? HOUR) <= NOW()
      LIMIT ?`,
    [TASK_STATUS_ENUM.WAIT_CONFIRM, hours, limit]
  );
}

/**
 * 雇主提交「未送达」申诉
 * 乐观锁 + 幂等：WHERE id = ? AND status = 2 AND is_disputed = 0
 *   - 任务不是「待雇主确认」-> 0 行
 *   - 已提交过申诉（重复提交）-> 0 行
 * @param {number} taskId 任务ID
 * @param {string} reason 申诉原因（标签文案 + 补充说明）
 * @param {object|null} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示状态已变更或重复提交
 */
async function markDisputed(taskId, reason, conn = null) {
  const rows = await run(
    conn,
    `UPDATE tasks
        SET is_disputed = 1, dispute_reason = ?, dispute_time = NOW()
      WHERE id = ? AND status = ? AND is_disputed = 0`,
    [reason, taskId, TASK_STATUS_ENUM.WAIT_CONFIRM]
  );
  return rows.affectedRows;
}

/**
 * 标记「免费代拿次数已返还」（乐观锁 + 幂等占位）
 * ---------------------------------------------------------------------
 * 只有同时满足以下条件的任务才会被标记成功（affectedRows = 1）：
 *   1) 该任务确实使用了免费代拿权益发布（is_free_delivery = 1）
 *   2) 从未返还过（is_free_delivery_returned = 0）
 *   3) 从未被任何人接单（once_taken = 0）—— 一旦有人接单过，永久不再返还
 * 调用方拿到 1 之后再调用 User.returnFreeDelivery 增加账号次数，
 * 两层配合保证「同一条任务无论重复撤销多少次，都只返还一次权益」。
 * @param {number} taskId 任务ID
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示不满足返还条件或已返还过
 */
async function markFreeDeliveryReturned(taskId, conn) {
  const [result] = await conn.execute(
    `UPDATE tasks
        SET is_free_delivery_returned = 1
      WHERE id = ?
        AND is_free_delivery = 1
        AND is_free_delivery_returned = 0
        AND once_taken = 0`,
    [taskId]
  );
  return result.affectedRows;
}

/**
 * 雇主结束「已超时」的限时任务（双方任务同时结束）
 * 乐观锁：仅当 status = 1（进行中）时才生效，重复调用返回 0 行
 * 业务约定：超时后任务状态直接置为 4（超时取消），接单者不再获得收入账单，
 *   是否封禁接单者交由管理员在「封禁管理」中判定，不在本方法内处理。
 * @param {number} taskId 任务ID
 * @param {object} conn 事务连接
 * @returns {Promise<number>} 受影响行数，0 表示任务状态已变更
 */
async function ownerEndOvertime(taskId, conn) {
  const [result] = await conn.execute(
    'UPDATE tasks SET status = ? WHERE id = ? AND status = ?',
    [TASK_STATUS_ENUM.TIMEOUT_CANCEL, taskId, TASK_STATUS_ENUM.TAKING]
  );
  return result.affectedRows;
}

/** 查询任务送达照片数组 */
function getDeliveryImages(task) {
  if (!task) return [];
  return [task.delivery_img1, task.delivery_img2, task.delivery_img3].filter(Boolean);
}

/** 查询任务物品照片数组（接单人拿到 / 买到物品的凭证） */
function getPickupImages(task) {
  if (!task) return [];
  return [task.pickup_img1, task.pickup_img2, task.pickup_img3].filter(Boolean);
}

module.exports = {
  EDITABLE_FIELDS,
  ADMIN_EDITABLE_FIELDS,
  SORT_MAP,
  create,
  findById,
  findByIdForUpdate,
  takeTask,
  cancelTake,
  updateByOwner,
  updateByAdmin,
  adjustReward,
  submitFinish,
  ownerEndOvertime,
  deductLateReward,
  confirmFinish,
  markOwnerReceipt,
  confirmPickup,
  autoConfirmFinish,
  ownerCancel,
  timeoutCancel,
  timeoutDeductReward,
  markRefunded,
  softDelete,
  listHall,
  listByOwner,
  countByOwnerGroup,
  countUnfinishedByTaker,
  countPendingConfirmByOwner,
  listByTaker,
  searchForAdmin,
  findTimeoutTasks,
  findAutoConfirmTasks,
  markDisputed,
  markFreeDeliveryReturned,
  getDeliveryImages,
  getPickupImages
};
