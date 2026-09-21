/**
 * =====================================================================
 * 安全回归：上传图片访问签名 + JWT 密钥强度
 * ---------------------------------------------------------------------
 * 覆盖点：
 *  1. 未携带签名的 /uploads 直链必须 403（修复前的漏洞：公开直出）
 *  2. 签名被篡改 / 过期时间被改 必须 403
 *  3. 带合法签名的地址必须 200 且返回真实图片
 *  4. 接口下发到前端的图片地址必须已带签名
 *  5. 前端把「带签名地址」回传时后端必须剥掉签名再入库
 *     （否则库里会存下带过期时间的 URL，签名一过期历史图片全部 403）
 *  6. 弱 JWT_SECRET 必须被启动自检拒绝
 * =====================================================================
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mediaSign = require('../src/utils/mediaSign');
const secretGuard = require('../src/utils/secretGuard');
const { stripMediaSignature } = require('../src/middleware/mediaGuard');

let failed = false;
const out = [];
const check = (name, pass, detail) => {
  out.push(pass);
  console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' -> ' + detail : ''));
};

/** 简易请求（返回状态码 / Content-Type / 响应体） */
function request(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: 3000,
      path: reqPath,
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        headers
      )
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buffer.toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, type: res.headers['content-type'] || '', buffer, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 递归找出响应里所有以 /uploads 开头的字符串 */
function collectUploadPaths(node, acc) {
  const list = acc || [];
  if (typeof node === 'string') {
    if (node.indexOf('/uploads/') === 0) list.push(node);
    return list;
  }
  if (!node || typeof node !== 'object') return list;
  Object.keys(node).forEach((key) => collectUploadPaths(node[key], list));
  return list;
}

const ADMIN_ACCOUNT = process.env.TEST_ADMIN_ACCOUNT || process.env.INIT_ADMIN_STUDENT_ID || '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.INIT_ADMIN_PASSWORD || '';

