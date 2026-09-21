/**
 * 任务详情（双视角：雇主 / 接单者）
 *  - 接单方：进行中需上传「物品照片」+「送达照片」两类照片，两个都上传后才能「提交已送达」
 *  - 雇主方：限时任务超时后可点「结束任务」（3秒倒计时二次确认），确认后双方任务同时结束
 *  - 雇主方：待确认显示送达照片预览 + 「确认送达」；进行中显示「跑腿员配送中」
 *  - 确认送达二次确认弹窗：「否」始终可点，「确定」3秒倒计时结束后方可点击
 */

const { get, post, chooseAndUpload, showError, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const dialog = require('../../utils/dialog');
const filter = require('../../utils/filter');
const theme = require('../../utils/theme');
const subscribe = require('../../utils/subscribe');
// 字典与业务常量（必须与后端 utils/constant.js 完全一致，禁止硬编码中文文案）
//   UNDELIVERED_TAG / UNDELIVERED_TAG_OTHER：未送达申诉标签
//   BIZ：超时扣酬金比例与下限（前端只做展示，计算口径与后端完全一致）
const {
  UNDELIVERED_TAG, UNDELIVERED_TAG_OTHER, BIZ, MSG,
  REPORT_TAKER_TAG, REPORT_TAKER_TAG_OTHER
} = require('../../utils/constant');

const app = getApp();

/**
 * 「恶意超时投诉」快捷标签（可多选）
 * 说明：投诉记录会以 report_type = 2 进入管理员后台「举报管理」，
 *      并给全部管理员账号推送站内消息（投诉直达管理员），由管理员决定是否封禁接单人。
 */
const LATE_REPORT_TAGS = [
  { value: 1, label: '已超时很久仍未送达' },
  { value: 2, label: '联系不上接单人' },
  { value: 3, label: '接单人恶意拖延' },
  { value: 4, label: '其他情况' }
];

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    taskId: 0,
    task: null,
    remainSeconds: null,
    statusText: '',
    statusClass: 'tag',
    rewardText: '0.00',
    // 限时展示文案（不限时为「不限时」）
    limitText: '',
    // 相关人员：发布者 / 接单者（头像、昵称、账号ID、学号、认证标识）
    ownerPerson: null,
    takerPerson: null,
    publishTimeText: '',
    takeTimeText: '',
    submitTimeText: '',
    isOwner: false,
    isTaker: false,
    canReport: false,
    // ---- 管理员删除任务 ----
    isDeleted: false,       // 任务是否已被管理员删除（展示下架提示并隐藏全部操作按钮）
    deleteReason: '',       // 删除原因（仅管理员可见，普通用户只知道任务被删除）
    canDeleteTask: false,   // 当前查看者是否管理员（由后端 actions 统一计算，前端不自行判断）
    deleteNoticeText: MSG.TASK_DELETED_NOTICE,
    actions: {},
    // ---- 物品照片（接单人已拿到 / 买到物品的凭证，与送达照片一一对应） ----
    pickupImages: [],
    // 物品照片展示地址（补全域名）；pickupImages 存相对路径，用于提交接口
    pickupImageUrls: [],
    // 两类照片（物品 + 送达）都至少 1 张时，才允许点击「提交已送达」
    canSubmitPhotos: false,
    deliveryImages: [],
    // 送达照片的展示地址（补全域名）；deliveryImages 存的仍是相对路径，用于提交接口
    deliveryImageUrls: [],
    // ---- 雇主「结束任务」二次确认弹窗（超时后才出现，3秒倒计时同确认送达） ----
    showEndModal: false,
    endCountdown: 3,
    endDisabled: true,
    showConfirmModal: false,
    confirmCountdown: 3,
    confirmDisabled: true,
    showRewardModal: false,
    newReward: '',
    showReportModal: false,
    reportReason: '',
    // ---- 恶意超时投诉弹窗状态（仅雇主、且任务确实已超时可见） ----
    showLateReportModal: false,
    lateReportTags: [],
    lateReportText: '',
    canSubmitLateReport: false,
    // 超时时长（本地每秒累计，双方页面都能实时看到「已超时 X分Y秒」）
    overtimeSeconds: 0,
    overtimeText: '',
    // ---- 未送达申诉弹窗状态 ----
    showRejectModal: false,   // 弹窗显隐
    rejectTags: [],           // 标签列表 [{ value, label, selected }]
    otherText: '',            // 勾选「其他」时用户自行填写的问题原因
    needOtherText: false,     // 是否勾选「其他」（勾选后展开聊天输入框）
    canSubmitReject: false,   // 「发送」按钮是否可点击
    // ---- 任务类型 / 5 段进度 / 限时倒计时条（与首页深色卡同一套口径） ----
    taskTypeText: '',
    taskTypeClass: '',
    progressStep: 0,
    progressText: '',
    progressSteps: [],
    // 进度连线长度：第 N 段点亮 (N-1)*20%，与首页深色卡完全一致
    flowPercent: 0,
    // 接单人头像：进度条第 1 段起出现（未接单为空串，头像不渲染）
    takerAvatar: '',
    // 进度时间轴：已接单 10:28 · 已取货 10:35 · 已送达 11:02（有时间才拼）
    progressTimesText: '',
    // 雇主确认收货时间（待支付态展示「已于 XX 确认收货」）
    receiptTimeText: '',
    barClass: 'pending',
    barPercent: 100,
    barText: '',
    // ---- 双方联系方式（仅雇主与接单人可见；接单后才下发手机号） ----
    showContact: false,
    // ---- 接单人「确认取货」：照片落库并锁定（进度第 1 段 -> 第 2 段） ----
    pickupLocked: false,
    pickupConfirmedText: '',
    showPickupModal: false,
    pickupCountdown: 3,
    pickupDisabled: true,
    // ---- 雇主「举报接单人」弹窗 ----
    showReportTakerModal: false,
    reportTakerTags: [],
    reportTakerText: '',
    canSubmitReportTaker: false,
    // 超时送达：超时时长文案 + 扣减金额预览文案 + 扣减比例（百分比整数）
    lateText: '',
    lateDeductText: '',
    lateDeductRateText: `${Math.round(BIZ.LATE_DEDUCT_RATE * 100)}%`,
    lateDeductMinText: `¥${Number(BIZ.LATE_DEDUCT_MIN).toFixed(2)}`,
    submitting: false
  },

  onLoad(options) {
    this.setData({ taskId: Number(options.id || 0) });
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    if (app.isLogin()) this.loadDetail();
  },

  onUnload() {
    theme.unsync(this);
    if (this.timer) clearInterval(this.timer);
    if (this.remainTimer) clearInterval(this.remainTimer);
    if (this.pickupTimer) clearInterval(this.pickupTimer);
    this.clearEndTimer();
  },

  /** 页面隐藏时停止倒计时，避免后台重复计时 */
  onHide() {
    if (this.remainTimer) {
      clearInterval(this.remainTimer);
      this.remainTimer = null;
    }
    if (this.pickupTimer) {
      clearInterval(this.pickupTimer);
      this.pickupTimer = null;
    }
    this.clearEndTimer();
  },

  onPullDownRefresh() {
    this.loadDetail().then(() => wx.stopPullDownRefresh());
  },

  /** 加载任务详情 */
  async loadDetail() {
    try {
      const res = await get(`/api/task/${this.data.taskId}`);
      const { task, remainSeconds } = res.data;
      // 进度条第几段（后端 computeProgressStep 的唯一出口，0 表示还没人接单）
      const progressStep = Number(task.progressStep) || 0;
      // 限时倒计时条：配色 / 文案与首页深色卡共用 filter.limitBarState，两处永远一致
      const bar = filter.limitBarState(task);
      // 联系方式：任务被接单后，双方可见彼此姓名与手机号（后端只对双方下发手机号，
      // 陌生人拿到空串）。这里提前算好，供 people 卡片与「仅双方可见」提示共用。
      const showContact = Boolean(task.takerUserId) && (task.isOwner || task.isTaker);
      // 服务端只返回 /uploads/... 相对路径，渲染前必须补全域名，否则真机上图片显示不出来
      task.images = filter.imageUrls(task.images);
      task.deliveryImages = filter.imageUrls(task.deliveryImages);
      task.pickupImages = filter.imageUrls(task.pickupImages);
      this.setData({
        task,
        remainSeconds,
        // 超时时长：进行中已超时由后端下发秒数，之后由本地每秒累计
        overtimeSeconds: task.overtimeSeconds || 0,
        overtimeText: task.isOvertime ? filter.lateDurationText(task.overtimeSeconds || 0) : '',
        // 超时送达：超过限时才送达，雇主可在确认前按规则扣减酬金
        lateText: task.isLateDelivery ? filter.lateDurationText(task.lateDeliverySeconds) : '',
        lateDeductText: task.lateDeductPreview
          ? `扣减 ¥${filter.price(task.lateDeductPreview.deduct)}，扣后 ¥${filter.price(task.lateDeductPreview.remain)}`
          : '',
        statusText: filter.taskStatusText(task.status),
        statusClass: filter.taskStatusClass(task.status),
        rewardText: filter.price(task.reward),
        limitText: filter.timeLimitText(task.timeLimitMin),
        // 发布者信息（管理员 = 红色标识；校园认证通过 = 绿色「已认证」；其余不显示）
        // phone/showPhone：手机号只在任务被接单后对双方下发，直接展示在这张卡片里
        ownerPerson: filter.personView({
          label: '发布者',
          avatar: task.ownerAvatar,
          nickname: task.ownerNickname,
          userIdText: task.ownerUserIdText,
          studentId: task.ownerStudentId,
          isAdmin: task.ownerIsAdmin,
          isCertified: task.ownerIsCertified,
          phone: task.ownerPhone,
          showPhone: showContact
        }),
        // 接单者信息（无人接单时为 null，页面不渲染该行）
        takerPerson: task.takerUserId ? filter.personView({
          label: '接单者',
          avatar: task.takerAvatar,
          nickname: task.takerNickname,
          userIdText: task.takerUserIdText,
          studentId: task.takerStudentId,
          isAdmin: task.takerIsAdmin,
          isCertified: task.takerIsCertified,
          phone: task.takerPhone,
          showPhone: showContact
        }) : null,
        publishTimeText: filter.formatTime(task.publishTime, 'MM-DD HH:mm'),
        takeTimeText: filter.formatTime(task.takeTime, 'MM-DD HH:mm'),
        submitTimeText: filter.formatTime(task.submitFinishTime, 'MM-DD HH:mm'),
        isOwner: task.isOwner,
        isTaker: task.isTaker,
        // 举报入口是否可见：发布人不能举报自己的任务（后端 actions.canReport 统一计算）
        canReport: !!(task.actions && task.actions.canReport),
        // 管理员删除任务：入口仅管理员可见；任务已删除时展示下架提示条
        isDeleted: !!task.isDeleted,
        deleteReason: task.deleteReason || '',
        canDeleteTask: !!(task.actions && task.actions.canDeleteTask),
        actions: task.actions || {},
        // ---- 任务类型 / 5 段进度 / 倒计时条 ----
        taskTypeText: task.taskTypeText || filter.taskTypeText(task.taskType),
        taskTypeClass: filter.taskTypeClass(task.taskType),
        progressStep,
        progressText: filter.progressText(progressStep),
        progressSteps: filter.progressSteps(progressStep),
        progressTimesText: this.buildProgressTimes(task),
        // 进度连线：第 1 段在 10% 处、第 5 段在 90% 处，每走过一段点亮 20%
        flowPercent: Math.max(0, Math.min(4, progressStep - 1)) * 20,
        takerAvatar: task.takerAvatar ? filter.imageUrl(task.takerAvatar) : '',
        receiptTimeText: filter.formatTime(task.ownerReceiptTime, 'MM-DD HH:mm'),
        barClass: bar.className,
        barPercent: bar.percent,
        barText: bar.text,
        // ---- 联系方式：手机号已并进上面的 userCard（发布者 / 接单者卡片） ----
        showContact,
        // ---- 确认取货锁定态 ----
        pickupLocked: Boolean(task.pickupConfirmTime),
        pickupConfirmedText: task.pickupConfirmTime
          ? `已于 ${filter.formatTime(task.pickupConfirmTime, 'MM-DD HH:mm')} 确认取货，照片已锁定不可修改`
          : ''
      });
      this.startRemainTimer();
    } catch (err) {
      showError(err);
    }
  },

  /** 进行中任务的剩余时间倒计时 */
  startRemainTimer() {
    if (this.remainTimer) clearInterval(this.remainTimer);
    // 进行中且已经超时（剩余 0 秒）：没有倒计时，改为持续累计超时时长
    if (this.data.remainSeconds === 0) {
      this.startOvertimeTimer();
      return;
    }
    if (this.data.remainSeconds === null || this.data.remainSeconds <= 0) return;

    this.remainTimer = setInterval(() => {
      const next = this.data.remainSeconds - 1;
      if (next <= 0) {
        clearInterval(this.remainTimer);
        this.remainTimer = null;
        this.setData({ remainSeconds: 0 });
        // 倒计时归零后继续按秒累计超时时长：双方页面都能实时看到「已超时 X分Y秒」
        this.startOvertimeTimer();
      } else {
        // 倒计时条同步递减：颜色档位与首页深色卡完全一致（>50% 绿 / 20~50% 橙 / <20% 红）
        const task = this.data.task || {};
        const bar = filter.limitBarState({
          status: task.status,
          remainSeconds: next,
          timeLimitMin: task.timeLimitMin
        });
        this.setData({
          remainSeconds: next,
          barClass: bar.className,
          barPercent: bar.percent,
          barText: bar.text
        });
      }
    }, 1000);
  },

  /**
   * 已超时：本地每秒累计超时时长
   * 说明：超时后任务不会被取消，跑腿员仍可继续送达；
   *      酬金由后端定时任务在超时瞬间按规则（5%，不足0.5元按0.5元）自动扣减，
   *      前端只负责展示，避免前后端算法不一致。
   */
  startOvertimeTimer() {
    if (this.remainTimer) clearInterval(this.remainTimer);
    this.remainTimer = setInterval(() => {
      const next = Number(this.data.overtimeSeconds || 0) + 1;
      this.setData({ overtimeSeconds: next, overtimeText: filter.lateDurationText(next) });
    }, 1000);
  },

  /**
   * 拼进度时间轴文案：已接单 10:28 · 已取货 10:35 · 已送达 11:02 · 已收货 11:20
   * 只拼有时间的节点，没走到的那段不出现，避免出现一串「--」占位。
   * @param {object} task 任务对象
   * @returns {string}
   */
  buildProgressTimes(task) {
    const parts = [];
    const push = (label, value) => {
      if (!value) return;
      const text = filter.formatTime(value, 'MM-DD HH:mm');
      if (text) parts.push(`${label} ${text}`);
    };
    push('已接单', task.takeTime);
    push('已取货', task.pickupConfirmTime);
    push('已送达', task.submitFinishTime);
    push('已收货', task.ownerReceiptTime);
    return parts.join(' · ');
  },

  /** 未认证引导 */
  guideCampusCert() {
    dialog.show(this, {
      title: '需要校园认证',
      content: '接单前请先完成校园认证，认证通过后可解锁接单权限。',
      confirmText: '去认证'
    }).then((res) => {
      if (res.confirm) wx.navigateTo({ url: '/pages/campusCert/campusCert' });
    });
  },

  /** 接单 */
  async takeTask() {
    if (!app.checkLogin()) return;
    // 管理员已删除（下架）的任务：后端 assertTaskNotDeleted 会直接拒绝，前端提前拦截给出友好提示
    if (this.data.isDeleted) {
      wx.showToast({ title: '该任务已被下架，无法接单', icon: 'none' });
      return;
    }
    if (this.data.actions.needCampusCert) {
      this.guideCampusCert();
      return;
    }
    // 兜底：按钮可用性以后端 actions.canTake 为准，避免任务被支付拦截 / 被封禁时仍能点进接口
    if (!this.data.actions.canTake) {
      wx.showToast({ title: '该任务当前暂不可接单', icon: 'none' });
      this.loadDetail();
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    // 征求一次订阅授权：授权后「任务已完成」时接单者能收到微信通知
    await subscribe.requestOrderSubscribe('接单');
    try {
      await post('/api/task/take', { taskId: this.data.taskId });
      wx.showToast({ title: '接单成功', icon: 'success' });
      this.loadDetail();
    } catch (err) {
      showError(err);
      this.loadDetail();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 取消接单（接单后10分钟内） */
  cancelTake() {
    dialog.show(this, {
      title: '取消接单',
      content: '接单后10分钟内可取消，取消后任务将重新上架，确认取消吗？',
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        await post('/api/task/cancelTake', { taskId: this.data.taskId });
        wx.showToast({ title: '已取消接单', icon: 'success' });
        this.loadDetail();
      } catch (err) {
        showError(err);
      }
    });
  },

  /**
   * 选择「物品照片」（最多3张）
   * 用途：证明接单人已经拿到 / 买到物品，未上传时不允许提交已送达
   */
  async choosePickupImage() {
    const rest = 3 - this.data.pickupImages.length;
    if (rest <= 0) {
      wx.showToast({ title: '物品照片最多3张', icon: 'none' });
      return;
    }
    try {
      const urls = await chooseAndUpload(rest);
      if (urls.length) {
        const pickupImages = this.data.pickupImages.concat(urls);
        this.setData({
          pickupImages,
          pickupImageUrls: filter.imageUrls(pickupImages),
          canSubmitPhotos: this.data.pickupLocked && this.data.deliveryImages.length > 0
        });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除物品照片 */
  removePickupImage(e) {
    const index = e.currentTarget.dataset.index;
    const pickupImages = this.data.pickupImages.slice();
    pickupImages.splice(index, 1);
    this.setData({
      pickupImages,
      pickupImageUrls: filter.imageUrls(pickupImages),
      // 物品照片是否「已确认取货」由服务端锁定状态决定，本地草稿清空不影响
      canSubmitPhotos: this.data.pickupLocked && this.data.deliveryImages.length > 0
    });
  },

  /** 选择送达照片（最多3张） */
  async chooseDeliveryImage() {
    const rest = 3 - this.data.deliveryImages.length;
    if (rest <= 0) {
      wx.showToast({ title: '送达照片最多3张', icon: 'none' });
      return;
    }
    try {
      const urls = await chooseAndUpload(rest);
      if (urls.length) {
        const deliveryImages = this.data.deliveryImages.concat(urls);
        this.setData({
          deliveryImages,
          deliveryImageUrls: filter.imageUrls(deliveryImages),
          canSubmitPhotos: this.data.pickupLocked && deliveryImages.length > 0
        });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除送达照片 */
  removeDeliveryImage(e) {
    const index = e.currentTarget.dataset.index;
    const deliveryImages = this.data.deliveryImages.slice();
    deliveryImages.splice(index, 1);
    this.setData({
      deliveryImages,
      deliveryImageUrls: filter.imageUrls(deliveryImages),
      canSubmitPhotos: this.data.pickupLocked && deliveryImages.length > 0
    });
  },

  /** 预览照片（本地待提交 / 服务器送达照片） */
  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    const source = e.currentTarget.dataset.source;
    let urls = [];
    if (source === 'local') urls = this.data.deliveryImageUrls;
    else if (source === 'pickupLocal') urls = this.data.pickupImageUrls;
    else if (source === 'pickupServer') urls = (this.data.task ? this.data.task.pickupImages : []) || [];
    else urls = (this.data.task ? this.data.task.deliveryImages : []) || [];
    wx.previewImage({ current: urls[index], urls });
  },

  /**
   * 提交任务完成
   * 强制校验两类照片：
   *   1) pickupImages   物品照片 —— 证明接单人已经拿到 / 买到物品
   *   2) deliveryImages 送达照片 —— 证明物品已经送到雇主手上
   * 两类照片都至少 1 张才允许提交，否则给出对应提示（文案统一走 MSG 字典）
   */
  async submitFinish() {
    if (this.data.pickupImages.length === 0 && this.data.deliveryImages.length === 0) {
      wx.showToast({ title: MSG.NEED_BOTH_IMG, icon: 'none' });
      return;
    }
    if (this.data.pickupImages.length === 0) {
      wx.showToast({ title: MSG.NEED_PICKUP_IMG, icon: 'none' });
      return;
    }
    if (this.data.deliveryImages.length === 0) {
      wx.showToast({ title: MSG.NEED_DELIVERY_IMG, icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      // 物品照片在「确认取货」时已落库并锁定，这里只提交送达照片
      await post('/api/task/submitFinish', {
        taskId: this.data.taskId,
        deliveryImages: this.data.deliveryImages
      });
      wx.showToast({ title: '提交成功', icon: 'success' });
      this.setData({
        pickupImages: [],
        pickupImageUrls: [],
        deliveryImages: [],
        deliveryImageUrls: [],
        canSubmitPhotos: false
      });
      this.loadDetail();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 打开确认送达弹窗（「确定」3秒倒计时后才可点击，「否」始终可点） */
  openConfirmModal() {
    this.setData({ showConfirmModal: true, confirmCountdown: 3, confirmDisabled: true });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const next = this.data.confirmCountdown - 1;
      if (next <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.setData({ confirmCountdown: 0, confirmDisabled: false });
      } else {
        this.setData({ confirmCountdown: next, confirmDisabled: true });
      }
    }, 1000);
  },

  /** 关闭弹窗 */
  closeConfirmModal() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setData({ showConfirmModal: false, confirmCountdown: 3, confirmDisabled: true });
  },

  /** 确认送达（生成接单者任务收入账单由后端完成） */
  async doConfirmFinish() {
    if (this.data.confirmDisabled) return;
    try {
      await post('/api/task/confirmFinish', { taskId: this.data.taskId });
      this.closeConfirmModal();
      wx.showToast({ title: '已确认送达', icon: 'success' });
      this.loadDetail();
    } catch (err) {
      this.closeConfirmModal();
      showError(err);
    }
  },

  /**
   * 打开「结束任务」弹窗（仅限时任务已超时、且当前用户是雇主时入口可见）
   * 交互与「确认送达」保持一致：「否」始终可点，「确定」3秒倒计时结束后才可点
   */
  openEndModal() {
    this.setData({ showEndModal: true, endCountdown: 3, endDisabled: true });
    if (this.endTimer) clearInterval(this.endTimer);
    this.endTimer = setInterval(() => {
      const next = this.data.endCountdown - 1;
      if (next <= 0) {
        clearInterval(this.endTimer);
        this.endTimer = null;
        this.setData({ endCountdown: 0, endDisabled: false });
      } else {
        this.setData({ endCountdown: next, endDisabled: true });
      }
    }, 1000);
  },

  /** 关闭「结束任务」弹窗并重置倒计时 */
  closeEndModal() {
    if (this.endTimer) clearInterval(this.endTimer);
    this.endTimer = null;
    this.setData({ showEndModal: false, endCountdown: 3, endDisabled: true });
  },

  /**
   * 雇主确认「结束任务」
   * 后端 /api/task/endOvertime 会在同一事务内把任务置为「超时取消」并给双方推送站内消息，
   * 双方任务列表 / 详情页刷新后都会看到任务已结束。
   */
  async doEndOvertime() {
    if (this.data.endDisabled) return;
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await post('/api/task/endOvertime', { taskId: this.data.taskId });
      this.closeEndModal();
      wx.showToast({ title: res.msg || '任务已结束', icon: 'none' });
      this.loadDetail();
    } catch (err) {
      this.closeEndModal();
      showError(err);
      this.loadDetail();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 页面卸载时清理结束任务弹窗的倒计时器 */
  clearEndTimer() {
    if (this.endTimer) clearInterval(this.endTimer);
    this.endTimer = null;
  },

  /**
   * 雇主对「超时送达」任务扣减酬金
   * 规则：扣减金额 = 酬金 × 5%，不足 0.5 元按 0.5 元计算（金额由后端算好下发，前端只做展示）
   * 该操作一次性生效，扣减后确认送达 / 自动确认时账单都按扣减后的酬金记账
   */
  deductLateReward() {
    const task = this.data.task;
    const preview = task && task.lateDeductPreview;
    if (!preview) {
      wx.showToast({ title: '该任务不是超时送达，无法扣减酬金', icon: 'none' });
      return;
    }
    dialog.show(this, {
      title: '超时送达扣减酬金',
      content: `本次送达超时 ${this.data.lateText}。按规则扣减酬金 ¥${filter.price(preview.deduct)}`
        + `（酬金的 ${this.data.lateDeductRateText}，不足 ${this.data.lateDeductMinText} 按 ${this.data.lateDeductMinText} 计算），`
        + `扣减后酬金 ¥${filter.price(preview.remain)}。确认扣减吗？`
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/task/deductLateReward', { taskId: this.data.taskId });
        wx.showToast({ title: result.msg || '已扣减酬金', icon: 'none' });
        this.loadDetail();
      } catch (err) {
        showError(err);
        this.loadDetail();
      }
    });
  },

  /**
   * 打开「未送达」申诉弹窗
   * 标签字典来自 utils/constant.js，点击标签可直接勾选，无需输入
   */
  openRejectModal() {
    const rejectTags = Object.keys(UNDELIVERED_TAG).map((key) => ({
      value: Number(key),
      label: UNDELIVERED_TAG[key],
      selected: false
    }));
    this.setData({
      showRejectModal: true,
      rejectTags,
      otherText: '',
      needOtherText: false,
      canSubmitReject: false
    });
  },

  /** 关闭「未送达」申诉弹窗并重置状态 */
  closeRejectModal() {
    this.setData({
      showRejectModal: false,
      rejectTags: [],
      otherText: '',
      needOtherText: false,
      canSubmitReject: false
    });
  },

  /**
   * 选择 / 取消选择申诉原因（单选）
   * ----------------------------------------------------------------
   * 一次申诉只对应一个主因：多选会让管理员难以判定责任归属，
   * 也让用户倾向于「全都勾上」。点已选中项＝取消，点其他项＝改选它。
   */
  toggleRejectTag(e) {
    const value = Number(e.currentTarget.dataset.value);
    const rejectTags = this.data.rejectTags.map((item) => ({
      ...item,
      selected: item.value === value ? !item.selected : false
    }));
    this.applyRejectState(rejectTags, this.data.otherText);
  },

  /** 「其他」问题原因输入（相当于聊天窗里用户自行描述问题） */
  onOtherInput(e) {
    this.applyRejectState(this.data.rejectTags, e.detail.value);
  },

  /**
   * 统一计算弹窗派生状态
   *  - needOtherText：选中「其他」→ 展开输入框，由用户自行输入问题原因
   *  - canSubmitReject：必须选中 1 项；选中「其他」时问题原因不少于 2 个字
   * @param {Array} rejectTags 标签列表
   * @param {string} otherText 其他原因文本
   */
  applyRejectState(rejectTags, otherText) {
    const selected = rejectTags.filter((item) => item.selected).map((item) => item.value);
    const needOtherText = selected.indexOf(UNDELIVERED_TAG_OTHER) > -1;
    const canSubmitReject = selected.length > 0
      && (!needOtherText || String(otherText || '').trim().length >= 2);
    this.setData({ rejectTags, otherText, needOtherText, canSubmitReject });
  },

  /**
   * 发送「未送达」申诉
   * 提交成功后后端会把 tasks.is_disputed 置 1，
   * 该任务随即退出「超过2小时自动确认完成」的定时判定，不再触发倒计时自动收货
   */
  async submitReject() {
    if (!this.data.canSubmitReject) {
      wx.showToast({
        title: this.data.needOtherText ? '请填写问题原因（不少于2个字）' : '请至少选择一项原因',
        icon: 'none'
      });
      return;
    }
    if (this.data.submitting) return;

    const tags = this.data.rejectTags.filter((item) => item.selected).map((item) => item.value);
    this.setData({ submitting: true });
    try {
      const res = await post('/api/task/rejectFinish', {
        taskId: this.data.taskId,
        tags,
        otherText: String(this.data.otherText || '').trim()
      });
      this.closeRejectModal();
      wx.showToast({ title: res.msg || '已发送', icon: 'none' });
      this.loadDetail();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 打开加酬金弹窗 */
  openRewardModal() {
    this.setData({ showRewardModal: true, newReward: this.data.task ? String(this.data.task.reward) : '' });
  },

  closeRewardModal() {
    this.setData({ showRewardModal: false, newReward: '' });
  },

  onRewardInput(e) {
    this.setData({ newReward: e.detail.value });
  },

  /** 提交加酬金（仅可提高） */
  async submitReward() {
    const reward = Number(this.data.newReward);
    if (!reward || reward <= 0) {
      wx.showToast({ title: '请输入正确的酬金', icon: 'none' });
      return;
    }
    if (this.data.task && reward <= Number(this.data.task.reward)) {
      wx.showToast({ title: '酬金仅可提高，不可降低', icon: 'none' });
      return;
    }
    try {
      await post('/api/task/adjustReward', { taskId: this.data.taskId, reward });
      this.closeRewardModal();
      wx.showToast({ title: '酬金调整成功', icon: 'success' });
      this.loadDetail();
    } catch (err) {
      showError(err);
    }
  },

  /** 雇主撤销任务（撤销后下架，退费到「我的发布-已撤销」申请） */
  ownerCancel() {
    dialog.show(this, {
      title: '撤销任务',
      content: '撤销后任务立即下架且不可再次编辑，可在「我的发布 - 已撤销」中申请退还0.1元信息服务费，确认撤销吗？',
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/task/cancel', { taskId: this.data.taskId });
        wx.showToast({ title: result.msg || '撤销成功', icon: 'none' });
        this.loadDetail();
      } catch (err) {
        showError(err);
      }
    });
  },

  /** 跳转编辑页 */
  goEdit() {
    wx.navigateTo({ url: `/pages/taskEdit/taskEdit?id=${this.data.taskId}` });
  },

  /** 打开举报弹窗 */
  openReportModal() {
    this.setData({ showReportModal: true, reportReason: '' });
  },

  closeReportModal() {
    this.setData({ showReportModal: false, reportReason: '' });
  },

  onReportInput(e) {
    this.setData({ reportReason: e.detail.value });
  },

  /** 提交举报 */
  async submitReport() {
    const reason = this.data.reportReason.trim();
    if (reason.length < 5) {
      wx.showToast({ title: '举报原因不少于5个字', icon: 'none' });
      return;
    }
    try {
      // 举报时一并上报订单号：后端会以 tasks.order_no 为准做一致性校验，
      // 并把「订单号 + 双方 账号ID / 学号 / 手机号」快照落库，供管理员核对订单
      await post('/api/report/submit', {
        taskId: this.data.taskId,
        reportReason: reason,
        orderNo: (this.data.task && this.data.task.orderNo) || ''
      });
      this.closeReportModal();
      wx.showToast({ title: '举报已提交', icon: 'success' });
    } catch (err) {
      showError(err);
    }
  },

  /**
   * 管理员删除任务（入口仅管理员账号可见，后端另有学号白名单硬校验）
   * ------------------------------------------------------------------
   * 1. 二次确认：原生弹窗可同时填写删除原因（选填，会同步告知发布者）；
   * 2. 后端 /api/admin/deleteTask 负责软删除（数据保留）并推送站内消息；
   * 3. 删除成功后任务全平台下架，返回上一页（列表页 onShow 会重新拉取，自动刷新）。
   */
  async onDeleteTask() {
    if (this.data.submitting) return;

    const confirmRes = await new Promise((resolve) => {
      wx.showModal({
        title: '删除任务',
        content: '删除后该任务会从任务大厅、我的发布、我的任务中全部下架，且不可恢复。'
          + '若任务处于「待接单」状态，信息服务费将自动原路退回。确定删除吗？',
        // editable：允许管理员顺手填写删除原因（选填）
        editable: true,
        placeholderText: '可填写删除原因（选填，会同步告知发布者）',
        confirmText: '删除',
        confirmColor: '#e64340',
        success: (res) => resolve(res),
        fail: () => resolve({ confirm: false })
      });
    });
    if (!confirmRes || !confirmRes.confirm) return;

    this.setData({ submitting: true });
    try {
      const res = await post('/api/admin/deleteTask', {
        taskId: this.data.taskId,
        // editable 输入框的内容（未填写时为空串）
        reason: String(confirmRes.content || '').trim()
      });
      // 后端会把「信息服务费已原路退回」一并写进提示语（待接单任务自动退费）
      wx.showToast({ title: (res && res.msg) || '任务已删除', icon: 'none' });
      // 稍等提示展示完再返回，避免 toast 被立刻销毁
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.reLaunch({ url: '/pages/index/index' });
        }
      }, 1200);
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 打开「举报接单人恶意超时」弹窗 */
  openLateReportModal() {
    this.setData({
      showLateReportModal: true,
      lateReportTags: LATE_REPORT_TAGS.map((item) => ({ ...item, selected: false })),
      lateReportText: '',
      canSubmitLateReport: false
    });
  },

  closeLateReportModal() {
    this.setData({ showLateReportModal: false, lateReportText: '' });
  },

  /** 选择 / 取消选择超时情况（单选，选中 1 项才能发送） */
  toggleLateReportTag(e) {
    const value = Number(e.currentTarget.dataset.value);
    const lateReportTags = this.data.lateReportTags.map((item) => ({
      ...item,
      selected: item.value === value ? !item.selected : false
    }));
    const canSubmitLateReport = lateReportTags.some((item) => item.selected);
    this.setData({ lateReportTags, canSubmitLateReport });
  },

  onLateReportInput(e) {
    this.setData({ lateReportText: e.detail.value });
  },

  /**
   * 提交「恶意超时投诉」
   * 投诉直达管理员账号：后端会写入 report（report_type=2 恶意超时投诉）并给全部管理员推送站内消息
   */
  async submitLateReport() {
    if (!this.data.canSubmitLateReport) {
      wx.showToast({ title: '请至少选择一项超时情况', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    const labels = this.data.lateReportTags
      .filter((item) => item.selected)
      .map((item) => item.label)
      .join('、');
    const text = String(this.data.lateReportText || '').trim();
    // 后端限制补充说明 150 字，这里自行截断，避免被服务端静默截断
    const reason = (text ? `${labels}；${text}` : labels).slice(0, 150);

    this.setData({ submitting: true });
    try {
      const res = await post('/api/task/reportLateTaker', { taskId: this.data.taskId, reason });
      this.closeLateReportModal();
      wx.showToast({ title: res.msg || '投诉已提交', icon: 'none' });
      this.loadDetail();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  // ==================================================================
  // 本轮新增：双方联系方式 / 确认取货 / 确认收货 / 举报接单人
  // ==================================================================

  /**
   * 拨打相关人员电话
   * 手机号只对「雇主 + 接单人」下发（后端按 isOwner || isTaker 判定），
   * 大厅里的陌生用户拿到的 ownerPhone / takerPhone 是空串，点按钮会提示未填写。
   */
  callPhone(e) {
    // 两种来源都兼容：userCard 组件抛出的 call 事件（详情页现在的入口）、
    // 以及历史写法 data-phone（dataset）。
    const detail = (e && e.detail) || {};
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const phone = String(detail.phone || dataset.phone || '').trim();
    if (!phone) {
      wx.showToast({ title: '对方未填写手机号', icon: 'none' });
      return;
    }
    // 用户取消拨打属于正常操作，不做任何提示；只有真正的失败才静默忽略
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  /**
   * 雇主「确认收货」（进度第 3 段已送达 → 第 4 段待支付）
   * ------------------------------------------------------------------
   * 为什么拆成两步：酬金是线下转账，平台无法代扣。
   * 一次性「确认送达」会让雇主在没付钱的情况下把单关掉，跑腿员拿不到钱。
   * 因此：确认收货 → 页面提示线下转账 → 结算完成后再点「完成任务」关单。
   */
  async receiptFinish() {
    if (this.data.submitting) return;
    const confirmRes = await dialog.show(this, {
      title: '确认收货',
      content: '请确认您已实际收到物品。确认后进度进入「待支付」，请与跑腿员线下转账结算酬金，结算完成后再点「完成任务」关闭订单。',
      confirmText: '确认收货'
    });
    if (!confirmRes || !confirmRes.confirm) return;

    this.setData({ submitting: true });
    try {
      const res = await post('/api/task/receiptFinish', { taskId: this.data.taskId });
      wx.showToast({ title: res.msg || '已确认收货', icon: 'none' });
      this.loadDetail();
    } catch (err) {
      showError(err);
      this.loadDetail();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 打开「确认取货」弹窗
   * 「取消」随时可点；「确定」要等 3 秒倒计时结束才可点（防误触：一旦确认照片即锁定）。
   */
  openPickupModal() {
    if (!this.data.pickupImages.length) {
      wx.showToast({ title: MSG.PICKUP_PHOTO_NEEDED, icon: 'none' });
      return;
    }
    this.setData({ showPickupModal: true, pickupCountdown: 3, pickupDisabled: true });
    if (this.pickupTimer) clearInterval(this.pickupTimer);
    this.pickupTimer = setInterval(() => {
      const next = this.data.pickupCountdown - 1;
      if (next <= 0) {
        clearInterval(this.pickupTimer);
        this.pickupTimer = null;
        this.setData({ pickupCountdown: 0, pickupDisabled: false });
      } else {
        this.setData({ pickupCountdown: next, pickupDisabled: true });
      }
    }, 1000);
  },

  /** 关闭「确认取货」弹窗并重置倒计时 */
  closePickupModal() {
    if (this.pickupTimer) clearInterval(this.pickupTimer);
    this.pickupTimer = null;
    this.setData({ showPickupModal: false, pickupCountdown: 3, pickupDisabled: true });
  },

  /**
   * 接单人确认取货：物品照片落库并锁定（进度第 1 段 → 第 2 段）
   * 后端 /api/task/confirmPickup 写入 pickup_img1~3 + pickup_confirm_time，
   * 之后：照片不可再改、接单人不能再取消接单、雇主不能再撤销任务。
   */
  async doConfirmPickup() {
    if (this.data.pickupDisabled) return;
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    // 征求一次订阅授权：授权后「任务已完成」时接单者能收到微信通知
    await subscribe.requestOrderSubscribe('确认取货');
    try {
      const res = await post('/api/task/confirmPickup', {
        taskId: this.data.taskId,
        pickupImages: this.data.pickupImages
      });
      this.closePickupModal();
      wx.showToast({ title: res.msg || '已确认取货', icon: 'none' });
      // 本地草稿清空：锁定后展示的是服务端那份已落库的照片
      this.setData({ pickupImages: [], pickupImageUrls: [], canSubmitPhotos: false });
      this.loadDetail();
    } catch (err) {
      this.closePickupModal();
      showError(err);
      this.loadDetail();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 打开「举报接单人」弹窗（仅雇主、且任务已被接单时入口可见） */
  openReportTakerModal() {
    const reportTakerTags = Object.keys(REPORT_TAKER_TAG).map((key) => ({
      value: Number(key),
      label: REPORT_TAKER_TAG[key],
      selected: false
    }));
    this.setData({
      showReportTakerModal: true,
      reportTakerTags,
      reportTakerText: '',
      canSubmitReportTaker: false
    });
  },

  /** 关闭举报接单人弹窗并重置状态 */
  closeReportTakerModal() {
    this.setData({
      showReportTakerModal: false,
      reportTakerTags: [],
      reportTakerText: '',
      canSubmitReportTaker: false
    });
  },

  /** 选择 / 取消选择举报原因（单选，与申诉 / 恶意超时投诉保持同一交互） */
  toggleReportTakerTag(e) {
    const value = Number(e.currentTarget.dataset.value);
    const reportTakerTags = this.data.reportTakerTags.map((item) => ({
      ...item,
      selected: item.value === value ? !item.selected : false
    }));
    this.applyReportTakerState(reportTakerTags, this.data.reportTakerText);
  },

  /** 补充说明输入 */
  onReportTakerInput(e) {
    this.applyReportTakerState(this.data.reportTakerTags, e.detail.value);
  },

  /**
   * 统一计算「举报接单人」弹窗的派生状态
   *  - 单选：恰好 1 个原因（与后端 REPORT_TAKER_TAG_NEEDED 一致）
   *  - 选中「其他」时补充说明不少于 5 个字（与后端 REPORT_TAKER_REASON_SHORT 一致）
   * @param {Array} reportTakerTags 标签列表
   * @param {string} reportTakerText 补充说明
   */
  applyReportTakerState(reportTakerTags, reportTakerText) {
    const selected = reportTakerTags.filter((item) => item.selected).map((item) => item.value);
    const needOther = selected.indexOf(REPORT_TAKER_TAG_OTHER) > -1;
    const text = String(reportTakerText || '').trim();
    const canSubmitReportTaker = selected.length > 0 && (!needOther || text.length >= 5);
    this.setData({ reportTakerTags, reportTakerText, canSubmitReportTaker });
  },

  /**
   * 提交「举报接单人」
   * 后端写入 report（report_type = 3）并给全部管理员账号推送站内消息，
   * 管理员在「管理员后台 - 举报管理」中按类型查看并核实。
   */
  async submitReportTaker() {
    if (!this.data.canSubmitReportTaker) {
      wx.showToast({ title: MSG.REPORT_TAKER_TAG_NEEDED, icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    const tags = this.data.reportTakerTags.filter((item) => item.selected).map((item) => item.value);
    this.setData({ submitting: true });
    try {
      const res = await post('/api/task/reportTaker', {
        taskId: this.data.taskId,
        tags,
        reason: String(this.data.reportTakerText || '').trim()
      });
      this.closeReportTakerModal();
      wx.showToast({ title: res.msg || '举报已提交', icon: 'none' });
      this.loadDetail();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  }
});
