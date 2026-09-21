/**
 * =====================================================================
 * 用户路由
 *  - router      : 挂载到 /api/user
 *  （管理员接口已统一迁移到 routes/adminRoutes.js，挂载到 /api/admin）
 * =====================================================================
 */

const express = require('express');
const multer = require('multer');
const userController = require('../controllers/userController');
const { auth } = require('../middleware/auth');
const {
  loginLimit, registerLimit, registerIpLimit, captchaLimit, accountHelperLimit, securityLimit, commonWriteLimit
} = require('../middleware/rateLimit');
const { BIZ } = require('../utils/constant');

const router = express.Router();

// 图片上传：内存接收，限制单张 2MB、单个文件；文件头校验在控制器内完成
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_SIZE || BIZ.MAX_UPLOAD_SIZE),
    files: 1
  }
});

// ---------------------- 公开接口（无需登录） ----------------------
router.post('/register', registerIpLimit, registerLimit, userController.register);
router.post('/login', loginLimit, userController.login);
router.post('/refreshToken', commonWriteLimit, userController.refreshToken);
// 图形验证码：替代短信验证码，服务端本地生成算术题图片，成本为 0
router.get('/captcha', captchaLimit, userController.captcha);
// 注册辅助：随机生成可用账号ID / 实时校验账号ID是否可注册
router.get('/randomAccountNo', accountHelperLimit, userController.randomAccountNo);
router.post('/checkAccountNo', accountHelperLimit, userController.checkAccountNo);
// 忘记密码（密保方式）：第一步取题、第二步校验并重置
router.post('/securityQuestions', securityLimit, userController.securityQuestions);
router.post('/resetPassword', securityLimit, userController.resetPassword);
// 新设备登录解锁：凭登录接口下发的一次性 unlockTicket 答密保换正式令牌
router.post('/securityUnlock', securityLimit, userController.securityUnlock);

// ---------------------- 需要登录 ----------------------
router.get('/info', auth, userController.info);
// 密保设置（登录后必须完成，未设置时其它业务接口统一返回 428）
router.post('/setSecurity', auth, commonWriteLimit, userController.setSecurity);
// 设备管理：查看已绑定设备 / 解绑设备（新设备登录保护的可视化入口）
router.get('/devices', auth, userController.deviceList);
router.post('/unbindDevice', auth, commonWriteLimit, userController.unbindDevice);
// 注销当前登录账号（不可恢复，需校验登录密码二次确认）
router.post('/deactivate', auth, commonWriteLimit, userController.deactivate);
router.post('/uploadImage', auth, upload.single('file'), userController.uploadImage);
// 备用上传通道：base64 + JSON（前端在 wx.uploadFile 被拦截时自动降级使用）
router.post('/uploadImageBase64', auth, userController.uploadImageBase64);

module.exports = { router };
