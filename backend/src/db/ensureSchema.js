/**
 * =====================================================================
 * 数据库结构自愈（保证老库也能平滑升级到「账号编号」体系）
 * ---------------------------------------------------------------------
 * 背景：
 *   用户的对外账号编号（管理员 A0001、普通用户 X0001 起）存放在 users.account_no，
 *   但 project 早期版本的 users 表没有这一列。为了让「已经建过库」的环境
 *   也能直接启动，这里在服务启动时做一次幂等的结构检查：
 *     1) 检查 information_schema 是否存在 users.account_no 列，存在则直接返回
 *     2) 不存在则 ALTER TABLE 增加该列（先允许 NULL，便于回填历史数据）
 *     3) 按 id 顺序回填历史账号：管理员 A0001 起、普通用户 X0001 起
 *     4) 回填完成后改为 NOT NULL 并加唯一索引，保证账号编号全局唯一
 *   全新安装执行 sql/init.sql 时该列已存在，本函数是空操作。
 * =====================================================================
 */

const { pool } = require('./db');
const { buildAccountNo, log } = require('../utils/common');
const { isAdminStudent } = require('../utils/adminUtil');
const { TASK_ORDER } = require('../utils/constant');

/** 账号编号列定义（与 sql/init.sql 保持一致） */
const COLUMN_DEFINITION = "VARCHAR(10) NOT NULL UNIQUE COMMENT '对外账号编号：管理员A+4位(A0001)，普通用户X+4位(X0001起)'";

/**
 * 确保 users.account_no 列存在且已回填
 * @returns {Promise<{created:boolean, backfilled:number}>} created=是否本次新建了列
 */
async function ensureAccountNoColumn() {
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'account_no'`
  );
  if (columns.length) {
    return { created: false, backfilled: 0 };
  }

  log('warn', '检测到 users 表缺少 account_no 列，开始自动升级（历史数据将按 id 顺序回填编号）');
  // 第一步：先加可空列，避免历史数据回填前触发 NOT NULL 约束
  await pool.query("ALTER TABLE `users` ADD COLUMN `account_no` VARCHAR(10) NULL COMMENT '对外账号编号' AFTER `id`");

  // 第二步：按 id 升序回填，管理员与普通用户各自独立计数
  const [rows] = await pool.query('SELECT id, student_id FROM users ORDER BY id ASC');
  let adminSeq = 0;
  let normalSeq = 0;
  for (const row of rows) {
    const isAdmin = isAdminStudent(row.student_id);
    if (isAdmin) {
      adminSeq += 1;
    } else {
      normalSeq += 1;
    }
    await pool.execute('UPDATE users SET account_no = ? WHERE id = ?', [
      buildAccountNo(isAdmin ? adminSeq : normalSeq, isAdmin),
      row.id
    ]);
  }

  // 第三步：加唯一索引并收紧为 NOT NULL
  await pool.query(`ALTER TABLE \`users\` MODIFY COLUMN \`account_no\` ${COLUMN_DEFINITION}`);
  log('info', `account_no 列升级完成，共回填 ${rows.length} 个账号`);
  return { created: true, backfilled: rows.length };
}

/**
 * 通用列自愈：确保某张表存在指定列，缺失的列一次性 ALTER 补齐
 * @param {string} table 表名（来自本文件常量，不是用户输入）
 * @param {Array<{name:string, definition:string}>} columns 目标列定义
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureColumns(table, columns) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  const existing = new Set(rows.map((row) => row.name));
  const missing = columns.filter((column) => !existing.has(column.name));
  if (!missing.length) return [];

  const sql = 'ALTER TABLE `' + table + '` '
    + missing.map((column) => 'ADD COLUMN `' + column.name + '` ' + column.definition).join(', ');
  await pool.query(sql);
  return missing.map((column) => column.name);
}

/**
 * 确保「账号安全体系」的结构与列存在
 * ---------------------------------------------------------------------
 * 本次改造背景：下线短信验证码（按条计费且个人开发者难以通过模板审核），
 *   改为「注册时自选账号ID + 图形验证码防刷 + 密保问题找回 + 新设备登录需密保解锁」。
 * 涉及改动：
 *   1) users.phone 允许 NULL：手机号改为「选填联系方式」，仅供管理员人工联系，
 *      不再参与登录、不再参与身份验证（UNIQUE 索引保留，MySQL 允许多行 NULL）
 *   2) users 新增密保列：
 *        security_set        0 未设置 / 1 已设置（注册后必须设置才能使用小程序）
 *        sec_question1       密保问题一（题库文本快照）
 *        sec_answer1_hash    密保答案一（bcrypt 哈希，绝不存明文）
 *        sec_question2       密保问题二
 *        sec_answer2_hash    密保答案二（bcrypt 哈希）
 *        security_fail_count 密保答案连续错误次数
 *        security_lock_time  密保锁定截止时间
 *        security_updated_at 密保最近修改时间
 *        reset_pwd_time      最近一次通过密保重置密码的时间（24 小时限一次）
 *   3) 新增 user_device 表：记录「账号 ↔ 微信 openid / 设备标识」绑定关系，
 *      用于「同一常用设备免验证、换设备需答密保」
 * 说明：users.name / student_id 保持 NOT NULL，注册阶段写入空串，
 *      等校园认证通过后再写入真实姓名与真实学号（避免为改可空而重建索引的风险）。
 * @returns {Promise<{columns:string[], phoneNullable:boolean}>}
 */
