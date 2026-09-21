/**
 * =====================================================================
 * 消息详情页
 * ---------------------------------------------------------------------
 * 为什么单独开一页：
 *   消息中心把每条消息压缩成两行，长正文（系统通知 / 管理员回复可能上百字）
 *   挤在列表里既看不全也点不准。详情页负责「完整展示 + 复制 / 跳转」，
 *   列表只负责「快速扫一眼」。
 * 后端契约：GET /api/message/detail?id=xx
 *   · 用 user_id 做归属校验，别人的消息 id 一律取不到（防越权探测）；
 *   · 进入详情即视为已读，后端顺手把 is_read 置 1（幂等）。
 * 返回消息中心时，message 页的 onShow 会重新拉列表，未读状态自动同步。
 * =====================================================================
 */

const { get, showError } = require('../../utils/request');
const filter = require('../../utils/filter');
const clipboard = require('../../utils/clipboard');

const theme = require('../../utils/theme');
/** 消息类型 → 配色类名（与 message.wxss 的 .msg-tag-* 保持一致） */
const TYPE_CLASS = {
  1: 'system',
  2: 'admin',
  3: 'task',
  4: 'owner'
};

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    id: '',
    loading: true,
    msg: null,
    typeText: '',
    typeClass: 'system',
    timeText: '',
    fullTimeText: ''
  },

  onLoad(query) {
    const id = query && query.id ? String(query.id) : '';
    if (!id) {
      // 没有 id 说明是被错误地直接打开，友好提示后返回，不白屏
      wx.showToast({ title: '消息不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ id });
    this.loadDetail();
  },

  /** 拉取消息详情 */
  async loadDetail() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/message/detail', { id: this.data.id });
      const msg = res.data.message;
      this.setData({
        msg,
        typeText: filter.msgTypeText(msg.msg_type),
        typeClass: TYPE_CLASS[Number(msg.msg_type)] || 'system',
        timeText: filter.fromNow(msg.created_at),
        fullTimeText: filter.formatTime(msg.created_at, 'YYYY-MM-DD HH:mm')
      });
      // 标题栏跟随消息标题，长标题自动截断由微信处理
      wx.setNavigationBarTitle({ title: '消息详情' });
    } catch (err) {
      if (err.code !== 401) showError(err);
      this.setData({ msg: null });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 复制整条消息（用户常要把取件码 / 地址转给别人） */
  copyContent() {
    const msg = this.data.msg;
    if (!msg) return Promise.resolve(false);
    return clipboard.copyText(`${msg.title}\n${msg.content}`, '消息内容');
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
