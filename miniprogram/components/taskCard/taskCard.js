/**
 * =====================================================================
 * 任务卡片组件（任务大厅 / 我的发布 / 我的任务 共用）
 * ---------------------------------------------------------------------
 * 展示口径（与任务详情页保持一致）：
 *   1. 发布者：头像、昵称、账号ID、学号 + 认证标识
 *      管理员 -> 红色「管理员」标识；校园认证通过 -> 绿色「已认证」标识；其余不显示
 *   2. 任务核心信息：送达地址、限时（不限时则显示「不限时」）、跑腿费
 *      更详细的字段（收件人手机号、备注、图片、送达照片等）点进详情页再加载体
 *   3. 我的发布视角额外展示接单跑腿员的头像 / 昵称 / 账号ID / 学号 / 标识
 * =====================================================================
 */

const filter = require('../../utils/filter');
const preview = require('../../utils/preview');

Component({
  // 允许 app.wxss 的公共类（.sub / .row / .price / .tag-* 等）作用到组件内部，
  // 保证卡片与服务端页面的展示口径、配色完全一致
  options: {
    addGlobalClass: true
  },

  properties: {
    task: {
      type: Object,
      value: {}
    },
    // 列表视角：hall(任务大厅) / publish(我的发布) / take(我的任务)
    mode: {
      type: String,
      value: 'hall'
    }
  },

  data: {
    statusText: '',
    statusClass: 'tag',
    // 卡片左侧状态色条（与状态标签同色系）
    accentClass: 'accent-0',
    rewardText: '0.00',
    timeText: '',
    limitText: '',
    // 任务类型标签（取快递 / 食堂带饭 / 打印资料 / 超市代买 / 其他）与配色槽位
    typeText: '',
    typeClass: '',
    // 未送达申诉：true 时展示红色「已申诉」角标，并提示已停止自动确认收货
    isDisputed: false,
    disputeReason: '',
    // 发布者信息（头像 / 昵称 / 账号ID / 学号 / 认证标识）
    ownerPerson: null,
    // 接单者信息（仅在「我的发布」且已有人接单时展示）
    takerPerson: null
  },

  observers: {
    task(task) {
      if (!task || !task.id) return;
      this.refresh(task, this.data.mode);
    },
    // mode 可能异步变化，单独监听保证展示口径不会错位
    mode(mode) {
      if (!this.data.task || !this.data.task.id) return;
      this.refresh(this.data.task, mode);
    }
  },

  methods: {
    /**
     * 刷新卡片展示字段
     * @param {object} task 服务端下发的任务对象
     * @param {string} mode 列表视角
     */
    refresh(task, mode) {
      this.setData({
        statusText: filter.taskStatusText(task.status),
        statusClass: filter.taskStatusClass(task.status),
        accentClass: filter.taskAccentClass(task.status),
        rewardText: filter.price(task.reward),
        timeText: filter.fromNow(task.publishTime),
        // 限时直接显示时长文案（不限时为「不限时」）
        limitText: filter.timeLimitText(task.timeLimitMin),
        // 任务类型标签：后端已下发 taskTypeText，这里兜底本地字典，避免老接口数据缺字段
        typeText: task.taskTypeText || filter.taskTypeText(task.taskType),
        typeClass: filter.taskTypeClass(task.taskType),
        // 未送达申诉（雇主已反馈未送达 -> 该任务不再自动确认收货）
        isDisputed: task.isDisputed === true,
        disputeReason: task.disputeReason || '',
        ownerPerson: filter.personView({
          label: mode === 'publish' ? '雇主（我）' : '雇主',
          avatar: task.ownerAvatar,
          nickname: task.ownerNickname,
          userIdText: task.ownerUserIdText,
          studentId: task.ownerStudentId,
          isAdmin: task.ownerIsAdmin,
          isCertified: task.ownerIsCertified
        }),
        takerPerson: this.buildTaker(task, mode)
      });
    },

    /**
     * 构建接单跑腿员信息（我的发布视角 + 已有人接单时才展示）
     * @param {object} task 任务对象
     * @param {string} mode 列表视角
     * @returns {object|null}
     */
    buildTaker(task, mode) {
      if (mode !== 'publish' || !task.takerUserId) return null;
      return filter.personView({
        label: '跑腿员',
        avatar: task.takerAvatar,
        nickname: task.takerNickname,
        userIdText: task.takerUserIdText,
        studentId: task.takerStudentId,
        isAdmin: task.takerIsAdmin,
        isCertified: task.takerIsCertified
      });
    },

    /** 点击卡片进入任务详情（详细信息全部在详情页加载） */
    onTapCard() {
      const id = this.data.task && this.data.task.id;
      if (!id) return;
      wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${id}` });
    },

    /**
     * 点击发布者 / 接单者头像查看大图
     * 用 catchtap 而不是 bindtap：点的是头像，不应该顺带跳进任务详情
     */
    previewAvatar(e) {
      preview.previewImage(e.currentTarget.dataset.url);
    }
  }
});
