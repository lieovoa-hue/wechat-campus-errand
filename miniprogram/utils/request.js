/**
 * =====================================================================
 * 网络请求封装
 *  - 自动携带 Authorization（access_token）、X-Device-Id（单设备登录）与 X-Device-Name（设备展示名）
 *  - access_token 过期（401）时自动使用 refresh_token 刷新并重试一次
 *  - 刷新失败自动清理登录态并跳转登录页
 *  - 未设置密保问题（428）时自动跳转「设置密保」页面
 *  - 统一错误提示，屏蔽后端内部细节
 *  - 账号被新设备顶下线（401 + data.kicked）时，先弹窗告知「新设备 / 时间 / 登录地点 / IP」，
 *    再清理登录态回到登录页（文案模板与后端字典保持一致，禁止在业务代码里硬编码中文）
 * =====================================================================
 */

const { MSG, formatText } = require('./constant');
// 统一确认弹窗（自绘，深色自适应）；工具类里没有页面 this，dialog.show 会自动取页面栈顶页面
const dialog = require('./dialog');
// 上传前压缩：离屏 canvas 重绘导出 JPG（wx.compressImage 对 PNG 截图基本无效）
const image = require('./image');

// 后端接口地址（上线 / 他人体验版测试前必须确认这里填对）
//  - 本机模拟器调试：http://localhost:3000
//  - 真机 / 他人体验版：cpolar 的 https 域名（如 https://你的域名）
//  - 正式上线：已备案的 HTTPS 域名
let BASE_URL = 'http://localhost:3000';

/**
 * 只能用于调试的地址特征（本机 / 内网 / 内网穿透）
 * ---------------------------------------------------------------------
 * 上线时最容易踩的坑：带着 localhost 或内网穿透地址（cpolar、ngrok…）提审，
 * 审核机上必然请求失败，会直接以「功能不可用」驳回。
 */
const DEV_HOST_PATTERNS = ['localhost', '127.0.0.1', '192.168.', '10.', '172.', 'cpolar', 'ngrok', 'natapp', 'trycloudflare', '.local'];

let lastWarnedUrl = '';

/**
 * 上线自检：当前后端地址能否用于正式提审
 * ---------------------------------------------------------------------
 * 命中临时地址、或不是 https 时打印醒目提示；只提示、不阻断，避免影响本机调试。
 * @returns {boolean} true = 是可用于正式上线的地址
 */
function checkBaseUrlForRelease() {
  const url = BASE_URL || '';
  const isDev = url.indexOf('https://') !== 0 || DEV_HOST_PATTERNS.some((p) => url.indexOf(p) !== -1);
  if (!isDev) {
    lastWarnedUrl = '';
    return true;
  }
  if (lastWarnedUrl !== url) {
    lastWarnedUrl = url;
    console.warn(
      '[上线自检] 当前后端地址 ' + url + ' 是调试 / 临时地址，仅供本机调试与他人体验版使用。\n' +
      '正式提审前必须完成三步：1) 换成已备案的 HTTPS 域名；2) 在微信公众平台 → 开发管理 → 服务器域名，把它加入 request / uploadFile / downloadFile 合法域名；3) 修改 utils/request.js 的 BASE_URL（或本地缓存 BASE_URL）。'
    );
  }
  return false;
}

// 模块加载即自检一次：app.js 用本地缓存覆盖地址后，setBaseUrl 内会再自检一次
checkBaseUrlForRelease();

/**
 * 是否开发 / 体验版
 * ---------------------------------------------------------------------
 * 正式版（release）不输出任何调试日志，避免提审时被判定为「遗留调试代码」。
 * @returns {boolean} true = 开发版或体验版
 */
function isDeveloperBuild() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const envVersion = info && info.miniProgram && info.miniProgram.envVersion;
    return envVersion !== 'release';
  } catch (e) {
    return true;
  }
}

