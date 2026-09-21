/**
 * 管理员后台（仅后端白名单学号可进入，前端 isAdmin 由后端下发）
 *  - 审核管理：通过 / 驳回（驳回需填写原因）
 *  - 申诉管理：回复申诉（回复后自动推送站内消息）
 *  - 举报管理：处理举报并填写处理说明（含雇主提交的「恶意超时投诉」，可一键封禁接单人）
 *     展示订单号（GCPT+数字）与雇主 / 接单人双方的 账号ID、学号、手机号
 *  - 封禁管理：查看被封禁人（ID / 学号 / 封禁时长一行一排），搜索、解封、加时
 *     搜索会同时命中「已封禁」与「未封禁」用户，未封禁的也能直接一键封禁
 *  - 用户管理：查看全部用户并对其封禁接单权限
 *  - 订单管理：按订单号（GCPT+数字）/ 任务ID / 学号 / 手机号 / 账号ID 搜索订单，
 *     展示任务完整详情与雇主、接单人 mini 卡片，可对双方处罚（封禁接单权限）、
 *     编辑订单资料与酬金、删除订单（删除待接单订单会自动退费）
 */

const { get, post, showError, chooseAndUpload, ERR_CHOOSE_CANCEL } = require('../../utils/request');
const filter = require('../../utils/filter');
// 一键复制：全站统一出口（复制成功/失败/空内容三种提示文案统一）
const clipboard = require('../../utils/clipboard');
// 封禁时长预设与自定义时间单位字典（必须与后端 utils/constant.js 完全一致）
const {
  BAN_DURATION, BAN_DURATION_ENUM, CAMPUS_AUDIT, BIZ, MSG, ANNOUNCE_SCOPE_ENUM, formatText
} = require('../../utils/constant');

const theme = require('../../utils/theme');
const dialog = require('../../utils/dialog');
const app = getApp();

const STATUS_TABS = [
  { label: '全部', value: '' },
  { label: '待处理', value: 1 },
  { label: '已处理', value: 2 }
];

/** 自定义封禁时长的 6 个输入项（最小为 0，不填表示该项为 0 / 不设置） */
const CUSTOM_UNITS = [
  { key: 'year', label: '年' },
  { key: 'month', label: '月' },
  { key: 'day', label: '日' },
  { key: 'hour', label: '时' },
  { key: 'minute', label: '分' },
  { key: 'second', label: '秒' }
];

/** 举报类型筛选 Tab（普通举报 / 恶意超时投诉） */
const REPORT_TYPE_TABS = [
  { label: '全部', value: '' },
  { label: '普通举报', value: 1 },
  { label: '恶意超时投诉', value: 2 }
];

/**
 * 校园认证状态可选项（0无申请 / 1待审核 / 2审核通过 / 3已驳回）
 * 文案统一取自 constant.js 字典，禁止在页面里硬编码中文
 */
/**
 * 批量删除配置：模块 → 列表数据字段 / 主键字段 / 使用的接口
 * ---------------------------------------------------------------------
 * 各 Tab 的列表项主键字段不统一（订单是 taskId、封禁与用户是 userId、
 * 其余是 id），所以这里统一声明，模板与逻辑都只认这份配置，避免各写一套。
 * api = announceDelete 时走公告专用接口，其余走通用 /api/admin/batchDelete。
 */
const BATCH_CONFIG = {
  audit: { listKey: 'audits', idField: 'id' },
  appeal: { listKey: 'appeals', idField: 'id' },
  report: { listKey: 'reports', idField: 'id' },
  order: { listKey: 'orders', idField: 'taskId' },
  ban: { listKey: 'bans', idField: 'userId' },
  user: { listKey: 'users', idField: 'userId' },
  announce: { listKey: 'announces', idField: 'id', api: 'announceDelete' }
};

/** 公告生效时间输入规范化：'2026-09-20 08:00' -> '2026-09-20 08:00:00'（后端按 DATETIME 解析） */
function normalizeTimeText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text) ? text + ':00' : text;
}