async function ensureUserSecuritySchema() {
  // ---------- 1) 手机号改为允许为空（选填联系方式） ----------
  const [phoneCols] = await pool.query(
    `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'`
  );
  const phoneNullable = !phoneCols.length || phoneCols[0].nullable === 'YES';
  if (!phoneNullable) {
    await pool.query(
      'ALTER TABLE `users` MODIFY COLUMN `phone` VARCHAR(11) NULL DEFAULT NULL '
      + "COMMENT '联系手机号（选填，仅用于人工联系，不参与身份验证）'"
    );
    log('info', 'users.phone 已改为允许为空：手机号改为选填联系方式，不再参与身份验证');
  }

  // ---------- 2) 密保 / 重置密码相关列 ----------
  const added = await ensureColumns('users', [
    { name: 'security_set', definition: "TINYINT NOT NULL DEFAULT 0 COMMENT '密保设置状态：0未设置，1已设置'" },
    { name: 'sec_question1', definition: "VARCHAR(50) NOT NULL DEFAULT '' COMMENT '密保问题一'" },
    { name: 'sec_answer1_hash', definition: "VARCHAR(100) NOT NULL DEFAULT '' COMMENT '密保答案一（bcrypt哈希）'" },
    { name: 'sec_question2', definition: "VARCHAR(50) NOT NULL DEFAULT '' COMMENT '密保问题二'" },
    { name: 'sec_answer2_hash', definition: "VARCHAR(100) NOT NULL DEFAULT '' COMMENT '密保答案二（bcrypt哈希）'" },
    { name: 'security_fail_count', definition: "INT NOT NULL DEFAULT 0 COMMENT '密保答案连续错误次数'" },
    { name: 'security_lock_time', definition: 'DATETIME NULL COMMENT \'密保锁定截止时间，NULL 表示未锁定\'' },
    { name: 'security_updated_at', definition: 'DATETIME NULL COMMENT \'密保最近修改时间\'' },
    { name: 'reset_pwd_time', definition: 'DATETIME NULL COMMENT \'最近一次通过密保重置密码的时间\'' }
  ]);
  if (added.length) {
    // 老库新增列统一回填默认值，避免 NULL 影响等值判断
    await pool.query('UPDATE users SET security_set = 0 WHERE security_set IS NULL');
    await pool.query("UPDATE users SET sec_question1 = '' WHERE sec_question1 IS NULL");
    await pool.query("UPDATE users SET sec_question2 = '' WHERE sec_question2 IS NULL");
    await pool.query('UPDATE users SET security_fail_count = 0 WHERE security_fail_count IS NULL');
    log('info', `users 表账号安全列升级完成，新增列：${added.join(', ')}`);
  }

  // ---------- 3) 账号-设备绑定表 ----------
  await pool.query(
    'CREATE TABLE IF NOT EXISTS `user_device` ('
    + '`id` INT PRIMARY KEY AUTO_INCREMENT,'
    + "`user_id` INT NOT NULL COMMENT '账号主键 users.id',"
    + "`openid` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '微信 openid（同一个小程序内该微信号唯一）',"
    + "`device_id` VARCHAR(100) NOT NULL COMMENT '设备标识（小程序端生成的设备指纹）',"
    + "`device_name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '设备名称，用于个人中心展示',"
    + '`last_login_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT \'最近一次使用该设备登录的时间\','
    + '`created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,'
    + 'UNIQUE KEY `uk_user_device` (`user_id`, `device_id`),'
    + 'KEY `idx_device_openid` (`openid`),'
    + 'CONSTRAINT `fk_user_device_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=\'账号-设备绑定表（新设备登录需密保解锁）\''
  );

  return { columns: added, phoneNullable: true };
}

