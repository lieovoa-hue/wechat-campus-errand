/**
 * =====================================================================
 * 本地自检脚本：npm run check
 * 作用：
 *  1. 逐个 require 所有模块，提前暴露语法错误、路径错误、循环依赖
 *  2. 对核心纯函数（账号解析、账号ID格式化、XSS转义、金额校验）做断言
 *  3. 不连接数据库，可在数据库未就绪时执行
 * =====================================================================
 */

require('dotenv').config();

const path = require('path');
const assert = require('assert');

const files = [
  '../src/utils/constant',
  '../src/utils/common',
  '../src/utils/bcryptUtil',
  '../src/utils/jwtUtil',
  // 短信工具已下线（短信验证码改为服务端本地生成的图形验证码）
  '../src/utils/captchaUtil',
  '../src/utils/wxUtil',
  '../src/utils/payUtil',
  '../src/utils/secretGuard',
  '../src/utils/mediaSign',
  '../src/utils/garbageCleaner',
  '../src/db/db',
  '../src/middleware/auth',
  '../src/middleware/rateLimit',
  '../src/middleware/xssFilter',
  '../src/middleware/mediaGuard',
  '../src/models/User',
  '../src/models/Task',
  '../src/models/AuditApply',
  '../src/models/Appeal',
  '../src/models/Message',
  '../src/models/Report',
  '../src/models/Payment',
  '../src/models/Bill',
  '../src/models/Announcement',
  '../src/controllers/userController',
  '../src/controllers/taskController',
  '../src/controllers/auditController',
  '../src/controllers/appealController',
  '../src/controllers/messageController',
  '../src/controllers/reportController',
  '../src/controllers/payController',
  '../src/controllers/billController',
  '../src/controllers/adminController',
  '../src/controllers/announceController',
  '../src/routes/userRoutes',
  '../src/routes/taskRoutes',
  '../src/routes/auditRoutes',
  '../src/routes/appealRoutes',
  '../src/routes/messageRoutes',
  '../src/routes/reportRoutes',
  '../src/routes/payRoutes',
  '../src/routes/billRoutes',
  '../src/routes/adminRoutes',
  '../src/routes/announceRoutes',
  '../src/schedule/index'
];

console.log('=== 1. 模块加载检查 ===');
for (const file of files) {
  require(path.join(__dirname, file));
  console.log(`  [OK] ${file.replace('../', '')}`);
}

console.log('=== 2. 核心函数断言 ===');
const common = require('../src/utils/common');
const { TASK_STATUS, CODE_MSG } = require('../src/utils/constant');

// 账号编号：管理员 A + 4位补零，普通用户 X + 4位补零
assert.strictEqual(common.buildAccountNo(1, true), 'A0001');
assert.strictEqual(common.buildAccountNo(2, false), 'X0002');
assert.strictEqual(common.buildAccountNo(10000, false), 'X10000');
assert.strictEqual(common.formatUserId(1, 'X0001'), 'X0001');
assert.strictEqual(common.formatUserId(1, 'a0001'), 'A0001');
// 兜底：历史数据没有 account_no 时仍按主键四位补零输出
assert.strictEqual(common.formatUserId(23), '0023');
assert.strictEqual(common.formatUserId(12345), '12345');
console.log('  [OK] buildAccountNo / formatUserId 账号编号（A0001 / X0001）');

// 登录输入识别（账号ID / 学号 / 内部编号 三通道）
assert.strictEqual(common.parseAccount('A0001').type, 'account');
assert.strictEqual(common.parseAccount('A0001').value, 'A0001');
assert.strictEqual(common.parseAccount('a0001').value, 'A0001');
assert.strictEqual(common.parseAccount('X0001').value, 'X0001');
// 纯数字：6 位及以上优先当学号（11 位手机号也走这条通道，控制器再兜底按手机号匹配老账号）
assert.strictEqual(common.parseAccount('202502084').type, 'studentId');
assert.strictEqual(common.parseAccount('13800138000').type, 'studentId');
// 纯数字：1~5 位按内部编号（0001 / 001 / 1 都命中 id=1 的账号）
assert.strictEqual(common.parseAccount('0001').value, 1);
assert.strictEqual(common.parseAccount('001').value, 1);
assert.strictEqual(common.parseAccount('1').value, 1);
assert.strictEqual(common.parseAccount('abc').type, 'unknown');
console.log('  [OK] parseAccount 账号ID / 学号 / 内部编号自动识别');

// XSS 转义
assert.strictEqual(
  common.escapeHtml('<script>alert("x")&\'</script>'),
  '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;'
);
console.log('  [OK] escapeHtml XSS 转义');

// 金额解析
assert.strictEqual(common.parseMoney('0.1'), 0.1);
assert.strictEqual(common.parseMoney('1.999'), 2);
assert.strictEqual(common.parseMoney('-1'), null);
assert.strictEqual(common.parseMoney('abc'), null);
console.log('  [OK] parseMoney 金额解析');

// 分页
const page = common.parsePage({ page: '2', pageSize: '999' });
assert.strictEqual(page.page, 2);
assert.strictEqual(page.pageSize, 50);
console.log('  [OK] parsePage 分页上限保护');

// 幂等
assert.strictEqual(common.checkIdempotent('unit-test-key', 1000), true);
assert.strictEqual(common.checkIdempotent('unit-test-key', 1000), false);
console.log('  [OK] checkIdempotent 重复提交拦截');

// 状态字典完整性
assert.strictEqual(Object.keys(TASK_STATUS).length, 6);
assert.strictEqual(TASK_STATUS[2], '待雇主确认');
assert.strictEqual(CODE_MSG[423], '账号已锁定');
console.log('  [OK] 状态字典与错误码字典');

console.log('=== 全部自检通过 ===');
process.exit(0);