/** 修改后端地址（app.js 启动时会读取本地缓存覆盖） */
function setBaseUrl(url) {
  if (url) BASE_URL = String(url).replace(/\/+$/, '');
  checkBaseUrlForRelease();
}

/** 获取后端地址 */
function getBaseUrl() {
  return BASE_URL;
}

// 刷新令牌的进行中 Promise，避免并发请求重复刷新
let refreshingPromise = null;

/** 读取全局登录态（延迟调用 getApp，避免模块加载顺序问题） */
function getAppInstance() {
  try {
    return getApp();
  } catch (err) {
    return null;
  }
}

/**
 * 读取当前设备的展示名（如「iPhone 13」「Xiaomi M2102J2SC」）
 * ---------------------------------------------------------------------
 * 为什么每个请求都要带：单设备登录「顶号」时，后端要把「新设备名称」写进
 * 被顶下线的旧设备的提示里，而这个名称只有客户端知道。
 * 登录 / 注册 / 密保解锁接口本来就在 body 里传了 deviceName，
 * 但普通业务请求没有 body 字段，必须统一用请求头携带，避免出现「未知设备」。
 * 注意：HTTP 头只允许 ASCII，中文品牌名（如「华为」）必须 URL 编码后传输，
 *      后端会 decodeURIComponent 还原，避免出现 Invalid character in header content。
 * @returns {string} 已 URL 编码的设备名称，取不到时返回空串（后端会兜底成「未知设备」）
 */
function getDeviceNameHeader() {
  const app = getAppInstance();
  if (app && typeof app.getDeviceName === 'function') {
    try {
      return encodeURIComponent(app.getDeviceName());
    } catch (err) {
      return '';
    }
  }
  return '';
}

/** 统一错误对象 */
function buildError(code, msg, data) {
  const error = new Error(msg || '请求失败');
  error.code = code;
  // 附加数据：目前用于「被顶下线」时携带提示内容（设备 / 时间 / 登录地点 / IP）
  if (data) error.data = data;
  return error;
}

/**
 * 账号被新设备顶下线时的统一提示
 * ---------------------------------------------------------------------
 * 必须让用户看清楚「是哪台设备、什么时候、从哪里登录的」，
 * 否则用户只会莫名掉线，既无法自证也发现不了盗号。
 * 文案优先使用后端渲染好的 content（服务端掌握真实 IP 与归属地），
 * 后端未下发时用本地字典模板兜底，保证任何情况下都有完整提示。
 * @param {object} notice 后端下发的提示对象
 */
function showKickNotice(notice) {
  const data = notice || {};
  // 后端没给出有效顶号记录（缺设备名/时间/IP 且没有渲染好的正文）时不要弹窗：
  // 否则会弹出一段全是「未知」的提示，用户既得不到信息，还会误以为账号被盗。
  const hasDetail = !!(data.content || data.deviceName || data.time || data.ip);
  if (!hasDetail) {
    redirectToLogin();
    return;
  }
  const title = data.title || MSG.KICK_NOTICE_TITLE;
  const content = data.content || formatText(MSG.KICK_NOTICE_TEMPLATE, {
    device: data.deviceName || MSG.KICK_NOTICE_UNKNOWN_DEVICE,
    time: data.time || MSG.KICK_NOTICE_UNKNOWN_TIME,
    region: data.region || MSG.KICK_NOTICE_UNKNOWN_REGION,
    ip: data.ip || MSG.KICK_NOTICE_UNKNOWN_IP
  });
  // 先清理登录态，保证任何后续请求都不会再带着失效令牌
  const app = getAppInstance();
  if (app) app.clearLogin();
  dialog.show(null, {
    title,
    content,
    showCancel: false,
    confirmText: '知道了'
  }).then(() => {
    // 弹窗关闭后再跳登录页：先 reLaunch 会把页面栈清掉，弹窗有被一起销毁的风险
    goLoginPage();
  });
}