/**
 * 确保 tasks 表的「未送达申诉」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：雇主在「待雇主确认」阶段可以提交「未送达」申诉（标签 + 补充说明），
 *   提交后该任务不再参与「超过 2 小时自动确认完成」的定时判定，
 *   必须由雇主手动确认送达或管理员介入处理。
 * 涉及列：
 *   is_disputed    0 未申诉 / 1 已申诉（定时任务据此跳过自动确认）
 *   dispute_reason 申诉原因（标签文案 + 其他说明）
 *   dispute_time   申诉提交时间
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskDisputeColumns() {
  const added = await ensureColumns('tasks', [
    { name: 'is_disputed', definition: "TINYINT DEFAULT 0 COMMENT '雇主未送达申诉：0否，1是（为1时不再自动确认收货）'" },
    { name: 'dispute_reason', definition: "VARCHAR(300) DEFAULT '' COMMENT '未送达申诉原因（标签+补充说明）'" },
    { name: 'dispute_time', definition: 'DATETIME NULL COMMENT \'未送达申诉提交时间\'' }
  ]);
  if (added.length) {
    // 老库新增列的存量行统一回填默认值，避免 NULL 影响定时任务的等值判断
    await pool.query('UPDATE tasks SET is_disputed = 0 WHERE is_disputed IS NULL');
    await pool.query("UPDATE tasks SET dispute_reason = '' WHERE dispute_reason IS NULL");
    log('info', `tasks 表结构升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 tasks 表的「超时送达 / 超时扣酬金」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：限时任务接单后开始倒计时，跑腿员超过 time_limit_min 才提交送达即为「超时送达」。
 *   此时任务已经是「待雇主确认」，雇主可以在确认前对酬金做一次性的超时扣减
 *   （扣减金额 = 酬金 × 5%，不足 0.5 元按 0.5 元），确认送达后账单按扣减后的酬金记账。
 * 涉及列：
 *   is_late_delivery          0 按时送达 / 1 超时送达
 *   late_delivery_seconds     超时秒数（用于展示「超时 xx 分 xx 秒」）
 *   is_late_reward_deducted   0 未扣减 / 1 已按超时扣减（保证扣减只生效一次）
 *   late_reward_deduct        实际扣减金额
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskLateDeliveryColumns() {
  const added = await ensureColumns('tasks', [
    { name: 'is_late_delivery', definition: "TINYINT DEFAULT 0 COMMENT '是否超时送达：0否，1是'" },
    { name: 'late_delivery_seconds', definition: "INT DEFAULT 0 COMMENT '超时送达的超出秒数'" },
    { name: 'is_late_reward_deducted', definition: "TINYINT DEFAULT 0 COMMENT '是否已按超时送达扣减酬金：0否，1是'" },
    { name: 'late_reward_deduct', definition: "DECIMAL(5,2) DEFAULT 0.00 COMMENT '超时送达实际扣减的酬金金额'" }
  ]);
  if (added.length) {
    // 老库新增列的存量行统一回填默认值，避免 NULL 影响等值判断与金额计算
    await pool.query('UPDATE tasks SET is_late_delivery = 0 WHERE is_late_delivery IS NULL');
    await pool.query('UPDATE tasks SET late_delivery_seconds = 0 WHERE late_delivery_seconds IS NULL');
    await pool.query('UPDATE tasks SET is_late_reward_deducted = 0 WHERE is_late_reward_deducted IS NULL');
    await pool.query('UPDATE tasks SET late_reward_deduct = 0.00 WHERE late_reward_deduct IS NULL');
    log('info', `tasks 表结构升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 users 表的「管理员封禁」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：限时任务超时后不再由系统自动封禁接单用户，
 *   改由管理员在「管理员后台 - 封禁管理」中手动封禁 / 解封 / 加时。
 *   users.ban_take_time 依旧是唯一生效字段（禁止接单截止时间，NULL 表示未封禁），
 *   以下列仅用于后台展示「谁封的、为什么封、什么时候封的」。
 * 涉及列：
 *   ban_reason      封禁原因（管理员填写）
 *   ban_operator_id 操作管理员 user_id
 *   ban_created_at  封禁创建时间
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureUserBanColumns() {
  const added = await ensureColumns('users', [
    { name: 'ban_reason', definition: "VARCHAR(200) DEFAULT '' COMMENT '接单封禁原因（管理员填写）'" },
    { name: 'ban_operator_id', definition: 'INT NULL COMMENT \'执行封禁的管理员 user_id\'' },
    { name: 'ban_created_at', definition: 'DATETIME NULL COMMENT \'封禁创建时间\'' }
  ]);
  if (added.length) {
    await pool.query("UPDATE users SET ban_reason = '' WHERE ban_reason IS NULL");
    log('info', `users 表结构升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 tasks 表的「任务订单号」列存在
 * ---------------------------------------------------------------------
 * 业务背景：每发布一个任务都会生成一个全局唯一的订单号（GCPT + 数字）。
 *   订单号在任务卡片 / 任务详情页展示；用户举报任务时会连同订单号与
 *   「雇主 / 接单人」双方的账号ID / 学号 / 手机号 一起上报，供管理员核对。
 * 涉及列：
 *   order_no  GCPT + 补零到 6 位的任务主键 id（如 GCPT000123），带唯一索引
 * 老库升级：新增列后按 id 回填历史任务，并补建唯一索引（回填口径与
 *   common.js 的 buildTaskOrderNo 完全一致，避免两处规则漂移）。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskOrderNoColumn() {
  const added = await ensureColumns('tasks', [
    { name: 'order_no', definition: "VARCHAR(32) DEFAULT NULL COMMENT '任务订单号：GCPT+数字（如 GCPT000123），全局唯一'" }
  ]);

  // ensureColumns 只负责列，唯一索引单独检查
  const [indexes] = await pool.query(
    "SELECT INDEX_NAME AS name FROM information_schema.STATISTICS"
      + " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND INDEX_NAME = 'uk_tasks_order_no'"
  );
  const needIndex = indexes.length === 0;

  // 回填历史任务：GCPT + 6 位补零 id（order_no 是 NULL / 空串的老数据）
  await pool.query(
    "UPDATE tasks SET order_no = CONCAT(?, LPAD(id, ?, '0'))"
      + " WHERE order_no IS NULL OR order_no = ''",
    [TASK_ORDER.PREFIX, TASK_ORDER.PAD]
  );

  if (needIndex) {
    await pool.query('ALTER TABLE `tasks` ADD UNIQUE KEY `uk_tasks_order_no` (`order_no`)');
  }

  if (added.length || needIndex) {
    log('info', `tasks 表订单号升级完成，新增列：${added.join(', ') || '无'}，唯一索引：${needIndex ? '已创建' : '已存在'}`);
  }
  return added;
}

/**
 * 确保 report 表的「举报类型」列存在
 * ---------------------------------------------------------------------
 * 业务背景：举报分为两类，管理员后台按类型区分展示与处理：
 *   1 普通举报       任何登录用户提交
 *   2 恶意超时投诉   限时任务超时后由雇主提交，直接送达管理员
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureReportColumns() {
  const added = await ensureColumns('report', [
    { name: 'report_type', definition: "TINYINT DEFAULT 1 COMMENT '举报类型：1普通举报，2恶意超时投诉'" },
    { name: 'order_no', definition: "VARCHAR(32) DEFAULT '' COMMENT '被举报任务的订单号快照（GCPT+数字）'" },
    { name: 'owner_user_id', definition: 'INT NULL COMMENT \'雇主账号 user_id 快照\'' },
    { name: 'owner_student_id', definition: "VARCHAR(20) DEFAULT '' COMMENT '雇主学号快照'" },
    { name: 'owner_phone', definition: "VARCHAR(11) DEFAULT '' COMMENT '雇主手机号快照'" },
    { name: 'taker_user_id', definition: 'INT NULL COMMENT \'接单人账号 user_id 快照\'' },
    { name: 'taker_student_id', definition: "VARCHAR(20) DEFAULT '' COMMENT '接单人学号快照'" },
    { name: 'taker_phone', definition: "VARCHAR(11) DEFAULT '' COMMENT '接单人手机号快照'" }
  ]);
  if (added.length) {
    // 老数据全部视为普通举报
    await pool.query('UPDATE report SET report_type = 1 WHERE report_type IS NULL');
    await pool.query("UPDATE report SET order_no = '' WHERE order_no IS NULL");
    // 历史举报回填：按当前任务数据补齐订单号与双方账号信息，
    // 保证管理员在「举报管理」里对老举报同样能看到订单（先写 id，再按 id 补学号 / 手机号）
    await pool.query(
      'UPDATE report r JOIN tasks t ON t.id = r.task_id '
      + "SET r.order_no = COALESCE(t.order_no, ''), r.owner_user_id = t.user_id,"
      + ' r.taker_user_id = t.taker_user_id'
    );
    await pool.query(
      'UPDATE report r JOIN users u ON u.id = r.owner_user_id '
      + "SET r.owner_student_id = COALESCE(u.student_id, ''), r.owner_phone = COALESCE(u.phone, '')"
    );
    await pool.query(
      'UPDATE report r JOIN users u ON u.id = r.taker_user_id '
      + "SET r.taker_student_id = COALESCE(u.student_id, ''), r.taker_phone = COALESCE(u.phone, '')"
    );
    log('info', `report 表结构升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保「邀请码免费代拿」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：使用邀请码注册的新用户可获赠「7 天内 1 次快递免费代拿」权益，
 *   在发布任务时勾选该权益即可免缴 0.1 元平台信息服务费（仅限一件包裹）。
 * 涉及列：
 *   users.invited_by            邀请人 user_id（邀请关系归属，便于追溯）
 *   users.invite_code_used      注册时填写的邀请码快照
 *   users.free_delivery_count   剩余免费代拿次数（0 表示无可用权益）
 *   users.free_delivery_expire  免费代拿次数有效期（注册后 7 天）
 *   users.free_delivery_used_at 免费代拿次数最近一次使用时间
 *   tasks.is_free_delivery      该任务是否使用免费代拿权益发布（1 时 service_fee = 0）
 *   tasks.is_free_delivery_returned 免费代拿次数是否已返还（撤销且从未被接单时返还 1 次）
 * 说明：老库升级时新增列全部带默认值（0 / '' / NULL），历史用户天然「无可用权益」，
 *      历史任务 is_free_delivery = 0，不影响任何既有数据与业务判定。
 * @returns {Promise<string[]>} 本次新增的列名（users 与 tasks 合并）
 */
