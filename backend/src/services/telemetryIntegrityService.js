/**
 * 埋点可信度（RQ-143 去重 / RQ-144 一致性校验）
 *
 * v12 头号发现不是「没数据」，而是「有数据但全是假的」：
 *   - `blind_resume` **714 条 / 仅 2 个用户**，单分钟 228 条 × 3 分钟；
 *   - `blind_start` 只有 10 条 → 714 次续做 vs 10 次开训，物理上不可能；
 *   - `blind_finish` 埋点 3 条，但 `blind_sessions` 里 FINISHED 只有 2 条。
 *
 * 这类污染的危害比「没数据」大得多：**没数据会让人去查，假数据会让人下错的结论**
 * （例如「复盘页 PV 523，用户很爱用」）。因此本模块做两件事：
 *
 *   1. **在写入侧去重**（RQ-143）：每个事件声明自己的去重维度，重复上报在数据库层
 *      被唯一索引拒绝，而不是靠事后清洗——事后清洗永远追不上新产生的污染。
 *   2. **在读取侧对账**（RQ-144）：埋点条数 vs 业务表行数每日比对，不一致直接告警。
 *
 * 设计约束：
 *   - **纯函数与取数分离**：建键、判定、对账全是纯函数，可无库单测（v8 起的分层约定）。
 *   - **去重键必须可读**：键形如 `u12|blind_resume|s:88`，人眼能看出「谁 + 什么事 + 按什么维度」，
 *      否则线上排查时只能靠猜。
 *   - **去重不改变语义，只削重复**：一个真实的动作仍会记一条；只有同一维度的重复上报被拦。
 */

import pool from '../db.js';
import { logger } from '../logger.js';

/* ------------------------------------------------------------------ *
 * 一、去重维度                                                        *
 * ------------------------------------------------------------------ */

export const DEDUPE_SCOPES = {
  /** 同一主体 + 事件 + 会话，只记一条：会话级动作（开训/续做/结算/放弃）天然唯一 */
  session: 'session',
  /** 同一主体 + 事件 + 时间窗，只记一条：浏览类动作，用来削掉轮询与重复上报 */
  burst: 'burst',
  /** 同一主体 + 事件，全局只记一条：注册、首训这类一生一次的事件 */
  unique: 'unique',
  /** 同一主体 + 事件 + 上海自然日，只记一条：签到、日报这类按日计数的动作 */
  daily: 'daily',
  /** 不去重：每 10 根一次的合法多次事件（如 blind_decision） */
  none: 'none',
};

/** 浏览类事件的默认去重窗口（秒）：5 分钟内重复打开只算一次 */
export const DEFAULT_BURST_SEC = 300;

/**
 * 事件 → 去重规则。
 *
 * 逐条说明为什么是这一档（避免出现「顺手全设成 session」的偷懒做法）：
 *   - blind_* 的会话级动作：一次训练局只会发生一次，重复就是上报 bug；
 *   - checkup_view / weekly_report_view 等浏览类：用户一天可能真打开几次，
 *     所以不按天砍到 1 条（那会丢信息），而是 5 分钟窗口削掉轮询与重渲染；
 *   - checkin 按天：签到本身的定义就是「每天一次」；
 *   - signup / first_training_* 按主体全局唯一：首训口径的分母必须是人，不是次数。
 */
