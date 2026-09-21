/**
 * =====================================================================
 * 站内消息路由
 * =====================================================================
 */

const express = require('express');
const messageController = require('../controllers/messageController');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.get('/list', auth, messageController.list);
router.get('/unreadCount', auth, messageController.unreadCount);
router.get('/detail', auth, messageController.detail);
router.post('/readAll', auth, messageController.readAll);
router.post('/clearUnread', auth, messageController.clearUnread);
// 全部删除（含已读，物理删除）：消息中心「全部删除」按钮
router.post('/deleteAll', auth, messageController.deleteAll);

module.exports = router;
