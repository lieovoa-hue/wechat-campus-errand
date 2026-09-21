/**
 * 编辑任务
 *  - 待接单任务（status=0）：全量字段可编辑，酬金仅可提高或不变
 *  - 进行中任务（status=1）：送达地址 / 限时 锁死，其余联系信息可更正，酬金仍只升不降
 *    （接单人已经按原地址、原限时在路上跑，中途改这两项等于让人白跑，后端也会拒绝）
 *  - 同一任务两次编辑/加酬金间隔至少 3 分钟（后端强校验）
 */

const { get, post, showError } = require('../../utils/request');
const { BIZ, MSG } = require('../../utils/constant');
const filter = require('../../utils/filter');

const theme = require('../../utils/theme');
Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    // 任务加载失败 / 参数缺失时的兜底文案（深色下不再露出一整张浅色空页）
    msgTaskNotFound: MSG.TASK_NOT_FOUND,
    taskId: 0,
    task: null,
    // true = 任务已被接单（部分字段锁定 + 酬金只加）
    takenMode: false,
    // true = 取快递（只能填「取件码」）；false = 其他类型（填「帮带物品」）
    isExpress: false,
    // 锁定态只读展示：限时文案 + 顶部说明条（都在 JS 里拼好，WXML 不做字符串拼接）
    timeLimitText: "",
    lockNoteText: "",
    // 选填项长度上限：统一取自 constant.js 的 BIZ，与后端校验口径一致
    itemNameMax: BIZ.ITEM_NAME_MAX,
    pickupCodeMax: BIZ.PICKUP_CODE_MAX,
    detailAddressMax: BIZ.DETAIL_ADDRESS_MAX,
    form: {
      receiverName: "",
      receiverPhone: "",
      pickupCode: "",
      itemName: "",
      deliverAddress: "",
      detailAddress: "",
      timeLimitMin: "",
      remark: "",
      reward: ""
    },
    submitting: false
  },

  onLoad(options) {
    this.setData({ taskId: Number(options.id || 0) });
    this.loadTask();
  },

  /** 加载任务并判断编辑模式 */
  async loadTask() {
    try {
      const res = await get(`/api/task/${this.data.taskId}`);
      const task = res.data.task;
      // 已被接单（进行中）：送达地址 / 限时锁定，其余字段仍可更正
      const takenMode = task.status === 1;
      // 取快递填取件码、其他类型填帮带物品（与发布页、后端 normalizeTaskForm 完全同一口径）
      const isExpress = Number(task.taskType) === 1;
      this.setData({
        task,
        takenMode,
        isExpress,
        timeLimitText: filter.timeLimitText(task.timeLimitMin),
        lockNoteText: "任务已被接单：「送达地址」与「限时」已锁定不可修改，酬金只能提高；"
          + `收件人姓名 / 电话、${isExpress ? "取件码" : "帮带物品"}、详细地址、备注仍可更正，`
          + "保存后会自动通知接单人。",
        form: {
          receiverName: task.receiverName,
          receiverPhone: task.receiverPhone,
          pickupCode: task.pickupCode || "",
          itemName: task.itemName || "",
          deliverAddress: task.deliverAddress,
          detailAddress: task.detailAddress || "",
          timeLimitMin: task.timeLimitMin || "",
          remark: task.remark || "",
          reward: String(task.reward)
        }
      });
    } catch (err) {
      showError(err);
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  /** 提交编辑 */
  async submit() {
    const { form, task, takenMode, isExpress } = this.data;
    if (this.data.submitting) return;

    const reward = Number(form.reward);
    if (!reward || reward <= 0) {
      wx.showToast({ title: "请输入正确的酬金", icon: "none" });
      return;
    }
    // 前端预校验：酬金只升不降（持平允许），口径与后端 /api/task/edit 的 REWARD_NO_DOWN 完全一致。
    // 注意：「必须高于原酬金」是「加酬金」接口的规则，编辑任务不适用，
    // 否则接单后想改电话 / 地址，也被迫先加钱。
    if (task && reward < Number(task.reward)) {
      wx.showToast({ title: MSG.REWARD_NO_DOWN, icon: "none" });
      return;
    }
    // 必填口径与发布页一致：取快递必须填取件码，其他类型必须填帮带物品
    if (isExpress && !String(form.pickupCode || "").trim()) {
      wx.showToast({ title: MSG.NEED_PICKUP_CODE, icon: "none" });
      return;
    }
    if (!isExpress && !String(form.itemName || "").trim()) {
      wx.showToast({ title: MSG.NEED_ITEM_NAME, icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    try {
      // 进行中只提交白名单字段：送达地址 / 限时 根本不发，避免被后端判定为「改锁定字段」
      const payload = takenMode ? {
        taskId: this.data.taskId,
        reward,
        receiverName: form.receiverName,
        receiverPhone: form.receiverPhone,
        pickupCode: form.pickupCode,
        itemName: form.itemName,
        detailAddress: form.detailAddress,
        remark: form.remark
      } : { taskId: this.data.taskId, ...form, reward };
      await post("/api/task/edit", payload);
      wx.showToast({ title: "修改成功", icon: "success" });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
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
