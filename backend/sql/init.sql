-- =====================================================================
-- 校园跑腿小程序 数据库初始化脚本
-- 数据库：MySQL 8.0   字符集：utf8mb4
-- 执行方式：mysql -u root -p < init.sql
-- =====================================================================

CREATE DATABASE IF NOT EXISTS `campus_errand`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE `campus_errand`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `user_bill`;
DROP TABLE IF EXISTS `payments`;
DROP TABLE IF EXISTS `report`;
DROP TABLE IF EXISTS `messages`;
DROP TABLE IF EXISTS `appeals`;
DROP TABLE IF EXISTS `audit_apply`;
DROP TABLE IF EXISTS `tasks`;
DROP TABLE IF EXISTS `sms_code`;
DROP TABLE IF EXISTS `announcements`;
DROP TABLE IF EXISTS `users`;

SET FOREIGN_KEY_CHECKS = 1;

-- 1. 用户表 users
CREATE TABLE `users` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键user_id，内部账号',
  `account_no` VARCHAR(10) NOT NULL UNIQUE COMMENT '对外账号编号：管理员A+4位(A0001)，普通用户X+4位(X0001起)',
  `student_id` VARCHAR(20) NOT NULL COMMENT '学号，注册初始值，认证后更新为真实学号',
  `password_hash` VARCHAR(100) NOT NULL COMMENT 'bcrypt哈希密码',
  `name` VARCHAR(20) NOT NULL COMMENT '真实姓名，认证后更新',
  `phone` VARCHAR(11) NOT NULL UNIQUE COMMENT '登录手机号，永久唯一',
  `nickname` VARCHAR(30) NOT NULL COMMENT '用户昵称',
  `nickname_modify_count` TINYINT DEFAULT 1 COMMENT '昵称剩余修改次数，驳回不扣，通过才消耗',
  `avatar` VARCHAR(255) DEFAULT '' COMMENT '头像图片地址',
  `is_avatar_audit` TINYINT DEFAULT 0 COMMENT '0无申请，1待审核，2通过，3驳回',
  `campus_cert_img` VARCHAR(255) DEFAULT '' COMMENT '校园认证截图',
  `is_campus_audit` TINYINT DEFAULT 0 COMMENT '0无申请，1待审核，2通过，3驳回',
  `is_admin` TINYINT DEFAULT 0 COMMENT '0普通用户，1管理员（仅展示，权限以后端白名单为准）',
  `invite_code` VARCHAR(20) UNIQUE COMMENT '专属邀请码，注册时生成',
  `invited_by` INT NULL COMMENT '邀请人 user_id：注册时填写邀请码后记录归属人，未填写为 NULL',
  `invite_code_used` VARCHAR(20) DEFAULT '' COMMENT '注册时填写使用的邀请码（快照，便于追溯邀请关系）',
  `free_delivery_count` TINYINT NOT NULL DEFAULT 0 COMMENT '剩余快递免费代拿次数（填写邀请码注册赠送）',
  `free_delivery_expire` DATETIME NULL COMMENT '免费代拿次数有效期截止时间（注册后7天）',
  `free_delivery_used_at` DATETIME NULL COMMENT '免费代拿次数最近一次使用时间',
  `ban_take_time` DATETIME NULL COMMENT '禁止接单截止时间，NULL为未封禁',
  `ban_reason` VARCHAR(200) DEFAULT '' COMMENT '接单封禁原因（管理员填写）',
  `ban_operator_id` INT NULL COMMENT '执行封禁的管理员 user_id',
  `ban_created_at` DATETIME NULL COMMENT '封禁创建时间',
  `login_fail_count` INT DEFAULT 0 COMMENT '连续密码错误次数',
  `login_lock_time` DATETIME NULL COMMENT '账号登录锁定截止时间',
  `last_login_time` DATETIME NULL,
  `login_device_id` VARCHAR(100) DEFAULT '' COMMENT '设备标识，单设备登录校验',
  `deactivated_at` DATETIME NULL COMMENT '账号注销时间，NULL 为正常账号；注销后手机号/学号被释放',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_users_student` (`student_id`),
  KEY `idx_users_campus_audit` (`is_campus_audit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 跑腿任务表 tasks【核心业务表】
