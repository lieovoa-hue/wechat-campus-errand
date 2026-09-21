/**
 * =====================================================================
 * 消息中心
 * ---------------------------------------------------------------------
 *  · 分类列表（系统 / 管理员 / 任务 / 雇主），紧凑行，点任意一行进详情页
 *  · 两个批量操作（常显，不再因为已读而消失）：
 *      全部已读 —— 标记已读，历史保留；无未读时置灰
 *      全部删除 —— 物理删除全部消息（含已读），弹二次确认；无消息时置灰
 *  · 分类 Tab 上带该分类的未读数角标
 *  · 详情页返回后会重新拉一次列表，保证已读状态与未读数是最新的
 * =====================================================================
 */

const { get, post, showError } = require('../../utils/request');
const dialog = require('../../utils/dialog');
const filter = require('../../utils/filter');
const { MSG, formatText } = require('../../utils/constant');

const theme = require('../../utils/theme');
const app = getApp();

/** 分类 Tab：value 为空串表示「全部」，与后端 msgType 参数一致 */
const TYPE_TABS = [
  { label: '全部', value: '' },
  { label: filter.msgTypeText(1), value: 1 },
  { label: filter.msgTypeText(2), value: 2 },
  { label: filter.msgTypeText(3), value: 3 },
  { label: filter.msgTypeText(4), value: 4 }
];

/**
 * 消息类型 → 列表标签配色类名（对应 message.wxss 里的 .msg-tag-*）
 * 1系统 2管理员 3任务 4雇主
 */
const TYPE_CLASS = {
  1: 'system',
  2: 'admin',
  3: 'task',
  4: 'owner'
};

/**
 * 消息类型 → 左侧圆底图标（对应 app.wxss 第 6 节的 CSS 图标集）
 * 用图标 + 同色淡底代替纯文字标签，列表左侧形成统一的视觉锚点
 */
const TYPE_ICON = {
  1: 'bell',
  2: 'shield',
  3: 'box',
  4: 'user'
};

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    typeTabs: TYPE_TABS,
    activeType: '',
    list: [],
    page: 1,
    pageSize: 15,
    hasMore: true,
    unread: 0,
    total: 0,
    unreadText: '',
    loading: false,
    // 按钮文案统一走字典（禁止在 wxml 里硬编码中文）
    readAllText: MSG.MSG_ACTION_READ_ALL,
    deleteAllText: MSG.MSG_ACTION_DELETE_ALL
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.loadList(true);
  },

  onPullDownRefresh() {
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadList(false);
  },

  onTabChange(e) {
    this.setData({ activeType: e.currentTarget.dataset.value });
    this.loadList(true);
  },

  async loadList(reset) {
    if (!app.isLogin() || this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const res = await get('/api/message/list', {
        page, pageSize: this.data.pageSize, msgType: this.data.activeType
      });
      const data = res.data;
      const list = (reset ? data.list : this.data.list.concat(data.list)).map((msg) => ({
        ...msg,
        typeText: filter.msgTypeText(msg.msg_type),
        timeText: filter.fromNow(msg.created_at),
        typeClass: TYPE_CLASS[Number(msg.msg_type)] || 'system',
        iconName: TYPE_ICON[Number(msg.msg_type)] || 'bell'
      }));
      const unreadByType = data.unreadByType || {};
      this.setData({
        list,
        page: data.page,
        hasMore: data.hasMore,
        unread: data.unread,
        total: data.total,
        unreadText: data.unread > 0 ? formatText(MSG.MSG_UNREAD_COUNT, { count: data.unread }) : MSG.MSG_NO_UNREAD,
        // 分类 Tab 上的角标：全部 = 总未读，其余按 msg_type 取；超过 99 显示 99+
        typeTabs: TYPE_TABS.map((tab) => {
          const badge = tab.value === '' ? (data.unread || 0) : (unreadByType[tab.value] || 0);
          return {
            ...tab,
            badge,
            badgeText: badge > 0 ? (badge > 99 ? MSG.BADGE_OVERFLOW : String(badge)) : ''
          };
        })
      });
    } catch (err) {
      if (err.code !== 401) showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 进入消息详情页（详情页会自行标记已读） */
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/messageDetail/messageDetail?id=${id}` });
  },

  /** 一键已读（幂等；无未读时按钮置灰，这里再做一次兜底） */
  async readAll() {
    if (this.data.unread <= 0) return;
    try {
      await post('/api/message/readAll', {});
      wx.showToast({ title: '已全部标记已读', icon: 'success' });
      this.loadList(true);
    } catch (err) {
      showError(err);
    }
  },

  /**
   * 全部删除（含已读，不可恢复）
   * ---------------------------------------------------------------------
   * 与「全部已读」并列常显：一键把收件箱清空，适合消息堆积时快速清理。
   * 删除不可恢复，所以必须先二次确认。
   */
  deleteAll() {
    if (this.data.total <= 0) {
      wx.showToast({ title: MSG.MSG_DELETE_ALL_EMPTY, icon: 'none' });
      return;
    }
    dialog.show(this, {
      title: MSG.MSG_DELETE_ALL_TITLE,
      content: MSG.MSG_DELETE_ALL_CONTENT,
      confirmText: MSG.MSG_DELETE_ALL_CONFIRM,
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/message/deleteAll', {});
        const deleted = (result.data && result.data.deleted) || 0;
        wx.showToast({ title: deleted > 0 ? `已删除 ${deleted} 条` : MSG.MSG_DELETE_ALL_EMPTY, icon: 'none' });
        this.loadList(true);
      } catch (err) {
        showError(err);
      }
    });
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
