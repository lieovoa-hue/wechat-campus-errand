/**
 * =====================================================================
 * 忘记密码页（只负责用密保问题重置密码）
 * ---------------------------------------------------------------------
 * 两步式流程：
 *   第 1 步：账号ID + 图形验证码 → POST /api/user/securityQuestions
 *            后端返回该账号的 2 道密保问题、是否需要补学号姓名、以及一次性重置票据
 *   第 2 步：答 2 道密保（已认证账号补真实学号 + 姓名）+ 新密码 + 图形验证码
 *            → POST /api/user/resetPassword
 * 安全要点（全部由后端强制，前端只做提前拦）：
 *   · 票据 10 分钟有效、一次性使用；
 *   · 密保答案连续答错 5 次锁定 15 分钟；
 *   · 同一账号 24 小时内仅可重置一次密码；
 *   · 全程图形验证码，短信通道已下线（零成本）。
 * =====================================================================
 */

const { get, post, showError } = require('../../utils/request');
const { BIZ, MSG } = require('../../utils/constant');

const theme = require('../../utils/theme');
/** 轻提示（统一 2 秒、无图标，避免遮挡输入框） */
function toast(title) {
  wx.showToast({ title, icon: 'none', duration: 2000 });
}

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    // 1 = 验证账号；2 = 回答密保并重置
    step: 1,

    // ---------------- 第 1 步 ----------------
    account: '',

    // ---------------- 第 2 步 ----------------
    questions: [],        // 该账号的 2 道密保问题
    answers: ['', ''],    // 两道密保答案
    needIdentity: false,  // 已认证账号需要额外填写学号 + 姓名
    studentId: '',
    name: '',
    newPassword: '',
    newPassword2: '',
    showPassword: false,
    resetTicket: '',      // 第一步下发的一次性票据（10 分钟）

    // ---------------- 图形验证码 ----------------
    captcha: { captchaId: '', image: '', expireMinutes: 0 },
    captchaCode: '',

    submitting: false
  },

  onLoad() {
    // 两步都要校验图形验证码，进入页面先预取一张
    this.refreshCaptcha();
  },

  /** 通用输入绑定 */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  /** 密保答案输入（两道题共用一个方法，靠 data-index 区分） */
  onAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    answers[index] = e.detail.value;
    this.setData({ answers });
  },

  /** 密码明文 / 掩码切换 */
  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  /** 回登录页（页面栈里有上一页就直接返回，避免堆栈变长） */
  goLogin() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  /** 获取图形验证码（本地生成，零成本） */
  async refreshCaptcha() {
    try {
      const res = await get('/api/user/captcha', {}, { auth: false });
      this.setData({ captcha: res.data, captchaCode: '' });
    } catch (err) {
      console.warn('[captcha] 获取失败：', (err && err.message) || '');
    }
  },

  /** 第 1 步：输入账号ID + 图形验证码，取出该账号的 2 道密保问题 */
  async doStep1() {
    const { account, captcha, captchaCode } = this.data;
    if (!account) {
      toast('请输入账号ID');
      return;
    }
    if (!captchaCode) {
      toast(MSG.CAPTCHA_REQUIRED);
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await post('/api/user/securityQuestions', {
        account,
        captchaId: captcha.captchaId,
        captchaCode
      }, { auth: false });

      this.setData({
        step: 2,
        questions: res.data.questions,
        needIdentity: res.data.needIdentity,
        resetTicket: res.data.resetTicket,
        answers: ['', ''],
        captchaCode: ''
      });
      // 第二步还要再校验一次图形验证码，这里预取一张
      this.refreshCaptcha();
    } catch (err) {
      showError(err);
      this.refreshCaptcha();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 第 2 步：答密保（已认证账号补学号 + 姓名）并重置密码 */
  async doStep2() {
    const {
      resetTicket, answers, needIdentity, studentId, name,
      newPassword, newPassword2, captcha, captchaCode
    } = this.data;

    if (!answers[0] || !answers[1]) {
      toast('请填写两道密保答案');
      return;
    }
    if (needIdentity && (!studentId || !name)) {
      toast('该账号已通过校园认证，请填写学号与姓名');
      return;
    }
    if (!newPassword) {
      toast('请输入新密码');
      return;
    }
    if (newPassword !== newPassword2) {
      toast('两次输入的密码不一致');
      return;
    }
    const weakLength = newPassword.length < BIZ.PASSWORD_MIN_LEN || newPassword.length > BIZ.PASSWORD_MAX_LEN;
    if (weakLength || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      toast(MSG.PASSWORD_TOO_WEAK);
      return;
    }
    if (!captchaCode) {
      toast(MSG.CAPTCHA_REQUIRED);
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      await post('/api/user/resetPassword', {
        resetTicket,
        answer1: answers[0],
        answer2: answers[1],
        studentId,
        name,
        newPassword,
        captchaId: captcha.captchaId,
        captchaCode
      }, { auth: false });

      wx.showToast({ title: '密码已重置，请登录', icon: 'success' });
      // 重置成功：清掉表单回到第 1 步，并回到登录页让用户用新密码登录
      this.setData({
        step: 1,
        account: '',
        resetTicket: '',
        questions: [],
        answers: ['', ''],
        newPassword: '',
        newPassword2: '',
        studentId: '',
        name: '',
        captchaCode: ''
      });
      this.refreshCaptcha();
      setTimeout(() => this.goLogin(), 900);
    } catch (err) {
      showError(err);
      this.refreshCaptcha();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 返回第 1 步（票据作废，需要重新验证账号） */
  backToStep1() {
    this.setData({ step: 1, resetTicket: '', answers: ['', ''], captchaCode: '' });
    this.refreshCaptcha();
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