export const EVENT_DEDUPE = {
  signup: { scope: DEDUPE_SCOPES.unique },
  first_training_start: { scope: DEDUPE_SCOPES.unique },
  first_training_finish: { scope: DEDUPE_SCOPES.unique },
  guide_complete: { scope: DEDUPE_SCOPES.unique },

  blind_start: { scope: DEDUPE_SCOPES.session },
  blind_resume: { scope: DEDUPE_SCOPES.session },
  blind_abandon: { scope: DEDUPE_SCOPES.session },
  blind_finish: { scope: DEDUPE_SCOPES.session },
  guest_training_start: { scope: DEDUPE_SCOPES.session },
  guest_training_finish: { scope: DEDUPE_SCOPES.session },
  score_card_view: { scope: DEDUPE_SCOPES.session },
  score_card_copy: { scope: DEDUPE_SCOPES.session },
  export_review: { scope: DEDUPE_SCOPES.session },
  share_card: { scope: DEDUPE_SCOPES.session },
  replay_start: { scope: DEDUPE_SCOPES.session },
  replay_finish: { scope: DEDUPE_SCOPES.session },
  prescription_start: { scope: DEDUPE_SCOPES.session },
  challenge_join: { scope: DEDUPE_SCOPES.session },
  challenge_finish: { scope: DEDUPE_SCOPES.session },
  room_join: { scope: DEDUPE_SCOPES.session },
  room_create: { scope: DEDUPE_SCOPES.session },
  task_complete: { scope: DEDUPE_SCOPES.session },
  first_training_enter: { scope: DEDUPE_SCOPES.session },
  first_training_decision: { scope: DEDUPE_SCOPES.session },

  checkin: { scope: DEDUPE_SCOPES.daily },
  checkup_view: { scope: DEDUPE_SCOPES.burst, windowSec: DEFAULT_BURST_SEC },
  weekly_report_view: { scope: DEDUPE_SCOPES.burst, windowSec: DEFAULT_BURST_SEC },
  dashboard_view: { scope: DEDUPE_SCOPES.burst, windowSec: DEFAULT_BURST_SEC },
  review_view: { scope: DEDUPE_SCOPES.burst, windowSec: DEFAULT_BURST_SEC },

  // 每 10 根一次，多次是合法的；去重会直接毁掉「每局判断了几次」这个指标
  blind_decision: { scope: DEDUPE_SCOPES.none },
};

/** 兜底规则：未登记的事件按浏览类削峰，宁可少记也不让轮询灌满漏斗 */
export const DEFAULT_DEDUPE = { scope: DEDUPE_SCOPES.burst, windowSec: DEFAULT_BURST_SEC };

export function dedupeRuleOf(event) {
  const e = String(event ?? '');
  return EVENT_DEDUPE[e] || DEFAULT_DEDUPE;
}

