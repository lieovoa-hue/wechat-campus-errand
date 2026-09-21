/**
 * =====================================================================
 * 并发接单专项回归（N 人同一瞬间抢同一个任务）
 * ---------------------------------------------------------------------
 * 为什么单独拉一个脚本：
 *   「两个人同时点接单」是跑腿业务最容易出事的地方 —— 一旦并发保护失效，
 *   同一个任务会被两个人同时接到：雇主收到两条接单消息、两个跑腿员白跑一趟。
 *   regression-business-flow.js 里只做了 2 人并发，这里加强成 5 人同时抢单，
 *   并额外断言「只产生一条接单消息」「失败方详情页立刻显示已被接单」「连点被挡」。
 *
 * 覆盖范围：
 *   1. 5 个已认证用户同一瞬间 POST /api/task/take：恰好 1 人成功，其余 4 人 409
 *   2. 落库校验：status=1 / taker_user_id=唯一赢家 / take_time 已写 / once_taken=1
 *   3. 副作用校验：雇主只收到 1 条「任务已被接单」消息（不重复通知、不重复派单）
 *   4. 失败方视角：详情接口 canTake=false，且能看到接单人学号
 *   5. 追加拦截：成功者连点被幂等挡住、失败方事后重试仍被拒、接单人不会被改写
 *
 * 运行：node scripts/regression-take-race.js   （需先启动后端服务）
 * 说明：脚本自带收尾清理（1 个雇主 + 5 个接单者账号及其任务 / 支付 / 消息一并删除），
 *       中途异常退出时会尽力清理已创建的账号。
 * 注意：审核校园认证需要管理员登录（账号见 .env 白名单），会顶掉管理员账号在其他端的登录态（含开发者工具），
 * 并给管理员本人推送一条「账号已在其他设备登录」站内消息（登录机制自带，脚本不清理）。
 * =====================================================================
 */

const h = require('./_accountHelper');
const db = require('../src/db/db');
const { TASK_STATUS_ENUM, MSG } = require('../src/utils/constant');

/** 同时抢单的人数 */
const RACERS = 5;
/** 接单成功后推给雇主的消息标题（与 taskController 保持一致） */
const TAKEN_TITLE = '任务已被接单';

let passCount = 0;
let failCount = 0;
const failedNames = [];

function title(text) {
  console.log(`\n===== ${text} =====`);
}

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failCount += 1;
    failedNames.push(name);
    console.log(`  [FAIL] ${name} ${extra === undefined ? '' : JSON.stringify(extra)}`);
  }
}

/** 带令牌的快捷请求 */
function api(method, path, body, token) {
  return h.request(method, path, body, { token, deviceId: 'take-race-device' });
}

/** 干净的发布表单（每次跑都用新账号，避免幂等键命中上一轮） */
function taskForm(overrides) {
  return Object.assign({
    receiverName: '并发收货人',
    receiverPhone: '13900139002',
    deliverAddress: 'X栋X楼B201',
    detailAddress: '宿舍B201门口',
    pickupCode: '9-9-9901',
    timeLimitMin: 60,
    remark: '并发接单回归任务',
    reward: 1.2,
    img1: '/uploads/test/task_race.jpg'
  }, overrides || {});
}

/** 读取任务行（数据库口径） */
async function taskRow(taskId) {
  const rows = await db.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
  return rows[0] || null;
}

/** 某雇主收到的、内容指向该任务的「任务已被接单」消息条数 */
async function takenMessageCount(employerId, taskId) {
  const rows = await db.query(
    'SELECT COUNT(*) AS total FROM messages WHERE user_id = ? AND title = ? AND content LIKE ?',
    [employerId, TAKEN_TITLE, `%${taskId}%`]
  );
  return rows[0] ? Number(rows[0].total) : 0;
}

