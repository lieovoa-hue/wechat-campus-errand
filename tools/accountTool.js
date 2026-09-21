/**
 * =====================================================================
 * 校园跑腿 · 账号管理工具（交互式命令行，本地运维专用）
 * ---------------------------------------------------------------------
 * 位置：D:\miniprogram123\tools\accountTool.js
 * 运行：双击工作目录下的「账号管理工具.bat」，或执行 node tools/accountTool.js
 *
 * 功能一览：
 *   1. 查看账号列表：支持按 账号编号 / 学号 / 手机号 / 昵称 / 姓名 模糊搜索
 *   2. 新建账号：学号、手机号、密码、姓名、昵称、校园认证状态、管理员权限 全部可填
 *   3. 修改账号：以上字段（含密码）随时可改；改管理员会自动同步 .env 白名单
 *   4. 注销账号：软删除。历史任务 / 账单 / 消息保留，手机号与学号释放给新账号复用
 *   5. 彻底删除账号：仅当该账号没有任何业务数据时才允许，避免破坏外键完整性
 *   6. 管理员白名单管理：添加 / 移除管理员
 *
 * 【三条硬规则，与线上后端完全一致】
 *   1. 管理员权限的唯一依据是 backend/.env 里的 ADMIN_STUDENT_IDS 学号白名单，
 *      不是数据库 users.is_admin 字段（那个字段只用于前端展示「管理员」标识）。
 *      因此本工具在「设为管理员」时会同时写入白名单 + 数据库标记，两处都改，
 *      避免出现「看着是管理员却没有权限」或「有权限但不显示标识」的错位。
 *   2. 密码一律 bcrypt 哈希后入库，数据库里永远不会出现明文密码。
 *   3. 所有 SQL 都是参数化查询（? 占位符），绝不拼接字符串。
 *
 * 【什么时候需要重启后端】
 *   只有改到 .env（管理员白名单）才需要重启；改数据库内容（学号 / 手机号 / 密码等）即时生效。
 * =====================================================================
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, 'backend', '.env');
const BACKEND = path.join(ROOT, 'backend');

// 本工具放在工作目录的 tools\ 下，而 npm 依赖（dotenv / mysql2 / bcrypt）都安装在
// backend\node_modules 里。用 createRequire 以 backend 为基准解析依赖，
// 这样双击运行时不会报「Cannot find module 'dotenv'」。
const backendRequire = createRequire(path.join(BACKEND, 'package.json'));

// 环境变量必须先加载：db.js / adminUtil.js 都依赖 backend/.env 里的配置
backendRequire('dotenv').config({ path: ENV_PATH });

const db = require(path.join(BACKEND, 'src', 'db', 'db'));
const User = require(path.join(BACKEND, 'src', 'models', 'User'));
const { hashPassword } = require(path.join(BACKEND, 'src', 'utils', 'bcryptUtil'));
const { buildAccountNo, isPhone } = require(path.join(BACKEND, 'src', 'utils', 'common'));
const { getAdminStudentIds } = require(path.join(BACKEND, 'src', 'utils', 'adminUtil'));
const {
  ACCOUNT_NO_RULE, ACCOUNT_STATUS, CAMPUS_AUDIT, CAMPUS_AUDIT_ENUM,
  ROLE_TAG, USER_ROLE_ENUM, BAN_STATUS, BAN_STATUS_ENUM
} = require(path.join(BACKEND, 'src', 'utils', 'constant'));

// ---------------- 交互输入基础 ----------------

// readline 采用「懒创建」：等到第一次真正要提问时才创建。
// 这样无论是人工交互，还是用管道喂入一串答案（自动化测试），输入都不会提前被读完丢弃。
let rlInstance = null;
let rlClosed = false;
const lineQueue = [];   // 已到达但还没被消费的整行输入
const lineWaiters = []; // 正在等待输入的回调
const EOF = Symbol('EOF');

/**
 * 取 readline 实例（首次调用时创建）
 * 【为什么自己维护行队列】
 *   readline 的 rl.question() 是「一次一问」：如果一行以上的输入同时到达
 *   （管道喂答案、或用户一次粘贴多行），只有第一行会被 question 的回调接走，
 *   其余行会被直接丢弃，导致后面的提问永远等不到输入而卡死。
 *   这里改成统一监听 line 事件并把输入放进队列，ask() 从队列里取，
 *   交互输入与管道输入都不会丢行。
 */
