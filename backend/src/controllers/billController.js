/**
 * =====================================================================
 * 账单控制器（纯记账展示，无提现入口）
 * 自动记账触发点：
 *   1. 任务完成（status=3）：为接单者生成「任务收入」流水，金额为任务酬金
 *   2. 支付成功（任务上架）：为发布者生成「服务费支出」流水，金额 0.1 元
 * 普通用户仅可查看本人账单，按时间倒序排列
 * =====================================================================
 */

const Bill = require('../models/Bill');
const { ok, parsePage, buildPage } = require('../utils/common');

/**
 * GET /api/bill/list 我的收支账单列表
 */
async function list(req, res, next) {
  try {
    const { page, pageSize, offset } = parsePage(req.query);
    const type = req.query.type === undefined || req.query.type === '' ? null : Number(req.query.type);

    const { list: rows, total } = await Bill.listByUser({
      userId: req.user.id, type, offset, limit: pageSize
    });
    const summary = await Bill.summary(req.user.id);

    return ok(res, {
      ...buildPage(rows, total, page, pageSize),
      summary: {
        income: Number(summary.income || 0),
        expense: Number(summary.expense || 0)
      }
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list
};