/** 跳转登录页（已登录态被清理时使用；reLaunch 会清空页面栈，避免用户点返回又回到业务页） */
function goLoginPage() {
  const pages = getCurrentPages();
  const current = pages.length ? pages[pages.length - 1].route : '';
  if (current !== 'pages/login/login') {
    wx.reLaunch({ url: '/pages/login/login' });
  }
}

/** 跳转登录页（避免重复跳转） */
function redirectToLogin() {
  const app = getAppInstance();
  if (app) app.clearLogin();
  const pages = getCurrentPages();
  const current = pages.length ? pages[pages.length - 1].route : '';
  if (current !== 'pages/login/login') {
    wx.navigateTo({ url: '/pages/login/login' });
  }
}

/**
 * 跳转「设置密保」页面（避免重复跳转）
 * 触发场景：后端返回 428 —— 注册成功后尚未设置密保问题，此时其它业务接口都会被拦截。
 */
function redirectToSecuritySetup() {
  const pages = getCurrentPages();
  const current = pages.length ? pages[pages.length - 1].route : '';
  if (current !== 'pages/securitySetup/securitySetup') {
    wx.navigateTo({ url: '/pages/securitySetup/securitySetup' });
  }
}

/**
 * 使用 refresh_token 换取新的双令牌
 * @returns {Promise<void>}
 */
function refreshToken() {
  if (refreshingPromise) return refreshingPromise;

  const app = getAppInstance();
  const refresh = app ? app.globalData.refreshToken : wx.getStorageSync('refreshToken');

  refreshingPromise = new Promise((resolve, reject) => {
    if (!refresh) {
      reject(buildError(401, '登录已失效，请重新登录'));
      return;
    }
    wx.request({
      url: `${BASE_URL}/api/user/refreshToken`,
      method: 'POST',
      data: { refreshToken: refresh },
      header: {
        'content-type': 'application/json',
        'X-Device-Id': app ? app.globalData.deviceId : '',
        'X-Device-Name': getDeviceNameHeader()
      },
      success: (res) => {
        const body = res.data || {};
        if (body.code === 200 && body.data) {
          // 只保存新的令牌，用户信息保持不变
          app.saveLogin({ accessToken: body.data.accessToken, refreshToken: body.data.refreshToken });
          resolve();
        } else {
          // 带上 data：被顶下线时后端会把「新设备 / 时间 / 地点 / IP」放在这里
          reject(buildError(body.code || 401, body.msg || '登录已失效', body.data));
        }
      },
      fail: () => reject(buildError(-1, '网络异常，请稍后重试'))
    });
  }).then(
    (result) => { refreshingPromise = null; return result; },
    (err) => { refreshingPromise = null; throw err; }
  );

  return refreshingPromise;
}

/**
 * 发起请求
 * @param {object} options
 * @param {string} options.url 接口路径，如 /api/task/list
 * @param {string} [options.method] 请求方法
 * @param {object} [options.data] 请求数据
 * @param {boolean} [options.auth] 是否携带令牌，默认 true
 * @param {boolean} [options.loading] 是否展示 loading，默认 false
 * @returns {Promise<{code:number,msg:string,data:*}>} 成功时 resolve，失败时 reject(Error)
 */
