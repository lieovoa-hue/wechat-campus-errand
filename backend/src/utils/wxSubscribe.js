/**
 * =====================================================================
 * 微信小程序「订阅消息」下发
 * ---------------------------------------------------------------------
 * 用途：任务进度变化时，给用户手机推送一条微信服务通知（无需用户打开小程序）。
 *
 * 为什么用一次性订阅而不是长期订阅：
 *   个人主体只能申请一次性订阅模板。一次性订阅的规则是
 *   「用户每在 wx.requestSubscribeMessage 里勾选一次，就获得 1 次下发额度」，
 *   额度用完必须再次征求用户同意。因此前端在关键按钮（发布 / 接单 / 确认取货）
 *   上都会顺带征求一次授权，后端只负责把额度用掉。
 *
 * 失败处理（重要）：
 *   订阅消息是「锦上添花」，绝不能因为下发失败影响业务。
 *   未配置模板 / 用户没授权（43101）/ 微信侧异常，一律只写日志、静默降级，
 *   站内信（Message 表）始终是保底通道。
 *
 * 模板字段（「订单进度通知」，类目：信息查询）：
 *   订单编号 = {{character_string1.DATA}}   32 位以内数字字母
 *   当前状态 = {{phrase2.DATA}}             5 个以内纯汉字
 *   操作时间 = {{date3.DATA}}               形如 2026年09月20日 15:01
 *   操作提示 = {{thing4.DATA}}              20 字符以内
 *
 * 启用方式（.env）：
 *   WX_SUBSCRIBE_ORDER_TEMPLATE=模板ID
 *   WX_SUBSCRIBE_STATE=formal   # developer=开发版 / trial=体验版 / formal=正式版
 * =====================================================================
 */

const wxUtil = require('./wxUtil');
const wxSecCheck = require('./wxSecCheck');
const { log } = require('./common');

/** 「订单进度通知」模板 ID */
const TEMPLATE_ORDER = String(process.env.WX_SUBSCRIBE_ORDER_TEMPLATE || '').trim();
/** 下发时声明的小程序版本（必须与实际使用的版本一致，否则微信拒发） */
const MP_STATE = String(process.env.WX_SUBSCRIBE_STATE || 'formal').trim() || 'formal';

/**
 * 任务进度状态文案（模板 phrase2 只接受 5 个以内纯汉字，故全部压到 3 个字）
 */
const STATUS_TEXT = {
  TAKEN: '已接单',
  PICKED: '已取货',
  DELIVERED: '已送达',
  FINISHED: '已完成',
  CANCELED: '已取消'
};

/** 当前是否具备下发条件（模板未配置时整体跳过） */
function isConfigured() {
  return Boolean(TEMPLATE_ORDER) && wxUtil.isConfigured();
}

/** 按字符数截断（微信对 thing / phrase 字段有硬性长度限制，超长会整条拒发） */
function clip(text, max) {
  const str = String(text === undefined || text === null ? '' : text);
  return str.length > max ? str.slice(0, max) : str;
}

/** 格式化为微信要求的「2026年09月20日 15:01」 */
function formatTime(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 '
    + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * 下发一条「订单进度通知」
 * @param {object} params
 * @param {number} params.userId 接收人 users.id（内部自动解析 openid）
 * @param {string} params.status 进度状态，取 STATUS_TEXT 的键
 * @param {string} [params.orderNo] 订单号（无单号时退回任务编号）
 * @param {string} [params.tip] 操作提示（超过 20 字符自动截断）
 * @param {string} [params.page] 点击通知跳转的小程序页面
 * @returns {Promise<{sent:boolean, reason?:string}>} 永远不抛异常
 */
async function sendOrderProgress({ userId, status, orderNo, tip, page }) {
  try {
    if (!isConfigured()) return { sent: false, reason: '未配置订阅消息模板' };
    const uid = Number(userId) || 0;
    if (!uid) return { sent: false, reason: '缺少接收人' };

    // openid 与 access_token 都直接复用内容安全模块的缓存实现，避免重复请求微信接口
    const openid = await wxSecCheck.resolveOpenid({ id: uid });
    if (!openid) return { sent: false, reason: '该用户没有 openid（未走过微信登录）' };

    const token = await wxSecCheck.getAccessToken();
    if (!token) return { sent: false, reason: 'access_token 不可用' };

    const orderText = String(orderNo || '').replace(/[^0-9A-Za-z]/g, '') || String(uid);
    const payload = {
      touser: openid,
      template_id: TEMPLATE_ORDER,
      page: page || 'pages/myPublish/myPublish',
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      data: {
        character_string1: { value: clip(orderText, 32) },
        phrase2: { value: STATUS_TEXT[status] || '已更新' },
        date3: { value: formatTime(new Date()) },
        thing4: { value: clip(tip || '点击查看任务详情', 20) }
      }
    };

    const body = await wxUtil.postJson(
      '/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(token),
      payload
    );
    if (!body) return { sent: false, reason: '微信接口无响应' };

    if (body.errcode === 0) return { sent: true };

    // 43101：用户未订阅 / 额度已用完。属于正常业务态，不当成故障刷错误日志
    if (body.errcode === 43101) {
      log('info', '订阅消息未下发：用户未订阅或订阅额度已用完（userId=' + uid + '）');
      return { sent: false, reason: '用户未订阅' };
    }
    // 40001 / 42001：token 过期，下次调用会自动重新获取
    log('warn', '订阅消息下发失败：errcode=' + body.errcode + ' errmsg=' + (body.errmsg || ''));
    return { sent: false, reason: 'errcode=' + body.errcode };
  } catch (err) {
    log('warn', '订阅消息下发异常：', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  isConfigured,
  sendOrderProgress,
  STATUS_TEXT,
  TEMPLATE_ORDER
};
