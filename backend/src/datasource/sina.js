/**
 * 新浪财经行情数据源（东方财富不可用时的兜底）
 *
 * 能力：
 *  1. fetchAllStocks()      —— 沪深京 A 股列表（代码/名称/现价/昨收/开高低/量额）
 *  2. fetchRealtimeQuotes() —— 同上（列表接口本身即带实时价）
 *  3. fetchDailyBars(code)  —— 日 K 线（兜底用；新浪单次最多约 1023 根，
 *                              全量历史优先用东方财富 push2his）
 *
 * 与东方财富的差异（重要）：
 *  - 新浪列表**不含行业与总市值**，因此 sector 只能给默认值、无法算股本
 *  - 新浪 K 线的 volume 单位就是「股」，无需换算（东方财富是「手」）
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://finance.sina.com.cn';

const LIST_URL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const KLINE_URL = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData';

const PAGE_SIZE = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '' || v === '-') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 新浪 symbol：sh600000 / sz000001 / bj920000 */
export function symbolOf(code) {
  const c = String(code);
  if (/^920/.test(c)) return `bj${c}`;
  if (/^(6|9)/.test(c)) return `sh${c}`;
  if (/^(4|8)/.test(c)) return `bj${c}`;
  return `sz${c}`;
}

async function getJson(url, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: REFERER },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return JSON.parse(await res.text());
      }
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) await sleep(300 * 2 ** i + Math.random() * 300);
  }
  throw lastErr || new Error('request failed');
}

/**
 * 拉取 A 股列表（分页直到空页）
 * @returns {Promise<Array<{code,name,price,prevClose,open,high,low,volume,amount}>>}
 */
export async function fetchAllStocks() {
  const out = [];
  for (let page = 1; page <= 200; page += 1) {
    const url =
      `${LIST_URL}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
    let arr = [];
    try {
      arr = await getJson(url, { retries: 2 });
    } catch {
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const d of arr) {
      const code = String(d.code || '').trim();
      if (!/^\d{6}$/.test(code)) continue;
      const price = num(d.trade, 0);
      out.push({
        code,
        name: String(d.name || '').trim(),
        sector: '', // 新浪列表不含行业，由上层决定默认值
        price,
        prevClose: num(d.settlement, price),
        open: num(d.open, price),
        high: num(d.high, price),
        low: num(d.low, price),
        volume: Math.round(num(d.volume, 0)), // 新浪单位已是「股」
        amount: num(d.amount, 0),
        marketCap: Math.round(num(d.mktcap, 0) * 10000), // 万元 -> 元
        exchange: /^920/.test(code) ? 'BJ' : /^(6|9)/.test(code) ? 'SH' : /^(4|8)/.test(code) ? 'BJ' : 'SZ',
      });
    }
    if (arr.length < PAGE_SIZE) break;
    await sleep(120);
  }
  return out;
}

/** 实时快照：直接复用列表接口（本身即实时价） */
export async function fetchRealtimeQuotes() {
  const list = await fetchAllStocks();
  const map = new Map();
  for (const s of list) {
    // 收盘后 trade（现价）常为 0，但 settlement（昨收）仍有值：
    // 此时用昨收兜底，保证快照完整（否则只有零星几只，前端拿不到任何行情）
    const price = s.price > 0 ? s.price : s.prevClose;
    if (!(price > 0)) continue;
    map.set(s.code, {
      price,
      open: s.open > 0 ? s.open : price,
      high: s.high > 0 ? s.high : price,
      low: s.low > 0 ? s.low : price,
      prevClose: s.prevClose > 0 ? s.prevClose : price,
      volume: s.volume ?? 0,
      amount: s.amount ?? 0,
    });
  }
  return map;
}

/**
 * 日 K 线（兜底）
 * @param {string} code
 * @param {{datalen?:number}} opts 新浪单次上限约 1023
 */
export async function fetchDailyBars(code, { datalen = 1023 } = {}) {
  const url = `${KLINE_URL}?symbol=${symbolOf(code)}&scale=240&ma=no&datalen=${datalen}`;
  const arr = await getJson(url, { retries: 2 });
  if (!Array.isArray(arr)) return [];
  const bars = [];
  for (const d of arr) {
    const day = String(d.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    bars.push({
      date: day,
      open: num(d.open, 0),
      close: num(d.close, 0),
      high: num(d.high, 0),
      low: num(d.low, 0),
      volume: Math.round(num(d.volume, 0)), // 新浪单位已是「股」
      amount: 0, // 新浪 K 线接口不返回成交额
    });
  }
  return bars;
}

export default { fetchAllStocks, fetchRealtimeQuotes, fetchDailyBars, symbolOf };
