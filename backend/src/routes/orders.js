import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler, parseIdParam } from '../middleware.js';
import { listOrders, createOrder, cancelOrder } from '../orders.js';

const router = express.Router();

// 我的委托（默认全部，?status=PENDING 只看未成交）
router.get(
  '/orders',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    res.json(await listOrders(req.userId, status));
  })
);

// 下限价委托
router.post(
  '/orders',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { code, side, price, quantity } = req.body || {};
    if (!code || !side || price === undefined || quantity === undefined) {
      return res.status(400).json({ error: '参数错误' });
    }
    const r = await createOrder({
      userId: req.userId,
      code: String(code),
      side: String(side).toUpperCase(),
      limitPrice: Number(price),
      quantity: Number(quantity),
    });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  })
);

// 撤单
router.delete(
  '/orders/:id',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const orderId = parseIdParam(req.params.id);
    if (orderId === null) return res.status(400).json({ error: '委托 ID 无效' });
    const r = await cancelOrder({ userId: req.userId, orderId });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  })
);

export default router;