async function ensureInviteCouponColumns() {
  const userAdded = await ensureColumns('users', [
    { name: 'invited_by', definition: 'INT NULL COMMENT \'邀请人 user_id\'' },
    { name: 'invite_code_used', definition: "VARCHAR(20) DEFAULT '' COMMENT '注册时填写使用的邀请码快照'" },
    { name: 'free_delivery_count', definition: "TINYINT NOT NULL DEFAULT 0 COMMENT '剩余快递免费代拿次数'" },
    { name: 'free_delivery_expire', definition: 'DATETIME NULL COMMENT \'免费代拿次数有效期截止时间\'' },
    { name: 'free_delivery_used_at', definition: 'DATETIME NULL COMMENT \'免费代拿次数最近一次使用时间\'' }
  ]);
  if (userAdded.length) {
    // 历史数据兜底：保证计数与快照字段不为 NULL，业务查询无需额外判空
    await pool.query('UPDATE users SET free_delivery_count = 0 WHERE free_delivery_count IS NULL');
    await pool.query("UPDATE users SET invite_code_used = '' WHERE invite_code_used IS NULL");
    log('info', `users 表邀请码权益升级完成，新增列：${userAdded.join(', ')}`);
  }

  const taskAdded = await ensureColumns('tasks', [
    {
      name: 'is_free_delivery',
      definition: "TINYINT DEFAULT 0 COMMENT '是否使用免费代拿权益发布：0否，1是'"
    },
    {
      name: 'is_free_delivery_returned',
      definition: "TINYINT DEFAULT 0 COMMENT '免费代拿次数是否已返还：0否，1是'"
    }
  ]);
  if (taskAdded.length) {
    await pool.query('UPDATE tasks SET is_free_delivery = 0 WHERE is_free_delivery IS NULL');
    await pool.query('UPDATE tasks SET is_free_delivery_returned = 0 WHERE is_free_delivery_returned IS NULL');
    log('info', `tasks 表免费代拿标记升级完成，新增列：${taskAdded.join(', ')}`);
  }

  return userAdded.concat(taskAdded);
}