/** 上海时区的自然日键（与 guestService 的 GUEST_TODAY_SQL 同口径，避免跨时区错位） */
export function shanghaiDateKey(at) {
  const d = at instanceof Date ? at : new Date(at);
  const t = Number.isFinite(d?.getTime?.()) ? d : new Date();
  // 东八区固定偏移：不需要引入时区库，且与 SQL 的 AT TIME ZONE 'Asia/Shanghai' 一致
  return new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 构造去重键（纯函数）。
 *
 * @param {object} o
 * @param {number|string|null} [o.userId]     登录用户（游客为 null）
 * @param {string|null} [o.guestToken]        游客 token（游客主体用它作键）
 * @param {string} [o.event]                  事件名
 * @param {object} [o.payload]                埋点载荷
 * @param {Date|number} [o.at]                事件发生时刻
 * @returns {string|null} null 表示不去重
 */
export function dedupeKeyOf(o) {
  const src = o && typeof o === 'object' ? o : {};
  const event = String(src.event ?? '');
  if (!event) return null;

  const payload = src.payload && typeof src.payload === 'object' ? src.payload : {};
  // 主体：登录用户优先，游客用 token（游客没有 userId，若回落到 null 会把所有游客并成一个人）
  const subject = src.userId != null && src.userId !== ''
    ? `u${src.userId}`
    : src.guestToken
      ? `g${String(src.guestToken).slice(0, 32)}`
      : 'anon';

  const rule = dedupeRuleOf(event);
  /**
   * 时刻解析必须同时接受 Date、数字时间戳与字符串。
   * 只写 `Date.parse(src.at)` 是个隐蔽的坑：Date.parse 会把数字先转成字符串
   * 再解析，`Date.parse(1793385300000)` 得到 NaN，所有数字时间戳都会静默回落到
   * 「当前时刻」——结果是**所有事件都落进同一个时间窗**，去重把真实动作全吃了。
   */
  const atMs = (() => {
    if (src.at == null) return Date.now();
    if (src.at instanceof Date) return src.at.getTime();
    if (typeof src.at === 'number') return src.at;
    const t = Date.parse(src.at);
    return Number.isFinite(t) ? t : Date.now();
  })();

  if (rule.scope === DEDUPE_SCOPES.none) return null;

  if (rule.scope === DEDUPE_SCOPES.unique) return `${subject}|${event}`;

  if (rule.scope === DEDUPE_SCOPES.session) {
    const sid = payload.sessionId ?? payload.session_id ?? payload.id ?? null;
    // 会话级事件却拿不到会话 ID 时**不能**退化成「主体+事件」（那会把后续所有事件都吃掉），
    // 改用时间窗兜底：宁可漏削，也不能误削。
    if (sid == null || sid === '') {
      const w = Math.floor(atMs / (DEFAULT_BURST_SEC * 1000));
      return `${subject}|${event}|w:${w}`;
    }
    return `${subject}|${event}|s:${sid}`;
  }

  if (rule.scope === DEDUPE_SCOPES.daily) return `${subject}|${event}|d:${shanghaiDateKey(atMs)}`;

  const win = Math.max(1, Math.floor(Number(rule.windowSec) || DEFAULT_BURST_SEC));
  return `${subject}|${event}|w:${Math.floor(atMs / (win * 1000))}`;
}

/**
 * 是否应当接受这条上报（纯函数，供写入前的内存判定，避免每次都打一次库）。
 *
 * @param {Set<string>|Array<string>} seen 已见过的去重键
 * @param {string|null} key
 */
export function shouldAccept(seen, key) {
  if (!key) return { accept: true, reason: 'no-dedupe-key' };
  const set = seen instanceof Set ? seen : new Set(Array.isArray(seen) ? seen : []);
  if (set.has(key)) return { accept: false, reason: 'duplicate', key };
  return { accept: true, reason: 'new', key };
}

/* ------------------------------------------------------------------ *
 * 二、重复与污染分析（纯函数）                                        *
 * ------------------------------------------------------------------ */

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * 重复上报汇总。
 *
 * @param {Array} rows [{event, user_id, dedupe_key, cnt}]（SQL 已按 key 分组）
 * @param {object} [o] { top }
 */
export function summarizeDuplicates(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = o && typeof o === 'object' ? o : {};
  const top = Math.max(1, int0(opts.top) || 10);

  const groups = list
    .map((r) => ({
      event: String(r?.event ?? ''),
      userId: r?.user_id ?? null,
      dedupeKey: String(r?.dedupe_key ?? ''),
      count: int0(r?.cnt),
    }))
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count);

  const byEvent = new Map();
  for (const g of groups) {
    const cur = byEvent.get(g.event) || { event: g.event, keys: 0, excess: 0, maxCount: 0 };
    cur.keys += 1;
    cur.excess += g.count - 1;
    cur.maxCount = Math.max(cur.maxCount, g.count);
    byEvent.set(g.event, cur);
  }

  const events = [...byEvent.values()].sort((a, b) => b.excess - a.excess);
  const totalExcess = events.reduce((s, e) => s + e.excess, 0);

  return {
    duplicateKeys: groups.length,
    excessEvents: totalExcess,
    byEvent: events,
    // 最严重的几个：给排查用，而不是让翻表
    worst: groups.slice(0, top).map((g) => ({ ...g })),
    ok: groups.length === 0,
    note:
      groups.length === 0
        ? '未发现重复上报，漏斗可按埋点直接读。'
        : `存在 ${groups.length} 个重复键、多出 ${totalExcess} 条记录；在这些键上做的任何转化率计算都不可信。`,
  };
}

/**
 * 埋点 ↔ 业务表 一致性对账（RQ-144，纯函数）。
 *
 * @param {object} o
 * @param {object} [o.eventCounts]  { blind_finish: 3, ... }  埋点侧计数
 * @param {object} [o.tableCounts]  { blind_finish: 2, ... }  业务表侧计数（同一口径）
 * @param {Array}  [o.rules]        对账项 [{key,label,event,table}]
 */