(async () => {
  // ============ 1. 签名工具本体 ============
  const sample = '/uploads/202609/1700000000000_abcdef123456.jpg';
  const signed = mediaSign.buildSignedUrl(sample);
  const parsed = new URL('http://x' + signed);
  check('签名地址格式正确', parsed.pathname === sample && !!parsed.searchParams.get('e') && !!parsed.searchParams.get('s'), signed);

  const exp = Number(parsed.searchParams.get('e'));
  const sig = parsed.searchParams.get('s');
  check('合法签名校验通过', mediaSign.verifySignature(sample, exp, sig) === true);
  check('篡改签名被拒', mediaSign.verifySignature(sample, exp, sig.replace(/.$/, '0') === sig ? sig.replace(/.$/, '1') : sig.replace(/.$/, '0')) === false);
  check('篡改路径被拒', mediaSign.verifySignature(sample.replace('abcdef', 'ffffff'), exp, sig) === false);
  check('过期时间早于当前被拒', mediaSign.verifySignature(sample, Date.now() - 1000, sig) === false);
  check('缺少签名参数被拒', mediaSign.verifySignature(sample, exp, '') === false);
  check('非 uploads 路径不参与签名', mediaSign.buildSignedUrl('/api/user/info') === '/api/user/info');
  check(
    '同一时间窗内签名地址保持稳定（小程序图片缓存友好）',
    mediaSign.buildSignedUrl(sample, 1758000000000) === mediaSign.buildSignedUrl(sample, 1758000000000 + 60000)
  );

  // ============ 2. 入参签名剥离 ============
  check('回传的带签名相对地址会被剥成裸路径', stripMediaSignature(signed) === sample, stripMediaSignature(signed));
  check(
    '回传的带签名绝对地址会被剥成裸路径',
    stripMediaSignature('https://example.com' + signed) === sample,
    stripMediaSignature('https://example.com' + signed)
  );
  check('普通文本不被误伤', stripMediaSignature('帮我拿个快递') === '帮我拿个快递');
  check(
    '第三方外链不被误伤',
    stripMediaSignature('https://thirdwx.qlogo.cn/mmopen/x.jpg?a=1') === 'https://thirdwx.qlogo.cn/mmopen/x.jpg?a=1'
  );

  // ============ 3. 密钥强度自检 ============
  check('当前 JWT_SECRET 通过强度自检', secretGuard.checkSecret('JWT_SECRET', process.env.JWT_SECRET) === '');
  check('过短的密钥被判定为不合格', !!secretGuard.checkSecret('JWT_SECRET', 'abc123'));
  check('开发期占位密钥被判定为不合格', !!secretGuard.checkSecret('JWT_SECRET', 'campus_errand_dev_secret_change_me_2026_9f3a1c'));
  check('重复字符密钥被判定为不合格', !!secretGuard.checkSecret('JWT_SECRET', 'a'.repeat(64)));
  check('未配置密钥被判定为不合格', !!secretGuard.checkSecret('JWT_SECRET', ''));

  // ============ 4. HTTP 层：未授权访问必须被拒 ============
  const monthDir = path.resolve(__dirname, '../uploads/202609');
  const firstFile = fs.readdirSync(monthDir).filter((f) => /\.(jpg|png|webp)$/i.test(f))[0];
  const filePath = '/uploads/202609/' + firstFile;

  const noSign = await request('GET', filePath);
  check('未携带签名访问图片被拒 403', noSign.status === 403, 'HTTP ' + noSign.status);

  const fakeSig = await request('GET', `${filePath}?e=${exp}&s=${'0'.repeat(mediaSign.SIG_LENGTH)}`);
  check('伪造签名访问图片被拒 403', fakeSig.status === 403, 'HTTP ' + fakeSig.status);

  const expiredUrl = mediaSign.buildSignedUrl(filePath, Date.now() - mediaSign.getWindowMs() * 4);
  const expiredRes = await request('GET', expiredUrl);
  check('签名过期后访问被拒 403', expiredRes.status === 403, 'HTTP ' + expiredRes.status);

  const goodRes = await request('GET', mediaSign.buildSignedUrl(filePath));
  check(
    '合法签名可正常读取图片 200',
    goodRes.status === 200 && /^image\//.test(goodRes.type),
    'HTTP ' + goodRes.status + ' ' + goodRes.type
  );

  const listing = await request('GET', '/uploads/202609/');
  check('目录列举被拒', listing.status === 403 || listing.status === 404, 'HTTP ' + listing.status);

  // ============ 5. 接口下发的图片地址必须已带签名 ============
  const login = await request('POST', '/api/user/login', { account: ADMIN_ACCOUNT, password: ADMIN_PASSWORD, deviceId: 'admin-dev' });
  const token = login.json && login.json.data && login.json.data.accessToken;
  check('管理员登录成功（新密钥下重新签发令牌）', !!token, login.json && login.json.msg);

  // 说明：任务大厅可能因为「待接单任务都被管理员删除 / 都已完成」而暂时为空，
  //       所以不能只依赖某一个接口。这里从多个会下发图片的接口一起收集，
  //       只要有任意一个接口返回了图片地址，就能完成「下发即带签名」的端到端校验。
  const mediaEndpoints = [
    '/api/task/list?page=1&pageSize=20',
    '/api/admin/userList?page=1&pageSize=20',
    '/api/audit/adminList?page=1&pageSize=20',
    '/api/report/adminList?page=1&pageSize=20',
    '/api/user/info'
  ];
  const paths = [];
  for (const endpoint of mediaEndpoints) {
    /* eslint-disable no-await-in-loop */
    const res = await request('GET', endpoint, null, { Authorization: 'Bearer ' + token });
    collectUploadPaths(res.json, paths);
  }
  check('接口能下发图片地址（多接口合并统计）', paths.length > 0, '共 ' + paths.length + ' 个，来源 ' + mediaEndpoints.length + ' 个接口');
  check(
    '下发的图片地址全部带签名',
    paths.every((p) => p.indexOf('?e=') > 0 && p.indexOf('&s=') > 0),
    paths[0] || '（无）'
  );
  check(
    '签名地址可直接访问（端到端打通）',
    paths.length > 0 ? (await request('GET', paths[0])).status === 200 : false,
    paths[0] || '（无）'
  );

  // 前端回传带签名地址 -> 库里必须只存裸路径
  const probe = await request('GET', '/api/user/info', null, { Authorization: 'Bearer ' + token });
  check('个人信息接口正常（响应改写未破坏结构）', probe.status === 200 && probe.json && probe.json.code === 200, probe.json && probe.json.msg);

  // ============ 6. 端到端：带签名地址回传后，数据库里必须只存裸路径 ============
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  const adminUserId = login.json.data.user.userId;
  const [beforeRows] = await conn.query('SELECT id, avatar FROM users WHERE id = ?', [adminUserId]);
  const avatarBefore = beforeRows[0].avatar || '';

  const signedAvatar = mediaSign.buildSignedUrl(filePath);
  const upd = await request('POST', '/api/admin/updateUser', { userId: adminUserId, avatar: signedAvatar }, { Authorization: 'Bearer ' + token });
  const [afterRows] = await conn.query('SELECT avatar FROM users WHERE id = ?', [adminUserId]);
  check(
    '回传「带签名图片地址」后数据库只存裸路径（否则签名过期历史图片会全部打不开）',
    upd.json && upd.json.code === 200 && afterRows[0].avatar === filePath,
    'DB=' + afterRows[0].avatar
  );

  // 还原被改动的头像，保持测试无副作用
  await conn.query('UPDATE users SET avatar = ? WHERE id = ?', [avatarBefore, adminUserId]);
  await conn.end();

  const pass = out.filter(Boolean).length;
  console.log('\n===== 安全回归：' + pass + ' / ' + out.length + ' 项通过 =====');
  if (pass !== out.length) failed = true;
})()
  .catch((e) => {
    console.error('异常', e.message);
    failed = true;
  })
  .then(() => {
    process.exit(failed ? 1 : 0);
  });
