/**
 * =====================================================================
 * 密钥强度启动自检
 * ---------------------------------------------------------------------
 * 背景：
 *   JWT_SECRET 是整套鉴权体系的根。一旦它是弱口令（例如开发期留下的
 *   `..._change_me_...`），攻击者可以离线爆破出密钥，然后【自行签发】
 *   任意 userId 的 access_token，直接冒充管理员，其余所有权限校验全部失效。
 *
 * 策略：
 *   启动时立刻校验，不符合要求就打印明确中文提示并退出进程（fail fast），
 *   绝不允许「带着弱密钥悄悄跑起来」。宁可起不来，也不上线一个能被伪造身份的版本。
 *
 * 校验项：
 *   1. 必须存在
 *   2. 长度不少于 MIN_SECRET_LENGTH
 *   3. 不能命中已知弱口令 / 占位符黑名单
 *   4. 不能是「全都一样的字符」这种明显随机性不足的值
 * =====================================================================
 */

const { log } = require('./common');

/** JWT_SECRET 最小长度（48 字符 ≈ 288 bit 熵上限，足够抗离线爆破） */
const MIN_SECRET_LENGTH = 32;

/** 已知的弱口令 / 模板占位符特征（命中即拒绝启动） */
const WEAK_PATTERNS = [
  /change[_-]?me/i,          // 各种 "change_me" 模板提示
  /^campus_errand_dev_secret/i, // 早期开发版默认密钥
  /^your[_-]?secret/i,       // 文档里的占位符
  /^secret$/i,
  /^jwt[_-]?secret$/i,
  /^123456/,
  /^password/i,
  /^test/i,
  /^dev/i
];

/**
 * 校验单个密钥的强度
 * @param {string} name 变量名（用于报错提示）
 * @param {string} value 密钥值
 * @returns {string} 校验失败原因，通过则返回空串
 */
function checkSecret(name, value) {
  if (!value) return `${name} 未配置`;
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} 长度只有 ${value.length}，至少需要 ${MIN_SECRET_LENGTH} 个字符`;
  }
  for (let i = 0; i < WEAK_PATTERNS.length; i += 1) {
    if (WEAK_PATTERNS[i].test(value)) {
      return `${name} 命中已知弱口令 / 模板占位符，必须更换为随机字符串`;
    }
  }
  // 全字符相同（如 aaaaaaaaaaaaaaaa…）随机性极低，同样拒绝
  if (/^(.)\1+$/.test(value)) {
    return `${name} 是重复字符，随机性不足`;
  }
  return '';
}

/**
 * 启动自检入口：不通过直接终止进程
 * 生成强密钥的命令见 .env 内注释，或执行：
 *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
 */
function assertSecretsStrong() {
  const problems = [];

  const jwtError = checkSecret('JWT_SECRET', process.env.JWT_SECRET);
  if (jwtError) problems.push(jwtError);

  // MEDIA_SIGN_SECRET 可选：不配则回退用 JWT_SECRET 派生，配了就必须同样强
  if (process.env.MEDIA_SIGN_SECRET) {
    const mediaError = checkSecret('MEDIA_SIGN_SECRET', process.env.MEDIA_SIGN_SECRET);
    if (mediaError) problems.push(mediaError);
  }

  if (problems.length) {
    log('error', '==================== 启动被拒绝：密钥强度不足 ====================');
    problems.forEach((item) => log('error', `  - ${item}`));
    log('error', '  生成强密钥（复制输出整行填到 backend/.env）：');
    log('error', '    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    log('error', '==================================================================');
    process.exit(1);
  }
}

module.exports = {
  MIN_SECRET_LENGTH,
  checkSecret,
  assertSecretsStrong
};
