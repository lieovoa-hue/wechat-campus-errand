/**
 * 我的任务（Tab 页）：我接的订单
 *  - 进行中：上传送达照片并提交完成（必须至少1张，最多3张）、10分钟内可取消接单
 *  - 待雇主确认：等待雇主确认（超过2小时系统自动确认）
 */

const { get, post, chooseAndUpload, showError, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const filter = require('../../utils/filter');
const { COUNTDOWN } = require('../../utils/constant');
const dialog = require('../../utils/dialog');
const preview = require('../../utils/preview');

const theme = require('../../utils/theme');
const app = getApp();

const STATUS_TABS = [
  { label: '全部', value: '' },
  { label: filter.taskStatusText(1), value: 1 },
  { label: filter.taskStatusText(2), value: 2 },
  { label: filter.taskStatusText(3), value: 3 },
  { label: '已取消', value: 45 }
];

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    statusTabs: STATUS_TABS,
    activeStatus: '',
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    // 待提交的送达照片保存在每个列表项的 photos 字段中
    placeholder: '',
    // 倒计时文案（统一读字典，页面里不硬编码中文）
    countdownLabel: COUNTDOWN.LABEL,
    countdownOverText: COUNTDOWN.OVER
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.loadList(true);
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

  onTabChange(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.value });
    this.loadList(true);
  },

  /** 加载我接的任务 */
  async loadList(reset) {
    if (!app.isLogin() || this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    try {
      const res = await get('/api/task/myTake', {
        page,
        pageSize: this.data.pageSize,
        status: this.data.activeStatus
      });
      const data = res.data;
      const list = (reset ? data.list : this.data.list.concat(data.list)).map((task) => ({
        ...task,
        statusText: filter.taskStatusText(task.status),
        statusClass: filter.taskStatusClass(task.status),
        rewardText: filter.price(task.reward),
        publishTimeText: filter.formatTime(task.publishTime, 'MM-DD HH:mm'),
        takeTimeText: filter.formatTime(task.takeTime, 'MM-DD HH:mm'),
        // 限时直接显示时长文案（不限时为「不限时」）
        limitText: filter.timeLimitText(task.timeLimitMin),
        // 未送达申诉：雇主已反馈未送达 -> 红色角标提示，且该任务不会再被自动确认收货
        isDisputed: task.isDisputed === true,
        disputeReason: task.disputeReason || '',
        // 限时倒计时：后端只对「进行中 + 设置了限时」的任务下发 remainSeconds，其余为 null
        remainSeconds: typeof task.remainSeconds === 'number' ? task.remainSeconds : null,
        remainText: typeof task.remainSeconds === 'number' ? filter.countdownText(task.remainSeconds) : '',
        countdownOver: task.remainSeconds === 0,
        // 超时送达：本次送达超过了限时，雇主可据此扣减酬金
        isLateDelivery: task.isLateDelivery === true,
        // 进行中且已超时：系统已自动扣减酬金但任务不取消，可继续送达
        isOvertime: task.isOvertime === true,
        lateDeductAmount: task.lateDeductAmount || 0,
        lateDeliverySeconds: task.lateDeliverySeconds || 0,
        // 雇主信息：头像 / 昵称 / 账号ID / 学号 / 认证标识（管理员为红色标识）
        ownerPerson: filter.personView({
          label: '雇主',
          avatar: task.ownerAvatar,
          nickname: task.ownerNickname,
          userIdText: task.ownerUserIdText,
          studentId: task.ownerStudentId,
          isAdmin: task.ownerIsAdmin,
          isCertified: task.ownerIsCertified
        }),
        // photos 保存待提交的相对路径（提交接口用），photoUrls 用于页面展示
        photos: [],
        photoUrls: []
      }));
      this.setData({ list, page: data.page, hasMore: data.hasMore });
      this.startCountdown();
    } catch (err) {
      if (err.code !== 401) showError(err);
    } finally {
      this.setData({ loading: false });
      // 列表刷完顺手校准 tabBar 角标：取消接单 / 提交完成都会改变「未完成」数量
      app.refreshTakeBadge();
    }
  },

  /** 点击雇主头像查看大图（catchtap 拦截，不会顺带跳到任务详情） */
  previewAvatar(e) {
    preview.previewImage(e.currentTarget.dataset.url);
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${e.currentTarget.dataset.id}` });
  },

  /**
   * 启动限时任务倒计时
   * 说明：接口只下发「某一时刻」的剩余秒数，这里本地每秒递减，
   *      避免手机本地时间与服务端时间不一致导致倒计时跳变。
   */
  startCountdown() {
    this.stopCountdown();
    const hasRunning = this.data.list.some(
      (item) => item.remainSeconds !== null && item.remainSeconds > 0
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
    this.data.list.forEach((item, index) => {
      if (item.remainSeconds === null || item.remainSeconds <= 0) return;
      const next = item.remainSeconds - 1;
      patch[`list[${index}].remainSeconds`] = next;
      patch[`list[${index}].remainText`] = filter.countdownText(next);
      patch[`list[${index}].countdownOver`] = next <= 0;
      if (next === 0) needRefresh = true;
    });
    if (Object.keys(patch).length) this.setData(patch);
    if (needRefresh) this.loadList(true);
  },

  /**
   * 上传送达照片
   * @param {object} e dataset.id 任务ID
   */
  async choosePhoto(e) {
    const index = e.currentTarget.dataset.index;
    const current = this.data.list[index].photos || [];
    const rest = 3 - current.length;
    if (rest <= 0) {
      wx.showToast({ title: '送达照片最多3张', icon: 'none' });
      return;
    }
    try {
      const urls = await chooseAndUpload(rest);
      if (urls.length) {
        const photos = current.concat(urls);
        this.setData({
          [`list[${index}].photos`]: photos,
          [`list[${index}].photoUrls`]: filter.imageUrls(photos)
        });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除待提交的送达照片 */
  removePhoto(e) {
    const index = e.currentTarget.dataset.index;
    const photoIndex = e.currentTarget.dataset.photoIndex;
    const urls = (this.data.list[index].photos || []).slice();
    urls.splice(photoIndex, 1);
    this.setData({
      [`list[${index}].photos`]: urls,
      [`list[${index}].photoUrls`]: filter.imageUrls(urls)
    });
  },

  /** 提交任务完成（未上传送达照片时提示并阻止） */
  async submitFinish(e) {
    const index = e.currentTarget.dataset.index;
    const taskId = this.data.list[index].id;
    const images = this.data.list[index].photos || [];
    if (images.length === 0) {
      wx.showToast({ title: '请先上传送达照片', icon: 'none' });
      return;
    }
    try {
      await post('/api/task/submitFinish', { taskId, deliveryImages: images });
      wx.showToast({ title: '提交成功', icon: 'success' });
      this.setData({ [`list[${index}].photos`]: [], [`list[${index}].photoUrls`]: [] });
      this.loadList(true);
    } catch (err) {
      showError(err);
    }
  },

  /** 取消接单（接单后10分钟内，不触发封禁） */
  cancelTake(e) {
    const taskId = e.currentTarget.dataset.id;
    dialog.show(this, {
      title: '取消接单',
      content: '接单后10分钟内可取消，取消后任务重新上架，确认取消吗？',
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        await post('/api/task/cancelTake', { taskId });
        wx.showToast({ title: '已取消接单', icon: 'success' });
        this.loadList(true);
      } catch (err) {
        showError(err);
      }
    });
  }
});
