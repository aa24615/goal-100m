/**
 * 真实 A 股数据全量同步脚本
 *
 * 用法（在宿主机执行，DB 已映射 5433）：
 *   DATABASE_URL=postgresql://papertrade:papertrade@localhost:5433/papertrade \
 *     node src/scripts/syncMarket.js [--limit 50] [--reset] [--concurrency 10] [--only 600000]
 *
 * 流程：
 *   0. buildCalendar 构建交易日历（trade_date -> 稠密 seq）
 *   1. syncUniverse  拉取全 A 股列表 -> upsert stocks
 *   2. syncHistory   并发拉取每只股票「上市至今」日线 -> 批量写入 stock_daily
 *   3. finalize      用最新一根日线回填 stocks 的 price/prev_close/开高低/成交量
 *
 * 关键约定：
 *   - stock_daily.seq 是「稠密连续交易日序号」（来自 trade_calendar），不是日期编码。
 *     回放训练用 cursor_seq ± 1 步进、seq BETWEEN 取区间，必须是连续序号，否则回放失效。
 *   - 日历由 000001（1991 上市至今）+ 600000 的 K 线日期并集构建，覆盖几乎所有交易日
 *   - prev_close 由「上一根 K 线的收盘」计算，首根用开盘价
 *   - 单只失败不中断整体；失败的 code 末尾汇总，重跑即可续传
 *   - 默认跳过已有日线的股票（--reset 会清空 stock_daily 后全量重来）
 */

import pool from '../db.js';
import { fetchAllStocks, fetchDailyBars } from '../datasource/index.js';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const LIMIT = Number(arg('limit', 0)) || 0; // 0 = 全部
const RESET = argv.includes('--reset');
const FORCE = argv.includes('--force'); // 忽略「已有数据」跳过逻辑，全部重拉（用于东财恢复后扩展历史）

// 只做回填：用最新日线重算 stocks 的价格/昨收/上市日期/股本。
// 场景：行情引擎或其他进程改写了 stocks.price 后，用它把价格拉回真实值。
const FINALIZE_ONLY = argv.includes('--finalize-only');
const CONCURRENCY = Number(arg('concurrency', 10)) || 10;
const ONLY = arg('only', '');
const CHUNK = 2000; // 单条 INSERT 的行数

// 用于构建交易日历的「长历史」标的：000001 自 1991 年上市，600000 自 1999 年
const CALENDAR_SEEDS = ['000001', '600000'];

const t0 = Date.now();
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * pg 返回的 date 是「本地时区 0 点」的 Date 对象。
 * 不能用 toISOString()：在 UTC+8 下会被减去 8 小时、整体变成前一天，
 * 导致日期匹配错位（表现为每只股票的周五数据对不上）。必须用本地日期分量格式化。
 */
