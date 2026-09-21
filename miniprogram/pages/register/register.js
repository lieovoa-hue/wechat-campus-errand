/**
 * =====================================================================
 * 注册页（只负责注册）
 * ---------------------------------------------------------------------
 * 与登录页拆开后的职责边界：
 *   本页只做「注册」一件事，注册成功直接进入「设置密保」流程；
 *   登录、忘记密码分别由 pages/login、pages/forgot 承担。
 * 注册规则（与后端逐条对齐，前端只做提前拦截，最终判定仍在服务端）：
 *   · 账号ID：前缀固定 X，后缀 1~4 位数字，可点「随机生成」拿一个未被占用的；
 *   · 密码：8-20 位且同时包含字母和数字（弱密码后端同样会拒）；
 *   · 图形验证码：本地生成、零成本，5 分钟有效、用后即废；
 *   · 手机号 / 昵称 / 邀请码：默认收在「更多」折叠区里，展开后才显示（全部选填）；
 *     · 手机号：填了必须是合法 11 位号码（后续校园认证会校验真实性）；
 *   · 昵称 / 邀请码：选填；邀请码有效则赠送 1 次快递免费代拿（7 天内有效）；
 *   · 协议：必须勾选同意《用户服务协议》与《隐私政策》（登录页同样要求）。
 * =====================================================================
 */

const { get, post, showError } = require('../../utils/request');
const { AGREEMENTS } = require('../../utils/agreement');
const { BIZ, MSG, ACCOUNT_NO_RULE } = require('../../utils/constant');

const theme = require('../../utils/theme');
const app = getApp();