/**
 * 确保「账号注销」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：用户 / 管理员可以注销账号。注销后：
 *   - 手机号与学号被释放（改写为不可注册的占位值），可以被新账号重新使用；
 *   - 个人资料（姓名 / 昵称 / 头像 / 认证截图）全部清空；
 *   - 账号不可再登录（登录接口与鉴权中间件都会拦截至 deactivated_at 非空的账号）；
 *   - 历史任务 / 账单 / 举报等记录仍然保留，供对方当事人继续查看。
 * 涉及列：
 *   users.deactivated_at  NULL 表示正常账号；非 NULL 为该账号的注销时间
 * 说明：老库升级时该列默认 NULL，即所有历史账号天然「未注销」，不影响任何既有业务。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureUserDeactivateColumn() {
  const added = await ensureColumns('users', [
    {
      name: 'deactivated_at',
      definition: "DATETIME NULL COMMENT '账号注销时间，NULL 为正常账号；注销后手机号/学号被释放'"
    }
  ]);
  if (added.length) {
    // 新列默认全部为 NULL，历史账号天然「未注销」，无需回填
    log('info', `users 表账号注销列升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 tasks 表的「取件码 / 详细地址」两个选填列存在
 * ---------------------------------------------------------------------
 * 业务背景：发布任务时雇主可以额外填写
 *   - 取件码：如菜鸟驿站的取件码，跑腿员凭码取件（仅雇主与接单者可见，避免被他人冒领）；
 *   - 详细地址：在「送达地址」之外补充更精确的位置（门牌 / 房间号 / 工位等）。
 * 两列均为选填，老库升级时统一补默认空串，历史任务查询无需额外判空。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskExtraColumns() {
  const added = await ensureColumns('tasks', [
    {
      name: 'pickup_code',
      definition: "VARCHAR(20) DEFAULT '' COMMENT '取件码（选填，如驿站取件码；仅雇主与接单者可见）'"
    },
    {
      name: 'detail_address',
      definition: "VARCHAR(100) DEFAULT '' COMMENT '详细地址（选填，如具体门牌/房间号/工位）'"
    }
  ]);
  if (added.length) {
    // 新列默认全部为空串，历史任务视为「未填写」，无需回填
    await pool.query("UPDATE tasks SET pickup_code = '' WHERE pickup_code IS NULL");
    await pool.query("UPDATE tasks SET detail_address = '' WHERE detail_address IS NULL");
    log('info', `tasks 表取件码 / 详细地址列升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 tasks 表的「管理员删除」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景：管理员在任务详情页可以删除有问题的任务（虚假任务 / 违规内容等）。
 *   【为什么用软删除】tasks 已被 payments / user_bill / report 通过外键引用，
 *   物理删除会破坏支付流水、账单与举报记录（管理员处置留痕也会丢失），
 *   因此这里只在 tasks 上打删除标记：任务从「任务大厅 / 我的发布 / 我的任务」
 *   全部列表中消失，但数据完整保留，账单点进详情仍能看到该任务与删除提示。
 * 涉及列：
 *   is_deleted       0 正常 / 1 已被管理员删除（列表查询与定时任务的过滤条件）
 *   delete_reason    管理员填写的删除原因（选填，仅管理员可见）
 *   delete_time      删除时间
 *   delete_admin_id  执行删除的管理员 user_id（审计留痕）
 * 说明：老库升级时 is_deleted 默认 0，历史任务天然「未删除」，不影响任何既有业务。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskDeletedColumns() {
  const added = await ensureColumns('tasks', [
    {
      name: 'is_deleted',
      definition: "TINYINT NOT NULL DEFAULT 0 COMMENT '管理员删除标记：0正常，1已被管理员删除'"
    },
    {
      name: 'delete_reason',
      definition: "VARCHAR(200) DEFAULT '' COMMENT '管理员删除原因（选填，仅管理员可见）'"
    },
    {
      name: 'delete_time',
      definition: "DATETIME NULL COMMENT '管理员删除时间'"
    },
    {
      name: 'delete_admin_id',
      definition: "INT NULL COMMENT '执行删除操作的管理员 user_id'"
    }
  ]);
  if (added.length) {
    // 新列默认 0 / 空串，历史任务视为「未删除」，无需回填
    await pool.query('UPDATE tasks SET is_deleted = 0 WHERE is_deleted IS NULL');
    await pool.query("UPDATE tasks SET delete_reason = '' WHERE delete_reason IS NULL");
    log('info', `tasks 表管理员删除标记升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保 audit_apply 表的「申请作废」标记列存在
 * ---------------------------------------------------------------------
 * 业务背景：同一用户同类型审核只能有 1 条待审核申请，提交新申请时旧申请会被自动撤销。
 *   撤销后的旧记录如果继续出现在管理员审核列表里，管理员会看到同一个人多条「认证申请」，
 *   容易误处理（甚至把已经作废的旧申请点成「通过」）。
 *   因此这里增加 is_void 标记：被新申请覆盖的旧记录置 1，
 *   管理员审核列表只展示 is_void = 0 的记录（我的审核记录仍然保留完整历史）。
 * 涉及列：
 *   is_void  0 正常 / 1 已被新申请作废（不计入管理员审核列表）
 * 说明：老库升级时默认 0，历史申请天然「未作废」，不影响既有数据；
 *      升级时同步把历史上「被新申请覆盖」的旧记录补上标记，避免升级后管理员仍看到重复申请。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureAuditVoidColumn() {
  const added = await ensureColumns('audit_apply', [
    {
      name: 'is_void',
      definition: "TINYINT NOT NULL DEFAULT 0 COMMENT '是否已被新申请作废：0正常，1作废'"
    }
  ]);
  if (added.length) {
    await pool.query('UPDATE audit_apply SET is_void = 0 WHERE is_void IS NULL');
    // 历史数据回填：以前被 cancelPending 撤销过的旧申请，reject_reason 只有两种取值
    // （「已被新申请覆盖」/「已有新的认证申请」）；这些记录本来就不该出现在管理员审核列表里，
    // 这里按原因一次性补上作废标记。
    const [result] = await pool.query(
      "UPDATE audit_apply SET is_void = 1 WHERE reject_reason IN ('已被新申请覆盖', '已有新的认证申请')"
    );
    log('info', `audit_apply 表申请作废列升级完成，新增列：${added.join(', ')}，`
      + `历史作废记录回填 ${result.affectedRows} 条`);
  }
  return added;
}

/**
 * 确保「设备登录 IP / 归属地」与「顶号提示」结构存在
 * ---------------------------------------------------------------------
 * 业务背景：
 *   1) 单设备登录规则下，新设备登录会把旧设备顶下线。旧设备此前只是静默失效，
 *      用户既不知道发生了什么，也无法判断是不是被盗号，因此需要记录一条「顶号记录」，
 *      由被顶下线的设备在下次请求时取走并弹窗提示（设备名 / 时间 / IP / 归属地）。
 *   2)「我的 - 设备管理」需要展示每台设备的「登录地点（省-市）」，便于用户识别陌生设备。
 * 涉及改动：
 *   user_device 新增两列：
 *     login_ip      最近一次使用该设备登录的 IP（IPv4 / IPv6 均可能，留 45 位）
 *     login_region  IP 归属地（省-市，如「湖北-随州」，解析失败为空串）
 *   新增 user_kick 表：记录「谁把谁顶下线 + 新设备的名称/时间/IP/归属地」。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureDeviceIpAndKickSchema() {
  const added = await ensureColumns('user_device', [
    { name: 'login_ip', definition: "VARCHAR(45) NOT NULL DEFAULT '' COMMENT '最近一次使用该设备登录的 IP'" },
    { name: 'login_region', definition: "VARCHAR(50) NOT NULL DEFAULT '' COMMENT '登录 IP 归属地（省-市，如 湖北-随州）'" }
  ]);
  if (added.length) {
    log('info', `user_device 表登录 IP / 归属地列升级完成，新增列：${added.join(', ')}`);
  }

  await pool.query(
    'CREATE TABLE IF NOT EXISTS `user_kick` ('
    + '`id` INT PRIMARY KEY AUTO_INCREMENT,'
    + "`user_id` INT NOT NULL COMMENT '账号主键 users.id',"
    + "`device_id` VARCHAR(100) NOT NULL COMMENT '被顶下线的设备标识',"
    + "`device_name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '被顶下线的设备名称',"
    + "`new_device_id` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '发起登录的新设备标识',"
    + "`new_device_name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '发起登录的新设备名称',"
    + "`login_ip` VARCHAR(45) NOT NULL DEFAULT '' COMMENT '新设备登录 IP',"
    + "`login_region` VARCHAR(50) NOT NULL DEFAULT '' COMMENT '新设备登录 IP 归属地（省-市）',"
    + '`kick_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT \'顶号发生时间\','
    + "`is_read` TINYINT NOT NULL DEFAULT 0 COMMENT '被顶设备是否已收到提示：0未提示，1已提示',"
    + 'KEY `idx_kick_device` (`user_id`, `device_id`, `is_read`),'
    + 'CONSTRAINT `fk_user_kick_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=\'登录顶号记录（告知被下线设备）\''
  );
  return added;
}

/**
 * 确保「物品照片」列存在（接单者提交完成时必须上传两类照片）
 * ---------------------------------------------------------------------
 * 业务背景：
 *   跑腿员提交任务完成时需要两张凭证：
 *     1) 物品照片（pickup_img1~3）：确认已经拿到 / 买到物品
 *     2) 送达照片（delivery_img1~3，早已存在）：确认已经送到
 *   两类照片都至少 1 张才允许提交，缺一不可。
 * 涉及列：tasks.pickup_img1 / pickup_img2 / pickup_img3（各最多 1 张，最多 3 张）
 * 说明：老库升级时默认空串，历史任务天然「没有物品照片」，不影响既有数据。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskPickupImages() {
  const added = await ensureColumns('tasks', [
    { name: 'pickup_img1', definition: "VARCHAR(255) DEFAULT '' COMMENT '物品照片1（接单人拿到/买到物品的凭证）'" },
    { name: 'pickup_img2', definition: "VARCHAR(255) DEFAULT '' COMMENT '物品照片2'" },
    { name: 'pickup_img3', definition: "VARCHAR(255) DEFAULT '' COMMENT '物品照片3'" }
  ]);
  if (added.length) {
    log('info', `tasks 表物品照片列升级完成，新增列：${added.join(', ')}`);
  }
  return added;
}

/**
 * 确保「任务类型 / 帮带物品 / 确认取货 / 雇主确认收货」四列存在
 * ---------------------------------------------------------------------
 * 业务背景（本轮新增）：
 *   1) task_type：发布时选的是哪个快捷模板（取快递 / 食堂带饭 / 打印资料 / 超市代买 / 其他），
 *      任务卡与详情页据此展示类型标签，也是「取件码 / 帮带物品」必填规则的判定依据；
 *   2) item_name：需要别人帮带的物品（取快递时是选填的包裹描述）；
 *   3) pickup_confirm_time：接单人点「确认取货」的时间。写入即代表物品照片已锁定：
 *      照片不能再改、接单人不能再取消接单、雇主不能再撤销任务，进度第 2 段「已取货」点亮；
 *   4) owner_receipt_time：雇主点「确认收货」的时间。写入后进入进度第 4 段「待支付」
 *      （提示线下转账），雇主再点「完成任务」才走到第 5 段「完成」。
 * 说明：四列对新老库都安全 —— task_type 历史任务默认 0（其他），两个时间列默认 NULL
 *      （NULL = 该动作没发生过），无需回填任何历史数据。
 * @returns {Promise<string[]>} 本次新增的列名
 */