function getRl() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
    rlInstance.on('line', (lineText) => {
      const waiter = lineWaiters.shift();
      if (waiter) waiter(String(lineText));
      else lineQueue.push(String(lineText));
    });
    rlInstance.on('close', () => {
      rlClosed = true;
      // 输入流结束：把还在等待的提问全部唤醒，避免脚本卡死
      while (lineWaiters.length) lineWaiters.shift()(EOF);
    });
  }
  return rlInstance;
}

/** 读取一行输入（返回 EOF 表示输入流已结束） */
function readLine() {
  getRl();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (rlClosed) return Promise.resolve(EOF);
  return new Promise((resolve) => { lineWaiters.push(resolve); });
}

/** 提问并读取一行；直接回车时返回 defaultValue */
async function ask(question, defaultValue) {
  const hint = defaultValue === undefined || defaultValue === '' ? '' : '（回车默认：' + defaultValue + '）';
  process.stdout.write(question + hint + ' ');
  const answer = await readLine();
  // 输入流结束（管道答案用完）时按默认值返回，避免抛异常
  if (answer === EOF) return String(defaultValue === undefined ? '' : defaultValue);
  const text = String(answer).trim();
  return text === '' ? String(defaultValue === undefined ? '' : defaultValue) : text;
}

/** 必填提问：空输入会一直重问 */
async function askRequired(question) {
  for (;;) {
    const text = await ask(question);
    if (text) return text;
    console.log('  [×] 该项为必填，不能为空');
  }
}

/** 可选项提问：直接回车表示「不修改」，返回 null */
async function askOptional(question, current) {
  const hint = current === undefined || current === null || current === '' ? '' : '，当前：' + current;
  const text = await ask(question + hint + '（回车=不修改）');
  return text === '' ? null : text;
}

/** 是 / 否提问 */
async function askYesNo(question, def) {
  for (;;) {
    const text = (await ask(question + '（y/n）', def ? 'y' : 'n')).toLowerCase();
    if (text === 'y' || text === 'yes') return true;
    if (text === 'n' || text === 'no') return false;
    console.log('  [×] 请输入 y 或 n');
  }
}

/** 等待回车，避免菜单刷屏后用户看不到结果 */
function pause() {
  return ask('按回车返回主菜单...');
}

function title(text) {
  console.log('');
  console.log('======== ' + text + ' ========');
}

