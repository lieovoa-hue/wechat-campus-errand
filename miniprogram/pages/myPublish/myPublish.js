/**
 * 我的发布（Tab 页）
 * 按状态分组展示任务：待接单可「编辑 / 撤销」，进行中可「加酬金」，待支付可「继续支付」，
 * 已撤销（雇主主动撤销）可「申请退费」（先撤销、再退费的两步流程）
 */

const { get, post, showError } = require('../../utils/request');
const filter = require('../../utils/filter');
const { COUNTDOWN } = require('../../utils/constant');
const dialog = require('../../utils/dialog');
const preview = require('../../utils/preview');

const theme = require('../../utils/theme');
const app = getApp();

// 状态筛选选项（文案取状态字典，避免硬编码）
const STATUS_TABS = [
  { label: '全部', value: '' },
  { label: filter.taskStatusText(0), value: 0 },
  { label: filter.taskStatusText(1), value: 1 },
  { label: filter.taskStatusText(2), value: 2 },
  { label: filter.taskStatusText(3), value: 3 },
  { label: filter.taskStatusText(4), value: 4 },
  { label: filter.taskStatusText(5), value: 5 }
];

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    statusTabs: STATUS_TABS,
    activeStatus: '',
    groups: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    // 倒计时文案（统一读字典，页面里不硬编码中文）
    countdownLabel: COUNTDOWN.LABEL,
    countdownOverText: COUNTDOWN.OVER
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.loadList(true);
    // 底部「我的任务」角标：从别的页面回来时数字可能已经变了
    app.refreshTakeBadge();
  },

  onHide() {
    this.stopCountdown();
  },

  onUnload() {
    theme.unsync(this);
    this.stopCountdown();
  },

  onPullDownRefresh() {
    this.loadList(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadList(false);
  },

  /** 切换状态筛选 */
  onTabChange(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.value });
    this.loadList(true);
  },

  /**
   * 拉取我发布的任务
   * @param {boolean} reset 是否重置分页
   */
  async loadList(reset) {
    if (!app.isLogin()) return;
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });

    try {
      const res = await get('/api/task/myPublish', {
        page,
        pageSize: this.data.pageSize,
        status: this.data.activeStatus
      });
      const data = res.data;
      const list = reset ? data.list : this.flatten(this.data.groups).concat(data.list);
      this.setData({
        groups: this.buildGroups(list),
        page: data.page,
        hasMore: data.hasMore
      });
      this.startCountdown();
    } catch (err) {
      if (err.code !== 401) showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 把分组数据摊平，便于分页追加 */
  flatten(groups) {
    return groups.reduce((acc, group) => acc.concat(group.list), []);
  },

  /**
   * 启动限时任务倒计时
   * 说明：接口只下发「某一时刻」的剩余秒数，这里本地每秒递减，
   *      避免手机本地时间与服务端时间不一致导致倒计时跳变。
   */
  startCountdown() {
    this.stopCountdown();
    const hasRunning = this.data.groups.some(
      (group) => group.list.some((item) => item.remainSeconds !== null && item.remainSeconds > 0)
    );
    if (!hasRunning) return;
    this.countdownTimer = setInterval(() => this.tickCountdown(), 1000);
  },

  /** 停止倒计时（离开页面必须清理，避免后台空跑） */
  stopCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  /**
   * 倒计时每秒递减
   *  - 只对仍在倒计时的任务做增量 setData（性能友好）
   *  - 有任务刚好归零时刷新一次列表：后端定时任务可能已把它判为「超时取消」
   */
  tickCountdown() {
    const patch = {};
    let needRefresh = false;
    this.data.groups.forEach((group, gi) => {
      group.list.forEach((item, li) => {
        if (item.remainSeconds === null || item.remainSeconds <= 0) return;
        const next = item.remainSeconds - 1;
        patch[`groups[${gi}].list[${li}].remainSeconds`] = next;
        patch[`groups[${gi}].list[${li}].remainText`] = filter.countdownText(next);
        patch[`groups[${gi}].list[${li}].countdownOver`] = next <= 0;
        if (next === 0) needRefresh = true;
      });
    });
    if (Object.keys(patch).length) this.setData(patch);
    if (needRefresh) this.loadList(true);
  },

  /** 按状态分组 */
  buildGroups(list) {
    const order = [0, 1, 2, 3, 4, 5];
    const map = {};
    // 我自己的信息（用于展示「雇主（我）」这一行）
    const me = app.globalData.userInfo || {};
    const ownerPerson = filter.personView({
      label: '雇主（我）',
      avatar: me.avatar,
      nickname: me.nickname,
      userIdText: me.userIdText,
      studentId: me.studentId,
      isAdmin: me.isAdmin,
      isCertified: me.isCampusCertified
    });
    list.forEach((task) => {
      const item = {
        ...task,
        statusText: filter.taskStatusText(task.status),
        statusClass: filter.taskStatusClass(task.status),
        rewardText: filter.price(task.reward),
        publishTimeText: filter.formatTime(task.publishTime, 'MM-DD HH:mm'),
        limitText: filter.timeLimitText(task.timeLimitMin),
        // 未送达申诉：雇主已反馈未送达 -> 卡片角标红字提示，且该任务不会再被自动确认收货
        isDisputed: task.isDisputed === true,
        disputeReason: task.disputeReason || '',
        // 限时倒计时：后端只对「进行中 + 设置了限时」的任务下发 remainSeconds，其余为 null
        remainSeconds: typeof task.remainSeconds === 'number' ? task.remainSeconds : null,
        remainText: typeof task.remainSeconds === 'number' ? filter.countdownText(task.remainSeconds) : '',
        countdownOver: task.remainSeconds === 0,
        // 超时送达：跑腿员超过限时才送达，雇主可扣减酬金（扣减预览由后端算好下发）
        isLateDelivery: task.isLateDelivery === true,
        // 进行中且已超时：系统已自动扣减酬金但任务不取消，跑腿员可继续送达
        isOvertime: task.isOvertime === true,
        lateDeductAmount: task.lateDeductAmount || 0,
        isLateRewardDeducted: task.isLateRewardDeducted === true,
        lateDeliverySeconds: task.lateDeliverySeconds || 0,
        lateDeductPreview: task.lateDeductPreview || null,
        ownerPerson,
        // 跑腿员信息：头像 / 昵称 / 账号ID / 学号 / 认证标识（无人接单时不展示）
        takerPerson: task.takerUserId ? filter.personView({
          label: '跑腿员',
          avatar: task.takerAvatar,
          nickname: task.takerNickname,
          userIdText: task.takerUserIdText,
          studentId: task.takerStudentId,
          isAdmin: task.takerIsAdmin,
          isCertified: task.takerIsCertified
        }) : null
      };
      if (!map[task.status]) map[task.status] = [];
      map[task.status].push(item);
    });
    return order
      .filter((status) => map[status] && map[status].length)
      .map((status) => ({
        status,
        statusText: filter.taskStatusText(status),
        count: map[status].length,
        list: map[status]
      }));
  },

  /** 进入任务详情 */
  /** 点击雇主 / 跑腿员头像查看大图（catchtap 拦截，不会顺带跳到任务详情） */
  previewAvatar(e) {
    preview.previewImage(e.currentTarget.dataset.url);
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${e.currentTarget.dataset.id}` });
  },

  /** 编辑待接单任务 */
  goEdit(e) {
    wx.navigateTo({ url: `/pages/taskEdit/taskEdit?id=${e.currentTarget.dataset.id}` });
  },

  /** 撤销待接单任务 */
  cancelTask(e) {
    const taskId = e.currentTarget.dataset.id;
    dialog.show(this, {
      title: '撤销任务',
      content: '撤销后任务立即下架且不可再次编辑，可在本页「已撤销」中申请退还0.1元信息服务费，确认撤销吗？',
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/task/cancel', { taskId });
        wx.showToast({ title: result.msg || '撤销成功', icon: 'none' });
        this.loadList(true);
      } catch (err) {
        showError(err);
      }
    });
  },

  /**
   * 已撤销任务申请退券（先撤销、再退券的两步流程）
   * 说明：微信虚拟支付不支持退款，所以退回的是「发布券」而不是现金，
   *      券会在下次发布任务时自动抵扣 0.1 元信息服务费。
   */
  applyRefund(e) {
    const taskId = e.currentTarget.dataset.id;
    dialog.show(this, {
      title: '申请退券',
      content: '仅「从未被接单且发布未超过24小时」的已撤销任务可退券，确认申请返还 1 张发布券（价值 0.1 元，下次发布自动抵扣）吗？'
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/task/applyRefund', { taskId });
        wx.showToast({ title: result.msg || '退券成功', icon: 'success' });
        this.loadList(true);
      } catch (err) {
        showError(err);
      }
    });
  },
  /** 继续支付未支付的订单 */
  async repay(e) {
    const taskId = e.currentTarget.dataset.id;
    try {
      const res = await post('/api/pay/repay', { taskId });
      if (res.data.paid) {
        wx.showToast({ title: '支付成功', icon: 'success' });
        this.loadList(true);
        return;
      }
      const payParams = res.data.payParams;

      // 虚拟支付（个人主体 B 方案）：走 wx.requestVirtualPayment，参数由后端生成
      if (res.data.payMode === 'virtual') {
        if (typeof wx.requestVirtualPayment !== 'function') {
          wx.showModal({ title: '当前微信版本不支持', content: '虚拟支付需要较新版本的微信，请升级微信后重试。', showCancel: false });
          return;
        }
        wx.requestVirtualPayment({
          signData: payParams.signData,
          paySig: payParams.paySig,
          signature: payParams.signature,
          mode: payParams.mode || 'short_series_goods',
          success: () => this.loadList(true),
          fail: () => wx.showToast({ title: '支付已取消', icon: 'none' })
        });
        return;
      }

      wx.requestPayment({
        timeStamp: payParams.timeStamp,
        nonceStr: payParams.nonceStr,
        package: payParams.package,
        signType: payParams.signType,
        paySign: payParams.paySign,
        success: () => this.loadList(true),
        fail: () => wx.showToast({ title: '支付已取消', icon: 'none' })
      });
    } catch (err) {
      showError(err);
    }
  }
});