function request(options) {
  const {
    url, method = 'GET', data = {}, auth = true, loading = false, header = {}, __retried = false
  } = options || {};

  const app = getAppInstance();
  const token = app ? app.globalData.accessToken : wx.getStorageSync('accessToken');
  const deviceId = app ? app.globalData.deviceId : wx.getStorageSync('deviceId');

  if (loading) wx.showLoading({ title: '加载中', mask: true });

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${url}`,
      method,
      data,
      header: {
        'content-type': 'application/json',
        'X-Device-Id': deviceId || '',
        'X-Device-Name': getDeviceNameHeader(),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...header
      },
      success: (res) => {
        const body = (res.data && typeof res.data === 'object') ? res.data : null;

        // 空响应体 / 非 JSON（如 304、网关异常）单独提示，避免误报成业务错误
        if (!body || body.code === undefined) {
          console.error('[request empty]', `${BASE_URL}${url}`, res.statusCode, res.data);
          reject(buildError(-2, `服务响应异常（HTTP ${res.statusCode}），请稍后重试`));
          return;
        }

        // 成功
        if (body.code === 200) {
          resolve(body);
          return;
        }

        // 令牌失效：刷新后重试一次
        if (body.code === 401 && auth && !__retried) {
          refreshToken()
            .then(() => request({ ...options, __retried: true }))
            .then(resolve)
            .catch((err) => {
              // 刷新令牌时同样会发现「账号已在别处登录」，此时优先弹窗告知本人
              if (err && err.data && err.data.kicked) {
                showKickNotice(err.data);
              } else {
                redirectToLogin();
              }
              reject(buildError(401, '登录已失效，请重新登录'));
            });
          return;
        }

        if (body.code === 401) {
          // access_token 仍在有效期内被顶下线：后端会在 401 里带上提示内容
          if (body.data && body.data.kicked) {
            showKickNotice(body.data);
            reject(buildError(401, body.msg || '登录已失效，请重新登录', body.data));
            return;
          }
          redirectToLogin();
        }
        // 未设置密保问题：跳转设置页，让用户立刻完成设置（其余业务接口会被后端持续拦截）
        if (body.code === 428) {
          redirectToSecuritySetup();
        }
        reject(buildError(body.code || 500, body.msg || '请求失败'));
      },
      fail: (err) => {
        // 真机排查用：打出「实际请求地址 + 微信原始错误」，在 vConsole 里一眼定位问题
        console.error('[request fail]', `${BASE_URL}${url}`, (err && err.errMsg) || 'request:fail');
        // 提示里带上后端地址：手机不通时能直接看出它在请求哪个域名
        reject(buildError(-1, `网络异常，无法连接 ${BASE_URL}`));
      },
      complete: () => {
        if (loading) wx.hideLoading();
      }
    });
  });
}

/** GET 快捷方法 */
function get(url, data, options) {
  return request({ url, method: 'GET', data, ...(options || {}) });
}

/** POST 快捷方法 */
function post(url, data, options) {
  return request({ url, method: 'POST', data, ...(options || {}) });
}

/**
 * 上传图片到后端（单张最大 2MB，仅支持 jpg/png/webp）
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{url:string, fullUrl:string}>}
 */
/**
 * 图片上传通道常量
 *  - MAX_UPLOAD_SIZE    ：与后端 UPLOAD_MAX_SIZE 保持一致（单张 2MB）
 *  - ERR_CHOOSE_CANCEL  ：用户主动取消选择（调用方静默忽略，不弹提示）
 *  - ERR_UPLOAD_FAILED  ：上传流程失败（调用方必须提示用户，禁止静默失败）
 */
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024;
const ERR_CHOOSE_CANCEL = -100;
const ERR_UPLOAD_FAILED = -3;

/** 是否用户主动取消选择（各端 errMsg 文案略有差异，统一模糊匹配） */
function isChooseCancel(err) {
  const msg = (err && (err.errMsg || err.message)) || '';
  return /cancel/i.test(msg);
}

/** 获取本地临时文件大小（字节）；失败返回 0 表示大小未知，交由后端兜底校验 */
function getLocalFileSize(filePath) {
  return new Promise((resolve) => {
    let fsManager = null;
    try {
      fsManager = wx.getFileSystemManager();
    } catch (err) {
      fsManager = null;
    }
    if (!fsManager || typeof fsManager.getFileInfo !== 'function') {
      resolve(0);
      return;
    }
    fsManager.getFileInfo({
      filePath,
      success: (res) => resolve(Number((res && res.size) || 0)),
      fail: () => resolve(0)
    });
  });
}


/**
 * 读取本地文件为 base64 字符串（备用上传通道使用）
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<string>}
 */
function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    const fsManager = wx.getFileSystemManager();
    fsManager.readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: () => reject(buildError(ERR_UPLOAD_FAILED, '读取图片失败，请重试'))
    });
  });
}

/**
 * 上传通道一（主通道）：wx.uploadFile multipart 上传
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{url:string, fullUrl:string}>}
 */
function uploadImageByUploadFile(filePath) {
  const app = getAppInstance();
  const token = app ? app.globalData.accessToken : wx.getStorageSync('accessToken');
  const deviceId = app ? app.globalData.deviceId : wx.getStorageSync('deviceId');

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${BASE_URL}/api/user/uploadImage`,
      filePath,
      name: 'file',
      timeout: 60000,
      header: {
        Authorization: `Bearer ${token}`,
        'X-Device-Id': deviceId || '',
        'X-Device-Name': getDeviceNameHeader()
      },
      success: (res) => {
        let body = null;
        try {
          body = JSON.parse(res.data || '{}');
        } catch (err) {
          // 响应不是 JSON：多半是域名没加入「uploadFile 合法域名」，被微信网关拦截后返回了 HTML
          console.error('[uploadImage] 响应不是 JSON', `${BASE_URL}/api/user/uploadImage`, res.statusCode, res.data);
          reject(buildError(ERR_UPLOAD_FAILED, `图片上传失败（HTTP ${res.statusCode}）`));
          return;
        }
        if (body.code === 200 && body.data && body.data.url) {
          resolve(body.data);
        } else {
          reject(buildError(body.code || ERR_UPLOAD_FAILED, body.msg || '图片上传失败，请重试'));
        }
      },
      fail: (err) => {
        // 真机排查用：这里会打印微信原始错误，例如 uploadFile:fail url not in domain list
        console.error('[uploadImage] uploadFile 失败', `${BASE_URL}/api/user/uploadImage`, (err && err.errMsg) || '');
        reject(buildError(ERR_UPLOAD_FAILED, '图片上传失败，请检查网络'));
      }
    });
  });
}

