/**
 * =====================================================================
 * 上传图片访问守卫中间件
 * ---------------------------------------------------------------------
 * 导出两个中间件：
 *  1. signResponseMedia —— 挂在业务路由【之前】，包装 res.json，
 *     把响应体里所有未签名的 /uploads 地址自动补上签名参数。
 *     这样所有接口（个人信息 / 任务列表 / 任务详情 / 审核 / 举报 …）
 *     无需逐个改造，天然都下发「可访问的带签名地址」。
 *  2. mediaGuard —— 挂在 /uploads 静态目录【之前】，先验签再放行。
 *
 * 中间件顺序（见 app.js）：
 *   解析请求体 -> XSS 转义 -> signResponseMedia -> 业务路由
 *   /uploads -> mediaGuard -> express.static
 * =====================================================================
 */

const mediaSign = require('../utils/mediaSign');
const { CODE_MSG } = require('../utils/constant');
const { log } = require('../utils/common');

/**
 * 归一化单个字符串：
 *  1. 绝对地址（https://域名/uploads/xxx.jpg?e=..&s=..）-> 去掉域名与签名，只留 /uploads/xxx.jpg
 *     （数据库永远只存相对路径，域名换了也不用批量改数据）
 *  2. 带签名的相对地址（/uploads/xxx.jpg?e=..&s=..）-> 去掉 ? 之后的签名参数
 * 不匹配的字符串原样返回（例如微信头像外链、昵称文本等一律不动）
 * @param {*} value 任意值
 * @returns {*} 归一化后的值
 */
function stripMediaSignature(value) {
  if (typeof value !== 'string' || !value) return value;

  // 绝对地址：仅当主机后紧跟 /uploads/ 时才处理，避免误伤微信头像等第三方外链
  let path = value;
  const absolute = /^https?:\/\/[^/]+\/uploads\//i.exec(path);
  if (absolute) path = path.slice(absolute[0].length - '/uploads/'.length);

  if (path.indexOf('/uploads/') !== 0) return value;
  const queryIndex = path.indexOf('?');
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

/**
 * 递归归一化请求体里的图片地址
 * 【为什么必须做】上传接口返回的是「带签名的地址」，前端会把它原样存下来并在
 * 提交表单时回传（如发布任务的 img1、提交完成的 deliveryImages、认证截图的 applyContent）。
 * 若不在这里剥掉签名，数据库里就会存进一个「带过期时间的 URL」，
 * 等签名过期后这些历史图片将全部变成 403 打不开。
 * @param {*} node
 */
function normalizeNode(node) {
  if (!node || typeof node !== 'object') return;
  if (node instanceof Date || Buffer.isBuffer(node)) return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const item = node[i];
      if (typeof item === 'string') {
        node[i] = stripMediaSignature(item);
      } else {
        normalizeNode(item);
      }
    }
    return;
  }

  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = node[key];
    if (typeof value === 'string') {
      node[key] = stripMediaSignature(value);
    } else {
      normalizeNode(value);
    }
  }
}

/**
 * 包装 res.json，把响应体中的所有本地上传图片地址改写成带签名地址
 * 设计取舍：改写异常绝不阻断正常业务响应（宁可图片加载失败，也不能让接口 500）
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function signResponseMedia(req, res, next) {
  const originalJson = res.json;
  res.json = function signedJson(body) {
    try {
      mediaSign.rewriteInPlace(body);
    } catch (err) {
      log('error', `[图片签名] 响应改写失败：${err.message}`);
    }
    return originalJson.call(this, body);
  };
  next();
}

/**
 * /uploads 静态目录访问守卫：必须携带有效签名才放行
 * 未通过时统一返回 403（不区分「签名错误 / 已过期 / 未携带」，避免给攻击者任何提示）
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function mediaGuard(req, res, next) {
  // 用 originalUrl 而不是 req.path：本中间件挂载在 /uploads 上，
  // req.path 会丢掉挂载前缀，导致签名比对路径不一致
  const ok = mediaSign.verifySignature(req.originalUrl, req.query.e, req.query.s);
  if (!ok) {
    return res.status(403).json({ code: 403, msg: CODE_MSG[403] || '无权限', data: null });
  }
  return next();
}

/**
 * 入参归一化：剥掉请求体里图片地址上携带的签名参数（只留 /uploads/xxx.jpg）
 * 挂在业务路由【之前】。详见上方 normalizeNode 注释。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function normalizeIncomingMedia(req, res, next) {
  try {
    normalizeNode(req.body);
  } catch (err) {
    // 入参归一化失败不影响业务：后续控制器的格式校验仍会兜底
    log('error', `[图片签名] 入参归一化失败：${err.message}`);
  }
  return next();
}

module.exports = {
  signResponseMedia,
  mediaGuard,
  normalizeIncomingMedia,
  stripMediaSignature
};
