/**
 * =====================================================================
 * 测试账号一键创建脚本（新版账号体系）
 *  数据被清空后，用它快速恢复一套可直接登录、可发布 / 可接单的测试账号。
 *
 * 新版账号体系说明（与旧版最大的区别）：
 *   1. 注册不再需要短信验证码，改为「图形验证码 + 自选账号ID」；
 *   2. 注册阶段不采集姓名 / 学号，姓名与学号在「校园认证」阶段提交；
 *   3. 注册后必须先设置密保问题，否则其它业务接口统一返回 428；
 *   4. 想让账号能发布 / 接单，必须走「提交校园认证 -> 管理员审核通过」。
 *
 * 管理员账号无法通过注册接口造出来（注册阶段没有学号，也就无法命中 .env 白名单），
 * 请使用工作目录下的「账号管理工具.bat」创建 / 维护管理员账号。
 *
 * 可通过环境变量覆盖：
 *   TEST_ADMIN_ACCOUNT / TEST_ADMIN_PASSWORD   管理员账号与密码
 *   TEST_USER_PHONE / TEST_USER_STUDENT_ID / TEST_USER_NAME   普通测试账号信息
 *   TEST_PASSWORD                              测试账号统一密码
 *
 * 运行：node scripts/createTestAccounts.js
 *
 * ⚠ 注意：脚本默认连 http://127.0.0.1:3000（正式服务），注册的账号会写进正式库！
 *   只想在测试库演练时，请先设置环境变量 SMOKE_BASE 指向测试服务。
 * =====================================================================
 */

const h = require('./_accountHelper');
const db = require('../src/db/db');

/** 待创建的普通测试账号定义 */
const ACCOUNTS = [
  {
    role: '普通测试用户（认证通过，可发布 / 可接单）',
    phone: process.env.TEST_USER_PHONE || h.testPhone(3001),
    studentId: process.env.TEST_USER_STUDENT_ID || '20259911',
    name: process.env.TEST_USER_NAME || '测试同学'
  }
];

const PASSWORD = process.env.TEST_PASSWORD || 'Abcd1234';

async function main() {
  console.log(`\n后端地址：${h.BASE}`);
  console.log('开始创建测试账号...\n');

  // ---------------- 1. 管理员账号自查 ----------------
  let adminToken = null;
  try {
    adminToken = await h.adminToken();
    console.log(`  [可用] 管理员账号 ${h.ADMIN_ACCOUNT} 登录成功，可用于审核校园认证`);
  } catch (err) {
    console.log(`  [提醒] 管理员账号不可用：${err.message}`);
    console.log('         校园认证将无法自动审核通过，可先用「账号管理工具.bat」创建管理员账号');
  }

  // ---------------- 2. 创建普通测试账号 ----------------
  for (const account of ACCOUNTS) {
    /* eslint-disable no-await-in-loop */
    const reg = await h.register({ phone: account.phone, password: PASSWORD, nickname: account.name });
    if (reg.res.code !== 200) {
      console.log(`  [失败] ${account.role} 注册失败：${reg.res.msg}`);
      continue;
    }
    const token = reg.res.data.accessToken;
    const setSecurity = await h.setSecurity(token);
    if (setSecurity.code !== 200) {
      console.log(`  [失败] ${account.role} 设置密保失败：${setSecurity.msg}`);
      continue;
    }

    let certText = '未提交校园认证';
    if (adminToken) {
      const apply = await h.submitCampusCert(token, {
        name: account.name, studentId: account.studentId, phone: account.phone
      });
      if (apply.code === 200) {
        const handled = await h.handleAudit(adminToken, apply.data.applyId, 2);
        certText = handled.code === 200 ? '校园认证已通过' : `校园认证审核失败：${handled.msg}`;
      } else {
        certText = `校园认证提交失败：${apply.msg}`;
      }
    }

    console.log(`  [成功] ${account.role}`);
    console.log(`         账号ID（登录用）: ${reg.accountNo}`);
    console.log(`         学号（登录用）  : ${account.studentId}`);
    console.log(`         手机号          : ${account.phone}`);
    console.log(`         密码            : ${PASSWORD}`);
    console.log(`         密保答案        : ${h.ANSWER_1} / ${h.ANSWER_2}`);
    console.log(`         认证状态        : ${certText}\n`);
  }

  console.log('提示：登录页输入「账号ID」或「学号」都可以登录；忘记密码走密保问题找回。');
  console.log('      学号命中后端 .env 的 ADMIN_STUDENT_IDS 白名单即自动成为管理员（需重启后端生效）。\n');
  await db.closePool();
}

main().catch(async (err) => {
  console.error('创建测试账号异常：', err.message);
  try {
    await db.closePool();
  } catch (closeErr) {
    // 忽略关闭异常
  }
  process.exit(1);
});