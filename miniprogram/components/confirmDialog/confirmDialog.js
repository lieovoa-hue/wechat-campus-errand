/**
 * =====================================================================
 * 统一确认弹窗（自绘，深色自适应）
 * ---------------------------------------------------------------------
 * 为什么自绘：微信原生 wx.showModal 的配色只跟随「系统」深浅色，
 *   不跟随小程序内手动切换的深色开关，手动切深色时弹窗仍是浅色，观感割裂。
 * 用法：
 *   1) 页面 wxml 根节点内放 <confirm-dialog id="confirmDialog" />；
 *   2) 页面 json 的 usingComponents 注册 "confirm-dialog"；
 *   3) js：const dialog = require('../../utils/dialog');
 *      dialog.show(this, { title, content, confirmText, danger }).then((res) => {
 *        if (!res.confirm) return;   // res 结构与 wx.showModal 的 success 回调一致
 *      });
 * 说明：不带输入框（输入型弹窗仍用原生 wx.showModal 的 editable，见管理员后台）。
 * =====================================================================
 */

const { MSG } = require('../../utils/constant');

Component({
  data: {
    visible: false,
    title: '',
    content: '',
    confirmText: '',
    cancelText: '',
    showCancel: true,
    danger: false
  },

  lifetimes: {
    detached() {
      // 页面销毁时把挂起的 Promise 收掉，避免调用方永远等不到结果
      if (this._resolver) {
        const resolve = this._resolver;
        this._resolver = null;
        resolve({ confirm: false, cancel: true });
      }
    }
  },

  methods: {
    /**
     * 打开弹窗
     * @param {object} options { title, content, confirmText, cancelText, showCancel, danger }
     * @returns {Promise<{confirm:boolean, cancel:boolean}>}
     */
    open(options) {
      const opts = options || {};
      // 上一次还没关闭就被再次调用：旧的按「取消」结掉，保证调用方不会被挂住
      if (this._resolver) {
        const prev = this._resolver;
        this._resolver = null;
        prev({ confirm: false, cancel: true });
      }
      return new Promise((resolve) => {
        this._resolver = resolve;
        this.setData({
          visible: true,
          title: opts.title || '',
          content: opts.content || '',
          confirmText: opts.confirmText || MSG.DIALOG_CONFIRM,
          cancelText: opts.cancelText || MSG.DIALOG_CANCEL,
          showCancel: opts.showCancel !== false,
          danger: Boolean(opts.danger)
        });
      });
    },

    onConfirm() {
      this.close({ confirm: true, cancel: false });
    },

    onCancel() {
      this.close({ confirm: false, cancel: true });
    },

    /** 关闭并回调调用方 */
    close(res) {
      const resolve = this._resolver;
      this._resolver = null;
      this.setData({ visible: false });
      if (resolve) resolve(res);
    },

    /** 空方法：拦截遮罩与内容区的冒泡（点内容区不关闭） */
    noop() {}
  }
});
