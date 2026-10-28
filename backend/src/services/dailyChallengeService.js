/**
 * 每日一题 · 连打 · 净胜局榜（RQ-113 / I-10 / F-41）
 *
 * v9 实地复核：训练结束之后**没有默认的下一次**——无再来一局、无每日一题、无连打（F-41）。
 * 留存钩子（成绩卡、周报、站内提示）全部就绪，但完成数为 0，钩子在最上游就断了。
 *
 * 形态参考大波浪已验证的那套：今日一题 · 全网同一道 + 连打 + 日榜，
 * 但**榜只算净胜局**：跑赢「一直拿着」+1、跑输 −1，打满 5 局才上榜，**不看绝对收益**。
 * 收益榜会奖励「抽到什么票」——抽到什么票不是本事（v4 遗留判断）。
 *
 * 硬约束 6 的物理实现：`daily_challenge_entries` 表**不设收益列**（迁移 0019），
 * 不存就不可能展示，比在展示层判断可靠得多。
 */

import pool from '../db.js';
import { DEFAULT_BARS } from './sessionLengthService.js';
import { safeUserId } from './guestService.js';

/** 上榜门槛：打满 N 局才进榜，避免 1 局好运霸榜 */
export const CHALLENGE_MIN_ROUNDS = 5;

/**
 * 公榜开放门槛：活跃用户达到该数量前**不展示公榜**（RQ-126 / I-15 / F-51）。
 *
 * 依据是本轮竞品实测：大波浪「近 30 天净胜局榜」只有 **9 人上榜**。
 * 这条证据说明两件事——这个赛道整体冷启动都极难，而且
 * **一个只有 9 个人的榜单出现在新用户面前，传递的是「这里没人」**。
 * 空榜在冷启动期是负资产，所以改为个人连打记录，公榜延后。
 */
export const PUBLIC_BOARD_MIN_ACTIVE_USERS = 100;

/** 每日一题默认走快局（RQ-107 短局化的延续） */
export const CHALLENGE_BARS = DEFAULT_BARS;

/* ----------------------------- 纯函数 ----------------------------- */

/**
 * Intl.DateTimeFormat 构造开销较大（实测占连打构建 90% 以上的耗时），
 * 单例缓存后 20000 次连打构建从分钟级降到秒级——这是 P4 性能用例的直接动因。
 */
