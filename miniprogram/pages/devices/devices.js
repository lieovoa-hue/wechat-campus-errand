/**
 * 我的设备管理
 * =====================================================================
 * 作用：展示当前账号绑定的设备（微信 openid / 设备指纹），支持解绑非本机设备。
 * 规则：
 *  1. 本机（当前登录设备）不允许解绑，避免把自己锁在外面；
 *  2. 至少保留 1 台设备，否则任何设备登录都必须答密保；
 *  3. 常用设备登录免密保，新设备登录必须答对 2 道密保问题（后端强制，不可绕过）。
 *  4. 每台设备展示「登录地点（省-市）+ 登录 IP」，方便用户识别陌生设备并及时解绑。
 * =====================================================================
 */

const { get, post, showError } = require('../../utils/request');
const { formatTime } = require('../../utils/filter');
const { MSG } = require('../../utils/constant');
const dialog = require('../../utils/dialog');

const theme = require('../../utils/theme');
/**
 * 拼装「登录地点」展示文案
 * 例：某省-某市（IP 1.2.3.4）/ 只解析出归属地时只显示归属地 / 内网或解析失败时只显示 IP
 * @param {object} item 后端下发的设备对象
 * @returns {string}
 */
function buildLocationText(item) {
  const region = String((item && item.loginRegion) || '').trim();
  const ip = String((item && item.loginIp) || '').trim();
  if (region && ip) return `${region}（IP ${ip}）`;
  if (region) return region;
  if (ip) return ip;
  return MSG.KICK_NOTICE_UNKNOWN_REGION;
}

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    list: [],
    loading: true
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.loadList();
  },

  /** 拉取已绑定设备 */
  async loadList() {
    try {
      const res = await get('/api/user/devices');
      const raw = (res.data && res.data.list) || [];
      // wxml 不能调用函数，这里统一把时间格式化成可读文本
      const list = raw.map((item) => ({
        id: item.id,
        deviceName: item.deviceName,
        isCurrent: item.isCurrent,
        // 登录地点（省-市）与 IP：让用户一眼看出「这台设备是从哪里登录的」
        locationText: buildLocationText(item),
        lastLoginText: formatTime(item.lastLoginTime)
      }));
      this.setData({ list, loading: false });
    } catch (err) {
      this.setData({ loading: false });
      showError(err);
    }
  },

  /** 解绑设备（二次确认） */
  unbind(e) {
    const { id, name, current } = e.currentTarget.dataset;
    if (current) {
      wx.showToast({ title: '当前设备不可解绑', icon: 'none' });
      return;
    }
    dialog.show(this, {
      title: '解绑设备',
      content: `确定解绑「${name}」吗？解绑后该设备再次登录需要回答密保问题。`,
      confirmText: '确定',
      cancelText: '取消',
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        await post('/api/user/unbindDevice', { deviceRowId: id });
        wx.showToast({ title: '已解绑', icon: 'success' });
        this.loadList();
      } catch (err) {
        showError(err);
      }
    });
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