/**
 * 上传通道二（备用通道）：base64 + wx.request
 * 适用场景：部分机型或未配置「uploadFile 合法域名」时 wx.uploadFile 会被微信拦截，
 *          而 wx.request 通道正常；主通道失败后自动降级，保证图片一定能传上去。
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{url:string, fullUrl:string}>}
 */
async function uploadImageByBase64(filePath) {
  const base64 = await readFileBase64(filePath);
  const res = await request({
    url: '/api/user/uploadImageBase64',
    method: 'POST',
    data: { base64, fileName: 'upload' }
  });
  if (res && res.data && res.data.url) return res.data;
  throw buildError(ERR_UPLOAD_FAILED, '图片上传失败，请重试');
}

/**
 * 上传单张图片（主通道失败自动切换备用通道）
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<{url:string, fullUrl:string}>}
 */
async function uploadImage(filePath) {
  try {
    return await uploadImageByUploadFile(filePath);
  } catch (err) {
    console.warn('[uploadImage] 主通道失败，改用 base64 通道重试：', (err && err.message) || '');
    return uploadImageByBase64(filePath);
  }
}

/**
 * 单张图片预处理 + 上传
 *  - 超过 2MB 自动压缩（最多两轮），压完仍超限则明确报错，绝不静默跳过
 * @param {object} file wx.chooseMedia 返回的临时文件对象
 * @returns {Promise<string>} 服务端相对图片地址
 */
