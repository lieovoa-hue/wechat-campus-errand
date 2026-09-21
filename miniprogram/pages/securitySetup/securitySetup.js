/**
 * 设置 / 修改密保问题
 * =====================================================================
 * 业务规则：
 *  1. 注册成功后必须先设置密保问题才能使用小程序（其它业务接口会被后端 428 拦截）；
 *  2. 共 2 道题，既可选题库内置题，也可选择「自定义问题（自行填写）」自行输入题目文本；
 *  3. 两道题不能相同；自定义问题长度受后端字典约束（minQuestionLen ~ maxQuestionLen）；
 *  4. 答案至少 minAnswerLen 个字符，且不能与问题内容相同；空 格 与大小写由后端统一规范化；
 *  5. 答案在后端「去空格 + 转小写」后 bcrypt 哈希存储，数据库绝不出现明文；
 *  6. 修改已有密保时，必须先答对当前密保（防止令牌被盗后直接换绑）；当前题目与下方新密保互不影响；
 *  7. 页面布局：每道题「上方是问题、下方是答案」，避免问题与答案挤在同一行导致误填。
 * =====================================================================
 */

const { post, showError } = require('../../utils/request');
const theme = require('../../utils/theme');
const {
  BIZ, MSG, SECURITY_QUESTIONS, SECURITY_STATUS
} = require('../../utils/constant');

const app = getApp();

// 「自定义问题」在 picker 选项列表中的下标（题库末尾追加一项）
const CUSTOM_INDEX = SECURITY_QUESTIONS.length;

/**
 * 密保答案规范化：去掉所有空白字符并转小写（与后端 normalizeAnswer 完全一致）
 * @param {string} value 原始输入
 * @returns {string} 规范化结果
 */
