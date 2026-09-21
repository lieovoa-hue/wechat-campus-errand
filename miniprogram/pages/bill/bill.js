/**
 * 收支账单（纯记账展示）
 *  - 无提现申请入口，账单不可修改
 *  - 任务完成生成「任务收入」，支付成功生成「服务费支出」
 *  - 按时间倒序，可点击跳转关联任务详情
 */

const { get, showError } = require('../../utils/request');
const filter = require('../../utils/filter');

const theme = require('../../utils/theme');
const app = getApp();

const TYPE_TABS = [
  { label: '全部', value: '' },
  { label: filter.billTypeText(1), value: 1 },
  { label: filter.billTypeText(2), value: 2 }
];

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    typeTabs: TYPE_TABS,
    activeType: '',
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    summary: { income: '0.00', expense: '0.00' },
    loading: false
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
      const res = await get('/api/bill/list', {
        page, pageSize: this.data.pageSize, type: this.data.activeType
      });
      const data = res.data;
      const list = (reset ? data.list : this.data.list.concat(data.list)).map((bill) => ({
        ...bill,
        typeText: filter.billTypeText(bill.type),
        amountText: filter.price(bill.amount),
        timeText: filter.formatTime(bill.created_at, 'YYYY-MM-DD HH:mm')
      }));
      this.setData({
        list,
        page: data.page,
        hasMore: data.hasMore,
        summary: {
          income: filter.price(data.summary.income),
          expense: filter.price(data.summary.expense)
        }
      });
    } catch (err) {
      if (err.code !== 401) showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 点击账单跳转关联任务详情 */
  goTask(e) {
    const taskId = e.currentTarget.dataset.taskId;
    if (!taskId) return;
    wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${taskId}` });
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
