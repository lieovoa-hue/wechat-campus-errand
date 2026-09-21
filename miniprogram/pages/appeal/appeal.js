/**
 * 申诉提交与我的申诉记录
 * 规则：单用户每日最多提交 2 条（每日0点重置），管理员回复后推送站内消息
 */

const { get, post, showError } = require('../../utils/request');
const filter = require('../../utils/filter');

const theme = require('../../utils/theme');
const app = getApp();

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    content: '',
    list: [],
    todayCount: 0,
    submitting: false
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    if (!app.isLogin()) return;
    this.loadList();
  },

  /** 我的申诉记录 */
  async loadList() {
    try {
      const res = await get('/api/appeal/myList', { page: 1, pageSize: 20 });
      const list = (res.data.list || []).map((item) => ({
        ...item,
        statusText: filter.appealStatusText(item.status),
        timeText: filter.formatTime(item.created_at, 'YYYY-MM-DD HH:mm')
      }));
      // 统计今日已提交数量（按自然日）
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
      const todayCount = list.filter((item) => {
        const date = new Date(String(item.created_at).replace(/-/g, '/'));
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` === todayKey;
      }).length;
      this.setData({ list, todayCount });
    } catch (err) {
      if (err.code !== 401) showError(err);
    }
  },

  onInput(e) {
    this.setData({ content: e.detail.value });
  },

  /** 提交申诉 */
  async submit() {
    const content = (this.data.content || '').trim();
    if (content.length < 5) {
      wx.showToast({ title: '申诉内容不少于5个字', icon: 'none' });
      return;
    }
    if (this.data.todayCount >= 2) {
      wx.showToast({ title: '今日申诉次数已用完（每日2条）', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await post('/api/appeal/submit', { content });
      wx.showToast({ title: '申诉已提交', icon: 'success' });
      this.setData({ content: '' });
      this.loadList();
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
