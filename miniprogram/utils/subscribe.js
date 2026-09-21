/**
 * =====================================================================
 * 订阅消息授权（前端）
 * ---------------------------------------------------------------------
 * 为什么需要：
 *   任务进度变化时后端会下发微信「订阅消息」，但一次性订阅必须先由用户
 *   在小程序里点「允许」授权一次，后端才获得 1 次下发额度。
 *   因此这里在关键按钮（发布任务 / 接单 / 确认取货）上顺带征求一次授权。
 *
 * 设计约定：
 *   1. 只做「征求授权」这一件事，不依赖授权结果 —— 用户点了「拒绝」也照样继续业务流程；
 *   2. 任何异常（接口不存在 / 用户快速点击导致重复调用 / 未配置模板）全部静默吞掉，
 *      绝不让订阅授权阻塞或打断主流程；
 *   3. 模板 ID 与后端 .env 的 WX_SUBSCRIBE_ORDER_TEMPLATE 必须保持一致。
 * =====================================================================
 */

/** 「订单进度通知」模板 ID（与后端 .env 的 WX_SUBSCRIBE_ORDER_TEMPLATE 对应） */
const ORDER_TEMPLATE_ID = 'MysxROXLrTdJkbrUAOoAttVuHz8YD3gnNLCj5jKKG2Ak';

/**
 * 征求一次「订单进度通知」订阅授权
 * @param {string} [scene] 触发场景，仅用于日志排查
 * @returns {Promise<boolean>} 是否授权成功（业务方无需关心）
 */
function requestOrderSubscribe(scene) {
  return new Promise((resolve) => {
    if (!ORDER_TEMPLATE_ID) {
      resolve(false);
      return;
    }
    if (typeof wx === 'undefined' || typeof wx.requestSubscribeMessage !== 'function') {
      resolve(false);
      return;
    }
    try {
      wx.requestSubscribeMessage({
        tmplIds: [ORDER_TEMPLATE_ID],
        success: (res) => {
          const accepted = res && res[ORDER_TEMPLATE_ID] === 'accept';
          console.log('[订阅消息] 授权结果（' + (scene || '未标注') + '）：', accepted ? '已允许' : '未允许');
          resolve(accepted);
        },
        fail: (err) => {
          console.log('[订阅消息] 授权失败（' + (scene || '未标注') + '）：', err && err.errMsg);
          resolve(false);
        }
      });
    } catch (err) {
      console.log('[订阅消息] 授权异常：', err && err.message);
      resolve(false);
    }
  });
}

module.exports = {
  ORDER_TEMPLATE_ID,
  requestOrderSubscribe
};
