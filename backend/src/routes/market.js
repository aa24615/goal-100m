import express from 'express';
import pool from '../db.js';
import { getSnapshot, getDetail, getSummary, getMarketStatus, forceNextSession } from '../market.js';
import { authMiddleware } from '../auth.js';
import { asyncHandler } from '../middleware.js';
import { isDbInt } from '../utils/num.js';

const router = express.Router();

router.get('/stocks', (req, res) => {
  res.json(getSnapshot());
});

router.get('/market/summary', (req, res) => {
  res.json(getSummary());
});

// 交易日历 / 行情引擎状态
router.get('/market/status', (req, res) => {
  res.json(getMarketStatus());
});

// 演示用：强制收盘结算并进入下一交易日
router.post(
  '/market/next-day',
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await forceNextSession());
  })
);

// 日 K 线：来自 stock_daily（一个 seq = 一个虚拟交易日）
// 同一 trade_date 可能存在多个 seq（压缩模式下会轮转多次），这里按 seq 序列返回，
// 保证回放（RQ-01）与 K 线展示用的是同一份数据。
router.get('/stocks/:code/daily', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const raw = Number(req.query.days);
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(400, Math.floor(raw)) : 120;
    // 回放场景需要「按 seq 区间」取数（历史区间可能远早于最近 120 根）
    const s = Number(req.query.startSeq);
    const e = Number(req.query.endSeq);
    // isDbInt 而非 Number.isInteger：后者只判断「数学上是整数」而不做范围约束，
    // `?endSeq=1e20` 能顺利通过判定并原样下发 SQL，PostgreSQL 抛
    // 22003（out of range for type integer）被兜成 500。见 utils/num.js 的注释。
    // 判定为非法时走「不启用区间」分支（取最近 N 根）—— 这与 abc/NaN 等
    // 非区间取值既有的降级口径一致，不改变任何合法请求的结果。
    const useRange = isDbInt(s) && isDbInt(e) && e >= s;
    const { rows } = useRange
      ? await pool.query(
          `SELECT seq, trade_date, open, high, low, close, volume, amount, prev_close
             FROM stock_daily
            WHERE code = $1 AND seq BETWEEN $2 AND $3
            ORDER BY seq ASC
            LIMIT 400`,
          [code, s, e]
        )
      : await pool.query(
          `SELECT seq, trade_date, open, high, low, close, volume, amount, prev_close
             FROM stock_daily
            WHERE code = $1
            ORDER BY seq DESC
            LIMIT $2`,
          [code, days]
        );
    if (rows.length === 0) return res.status(404).json({ error: '该标的暂无历史行情' });
    // 两个分支统一按时间升序（旧 → 新）返回：前端按数组顺序推进回放游标与绘制 K 线。
    // 默认分支 SQL 是 ORDER BY seq DESC + LIMIT（取最近 N 根），需要反转；
    // 区间分支 SQL 已是 ASC，此前共用同一个 reverse() 反而被转成降序（新 → 旧），
    // 与默认分支口径相反 —— 按区间请求时 K 线左右镜像、均线/涨跌幅方向全反。
    const ordered = useRange ? rows : rows.slice().reverse();
    res.json({
      code,
      count: rows.length,
      bars: ordered.map((r) => ({
        seq: r.seq,
        date: r.trade_date instanceof Date ? r.trade_date.toISOString().slice(0, 10) : String(r.trade_date),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        amount: Number(r.amount),
        prevClose: Number(r.prev_close),
      })),
    });
  } catch (e) {
    next(e);
  }
});

// 全部标的的历史交易日序号区间（回放选择区间时用）
router.get('/market/history', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT MIN(seq)::int AS "minSeq", MAX(seq)::int AS "maxSeq", COUNT(DISTINCT seq)::int AS bars FROM stock_daily'
    );
    res.json(rows[0] || { minSeq: null, maxSeq: null, bars: 0 });
  } catch (e) {
    next(e);
  }
});

router.get('/stocks/:code', (req, res) => {
  const d = getDetail(req.params.code.toUpperCase());
  if (!d) return res.status(404).json({ error: '股票不存在' });
  res.json(d);
});

export default router;
