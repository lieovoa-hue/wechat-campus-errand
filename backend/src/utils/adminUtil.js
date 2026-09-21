/**
 * =====================================================================
 * 管理员白名单工具
 * ---------------------------------------------------------------------
 * 【安全红线】管理员权限只认 .env 中的 ADMIN_STUDENT_IDS 硬编码学号白名单，
 *            绝不依赖数据库 users.is_admin 字段（该字段仅用于前端标识展示）。
 * 本模块被 middleware/auth.js、models、controllers 共同复用，
 * 避免多处重复读取环境变量导致口径不一致。
 * =====================================================================
 */

require('dotenv').config();

const { ROLE_TAG, USER_ROLE_ENUM } = require('./constant');

/**
 * 读取管理员学号白名单（.env ADMIN_STUDENT_IDS，逗号分隔）
 * @returns {string[]} 去空格、去空项后的学号数组
 */
function getAdminStudentIds() {
  return String(process.env.ADMIN_STUDENT_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 判断学号是否命中管理员白名单（硬校验）
 * @param {string|number} studentId 学号
 * @returns {boolean}
 */
function isAdminStudent(studentId) {
  if (studentId === undefined || studentId === null || studentId === '') return false;
  return getAdminStudentIds().includes(String(studentId).trim());
}

/**
 * 角色标识文案（前端展示用，文案统一取自 constant.js 字典）
 * @param {boolean} isAdmin 是否管理员
 * @returns {string} 管理员 / 普通用户
 */
function roleTagOf(isAdmin) {
  return isAdmin ? ROLE_TAG[USER_ROLE_ENUM.ADMIN] : ROLE_TAG[USER_ROLE_ENUM.NORMAL];
}

/**
 * 生成 IN (?, ?, ...) 占位符，供参数化查询使用（绝不拼接用户输入）
 * @param {number} count 占位符数量
 * @returns {string}
 */
function buildPlaceholders(count) {
  return new Array(Number(count) || 0).fill('?').join(', ');
}

/**
 * 消息 / 日志中展示的用户名
 * 管理员自动带角色前缀，让接收方一眼看出对方是管理员（管理员标识对其他人可见）
 * @param {string} nickname 昵称
 * @param {string|number} studentId 学号
 * @returns {string}
 */
function displayNickname(nickname, studentId) {
  const name = String(nickname || '');
  return isAdminStudent(studentId) ? `${ROLE_TAG[USER_ROLE_ENUM.ADMIN]}·${name}` : name;
}

module.exports = {
  getAdminStudentIds,
  isAdminStudent,
  roleTagOf,
  displayNickname,
  buildPlaceholders
};