async function ensureTaskFlowColumns() {
  const added = await ensureColumns('tasks', [
    {
      name: 'task_type',
      definition: "TINYINT NOT NULL DEFAULT 0 COMMENT '任务类型：0其他/自定义，1取快递，2食堂带饭，3打印资料，4超市代买'"
    },
    {
      name: 'item_name',
      definition: "VARCHAR(60) DEFAULT '' COMMENT '帮带物品名称（取快递时选填，用于描述包裹）'"
    },
    {
      name: 'pickup_confirm_time',
      definition: "DATETIME NULL COMMENT '接单人确认取货时间；非空表示物品照片已锁定、不可撤销'"
    },
    {
      name: 'owner_receipt_time',
      definition: "DATETIME NULL COMMENT '雇主确认收货时间；非空表示已进入待支付（进度4）'"
    }
  ]);
  if (added.length) {
    // 历史任务：类型归入「其他」，帮带物品为空串；两个时间列保持 NULL（表示该动作未发生）
    await pool.query("UPDATE tasks SET item_name = '' WHERE item_name IS NULL");
    log('info', 'tasks 表任务类型 / 帮带物品 / 确认取货 / 确认收货列升级完成，新增列：' + added.join(', '));
  }
  return added;
}

/**
 * 确保「公告」表存在（跑马灯 / 全局通知条）
 * ---------------------------------------------------------------------
 * 业务背景：管理员后台需要一键发布公告，用户端在首页顶部跑马灯、
 *   各页顶部通知条展示「所有用户都能看到」的内容。
 * 表结构见 sql/init.sql 第 10 节；本函数保证老库启动后自动补表。
 * @returns {Promise<void>}
 */