CREATE TABLE `tasks` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `order_no` VARCHAR(32) DEFAULT NULL COMMENT '任务订单号：GCPT+数字（如 GCPT000123），全局唯一',
  `user_id` INT NOT NULL COMMENT '雇主user_id',
  `receiver_name` VARCHAR(20) NOT NULL COMMENT '收件人姓名',
  `receiver_phone` VARCHAR(11) NOT NULL COMMENT '收件人手机号',
  `pickup_code` VARCHAR(20) DEFAULT '' COMMENT '取件码（选填，如驿站取件码；仅雇主与接单者可见）',
  `task_type` TINYINT NOT NULL DEFAULT 0 COMMENT '任务类型：0其他，1取快递，2食堂带饭，3打印资料，4超市代买（决定取件码/帮带物品哪个必填）',
  `item_name` VARCHAR(60) DEFAULT '' COMMENT '需要跑腿员帮带的物品（带饭/打印/代买必填，取快递选填）',
  `deliver_address` VARCHAR(100) NOT NULL COMMENT '送达地址',
  `detail_address` VARCHAR(100) DEFAULT '' COMMENT '详细地址（选填，如具体门牌/房间号/工位）',
  `time_limit_min` INT NULL COMMENT '接单后限时分钟，NULL代表不限时',
  `remark` VARCHAR(200) DEFAULT '' COMMENT '任务备注',
  `reward` DECIMAL(5,2) NOT NULL COMMENT '跑腿劳务酬金，线下转账',
  `service_fee` DECIMAL(5,2) NOT NULL DEFAULT 0.10 COMMENT '平台信息服务费',
  `is_free_delivery` TINYINT DEFAULT 0 COMMENT '是否使用免费代拿权益发布：0否，1是（为1时service_fee=0，免信息服务费）',
  `is_free_delivery_returned` TINYINT DEFAULT 0 COMMENT '免费代拿次数是否已返还：0否，1是（仅撤销且从未被接单时才返还）',
  `img1` VARCHAR(255) DEFAULT '',
  `img2` VARCHAR(255) DEFAULT '',
  `img3` VARCHAR(255) DEFAULT '',
  `delivery_img1` VARCHAR(255) DEFAULT '' COMMENT '送达照片1',
  `delivery_img2` VARCHAR(255) DEFAULT '' COMMENT '送达照片2',
  `delivery_img3` VARCHAR(255) DEFAULT '' COMMENT '送达照片3',
  `pickup_img1` VARCHAR(255) DEFAULT '' COMMENT '物品照片1（接单人点「确认取货」时落库并锁定）',
  `pickup_img2` VARCHAR(255) DEFAULT '' COMMENT '物品照片2',
  `pickup_img3` VARCHAR(255) DEFAULT '' COMMENT '物品照片3',
  `pickup_confirm_time` DATETIME NULL COMMENT '接单人确认取货时间（非空=物品照片已锁定，不可再改照片/取消接单/撤销任务）',
  `owner_receipt_time` DATETIME NULL COMMENT '雇主确认收货时间（非空=进入进度第4段「待支付」，才允许点「完成任务」）',
  `status` TINYINT NOT NULL DEFAULT 0 COMMENT '0待接单，1进行中，2待雇主确认，3已完成，4超时取消，5雇主撤销',
  `taker_user_id` INT NULL COMMENT '接单者user_id',
  `take_time` DATETIME NULL COMMENT '接单时间',
  `publish_time` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间，24h退费计时起点',
  `submit_finish_time` DATETIME NULL COMMENT '跑腿员提交完成时间',
  `last_edit_time` DATETIME NULL COMMENT '最后编辑时间，用于3分钟编辑频率限制',
  `is_disputed` TINYINT DEFAULT 0 COMMENT '雇主未送达申诉：0否，1是（为1时不再自动确认收货）',
  `dispute_reason` VARCHAR(300) DEFAULT '' COMMENT '未送达申诉原因（标签+补充说明）',
  `dispute_time` DATETIME NULL COMMENT '未送达申诉提交时间',
  `is_late_delivery` TINYINT DEFAULT 0 COMMENT '是否超时送达：0否，1是',
  `late_delivery_seconds` INT DEFAULT 0 COMMENT '超时送达的超出秒数',
  `is_late_reward_deducted` TINYINT DEFAULT 0 COMMENT '是否已按超时送达扣减酬金：0否，1是',
  `late_reward_deduct` DECIMAL(5,2) DEFAULT 0.00 COMMENT '超时送达实际扣减的酬金金额',
  `is_refunded` TINYINT DEFAULT 0 COMMENT '0未退费，1已退费',
  `once_taken` TINYINT DEFAULT 0 COMMENT '是否曾被接单，一旦为1永久不变；再次接单则永久关闭退费',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '管理员删除标记：0正常，1已被管理员删除（从任务大厅/我的发布/我的任务中隐藏，数据保留作为处置留痕）',
  `delete_reason` VARCHAR(200) DEFAULT '' COMMENT '管理员删除原因（选填，仅管理员可见）',
  `delete_time` DATETIME NULL COMMENT '管理员删除时间',
  `delete_admin_id` INT NULL COMMENT '执行删除操作的管理员 user_id',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`taker_user_id`) REFERENCES `users`(`id`),
  UNIQUE KEY `uk_tasks_order_no` (`order_no`),
  KEY `idx_tasks_status` (`status`),
  KEY `idx_tasks_publish_time` (`publish_time`),
  KEY `idx_tasks_take_time` (`take_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 审核申请表（头像/昵称/校园认证）
CREATE TABLE `audit_apply` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `apply_type` TINYINT NOT NULL COMMENT '1头像，2昵称，3校园认证',
  `apply_content` VARCHAR(255) NOT NULL COMMENT '图片地址/新昵称',
  `cert_name` VARCHAR(20) DEFAULT '' COMMENT '校园认证-真实姓名',
  `cert_student_id` VARCHAR(20) DEFAULT '' COMMENT '校园认证-真实学号',
  `cert_phone` VARCHAR(11) DEFAULT '' COMMENT '校园认证-可联系手机号',
  `status` TINYINT DEFAULT 1 COMMENT '1待审核，2通过，3驳回',
  `reject_reason` VARCHAR(200) DEFAULT '',
  `is_void` TINYINT NOT NULL DEFAULT 0 COMMENT '是否已被新申请作废：0正常，1作废（同一用户同类型只保留最新待审核，旧申请作废且不在管理员审核列表展示）',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  KEY `idx_audit_status` (`status`),
  KEY `idx_audit_user_type` (`user_id`, `apply_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 申诉表 appeals
CREATE TABLE `appeals` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `content` VARCHAR(200) NOT NULL,
  `admin_reply` VARCHAR(200) DEFAULT '',
  `status` TINYINT DEFAULT 1 COMMENT '1待处理，2已回复',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  KEY `idx_appeals_user` (`user_id`),
  KEY `idx_appeals_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. 站内消息 messages
CREATE TABLE `messages` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `msg_type` TINYINT NOT NULL COMMENT '1系统，2管理员，3任务，4雇主',
  `title` VARCHAR(50) NOT NULL,
  `content` VARCHAR(500) NOT NULL,
  `is_read` TINYINT DEFAULT 0 COMMENT '0未读，1已读',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  KEY `idx_msg_user_read` (`user_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 举报表 report
CREATE TABLE `report` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL COMMENT '举报人user_id',
  `task_id` INT NOT NULL COMMENT '被举报任务id',
  `report_reason` VARCHAR(200) NOT NULL,
  `report_type` TINYINT DEFAULT 1 COMMENT '举报类型：1普通举报，2恶意超时投诉',
  `status` TINYINT DEFAULT 1 COMMENT '1待处理，2已处理',
  `order_no` VARCHAR(32) DEFAULT '' COMMENT '被举报任务的订单号快照（GCPT+数字）',
  `owner_user_id` INT NULL COMMENT '雇主账号 user_id 快照',
  `owner_student_id` VARCHAR(20) DEFAULT '' COMMENT '雇主学号快照',
  `owner_phone` VARCHAR(11) DEFAULT '' COMMENT '雇主手机号快照',
  `taker_user_id` INT NULL COMMENT '接单人账号 user_id 快照',
  `taker_student_id` VARCHAR(20) DEFAULT '' COMMENT '接单人学号快照',
  `taker_phone` VARCHAR(11) DEFAULT '' COMMENT '接单人手机号快照',
  `admin_note` VARCHAR(200) DEFAULT '',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 支付流水表 payments
CREATE TABLE `payments` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `task_id` INT NOT NULL,
  `out_trade_no` VARCHAR(64) NOT NULL UNIQUE COMMENT '商户订单号',
  `total_fee` DECIMAL(5,2) NOT NULL DEFAULT 0.10,
  `pay_type` TINYINT DEFAULT 1 COMMENT '1微信虚拟支付',
  `status` TINYINT DEFAULT 0 COMMENT '0待支付，1成功，2失败，3已退款',
  `transaction_id` VARCHAR(64) DEFAULT '' COMMENT '微信支付单号',
  `refund_fee` DECIMAL(5,2) DEFAULT 0.00,
  `refund_time` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
  KEY `idx_pay_task` (`task_id`),
  KEY `idx_pay_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 用户收支账单表 user_bill
CREATE TABLE `user_bill` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `task_id` INT NOT NULL COMMENT '关联任务ID',
  `type` TINYINT NOT NULL COMMENT '1任务收入，2服务费支出',
  `amount` DECIMAL(8,2) NOT NULL COMMENT '金额',
  `remark` VARCHAR(100) DEFAULT '' COMMENT '备注',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
  KEY `idx_bill_user_time` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 短信验证码表 sms_code
CREATE TABLE `sms_code` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `phone` VARCHAR(11) NOT NULL,
  `code` VARCHAR(6) NOT NULL COMMENT '6位验证码',
  `expire_time` DATETIME NOT NULL,
  `used` TINYINT DEFAULT 0 COMMENT '0未使用，1已使用',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_sms_phone_time` (`phone`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- 10. 公告表 announcements（跑马灯 / 全局通知条两套内容分开维护）
-- 设计意图：
--   · 管理员在后台只需输入一行正文即可发布，标题由后端自动摘取正文前若干字；
--   · scope 区分展示位置：1 跑马灯（首页横向滚动）、2 全局通知条（各页顶部横幅），
--     两套内容互不影响，管理员分别维护；
--   · start_at / end_at 支持定时生效与到期自动下架（NULL 表示立即 / 长期）；
--   · push_count 记录发布时一并推送到消息中心的用户数，0 表示未推送。
CREATE TABLE `announcements` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `scope` TINYINT NOT NULL DEFAULT 1 COMMENT '展示位置：1跑马灯，2全局通知条',
  `content` VARCHAR(200) NOT NULL COMMENT '公告正文（管理员只需填这一项）',
  `is_active` TINYINT NOT NULL DEFAULT 1 COMMENT '0已下架，1生效中',
  `sort` INT NOT NULL DEFAULT 0 COMMENT '排序值，越大越靠前',
  `start_at` DATETIME NULL COMMENT '生效开始时间，NULL=立即生效',
  `end_at` DATETIME NULL COMMENT '生效结束时间，NULL=长期有效',
  `is_closable` TINYINT NOT NULL DEFAULT 1 COMMENT '通知条是否允许用户关闭：0不可关闭，1可关闭',
  `push_count` INT NOT NULL DEFAULT 0 COMMENT '发布时写入消息中心的用户数（0=未推送）',
  `creator_id` INT NULL COMMENT '发布管理员 user_id',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_announce_scope` (`scope`, `is_active`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 说明：管理员账号无需特殊建表。使用白名单中的学号注册账号即拥有管理员权限，
--      例如 ADMIN_STUDENT_IDS=20240001,20240002，注册时学号填 20240001 即可。
-- =====================================================================
