/**
 * 校园认证提交页
 *  - 4 项必填：真实姓名、真实学号、可联系手机号、校园身份截图
 *  - 7 天内最多提交 3 次；学号已被其他账号认证通过时会被直接驳回
 *  - 认证通过后解锁全部发布与接单权限
 */

const { get, post, chooseAndUpload, showError, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const filter = require('../../utils/filter');
const dialog = require('../../utils/dialog');
// 字典与业务常量（必须与后端 utils/constant.js 完全一致）：
// MSG.CAMPUS_APPLY_TIP 是「7天内仅限提交3次认证信息，你还可以提交{remain}次」文案模板，
// 数字（天数 / 次数上限）取自 BIZ，剩余次数取自后端返回，页面里不写死中文与数字
const { MSG, BIZ, formatText } = require('../../utils/constant');

const theme = require('../../utils/theme');
const app = getApp();

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    isCampusAudit: 0,
    statusText: '',
    rejectReason: '',
    form: { certName: '', certStudentId: '', certPhone: '' },
    certImg: '',
    certImgUrl: '',
    // 校园身份截图的上传示例图（智慧校园 ->「身份卡」），放在 miniprogram/images 下
    certGuideImg: '/images/campus-cert-guide.jpg',
    submitting: false
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    if (!app.isLogin()) return;
    this.loadStatus();
  },

  /**
   * 加载认证状态与最近一次申请记录
   * @param {boolean} preserveForm 是否保留当前表单内容
   *   提交成功后本页会先清空表单再刷新状态，此时必须传 true，
   *   否则账号资料（姓名 / 学号 / 已上传的认证截图）会把刚清空的表单重新回填
   */
  async loadStatus(preserveForm = false) {
    try {
      const info = await get('/api/user/info');
      const user = info.data.user;
      // 表单兜底回填：仅首次进入页面时用账号资料补全，避免用户重复输入
      const form = preserveForm ? this.data.form : {
        certName: this.data.form.certName || user.name || '',
        certStudentId: this.data.form.certStudentId || user.studentId || '',
        certPhone: this.data.form.certPhone || ''
      };
      const certImg = preserveForm
        ? this.data.certImg
        : (this.data.certImg || user.campusCertImg || '');
      this.setData({
        isCampusAudit: user.isCampusAudit,
        statusText: filter.campusAuditText(user.isCampusAudit),
        form,
        certImg,
        certImgUrl: filter.imageUrl(certImg)
      });

      // 读取最近一条校园认证申请，用于展示驳回原因
      const listRes = await get('/api/audit/myList', { page: 1, pageSize: 5, applyType: 3 });
      const latest = (listRes.data.list || [])[0];
      if (latest) {
        this.setData({
          rejectReason: latest.reject_reason || '',
          statusText: filter.auditStatusText(latest.status)
        });
      }
    } catch (err) {
      if (err.code !== 401) showError(err);
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  /** 上传校园身份截图 */
  async chooseCertImage() {
    try {
      const urls = await chooseAndUpload(1);
      if (urls.length) this.setData({ certImg: urls[0], certImgUrl: filter.imageUrl(urls[0]) });
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 删除已上传的截图，方便重新选择 */
  deleteCertImage() {
    this.setData({ certImg: '', certImgUrl: '' });
  },

  previewCertImage() {
    if (this.data.certImg) {
      wx.previewImage({ urls: [this.data.certImgUrl] });
    }
  },

  /** 预览「身份卡」示例图（点击放大，方便对照截图要求） */
  previewCertGuide() {
    const url = this.data.certGuideImg;
    if (url) wx.previewImage({ urls: [url] });
  },

  /** 提交认证申请 */
  async submit() {
    const { form, certImg } = this.data;
    if (!form.certName || !form.certStudentId || !form.certPhone || !certImg) {
      wx.showToast({ title: '请完整填写4项认证信息', icon: 'none' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(form.certPhone)) {
      wx.showToast({ title: '可联系手机号格式不正确', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const res = await post('/api/audit/submit', {
        applyType: 3,
        applyContent: certImg,
        certName: form.certName,
        certStudentId: form.certStudentId,
        certPhone: form.certPhone
      });

      // 1) 提交成功后立即清空表单（含已上传的认证截图），
      //    避免用户看到旧内容误以为没提交成功而连续重复申请（7 天只有 3 次机会）
      this.setData({
        form: { certName: '', certStudentId: '', certPhone: '' },
        certImg: '',
        certImgUrl: ''
      });
      // 2) 刷新认证状态：preserveForm = true，保住刚清空的表单不被账号资料回填
      await this.loadStatus(true);
      app.refreshUserInfo();
      // 3) 弹窗告知「7 天内仅限提交 3 次」以及本次提交后还剩多少次
      this.showSubmitResult(res.data && res.data.campusApply);
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 校园认证提交成功后的结果弹窗
   * 告知用户：7 天内仅限提交 3 次认证信息，本次提交后还剩余多少次。
   * 文案模板取自字典 MSG.CAMPUS_APPLY_TIP，天数 / 次数上限取自 BIZ，
   * 剩余次数用后端返回的 campusApply.remainTimes（后端按 7 天窗口实时统计，避免前后端口径不一致）。
   * @param {object} campusApply 后端返回的 { days, limit, usedTimes, remainTimes }
   */
  showSubmitResult(campusApply) {
    const data = campusApply || {};
    const remain = Number(data.remainTimes);
    const tip = formatText(MSG.CAMPUS_APPLY_TIP, {
      days: data.days || BIZ.CAMPUS_APPLY_DAYS,
      limit: data.limit || BIZ.CAMPUS_APPLY_LIMIT,
      remain: isNaN(remain) ? 0 : remain
    });
    dialog.show(this, {
      title: MSG.CAMPUS_SUBMIT_TITLE,
      content: `${MSG.CAMPUS_SUBMIT_CONTENT}\n${tip}`,
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  }

});
