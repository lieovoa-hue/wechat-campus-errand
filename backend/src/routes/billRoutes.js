/**
 * =====================================================================
 * 账单路由（纯查看记账，无提现接口）
 * =====================================================================
 */

const express = require('express');
const billController = require('../controllers/billController');
const { auth } = require('../middleware/auth');

const router = express.Router();

router.get('/list', auth, billController.list);

module.exports = router;
