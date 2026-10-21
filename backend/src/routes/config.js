import express from 'express';
import { feeConfig } from '../fees.js';

const router = express.Router();

// 交易费用与规则由后端统一下发，前端不再硬编码
router.get('/config/fees', (req, res) => {
  res.json(feeConfig());
});

export default router;