/** 轻提示（统一 2 秒、无图标，避免遮挡输入框） */
function toast(title) {
  wx.showToast({ title, icon: 'none', duration: 2000 });
}

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    // ---------------- 表单字段 ----------------
    accountNo: '',
    accountTip: '',
    // 提示类型：'ok' 绿色（ID 可用）/ 'error' 红色（已占用或格式错）
    accountTipType: '',
    regPassword: '',
    regPassword2: '',
    phone: '',
    nickname: '',
    inviteCode: '',
    showPassword: false,
    // ---------------- 更多资料（手机号 / 昵称 / 邀请码） ----------------
    // 默认收起：注册首屏只留必填项。收起只是隐藏节点，值都在 data 里，
    // 所以展开填好再收起不会丢，重新展开内容仍在；展开状态不记忆。
    showMore: false,
    // 收起时显示「已填 N 项」：只统计填写且格式正确的项（填错 / 没填都不计入）
    moreFilledCount: 0,

    // ---------------- 图形验证码 ----------------
    captcha: { captchaId: '', image: '', expireMinutes: 0 },
    captchaCode: '',

    // ---------------- 用户协议与隐私政策 ----------------
    agreed: false,
    showAgreement: false,
    agreementTitle: '',
    agreementParagraphs: [],

    // 页面固定文案全部取自字典，禁止在 wxml 里硬编码中文
    accountPrefix: ACCOUNT_NO_RULE.NORMAL_PREFIX,
    accountNoPlaceholder: '如 ' + ACCOUNT_NO_RULE.NORMAL_PREFIX + '0001',
    submitting: false
  },

  onLoad() {
    // 进入页面先预取一张验证码（失败不阻断，用户可点图片重试）
    this.refreshCaptcha();
  },

  /** 通用输入绑定 */
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = { [field]: e.detail.value };
    // 账号ID 一改，上一次的「已被占用」红字立即失效，等下次失焦再重新校验
    if (field === 'accountNo' && this.data.accountTip) patch.accountTip = '';
    this.setData(patch);
    // 「更多」里任一字段变化都要重算「已填 N 项」的角标
    if (field === 'phone' || field === 'nickname' || field === 'inviteCode') this.countMoreFilled();
  },

  /** 密码明文 / 掩码切换 */
  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  /** 展开 / 收起「更多资料」（手机号 / 昵称 / 邀请码） */
  toggleMore() {
    this.setData({ showMore: !this.data.showMore });
    // 收起时同步刷新一次角标，展开时不需要（内容就在眼前）
    if (!this.data.showMore) this.countMoreFilled();
  },

  /**
   * 统计「更多」里已正确填写的项数（收起后的「已填 N 项」角标用）
   * 口径与 doRegister 的前置校验一致，填错或没填都不计入：
   *   · 手机号：合法 11 位号码；
   *   · 昵称：去空格后非空；
   *   · 邀请码：8 位字母数字（后端 generateInviteCode 生成的格式，
   *     是否真实存在只有提交时由服务端判定，这里只做格式有效性）。
   */
  countMoreFilled() {
    const { phone, nickname, inviteCode } = this.data;
    let count = 0;
    if (/^1[3-9]\d{9}$/.test(String(phone || '').trim())) count += 1;
    if (String(nickname || '').trim()) count += 1;
    if (/^[A-Za-z0-9]{8}$/.test(String(inviteCode || '').trim())) count += 1;
    this.setData({ moreFilledCount: count });
  },

  /** 切换「我已阅读并同意」勾选状态 */
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 打开《用户服务协议》/《隐私政策》阅读弹窗 */
  openAgreement(e) {
    const doc = AGREEMENTS[e.currentTarget.dataset.type];
    if (!doc) return;
    this.setData({
      showAgreement: true,
      agreementTitle: doc.title,
      agreementParagraphs: doc.paragraphs
    });
  },

  closeAgreement() {
    this.setData({ showAgreement: false });
  },

  /** 空方法：弹窗内容区的 catchtap 用，只拦截冒泡、不做任何事 */
  noop() {},

  /**
   * 获取图形验证码（本地生成，零成本）
   * 返回的 image 是以 data:image 开头的字符串，可直接给 image 组件渲染
   */
  async refreshCaptcha() {
    try {
      const res = await get('/api/user/captcha', {}, { auth: false });
      this.setData({ captcha: res.data, captchaCode: '' });
    } catch (err) {
      console.warn('[captcha] 获取失败：', (err && err.message) || '');
    }
  },

  /** 随机生成一个未被占用的账号ID（前缀固定 X） */
  async randomAccountNo() {
    try {
      const res = await get('/api/user/randomAccountNo', {}, { auth: false });
      this.setData({
        accountNo: res.data.accountNo,
        accountTip: MSG.ACCOUNT_NO_AVAILABLE,
        accountTipType: 'ok'
      });
      toast('已生成可用账号ID：' + res.data.accountNo);
    } catch (err) {
      showError(err);
    }
  },

  /** 账号ID 失焦校验（可注册 / 已被占用 / 格式错误） */
  async checkAccountNo() {
    const accountNo = String(this.data.accountNo || '').trim();
    if (!accountNo) return;
    try {
      const res = await post('/api/user/checkAccountNo', { accountNo }, { auth: false });
      // 校验期间用户又改了输入或点了「随机生成」：丢弃这次旧结果，免得盖到新值上
      if (String(this.data.accountNo || '').trim() !== accountNo) return;
      if (res.data.available) {
        // 后端会把 x1 / X01 规范化成 X0001，这里同步回显，避免用户以为填错了
        this.setData({
          accountNo: res.data.accountNo,
          accountTip: MSG.ACCOUNT_NO_AVAILABLE,
          accountTipType: 'ok'
        });
      } else {
        this.setData({ accountTip: MSG.ACCOUNT_NO_TAKEN, accountTipType: 'error' });
      }
    } catch (err) {
      this.setData({
        accountTip: (err && err.message) || MSG.ACCOUNT_NO_INVALID,
        accountTipType: 'error'
      });
    }
  },

  /** 回登录页 */
  goLogin() {
    const pages = getCurrentPages();
    // 从登录页跳进来的：直接返回上一页，避免堆出「登录 → 注册 → 登录」的长栈
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  /** 注册（成功后直接进入「设置密保」，未设密保前其它接口一律 428） */
  async doRegister() {
    const {
      accountNo, regPassword, regPassword2, phone, nickname, inviteCode,
      captchaCode, agreed, captcha
    } = this.data;

    if (!accountNo || !regPassword || !regPassword2) {
      toast('请填写账号ID和密码');
      return;
    }
    if (!captchaCode) {
      toast(MSG.CAPTCHA_REQUIRED);
      return;
    }
    if (regPassword !== regPassword2) {
      toast('两次输入的密码不一致');
      return;
    }
    // 与后端同口径的密码强度校验：8-20 位且同时包含字母和数字
    const weakLength = regPassword.length < BIZ.PASSWORD_MIN_LEN || regPassword.length > BIZ.PASSWORD_MAX_LEN;
    if (weakLength || !/[A-Za-z]/.test(regPassword) || !/[0-9]/.test(regPassword)) {
      toast(MSG.PASSWORD_TOO_WEAK);
      return;
    }
    // 手机号选填：填了就必须是合法的 11 位手机号
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      toast(MSG.PHONE_INVALID);
      return;
    }
    // 注册必须勾选同意《用户服务协议》与《隐私政策》
    if (!agreed) {
      toast(MSG.NEED_PROTOCOL_AGREE);
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      const device = await app.getDevicePayload();
      const res = await post('/api/user/register', {
        accountNo,
        password: regPassword,
        phone,
        nickname,
        inviteCode,
        captchaId: captcha.captchaId,
        captchaCode,
        agreeProtocol: true,
        ...device
      }, { auth: false });

      app.saveLogin(res.data);
      // 注册成功即登录，但必须先设置密保问题才能使用小程序
      wx.redirectTo({ url: '/pages/securitySetup/securitySetup?from=register' });
    } catch (err) {
      showError(err);
      // 注册失败（例如账号ID被抢注 / 验证码过期）后立刻换一张新验证码
      this.refreshCaptcha();
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 主题校准
   * ------------------------------------------------------------------
   * 本页原本没有 onShow，这个钩子只为主题同步而存在：
   * 从后台切回来、或用户刚在首页拨过开关时，把页面主题重新对齐一次。
   */
  onShow() {
    theme.sync(this);
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
