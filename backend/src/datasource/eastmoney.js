/**
 * 东方财富公开行情数据源（无需 key）
 *
 * 三个能力：
 *  1. fetchAllStocks()      —— 全 A 股标的列表（代码/名称/行业/市值/交易所）
 *  2. fetchDailyBars(code)  —— 单只股票「上市至今」的全部日线（不复权，真实成交价）
 *  3. fetchRealtimeQuotes() —— 全市场实时快照
 *
 * 设计要点：
 *  - 均带 UA/Referer，否则东方财富会拒绝或返回空
 *  - 多域名容灾：实测 push2.eastmoney.com 会被断开，82.push2.eastmoney.com /
 *    push2delay.eastmoney.com 可用；K 线 push2his / 61.push2his 均可用
 *  - 分页上限实测为 100（pz 传更大也只返回 100 条），因此按 100 分页
 *  - 统一请求层：超时 + 指数退避重试，抵御限流/抖动
 *  - K 线用 fqt=0（不复权）：价格、成交量、成交额口径一致；
 *    前复权会把历史价格整体下移，导致「成交额/成交量」与显示价格对不上
 *  - 东方财富 K 线的成交量单位是「手」，统一换算成「股」返回
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://quote.eastmoney.com/';

// 列表域名（按可用性排序，逐个回退）
const CLIST_HOSTS = ['82.push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com'];
// K 线域名
const KLINE_HOSTS = ['push2his.eastmoney.com', '61.push2his.eastmoney.com'];

// fs 覆盖：深主板(m:0 t:6) + 创业板(m:0 t:80) + 沪主板(m:1 t:2) + 科创板(m:1 t:23) + 北交所(m:0 t:81 s:2048)
const FS_ALL_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

const LIST_FIELDS = 'f12,f14,f100,f2,f3,f4,f5,f6,f15,f16,f17,f18,f20,f21';
const KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58';

const PAGE_SIZE = 100; // 实测上限，传更大无效

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 数值字段可能是 '-'（停牌/无数据），统一转成 number */
function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '' || v === '-') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 按代码推导交易所
 * 注意：北交所除 4/8 老代码段外，还有 920xxx 新代码段，
 * 若按首字符 '9' 判为沪市会导致 secid 错误、K 线拉不到。
 */
export function exchangeOf(code) {
  const c = String(code);
  if (/^920/.test(c)) return 'BJ'; // 北交所新代码段
  if (/^(6|9)/.test(c)) return 'SH'; // 沪市（含 688 科创板、900 B股）
  if (/^(4|8)/.test(c)) return 'BJ'; // 北交所老代码段
  return 'SZ'; // 深市（000/001/002/003/300）
}

/** 推导东方财富的 secid（market.code）：沪市 1，深市/北交所 0 */
export function secidOf(code) {
  return exchangeOf(code) === 'SH' ? `1.${code}` : `0.${code}`;
}

/** 单URL请求：超时 + 指数退避重试（仅网络/5xx/429 重试） */
async function requestOnce(url, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: REFERER, Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return JSON.parse(await res.text());
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      await sleep(300 * 2 ** attempt + Math.random() * 300);
    }
  }
  throw lastErr || new Error('request failed');
}

/**
 * 多域名回退请求：依次尝试每个域名的同一路径，任一成功即返回
 * @param {(host:string)=>string} urlBuilder
 * @param {string[]} hosts
 */
async function requestWithFallback(urlBuilder, hosts, opts = {}) {
  let lastErr = null;
  for (const host of hosts) {
    try {
      return await requestOnce(urlBuilder(host), opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all hosts failed');
}

/**
 * 拉取全 A 股列表
 * @returns {Promise<Array<{code,name,sector,price,prevClose,marketCap,exchange}>>}
 */
export async function fetchAllStocks() {
  const out = [];
  let page = 1;
  let total = Infinity;

  while (out.length < total) {
    const json = await requestWithFallback(
      (host) =>
        `https://${host}/api/qt/clist/get?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f12` +
        `&fs=${encodeURIComponent(FS_ALL_A)}&fields=${LIST_FIELDS}`,
      CLIST_HOSTS,
      { retries: 2, timeoutMs: 15000 }
    );
    const data = json?.data;
    if (!data || !Array.isArray(data.diff) || data.diff.length === 0) break;
    total = Number(data.total) || 0;
    for (const d of data.diff) {
      const code = String(d.f12 || '').trim();
      if (!code) continue;
      const price = num(d.f2, 0);
      out.push({
        code,
        name: String(d.f14 || '').trim(),
        sector: String(d.f100 || '').trim() || '其他',
        price,
        prevClose: num(d.f18, price),
        marketCap: num(d.f20, 0), // 总市值（元）
        exchange: exchangeOf(code),
      });
    }
    page += 1;
    if (page > 200) break; // 安全阀
    await sleep(100); // 轻微限速，降低被限流概率
  }
  return out;
}

/**
 * 拉取单只股票「上市至今」的全部日线（不复权）
 * @param {string} code 6 位代码
 * @returns {Promise<Array<{date,open,close,high,low,volume,amount}>>} 按日期升序
 */
export async function fetchDailyBars(code, opts = {}) {
  const json = await requestWithFallback(
    (host) =>
      `https://${host}/api/qt/stock/kline/get?secid=${secidOf(code)}&klt=101&fqt=0` +
      `&beg=19900101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=${KLINE_FIELDS2}`,
    KLINE_HOSTS,
    { retries: 3, timeoutMs: 20000, ...opts }
  );
  const klines = json?.data?.klines;
  if (!Array.isArray(klines)) return [];

  const bars = [];
  for (const line of klines) {
    // 格式：日期,开,收,高,低,成交量(手),成交额,振幅
    const p = String(line).split(',');
    if (p.length < 7) continue;
    const date = p[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    bars.push({
      date,
      open: num(p[1], 0),
      close: num(p[2], 0),
      high: num(p[3], 0),
      low: num(p[4], 0),
      volume: Math.round(num(p[5], 0)) * 100, // 手 -> 股
      amount: num(p[6], 0),
    });
  }
  return bars;
}

/**
 * 全市场实时快照
 * @returns {Promise<Map<string, {price,open,high,low,prevClose,volume,amount}>>} key = code
 */
export async function fetchRealtimeQuotes() {
  const map = new Map();
  let page = 1;
  let total = Infinity;

  while (map.size < total) {
    const json = await requestWithFallback(
      (host) =>
        `https://${host}/api/qt/clist/get?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f12` +
        `&fs=${encodeURIComponent(FS_ALL_A)}&fields=${LIST_FIELDS}`,
      CLIST_HOSTS,
      { retries: 2, timeoutMs: 12000 }
    );
    const data = json?.data;
    if (!data || !Array.isArray(data.diff) || data.diff.length === 0) break;
    total = Number(data.total) || 0;
    for (const d of data.diff) {
      const code = String(d.f12 || '').trim();
      if (!code) continue;
      const price = num(d.f2, 0);
      if (price <= 0) continue; // 停牌/无报价跳过，保留上一次价格
      map.set(code, {
        price,
        open: num(d.f17, price),
        high: num(d.f15, price),
        low: num(d.f16, price),
        prevClose: num(d.f18, price),
        volume: Math.round(num(d.f5, 0)) * 100, // 手 -> 股
        amount: num(d.f6, 0),
      });
    }
    page += 1;
    if (page > 80) break;
  }
  return map;
}

export default {
  fetchAllStocks,
  fetchDailyBars,
  fetchRealtimeQuotes,
  secidOf,
  exchangeOf,
};
