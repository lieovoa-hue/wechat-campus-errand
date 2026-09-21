/**
 * =====================================================================
 * 一键复制工具（全站统一出口）
 * ---------------------------------------------------------------------
 * 为什么单独抽一个文件：
 *   1) wx.setClipboardData 成功后微信会自动弹一个「内容已复制」的 toast，
 *      如果直接再弹自己的提示会出现两个 toast 叠在一起，这里统一先 hideToast 再提示；
 *   2) 复制成功 / 失败 / 内容为空三种情况的提示文案全站保持一致；
 *   3) 页面里只写 <view bindtap="copy" data-value="..." data-label="账号ID">，
 *      不需要每个页面各写一遍 setClipboardData。
 * =====================================================================
 */

/**
 * 复制文本到剪贴板
 * @param {string} text 要复制的内容
 * @param {string} [label] 内容名称（用于提示文案，如「账号ID」「邀请码」）
 * @returns {Promise<boolean>} 是否复制成功
 */
function copyText(text, label) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!value) {
    wx.showToast({ title: '没有可复制的内容', icon: 'none' });
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: value,
      success: () => {
        // 先收起微信默认的「内容已复制」提示，再显示带名称的提示，避免两个 toast 叠加
        wx.hideToast();
        wx.showToast({ title: `${label || '内容'}已复制`, icon: 'none' });
        resolve(true);
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请长按手动选择', icon: 'none' });
        resolve(false);
      }
    });
  });
}

/**
 * 事件绑定版本：从 dataset 里取 value / label
 * 用法：<view data-value="{{user.userIdText}}" data-label="账号ID" bindtap="copyFromEvent">…</view>
 * @param {object} e 事件对象
 * @returns {Promise<boolean>}
 */
function copyFromEvent(e) {
  const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
  return copyText(ds.value, ds.label);
}

module.exports = {
  copyText,
  copyFromEvent
};