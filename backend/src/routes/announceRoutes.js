/**
 * =====================================================================
 * 公告路由（挂载到 /api/announce）
 * 用户端只需一个只读接口：拉取当前生效中的跑马灯 / 通知条内容。
 * 管理员发布 / 上下架 / 删除在 /api/admin 下（见 adminRoutes）。
 * =====================================================================
 */

const express = require('express');
const announceController = require('../controllers/announceController');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.get('/active', auth, announceController.active);

module.exports = router;
