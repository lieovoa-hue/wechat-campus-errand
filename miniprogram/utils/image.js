/**
 * =====================================================================
 * 上传前图片压缩（canvas 重绘 → 导出 JPG）
 * ---------------------------------------------------------------------
 * 【为什么需要】
 *   1) 体积大：一张 3MB 的手机截图 = 3MB 磁盘 + 3MB 流量；一个任务最多 6 张图
 *      （3 张物品 + 3 张送达），一单就能吃掉十几 MB，本地磁盘和用户流量都受不了；
 *   2) 微信自带的 wx.compressImage 的 quality 参数**只对 JPG 生效**，
 *      手机截图大多是 PNG，压完几乎没变小——所以光靠它不够。
 *
 * 【本模块怎么压】
 *   用离屏 canvas 把图片重新绘制到「长边不超过 MAX_SIDE」的画布上，再导出为 JPG。
 *   实测 3MB 的 PNG 截图通常能压到 200~400KB，一单从约 9MB 降到约 1.5MB。
 *
 * 【降级链：任何一环失败都不会挡住用户】
 *   1) 离屏 canvas 重绘导出 JPG（首选：既能缩放，又能把 PNG 转成 JPG）
 *   2) wx.compressImage（老基础库 / 离屏 canvas 不可用时；带 compressedWidth 缩放）
 *   3) 原图直传（后端仍会做 2MB 上限兜底，绝不让用户卡在「选不了图」）
 * =====================================================================
 */

/** 压缩后长边上限（像素）：1280 足够看清取件码、门牌号与物品细节 */
const MAX_SIDE = 1280;
/** 导出 JPG 质量（0-100） */
const QUALITY = 75;
/** 兜底重压时的质量 */
const QUALITY_LOW = 45;

/**
 * 读取图片宽高
 * @param {string} src 本地临时文件路径
 * @returns {Promise<{width:number,height:number}|null>} 失败返回 null
 */
function getImageInfo(src) {
  return new Promise((resolve) => {
    if (typeof wx.getImageInfo !== 'function') {
      resolve(null);
      return;
    }
    wx.getImageInfo({
      src,
      success: (info) => resolve({
        width: Number((info && info.width) || 0),
        height: Number((info && info.height) || 0)
      }),
      fail: () => resolve(null)
    });
  });
}

/**
 * 按长边上限换算目标尺寸（只缩不放）
 * @returns {{width:number,height:number}}
 */
function fitSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * 通道一：离屏 canvas 重绘后导出 JPG
 * @param {string} src 原图路径
 * @param {number} quality 导出质量 0-100
 * @param {number} maxSide 长边上限
 * @returns {Promise<string>} 压缩后路径；不可用或失败时返回空串
 */
function compressByCanvas(src, quality, maxSide) {
  return new Promise((resolve) => {
    if (typeof wx.createOffscreenCanvas !== 'function'
      || typeof wx.canvasToTempFilePath !== 'function') {
      resolve('');
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || '');
    };

    getImageInfo(src).then((info) => {
      if (!info || !info.width || !info.height) {
        finish('');
        return;
      }
      const { width, height } = fitSize(info.width, info.height, maxSide);

      let canvas = null;
      try {
        canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
      } catch (err) {
        canvas = null;
      }
      if (!canvas || typeof canvas.getContext !== 'function'
        || typeof canvas.createImage !== 'function') {
        finish('');
        return;
      }

      const ctx = canvas.getContext('2d');
      const image = canvas.createImage();
      if (!ctx || !image) {
        finish('');
        return;
      }

      image.onload = () => {
        try {
          // PNG 的透明区域转 JPG 会变成黑块，先铺一层白底
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);
        } catch (err) {
          finish('');
          return;
        }
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'jpg',
          quality: Math.max(1, Math.min(100, quality)) / 100,
          success: (res) => finish((res && res.tempFilePath) || ''),
          fail: () => finish('')
        });
      };
      image.onerror = () => finish('');
      try {
        image.src = src;
      } catch (err) {
        finish('');
      }
    });
  });
}

/**
 * 通道二：wx.compressImage（支持 compressedWidth 的基础库会顺带缩放）
 * @param {string} src 原图路径
 * @param {number} quality 压缩质量 0-100
 * @param {number} maxSide 长边上限
 * @returns {Promise<string>} 压缩后路径；不可用时返回空串
 */
function compressByApi(src, quality, maxSide) {
  return new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') {
      resolve('');
      return;
    }
    getImageInfo(src).then((info) => {
      const options = {
        src,
        quality,
        success: (res) => resolve((res && res.tempFilePath) || ''),
        fail: () => resolve('')
      };
      // compressedWidth / compressedHeight 需要成对出现，且要 2.26.0+ 才支持
      if (info && info.width && info.height) {
        const size = fitSize(info.width, info.height, maxSide);
        if (size.width < info.width || size.height < info.height) {
          options.compressedWidth = size.width;
          options.compressedHeight = size.height;
        }
      }
      try {
        wx.compressImage(options);
      } catch (err) {
        resolve('');
      }
    });
  });
}

/**
 * 上传前压缩（对外唯一入口）
 * @param {string} src 原图本地路径
 * @param {{quality?:number, maxSide?:number}} [options]
 * @returns {Promise<string>} 压缩后的图片路径；全都失败时原样返回 src
 */
async function compressForUpload(src, options) {
  const quality = (options && options.quality) || QUALITY;
  const maxSide = (options && options.maxSide) || MAX_SIDE;
  if (!src) return src;

  const byCanvas = await compressByCanvas(src, quality, maxSide);
  if (byCanvas) return byCanvas;

  const byApi = await compressByApi(src, quality, maxSide);
  if (byApi) return byApi;

  return src;
}

module.exports = {
  MAX_SIDE,
  QUALITY,
  QUALITY_LOW,
  compressForUpload
};