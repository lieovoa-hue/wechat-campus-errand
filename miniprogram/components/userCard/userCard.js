/**
 * =====================================================================
 * 用户 mini 卡片组件（全站统一的「人」展示样式）
 * ---------------------------------------------------------------------
 * 用途：任务列表、任务详情、管理员举报/审核列表等任何需要展示某个用户的场景。
 * 展示口径（全站一致，禁止各页面自己拼）：
 *   头像 + 角色标签（雇主/跑腿员/举报人…）+ 昵称 + 身份标识 + 账号ID + 学号
 * 交互：
 *   clickable = true 时整卡可点击，点击后向父页面抛出 usertap 事件（由父页面决定是
 *   查看用户详情、发消息还是其它行为），并提供 --hover 按压反馈。
 *   person.showPhone = true 时卡片内多一行「手机号 + 拨打」，号码由页面按权限决定是否下发
 *   （任务详情里只有雇主 / 接单人这一对双方能看到），点击拨打抛出 call 事件。
 * =====================================================================
 */

const preview = require('../../utils/preview');

Component({
  // 允许 app.wxss 的公共类（.tag-* / .ellipsis 等）作用到组件内部，
  // 保证「用户卡片」与页面上的标签配色、标识口径完全一致
  options: {
    addGlobalClass: true
  },

  properties: {
    // 由页面用 filter.personView() 构建，字段见 utils/filter.js
    person: {
      type: Object,
      value: null
    },
    // 是否可点击（可点击时右侧显示箭头 + 按压动效）
    clickable: {
      type: Boolean,
      value: false
    },
    // 是否展示「学号」一行（列表页空间紧张时可以关掉）
    showStudentId: {
      type: Boolean,
      value: true
    }
  },

  methods: {
    /** 点击整卡：把 person 抛给父页面处理 */
    onTap() {
      if (!this.data.clickable || !this.data.person) return;
      this.triggerEvent('usertap', this.data.person);
    },

    /**
     * 点击头像查看大图
     * 头像在卡片里只有几十 rpx，「想看清是谁」时只能靠大图；
     * 没上传头像时 previewImage 直接返回，不会弹出空白预览。
     */
    previewAvatar() {
      const person = this.data.person || {};
      preview.previewImage(person.avatarUrl);
    },

    /**
     * 点击「拨打」
     * 拨号是系统能力，交给父页面统一处理（用 catchtap 拦住冒泡，避免同时触发整卡的 usertap）：
     * 只有绑定了 call 事件的页面（任务详情）才会展示按钮，其它页面 person 里没有号码，这一行不渲染。
     */
    onCall() {
      const phone = (this.data.person || {}).phone || '';
      this.triggerEvent('call', { phone });
    }
  }
});
