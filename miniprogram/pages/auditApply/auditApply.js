/**
 * 头像 / 昵称修改申请
 *  - 头像：上传图片后提交审核，审核通过自动生效
 *  - 昵称：剩余修改次数大于 0 才可提交；驳回不扣次数，通过才消耗
 *          管理员账号不受次数限制（后端下发 -1 表示不限）
 *  - 同一类型只能存在 1 条待审核申请，提交新申请自动撤销旧申请
 */

const { get, post, chooseAndUpload, showError, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const filter = require('../../utils/filter');
// 昵称修改次数「不限」标记（-1）：管理员账号不受修改次数限制
const { NICKNAME_COUNT_UNLIMITED } = require('../../utils/constant');

const theme = require('../../utils/theme');
const app = getApp();

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    tab: 'avatar',        // avatar | nickname | records
    user: null,
    avatarImg: '',
    avatarImgUrl: '',
    nickname: '',
    avatarAuditText: '',
    nicknameUnlimited: false,   // 管理员账号：昵称修改次数不限
    nicknameCountText: '',      // 昵称剩余次数展示文案
    records: [],
    submitting: false
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    if (!app.isLogin()) return;
    this.loadUser();
    this.loadRecords();
  },

  onTabChange(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  /** 加载用户信息（昵称剩余修改次数、头像审核状态） */
  async loadUser() {
    try {
      const res = await get('/api/user/info');
      const user = res.data.user;
      // 管理员账号后端下发 -1，表示不受「昵称修改次数」限制
      const nicknameUnlimited = Number(user.nicknameModifyCount) === NICKNAME_COUNT_UNLIMITED;
      this.setData({
        user,
        nicknameUnlimited,
        nicknameCountText: nicknameUnlimited ? '不限（管理员账号）' : `${Number(user.nicknameModifyCount)} 次`,
        avatarAuditText: filter.avatarAuditText(user.isAvatarAudit),
        nickname: this.data.nickname || user.nickname
      });
    } catch (err) {
      if (err.code !== 401) showError(err);
    }
  },

  /** 我的审核记录 */
  async loadRecords() {
    try {
      const res = await get('/api/audit/myList', { page: 1, pageSize: 20 });
      const records = (res.data.list || []).map((item) => ({
        ...item,
        typeText: filter.auditApplyTypeText(item.apply_type),
        statusText: filter.auditStatusText(item.status),
        timeText: filter.formatTime(item.created_at, 'YYYY-MM-DD HH:mm'),
        // 头像(1) / 校园认证(3) 的申请内容是图片，展示缩略图；昵称(2) 是纯文本
        contentImage: item.apply_type === 2 ? '' : filter.imageUrl(item.apply_content),
        contentText: item.apply_type === 2 ? item.apply_content : ''
      }));
      this.setData({ records });
    } catch (err) {
      if (err.code !== 401) showError(err);
    }
  },

  /** 选择头像图片 */
  async chooseAvatar() {
    try {
      const urls = await chooseAndUpload(1);
      if (urls.length) this.setData({ avatarImg: urls[0], avatarImgUrl: filter.imageUrl(urls[0]) });
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除已选择 / 已上传的头像，方便重新选择 */
  deleteAvatarImage() {
    this.setData({ avatarImg: '', avatarImgUrl: '' });
  },

  previewAvatar() {
    if (this.data.avatarImgUrl) wx.previewImage({ urls: [this.data.avatarImgUrl] });
  },

  /** 提交头像审核 */
  async submitAvatar() {
    if (!this.data.avatarImg) {
      wx.showToast({ title: '请先上传头像图片', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await post('/api/audit/submit', { applyType: 1, applyContent: this.data.avatarImg });
      wx.showToast({ title: '已提交审核', icon: 'success' });
      this.setData({ avatarImg: '', avatarImgUrl: '' });
      this.loadUser();
      this.loadRecords();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /** 提交昵称审核 */
  async submitNickname() {
    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入新昵称', icon: 'none' });
      return;
    }
    if (!this.data.nicknameUnlimited && this.data.user && Number(this.data.user.nicknameModifyCount) <= 0) {
      wx.showToast({ title: '昵称修改次数已用完', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await post('/api/audit/submit', { applyType: 2, applyContent: nickname });
      wx.showToast({ title: '已提交审核', icon: 'success' });
      this.loadRecords();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
