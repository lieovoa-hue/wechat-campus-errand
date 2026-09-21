/**
 * =====================================================================
 * 管理员路由（挂载到 /api/admin）
 * ---------------------------------------------------------------------
 * 【安全红线】所有接口必须：
 *   1. auth     校验登录态（access_token + 单设备登录）
 *   2. adminAuth 校验管理员权限，且只认后端 .env ADMIN_STUDENT_IDS 硬编码学号白名单
 * 写接口统一叠加限流，防止恶意刷接口
 * =====================================================================
 */

const express = require('express');
const adminController = require('../controllers/adminController');
const announceController = require('../controllers/announceController');
const { auth, adminAuth } = require('../middleware/auth');
const { commonWriteLimit } = require('../middleware/rateLimit');

const router = express.Router();

// 整个管理员路由组统一鉴权
router.use(auth, adminAuth);

// 用户管理
router.get('/userList', adminController.userList);
// 查看指定用户完整信息：举报/审核/封禁列表里点用户卡片时调用（只读）
router.get('/userDetail', adminController.userDetail);
// 管理员直接修改用户资料（昵称 / 姓名 / 手机号 / 学号 / 校园认证状态 / 头像），改完自动推送站内消息
router.post('/updateUser', commonWriteLimit, adminController.updateUser);
// 管理员重置任意用户的登录密码（留空则自动生成随机密码并返回），改完自动推送站内消息
router.post('/resetUserPassword', commonWriteLimit, adminController.resetUserPassword);
// 管理员注销任意普通用户账号（不可恢复；管理员账号与自己均不可注销）
router.post('/deactivateUser', commonWriteLimit, adminController.deactivateUser);

// 管理员删除任务（软删除：任务从任务大厅 / 我的发布 / 我的任务全部下架并冻结全部流转操作，
// 数据保留作为处置留痕；删除后自动给雇主与接单人推送站内消息）
router.post('/deleteTask', commonWriteLimit, adminController.deleteTask);

// 订单管理：按 订单号 / 任务ID / 学号 / 手机号 / 账号ID 搜索订单（含已被删除的订单，只读）
router.get('/searchTask', adminController.searchTask);
// 订单管理：管理员编辑订单（白名单字段 + 事务 + 乐观锁，改完自动通知雇主与接单人）
router.post('/updateTask', commonWriteLimit, adminController.updateTask);

// 封禁管理：列表（搜索）/ 封禁（含加时）/ 解封
router.get('/banList', adminController.banList);
router.post('/banUser', commonWriteLimit, adminController.banUser);
router.post('/unbanUser', commonWriteLimit, adminController.unbanUser);

// 公告管理：跑马灯（scope=1）/ 全局通知条（scope=2）两套内容分开维护
router.get('/announceList', announceController.adminList);
router.post('/announceCreate', commonWriteLimit, announceController.adminCreate);
router.post('/announceToggle', commonWriteLimit, announceController.adminToggle);
router.post('/announceDelete', commonWriteLimit, announceController.adminDelete);

// 批量删除：审核 / 申诉 / 举报 / 订单 / 封禁记录 / 已注销账号的列表清理
router.post('/batchDelete', commonWriteLimit, adminController.batchDelete);

module.exports = router;
