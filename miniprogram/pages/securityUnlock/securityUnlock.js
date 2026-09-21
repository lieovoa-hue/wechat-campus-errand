/**
 * 新设备登录 · 安全解锁
 * =====================================================================
 * 触发场景：在「不是常用设备」的微信上登录成功校验密码后，
 *           后端返回 needUnlock + 一次性 unlockTicket + 2 道密保问题，
 *           必须答对 2 道密保才能换取正式令牌（防止密码泄漏后被陌生人登录）。
 * 安全设计（均在后端实现，前端只负责收集答案）：
 *  1. 票据 10 分钟过期，只对本次登录设备有效；
 *  2. 连续答错 5 次锁定 15 分钟；
 *  3. 解锁成功后本设备自动成为常用设备，下次在同一设备登录不再要求密保。
 * =====================================================================
 */

const { post, showError } = require('../../utils/request');
const { MSG } = require('../../utils/constant');
const dialog = require('../../utils/dialog');

const theme = require('../../utils/theme');
const app = getApp();

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    questions: ['', ''],
    answers: ['', ''],
    submitting: false
  },

  onLoad() {
    const ctx = app.globalData.securityUnlock || null;
    if (!ctx || !ctx.unlockTicket || !Array.isArray(ctx.questions) || ctx.questions.length !== 2) {
      dialog.show(this, {
        title: '安全验证已失效',
        content: MSG.UNLOCK_TICKET_INVALID,
        showCancel: false
      }).then(() => wx.navigateBack());
      return;
    }
    this.setData({ questions: ctx.questions });
  },

  /** 密保答案输入 */
  onAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    answers[index] = e.detail.value;
    this.setData({ answers });
  },

  /** 提交密保答案解锁 */
  async doUnlock() {
    const ctx = app.globalData.securityUnlock || {};
    const { answers } = this.data;

    if (!answers[0] || !answers[1]) {
      wx.showToast({ title: '请填写两道密保答案', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      const res = await post('/api/user/securityUnlock', {
        unlockTicket: ctx.unlockTicket,
        answer1: answers[0],
        answer2: answers[1]
      }, { auth: false });

      // 解锁成功：后端已签发正式双令牌，这里直接保存登录态
      app.saveLogin(res.data);
      app.globalData.securityUnlock = null;

      wx.showToast({ title: '验证通过', icon: 'success' });
      setTimeout(() => {
        if (res.data && res.data.needSetSecurity) {
          wx.redirectTo({ url: '/pages/securitySetup/securitySetup' });
        } else {
          wx.switchTab({ url: '/pages/index/index' });
        }
      }, 700);
    } catch (err) {
      showError(err);
      // 错误次数达到上限会被锁定，此时只能回登录页等 15 分钟后再试
      if (err && err.code === 423) {
        this.setData({ answers: ['', ''] });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 返回登录页（重新走一次密码校验，可换账号登录） */
  backToLogin() {
    app.globalData.securityUnlock = null;
    wx.navigateBack();
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