function normalizeAnswer(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

Page({
  data: {
    // 页面根节点的主题类（浅色 theme-light / 深色 theme-dark），模块加载时同步取一次，
    // 首帧就是正确主题；后续由 onShow 里的 theme.sync(this) 持续校准
    themeClass: theme.getClass(),
    // 密保题库（与后端 constant.js 完全一致）
    questions: SECURITY_QUESTIONS,
    // picker 可选范围 = 题库 + 「自定义问题（自行填写）」
    pickerRange: SECURITY_QUESTIONS.concat([MSG.SECURITY_CUSTOM_QUESTION]),
    // 自定义选项下标，wxml 中据此判断是否显示自定义问题输入框
    customIndex: CUSTOM_INDEX,

    // 新密保：picker 选中下标（等于自定义下标时表示自定义）与用户输入的自定义题目文本
    qIndex: [0, 1],
    qCustom: ['', ''],
    // picker 显示用的 value（与 qIndex 同步）
    pickerValue: [0, 1],
    // picker 上方展示的题目文本（内置题 = 题库原文；自定义 = 用户输入或占位提示）
    qText: [SECURITY_QUESTIONS[0], SECURITY_QUESTIONS[1]],

    // 新答案
    answers: ['', ''],

    // 修改模式：账号当前已设置的 2 道题 + 需先验证的当前答案
    currentQuestions: [],
    currentAnswers: ['', ''],

    isModify: false,
    fromRegister: false,
    securityStatusText: SECURITY_STATUS[0],
    minAnswerLen: BIZ.SECURITY_ANSWER_MIN_LEN,
    minQuestionLen: BIZ.SECURITY_QUESTION_MIN_LEN,
    maxQuestionLen: BIZ.SECURITY_QUESTION_MAX_LEN,
    submitting: false
  },

  onLoad(query) {
    const info = app.globalData.userInfo || {};
    const isModify = Number(info.securitySet) === 1;

    // 新密保选择器默认值：修改模式下回显用户当前的 2 道题（自定义题自动切到「自定义」并带出原文）
    let qIndex = [0, 1];
    const qCustom = ['', ''];
    const currentQuestions = [];
    if (isModify && Array.isArray(info.securityQuestions) && info.securityQuestions.length === 2) {
      info.securityQuestions.forEach((text, i) => {
        const raw = String(text || '');
        currentQuestions.push(raw);
        const bankIndex = SECURITY_QUESTIONS.indexOf(raw);
        if (bankIndex >= 0) {
          qIndex[i] = bankIndex;
        } else {
          // 不在题库中 → 说明该题是自定义问题
          qIndex[i] = CUSTOM_INDEX;
          qCustom[i] = raw;
        }
      });
    }

    this.setData({
      isModify,
      fromRegister: (query && query.from) === 'register',
      qIndex,
      pickerValue: qIndex.slice(),
      qCustom,
      qText: this.buildQText(qIndex, qCustom),
      currentQuestions,
      securityStatusText: SECURITY_STATUS[isModify ? 1 : 0]
    });
  },

  /**
   * 依据选中下标与自定义文本，计算 picker 展示文本
   * @param {number[]} qIndex 选中下标数组
   * @param {string[]} qCustom 自定义题目文本数组
   * @returns {string[]} 展示文本
   */
  buildQText(qIndex, qCustom) {
    return qIndex.map((index, i) => {
      if (index !== CUSTOM_INDEX) return SECURITY_QUESTIONS[index] || '';
      return String(qCustom[i] || '').trim() || MSG.SECURITY_CUSTOM_QUESTION;
    });
  },

  /** 选择第 index 道密保问题 */
  onQuestionChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = Number(e.detail.value);
    const qIndex = this.data.qIndex.slice();
    qIndex[index] = value;

    // 两道都选内置题时不允许撞题：撞题自动顺延到下一题，避免提交后才被驳回
    if (value !== CUSTOM_INDEX && qIndex[0] === qIndex[1]) {
      qIndex[index] = (value + 1) % SECURITY_QUESTIONS.length;
      wx.showToast({ title: MSG.SECURITY_QUESTION_DUPLICATE, icon: 'none' });
    }

    this.setData({
      qIndex,
      pickerValue: qIndex.slice(),
      qText: this.buildQText(qIndex, this.data.qCustom)
    });
  },

  /** 自定义问题文本输入 */
  onCustomQuestionInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const qCustom = this.data.qCustom.slice();
    qCustom[index] = e.detail.value;
    this.setData({
      qCustom,
      qText: this.buildQText(this.data.qIndex, qCustom)
    });
  },

  /** 新答案输入 */
  onAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const answers = this.data.answers.slice();
    answers[index] = e.detail.value;
    this.setData({ answers });
  },

  /** 当前答案输入（仅修改模式使用） */
  onCurrentAnswerInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const currentAnswers = this.data.currentAnswers.slice();
    currentAnswers[index] = e.detail.value;
    this.setData({ currentAnswers });
  },

  /**
   * 提交前本地校验：收集最终题目文本并逐步检查
   * @returns {string[]|null} 校验通过返回 2 道题目文本，否则返回 null（已弹出提示）
   */
  collectQuestions() {
    const { qIndex, qCustom, minQuestionLen, maxQuestionLen } = this.data;
    const questions = [];

    for (let i = 0; i < BIZ.SECURITY_QUESTION_COUNT; i += 1) {
      if (qIndex[i] === CUSTOM_INDEX) {
        const text = String(qCustom[i] || '').trim();
        if (!text) {
          wx.showToast({ title: MSG.SECURITY_CUSTOM_QUESTION_REQUIRED, icon: 'none' });
          return null;
        }
        // 长度按后端同一套字典校验（后端还会在 HTML 转义后再校验一次，双向兜底）
        if (text.length < minQuestionLen) {
          wx.showToast({ title: MSG.SECURITY_QUESTION_TOO_SHORT, icon: 'none' });
          return null;
        }
        if (text.length > maxQuestionLen) {
          wx.showToast({ title: MSG.SECURITY_QUESTION_TOO_LONG, icon: 'none' });
          return null;
        }
        questions.push(text);
      } else {
        questions.push(SECURITY_QUESTIONS[qIndex[i]]);
      }
    }

    if (questions[0] === questions[1]) {
      wx.showToast({ title: MSG.SECURITY_QUESTION_DUPLICATE, icon: 'none' });
      return null;
    }
    return questions;
  },

  /** 提交设置 / 修改 */
  async doSubmit() {
    const { answers, currentAnswers, isModify, fromRegister } = this.data;
    if (this.data.submitting) return;

    // 题目校验（含自定义问题长度、两道不重复）
    const questions = this.collectQuestions();
    if (!questions) return;

    if (!answers[0] || !answers[1]) {
      wx.showToast({ title: MSG.SECURITY_ANSWER_REQUIRED, icon: 'none' });
      return;
    }
    if (normalizeAnswer(answers[0]).length < this.data.minAnswerLen
      || normalizeAnswer(answers[1]).length < this.data.minAnswerLen) {
      wx.showToast({ title: MSG.SECURITY_ANSWER_TOO_SHORT, icon: 'none' });
      return;
    }
    // 答案不能与题目内容相同（自定义问题同样适用）
    if (questions.some((question, i) => normalizeAnswer(question) === normalizeAnswer(answers[i]))) {
      wx.showToast({ title: MSG.SECURITY_ANSWER_SAME_AS_QUESTION, icon: 'none' });
      return;
    }
    if (isModify && (!currentAnswers[0] || !currentAnswers[1])) {
      wx.showToast({ title: MSG.SECURITY_CURRENT_ANSWER_REQUIRED, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });

    try {
      await post('/api/user/setSecurity', {
        questions,
        answers,
        currentAnswers: isModify ? currentAnswers : []
      });

      wx.showToast({ title: isModify ? '密保已更新' : '密保设置成功', icon: 'success' });
      // 刷新全局用户信息，让 profile 等页面立刻看到 securitySet = 1
      await app.refreshUserInfo();

      setTimeout(() => {
        if (fromRegister) {
          wx.switchTab({ url: '/pages/index/index' });
        } else {
          wx.navigateBack();
        }
      }, 800);
    } catch (err) {
      showError(err);
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