async function ensureAnnounceSchema() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS `announcements` ('
    + '`id` INT PRIMARY KEY AUTO_INCREMENT,'
    + "\`scope\` TINYINT NOT NULL DEFAULT 1 COMMENT '展示位置：1跑马灯，2全局通知条',"
    + "\`content\` VARCHAR(200) NOT NULL COMMENT '公告正文（管理员只需填这一项）',"
    + "\`is_active\` TINYINT NOT NULL DEFAULT 1 COMMENT '0已下架，1生效中',"
    + "\`sort\` INT NOT NULL DEFAULT 0 COMMENT '排序值，越大越靠前',"
    + "\`start_at\` DATETIME NULL COMMENT '生效开始时间，NULL=立即生效',"
    + "\`end_at\` DATETIME NULL COMMENT '生效结束时间，NULL=长期有效',"
    + "\`is_closable\` TINYINT NOT NULL DEFAULT 1 COMMENT '通知条是否允许用户关闭',"
    + "\`push_count\` INT NOT NULL DEFAULT 0 COMMENT '发布时写入消息中心的用户数',"
    + "\`creator_id\` INT NULL COMMENT '发布管理员 user_id',"
    + '\`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,'
    + '\`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,'
    + 'KEY `idx_announce_scope` (`scope`, `is_active`, `sort`)'
    + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=\'公告（跑马灯 / 全局通知条）\''
  );
}

