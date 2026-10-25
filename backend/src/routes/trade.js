import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler } from '../middleware.js';
import { logger } from '../logger.js';
import { getDetail } from '../market.js';
import { T1_ENABLED, PRICE_TOLERANCE } from '../fees.js';
import { guardTrade } from '../rules.js';
import { executeTrade, validateOrder } from '../services/tradeService.js';
import { getPortfolio } from '../services/portfolioService.js';
import { listTransactions } from '../services/transactionService.js';

const router = express.Router();

// 持仓与资产概览
router.get(
  '/portfolio',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await getPortfolio(req.userId));
  })
);

// 市价买卖交易
router.post(
  '/trade',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const { code, type, quantity } = req.body || {};
    const clientPrice = Number(req.body?.clientPrice);
    if (!code || !['BUY', 'SELL'].includes(type) || !Number.isInteger(quantity) || quantity <= 0) {
      logger.warn('交易失败: 参数错误', { userId: uid, code, type, quantity });
      return res.status(400).json({ error: '参数错误' });
    }
    // A 股整手约束：市价单此前缺这道校验，而限价单（orders.js:48）与回放
    // （replayService.js:428）都有 —— 同一业务三条链路口径不一致，
    // 会产生 37 股这类其它链路都不认可的持仓，后续无法用等量限价单卖出。
    if (quantity % 100 !== 0) {
      logger.warn('交易失败: 数量非整手', { userId: uid, code, type, quantity });
      return res.status(400).json({ error: '交易数量需为 100 的整数倍' });
    }
    const c = code.toUpperCase();
    const d = getDetail(c);
    if (!d) {
      logger.warn('交易失败: 股票不存在', { userId: uid, code: c });
      return res.status(404).json({ error: '股票不存在' });
    }

    const price = d.price;
    // RQ-49/50：停牌、退市、无报价、分板块涨跌停统一在此拦截。
    // 此前全市场一刀切 ±10%（旧 fees.js 常量），在创业板/科创/北交所/ST 标的上
    // 练出来的是错误肌肉记忆（F-03）；停牌标的还能正常下单成功（F-04）。
    const guard = guardTrade({
      code: c,
      name: d.name,
      type,
      price,
      prevClose: d.prevClose,
      volume: d.volume,
      quantity,
      tradeStatus: d.halted ? 'HALTED' : d.tradeStatus,
      listingDate: d.listingDate,
    });
    if (!guard.ok) {
      logger.warn('下单被交易规则拒绝', { userId: uid, code: c, type, rule: guard.code });
      return res.status(guard.status).json({
        error: guard.message,
        rule: guard.code,
        limits: guard.limits,
      });
    }

    const err = validateOrder({
      type,
      price,
      limitUp: guard.limits.limitUp,
      limitDown: guard.limits.limitDown,
      clientPrice,
    });
    if (err) {
      logger.warn('下单校验未通过', { userId: uid, code: c, type, reason: err.message });
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }

    // executeTrade 抛出的业务错误（资金不足 / T+1 / 持仓不足）由 errorHandler 透传
    const result = await executeTrade({ uid, code: c, type, quantity, price, stockName: d.name });
    res.json(result);
  })
);

// 交易记录
router.get(
  '/transactions',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const size = Number(req.query.size) || 20;
    res.json(await listTransactions(req.userId, page, size));
  })
);

export default router;
