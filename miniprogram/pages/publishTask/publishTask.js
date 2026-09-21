/**
 * 发布任务
 * 流程：填写表单 -> 创建订单 -> 支付信息服务费（0.1元）-> 支付成功后任务上架
 * 说明：
 *   1) PAY_SIMULATE=true 时后端直接标记支付成功；false 时唤起微信支付并等待回调
 *   2) 使用邀请码注册的用户可获赠「7 天内 1 次快递免费代拿」权益，
 *      点击「取快递」快捷模板即自动使用该权益（本次免缴 0.1 元平台信息服务费，仅限一件包裹）
 *   3) 表单必填项：收件人姓名、收件人手机号、送达地址、酬金、照片，缺一不可
 */

const { post, get, chooseAndUpload, showError, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const filter = require('../../utils/filter');
const { BIZ, MSG, TASK_TYPE_ENUM } = require('../../utils/constant');
const dialog = require('../../utils/dialog');
const subscribe = require('../../utils/subscribe');

const theme = require('../../utils/theme');
const app = getApp();

/** 「取快递」模板标识：点击该模板会自动使用免费代拿权益 */
const FREE_TEMPLATE_KEY = 'express';

/**
 * 预设模板，一键填充常用场景
 * 说明：送达地址统一使用宿舍楼格式「X栋X楼AXXX/BXXX」，
 *      用户点击模板后只需把 X 换成真实楼栋 / 房间号即可，避免每次手打整段地址。
 *      key='express' 的「取快递」模板额外支持「免费代拿次数」角标与自动使用权益。
 *      icon / meta 只用于前端展示（CSS 图标名 + 预置酬金限时摘要），不参与后端请求。
 */
const TEMPLATES = [
  {
    key: 'express',
    name: '取快递',
    taskType: TASK_TYPE_ENUM.EXPRESS,
    img: '/images/tpl/express.png',
    meta: '限时60 · ¥0.8',
    deliverAddress: 'X栋X楼AXXX/BXXX',
    remark: '帮我拿快递，尽快谢谢！',
    reward: '0.8',
    timeLimitMin: '60',
    // 取快递：取件码必填（跑腿员凭码取件），帮带物品可选填（写明是什么包裹更方便找）
    tip: '当前模板「取快递」：跑腿员凭取件码取件，请填写',
    itemPlaceholder: '选填，如 一个中通快递（小件）'
  },
  {
    key: 'meal',
    name: '食堂带饭',
    taskType: TASK_TYPE_ENUM.MEAL,
    img: '/images/tpl/meal.png',
    meta: '限时40 · ¥1',
    deliverAddress: 'X栋X楼AXXX/BXXX',
    remark: '义父，感激不尽！',
    reward: '1',
    timeLimitMin: '40',
    tip: '当前模板「食堂带饭」：请写清要帮带的物品',
    itemPlaceholder: '必填，如 一份黄焖鸡米饭，不要香菜'
  },
  {
    key: 'print',
    name: '打印资料',
    taskType: TASK_TYPE_ENUM.PRINT,
    img: '/images/tpl/print.png',
    meta: '限时60 · ¥3',
    deliverAddress: 'X栋X楼AXXX/BXXX',
    remark: '加急，非常感谢！',
    reward: '3',
    timeLimitMin: '60',
    tip: '当前模板「打印资料」：请写清要帮带的资料',
    itemPlaceholder: '必填，如 一份实验报告（A4 双面黑白）'
  },
  {
    key: 'market',
    name: '超市代买',
    taskType: TASK_TYPE_ENUM.MARKET,
    img: '/images/tpl/market.png',
    meta: '限时60 · ¥3',
    deliverAddress: 'X栋X楼AXXX/BXXX',
    remark: '有事抽不开身，帮忙买一下！',
    reward: '3',
    timeLimitMin: '60',
    tip: '当前模板「超市代买」：请写清要代买的商品',
    itemPlaceholder: '必填，如 一瓶矿泉水 + 一包纸巾'
  }
];

/** 信息服务费展示文案（口径来自 constant.js 的 BIZ.SERVICE_FEE，禁止硬编码） */
const SERVICE_FEE_TEXT = Number(BIZ.SERVICE_FEE).toFixed(2);

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    form: {
      receiverName: '',
      receiverPhone: '',
      // 任务类型（快捷模板）：决定「取件码 / 帮带物品」哪个必填，0=其他（两项都选填）
      taskType: TASK_TYPE_ENUM.OTHER,
      // 取件码：取快递模板下必填，其余模板选填；仅雇主与接单者可见
      pickupCode: '',
      // 帮带物品：带饭 / 打印 / 代买模板下必填，取快递模板选填
      itemName: '',
      deliverAddress: '',
      // 详细地址（选填）：对送达地址的补充说明
      detailAddress: '',
      timeLimitMin: '',
      remark: '',
      // 酬金默认 0.8 元；可下调，但不能低于 0.5 元（REWARD_MIN）
      reward: Number(BIZ.REWARD_DEFAULT).toFixed(1)
    },
    images: [],
    imageUrls: [],
    templates: TEMPLATES,
    // 当前选中的快捷模板 key（仅用于胶囊高亮，不参与提交）
    activeTpl: '',
    serviceFee: SERVICE_FEE_TEXT,
    // 发布券余额（撤销任务返还，发布时自动抵扣 0.1 元信息服务费），与后端 toSafeUser 字段同名
    publishCouponCount: 0,
    // 本单是否将用发布券抵扣（有券就自动用，无需用户勾选）
    useCoupon: false,
    // 长度上限：统一取自 constant.js 的 BIZ，保证与后端校验口径完全一致
    pickupCodeMax: BIZ.PICKUP_CODE_MAX,
    itemNameMax: BIZ.ITEM_NAME_MAX,
    detailAddressMax: BIZ.DETAIL_ADDRESS_MAX,
    // ---------------- 任务类型联动（切换模板只改标签 / 星号 / placeholder，字段顺序固定不跳版） ----------------
    pickupCodeRequired: false,
    itemNameRequired: false,
    pickupCodePlaceholder: '选填，如 6-8-1234',
    itemNamePlaceholder: '选填，如 一个中通快递（小件）',
    fieldTip: '',
    // 本次发布实际应付金额：使用免费代拿权益时为 0.00
    payFee: SERVICE_FEE_TEXT,
    // ---------------- 邀请码免费代拿权益 ----------------
    freeDeliveryCount: 0,       // 剩余免费代拿次数
    freeDeliveryAvailable: false, // 当前是否真的有可用权益（含有效期判定）
    useFreeDelivery: false,     // 本次发布是否使用免费代拿权益
    submitting: false
  },

  onLoad(options) {
    // 首页金刚区跳转过来时带上 ?tpl=express 之类的模板 key，进入后自动预填表单
    this.pendingTpl = (options && options.tpl) || '';
    // 首帧就按当前任务类型把「取件码 / 帮带物品」的必填标识与提示语算好
    this.syncTaskTypeFields();
    // 必须登录且校园认证通过（前端提示，后端强制校验）
    if (!app.checkLogin()) return;
    const user = app.globalData.userInfo;
    if (!user || user.isCampusAudit !== 2) {
      dialog.show(this, {
        title: '需要校园认证',
        content: '发布任务前请先完成校园认证。',
        confirmText: '去认证'
      }).then((res) => {
        if (res.confirm) wx.redirectTo({ url: '/pages/campusCert/campusCert' });
      });
    }
  },

  /** 每次进入页面都重新拉取用户信息，避免免费次数展示过期数据 */
  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.refreshFreeDelivery();
  },

  /**
   * 刷新「免费代拿」权益状态
   * 数据来源：GET /api/user/info（后端 toSafeUser 下发 freeDeliveryCount / freeDeliveryAvailable）
   */
  async refreshFreeDelivery() {
    if (!app.isLogin()) return;
    const info = await app.refreshUserInfo();
    const user = (info && info.user) || app.globalData.userInfo || {};
    const count = user.freeDeliveryAvailable ? Number(user.freeDeliveryCount || 0) : 0;
    // 发布券余额：撤销任务返还，发布时自动抵扣（与免费代拿权益无关，两者可叠加优先级：权益 > 券 > 现金）
    const couponCount = Number(user.publishCouponCount || 0);
    this.setData({
      freeDeliveryCount: count,
      freeDeliveryAvailable: count > 0,
      publishCouponCount: couponCount
    });
    this.applyFeeView(count > 0 ? this.data.useFreeDelivery : false);
    // 带参进入时延后到此处再填模板：此时免费代拿次数已拿到，
    // 「取快递」模板才能正确勾上免费权益（否则会误判为 0 次）
    if (this.pendingTpl) {
      const key = this.pendingTpl;
      this.pendingTpl = '';
      this.applyTemplateByKey(key);
    }
  },

  /**
   * 计算并刷新「是否使用免费权益 / 本次应付金额」
   * @param {boolean} [useFree] 指定是否使用免费权益，缺省沿用当前状态
   * @returns {boolean} 最终是否使用免费权益
   */
  applyFeeView(useFree) {
    const available = this.data.freeDeliveryCount > 0;
    const free = (useFree === undefined ? this.data.useFreeDelivery : useFree) && available;
    // 抵扣优先级与后端 createOrder 完全一致：
    //   免费代拿权益 > 发布券 > 现金支付 0.1 元
    const coupon = !free && this.data.publishCouponCount > 0;
    this.setData({
      useFreeDelivery: free,
      useCoupon: coupon,
      payFee: (free || coupon) ? '0.00' : this.data.serviceFee
    });
    return free;
  },

  /** 主动取消使用免费代拿权益（本次按正常服务费发布，权益留到下次） */
  cancelFreeDelivery() {
    this.applyFeeView(false);
    wx.showToast({ title: '已取消使用免费代拿权益', icon: 'none' });
  },

  /** 通用输入 */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  /** 应用预设模板（发布页内点击模板按钮触发） */
  applyTemplate(e) {
    const index = e.currentTarget.dataset.index;
    const tpl = TEMPLATES[index];
    if (!tpl) return;
    this.applyTemplateByKey(tpl.key);
  },

  /**
   * 按模板 key 填充表单
   * 供两条入口共用：① 发布页内点击模板按钮；② 首页金刚区跳转 ?tpl=key 自动预填
   * @param {string} key TEMPLATES 中的模板 key（express / meal / print / market）
   */
  applyTemplateByKey(key) {
    const tpl = TEMPLATES.find((item) => item.key === key);
    if (!tpl) return;
    this.setData({
      activeTpl: tpl.key,
      'form.taskType': tpl.taskType,
      'form.deliverAddress': tpl.deliverAddress,
      'form.remark': tpl.remark,
      'form.reward': tpl.reward,
      'form.timeLimitMin': tpl.timeLimitMin
    });
    // 切换模板后立刻刷新「取件码 / 帮带物品」的必填标识与提示语
    this.syncTaskTypeFields();
    // 点击「取快递」模板即视为使用免费代拿权益（仍有可用次数时自动勾选，可手动取消）
    const useFree = tpl.key === FREE_TEMPLATE_KEY && this.data.freeDeliveryCount > 0;
    this.applyFeeView(useFree);
    if (useFree) {
      wx.showToast({ title: `本次发布将使用免费代拿权益（剩${this.data.freeDeliveryCount}次）`, icon: 'none' });
    }
  },

  /**
   * 按「任务类型」刷新取件码 / 帮带物品两项的必填标识、placeholder 与提示语
   * ------------------------------------------------------------------
   * 规则（与后端 normalizeTaskForm 完全一致，前端只是提前提示）：
   *   取快递(1)      -> 取件码必填
   *   带饭/打印/代买 -> 帮带物品必填
   *   其他/自定义(0) -> 两项都选填
   * 字段顺序永远固定（取件码在前、帮带物品在后），切换模板只改文案与星号，
   * 避免字段上下跳动导致用户填错位置。
   */
  syncTaskTypeFields() {
    const taskType = Number(this.data.form.taskType) || TASK_TYPE_ENUM.OTHER;
    const tpl = TEMPLATES.find((item) => item.taskType === taskType);
    const pickupCodeRequired = taskType === TASK_TYPE_ENUM.EXPRESS;
    const itemNameRequired = taskType !== TASK_TYPE_ENUM.EXPRESS && taskType !== TASK_TYPE_ENUM.OTHER;
    this.setData({
      pickupCodeRequired,
      itemNameRequired,
      pickupCodePlaceholder: pickupCodeRequired ? '必填，如 6-8-1234' : '选填，如 6-8-1234',
      itemNamePlaceholder: (tpl && tpl.itemPlaceholder) || '选填，如 一个中通快递（小件）',
      fieldTip: (tpl && tpl.tip) || ''
    });
  },

  /** 选择并上传图片（最多3张，单张2MB，仅 jpg/png/webp） */
  async chooseImage() {
    const rest = 3 - this.data.images.length;
    if (rest <= 0) {
      wx.showToast({ title: '最多上传3张图片', icon: 'none' });
      return;
    }
    try {
      const urls = await chooseAndUpload(rest);
      if (urls.length) {
        const images = this.data.images.concat(urls);
        this.setData({ images, imageUrls: filter.imageUrls(images) });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除图片 */
  removeImage(e) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images, imageUrls: filter.imageUrls(images) });
  },

  /** 预览图片 */
  previewImage(e) {
    const index = e.currentTarget.dataset.index;
    const urls = this.data.imageUrls;
    wx.previewImage({ current: urls[index], urls });
  },

  /**
   * 提交并支付
   * 必填校验（前端先拦一道，后端强制兜底）：收件人姓名、手机号、送达地址、酬金、照片
   */
  async submit() {
    const { form, images } = this.data;
    if (!String(form.receiverName || '').trim()) {
      wx.showToast({ title: '请填写收件人姓名', icon: 'none' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(String(form.receiverPhone || '').trim())) {
      wx.showToast({ title: '请填写正确的收件人手机号', icon: 'none' });
      return;
    }
    // 任务类型决定的必填项（与后端 normalizeTaskForm 同一口径，前端先拦一道）
    if (this.data.pickupCodeRequired && !String(form.pickupCode || '').trim()) {
      wx.showToast({ title: MSG.NEED_PICKUP_CODE, icon: 'none' });
      return;
    }
    if (this.data.itemNameRequired && !String(form.itemName || '').trim()) {
      wx.showToast({ title: MSG.NEED_ITEM_NAME, icon: 'none' });
      return;
    }
    if (String(form.itemName || '').trim().length > BIZ.ITEM_NAME_MAX) {
      wx.showToast({ title: MSG.ITEM_NAME_TOO_LONG, icon: 'none' });
      return;
    }
    if (!String(form.deliverAddress || '').trim()) {
      wx.showToast({ title: '请填写送达地址', icon: 'none' });
      return;
    }
    if (String(form.reward) === '' || String(form.reward) === undefined) {
      wx.showToast({ title: MSG.REWARD_FORMAT_ERROR, icon: 'none' });
      return;
    }
    const reward = Number(form.reward);
    if (!Number.isFinite(reward)) {
      wx.showToast({ title: MSG.REWARD_FORMAT_ERROR, icon: 'none' });
      return;
    }
    if (reward < BIZ.REWARD_MIN) {
      wx.showToast({ title: MSG.REWARD_TOO_LOW, icon: 'none' });
      return;
    }
    if (reward > BIZ.REWARD_MAX) {
      wx.showToast({ title: MSG.REWARD_TOO_HIGH, icon: 'none' });
      return;
    }
    if (!images.length) {
      wx.showToast({ title: MSG.NEED_TASK_IMAGE, icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    // 征求一次「订单进度通知」订阅授权（用户拒绝也照常发布，绝不阻塞主流程）
    await subscribe.requestOrderSubscribe('发布任务');

    try {
      const res = await post('/api/task/createOrder', {
        ...form,
        img1: images[0] || '',
        img2: images[1] || '',
        img3: images[2] || '',
        // 使用免费代拿权益时后端把服务费记为 0 元（事务内核销次数）
        useFreeDelivery: this.data.useFreeDelivery,
        // 正式支付模式需要 code 换取 openid；模拟模式可忽略
        code: await this.getWxCode()
      });
      const { paid, taskId, payParams, freeDelivery, couponUsed, payMode } = res.data;

      if (paid) {
        // 模拟支付模式 / 免费代拿单 / 发布券抵扣单：任务已直接上架
        const tip = couponUsed ? '发布券已抵扣，发布成功' : (freeDelivery ? '免费发布成功' : '发布成功');
        wx.showToast({ title: tip, icon: 'success' });
        // 发布成功后刷新权益状态（免费次数已被核销）
        this.refreshFreeDelivery();
        setTimeout(() => wx.switchTab({ url: '/pages/myPublish/myPublish' }), 800);
        return;
      }

      // 虚拟支付（个人主体 B 方案）：唤起微信虚拟支付收银台
      if (payMode === 'virtual') {
        this.invokeVirtualPay(payParams, taskId);
        return;
      }

      // 备用：微信支付 API v3
      this.invokeWxPay(payParams, taskId);
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 获取 wx.login 的 code（正式支付模式使用） */
  getWxCode() {
    return new Promise((resolve) => {
      wx.login({
        success: (res) => resolve(res.code || ''),
        fail: () => resolve('')
      });
    });
  },

  /**
   * 唤起微信支付
   * @param {object} payParams 后端返回的支付参数
   * @param {number} taskId 任务ID
   */
  invokeWxPay(payParams, taskId) {
    wx.requestPayment({
      timeStamp: payParams.timeStamp,
      nonceStr: payParams.nonceStr,
      package: payParams.package,
      signType: payParams.signType,
      paySign: payParams.paySign,
      success: () => {
        // 支付成功后轮询支付结果（回调可能存在延迟）
        this.pollPayStatus(taskId, 0);
      },
      fail: () => {
        wx.showToast({ title: '支付已取消，可在我的发布中继续支付', icon: 'none' });
      }
    });
  },

  /**
   * 唤起微信「虚拟支付」收银台（个人主体 B 方案）
   * ------------------------------------------------------------------
   * signData / paySig / signature 全部由后端生成，前端只负责原样透传：
   *   signData  拼接好的下单参数（JSON 字符串，不能自己重新序列化）
   *   paySig    商户侧签名（证明请求来自我们自己的后端）
   *   signature 用户态签名（证明是当前登录用户本人发起）
   * 支付成功后微信不会回调前端，而是服务端收到「发货推送」，因此这里同样轮询支付状态。
   * @param {object} payParams 后端返回的支付参数
   * @param {number} taskId 任务ID
   */
  invokeVirtualPay(payParams, taskId) {
    if (typeof wx.requestVirtualPayment !== 'function') {
      wx.showModal({
        title: '当前微信版本不支持',
        content: '虚拟支付需要较新版本的微信，请升级微信后重试。任务已保存，可在「我的发布」里继续支付。',
        showCancel: false
      });
      return;
    }
    wx.requestVirtualPayment({
      signData: payParams.signData,
      paySig: payParams.paySig,
      signature: payParams.signature,
      mode: payParams.mode || 'short_series_goods',
      success: () => {
        // 微信发货推送可能存在延迟，沿用普通支付的轮询逻辑
        this.pollPayStatus(taskId, 0);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        const cancelled = /cancel/i.test(msg);
        wx.showToast({
          title: cancelled ? '支付已取消，可在我的发布中继续支付' : '支付失败，请稍后重试',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 轮询支付状态（最多 5 次）
   */
  async pollPayStatus(taskId, times) {
    if (times >= 5) {
      wx.showToast({ title: '支付结果确认中，请稍后在我的发布查看', icon: 'none' });
      return;
    }
    try {
      const res = await get(`/api/pay/queryStatus/${taskId}`);
      if (res.data.paid) {
        wx.showToast({ title: '发布成功', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/myPublish/myPublish' }), 800);
        return;
      }
    } catch (err) {
      // 忽略轮询异常
    }
    setTimeout(() => this.pollPayStatus(taskId, times + 1), 1200);
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