/** 计算显示宽度：中日韩全角字符算 2，其余算 1，用于命令行表格对齐 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格 */
function pad(text, width) {
  const s = String(text === undefined || text === null ? '' : text);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

// ---------------- .env 管理员白名单读写 ----------------

/** 读取 .env 里的管理员学号白名单 */
function readWhitelist() {
  return getAdminStudentIds();
}

/**
 * 把管理员学号白名单写回 backend/.env
 * 只替换 ADMIN_STUDENT_IDS 那一行，其余内容原样保留（含 CRLF 换行与注释）
 * @param {string[]} ids 学号数组
 */
function writeWhitelist(ids) {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const line = 'ADMIN_STUDENT_IDS=' + ids.join(',');
  const re = /^[ \t]*ADMIN_STUDENT_IDS=.*$/m;
  const next = re.test(text)
    ? text.replace(re, line)
    : text.replace(/\s*$/, '\n' + line + '\n');
  fs.writeFileSync(ENV_PATH, next, 'utf8');
  // 同步更新当前进程的环境变量。
  // 后端要重启才会重新读 .env，但工具自己必须立刻按新白名单显示角色/权限，
  // 否则刚设成管理员的账号在本工具里还会显示「普通用户」，也绕不过管理员保护。
  process.env.ADMIN_STUDENT_IDS = ids.join(',');
}

/** 新增一个管理员学号（已存在则原样返回） */
function addToWhitelist(studentId) {
  const ids = readWhitelist();
  const target = String(studentId).trim();
  if (ids.includes(target)) return false;
  ids.push(target);
  writeWhitelist(ids);
  return true;
}

/** 从白名单移除一个管理员学号 */
function removeFromWhitelist(studentId) {
  const ids = readWhitelist();
  const target = String(studentId).trim();
  const next = ids.filter((item) => item !== target);
  if (next.length === ids.length) return false;
  writeWhitelist(next);
  return true;
}

// ---------------- 数据库查询helper ----------------

/** 查询用户列表（keyword 为空则查全部） */
async function queryUsers(keyword) {
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(account_no LIKE ? OR student_id LIKE ? OR phone LIKE ? OR nickname LIKE ? OR name LIKE ?)');
    const like = '%' + keyword + '%';
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.query(
    'SELECT id, account_no, student_id, phone, name, nickname, is_campus_audit, is_admin,'
    + ' deactivated_at, ban_take_time, last_login_time, created_at'
    + ' FROM users' + whereSql + ' ORDER BY id ASC LIMIT 200',
    params
  );
}

/** 按主键取单个用户 */
async function findUserById(userId) {
  const rows = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

/** 学号是否已被别的账号占用 */
async function isStudentIdTaken(studentId, exceptUserId) {
  const rows = exceptUserId
    ? await db.query('SELECT id, account_no FROM users WHERE student_id = ? AND id <> ? LIMIT 1', [studentId, exceptUserId])
    : await db.query('SELECT id, account_no FROM users WHERE student_id = ? LIMIT 1', [studentId]);
  return rows[0] || null;
}

/** 手机号是否已被别的账号占用 */
async function isPhoneTaken(phone, exceptUserId) {
  const rows = exceptUserId
    ? await db.query('SELECT id, account_no FROM users WHERE phone = ? AND id <> ? LIMIT 1', [phone, exceptUserId])
    : await db.query('SELECT id, account_no FROM users WHERE phone = ? LIMIT 1', [phone]);
  return rows[0] || null;
}

/** 账号编号是否已被占用 */
async function isAccountNoTaken(accountNo) {
  const rows = await db.query('SELECT id FROM users WHERE account_no = ? LIMIT 1', [accountNo]);
  return !!rows[0];
}

/** 取下一个账号编号序号（前缀 A=管理员 / X=普通用户） */
async function nextSeq(prefix, conn) {
  const sql = 'SELECT COALESCE(MAX(CAST(SUBSTRING(account_no, 2) AS UNSIGNED)), 0) AS maxSeq'
    + ' FROM users WHERE account_no LIKE ?';
  const rows = conn ? (await conn.execute(sql, [prefix + '%']))[0] : await db.query(sql, [prefix + '%']);
  const maxSeq = rows[0] ? Number(rows[0].maxSeq) : 0;
  return (Number.isFinite(maxSeq) ? maxSeq : 0) + 1;
}

/** 生成一个数据库里不存在的邀请码（与本项目其它脚本保持同一套字符集） */
async function generateUniqueInviteCode(conn) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i += 1) {
    let code = '';
    for (let j = 0; j < 8; j += 1) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    const rows = conn
      ? (await conn.execute('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [code]))[0]
      : await db.query('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
}

// ---------------- 展示 ----------------

/** 账号列表表格 */
function printUserList(rows) {
  if (!rows.length) {
    console.log('  （没有符合条件的账号）');
    return;
  }
  const header = [
    pad('序号', 4), pad('ID', 6), pad('账号编号', 10), pad('学号', 14), pad('手机号', 13),
    pad('姓名', 10), pad('昵称', 12), pad('认证', 10), pad('角色', 10), pad('状态', 8)
  ].join(' ');
  console.log('  ' + header);
  console.log('  ' + '-'.repeat(displayWidth(header)));
  rows.forEach((row, index) => {
    const isAdmin = getAdminStudentIds().includes(String(row.student_id));
    const deactivated = !!row.deactivated_at;
    const banned = !!row.ban_take_time && new Date(row.ban_take_time).getTime() > Date.now();
    const statusText = deactivated
      ? ACCOUNT_STATUS[1]
      : BAN_STATUS[banned ? BAN_STATUS_ENUM.BANNED : BAN_STATUS_ENUM.NORMAL];
    console.log('  ' + [
      pad(index + 1, 4),
      pad(row.id, 6),
      pad(row.account_no || '', 10),
      pad(deactivated ? '' : row.student_id, 14),
      pad(deactivated ? '' : row.phone, 13),
      pad(deactivated ? '' : row.name, 10),
      pad(deactivated ? '' : row.nickname, 12),
      pad(CAMPUS_AUDIT[isAdmin ? CAMPUS_AUDIT_ENUM.PASS : row.is_campus_audit] || '', 10),
      pad(ROLE_TAG[isAdmin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL], 10),
      pad(statusText, 8)
    ].join(' '));
  });
  console.log('');
  console.log('  共 ' + rows.length + ' 个账号');
}

/** 单个账号详情 */
function printUserDetail(row, index) {
  const isAdmin = getAdminStudentIds().includes(String(row.student_id));
  const deactivated = !!row.deactivated_at;
  console.log('');
  console.log('  ' + (index === undefined ? '' : '[' + index + '] ') + '账号详情');
  console.log('  ------------------------------------------------');
  console.log('  数据库主键 id ：' + row.id);
  console.log('  账号编号      ：' + (row.account_no || '（空）') + '   ←  登录页「账号」可填这个');
  console.log('  学号          ：' + (deactivated ? '（已注销）' : row.student_id));
  console.log('  手机号        ：' + (deactivated ? '（已注销）' : row.phone));
  console.log('  真实姓名      ：' + (deactivated ? '（已注销）' : row.name));
  console.log('  昵称          ：' + (deactivated ? '（已注销）' : row.nickname));
  console.log('  校园认证      ：' + (CAMPUS_AUDIT[isAdmin ? CAMPUS_AUDIT_ENUM.PASS : row.is_campus_audit] || ''));
  console.log('  角色          ：' + ROLE_TAG[isAdmin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL]
    + (isAdmin ? '（学号在白名单里，拥有后台全部权限）' : ''));
  console.log('  账号状态      ：' + (deactivated ? ACCOUNT_STATUS[1] : ACCOUNT_STATUS[0]));
  if (row.ban_take_time) {
    console.log('  接单封禁至    ：' + row.ban_take_time);
  }
  console.log('  邀请码        ：' + (row.invite_code || '（无）'));
  console.log('  最后登录      ：' + (row.last_login_time || '（从未登录）'));
  console.log('  注册时间      ：' + (row.created_at || ''));
  console.log('');
}

/** 搜索并让用户选中一个账号 */
async function pickUser(promptText) {
  const keyword = await ask(promptText || '输入关键词搜索（账号编号 / 学号 / 手机号 / 昵称 / 姓名，直接回车=列出全部）');
  const rows = await queryUsers(keyword);
  if (!rows.length) {
    console.log('  [×] 没有搜索到账号');
    return null;
  }
  printUserList(rows);
  if (rows.length === 1) {
    return rows[0];
  }
  const choice = await ask('请输入要操作的「序号」（直接回车=取消）');
  if (!choice) return null;
  const index = Number(choice);
  if (!Number.isInteger(index) || index < 1 || index > rows.length) {
    console.log('  [×] 序号不合法');
    return null;
  }
  return rows[index - 1];
}

// ---------------- 功能：查看账号列表 ----------------

async function menuList() {
  title('账号列表');
  const keyword = await ask('输入关键词搜索（直接回车=列出全部）');
  const rows = await queryUsers(keyword);
  printUserList(rows);
  await pause();
}

// ---------------- 功能：新建账号 ----------------

/** 询问校园认证状态，返回 0/1/2/3 */
async function askCampusAudit(def) {
  console.log('  校园认证状态可选：0=' + CAMPUS_AUDIT[0] + '  1=' + CAMPUS_AUDIT[1]
    + '  2=' + CAMPUS_AUDIT[2] + '  3=' + CAMPUS_AUDIT[3]);
  for (;;) {
    const text = await ask('校园认证状态', String(def));
    const num = Number(text);
    if ([0, 1, 2, 3].includes(num)) return num;
    console.log('  [×] 只能填 0 / 1 / 2 / 3');
  }
}

async function menuCreate() {
  title('新建账号');
  console.log('  提示：带 * 的是必填项；直接回车表示使用默认值');
  console.log('');

  const studentId = await askRequired('* 学号');
  if (await isStudentIdTaken(studentId)) {
    console.log('  [×] 该学号已经被占用，新建取消');
    await pause();
    return;
  }

  const isAdmin = await askYesNo('  是否设为管理员？', false);

  let phone = await askRequired('* 手机号（管理员可用非常规号码，如 20240001）');
  // 普通用户必须是合法的大陆手机号，与注册接口保持同一套校验；管理员放宽
  while (!isAdmin && !isPhone(phone)) {
    console.log('  [×] 手机号格式不正确（必须是 1 开头的 11 位数字）');
    phone = await askRequired('* 手机号');
  }
  if (await isPhoneTaken(phone)) {
    console.log('  [×] 该手机号已经被占用，新建取消');
    await pause();
    return;
  }

  const password = await askRequired('* 登录密码（6~20 位）');
  if (password.length < 6 || password.length > 20) {
    console.log('  [×] 密码长度必须是 6~20 位，新建取消');
    await pause();
    return;
  }

  const name = await askRequired('* 真实姓名');
  const nickname = await ask('  昵称', name);
  const auditStatus = isAdmin ? CAMPUS_AUDIT_ENUM.PASS : await askCampusAudit(CAMPUS_AUDIT_ENUM.NONE);

  // 账号编号：管理员 A 开头、普通用户 X 开头，按当前最大值递增
  const prefix = isAdmin ? ACCOUNT_NO_RULE.ADMIN_PREFIX : ACCOUNT_NO_RULE.NORMAL_PREFIX;
  const autoAccountNo = buildAccountNo(await nextSeq(prefix), isAdmin);
  const accountNoInput = await ask('  账号编号', autoAccountNo);
  const accountNo = accountNoInput.toUpperCase();
  // 账号编号格式校验：必须是「前缀 + 数字」，且前缀与角色一致
  // （管理员 A 开头、普通用户 X 开头），避免手滑填出 Y 之类的无效编号
  const expectPrefix = isAdmin ? ACCOUNT_NO_RULE.ADMIN_PREFIX : ACCOUNT_NO_RULE.NORMAL_PREFIX;
  if (!new RegExp('^' + expectPrefix + '[0-9]{1,6}$').test(accountNo)) {
    console.log('  [×] 账号编号格式不对：必须是 ' + expectPrefix + ' 开头后面跟数字，例如 ' + autoAccountNo + '，新建取消');
    await pause();
    return;
  }
  if (await isAccountNoTaken(accountNo)) {
    console.log('  [×] 该账号编号已经被占用，新建取消');
    await pause();
    return;
  }

  console.log('');
  console.log('  即将创建：');
  console.log('    账号编号 ' + accountNo + '   学号 ' + studentId + '   手机号 ' + phone);
  console.log('    姓名 ' + name + '   昵称 ' + nickname);
  console.log('    校园认证 ' + CAMPUS_AUDIT[auditStatus] + '   角色 ' + ROLE_TAG[isAdmin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL]);
  if (!(await askYesNo('  确认创建？', true))) {
    console.log('  已取消');
    await pause();
    return;
  }

  const passwordHash = await hashPassword(password);
  // 事务：建号 + 写认证/管理员标记，保证要么全成功要么全回滚
  const newUserId = await db.transaction(async (conn) => {
    const inviteCode = await generateUniqueInviteCode(conn);
    const userId = await User.create({
      account_no: accountNo,
      student_id: studentId,
      password_hash: passwordHash,
      name,
      phone,
      nickname,
      invite_code: inviteCode
    }, conn);
    await conn.execute(
      'UPDATE users SET is_campus_audit = ?, is_admin = ? WHERE id = ?',
      [auditStatus, isAdmin ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL, userId]
    );
    return userId;
  });

  let needRestart = false;
  if (isAdmin) {
    needRestart = addToWhitelist(studentId);
  }

  console.log('');
  console.log('  [√] 账号创建成功');
  console.log('      数据库 id：' + newUserId + '    账号编号：' + accountNo);
  console.log('      登录方式：账号填 ' + accountNo + ' 或 ' + phone + '，密码 ' + password);
  if (needRestart) {
    console.log('      [注意] 已把学号 ' + studentId + ' 写入管理员白名单，需要重启后端才会生效');
    await offerRestart();
  }
  await pause();
}

// ---------------- 功能：修改账号 ----------------

async function menuEdit() {
  title('修改账号');
  const target = await pickUser();
  if (!target) return;

  const row = await findUserById(target.id);
  if (!row) {
    console.log('  [×] 账号不存在');
    await pause();
    return;
  }
  printUserDetail(row);
  console.log('  逐项填写，直接回车表示该项不改动');
  console.log('');

  const fields = {};
  const oldStudentId = String(row.student_id);
  const isAdminNow = getAdminStudentIds().includes(oldStudentId);

  // ---- 学号 ----
  const studentIdInput = await askOptional('  学号', row.student_id);
  if (studentIdInput !== null && studentIdInput !== String(row.student_id)) {
    const taken = await isStudentIdTaken(studentIdInput, row.id);
    if (taken) {
      console.log('  [×] 该学号已被账号 ' + (taken.account_no || taken.id) + ' 占用，修改取消');
      await pause();
      return;
    }
    fields.student_id = studentIdInput;
  }

  // ---- 手机号 ----
  const phoneInput = await askOptional('  手机号', row.phone);
  if (phoneInput !== null && phoneInput !== String(row.phone)) {
    if (!isAdminNow && !isPhone(phoneInput)) {
      console.log('  [×] 手机号格式不正确（必须是 1 开头的 11 位数字），修改取消');
      await pause();
      return;
    }
    const taken = await isPhoneTaken(phoneInput, row.id);
    if (taken) {
      console.log('  [×] 该手机号已被账号 ' + (taken.account_no || taken.id) + ' 占用，修改取消');
      await pause();
      return;
    }
    fields.phone = phoneInput;
  }

  // ---- 姓名 / 昵称 ----
  const nameInput = await askOptional('  真实姓名', row.name);
  if (nameInput !== null) fields.name = nameInput;

  const nicknameInput = await askOptional('  昵称', row.nickname);
  if (nicknameInput !== null) fields.nickname = nicknameInput;

  // ---- 校园认证状态 ----
  const auditInput = await askOptional('  校园认证状态（0/1/2/3）', row.is_campus_audit);
  if (auditInput !== null) {
    const num = Number(auditInput);
    if (![0, 1, 2, 3].includes(num)) {
      console.log('  [×] 校园认证状态只能是 0 / 1 / 2 / 3，修改取消');
      await pause();
      return;
    }
    fields.is_campus_audit = num;
  }

  // ---- 密码 ----
  const passwordInput = await askOptional('  新密码（6~20 位，留空=不改）', '（不显示）');
  let newPasswordHash = null;
  if (passwordInput !== null && passwordInput !== '（不显示）') {
    if (passwordInput.length < 6 || passwordInput.length > 20) {
      console.log('  [×] 密码长度必须是 6~20 位，修改取消');
      await pause();
      return;
    }
    newPasswordHash = await hashPassword(passwordInput);
  }

  // ---- 管理员权限 ----
  const finalStudentId = fields.student_id || String(row.student_id);
  let adminAction = 'none';
  if (await askYesNo('  当前是否设为管理员？（现在是：' + ROLE_TAG[isAdminNow ? USER_ROLE_ENUM.ADMIN : USER_ROLE_ENUM.NORMAL] + '）', isAdminNow)) {
    if (!isAdminNow) adminAction = 'add';
  } else if (isAdminNow) {
    adminAction = 'remove';
  }

  // ---- 落库 ----
  let changed = 0;
  if (Object.keys(fields).length) {
    // 走模型层：列名白名单 + 参数化，且不包含 is_admin（管理员只认白名单）
    changed += await User.updateProfileByAdmin(row.id, fields);
  }
  if (newPasswordHash) {
    // 管理员重置密码：同时清零错误次数、解除锁定、清空设备标识（强制重新登录）
    await User.resetPasswordByAdmin(row.id, newPasswordHash);
    changed += 1;
  }
  if (adminAction !== 'none') {
    if (adminAction === 'add') {
      addToWhitelist(finalStudentId);
      await db.execute('UPDATE users SET is_admin = ?, is_campus_audit = ? WHERE id = ?',
        [USER_ROLE_ENUM.ADMIN, CAMPUS_AUDIT_ENUM.PASS, row.id]);
    } else {
      removeFromWhitelist(oldStudentId);
      await db.execute('UPDATE users SET is_admin = ? WHERE id = ?', [USER_ROLE_ENUM.NORMAL, row.id]);
    }
    changed += 1;
  }

  console.log('');
  if (!changed) {
    console.log('  没有做任何修改');
  } else {
    console.log('  [√] 修改完成，共更新 ' + changed + ' 项');
    const fresh = await findUserById(row.id);
    printUserDetail(fresh);
  }
  if (adminAction !== 'none') {
    console.log('  [注意] 管理员白名单已改动，需要重启后端才会生效');
    await offerRestart();
  }
  await pause();
}

// ---------------- 功能：注销账号 ----------------

async function menuDeactivate() {
  title('注销账号（软删除）');
  const target = await pickUser();
  if (!target) return;
  const row = await findUserById(target.id);
  printUserDetail(row);
  // 管理员账号保护：白名单里的学号 = 管理员，不允许被工具直接注销掉
  if (getAdminStudentIds().includes(String(row.student_id))) {
    console.log('  [×] 该账号是管理员（学号在白名单里），不能直接注销。');
    console.log('      请先去「6. 管理员白名单管理」把学号移出白名单，再执行注销。');
    await pause();
    return;
  }
  console.log('  注销后：该账号不能再登录，姓名 / 昵称 / 头像清空，');
  console.log('          手机号与学号释放（可被新账号注册复用），');
  console.log('          历史任务 / 账单 / 消息仍然保留。此操作不可恢复。');
  console.log('');
  const confirm = await ask('确认请输入大写 YES，其它任何输入都会取消');
  if (confirm !== 'YES') {
    console.log('  已取消');
    await pause();
    return;
  }
  await db.transaction(async (conn) => {
    await User.deactivate(row.id, conn);
  });
  console.log('  [√] 账号 ' + row.id + ' 已注销');
  await pause();
}

// ---------------- 功能：彻底删除账号 ----------------

async function menuDelete() {
  title('彻底删除账号');
  const target = await pickUser();
  if (!target) return;
  const row = await findUserById(target.id);
  printUserDetail(row);

  // 管理员账号保护：同上，避免误删管理员导致后台无人可用
  if (getAdminStudentIds().includes(String(row.student_id))) {
    console.log('  [×] 该账号是管理员（学号在白名单里），不能直接删除。');
    console.log('      请先去「6. 管理员白名单管理」把学号移出白名单，再执行删除。');
    await pause();
    return;
  }

  // 先用一条 SQL 统计该账号名下的业务数据（外键都指向 users.id，有数据就不能硬删）
  const statSql = 'SELECT'
    + ' (SELECT COUNT(*) FROM tasks WHERE user_id = ? OR taker_user_id = ?) AS tasks,'
    + ' (SELECT COUNT(*) FROM payments WHERE user_id = ?) AS payments,'
    + ' (SELECT COUNT(*) FROM user_bill WHERE user_id = ?) AS bills,'
    + ' (SELECT COUNT(*) FROM messages WHERE user_id = ?) AS messages,'
    + ' (SELECT COUNT(*) FROM appeals WHERE user_id = ?) AS appeals,'
    + ' (SELECT COUNT(*) FROM report WHERE user_id = ?) AS reports,'
    + ' (SELECT COUNT(*) FROM audit_apply WHERE user_id = ?) AS audits';
  const statRows = await db.query(statSql, [row.id, row.id, row.id, row.id, row.id, row.id, row.id, row.id]);
  const stat = statRows[0] || {};
  const labels = {
    tasks: '任务', payments: '支付流水', bills: '账单',
    messages: '站内消息', appeals: '申诉', reports: '举报', audits: '审核申请'
  };
  const used = Object.keys(labels).filter((key) => Number(stat[key]) > 0);

  console.log('  该账号名下的业务数据：');
  Object.keys(labels).forEach((key) => {
    console.log('    ' + pad(labels[key], 10) + ' ' + stat[key] + ' 条');
  });
  console.log('');

  if (used.length) {
    console.log('  [×] 该账号还有业务数据（' + used.map((key) => labels[key]).join('、') + '），不允许彻底删除。');
    console.log('      请改用「注销账号」：一样能让它无法登录、释放手机号和学号，同时保留历史数据。');
    await pause();
    return;
  }

  const confirm = await ask('确认彻底删除请输入大写 DELETE，其它任何输入都会取消');
  if (confirm !== 'DELETE') {
    console.log('  已取消');
    await pause();
    return;
  }
  await db.execute('DELETE FROM users WHERE id = ?', [row.id]);
  console.log('  [√] 账号 ' + row.id + ' 已彻底删除');
  await pause();
}

// ---------------- 功能：管理员白名单 ----------------

async function menuWhitelist() {
  title('管理员白名单');
  const ids = readWhitelist();
  console.log('  当前白名单（ADMIN_STUDENT_IDS）：' + (ids.length ? ids.join(', ') : '（空）'));
  console.log('  说明：白名单里的学号 = 管理员，拥有后台全部权限；数据库 users.is_admin 只用于前端标识。');
  console.log('');
  console.log('  1. 添加管理员（填学号）');
  console.log('  2. 移除管理员（填学号）');
  console.log('  0. 返回主菜单');
  console.log('');
  const choice = await ask('请选择', '0');

  if (choice === '1') {
    const studentId = await askRequired('  要添加为管理员的学号');
    const userRows = await db.query('SELECT id, account_no, nickname FROM users WHERE student_id = ? LIMIT 1', [studentId]);
    if (!userRows.length) {
      console.log('  [×] 数据库里没有学号为 ' + studentId + ' 的账号。');
      console.log('      请先用「新建账号」建号，或用「修改账号」把某个账号的学号改成它。');
      await pause();
      return;
    }
    if (!addToWhitelist(studentId)) {
      console.log('  [×] 该学号已经在白名单里了');
      await pause();
      return;
    }
    await db.execute('UPDATE users SET is_admin = ?, is_campus_audit = ? WHERE student_id = ?',
      [USER_ROLE_ENUM.ADMIN, CAMPUS_AUDIT_ENUM.PASS, studentId]);
    console.log('  [√] 学号 ' + studentId + ' 已设为管理员（账号 ' + (userRows[0].account_no || userRows[0].id)
      + '，昵称 ' + userRows[0].nickname + '）');
    await offerRestart();
  } else if (choice === '2') {
    const studentId = await askRequired('  要移除管理员的学号');
    if (!removeFromWhitelist(studentId)) {
      console.log('  [×] 该学号不在白名单里');
      await pause();
      return;
    }
    await db.execute('UPDATE users SET is_admin = ? WHERE student_id = ?', [USER_ROLE_ENUM.NORMAL, studentId]);
    console.log('  [√] 学号 ' + studentId + ' 已移除管理员权限');
    await offerRestart();
  }
  await pause();
}

// ---------------- 重启后端 ----------------

/** 询问并尝试重启后端（杀掉监听进程，交给守护脚本自动拉起） */
async function offerRestart() {
  if (!(await askYesNo('  是否现在重启后端让改动立即生效？', true))) {
    console.log('  稍后请自行重启后端（双击工作目录的「启动后端守护.bat」）。');
    return;
  }
  const port = Number(process.env.PORT || 3000);
  try {
    const { execSync } = require('child_process');
    // 找到监听该端口的进程并结束；守护脚本会在 10 秒内自动把它拉起来
    const netstat = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    netstat.split(/\r?\n/).forEach((lineText) => {
      if (lineText.indexOf(':' + port) >= 0 && lineText.indexOf('LISTENING') >= 0) {
        const match = lineText.trim().match(/(\d+)$/);
        if (match) pids.add(match[1]);
      }
    });
    if (!pids.size) {
      console.log('  [i] 没有检测到监听 ' + port + ' 端口的后端进程，可能后端当前没在运行。');
      return;
    }
    pids.forEach((pid) => {
      try { execSync('taskkill /F /PID ' + pid + ' >nul 2>&1'); } catch (err) { /* 进程可能已退出 */ }
    });
    console.log('  已结束旧后端进程（PID ' + Array.from(pids).join(', ') + '），等待守护脚本自动拉起...');

    // 轮询健康检查，最多等 60 秒
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const resp = await fetch('http://127.0.0.1:' + port + '/api/health');
        if (resp.ok) {
          console.log('  [√] 后端已恢复：http://127.0.0.1:' + port + '/api/health 返回 200');
          return;
        }
      } catch (err) { /* 还在启动中，继续等 */ }
    }
    console.log('  [!] 60 秒内没有等到后端恢复。请双击工作目录的「启动后端守护.bat」手动启动。');
  } catch (err) {
    console.log('  [!] 自动重启失败：' + err.message);
    console.log('      请双击工作目录的「启动后端守护.bat」手动启动后端。');
  }
}

// ---------------- 主菜单 ----------------

function printMenu() {
  const port = process.env.PORT || 3000;
  console.log('');
  console.log('============================================================');
  console.log('            校园跑腿 · 账号管理工具');
  console.log('============================================================');
  console.log('  数据库：' + (process.env.DB_NAME || 'campus_errand') + ' @ ' + (process.env.DB_HOST || 'localhost')
    + ':' + (process.env.DB_PORT || 3306));
  console.log('  后端  ：http://127.0.0.1:' + port);
  console.log('  管理员白名单：' + (readWhitelist().join(', ') || '（空）'));
  console.log('------------------------------------------------------------');
  console.log('  1. 查看账号列表（支持搜索）');
  console.log('  2. 新建账号');
  console.log('  3. 修改账号（学号 / 手机号 / 密码 / 姓名 / 昵称 / 认证状态 / 管理员权限）');
  console.log('  4. 注销账号（软删除，保留历史数据）');
  console.log('  5. 彻底删除账号（无业务数据时才允许）');
  console.log('  6. 管理员白名单管理');
  console.log('  0. 退出');
  console.log('============================================================');
}

async function main() {
  const okConn = await db.testConnection();
  if (!okConn) throw new Error('数据库连接失败');
  console.log('数据库连接成功：' + (process.env.DB_NAME || 'campus_errand'));

  for (;;) {
    printMenu();
    const choice = await ask('请输入序号', '0');
    if (choice === '1') await menuList();
    else if (choice === '2') await menuCreate();
    else if (choice === '3') await menuEdit();
    else if (choice === '4') await menuDeactivate();
    else if (choice === '5') await menuDelete();
    else if (choice === '6') await menuWhitelist();
    else if (choice === '0' || choice.toLowerCase() === 'q') break;
    else console.log('  [×] 没有这个选项');
  }
}

main()
  .catch((err) => {
    console.log('');
    console.log('[×] 执行出错：' + err.message);
  })
  .finally(async () => {
    if (rlInstance) rlInstance.close();
    try { await db.closePool(); } catch (err) { /* 忽略关闭异常 */ }
    console.log('已退出，数据库连接已关闭。');
    process.exit(0);
  });
