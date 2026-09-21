/**
 * =====================================================================
 * 审核路由
 * =====================================================================
 */

const express = require('express');
const auditController = require('../controllers/auditController');
const { auth, adminAuth } = require('../middleware/auth');
const { commonWriteLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/submit', auth, commonWriteLimit, auditController.submit);
router.get('/myList', auth, auditController.myList);
router.get('/adminList', auth, adminAuth, auditController.adminList);
router.post('/handle', auth, adminAuth, commonWriteLimit, auditController.handle);

module.exports = router;
