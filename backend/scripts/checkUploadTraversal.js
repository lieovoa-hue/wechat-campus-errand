/**
 * 一次性地验证：修复前「公开静态目录」是否可被目录穿越读到 .env
 * 做法：在本机 3999 端口复刻修复前的挂载方式（express.static 直接对外），
 *      分别请求各种穿越路径，对比当前线上（3000 端口，带签名守卫）的表现。
 * 【结论用于确认漏洞真实存在以及修复有效，日常无需运行】
 */

const express = require('express');
const http = require('http');
const path = require('path');

const UPLOAD_DIR = path.resolve(__dirname, '../uploads');

/** 发起一次请求，返回 {status, body前80字} */
function probe(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw.slice(0, 80).replace(/\n/g, ' ') }));
    });
    req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    req.end();
  });
}

const PATHS = [
  '/uploads/..%2f.env',
  '/uploads/..%2f..%2f.env',
  '/uploads/%2e%2e/.env',
  '/uploads/....//.env',
  '/uploads/.gitkeep'
];

(async () => {
  // 复刻「修复前」的挂载方式
  const legacy = express();
  legacy.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
  legacy.use((req, res) => res.status(404).send('not found'));
  const server = legacy.listen(3999);
  await new Promise((r) => server.once('listening', r));

  console.log('路径'.padEnd(28) + '修复前'.padEnd(12) + '修复后(当前线上)');
  for (const p of PATHS) {
    const before = await probe(3999, p);
    const after = await probe(3000, p);
    const beforeText = before.status + (String(before.body).indexOf('DB_PASSWORD') >= 0 ? ' 泄漏! ' : ' ');
    console.log(p.padEnd(28) + String(beforeText).padEnd(12) + after.status);
    if (String(before.body).indexOf('DB_PASSWORD') >= 0) {
      console.log('  ^ 修复前返回内容片段：' + before.body);
    }
  }

  server.close();
})();
