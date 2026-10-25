/**
 * 集成测试前置：播种多交易日历史（RQ-01 回放区间的前置条件）
 *
 * 背景：2026-10 标的池切换为真实 A 股数据后，`forceNextSession()` 不再推进交易日
 * （真实行情下凭空造开盘价没有意义，行为改为「刷新一次真实快照」）。
 * 而集成测试库里只有 28 只种子标的、1 个交易日，`stock_daily` 只有 1 根 K 线，
 * 于是 `GET /replay/range` 返回 `minSeq == maxSeq`，RQ-01 ~ RQ-05 的 9 条用例
 * 全部挂在「区间过短」上——同时每次 `forceNextSession()` 还会真的去打行情接口，
 * 单条用例耗时 63 秒。
 *
 * 这里直接在测试库写入 N 个交易日的 `trade_calendar` + `stock_daily`，
 * 价格由代码散列确定（不随机、可复现），只为让回放/双盲有可推进的区间。
 * **仅测试使用，不参与生产代码路径。**
 */

const DAY = 86400000;

/** 由代码散列出稳定的价格波动，保证每次跑出来的历史完全一致（回放成绩可复查） */
function hashOf(code) {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 31 + code.charCodeAt(i)) % 100003;
  return h % 997;
}

/** 过去 N 个交易日（跳过周末），从旧到新 */
export function pastTradingDays(n, today = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 0; out.length < n; i += 1) {
    const cur = new Date(d.getTime() - i * DAY);
    const wd = cur.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push(cur.toISOString().slice(0, 10));
  }
  return out.reverse(); // 旧 → 新
}

/**
 * @param {import('pg').Pool} pool
 * @param {object} o { days, startPrice }
 * @returns {Promise<{seqFrom:number, seqTo:number, codes:number}>}
 */
export async function seedHistoryBars(pool, { days = 40, startSeq = 1 } = {}) {
  const { rows: stocks } = await pool.query('SELECT code, name, prev_close, price FROM stocks');
  if (stocks.length === 0) return { seqFrom: 0, seqTo: 0, codes: 0 };

  const dates = pastTradingDays(days);

  // 交易日历：seq 必须稠密连续（1..N），回放用 cursor_seq ± 1 步进
  for (let i = 0; i < dates.length; i += 1) {
    await pool.query(
      'INSERT INTO trade_calendar (seq, trade_date) VALUES ($1,$2) ON CONFLICT (trade_date) DO NOTHING',
      [startSeq + i, dates[i]]
    );
  }

  const codes = [];
  const seqs = [];
  const tradeDates = [];
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const vols = [];
  const amounts = [];
  const prevs = [];

  for (const s of stocks) {
    const seed = hashOf(s.code);
    let prev = Number(s.prev_close) > 0 ? Number(s.prev_close) : Number(s.price) || 10;
    for (let i = 0; i < dates.length; i += 1) {
      // 确定性波动：不同标的不同相位，避免所有票走势完全一样导致回放无意义
      const phase = (seed + i * 37) % 360;
      const drift = Math.sin((phase * Math.PI) / 180) * 0.012;
      const open = round2(prev * (1 + drift * 0.3));
      const close = round2(prev * (1 + drift));
      const high = round2(Math.max(open, close) * (1 + Math.abs(drift) * 0.4 + 0.002));
      const low = round2(Math.min(open, close) * (1 - Math.abs(drift) * 0.4 - 0.002));
      const volume = 100000 + ((seed * (i + 1)) % 900000);
      codes.push(s.code);
      seqs.push(startSeq + i);
      tradeDates.push(dates[i]);
      opens.push(open);
      highs.push(high);
      lows.push(low);
      closes.push(close);
      vols.push(volume);
      amounts.push(round2(close * volume));
      prevs.push(prev);
      prev = close;
    }
  }

  // 批量写入，避免 28 × 40 = 1120 次往返
  await pool.query(
    `INSERT INTO stock_daily (code, seq, trade_date, open, high, low, close, volume, amount, prev_close)
     SELECT * FROM unnest(
       $1::text[], $2::int[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[],
       $7::numeric[], $8::bigint[], $9::numeric[], $10::numeric[]
     ) AS t(code, seq, trade_date, open, high, low, close, volume, amount, prev_close)
     ON CONFLICT (code, seq) DO UPDATE SET close = EXCLUDED.close, prev_close = EXCLUDED.prev_close`,
    [codes, seqs, tradeDates, opens, highs, lows, closes, vols, amounts, prevs]
  );

  return { seqFrom: startSeq, seqTo: startSeq + dates.length - 1, codes: stocks.length };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
