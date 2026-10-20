import express from 'express';
import pool from '../db.js';
import { authMiddleware } from '../auth.js';
import { getDetail } from '../market.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware.js';

const router = express.Router();

// A 股风格费用：佣金万3（最低5元）、卖出印花税万5、过户费万0.1
const COMMISSION_RATE = 0.0003;
const STAMP_RATE = 0.0005;
const TRANSFER_RATE = 0.00001;
const MIN_COMMISSION = 5;

function calcFees(amount, type) {
  const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE);
  const stamp = type === 'SELL' ? amount * STAMP_RATE : 0;
  const transfer = amount * TRANSFER_RATE;
  return Math.round((commission + stamp + transfer) * 100) / 100;
}

// 持仓与资产概览
router.get(
  '/portfolio',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const u = await pool.query('SELECT cash, initial_capital FROM users WHERE id=$1', [uid]);
    if (!u.rows[0]) {
      logger.warn('查询持仓失败: 用户不存在', { userId: uid });
      return res.status(404).json({ error: '用户不存在' });
    }
    const cash = Number(u.rows[0].cash);
    const initial = Number(u.rows[0].initial_capital);
    const h = await pool.query('SELECT * FROM holdings WHERE user_id=$1', [uid]);

    const holdings = [];
    let marketValue = 0;
    let costValue = 0;
    for (const r of h.rows) {
      const d = getDetail(r.stock_code);
      const price = d ? d.price : Number(r.avg_cost);
      const qty = r.quantity;
      const mv = qty * price;
      const cv = qty * Number(r.avg_cost);
      marketValue += mv;
      costValue += cv;
      holdings.push({
        code: r.stock_code,
        name: d ? d.name : r.stock_code,
        quantity: qty,
        avgCost: Number(r.avg_cost),
        price,
        marketValue: Math.round(mv * 100) / 100,
        pnl: Math.round((mv - cv) * 100) / 100,
        pnlPct: cv ? Math.round(((mv - cv) / cv) * 10000) / 100 : 0,
      });
    }
    const totalAssets = cash + marketValue;
    res.json({
      cash,
      initialCapital: initial,
      marketValue: Math.round(marketValue * 100) / 100,
      costValue: Math.round(costValue * 100) / 100,
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalPnl: Math.round((totalAssets - initial) * 100) / 100,
      totalPnlPct: Math.round(((totalAssets - initial) / initial) * 10000) / 100,
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
    });
  })
);

// 买卖交易
router.post(
  '/trade',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const { code, type, quantity } = req.body || {};
    if (!code || !['BUY', 'SELL'].includes(type) || !Number.isInteger(quantity) || quantity <= 0) {
      logger.warn('交易失败: 参数错误', { userId: uid, code, type, quantity });
      return res.status(400).json({ error: '参数错误' });
    }
    const c = code.toUpperCase();
    const d = getDetail(c);
    if (!d) {
      logger.warn('交易失败: 股票不存在', { userId: uid, code: c });
      return res.status(404).json({ error: '股票不存在' });
    }

    const price = d.price;
    const amount = Math.round(price * quantity * 100) / 100;
    const fee = calcFees(amount, type);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query('SELECT cash FROM users WHERE id=$1 FOR UPDATE', [uid]);
      if (!u.rows[0]) {
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('交易失败: 用户不存在', { userId: uid });
        return res.status(404).json({ error: '用户不存在' });
      }
      const cash = Number(u.rows[0].cash);

      if (type === 'BUY') {
        const total = amount + fee;
        if (total > cash) {
          await client.query('ROLLBACK').catch(() => {});
          logger.warn('买入失败: 可用资金不足', {
            userId: uid,
            code: c,
            quantity,
            need: Math.round(total * 100) / 100,
            cash,
          });
          return res.status(400).json({ error: '可用资金不足' });
        }
        await client.query('UPDATE users SET cash = cash - $1 WHERE id=$2', [total, uid]);
        const h = await client.query('SELECT * FROM holdings WHERE user_id=$1 AND stock_code=$2', [
          uid,
          c,
        ]);
        if (h.rows.length === 0) {
          await client.query(
            'INSERT INTO holdings (user_id, stock_code, quantity, avg_cost) VALUES ($1, $2, $3, $4)',
            [uid, c, quantity, price]
          );
        } else {
          const r = h.rows[0];
          const newQty = r.quantity + quantity;
          const newAvg =
            Math.round(((r.quantity * Number(r.avg_cost) + amount) / newQty) * 100) / 100;
          await client.query(
            'UPDATE holdings SET quantity=$1, avg_cost=$2, updated_at=now() WHERE id=$3',
            [newQty, newAvg, r.id]
          );
        }
      } else {
        const h = await client.query('SELECT * FROM holdings WHERE user_id=$1 AND stock_code=$2', [
          uid,
          c,
        ]);
        if (h.rows.length === 0 || h.rows[0].quantity < quantity) {
          await client.query('ROLLBACK').catch(() => {});
          logger.warn('卖出失败: 可用持仓不足', {
            userId: uid,
            code: c,
            want: quantity,
            hold: h.rows[0]?.quantity ?? 0,
          });
          return res.status(400).json({ error: '可用持仓不足' });
        }
        const r = h.rows[0];
        const newQty = r.quantity - quantity;
        if (newQty === 0) {
          await client.query('DELETE FROM holdings WHERE id=$1', [r.id]);
        } else {
          await client.query(
            'UPDATE holdings SET quantity=$1, updated_at=now() WHERE id=$2',
            [newQty, r.id]
          );
        }
        await client.query('UPDATE users SET cash = cash + $1 WHERE id=$2', [amount - fee, uid]);
      }

      await client.query(
        'INSERT INTO transactions (user_id, stock_code, stock_name, type, quantity, price, amount, fee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [uid, c, d.name, type, quantity, price, amount, fee]
      );
      await client.query('COMMIT');
      logger.info('交易成功', { userId: uid, type, code: c, quantity, price, amount, fee });
      res.json({ ok: true, type, code: c, quantity, price, amount, fee });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('交易异常: 数据库错误', { userId: uid, code: c, type, quantity, err: e });
      throw e;
    } finally {
      client.release();
    }
  })
);

// 交易记录
router.get(
  '/transactions',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(50, Number(req.query.size) || 20);
    const off = (page - 1) * size;
    const c = await pool.query('SELECT COUNT(*)::int AS t FROM transactions WHERE user_id=$1', [uid]);
    const r = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [uid, size, off]
    );
    res.json({
      total: c.rows[0].t,
      page,
      size,
      items: r.rows.map((x) => ({
        id: x.id,
        stockCode: x.stock_code,
        stockName: x.stock_name,
        type: x.type,
        quantity: x.quantity,
        price: Number(x.price),
        amount: Number(x.amount),
        fee: Number(x.fee),
        createdAt: x.created_at,
      })),
    });
  })
);

export default router;