export function summarizeConsistency(o) {
  const src = o && typeof o === 'object' ? o : {};
  const ec = src.eventCounts && typeof src.eventCounts === 'object' ? src.eventCounts : {};
  const tc = src.tableCounts && typeof src.tableCounts === 'object' ? src.tableCounts : {};

  const rules = Array.isArray(src.rules) && src.rules.length
    ? src.rules
    : DEFAULT_CONSISTENCY_RULES;

  const items = rules.map((r) => {
    const e = int0(ec[r.event]);
    const t = int0(tc[r.table ?? r.event]);
    const diff = e - t;
    return {
      key: r.key || r.event,
      label: r.label || r.event,
      event: r.event,
      table: r.table ?? r.event,
      eventCount: e,
      tableCount: t,
      diff,
      match: diff === 0,
      // 埋点少于业务表同样是缺陷：说明有完成的局没被记上（漏报）
      severity: diff === 0 ? 'ok' : Math.abs(diff) <= (r.tolerance ?? 0) ? 'warn' : 'error',
      hint:
        diff === 0
          ? '埋点与业务表一致。'
          : diff > 0
            ? `埋点比业务表多 ${diff} 条，属重复上报或上报了不存在的会话。`
            : `业务表比埋点多 ${-diff} 条，属漏报（有完成的局没有被记上）。`,
    };
  });

  const broken = items.filter((i) => i.severity === 'error');
  return {
    items,
    ok: broken.length === 0,
    brokenCount: broken.length,
    detail: broken.length === 0 ? '全部对账项一致。' : `不一致项：${broken.map((b) => b.label).join('、')}`,
    note: '每日一次；不一致时先修埋点再看指标，否则所有优化都建立在错误读数上。',
  };
}

/** 默认对账项：埋点数必须等于业务表行数（RQ-144 验收标准直接对应这一条） */
export const DEFAULT_CONSISTENCY_RULES = [
  {
    key: 'blind_finish',
    label: 'blind_finish 埋点数 = FINISHED 会话数',
    event: 'blind_finish',
    table: 'blind_sessions_finished',
    tolerance: 0,
  },
  {
    key: 'blind_start',
    label: 'blind_start 埋点数 = 训练会话数',
    event: 'blind_start',
    table: 'blind_sessions',
    tolerance: 0,
  },
];

/* ------------------------------------------------------------------ *
 * 三、DB 侧：去重写入、审计、清理                                     *
 * ------------------------------------------------------------------ */

/**
 * 去重写入埋点（RQ-143 的写入侧防线）。
 *
 * 与 `analyticsService.track` 的区别：本函数带 dedupe_key 并依赖唯一索引，
 * 重复上报返回 `{recorded:false, duplicate:true}` 而不是静默多插一行。
 *
 * @returns {Promise<{recorded:boolean, duplicate:boolean, dedupeKey:string|null, event:string}>}
 */
export async function trackOnce(userId, event, payload = {}, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const p = payload && typeof payload === 'object' ? payload : {};
  const key = dedupeKeyOf({
    userId: userId ?? null,
    guestToken: o.guestToken ?? null,
    event,
    payload: p,
    at: o.at ?? new Date(),
  });

  if (!key) {
    await pool.query('INSERT INTO analytics_events (user_id, event, payload) VALUES ($1,$2,$3)', [
      userId ?? null,
      event,
      JSON.stringify(p),
    ]);
    return { recorded: true, duplicate: false, dedupeKey: null, event };
  }

  const { rowCount } = await pool.query(
    `INSERT INTO analytics_events (user_id, event, payload, dedupe_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId ?? null, event, JSON.stringify(p), key]
  );

  const recorded = (rowCount || 0) > 0;
  if (!recorded) logger.debug('埋点被去重拦截', { event, dedupeKey: key });
  return { recorded, duplicate: !recorded, dedupeKey: key, event };
}

/** 每天要比对的计数：埋点侧与业务表侧一次取回（RQ-144） */
export async function collectConsistencyCounts({ days = 1, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 1));

  const { rows: ev } = await q(
    `SELECT event, COUNT(*)::int AS c
       FROM analytics_events
      WHERE event IN ('blind_start','blind_finish')
        AND created_at >= now() - ($1 || ' days')::interval
      GROUP BY event`,
    [String(d)]
  );
  const eventCounts = {};
  for (const r of ev) eventCounts[r.event] = r.c;

  const { rows: tb } = await q(
    `SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL)::int AS finished,
            COUNT(*)::int                                        AS total
       FROM blind_sessions
      WHERE created_at >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  const tableCounts = {
    blind_sessions_finished: tb[0]?.finished || 0,
    blind_sessions: tb[0]?.total || 0,
  };

  return { days: d, eventCounts, tableCounts };
}

