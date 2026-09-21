/**
 * =====================================================================
 * 密码哈希工具（bcrypt）
 * 优先使用原生 bcrypt，若未安装原生模块则自动降级到 bcryptjs
 * （两者算法完全一致，$2a$/$2b$ 哈希可互通），保证任何环境都能跑起来。
 * 数据库中永远只存哈希，绝不出现明文密码。
 * =====================================================================
 */

const { log } = require('./common');

let bcryptLib;
try {
  // 原生实现，性能更好
  bcryptLib = require('bcrypt');
} catch (err) {
  // 降级到纯 JS 实现
  bcryptLib = require('bcryptjs');
  log('warn', '未检测到原生 bcrypt，已自动降级为 bcryptjs（功能一致）');
}

// 加盐轮数：10 轮在安全性与性能之间取得平衡
const SALT_ROUNDS = 10;

/**
 * 生成密码哈希
 * @param {string} plainPassword 明文密码
 * @returns {Promise<string>} bcrypt 哈希
 */
async function hashPassword(plainPassword) {
  return bcryptLib.hash(String(plainPassword), SALT_ROUNDS);
}

/**
 * 校验密码
 * @param {string} plainPassword 明文密码
 * @param {string} passwordHash 数据库中的哈希
 * @returns {Promise<boolean>} 是否匹配
 */
async function comparePassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  try {
    return await bcryptLib.compare(String(plainPassword), String(passwordHash));
  } catch (err) {
    // 哈希格式非法等异常，一律视为校验失败，不抛出到上层
    return false;
  }
}

module.exports = {
  SALT_ROUNDS,
  hashPassword,
  comparePassword
};
