/**
 * =====================================================================
 * XSS 过滤中间件
 * 对所有入参（body / query / params）中的字符串做 HTML 特殊字符转义：
 *   <  >  &  "  '
 * 密码类字段不做转义（避免破坏用户密码原文），但仍受参数化 SQL 保护。
 * =====================================================================
 */

const { escapeHtml } = require('../utils/common');

// 不做转义的字段（密码 / 验证码），这些字段仅参与哈希比对，不落库展示
const SKIP_KEYS = new Set([
  'password',
  'oldPassword',
  'newPassword',
  'confirmPassword',
  'passwordHash',
  'code',
  'smsCode'
]);

/**
 * 递归转义对象中的字符串
 * @param {*} target 目标对象/数组/值
 * @param {string} [parentKey] 父级字段名
 * @returns {*} 处理后的对象
 */
function escapeDeep(target, parentKey = '') {
  if (target === null || target === undefined) return target;

  if (typeof target === 'string') {
    return SKIP_KEYS.has(parentKey) ? target : escapeHtml(target);
  }
  if (Array.isArray(target)) {
    return target.map((item) => escapeDeep(item, parentKey));
  }
  if (typeof target === 'object') {
    for (const key of Object.keys(target)) {
      target[key] = escapeDeep(target[key], key);
    }
    return target;
  }
  return target;
}

/**
 * 中间件主体
 */
function xssFilter(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      escapeDeep(req.body);
    }
    if (req.query && typeof req.query === 'object') {
      escapeDeep(req.query);
    }
    if (req.params && typeof req.params === 'object') {
      escapeDeep(req.params);
    }
  } catch (err) {
    // 转义失败不阻断请求，交由业务层参数校验兜底
  }
  next();
}

module.exports = xssFilter;
module.exports.escapeDeep = escapeDeep;
