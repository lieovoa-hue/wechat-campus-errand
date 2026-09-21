/**
 * =====================================================================
 * 任务路由（全部需要登录）
 * 注意：/:id 必须放在所有具名路由之后，避免路径冲突
 * =====================================================================
 */

const express = require('express');
const taskController = require('../controllers/taskController');
const { auth } = require('../middleware/auth');
const { publishLimit, commonWriteLimit } = require('../middleware/rateLimit');

const router = express.Router();

// 所有任务接口必须登录（未认证校园的用户仍可浏览、查看详情）
router.use(auth);

// 发布任务：限流（防止恶意刷接口）
router.post('/createOrder', publishLimit, taskController.createOrder);

// 列表与查询
router.get('/list', taskController.list);
router.get('/myPublish', taskController.myPublish);
router.get('/myTake', taskController.myTake);
// tabBar 角标：必须是极轻量查询，且要放在 /:id 之前
router.get('/tabBadge', taskController.tabBadge);

// 接单与流转
router.post('/take', commonWriteLimit, taskController.take);
router.post('/cancelTake', commonWriteLimit, taskController.cancelTake);
router.post('/edit', commonWriteLimit, taskController.edit);
router.post('/adjustReward', commonWriteLimit, taskController.adjustReward);
router.post('/submitFinish', commonWriteLimit, taskController.submitFinish);
// 接单人「确认取货」：上传物品照片并锁定（进度第 1 段 -> 第 2 段），确认后可提交送达
router.post('/confirmPickup', commonWriteLimit, taskController.confirmPickup);
// 雇主「确认收货」：确认收到物品后进入待支付（进度第 3 段 -> 第 4 段），线下转账后再点完成任务
router.post('/receiptFinish', commonWriteLimit, taskController.receiptFinish);
router.post('/confirmFinish', commonWriteLimit, taskController.confirmFinish);
// 超时送达扣酬金：超过限时才送达，雇主可一次性扣减酬金（5%，不足 0.5 元按 0.5 元）
router.post('/deductLateReward', commonWriteLimit, taskController.deductLateReward);
// 雇主提交「未送达」申诉：提交后不再倒计时自动确认收货
router.post('/rejectFinish', commonWriteLimit, taskController.rejectFinish);
// 雇主举报接单人「恶意超时」：投诉直达管理员，由管理员决定是否封禁（限流防刷）
router.post('/reportLateTaker', commonWriteLimit, taskController.reportLateTaker);
// 雇主举报接单人（服务质量类：物品损坏 / 态度恶劣等），投诉直达管理员「举报管理」
router.post('/reportTaker', commonWriteLimit, taskController.reportTaker);
// 雇主结束「已超时」的限时任务：确认后任务置为「超时取消」，双方都不再显示为进行中
router.post('/endOvertime', commonWriteLimit, taskController.endOvertime);
router.post('/cancel', commonWriteLimit, taskController.cancel);
router.post('/applyRefund', commonWriteLimit, taskController.applyRefund);

// 详情（放在最后）
router.get('/:id', taskController.detail);

module.exports = router;