let DATE_FMT = null;
function shanghaiFmt() {
  if (!DATE_FMT) {
    DATE_FMT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return DATE_FMT;
}

/** 按 Asia/Shanghai 取日期键（训练场景以 A 股交易日为准，不是 UTC） */
export function dateKeyOf(v) {
  const d = v instanceof Date ? v : v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return shanghaiFmt().format(d);
}

/** 由「上海时区当日 00:00 的 UTC 时间戳」直接拼日期键，绕开 Intl，供日历这类高频调用使用 */
function dateKeyFromTs(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 32 位字符串哈希 → 稳定的日期种子（同一天所有用户算出同一题） */
export function seedFromDate(dateKey) {
  const s = String(dateKey || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而稳的确定性 PRNG，保证同种子同结果（可复现、可单测） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 净胜局：跑赢买入持有 +1 / 跑输 −1 / 打平 0。
 *
 * 注意：**显式判空先于 Number() 转换**。Number(null) === 0，
 * 若先转换，「缺收益率」会被当成「收益 0%」从而算出 −1 的假净胜局——
 * 那是把「没数据」伪装成「跑输了」，属于伪结论（F-32 同类错误）。
 */
export function netWinOf(o) {
  const src = o && typeof o === 'object' ? o : {};
  if (src.returnPct == null || src.buyHoldPct == null) return null;
  const rp = Number(src.returnPct);
  const bp = Number(src.buyHoldPct);
  if (!Number.isFinite(rp) || !Number.isFinite(bp)) return null;
  const diff = rp - bp;
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function toDay(v) {
  const k = dateKeyOf(v);
  if (!k) return null;
  const t = Date.parse(`${k}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * 连打（streak）：连续自然日参与。
 * 纯函数，入参是去重后的日期键数组。
 */
export function summarizeStreak(dateKeys = [], now = new Date()) {
  const uniq = [...new Set((Array.isArray(dateKeys) ? dateKeys : []).map(dateKeyOf).filter(Boolean))].sort();
  if (uniq.length === 0) return { current: 0, longest: 0, days: [], lastDate: null };

  const DAY = 86400000;
  let longest = 1;
  let run = 1;
  for (let i = 1; i < uniq.length; i += 1) {
    const prev = toDay(uniq[i - 1]);
    const cur = toDay(uniq[i]);
    if (prev != null && cur != null && cur - prev === DAY) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  const today = toDay(now);
  const last = uniq[uniq.length - 1];
  const lastT = toDay(last);
  // 断连判定：最后一次参与距今超过 1 天即视为断了
  const current = today != null && lastT != null && today - lastT <= DAY ? run : 0;

  return { current, longest, days: uniq, lastDate: last };
}

/**
 * 个人连打记录（RQ-126 / I-15）：连打日历 + 与上周的你比。
 *
 * 替代公榜的理由写在 PUBLIC_BOARD_MIN_ACTIVE_USERS 上：冷启动期空榜是负资产。
 * 但「回来的理由」不能一起丢掉，所以把外部比较（和人比）换成内部比较（和上周的自己比）——
 * 后者在任何用户量下都有意义，且不依赖别人也在用。
 *
 * 纯函数：入参是参与过的日期键数组。
 */
export function buildStreakRecord(dateKeys = [], o = {}) {
  const opts = o && typeof o === 'object' ? o : {};
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  const win = Math.min(365, Math.max(7, Math.floor(Number(opts.windowDays) || 28)));

  // 先剔除空值**再**转换：dateKeyOf(null) 会返回「今天」，
  // 于是「传了一个 null」会被当成「今天参与过」——凭空多出一天参与记录。
  const set = new Set(
    (Array.isArray(dateKeys) ? dateKeys : [])
      .filter((k) => k !== null && k !== undefined && k !== '')
      .map(dateKeyOf)
      .filter(Boolean)
  );
  const todayT = toDay(now);
  const DAY = 86400000;

  // 日历：最近 win 天（含今天），每天给出是否参与。空也要给全，
  // 因为「哪几天没练」本身就是用户要看的信息。
  const calendar = [];
  if (todayT != null) {
    for (let i = win - 1; i >= 0; i -= 1) {
      calendar.push({ date: dateKeyFromTs(todayT - i * DAY), participated: set.has(dateKeyFromTs(todayT - i * DAY)) });
    }
  }

  const thisWeek = calendar.slice(-7).filter((d) => d.participated).length;
  const lastWeek = calendar.slice(-14, -7).filter((d) => d.participated).length;
  const delta = thisWeek - lastWeek;
  const streak = summarizeStreak([...set], now);

  return {
    windowDays: win,
    calendar,
    thisWeek,
    lastWeek,
    delta,
    current: streak.current,
    longest: streak.longest,
    lastDate: streak.lastDate,
    totalDays: set.size,
    comparison:
      delta > 0
        ? `本周已练 ${thisWeek} 天，比上周同期多 ${delta} 天。`
        : delta < 0
          ? `本周已练 ${thisWeek} 天，比上周同期少 ${Math.abs(delta)} 天。`
          : `本周已练 ${thisWeek} 天，与上周同期持平。`,
    metric: '参与天数',
    metricDef: '连续自然日参与训练的天数；只和自己比，不与人比。',
    note:
      '公榜在活跃用户达到 100 前不展示——空榜只会传递「这里没人」。' +
      '在那之前，回来的理由是与上周的自己比。',
  };
}

/**
 * 净胜局榜（纯函数）。
 *
 * 硬约束 6：只展示净胜局累加，**绝不展示绝对收益率**。
 * 为此这里的返回结构里根本不存在收益字段，且未达门槛的一律不进榜。
 *
 * RQ-126：新增 `activeUsers` 入参。达到 PUBLIC_BOARD_MIN_ACTIVE_USERS 才产出榜单内容；
 * **不传该参数时保持原行为（产出榜单）**——「未统计活跃用户」不等于「活跃用户为 0」，
 * 把二者混同会让既有调用方凭空失去数据。
 */
export function buildNetWinBoard(entries = [], o = {}) {
  const opts = o && typeof o === 'object' ? o : {};
  const minRounds = Math.max(1, Number(opts.minRounds) || CHALLENGE_MIN_ROUNDS);
  const hasActive = Number.isFinite(Number(opts.activeUsers));
  const activeUsers = hasActive ? Math.max(0, Math.floor(Number(opts.activeUsers))) : null;
  const publicBoardEnabled = activeUsers === null ? true : activeUsers >= PUBLIC_BOARD_MIN_ACTIVE_USERS;
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => {
      const src = e && typeof e === 'object' ? e : {};
      const rounds = Math.max(0, Math.floor(Number(src.rounds) || 0));
      const netWin = Math.floor(Number(src.netWin) || 0);
      return {
        ref: String(src.ref ?? ''),
        displayName: String(src.displayName ?? src.ref ?? '匿名训练者'),
        rounds,
        netWin,
        eligible: rounds >= minRounds,
      };
    })
    .filter((r) => r.eligible)
    .sort((a, b) => b.netWin - a.netWin || b.rounds - a.rounds);

  const ranked = list.map((r, i) => ({ rank: i + 1, ...r }));
  // RQ-126：未达活跃门槛时榜单内容为空，但**结构保留**——前端据此隐藏入口，
  // 而不是渲染一个「第 1 名：无人」的空壳。
  const board = publicBoardEnabled ? ranked : [];

  return {
    minRounds,
    activeUsers,
    publicBoardEnabled,
    publicBoardMinUsers: PUBLIC_BOARD_MIN_ACTIVE_USERS,
    boardReason: publicBoardEnabled
      ? null
      : `活跃用户 ${activeUsers} 人 < ${PUBLIC_BOARD_MIN_ACTIVE_USERS} 人，公榜暂不展示（空榜会劝退）。`,
    board,
    participants: board.length,
    // 未上榜的人也要看见自己还差几局——把护栏从「拦截」改为「牵引」（RQ-117 同源）
    waiting: (Array.isArray(entries) ? entries : [])
      .filter((e) => Math.max(0, Math.floor(Number(e?.rounds) || 0)) < minRounds)
      .map((e) => ({
        displayName: String(e?.displayName ?? e?.ref ?? '匿名训练者'),
        rounds: Math.max(0, Math.floor(Number(e?.rounds) || 0)),
        remaining: minRounds - Math.max(0, Math.floor(Number(e?.rounds) || 0)),
      })),
    metric: '净胜局',
    metricDef: '跑赢「一直拿着」+1 / 跑输 −1，累加；不看绝对收益。',
    note: `打满 ${minRounds} 局才上榜；抽到什么票不是本事，所以只比是否跑赢买入持有。`,
  };
}

/* ----------------------------- 取数与写入 ----------------------------- */

/** 取（或生成）今日一题。全站同题：题目落库，同一天永远返回同一道。 */
export async function todayChallenge({ now = new Date(), bars = CHALLENGE_BARS } = {}) {
  const dateKey = dateKeyOf(now);
  if (!dateKey) throw new Error('无法解析日期');

  const { rows: exist } = await pool.query(
    'SELECT challenge_date, start_seq, end_seq, bars FROM daily_challenges WHERE challenge_date=$1',
    [dateKey]
  );
  if (exist.length) {
    return { date: dateKey, ...exist[0], created: false, bars: exist[0].bars };
  }

  // 确定性抽题：同日期 → 同种子 → 同结果
  const rng = mulberry32(seedFromDate(dateKey));
  const n = Math.max(10, Math.floor(Number(bars) || CHALLENGE_BARS));
  const { rows: cands } = await pool.query(
    `SELECT d.code AS code, s.name AS name, MIN(d.seq)::int AS minseq, MAX(d.seq)::int AS maxseq
       FROM stock_daily d JOIN stocks s ON s.code = d.code
      WHERE s.trade_status = 'NORMAL'
      GROUP BY d.code, s.name
     HAVING COUNT(*) >= $1`,
    [n]
  );
  if (!cands.length) throw new Error('没有满足长度要求的标的，无法生成今日一题');

  let picked = null;
  for (let i = 0; i < 20 && !picked; i += 1) {
    const c = cands[Math.floor(rng() * cands.length)];
    const hi = c.maxseq - n + 1;
    if (hi < c.minseq) continue;
    const start = c.minseq + Math.floor(rng() * (hi - c.minseq + 1));
    picked = { code: c.code, name: c.name, startSeq: start, endSeq: start + n - 1 };
  }
  if (!picked) throw new Error('今日一题抽取失败');

  const { rows } = await pool.query(
    `INSERT INTO daily_challenges (challenge_date, stock_code, stock_name, start_seq, end_seq, bars)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (challenge_date) DO UPDATE SET challenge_date = daily_challenges.challenge_date
     RETURNING challenge_date, start_seq, end_seq, bars`,
    [dateKey, picked.code, picked.name, picked.startSeq, picked.endSeq, n]
  );
  return { date: dateKey, ...rows[0], created: true, bars: n };
}

/** 记录一次参赛结果（同一天同一人只保留最新一次） */
export async function joinChallenge({ identity = {}, sessionId = null, netWin = 0, now = new Date() } = {}) {
  const dateKey = dateKeyOf(now);
  if (!dateKey) throw new Error('无法解析日期');
  const userId = safeUserId(identity.userId);
  const guestToken = userId ? null : String(identity.guestToken || '') || null;
  if (!userId && !guestToken) throw new Error('缺少归属身份');

  const w = Math.max(-1, Math.min(1, Math.floor(Number(netWin) || 0)));
  // 同一天同一人只保留最新一次：先删后插。
  // 不用 ON CONFLICT —— 表里有两个**部分唯一索引**（user / guest），
  // PostgreSQL 的 ON CONFLICT 只能指定一个推断目标，无法同时覆盖两者。
  await pool.query(
    `DELETE FROM daily_challenge_entries
      WHERE challenge_date = $1
        AND (($2::int IS NOT NULL AND user_id = $2) OR ($3::text IS NOT NULL AND guest_token = $3))`,
    [dateKey, userId, guestToken]
  );
  const { rows } = await pool.query(
    `INSERT INTO daily_challenge_entries (challenge_date, user_id, guest_token, session_id, net_win, finished_at)
     VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
    [dateKey, userId, guestToken, sessionId, w]
  );
  return { date: dateKey, netWin: w, recorded: rows.length > 0 };
}

/** 近 N 天的活跃参与者数（去重：登录用户与游客各算一个独立参与者） */
export async function activeParticipants({ days = 30 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE('u' || e.user_id, 'g' || LEFT(e.guest_token, 6)))::int AS c
       FROM daily_challenge_entries e
      WHERE e.challenge_date >= (now() - ($1 || ' days')::interval)::date`,
    [String(d)]
  );
  return rows[0]?.c || 0;
}

/**
 * 榜单取数 + 个人连打记录（RQ-126）。
 * 活跃用户不足时公榜内容为空，但**返回结构不变**，前端据此隐藏入口。
 */
export async function challengeBoard({ days = 30, now = new Date(), identity = null } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const [entryRows, active] = await Promise.all([
    pool.query(
      `SELECT COALESCE(u.username, '游客') AS display_name,
              COALESCE('u' || e.user_id, 'g' || LEFT(e.guest_token, 6)) AS ref,
              COUNT(*)::int AS rounds,
              SUM(e.net_win)::int AS net_win
         FROM daily_challenge_entries e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.challenge_date >= (now() - ($1 || ' days')::interval)::date
        GROUP BY 1, 2`,
      [String(d)]
    ),
    activeParticipants({ days: d }),
  ]);
  const rows = entryRows.rows;
  const board = buildNetWinBoard(
    rows.map((r) => ({ ref: r.ref, displayName: r.display_name, rounds: r.rounds, netWin: r.net_win })),
    { activeUsers: active }
  );
  return {
    days: d,
    ...board,
    // RQ-126：连打从「附带的数字」升级为**默认展示的主角**
    streak: identity ? await streakOf(identity, now) : null,
    streakRecord: identity ? await streakRecordOf(identity, { now }) : null,
  };
}

/** 单个用户的连打进度 */
export async function streakOf(identity, now = new Date()) {
  const days = await participantDays(identity);
  return summarizeStreak(days, now);
}

/** 取某人的参与日期键（登录用户与游客共用一套归属口径） */
async function participantDays(identity) {
  const userId = safeUserId(identity?.userId);
  const guestToken = userId ? null : String(identity?.guestToken || '') || null;
  if (!userId && !guestToken) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT challenge_date::text AS d FROM daily_challenge_entries
      WHERE ($1::int IS NOT NULL AND user_id = $1) OR ($2::text IS NOT NULL AND guest_token = $2)
      ORDER BY d ASC`,
    [userId, guestToken]
  );
  return rows.map((r) => r.d);
}

/**
 * 个人连打记录（RQ-126 的主角）：连打日历 + 与上周对比。
 * 与 streakOf 的区别：streakOf 只给「连续几天」这一个数字，
 * 这里给出可以看着复盘的日历与周对比。
 */
export async function streakRecordOf(identity, o = {}) {
  const opts = o && typeof o === 'object' ? o : {};
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  const days = await participantDays(identity);
  return buildStreakRecord(days, { now, windowDays: opts.windowDays ?? 28 });
}