function toDateStr(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// ---------- 0. 交易日历 ----------
async function buildCalendar() {
  const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM trade_calendar');
  if (cnt[0].c > 0) {
    const { rows } = await pool.query('SELECT seq, trade_date FROM trade_calendar ORDER BY seq ASC');
    const m = new Map(rows.map((r) => [toDateStr(r.trade_date), r.seq]));
    console.log(`[日历] 复用已有 ${m.size} 个交易日`);
    return m;
  }

  const dates = new Set();
  for (const seed of CALENDAR_SEEDS) {
    const bars = await fetchDailyBars(seed);
    for (const b of bars) dates.add(b.date);
    console.log(`[日历] ${seed} 贡献 ${bars.length} 个交易日`);
  }
  const sorted = [...dates].sort();
  const seqs = sorted.map((_, i) => i + 1);
  for (let i = 0; i < sorted.length; i += CHUNK) {
    await pool.query(
      `INSERT INTO trade_calendar (seq, trade_date)
       SELECT * FROM unnest($1::int[], $2::date[])
       ON CONFLICT (trade_date) DO NOTHING`,
      [seqs.slice(i, i + CHUNK), sorted.slice(i, i + CHUNK)]
    );
  }
  const m = new Map(sorted.map((d, i) => [d, i + 1]));
  console.log(`[日历] 构建完成 ${m.size} 个交易日（${sorted[0]} ~ ${sorted[sorted.length - 1]}）`);
  return m;
}

// ---------- 1. 标的池 ----------
async function syncUniverse() {
  const list = await fetchAllStocks();
  console.log(`[标的] 拉取到 ${list.length} 只 A 股`);

  const codes = list.map((s) => s.code);
  // 批量 upsert；行情类字段先置 0，稍后由 finalize 用真实日线回填
  await pool.query(
    `INSERT INTO stocks (code, name, sector, exchange, market_cap,
                         prev_close, open_price, price, high, low, volume, day_amount)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[]),
                   LATERAL (SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
                                   0::bigint, 0::numeric) z
     ON CONFLICT (code) DO UPDATE SET
       name = EXCLUDED.name,
       -- 新浪兜底时 sector 只有「其他」，不要用占位值覆盖已同步到的真实行业
       sector = CASE WHEN EXCLUDED.sector <> '其他' THEN EXCLUDED.sector ELSE stocks.sector END,
       exchange = EXCLUDED.exchange,
       market_cap = CASE WHEN EXCLUDED.market_cap > 0 THEN EXCLUDED.market_cap ELSE stocks.market_cap END,
       updated_at = now()`,
    [codes, list.map((s) => s.name), list.map((s) => s.sector), list.map((s) => s.exchange), list.map((s) => s.marketCap || 0)]
  );
  console.log(`[标的] 写入/更新 ${codes.length} 只`);

  // 全量同步时清理「非真实标的」（历史上杜撰的假股票），连带清掉其持仓/流水
  if (LIMIT === 0 && !ONLY) {
    const r = await pool.query('DELETE FROM stocks WHERE code <> ALL($1::text[])', [codes]);
    if (r.rowCount > 0) console.log(`[标的] 清理非真实标的 ${r.rowCount} 只（级联清除其持仓与流水）`);
  }
  return list;
}

// ---------- 2. 日线历史 ----------
/** 写入一只股票的全部日线；返回跳过的根数（日期不在日历内） */
async function insertBars(code, bars, seqOf) {
  const rows = [];
  let skipped = 0;
  for (const b of bars) {
    const seq = seqOf.get(b.date);
    if (!seq) {
      skipped += 1;
      continue;
    }
    rows.push({ ...b, seq });
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const seqs = [];
    const dates = [];
    const opens = [];
    const highs = [];
    const lows = [];
    const closes = [];
    const vols = [];
    const amounts = [];
    const prevs = [];
    for (let k = 0; k < part.length; k += 1) {
      const r = part[k];
      seqs.push(r.seq);
      dates.push(r.date);
      opens.push(r.open);
      highs.push(r.high);
      lows.push(r.low);
      closes.push(r.close);
      vols.push(r.volume);
      amounts.push(r.amount);
      prevs.push(k === 0 ? (i === 0 ? r.open : rows[i - 1].close) : part[k - 1].close);
    }
    await pool.query(
      `INSERT INTO stock_daily
         (code, seq, trade_date, open, high, low, close, volume, amount, prev_close)
       SELECT $1,
              * FROM unnest($2::int[], $3::date[], $4::numeric[], $5::numeric[],
                            $6::numeric[], $7::numeric[], $8::bigint[], $9::numeric[], $10::numeric[])
       ON CONFLICT (code, seq) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume,
         amount = EXCLUDED.amount, prev_close = EXCLUDED.prev_close`,
      [code, seqs, dates, opens, highs, lows, closes, vols, amounts, prevs]
    );
  }
  return skipped;
}

/** 简单并发池 */
async function runPool(items, limit, worker) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const my = idx;
      idx += 1;
      if (my >= items.length) return;
      await worker(items[my], my);
    }
  });
  await Promise.all(runners);
}

