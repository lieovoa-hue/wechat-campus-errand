/**
 * =====================================================================
 * 统一确认弹窗调用入口
 * ---------------------------------------------------------------------
 * 用法：const dialog = require('../../utils/dialog');
 *   dialog.show(this, { title: '删除订单', content: '确认删除？', confirmText: '删除', danger: true })
 *     .then((res) => { if (!res.confirm) return; ... });
 * 说明：
 *   · 页面需在 wxml 里放 <confirm-dialog id="confirmDialog" /> 并注册组件；
 *   · 组件取不到时自动回退到原生 wx.showModal，保证功能不中断
 *     （极端情况：页面没挂组件、或工具类里拿不到页面实例）；
 *   · res 结构与 wx.showModal 的 success 回调一致：{ confirm, cancel }。
 * =====================================================================
 */

/** 页面上的弹窗组件 id（各页面统一用 confirmDialog） */
const COMPONENT_ID = '#confirmDialog';

/**
 * 弹出确认框
 * @param {object} page 页面实例（this）；传空则自动取当前页面栈顶页面
 * @param {object} options { title, content, confirmText, cancelText, showCancel, danger }
 * @returns {Promise<{confirm:boolean, cancel:boolean}>}
 */
function show(page, options) {
  const opts = options || {};
  const target = page || currentPage();
  const comp = target && typeof target.selectComponent === 'function'
    ? target.selectComponent(COMPONENT_ID)
    : null;

  if (comp && typeof comp.open === 'function') {
    return comp.open(opts);
  }

  // 兜底：原生弹窗（浅色主题下与自绘观感一致；深色下颜色跟随系统）
  return new Promise((resolve) => {
    wx.showModal(Object.assign({}, opts, {
      success: (res) => resolve({ confirm: Boolean(res.confirm), cancel: Boolean(res.cancel) }),
      fail: () => resolve({ confirm: false, cancel: true })
    }));
  });
}

/** 取当前页面栈顶页面（工具类里没有 this 时使用） */
function currentPage() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  return pages.length ? pages[pages.length - 1] : null;
}

module.exports = { show };
