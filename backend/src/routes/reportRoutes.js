/**
 * =====================================================================
 * 举报路由
 * =====================================================================
 */

const express = require('express');
const reportController = require('../controllers/reportController');
const { auth, adminAuth } = require('../middleware/auth');
const { commonWriteLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/submit', auth, commonWriteLimit, reportController.submit);
router.get('/adminList', auth, adminAuth, reportController.adminList);
router.post('/handle', auth, adminAuth, commonWriteLimit, reportController.handle);

module.exports = router;
