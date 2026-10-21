import express from 'express';
import { authMiddleware } from '../auth.js';
import { asyncHandler } from '../middleware.js';
import { getEquity } from '../services/equityService.js';

const router = express.Router();
const DAYS = [7, 30, 90, 365, 0];

// 资产曲线 / 账户分账
router.get(
  '/equity',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const uid = req.userId;
    const rawGran = String(req.query.gran || 'day').toLowerCase();
    const gran = rawGran === 'minute' ? 'minute' : 'day';
    const raw = Number(req.query.days);
    const days = DAYS.includes(raw) ? raw : 30;
    // getEquity 抛出的业务错误（用户不存在）由 errorHandler 透传
    res.json(await getEquity(uid, gran, days));
  })
);

export default router;
