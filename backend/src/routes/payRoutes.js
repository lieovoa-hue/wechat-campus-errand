/**
 * =====================================================================
 * 支付路由
 *  - /api/pay/notify       微信支付 API v3 回调：无需鉴权，但必须验签（备用通道）
 *  - /api/pay/xpayNotify   微信虚拟支付「道具发货推送」：无验签头，报文为 XML（B 方案主通道）
 *  - /api/pay/queryStatus  查询支付状态（需登录）
 *  - /api/pay/repay        未支付订单重新发起支付（需登录）
 * =====================================================================
 */

const express = require('express');
const payController = require('../controllers/payController');
const { auth } = require('../middleware/auth');
const { commonWriteLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/notify', payController.notify);
// 虚拟支付发货推送：报文是 XML，app.js 为该路径单独挂了文本解析器（必须在全局 JSON 解析器之前）
router.post('/xpayNotify', payController.notifyVirtual);
router.get('/queryStatus/:taskId', auth, payController.queryStatus);
router.post('/repay', auth, commonWriteLimit, payController.repay);

module.exports = router;