/**
 * 确保「发布券（虚拟支付）」相关列存在
 * ---------------------------------------------------------------------
 * 业务背景（B 方案：个人主体 + 微信虚拟支付）：
 *   微信个人主体的虚拟支付**不支持退款**，因此把「撤销退费」改成「返还发布券」：
 *     1) 发布任务时若账号有发布券，直接扣 1 张券免付 0.1 元；
 *     2) 没有券则正常支付 0.1 元（模拟模式直接成功 / 虚拟支付唤起微信收银台）；
 *     3) 撤销任务符合条件时返还 1 张发布券（价值等同 0.1 元），下次发布可直接抵扣。
 * 涉及列：
 *   users.publish_coupon_count  发布券余额（撤销任务返还，0 表示无可用券）
 *   tasks.pay_channel           本单发布费用的来源：
 *                                 0 = 邀请码免费代拿权益（service_fee = 0，撤销返还权益）
 *                                 1 = 现金支付 0.1 元（撤销返还 1 张发布券）
 *                                 2 = 发布券抵扣（service_fee = 0，撤销返还 1 张发布券）
 * 说明：老库升级时两列都带默认值（0 / 1），历史用户天然「无券」、
 *      历史任务 pay_channel = 1（现金单），撤销时按新规则返还发布券，不影响任何既有数据。
 * @returns {Promise<string[]>} 本次新增的列名（users 与 tasks 合并）
 */
async function ensurePublishCouponSchema() {
  const userAdded = await ensureColumns('users', [
    {
      name: 'publish_coupon_count',
      definition: "INT NOT NULL DEFAULT 0 COMMENT '发布券余额（撤销任务返还，1张可抵扣1次发布）'"
    }
  ]);
  if (userAdded.length) {
    await pool.query('UPDATE users SET publish_coupon_count = 0 WHERE publish_coupon_count IS NULL');
    log('info', `users 表发布券列升级完成，新增列：${userAdded.join(', ')}`);
  }

  const taskAdded = await ensureColumns('tasks', [
    {
      name: 'pay_channel',
      definition: "TINYINT NOT NULL DEFAULT 1 COMMENT '发布费用来源：0免费权益，1现金支付，2发布券'"
    }
  ]);
  if (taskAdded.length) {
    // 历史任务全部是现金支付的 0.1 元单，默认 1 与事实一致
    await pool.query('UPDATE tasks SET pay_channel = 1 WHERE pay_channel IS NULL');
    log('info', `tasks 表发布费用来源列升级完成，新增列：${taskAdded.join(', ')}`);
  }

  return userAdded.concat(taskAdded);
}

module.exports = {
  ensureTaskFlowColumns,
  ensureTaskPickupImages,
  ensureAccountNoColumn,
  ensureUserSecuritySchema,
  ensureTaskDisputeColumns,
  ensureTaskLateDeliveryColumns,
  ensureUserBanColumns,
  ensureReportColumns,
  ensureTaskOrderNoColumn,
  ensureInviteCouponColumns,
  ensureUserDeactivateColumn,
  ensureTaskExtraColumns,
  ensureTaskDeletedColumns,
  ensureAuditVoidColumn,
  ensureDeviceIpAndKickSchema,
  ensureAnnounceSchema,
  ensurePublishCouponSchema,
  ensureColumns
};
