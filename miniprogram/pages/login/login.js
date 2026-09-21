/**
 * =====================================================================
 * 登录页（只负责登录）
 * ---------------------------------------------------------------------
 * 本次拆分：原来「登录 / 注册 / 忘记密码」挤在同一个页面用 Tab 切换，
 *   手机上三个流程的表单互相干扰（切来切去还会丢失已填内容）。
 *   现在拆成三个独立页面：
 *     · 登录        → pages/login/login（本文件）
 *     · 注册        → pages/register/register
 *     · 忘记密码    → pages/forgot/forgot
 *   登录页只保留「账号 + 密码 + 两个跳转小字」，路径清晰、返回栈也正常。
 * 保留的既有能力：
 *   · 账号栏支持「账号ID（X0001 / A0001）」或「学号」，后端自动识别；
 *   · 新设备登录后端返回 needUnlock 时跳「安全解锁」页答密保；
 *   · 注册后未设密保的账号登录时跳「设置密保」页；
 *   · 长按 Logo 触发后端连通性自检（真机排障入口）；
 *   · 登录前必须勾选同意《用户服务协议》与《隐私政策》，可点击书名号查看全文。
 * =====================================================================
 */

const { post, showError, getBaseUrl } = require('../../utils/request');
const { AGREEMENTS } = require('../../utils/agreement');
const { MSG } = require('../../utils/constant');
const dialog = require('../../utils/dialog');

const theme = require('../../utils/theme');
const app = getApp();

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    account: '',
    password: '',
    // 密码默认掩码显示，点「显示」可临时明文核对
    showPassword: false,
    submitting: false,

    // ---------------- 用户协议与隐私政策 ----------------
    // 登录与注册都必须先勾选同意，未勾选时拦住并提示（与注册页同一套规则）
    agreed: false,
    showAgreement: false,
    agreementTitle: '',
    agreementParagraphs: [],

    // 页面上出现的固定文案统一从字典取，禁止在 wxml 里硬编码中文
    msg: {
      goRegister: MSG.LOGIN_GO_REGISTER,
      forgetPassword: MSG.LOGIN_FORGET_PASSWORD
    }
  },

  /** 通用输入绑定 */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  /** 密码明文 / 掩码切换 */
  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  /** 切换「我已阅读并同意」勾选状态 */
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 打开《用户服务协议》/《隐私政策》阅读弹窗 */
  openAgreement(e) {
    const doc = AGREEMENTS[e.currentTarget.dataset.type];
    if (!doc) return;
    this.setData({
      showAgreement: true,
      agreementTitle: doc.title,
      agreementParagraphs: doc.paragraphs
    });
  },

  closeAgreement() {
    this.setData({ showAgreement: false });
  },

  /** 空方法：弹窗内容区的 catchtap 用，只拦截冒泡、不做任何事 */
  noop() {},

  /** 去注册页 */
  goRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  /** 去忘记密码页 */
  goForgot() {
    wx.navigateTo({ url: '/pages/forgot/forgot' });
  },

  /**
   * 后端连接自检（隐藏入口：长按顶部的「跑」图标触发）
   * 直接把「当前请求的后端地址 + 实际结果」弹出来，一眼判断是网络问题还是域名问题
   */
  checkServer() {
    const base = getBaseUrl();
    wx.showLoading({ title: '检测中', mask: true });
    wx.request({
      url: `${base}/api/health`,
      method: 'GET',
      success: (res) => {
        wx.hideLoading();
        const isOk = res.data && res.data.code === 200;
        dialog.show(this, {
          title: isOk ? '后端连接正常' : '后端响应异常',
          content: `后端地址：${base}\nHTTP 状态：${res.statusCode}\n响应：${JSON.stringify(res.data)}`,
          showCancel: false
        });
      },
      fail: (err) => {
        wx.hideLoading();
        dialog.show(this, {
          title: '无法连接后端',
          content: `后端地址：${base}\n错误：${(err && err.errMsg) || 'request:fail'}\n\n`
            + '若开发者工具能通、手机不通：多为「服务器域名」未配置，'
            + '请在小程序右上角 ··· 里打开「开发调试」后重试。',
          showCancel: false
        });
      }
    });
  },

  /**
   * 登录（账号ID / 学号）
   * 后端会自动识别输入类型：X/A 开头 → 账号ID；纯数字 → 学号（并兼容内部编号 / 手机号兜底）
   */
  async doLogin() {
    const { account, password } = this.data;
    if (!account || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }

    // 未勾选协议不允许登录：与注册页口径一致（合规要求「使用前取得同意」）
    if (!this.data.agreed) {
      wx.showToast({ title: MSG.NEED_PROTOCOL_AGREE, icon: 'none', duration: 2000 });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const device = await app.getDevicePayload();
      const res = await post('/api/user/login', { account, password, ...device }, { auth: false });

      // 新设备登录：后端下发一次性解锁票据 + 2 道密保问题，答对后才会拿到正式令牌
      if (res.data && res.data.needUnlock) {
        app.globalData.securityUnlock = {
          unlockTicket: res.data.unlockTicket,
          questions: res.data.questions,
          account
        };
        wx.navigateTo({ url: '/pages/securityUnlock/securityUnlock' });
        return;
      }

      app.saveLogin(res.data);

      // 尚未设置密保问题：直接引导到设置页（后端其余业务接口会持续返回 428）
      if (res.data.needSetSecurity) {
        wx.redirectTo({ url: '/pages/securitySetup/securitySetup' });
        return;
      }

      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 主题校准
   * ------------------------------------------------------------------
   * 本页原本没有 onShow，这个钩子只为主题同步而存在：
   * 从后台切回来、或用户刚在首页拨过开关时，把页面主题重新对齐一次。
   */
  onShow() {
    theme.sync(this);
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