async function prepareAndUpload(file) {
  const original = file.tempFilePath;
  // 无条件压缩：不再等「超过 2MB 才压」——那样 1.9MB 的图会原样上传，
  // 一个任务最多 6 张图，累积起来很快把本地磁盘吃满（详见 utils/image.js 的说明）
  let filePath = await image.compressForUpload(original);
  let size = await getLocalFileSize(filePath);

  // 压完仍超限（超大 PNG 截图 / 长图）：降一档质量再压一次
  if (size > MAX_UPLOAD_SIZE) {
    const smaller = await image.compressForUpload(original, { quality: image.QUALITY_LOW });
    if (smaller && smaller !== filePath) {
      filePath = smaller;
      size = await getLocalFileSize(filePath);
    }
  }
  if (size > MAX_UPLOAD_SIZE) {
    throw buildError(ERR_UPLOAD_FAILED, '图片过大，请重新选择或先裁剪');
  }

  const data = await uploadImage(filePath);
  if (!data || !data.url) throw buildError(ERR_UPLOAD_FAILED, '图片上传失败，请重试');
  return data.url;
}

/**
 * 选择并上传图片（封装 chooseMedia：自动压缩、大小校验、失败必提示）
 * @param {number} count 最多可选张数
 * @returns {Promise<string[]>} 服务端图片地址数组（相对路径，如 /uploads/202609/x.jpg）
 * 说明：用户主动取消选择时 reject 的错误码是 ERR_CHOOSE_CANCEL(-100)，调用方应静默忽略；
 *      其它失败（图片过大 / 上传失败）错误码是 ERR_UPLOAD_FAILED(-3)，调用方必须提示用户。
 */
function chooseAndUpload(count = 1) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res && res.tempFiles) || [];
        // 调试日志只在开发 / 体验版输出，正式版保持控制台干净
        if (isDeveloperBuild()) console.log('[chooseAndUpload] 已选择文件数量：', files.length, files);

        if (!files.length) {
          reject(buildError(ERR_UPLOAD_FAILED, '没有选择到图片，请重新选择'));
          return;
        }

        wx.showLoading({ title: '上传中', mask: true });
        const urls = [];
        const errors = [];
        try {
          for (let i = 0; i < files.length; i += 1) {
            /* eslint-disable no-await-in-loop */
            try {
              const url = await prepareAndUpload(files[i]);
              if (url) urls.push(url);
            } catch (err) {
              console.error(`[chooseAndUpload] 第 ${i + 1} 张图片上传失败：`, err);
              errors.push((err && err.message) || '图片上传失败，请重试');
            }
          }
          wx.hideLoading();

          // 全部失败：reject 交给调用方弹出明确提示（禁止静默失败）
          if (!urls.length) {
            reject(buildError(ERR_UPLOAD_FAILED, errors[0] || '图片上传失败，请重试'));
            return;
          }
          // 部分失败：成功的照常用，同时提示失败原因
          if (errors.length) {
            wx.showToast({ title: errors[0], icon: 'none', duration: 2500 });
          }
          resolve(urls);
        } catch (err) {
          wx.hideLoading();
          reject(err);
        }
      },
      fail: (err) => {
        console.error('[chooseAndUpload] chooseMedia 失败：', (err && err.errMsg) || '');
        if (isChooseCancel(err)) {
          reject(buildError(ERR_CHOOSE_CANCEL, '已取消选择'));
        } else {
          reject(buildError(ERR_UPLOAD_FAILED, '无法打开相册 / 相机，请检查微信权限'));
        }
      }
    });
  });
}
function showError(err) {
  // 被新设备顶下线时已经弹过说明弹窗，这里不再叠加一条 toast（避免提示打架）
  if (err && err.data && err.data.kicked) return;
  wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none', duration: 2000 });
}

module.exports = {
  MAX_UPLOAD_SIZE,
  ERR_CHOOSE_CANCEL,
  ERR_UPLOAD_FAILED,
  BASE_URL,
  setBaseUrl,
  getBaseUrl,
  request,
  get,
  post,
  uploadImage,
  chooseAndUpload,
  showError,
  refreshToken
};