async function syncHistory(list, seqOf) {
  let codes = list.map((s) => s.code);
  if (ONLY) {
    const set = new Set(ONLY.split(',').map((c) => c.trim()));
    codes = codes.filter((c) => set.has(c));
  }
  if (LIMIT > 0) codes = codes.slice(0, LIMIT);

  if (RESET) {
    console.log('[历史] --reset：清空 stock_daily');
    await pool.query('TRUNCATE TABLE stock_daily');
  } else if (!ONLY && LIMIT === 0 && !FORCE) {
    const { rows } = await pool.query('SELECT DISTINCT code FROM stock_daily');
    const done = new Set(rows.map((r) => r.code));
    const before = codes.length;
    codes = codes.filter((c) => !done.has(c));
    if (before !== codes.length) {
      console.log(`[历史] 续传：${before - codes.length} 只已有数据，待同步 ${codes.length} 只`);
    }
  }

  console.log(`[历史] 待同步 ${codes.length} 只，并发 ${CONCURRENCY}`);
  let ok = 0;
  let empty = 0;
  let bars = 0;
  let skipped = 0;
  const failed = [];

  const one = async (code, i) => {
    try {
      const b = await fetchDailyBars(code);
      if (b.length === 0) {
        empty += 1;
      } else {
        skipped += await insertBars(code, b, seqOf);
        bars += b.length;
        ok += 1;
      }
    } catch {
      failed.push(code);
    }
    const done = ok + empty + failed.length;
    if (done % 200 === 0 || done === codes.length) {
      console.log(
        `[历史] 进度 ${done}/${codes.length} 成功=${ok} 空=${empty} 失败=${failed.length} K线=${bars} 用时=${((Date.now() - t0) / 1000).toFixed(0)}s`
      );
    }
  };

  await runPool(codes, CONCURRENCY, one);

  // 失败的重试一轮（多为网络抖动）
  if (failed.length > 0) {
    console.log(`[历史] 重试 ${failed.length} 只...`);
    const retry = [...failed];
    failed.length = 0;
    for (const code of retry) {
      try {
        const b = await fetchDailyBars(code);
        if (b.length === 0) empty += 1;
        else {
          skipped += await insertBars(code, b, seqOf);
          bars += b.length;
          ok += 1;
        }
      } catch {
        failed.push(code);
      }
    }
  }

  console.log(
    `[历史] 完成：成功 ${ok} 空 ${empty} 失败 ${failed.length}，共 ${bars} 根（跳过 ${skipped} 根不在日历），用时 ${fmt(Date.now() - t0)}`
  );
  if (failed.length > 0) {
    console.log(`[历史] 失败清单（重跑可续传）：${failed.slice(0, 50).join(',')}${failed.length > 50 ? ' ...' : ''}`);
  }
}

// ---------- 3. 回填当前行情 ----------
async function finalize() {
  const r1 = await pool.query(
    `UPDATE stocks s SET
        price = l.close, prev_close = l.prev_close, open_price = l.open,
        high = l.high, low = l.low, volume = l.volume, day_amount = l.amount,
        updated_at = now()
       FROM (
         SELECT DISTINCT ON (code) code, open, high, low, close, volume, amount, prev_close
           FROM stock_daily ORDER BY code, seq DESC
       ) l
      WHERE s.code = l.code`
  );
  const r2 = await pool.query(
    `UPDATE stocks s SET listing_date = l.first_date
       FROM (SELECT code, MIN(trade_date) AS first_date FROM stock_daily GROUP BY code) l
      WHERE s.code = l.code`
  );
  const r3 = await pool.query(
    `UPDATE stocks SET shares = ROUND(market_cap / NULLIF(price, 0))
      WHERE market_cap > 0 AND price > 0 AND (shares IS NULL OR shares = 0)`
  );
  console.log(`[回填] 价格 ${r1.rowCount} 只，上市日期 ${r2.rowCount} 只，股本 ${r3.rowCount} 只`);

  await pool.query(
    `INSERT INTO sync_state (k, v) VALUES ('last_sync', $1)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [new Date().toISOString()]
  );
}

// ---------- main ----------
async function main() {
  console.log('===== A 股真实数据同步开始 =====');
  if (FINALIZE_ONLY) {
    console.log('[模式] 仅回填价格（--finalize-only）');
    await finalize();
    await pool.end();
    return;
  }
  const seqOf = await buildCalendar();
  const list = await syncUniverse();
  await syncHistory(list, seqOf);
  await finalize();

  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM stocks) AS stocks,
            (SELECT COUNT(*)::int FROM stock_daily) AS bars,
            (SELECT COUNT(DISTINCT trade_date)::int FROM stock_daily) AS days,
            (SELECT COUNT(*)::int FROM trade_calendar) AS cal`
  );
  const r = rows[0];
  console.log(
    `===== 完成 ===== 标的 ${r.stocks} 只，K线 ${r.bars} 根，覆盖 ${r.days} 个交易日，日历 ${r.cal} 天，总用时 ${fmt(Date.now() - t0)}`
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error('[同步失败]', e);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