/** 重复上报扫描：按去重键分组，找出 >1 的（RQ-143 验收「单会话 blind_resume ≤1」） */
export async function scanDuplicates({ days = 30, top = 10, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await q(
    `SELECT event, user_id, dedupe_key, COUNT(*)::int AS cnt
       FROM analytics_events
      WHERE dedupe_key IS NOT NULL
        AND created_at >= now() - ($1 || ' days')::interval
      GROUP BY event, user_id, dedupe_key
     HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT $2`,
    [String(d), Math.min(200, Math.max(1, Number(top) || 10))]
  );
  return { days: d, ...summarizeDuplicates(rows, { top }) };
}

/**
 * 清理历史重复上报（RQ-143「清理历史污染数据」）。
 *
 * 保留每个重复键中 **id 最小** 的那条（最早的一次是真动作，后续是轮询），
 * 其余删除。`dryRun` 默认 true —— 删除是不可逆动作，默认只报数不执行。
 */
export async function purgeDuplicates({ dryRun = true, batch = 5000, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const probe = await q(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY id ASC) AS rn
         FROM analytics_events
        WHERE dedupe_key IS NOT NULL
     ) t WHERE t.rn > 1`
  );
  const removable = probe.rows[0]?.c || 0;

  if (dryRun || removable === 0) {
    return { dryRun, removable, deleted: 0, note: dryRun ? '未执行删除（dryRun 默认开启）' : '无重复记录可清理' };
  }

  const limit = Math.min(50000, Math.max(1, Number(batch) || 5000));
  const { rowCount } = await q(
    `DELETE FROM analytics_events WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY id ASC) AS rn
           FROM analytics_events
          WHERE dedupe_key IS NOT NULL
       ) t WHERE t.rn > 1
       LIMIT $1
     )`,
    [limit]
  );
  logger.info('清理重复埋点', { deleted: rowCount || 0 });
  return { dryRun: false, removable, deleted: rowCount || 0, note: '已删除重复项，保留每个键最早一条' };
}

/**
 * 给历史污染数据打标（RQ-143「清理/标记历史污染数据」）。
 *
 * 与 `purgeDuplicates` 的关系：**先打标，再决定要不要删**。
 * 打标是不可逆性最低的一步，且满足 RK-03「历史数据打标而非删除，保留可追溯性」。
 */
export async function markPolluted({ days = 30, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const { rowCount } = await q(
    `UPDATE analytics_events e
        SET is_test = TRUE
      WHERE e.is_test = FALSE
        AND e.created_at >= now() - ($1 || ' days')::interval
        AND (
          -- ① 重复上报中「非最早」的那条
          EXISTS (
            SELECT 1 FROM analytics_events x
             WHERE x.dedupe_key IS NOT NULL
               AND x.dedupe_key = e.dedupe_key
               AND x.id < e.id
          )
          OR
          -- ② 被测流量用户产生的事件
          EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id AND u.is_test = TRUE)
        )`,
    [String(d)]
  );
  return { days: d, marked: rowCount || 0 };
}

/** 一次性审计：给发布后验证与人工排查共用一个入口 */
export async function auditTelemetry({ days = 30, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const { days: d, eventCounts, tableCounts } = await collectConsistencyCounts({ days, queryFn: q });
  const dup = await scanDuplicates({ days: d, queryFn: q });
  const consistency = summarizeConsistency({ eventCounts, tableCounts });
  return {
    days: d,
    consistency,
    duplicates: dup,
    ok: consistency.ok && dup.ok,
    note: consistency.ok && dup.ok
      ? '埋点可信：无重复、与业务表一致。'
      : '埋点不可信：在修复前，所有基于埋点的转化率结论都不成立。',
  };
}
