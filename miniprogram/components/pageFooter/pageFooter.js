/**
 * =====================================================================
 * 页面底部「官方 Q 群」提示组件
 * ---------------------------------------------------------------------
 * 【在哪里改群号】只需要改 miniprogram/utils/constant.js 里的 OFFICIAL_INFO.QQ_GROUP，
 *   全站所有页面底部的群号会同步生效，不需要逐个页面修改。
 * 用法：页面 json 里注册 "page-footer": "/components/pageFooter/pageFooter"，
 *      页面 wxml 底部写 <page-footer /> 即可。
 * 交互：点击群号数字即一键复制，不额外加「复制」按钮或提示文字。
 * =====================================================================
 */

const { OFFICIAL_INFO } = require('../../utils/constant');
const clipboard = require('../../utils/clipboard');

Component({
  data: {
    // 提示前缀文案
    tip: OFFICIAL_INFO.TIP,
    // 官方 QQ 群号（改 constant.js 即可）
    qqGroup: OFFICIAL_INFO.QQ_GROUP
  },

  methods: {
    /**
     * 点击群号一键复制
     * 走全站统一的 utils/clipboard，保证复制成功 / 失败的提示口径与账号ID、邀请码一致
     * @param {object} e 事件对象（data-value / data-label 由 wxml 传入）
     */
    copyGroup(e) {
      return clipboard.copyFromEvent(e);
    }
  }
});
