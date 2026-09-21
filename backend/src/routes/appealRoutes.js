/**
 * =====================================================================
 * 申诉路由（提交申诉接口配置限流）
 * =====================================================================
 */

const express = require('express');
const appealController = require('../controllers/appealController');
const { auth, adminAuth } = require('../middleware/auth');
const { appealLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/submit', auth, appealLimit, appealController.submit);
router.get('/myList', auth, appealController.myList);
router.get('/adminList', auth, adminAuth, appealController.adminList);
router.post('/reply', auth, adminAuth, appealController.reply);

module.exports = router;