async function main() {
  const createdAccountNos = [];
  try {
    const admin = await h.adminToken();

    title('0. 环境自检');
    const health = await api('GET', '/api/health');
    check('后端健康检查通过', health.code === 200, health.msg);

    // ---------------------------------------------------------------- 造数据
    title(`1. 造数据：1 个雇主 + ${RACERS} 个已认证接单者`);
    const employer = await h.createCertifiedUser({
      adminToken: admin, name: '并发回归雇主', studentId: '20259951', phone: h.testPhone(2101)
    });
    createdAccountNos.push(employer.accountNo);

    const takers = [];
    for (let i = 0; i < RACERS; i += 1) {
      /* eslint-disable no-await-in-loop */
      const user = await h.createCertifiedUser({
        adminToken: admin,
        name: `并发回归跑腿${i + 1}`,
        studentId: String(20259952 + i),
        phone: h.testPhone(2102 + i)
      });
      createdAccountNos.push(user.accountNo);
      takers.push(user);
    }
    check(`已创建 ${RACERS} 个可接单的认证账号`, takers.length === RACERS, takers.length);

    const created = await api('POST', '/api/task/createOrder', taskForm(), employer.token);
    check('发布并模拟支付成功', created.code === 200 && created.data && created.data.paid === true, created.msg);
    const taskId = created.data && created.data.taskId;

    const rowBefore = await taskRow(taskId);
    check('任务上架为待接单且无接单人',
      Boolean(rowBefore) && Number(rowBefore.status) === TASK_STATUS_ENUM.WAIT_TAKE && !rowBefore.taker_user_id,
      rowBefore && { status: rowBefore.status, taker: rowBefore.taker_user_id });
    check('抢单前雇主尚未收到接单消息', (await takenMessageCount(employer.userId, taskId)) === 0);

    // ---------------------------------------------------------------- 并发抢单
    title(`2. ${RACERS} 人同一瞬间抢单`);
    // 先各打一次轻量接口预热连接与登录态，避免握手耗时把请求错开
    await Promise.all(takers.map((t) => api('GET', '/api/user/info', null, t.token)));

    const startedAt = Date.now();
    const results = await Promise.all(takers.map(async (taker) => {
      const t0 = Date.now();
      const res = await api('POST', '/api/task/take', { taskId }, taker.token);
      return {
        accountNo: taker.accountNo,
        userId: taker.userId,
        code: res.code,
        msg: res.msg,
        startOffset: t0 - startedAt,
        cost: Date.now() - t0
      };
    }));
    results.forEach((r) => {
      console.log(`    ${r.accountNo} 起跑+${r.startOffset}ms -> code=${r.code} 耗时=${r.cost}ms msg=${r.msg}`);
    });
    console.log(`    （${RACERS} 个请求的起跑时间跨度 ${Math.max.apply(null, results.map((r) => r.startOffset))}ms）`);

    const okResults = results.filter((r) => r.code === 200);
    const rejectResults = results.filter((r) => r.code !== 200);
    check(`${RACERS} 人并发抢单恰好 1 人成功`, okResults.length === 1, results.map((r) => r.accountNo + ':' + r.code));
    check(`其余 ${RACERS - 1} 人全部被拒`, rejectResults.length === RACERS - 1, rejectResults.map((r) => r.code));
    check(`被拒者返回 409 + 「${MSG.TASK_TAKEN}」`,
      rejectResults.every((r) => r.code === 409 && r.msg === MSG.TASK_TAKEN),
      rejectResults.map((r) => r.code + ':' + r.msg));

    const winner = takers.find((t) => t.accountNo === okResults[0].accountNo);
    const loser = takers.find((t) => t.accountNo === rejectResults[0].accountNo);

    // ---------------------------------------------------------------- 落库校验
    title('3. 落库校验（只能有一个接单人）');
    const rowAfter = await taskRow(taskId);
    check('任务变为进行中(status=1)', Number(rowAfter.status) === TASK_STATUS_ENUM.TAKING, rowAfter.status);
    check('接单人就是唯一成功者', Number(rowAfter.taker_user_id) === winner.userId,
      { taker: rowAfter.taker_user_id, winner: winner.userId });
    check('接单时间已写入', Boolean(rowAfter.take_time), rowAfter.take_time);
    check('once_taken 已置 1（退费永久关闭）', Number(rowAfter.once_taken) === 1, rowAfter.once_taken);

    const winnerRows = await db.query('SELECT student_id FROM users WHERE id = ?', [winner.userId]);
    const winnerStudentId = winnerRows[0] ? String(winnerRows[0].student_id) : '';

    // ---------------------------------------------------------------- 副作用
    title('4. 副作用校验（不重复通知 / 不重复派单）');
    const msgCount = await takenMessageCount(employer.userId, taskId);
    check('雇主只收到 1 条「任务已被接单」消息', msgCount === 1, msgCount);

    const loserDetail = await api('GET', `/api/task/${taskId}`, null, loser.token);
    // 详情接口返回 { task: vo, remainSeconds }，按钮开关在 vo.actions 里
    check('失败方详情页 canTake=false',
      loserDetail.code === 200 && loserDetail.data.task.actions.canTake === false,
      loserDetail.data && loserDetail.data.task && loserDetail.data.task.actions);
    check('失败方看到的是真正的接单人学号',
      loserDetail.code === 200 && loserDetail.data.task.takerStudentId === winnerStudentId,
      { api: loserDetail.data && loserDetail.data.task && loserDetail.data.task.takerStudentId, expect: winnerStudentId });

    // ---------------------------------------------------------------- 追加拦截
    title('5. 追加拦截（连点 / 事后重试）');
    const winnerAgain = await api('POST', '/api/task/take', { taskId }, winner.token);
    check('成功者立刻再点一次仍被拒', winnerAgain.code === 409, winnerAgain.code + ' ' + winnerAgain.msg);

    // 同一个人短时间内重复请求会先命中防连点幂等窗口，等窗口过去再验证状态拦截
    await h.sleep(3200);
    const loserRetry = await api('POST', '/api/task/take', { taskId }, loser.token);
    check(`幂等窗口过后失败方重试仍是「${MSG.TASK_TAKEN}」`,
      loserRetry.code === 409 && loserRetry.msg === MSG.TASK_TAKEN, loserRetry.code + ' ' + loserRetry.msg);

    const rowFinal = await taskRow(taskId);
    check('多次重试后接单人没有被改写', Number(rowFinal.taker_user_id) === winner.userId, rowFinal.taker_user_id);
    check('重试期间没有再产生接单消息', (await takenMessageCount(employer.userId, taskId)) === 1);
  } finally {
    // ---------------------------------------------------------------- 收尾
    title('6. 清理测试数据');
    try {
      const purged = createdAccountNos.length ? await h.purgeAccounts(createdAccountNos) : 0;
      check('测试账号与关联数据已清理', purged === createdAccountNos.length,
        { purged, expect: createdAccountNos.length });
    } catch (err) {
      check('测试账号与关联数据已清理', false, err && err.message);
    }

    console.log(`\n===== 结果：${passCount} 项通过 / ${failCount} 项失败（共 ${passCount + failCount} 项）=====`);
    if (failCount) console.log('失败项：\n  - ' + failedNames.join('\n  - '));
  }
}

main()
  .catch((err) => {
    failCount += 1;
    console.error('\n脚本异常：', err && err.message ? err.message : err);
  })
  .then(async () => {
    try {
      if (db.closePool) await db.closePool();
      else if (db.pool && db.pool.end) await db.pool.end();
    } catch (err) {
      /* 忽略关闭连接池异常 */
    }
    process.exit(failCount ? 1 : 0);
  });
