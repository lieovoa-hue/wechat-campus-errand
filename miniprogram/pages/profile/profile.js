/**
 * 我的（个人中心）
 *  - 醒目展示账号ID（管理员 A0001、普通用户 X0001，可用于登录）
 *  - 展示认证状态、学号、昵称、手机号（脱敏）、接单封禁状态
 *  - 入口：校园认证 / 资料修改申请 / 申诉 / 账单 / 消息 / 管理员后台 / 退出登录 / 注销账号
 */

const { get, post, showError } = require('../../utils/request');
const filter = require('../../utils/filter');
const clipboard = require('../../utils/clipboard');
const preview = require('../../utils/preview');
const { SECURITY_STATUS, MSG } = require('../../utils/constant');
const dialog = require('../../utils/dialog');

const theme = require('../../utils/theme');
const app = getApp();

/**
 * 审核状态 → 徽标配色类名（无申请 / 待审核 / 通过 / 驳回 四态与后端字典一致）
 * 统一在页面内计算，保证「校园认证」与「头像审核」两行徽标大小、配色完全一致。
 * @param {number} status 0 无申请 / 1 待审核 / 2 通过 / 3 驳回
 * @returns {string} 徽标类名
 */
function profileAuditTagClass(status) {
  const value = Number(status) || 0;
  if (value === 2) return 'tag tag-success';
  if (value === 3) return 'tag tag-danger';
  if (value === 1) return 'tag tag-warn';
  return 'tag tag-gray';
}

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    isLogin: false,
    user: null,
    avatarUrl: '',
    unread: 0,
    // 未读角标文案（超过 99 显示 99+）：消息中心入口上的红色数字
    unreadText: '',
    campusAuditText: '',
    avatarAuditText: '',
    // 头像审核徽标配色（无申请=灰 / 待审核=橙 / 通过=绿 / 驳回=红），与校园认证徽标同一套配色口径
    avatarAuditTagClass: 'tag tag-gray',
    // 校园认证徽标配色（口径与头像审核一致）
    campusAuditTagClass: 'tag tag-gray',
    // 密保设置状态（未设置时后端会拦截其它业务接口，因此这里必须显眼提示）
    securityText: '',
    banTakeText: '',
    // ---------------- 注销账号（不可恢复） ----------------
    showDeactivate: false,      // 注销确认弹窗显隐
    deactivatePassword: '',     // 用户输入的登录密码
    deactivateSubmitting: false // 提交中：防止连点重复注销
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    // 底部 tabBar 角标校准（未完成任务数）
    app.refreshTakeBadge();
    this.setData({ isLogin: app.isLogin() });
    if (app.isLogin()) {
      this.loadInfo();
    } else {
      this.setData({ user: null });
    }
  },

  /** 点击本人头像查看大图（未上传头像时 previewImage 内部直接返回） */
  previewAvatar() {
    preview.previewImage(this.data.avatarUrl);
  },

  /** 拉取个人信息 */
  async loadInfo() {
    try {
      const res = await get('/api/user/info');
      const user = res.data.user;
      // 头像地址是服务端相对路径，展示前补全域名
      const avatarUrl = filter.imageUrl(user.avatar);
      app.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);
      const unreadCount = Number(res.data.unreadCount || 0);
      this.setData({
        user,
        avatarUrl,
        unread: unreadCount,
        unreadText: unreadCount > 99 ? MSG.BADGE_OVERFLOW : String(unreadCount),
        campusAuditText: filter.campusAuditText(user.isCampusAudit),
        avatarAuditText: filter.avatarAuditText(user.isAvatarAudit),
        avatarAuditTagClass: profileAuditTagClass(user.isAvatarAudit),
        campusAuditTagClass: profileAuditTagClass(user.isCampusAudit),
        securityText: SECURITY_STATUS[Number(user.securitySet) || 0],
        banTakeText: user.banTakeTime ? filter.formatTime(user.banTakeTime, 'MM-DD HH:mm') : ''
      });
    } catch (err) {
      if (err.code !== 401) showError(err);
    }
  },

  /** 页面跳转 */
  goPage(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    if (!app.checkLogin()) return;
    wx.navigateTo({ url });
  },

  /**
   * 一键复制（账号ID / 邀请码等）
   * 取值方式：wxml 上写 data-value="{{...}}" data-label="账号ID"，全站统一走 utils/clipboard.js
   */
  copyValue(e) {
    return clipboard.copyFromEvent(e);
  },

  /** 去认证（提示后跳转） */
  goCampusCert() {
    if (!app.checkLogin()) return;
    wx.navigateTo({ url: '/pages/campusCert/campusCert' });
  },

  /** 登录 */
  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 退出登录 */
  logout() {
    dialog.show(this, {
      title: '退出登录',
      content: '确认退出当前账号吗？'
    }).then((res) => {
      if (!res.confirm) return;
      app.clearLogin();
      this.setData({ isLogin: false, user: null });
      wx.showToast({ title: '已退出登录', icon: 'success' });
    });
  },

  /** 打开注销账号确认弹窗（管理员账号不可注销，由后端白名单兜底校验） */
  openDeactivate() {
    if (this.data.user && this.data.user.isAdmin) {
      wx.showToast({ title: '管理员账号不可注销', icon: 'none' });
      return;
    }
    this.setData({ showDeactivate: true, deactivatePassword: '' });
  },

  /** 关闭注销弹窗（提交中不允许关闭，避免请求已发出却看不到结果） */
  closeDeactivate() {
    if (this.data.deactivateSubmitting) return;
    this.setData({ showDeactivate: false, deactivatePassword: '' });
  },

  /** 记录密码输入 */
  onDeactivateInput(e) {
    this.setData({ deactivatePassword: e.detail.value });
  },

  /**
   * 提交注销申请
   * 后端会再次校验登录密码、管理员身份与幂等，校验通过后账号不可恢复
   */
  async submitDeactivate() {
    if (this.data.deactivateSubmitting) return;
    const password = String(this.data.deactivatePassword || '');
    if (!password) {
      wx.showToast({ title: '请输入登录密码', icon: 'none' });
      return;
    }

    this.setData({ deactivateSubmitting: true });
    try {
      await post('/api/user/deactivate', { password });
      this.setData({ showDeactivate: false, deactivateSubmitting: false, deactivatePassword: '' });
      // 账号已注销：清空本地登录态并回到登录页，避免停留在已失效的会话里
      app.clearLogin();
      wx.showToast({ title: '账号已注销', icon: 'success' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/login/login' });
      }, 1200);
    } catch (err) {
      this.setData({ deactivateSubmitting: false });
      showError(err);
    }
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