const CAMPUS_AUDIT_OPTIONS = Object.keys(CAMPUS_AUDIT).map((key) => ({
  value: Number(key),
  label: CAMPUS_AUDIT[key]
}));

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    tab: 'audit',           // audit | appeal | report | ban | order | user
    auditTabs: [
      { label: '待审核', value: 1 },
      { label: '审核通过', value: 2 },
      { label: '已驳回', value: 3 }
    ],
    statusTabs: STATUS_TABS,
    reportTypeTabs: REPORT_TYPE_TABS,
    auditStatus: 1,
    appealStatus: 1,
    reportStatus: 1,
    reportType: 2,
    audits: [],
    appeals: [],
    reports: [],
    users: [],
    keyword: '',
    // ---------------- 封禁管理 ----------------
    banKeyword: '',
    bans: [],
    durationOptions: BAN_DURATION,
    customUnits: CUSTOM_UNITS,
    showBanModal: false,
    banTarget: null,       // { userId, userIdText, nickname, studentId }
    banMode: 'ban',        // ban 封禁 / extend 加时
    banDurationType: BAN_DURATION_ENUM.MIN30,
    banCustom: { year: '', month: '', day: '', hour: '', minute: '', second: '' },
    banReason: '',
    // ---------------- 用户管理：管理员直接修改用户资料 ----------------
    campusAuditOptions: CAMPUS_AUDIT_OPTIONS,
    showUserEdit: false,
    editForm: null,        // { userId, userIdText, nickname, name, phone, studentId, isCampusAudit, avatar, avatarUrl }
    editSubmitting: false,
    // ---------------- 用户管理：管理员注销账号（不可恢复） ----------------
    showDeactivateModal: false,
    deactivateTarget: null,       // { userId, userIdText, nickname, studentId }
    deactivateSubmitting: false,
    // ---------------- 订单管理（搜索 / 编辑 / 处罚 / 删除） ----------------
    orderKeyword: '',
    orders: [],
    // 订单编辑弹窗
    showOrderEdit: false,
    orderForm: null,        // { taskId, orderNo, receiverName, receiverPhone, pickupCode,
                            //   deliverAddress, detailAddress, timeLimitMin, remark, reward,
                            //   images: [], imageUrls: [] }
    orderSubmitting: false,
    taskImgMax: BIZ.TASK_IMG_MAX,
    // ---------------- 批量删除（列表清理）：各模块的勾选状态 ----------------
    // key 与 BATCH_CONFIG 一致；text = 「已选 N 条 / 未选择」，all = 是否已全选
    batch: {
      audit: { count: 0, all: false, text: '' },
      appeal: { count: 0, all: false, text: '' },
      report: { count: 0, all: false, text: '' },
      order: { count: 0, all: false, text: '' },
      ban: { count: 0, all: false, text: '' },
      user: { count: 0, all: false, text: '' },
      announce: { count: 0, all: false, text: '' }
    },
    selectAllText: MSG.BATCH_SELECT_ALL,
    batchDeleteText: MSG.BATCH_DELETE,
    deleteText: MSG.DELETE,
    // ---------------- 用户管理：默认隐藏已注销账号 ----------------
    includeDeactivated: false,
    showDeactivatedText: MSG.BATCH_SHOW_DEACTIVATED,
    // ---------------- 公告管理（跑马灯 / 全局通知条） ----------------
    announceScopes: [
      { label: MSG.ANNOUNCE_SCOPE_MARQUEE, value: ANNOUNCE_SCOPE_ENUM.MARQUEE },
      { label: MSG.ANNOUNCE_SCOPE_NOTICE, value: ANNOUNCE_SCOPE_ENUM.NOTICE }
    ],
    announceScope: ANNOUNCE_SCOPE_ENUM.MARQUEE,
    announceContent: '',
    announceContentPlaceholder: MSG.ANNOUNCE_CONTENT_PLACEHOLDER,
    announceStart: '',
    announceEnd: '',
    announceStartPlaceholder: MSG.ANNOUNCE_START_PLACEHOLDER,
    announceEndPlaceholder: MSG.ANNOUNCE_END_PLACEHOLDER,
    announceTimeTip: MSG.ANNOUNCE_TIME_TIP,
    announcePush: true,
    announcePushLabel: MSG.ANNOUNCE_PUSH_LABEL,
    announceClosable: true,
    announceClosableLabel: MSG.ANNOUNCE_CLOSABLE_LABEL,
    announceSubmitting: false,
    announceSubmitText: MSG.ANNOUNCE_PUBLISH,
    announcePublishingText: MSG.ANNOUNCE_PUBLISHING,
    announceEmptyText: MSG.ANNOUNCE_EMPTY,
    announceActiveText: MSG.ANNOUNCE_ACTIVE,
    announceInactiveText: MSG.ANNOUNCE_INACTIVE,
    announceOnText: MSG.ANNOUNCE_ON,
    announceOffText: MSG.ANNOUNCE_OFF,
    announceMaxLen: 200,
    announces: [],
    loading: false
  },

  onLoad() {
    const user = app.globalData.userInfo;
    if (user && !user.isAdmin) {
      wx.showToast({ title: '无管理员权限', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  onShow() {
    // 主题校准：系统深浅色可能变了，用户也可能刚在首页拨过开关
    theme.sync(this);
    this.loadCurrent();
  },

  onTabChange(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.loadCurrent();
  },

  loadCurrent() {
    const { tab } = this.data;
    const cfg = BATCH_CONFIG[tab];
    const run = () => {
      if (tab === 'audit') return this.loadAudits();
      if (tab === 'appeal') return this.loadAppeals();
      if (tab === 'report') return this.loadReports();
      if (tab === 'ban') return this.loadBans();
      if (tab === 'order') return this.loadOrders();
      if (tab === 'announce') return this.loadAnnounces();
      return this.loadUsers();
    };
    const result = run();
    // 列表刷新后重置勾选统计（避免上一批勾选状态残留导致计数对不上）
    if (cfg && result && typeof result.then === 'function') {
      return result.then(() => this.syncBatch(tab, cfg.listKey));
    }
    return result;
  },

  onAuditStatusChange(e) {
    this.setData({ auditStatus: Number(e.currentTarget.dataset.value) });
    this.loadAudits();
  },

  onStatusChange(e) {
    const status = e.currentTarget.dataset.value;
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: status === '' ? '' : Number(status) });
    this.loadCurrent();
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  /** 审核列表 */
  async loadAudits() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/audit/adminList', { page: 1, pageSize: 30, status: this.data.auditStatus });
      const audits = (res.data.list || []).map((item) => ({
        ...item,
        typeText: filter.auditApplyTypeText(item.apply_type),
        statusText: filter.auditStatusText(item.status),
        timeText: filter.formatTime(item.created_at, 'YYYY-MM-DD HH:mm'),
        // 头像(1)/校园认证(3) 的申请内容是图片，补全域名后才能在真机预览
        contentImage: item.apply_type === 2 ? '' : filter.imageUrl(item.apply_content)
      }));
      this.setData({ audits });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 申诉列表 */
  async loadAppeals() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/appeal/adminList', { page: 1, pageSize: 30, status: this.data.appealStatus });
      const appeals = (res.data.list || []).map((item) => ({
        ...item,
        statusText: filter.appealStatusText(item.status),
        timeText: filter.formatTime(item.created_at, 'YYYY-MM-DD HH:mm')
      }));
      this.setData({ appeals });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 举报列表（含恶意超时投诉）
   * 订单号（GCPT+数字）、举报类型文案、雇主 / 接单人双方的 账号ID / 学号 / 手机号
   * 以及「可否一键封禁接单人」全部由后端统一下发（快照优先），前端只补时间格式化，
   * 避免前后端各算一套导致显示口径不一致。
   */
  async loadReports() {
    this.setData({ loading: true });
    try {
      const query = { page: 1, pageSize: 30, status: this.data.reportStatus };
      // reportType 为空表示不筛选（后端按空值忽略该条件）
      if (this.data.reportType !== '') query.reportType = this.data.reportType;
      const res = await get('/api/report/adminList', query);
      const reports = (res.data.list || []).map((item) => ({
        ...item,
        timeText: filter.formatTime(item.createdAt, 'YYYY-MM-DD HH:mm'),
        // 三方用户 mini 卡片：举报人 / 雇主 / 接单人，点击卡片可直接查看该用户全部信息
        reporterPerson: filter.personView({
          label: '举报人',
          userId: item.reporterUserId,
          avatar: item.reporterAvatar,
          nickname: item.reporterNickname,
          userIdText: item.reporterUserIdText,
          studentId: item.reporterStudentId,
          isAdmin: item.reporterIsAdmin,
          isCertified: item.reporterIsCertified
        }),
        ownerPerson: filter.personView({
          label: '雇主',
          userId: item.ownerUserId,
          avatar: item.ownerAvatar,
          nickname: item.ownerNickname,
          userIdText: item.ownerUserIdText,
          studentId: item.ownerStudentId,
          isAdmin: item.ownerIsAdmin,
          isCertified: item.ownerIsCertified
        }),
        // 任务尚未被接单时没有接单人，组件整体不渲染
        takerPerson: item.takerUserId ? filter.personView({
          label: '接单人',
          userId: item.takerUserId,
          avatar: item.takerAvatar,
          nickname: item.takerNickname,
          userIdText: item.takerUserIdText,
          studentId: item.takerStudentId,
          isAdmin: item.takerIsAdmin,
          isCertified: item.takerIsCertified
        }) : null
      }));
      this.setData({ reports });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 用户列表 */
  async loadUsers() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/admin/userList', {
        page: 1,
        pageSize: 30,
        keyword: this.data.keyword,
        includeDeactivated: this.data.includeDeactivated
      });
      const users = (res.data.list || []).map((item) => ({
        ...item,
        banRemainText: item.isBanned ? filter.banRemainText(item.banTakeTime) : '',
        // 头像、认证状态文案（认证状态文案统一取自 constant.js 字典）
        avatarUrl: filter.imageUrl(item.avatar),
        campusAuditText: filter.campusAuditText(item.isCampusAudit),
        // 昵称剩余修改次数：管理员账号后端下发 -1，表示不受次数限制
        nicknameModifyText: item.nicknameModifyCount < 0 ? '不限' : `${item.nicknameModifyCount} 次`
      }));
      this.setData({ users });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  // ==================== 用户管理：管理员修改用户资料 ====================

  /**
   * 打开「修改用户资料」弹窗
   * 可修改：昵称、姓名、手机号（管理员可见完整号码）、学号、校园认证状态、头像
   */
  openUserEdit(e) {
    const ds = e.currentTarget.dataset;
    const user = this.data.users.find((item) => item.userId === Number(ds.userid));
    if (!user) {
      wx.showToast({ title: '未找到该用户，请刷新列表', icon: 'none' });
      return;
    }
    this.openEditForm(user);
  },

  /**
   * 打开「用户资料」弹窗
   * 用户管理列表的「修改资料」按钮 与 举报/审核里的用户 mini 卡片 共用同一弹窗，
   * 保证管理员在哪个入口看到的都是同一份完整资料（字段来自 userList / userDetail，口径一致）。
   * @param {object} user 后端下发的用户对象
   */
  openEditForm(user) {
    if (!user) return;
    this.setData({
      showUserEdit: true,
      editForm: {
        userId: user.userId,
        userIdText: user.userIdText,
        isAdmin: !!user.isAdmin,
        nickname: user.nickname || '',
        name: user.name || '',
        phone: user.phone || '',
        studentId: user.studentId || '',
        isCampusAudit: Number(user.isCampusAudit),
        avatar: user.avatar || '',
        avatarUrl: user.avatarUrl || filter.imageUrl(user.avatar)
      }
    });
  },

  /**
   * 点击用户 mini 卡片：拉取该用户完整信息并打开「用户资料」弹窗
   * 管理员权限为最高，既能查看全部字段，也能直接修改
   */
  async onUserCardTap(e) {
    const person = (e && e.detail) || {};
    const userId = Number(person.userId);
    if (!userId) {
      wx.showToast({ title: '该用户信息不可用', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await get('/api/admin/userDetail', { userId });
      this.openEditForm(res.data);
    } catch (err) {
      showError(err);
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 一键复制一条举报的全部关键信息
   * 便于管理员把「订单号 + 三方账号/学号/手机号 + 举报原因」整段转给客服或上级
   */
  copyReport(e) {
    const report = this.data.reports.find((item) => item.id === Number(e.currentTarget.dataset.id));
    if (!report) {
      wx.showToast({ title: '未找到该举报，请刷新列表', icon: 'none' });
      return;
    }
    return clipboard.copyText(this.buildReportText(report), '举报信息');
  },

  /**
   * 生成举报信息纯文本（一键复制用，字段与页面展示完全一致）
   * @param {object} item 举报列表项
   * @returns {string}
   */
  buildReportText(item) {
    const lines = [
      '【校园跑腿 · 举报单】',
      `举报编号：${item.id}`,
      `订单号：${item.orderNo || '暂无'}`,
      `举报类型：${item.reportTypeText || ''}`,
      `被举报任务：任务 #${item.taskId}`,
      `送达地址：${item.deliverAddress || '暂无'}`,
      '',
      `雇主：${item.ownerNickname || '未知'}（账号 ${item.ownerUserIdText || item.ownerUserId || '未知'}）`,
      `雇主学号：${item.ownerStudentId || '未填'}`,
      `雇主手机：${item.ownerPhone || '未填'}`
    ];
    if (item.takerUserId) {
      lines.push(`接单人：${item.takerNickname || '未知'}（账号 ${item.takerUserIdText || item.takerUserId}）`);
      lines.push(`接单人学号：${item.takerStudentId || '未填'}`);
      lines.push(`接单人手机：${item.takerPhone || '未填'}`);
    } else {
      lines.push('接单人：暂无（未被接单）');
    }
    lines.push(`举报人：${item.reporterNickname || '未知'}（账号 ${item.reporterUserIdText || item.reporterUserId}）`);
    lines.push(`举报人学号：${item.reporterStudentId || '未填'}`);
    lines.push(`举报人手机：${item.reporterPhone || '未填'}`);
    lines.push('');
    lines.push(`举报原因：${item.reportReason || ''}`);
    lines.push(`提交时间：${item.timeText || ''}`);
    return lines.join('\n');
  },

  closeUserEdit() {
    this.setData({ showUserEdit: false, editForm: null });
  },

  /** 编辑弹窗内的通用文本输入 */
  onEditInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`editForm.${field}`]: e.detail.value });
  },

  /** 选择校园认证状态 */
  onEditCampusSelect(e) {
    this.setData({ 'editForm.isCampusAudit': Number(e.currentTarget.dataset.value) });
  },

  /** 管理员为指定用户上传 / 更换头像（直接生效，无需再走审核） */
  async chooseEditAvatar() {
    try {
      const urls = await chooseAndUpload(1);
      if (urls.length) {
        this.setData({ 'editForm.avatar': urls[0], 'editForm.avatarUrl': filter.imageUrl(urls[0]) });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  /** 清空头像（提交后该用户恢复默认头像） */
  removeEditAvatar() {
    this.setData({ 'editForm.avatar': '', 'editForm.avatarUrl': '' });
  },

  previewEditAvatar() {
    const url = this.data.editForm && this.data.editForm.avatarUrl;
    if (url) wx.previewImage({ urls: [url] });
  },

  /**
   * 提交用户资料修改
   * 后端会做完整校验（手机号唯一、学号唯一、不允许占用管理员白名单学号等），
   * 保存成功后自动向该用户推送「账号信息已被管理员修改」的站内消息。
   */
  async submitUserEdit() {
    const form = this.data.editForm;
    if (!form || !form.userId) {
      wx.showToast({ title: '未选择用户', icon: 'none' });
      return;
    }
    if (!form.nickname || !form.name || !form.phone || !form.studentId) {
      wx.showToast({ title: '昵称、姓名、手机号、学号都不能为空', icon: 'none' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(form.phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' });
      return;
    }
    if (!/^[A-Za-z0-9]{4,20}$/.test(form.studentId)) {
      wx.showToast({ title: '学号格式不正确（4-20位字母或数字）', icon: 'none' });
      return;
    }
    if (this.data.editSubmitting) return;

    this.setData({ editSubmitting: true });
    try {
      const res = await post('/api/admin/updateUser', {
        userId: form.userId,
        nickname: form.nickname,
        name: form.name,
        phone: form.phone,
        studentId: form.studentId,
        isCampusAudit: form.isCampusAudit,
        avatar: form.avatar
      });
      this.closeUserEdit();
      wx.showToast({ title: res.msg || '已保存', icon: 'none' });
      this.loadUsers();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ editSubmitting: false });
    }
  },

  // ==================== 用户管理：管理员重置登录密码 ====================

  /** 打开「重置登录密码」弹窗（默认自动生成随机密码） */
  openPwdModal(e) {
    const ds = e.currentTarget.dataset;
    const user = this.data.users.find((item) => item.userId === Number(ds.userid));
    if (!user) {
      wx.showToast({ title: '未找到该用户，请刷新列表', icon: 'none' });
      return;
    }
    this.setData({
      showPwdModal: true,
      pwdForm: {
        userId: user.userId,
        userIdText: user.userIdText,
        nickname: user.nickname || '',
        mode: 'auto',       // auto 自动生成随机密码 / manual 手动指定
        password: ''
      }
    });
  },

  closePwdModal() {
    this.setData({ showPwdModal: false, pwdForm: null });
  },

  /** 切换「自动生成 / 手动指定」 */
  onPwdModeSelect(e) {
    this.setData({ 'pwdForm.mode': e.currentTarget.dataset.mode });
  },

  onPwdInput(e) {
    this.setData({ 'pwdForm.password': e.detail.value });
  },

  /**
   * 提交重置密码
   * 说明：重置成功后该用户所有设备会被强制退出登录，必须用新密码重新登录；
   *      自动生成模式会把随机密码返回给管理员，这里弹出并支持一键复制。
   */
  async submitResetPwd() {
    const form = this.data.pwdForm;
    if (!form || !form.userId) {
      wx.showToast({ title: '未选择用户', icon: 'none' });
      return;
    }
    const manual = form.mode === 'manual';
    if (manual) {
      const pwd = String(form.password || '');
      if (pwd.length < 6 || pwd.length > 20) {
        wx.showToast({ title: '密码长度需为6-20位', icon: 'none' });
        return;
      }
    }
    if (this.data.pwdSubmitting) return;

    this.setData({ pwdSubmitting: true });
    try {
      const res = await post('/api/admin/resetUserPassword', {
        userId: form.userId,
        newPassword: manual ? String(form.password) : ''
      });
      const data = res.data || {};
      this.closePwdModal();
      dialog.show(this, {
        title: '密码已重置',
        content: `账号 ${data.userIdText || ''}（${form.nickname}）的新密码：\n${data.password}\n\n`
          + '请复制后转告该用户；该用户当前所有设备已退出登录，需用新密码重新登录。',
        confirmText: '复制密码',
        cancelText: '关闭'
      }).then((r) => {
        if (r.confirm) {
          wx.setClipboardData({
            data: String(data.password || ''),
            success: () => wx.showToast({ title: '密码已复制', icon: 'success' })
          });
        }
      });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ pwdSubmitting: false });
    }
  },

  // ==================== 用户管理：管理员注销账号（不可恢复） ====================

  /** 打开「注销账号」确认弹窗 */
  openDeactivateModal(e) {
    const ds = e.currentTarget.dataset;
    const user = this.data.users.find((item) => item.userId === Number(ds.userid));
    if (!user) {
      wx.showToast({ title: '未找到该用户，请刷新列表', icon: 'none' });
      return;
    }
    // 前端先拦一道，后端 adminController 还会再校验一次（白名单 + 不能注销自己）
    if (user.isAdmin) {
      wx.showToast({ title: '管理员账号不可注销', icon: 'none' });
      return;
    }
    this.setData({
      showDeactivateModal: true,
      deactivateTarget: {
        userId: user.userId,
        userIdText: user.userIdText,
        nickname: user.nickname || '',
        studentId: user.studentId || ''
      }
    });
  },

  closeDeactivateModal() {
    if (this.data.deactivateSubmitting) return;
    this.setData({ showDeactivateModal: false, deactivateTarget: null });
  },

  /**
   * 提交注销
   * 注销不可恢复：手机号 / 学号释放、隐私资料清空、对方旧 token 立即失效；
   * 历史任务与账单记录保留，因此这里只在成功后刷新用户列表。
   */
  async submitDeactivate() {
    const target = this.data.deactivateTarget;
    if (!target || !target.userId) {
      wx.showToast({ title: '未选择用户', icon: 'none' });
      return;
    }
    if (this.data.deactivateSubmitting) return;

    this.setData({ deactivateSubmitting: true });
    try {
      await post('/api/admin/deactivateUser', { userId: target.userId });
      this.setData({ showDeactivateModal: false, deactivateTarget: null });
      wx.showToast({ title: '账号已注销', icon: 'success' });
      this.loadUsers();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ deactivateSubmitting: false });
    }
  },

  // ==================== 封禁管理 ====================

  // ==================== 订单管理（搜索 / 编辑 / 处罚 / 删除） ====================

  onOrderKeywordInput(e) {
    this.setData({ orderKeyword: e.detail.value });
  },

  /** 点击「搜索」或键盘回车：按关键词搜索订单 */
  searchOrders() {
    return this.loadOrders();
  },

  /**
   * 订单列表（订单管理 Tab）
   * ------------------------------------------------------------------
   * 关键词支持：订单号（GCPT+数字）/ 任务ID / 学号 / 手机号 / 账号ID / 收件人手机号；
   * 不填关键词则返回全部订单（含已被管理员删除的订单，卡片上会标注「已删除」）。
   *
   * 状态文案、可执行操作（canEdit / canDelete / 可处罚对象）全部由后端下发，
   * 前端只做展示层格式化（金额、时间、倒计时、图片地址补全），不自行判断权限。
   */
  async loadOrders() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/admin/searchTask', {
        page: 1, pageSize: 30, keyword: this.data.orderKeyword
      });
      const orders = (res.data.list || []).map((item) => this.buildOrderView(item));
      this.setData({ orders });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 把后端下发的订单对象格式化为可直接渲染的视图对象
   * @param {object} item 后端 toAdminTaskVO 的输出
   * @returns {object}
   */
  buildOrderView(item) {
    const remainSeconds = item.remainSeconds;
    return {
      ...item,
      // 金额 / 限时 / 状态样式
      rewardText: filter.price(item.reward),
      serviceFeeText: filter.price(item.serviceFee),
      timeLimitText: filter.timeLimitText(item.timeLimitMin),
      statusClass: filter.taskStatusClass(item.status),
      payStatusText: item.payStatus === null || item.payStatus === undefined
        ? '' : filter.payStatusText(item.payStatus),
      // 倒计时：仅进行中的限时任务有值；负数表示已超时
      countdownText: remainSeconds === null || remainSeconds === undefined
        ? '' : filter.countdownText(Math.max(0, remainSeconds)),
      // 时间轴
      publishTimeText: filter.formatTime(item.publishTime, 'YYYY-MM-DD HH:mm'),
      takeTimeText: filter.formatTime(item.takeTime, 'YYYY-MM-DD HH:mm'),
      submitFinishTimeText: filter.formatTime(item.submitFinishTime, 'YYYY-MM-DD HH:mm'),
      deleteTimeText: filter.formatTime(item.deleteTime, 'YYYY-MM-DD HH:mm'),
      // 雇主 / 接单人 mini 卡片（点击卡片可查看该用户全部资料）
      ownerPerson: filter.personView({
        label: '雇主',
        userId: item.owner ? item.owner.userId : 0,
        avatar: item.owner ? item.owner.avatar : '',
        nickname: item.owner ? item.owner.nickname : '',
        userIdText: item.owner ? item.owner.userIdText : '',
        studentId: item.owner ? item.owner.studentId : '',
        isAdmin: item.owner ? item.owner.isAdmin : false,
        isCertified: item.owner ? item.owner.isCertified : false
      }),
      takerPerson: item.taker ? filter.personView({
        label: '接单人',
        userId: item.taker.userId,
        avatar: item.taker.avatar,
        nickname: item.taker.nickname,
        userIdText: item.taker.userIdText,
        studentId: item.taker.studentId,
        isAdmin: item.taker.isAdmin,
        isCertified: item.taker.isCertified
      }) : null,
      // 图片地址补全（数据库存相对路径，渲染前必须补域名）
      imageUrls: filter.imageUrls(item.images),
      deliveryImageUrls: filter.imageUrls(item.deliveryImages)
    };
  },

  /** 跳转任务详情页（管理员视角会额外显示「删除任务」入口） */
  viewOrderDetail(e) {
    const taskId = Number(e.currentTarget.dataset.id);
    if (!taskId) return;
    wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${taskId}` });
  },

  // ---------------- 订单编辑 ----------------

  /** 打开「编辑订单」弹窗（回显当前订单全部可编辑字段） */
  openOrderEdit(e) {
    const order = this.data.orders.find((item) => item.taskId === Number(e.currentTarget.dataset.id));
    if (!order) {
      wx.showToast({ title: '未找到该订单，请重新搜索', icon: 'none' });
      return;
    }
    if (!order.canEdit) {
      wx.showToast({ title: '该订单已被删除，无法编辑', icon: 'none' });
      return;
    }
    const images = (order.images || []).slice();
    this.setData({
      showOrderEdit: true,
      orderForm: {
        taskId: order.taskId,
        orderNo: order.orderNo,
        receiverName: order.receiverName,
        receiverPhone: order.receiverPhone,
        pickupCode: order.pickupCode,
        deliverAddress: order.deliverAddress,
        detailAddress: order.detailAddress,
        // 限时：null（不限时）在输入框里显示为空串
        timeLimitMin: order.timeLimitMin === null || order.timeLimitMin === undefined
          ? '' : String(order.timeLimitMin),
        remark: order.remark,
        reward: String(order.reward),
        images,
        imageUrls: filter.imageUrls(images)
      }
    });
  },

  closeOrderEdit() {
    if (this.data.orderSubmitting) return;
    this.setData({ showOrderEdit: false, orderForm: null });
  },

  /** 编辑弹窗内的通用文本输入 */
  onOrderInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field || !this.data.orderForm) return;
    this.setData({ [`orderForm.${field}`]: e.detail.value });
  },

  /** 管理员替换订单图片（最多 3 张，单张 2MB，仅 jpg/png/webp） */
  async chooseOrderImage() {
    const form = this.data.orderForm;
    if (!form) return;
    const rest = BIZ.TASK_IMG_MAX - form.images.length;
    if (rest <= 0) {
      wx.showToast({ title: `最多上传${BIZ.TASK_IMG_MAX}张图片`, icon: 'none' });
      return;
    }
    try {
      const urls = await chooseAndUpload(rest);
      if (urls.length) {
        const images = form.images.concat(urls).slice(0, BIZ.TASK_IMG_MAX);
        this.setData({
          'orderForm.images': images,
          'orderForm.imageUrls': filter.imageUrls(images)
        });
      }
    } catch (err) {
      if (err.code !== ERR_CHOOSE_CANCEL) showError(err);
    }
  },

  removeOrderImage(e) {
    const form = this.data.orderForm;
    if (!form) return;
    const index = Number(e.currentTarget.dataset.index);
    const images = form.images.slice();
    images.splice(index, 1);
    this.setData({
      'orderForm.images': images,
      'orderForm.imageUrls': filter.imageUrls(images)
    });
  },

  previewOrderImage(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /**
   * 提交订单编辑
   * 校验规则与后端保持同一口径（前端先兜底提示，后端仍会再校验一次）：
   *   收件人姓名 / 手机号 / 送达地址 / 酬金 必填，酬金 0.5-999.99 元，
   *   限时留空表示不限时，填了必须是 1-1440 的整数。
   */
  async submitOrderEdit() {
    const form = this.data.orderForm;
    if (!form || this.data.orderSubmitting) return;

    const receiverName = String(form.receiverName || '').trim();
    const receiverPhone = String(form.receiverPhone || '').trim();
    const deliverAddress = String(form.deliverAddress || '').trim();
    const reward = Number(String(form.reward || '').trim());
    const timeLimitRaw = String(form.timeLimitMin || '').trim();

    if (!receiverName) {
      wx.showToast({ title: '请填写收件人姓名', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(receiverPhone)) {
      wx.showToast({ title: '收件人手机号格式不正确', icon: 'none' });
      return;
    }
    if (!deliverAddress) {
      wx.showToast({ title: '请填写送达地址', icon: 'none' });
      return;
    }
    if (!Number.isFinite(reward) || reward < BIZ.REWARD_MIN || reward > BIZ.REWARD_MAX) {
      wx.showToast({
        title: `酬金需在${BIZ.REWARD_MIN}~${BIZ.REWARD_MAX}元之间`, icon: 'none'
      });
      return;
    }
    if (timeLimitRaw) {
      const minutes = Number(timeLimitRaw);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        wx.showToast({ title: '限时需为1-1440分钟的整数，留空表示不限时', icon: 'none' });
        return;
      }
    }

    this.setData({ orderSubmitting: true });
    try {
      const res = await post('/api/admin/updateTask', {
        taskId: form.taskId,
        receiverName,
        receiverPhone,
        pickupCode: String(form.pickupCode || '').trim(),
        deliverAddress,
        detailAddress: String(form.detailAddress || '').trim(),
        timeLimitMin: timeLimitRaw,
        remark: String(form.remark || '').trim(),
        reward,
        // 图片按下标重新排布，空位传空串（后端会原样落库）
        img1: form.images[0] || '',
        img2: form.images[1] || '',
        img3: form.images[2] || ''
      });
      this.setData({ showOrderEdit: false, orderForm: null });
      wx.showToast({ title: (res && res.msg) || '订单已更新', icon: 'none' });
      this.loadOrders();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ orderSubmitting: false });
    }
  },

  /**
   * 删除订单（软删除，数据保留作为处置留痕）
   * 二次确认弹窗允许顺手填写删除原因（选填，会同步告知雇主与接单人）；
   * 若订单处于「待接单」，后端会自动原路退回 0.1 元信息服务费。
   */
  deleteOrder(e) {
    const order = this.data.orders.find((item) => item.taskId === Number(e.currentTarget.dataset.id));
    if (!order) {
      wx.showToast({ title: '未找到该订单，请重新搜索', icon: 'none' });
      return;
    }
    if (!order.canDelete) {
      wx.showToast({ title: '该订单已被删除，请勿重复操作', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除订单',
      content: `确认删除订单号 ${order.orderNo || order.taskId} 吗？删除后该任务会从任务大厅、`
        + '我的发布、我的任务中全部下架且不可恢复；若处于「待接单」状态，信息服务费将自动原路退回。',
      editable: true,
      placeholderText: `可填写删除原因（选填，最多${BIZ.TASK_DELETE_REASON_MAX}字，会同步告知双方）`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const result = await post('/api/admin/deleteTask', {
            taskId: order.taskId,
            reason: String(res.content || '').trim().slice(0, BIZ.TASK_DELETE_REASON_MAX)
          });
          wx.showToast({ title: (result && result.msg) || '订单已删除', icon: 'none' });
          this.loadOrders();
        } catch (err) {
          showError(err);
        }
      }
    });
  },

  // ==================== 封禁管理 ====================

  onBanKeywordInput(e) {
    this.setData({ banKeyword: e.detail.value });
  },

  /**
   * 封禁管理列表
   *   - 不输关键词：展示「当前封禁名单」（正在封禁中的用户）
   *   - 输入关键词：同时返回已封禁与未封禁的用户，封禁中的排在前面，
   *     未封禁的也能直接点「封禁接单」进行封禁
   */
  async loadBans() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/admin/banList', {
        page: 1, pageSize: 50, keyword: this.data.banKeyword
      });
      const bans = (res.data.list || []).map((item) => ({
        ...item,
        // 只有封禁中的用户才展示剩余时长
        remainText: item.isBanned ? filter.banRemainText(item.banEndTime) : '',
        createdAtText: filter.formatTime(item.banCreatedAt, 'YYYY-MM-DD HH:mm'),
        endTimeText: filter.formatTime(item.banEndTime, 'YYYY-MM-DD HH:mm')
      }));
      this.setData({ bans });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 打开封禁 / 加时弹窗
   * 数据来源：封禁列表的「加时」按钮，或用户管理 / 举报列表的「封禁」按钮
   */
  openBanModal(e) {
    const ds = e.currentTarget.dataset;
    const isExtend = ds.mode === 'extend';
    this.setData({
      showBanModal: true,
      banMode: isExtend ? 'extend' : 'ban',
      banTarget: {
        userId: Number(ds.userid),
        userIdText: ds.useridtext || '',
        nickname: ds.nickname || '',
        studentId: ds.studentid || ''
      },
      banDurationType: BAN_DURATION_ENUM.MIN30,
      banCustom: { year: '', month: '', day: '', hour: '', minute: '', second: '' },
      banReason: ''
    });
  },

  closeBanModal() {
    this.setData({ showBanModal: false, banTarget: null, banReason: '' });
  },

  /** 选择封禁时长档位（5分钟/15分钟/30分钟/1小时/2小时/1天/自定义） */
  onDurationSelect(e) {
    this.setData({ banDurationType: e.currentTarget.dataset.key });
  },

  /** 自定义时长输入（年月日时分秒，最小为 0，不填即不设置该项） */
  onCustomInput(e) {
    const unit = e.currentTarget.dataset.unit;
    const banCustom = Object.assign({}, this.data.banCustom, { [unit]: e.detail.value });
    this.setData({ banCustom });
  },

  onBanReasonInput(e) {
    this.setData({ banReason: e.detail.value });
  },

  /** 提交封禁 / 加时 */
  async submitBan() {
    const target = this.data.banTarget;
    if (!target || !target.userId) {
      wx.showToast({ title: '未选择用户', icon: 'none' });
      return;
    }
    if (this.data.loading) return;

    this.setData({ loading: true });
    try {
      const res = await post('/api/admin/banUser', {
        userId: target.userId,
        durationType: this.data.banDurationType,
        custom: this.data.banCustom,
        reason: String(this.data.banReason || '').trim()
      });
      this.closeBanModal();
      wx.showToast({ title: res.msg || '操作成功', icon: 'none' });
      // 封禁结果会同时影响封禁列表与用户列表，两个都刷新
      this.loadCurrent();
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 解除封禁 */
  unban(e) {
    const ds = e.currentTarget.dataset;
    const userId = Number(ds.userid);
    dialog.show(this, {
      title: '解除封禁',
      content: `确认解除 ${ds.useridtext || ''} ${ds.nickname || ''} 的接单封禁吗？`
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/admin/unbanUser', { userId });
        wx.showToast({ title: result.msg || '已解封', icon: 'none' });
        this.loadCurrent();
      } catch (err) {
        showError(err);
      }
    });
  },

  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  /** 审核通过 */
  approveAudit(e) {
    const applyId = e.currentTarget.dataset.id;
    dialog.show(this, {
      title: '审核通过',
      content: '确认通过该申请吗？'
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        await post('/api/audit/handle', { applyId, status: 2 });
        wx.showToast({ title: '已通过', icon: 'success' });
        this.loadAudits();
      } catch (err) {
        showError(err);
      }
    });
  },

  /** 审核驳回（必须填写驳回原因） */
  rejectAudit(e) {
    const applyId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回原因',
      editable: true,
      placeholderText: '请输入驳回原因',
      success: async (res) => {
        if (!res.confirm) return;
        const rejectReason = (res.content || '').trim();
        if (!rejectReason) {
          wx.showToast({ title: '驳回原因不能为空', icon: 'none' });
          return;
        }
        try {
          await post('/api/audit/handle', { applyId, status: 3, rejectReason });
          wx.showToast({ title: '已驳回', icon: 'success' });
          this.loadAudits();
        } catch (err) {
          showError(err);
        }
      }
    });
  },

  /** 回复申诉 */
  replyAppeal(e) {
    const appealId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '回复申诉',
      editable: true,
      placeholderText: '请输入回复内容',
      success: async (res) => {
        if (!res.confirm) return;
        const adminReply = (res.content || '').trim();
        if (!adminReply) {
          wx.showToast({ title: '回复内容不能为空', icon: 'none' });
          return;
        }
        try {
          await post('/api/appeal/reply', { appealId, adminReply });
          wx.showToast({ title: '回复成功', icon: 'success' });
          this.loadAppeals();
        } catch (err) {
          showError(err);
        }
      }
    });
  },

  /** 处理举报 */
  handleReport(e) {
    const reportId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '处理举报',
      editable: true,
      placeholderText: '请输入处理说明',
      success: async (res) => {
        if (!res.confirm) return;
        const adminNote = (res.content || '').trim();
        if (!adminNote) {
          wx.showToast({ title: '处理说明不能为空', icon: 'none' });
          return;
        }
        try {
          await post('/api/report/handle', { reportId, adminNote });
          wx.showToast({ title: '已处理', icon: 'success' });
          this.loadReports();
        } catch (err) {
          showError(err);
        }
      }
    });
  },

  /** 页面卸载：取消主题登记，避免已销毁的实例被长期持有 */
  onUnload() {
    theme.unsync(this);
  },

  // ==================== 批量删除（各 Tab 通用） ====================

  /**
   * 刷新某个模块的勾选统计
   * @param {string} module BATCH_CONFIG 的 key
   * @param {string} listKey 列表在 data 里的字段名
   */
  syncBatch(module, listKey) {
    const list = this.data[listKey] || [];
    const count = list.filter((item) => item._sel).length;
    const patch = {};
    patch['batch.' + module + '.count'] = count;
    patch['batch.' + module + '.all'] = list.length > 0 && count === list.length;
    patch['batch.' + module + '.text'] = count > 0
      ? formatText(MSG.BATCH_SELECTED, { count })
      : MSG.BATCH_NONE_SELECTED;
    this.setData(patch);
  },

  /** 勾选 / 取消勾选某一行（勾选框用 catchtap，不会触发卡片自身的点击） */
  batchToggle(e) {
    const { module, id } = e.currentTarget.dataset;
    const cfg = BATCH_CONFIG[module];
    if (!cfg) return;
    const targetId = Number(id);
    const list = (this.data[cfg.listKey] || []).map((item) => (
      Number(item[cfg.idField]) === targetId ? Object.assign({}, item, { _sel: !item._sel }) : item
    ));
    this.setData({ [cfg.listKey]: list });
    this.syncBatch(module, cfg.listKey);
  },

  /** 全选 / 取消全选当前列表 */
  batchSelectAll(e) {
    const module = e.currentTarget.dataset.module;
    const cfg = BATCH_CONFIG[module];
    if (!cfg) return;
    const list = this.data[cfg.listKey] || [];
    const allSelected = list.length > 0 && list.every((item) => item._sel);
    const next = list.map((item) => Object.assign({}, item, { _sel: !allSelected }));
    this.setData({ [cfg.listKey]: next });
    this.syncBatch(module, cfg.listKey);
  },

  /**
   * 一键删除选中
   * ---------------------------------------------------------------------
   * 二次确认后调用后端；后端只删「已结束」的记录（进行中的一律跳过），
   * 并把「删了几条、跳过了几条」放在 msg 里，这里直接原样提示给管理员。
   */
  batchDelete(e) {
    const module = e.currentTarget.dataset.module;
    const cfg = BATCH_CONFIG[module];
    if (!cfg) return;
    const list = this.data[cfg.listKey] || [];
    const ids = list
      .filter((item) => item._sel)
      .map((item) => Number(item[cfg.idField]))
      .filter((id) => id > 0);
    if (!ids.length) {
      wx.showToast({ title: MSG.BATCH_DELETE_EMPTY_TIP, icon: 'none' });
      return;
    }
    dialog.show(this, {
      title: MSG.BATCH_DELETE_CONFIRM_TITLE,
      content: formatText(MSG.BATCH_DELETE_CONFIRM_CONTENT, { count: ids.length }),
      confirmText: MSG.BATCH_DELETE,
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const isAnnounce = cfg.api === 'announceDelete';
        const result = await post(isAnnounce ? '/api/admin/announceDelete' : '/api/admin/batchDelete',
          isAnnounce ? { ids } : { module, ids });
        wx.showToast({ title: result.msg || MSG.BATCH_DELETE_DONE, icon: 'none' });
        this.loadCurrent();
      } catch (err) {
        showError(err);
      }
    });
  },

  /** 用户管理：显示 / 隐藏已注销账号（默认隐藏，见后端 userList 的 includeDeactivated） */
  toggleDeactivated() {
    this.setData({ includeDeactivated: !this.data.includeDeactivated });
    this.loadUsers().then(() => this.syncBatch('user', 'users'));
  },

  // ==================== 公告管理（跑马灯 / 全局通知条） ====================

  /** 公告列表 */
  async loadAnnounces() {
    this.setData({ loading: true });
    try {
      const res = await get('/api/admin/announceList', { page: 1, pageSize: 30 });
      const announces = (res.data.list || []).map((item) => ({
        ...item,
        _sel: false,
        timeText: filter.formatTime(item.createdAt, 'MM-DD HH:mm')
      }));
      this.setData({ announces });
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ loading: false });
    }
  },

  onAnnounceScopeChange(e) {
    this.setData({ announceScope: Number(e.currentTarget.dataset.value) });
  },

  onAnnounceInput(e) {
    this.setData({ announceContent: e.detail.value });
  },

  onAnnounceStartInput(e) {
    this.setData({ announceStart: e.detail.value });
  },

  onAnnounceEndInput(e) {
    this.setData({ announceEnd: e.detail.value });
  },

  toggleAnnouncePush() {
    this.setData({ announcePush: !this.data.announcePush });
  },

  toggleAnnounceClosable() {
    this.setData({ announceClosable: !this.data.announceClosable });
  },

  /**
   * 发布公告：只需填正文，其余（标题摘取、推送消息中心）由后端完成
   * 生效时间可留空 = 立即生效 / 长期有效
   */
  async submitAnnounce() {
    if (this.data.announceSubmitting) return;
    const content = String(this.data.announceContent || '').trim();
    if (!content) {
      wx.showToast({ title: MSG.ANNOUNCE_CONTENT_EMPTY, icon: 'none' });
      return;
    }
    this.setData({ announceSubmitting: true });
    try {
      const result = await post('/api/admin/announceCreate', {
        scope: this.data.announceScope,
        content,
        startAt: normalizeTimeText(this.data.announceStart),
        endAt: normalizeTimeText(this.data.announceEnd),
        isClosable: this.data.announceClosable,
        pushMessage: this.data.announcePush
      });
      wx.showToast({ title: result.msg || MSG.ANNOUNCE_PUBLISHED, icon: 'success' });
      this.setData({ announceContent: '', announceStart: '', announceEnd: '' });
      this.loadAnnounces().then(() => this.syncBatch('announce', 'announces'));
    } catch (err) {
      showError(err);
    } finally {
      this.setData({ announceSubmitting: false });
    }
  },

  /** 上架 / 下架一条公告 */
  toggleAnnounceActive(e) {
    const id = Number(e.currentTarget.dataset.id);
    const active = String(e.currentTarget.dataset.active) !== 'true';
    post('/api/admin/announceToggle', { id, isActive: active })
      .then((result) => {
        wx.showToast({ title: result.msg || '', icon: 'none' });
        this.loadAnnounces().then(() => this.syncBatch('announce', 'announces'));
      })
      .catch(showError);
  },

  /** 删除单条公告（走批量删除接口，传一个 id） */
  deleteAnnounceOne(e) {
    const id = Number(e.currentTarget.dataset.id);
    dialog.show(this, {
      title: MSG.BATCH_DELETE_CONFIRM_TITLE,
      content: formatText(MSG.BATCH_DELETE_CONFIRM_CONTENT, { count: 1 }),
      confirmText: MSG.DELETE,
      danger: true
    }).then(async (res) => {
      if (!res.confirm) return;
      try {
        const result = await post('/api/admin/announceDelete', { ids: [id] });
        wx.showToast({ title: result.msg || MSG.ANNOUNCE_DELETED, icon: 'none' });
        this.loadAnnounces().then(() => this.syncBatch('announce', 'announces'));
      } catch (err) {
        showError(err);
      }
    });
  }

});
