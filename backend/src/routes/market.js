import express from 'express';
import { getSnapshot, getDetail, getSummary } from '../market.js';

const router = express.Router();

router.get('/stocks', (req, res) => {
  res.json(getSnapshot());
});

router.get('/market/summary', (req, res) => {
  res.json(getSummary());
});

router.get('/stocks/:code', (req, res) => {
  const d = getDetail(req.params.code.toUpperCase());
  if (!d) return res.status(404).json({ error: '股票不存在' });
  res.json(d);
});

export default router;
