/**
 * 外部真实用户邀请与归因（RQ-159）
 *
 * v13 §2 的验收读数：RQ-159 判 ❌，理由是 **12 个用户里 0 个外部真人**，
 * 其中 5 个是两次「同秒批量注册」造出来的。而 RQ-148（v12）虽然已经有了
 * `externalUserFunnel`，它回答的是「**库里有几个外部用户**」，
 * 回答不了 RQ-159 要的两件事：
 *
 *   1. **这 5 个人是谁、从哪条链接进来的** —— `acquisition_channel` 只有
 *      community / unknown 两个粗值，5 个人进来之后无法互相区分；
 *   2. **每一步流失点在哪** —— 只有聚合转化率，没有「张三卡在决策步」这种
 *      可回访的个体路径（验收明确要求「5 份路径记录」）。
 *
 * 因此本模块做的最小充分手段是**一人一码**：
 *   - 每个被邀请的人一条 `invite_codes` 行，注册时把码写进 `users.invite_code`；
 *   - 漏斗按「码」聚合，而不是按「渠道」聚合 —— 渠道是投放面的口径，
 *     码才是能回访到人的口径；
 *   - 每个人的四步路径（注册 → 开训 → 决策 → 有效完成）逐条输出，
 *     断点直接标在哪一步。
 *
 * 设计约束：聚合与判定是纯函数，取数在 `inviteFunnel` 里且接受 `queryFn` 注入
 * （v8 起的分层约定，便于无库单测）。
 */

/** 邀请码字符集：刻意排除易混淆字符（0/O、1/I），避免口头传播时抄错 */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 邀请码默认长度（8 位字符 ≈ 10^12 空间，5~20 人的量级不会撞） */
export const INVITE_CODE_LEN = 8;

/** RQ-159 验收目标：≥5 名外部用户注册，≥2 名达到有效完成 */
export const INVITE_GOAL = { registered: 5, effective: 2 };

/** 单个邀请码的最大重试次数（撞库时换一个再试，不无限循环） */
export const MAX_CODE_RETRY = 5;

/** 一次批量生成的硬上限：防止误传 count=100000 灌库 */
export const MAX_BATCH = 200;

/** 每个被邀请人追溯的四步（顺序即漏斗顺序，不可调换） */
export const INVITE_STEPS = [
  { key: 'registered', label: '完成注册' },
  { key: 'started', label: '开始第一次训练' },
  { key: 'decided', label: '记录过一次决策' },
  { key: 'effective', label: '有效完成（≥1 笔成交且走完）' },
];

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * 归一化邀请码。
 *
 * 大小写不敏感、去掉分隔符：码是**让人手抄/口述**的，
 * 要求用户精确输入 `INV-a1B2-c3D4` 这种格式只会制造无效流失。
 * 非法字符（注入用）一律判无效而不是清洗 —— 清洗会产生「两个不同输入指向同一个码」。
 */
export function normalizeInviteCode(v) {
  // 类型语义：码是字符串。数字入参（JSON 里 {"code":123}）一律视为无效，
  // 静默转字符串会让「123」与 123 两个不同输入指向同一个码，归因就不可信了。
  if (v === null || v === undefined || typeof v !== 'string') return null;
  const s = v.trim().toUpperCase().replace(/[\s_-]/g, '');
  if (!s) return null;
  if (s.length > 40) return null;
  if (!/^[A-Z0-9]+$/.test(s)) return null;
  return s;
}

/**
 * 生成邀请码（纯函数，随机源注入便于单测复现）。
 * @param {object} o { rand, prefix, len }
 */
export function newInviteCode(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const rand = typeof src.rand === 'function' ? src.rand : Math.random;
  const len = Math.max(4, Math.min(40, int0(src.len) || INVITE_CODE_LEN));
  const prefix = trim(src.prefix) ? `${trim(src.prefix).toUpperCase().replace(/[\s-]/g, '')}-` : '';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += INVITE_ALPHABET[Math.floor(rand() * INVITE_ALPHABET.length) % INVITE_ALPHABET.length];
  }
  return `${prefix}${out}`;
}

/**
 * 拼接分享链接。
 *
 * 刻意**不带任何身份信息**：链接里放 userId / 邮箱会让分享链接变成可枚举的
 * 用户凭证（硬约束 5 的历史教训）。归因靠码，不靠身份。
 */
export function buildInviteLink({ baseUrl = '', code = '' } = {}) {
  const base = trim(baseUrl).replace(/\/+$/, '');
  const c = normalizeInviteCode(code);
  if (!c) return null;
  if (!base) return `/?invite=${c}`;
  return `${base}/?invite=${c}`;
}

/**
 * 批量生成邀请码计划（纯函数，不写库）。
 * @param {object} o { count, channel, label, baseUrl, rand, prefix }
 */
export function planInvites(o = {}) {
  const src = o && typeof o === 'object' ? o : {};
  const count = Math.max(1, Math.min(MAX_BATCH, int0(src.count) || 1));
  const channel = trim(src.channel) || 'manual';
  const label = trim(src.label) || null;
  const rand = typeof src.rand === 'function' ? src.rand : Math.random;
  const seen = new Set();
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let code = null;
    for (let t = 0; t < MAX_CODE_RETRY; t += 1) {
      const c = newInviteCode({ rand, prefix: src.prefix });
      if (!seen.has(c)) {
        seen.add(c);
        code = c;
        break;
      }
    }
    if (code) codes.push({ code, channel, label, url: buildInviteLink({ baseUrl: src.baseUrl, code }) });
  }
  return { count: codes.length, requested: count, channel, label, codes };
}

/* ------------------------------------------------------------------ *
 * 漏斗聚合（纯函数）                                                    *
 * ------------------------------------------------------------------ */

/**
 * 单个被邀请人的四步路径。
 * @param {object} row { registeredUserId, registeredAt, started, decided, effective }
 */
export function inviteePath(row) {
  const r = row && typeof row === 'object' ? row : {};
  // 三个键名都认：DB 行列是 snake_case，服务层与前端用 camelCase。
  // 只认一种写法会导致「码已绑定但漏斗算成未注册」——这种错误没有任何报错，只会让指标偏小。
  const uid = r.registeredUserId ?? r.registered_user_id ?? r.user_id ?? null;
  const flags = {
    registered: Boolean(uid || r.registeredAt || r.registered_at),
    started: int0(r.started) > 0,
    decided: int0(r.decided) > 0,
    effective: int0(r.effective) > 0,
  };
  const done = INVITE_STEPS.filter((s) => flags[s.key]).map((s) => s.key);
  const firstMissing = INVITE_STEPS.find((s) => !flags[s.key]) || null;
  return {
    code: normalizeInviteCode(r.code) || trim(r.code) || null,
    channel: trim(r.channel) || null,
    label: trim(r.label) || null,
    userId: uid,
    steps: INVITE_STEPS.map((s) => ({ ...s, done: flags[s.key] })),
    done,
    dropAt: firstMissing ? firstMissing.key : null,
    dropLabel: firstMissing ? firstMissing.label : null,
    counts: { started: int0(r.started), decided: int0(r.decided), effective: int0(r.effective) },
  };
}

/**
 * 邀请漏斗汇总（RQ-159）。
 *
 * @param {Array} rows invite_codes 行（含 started/decided/effective）
 * @param {object} o { goal }
 */
export function summarizeInviteFunnel(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = o && typeof o === 'object' ? o : {};
  const goal = {
    registered: Math.max(1, int0(opts.goal?.registered) || INVITE_GOAL.registered),
    effective: Math.max(1, int0(opts.goal?.effective) || INVITE_GOAL.effective),
  };

  const paths = list.map(inviteePath);
  const counts = {
    created: paths.length,
    registered: paths.filter((p) => p.done.includes('registered')).length,
    started: paths.filter((p) => p.done.includes('started')).length,
    decided: paths.filter((p) => p.done.includes('decided')).length,
    effective: paths.filter((p) => p.done.includes('effective')).length,
  };

  const steps = [
    { key: 'created', label: '已生成邀请码', count: counts.created },
    ...INVITE_STEPS.map((s) => ({ ...s, count: counts[s.key] })),
  ].map((s, i, arr) => ({
    ...s,
    conversionFromPrev: i === 0 ? 1 : arr[i - 1].count > 0 ? Math.round((s.count / arr[i - 1].count) * 10000) / 100 : null,
    conversionFromTop: arr[0].count > 0 ? Math.round((s.count / arr[0].count) * 10000) / 100 : null,
  }));

  const dropoffs = steps.slice(1).map((s, i) => ({
    from: steps[i].key,
    to: s.key,
    lost: Math.max(0, steps[i].count - s.count),
    // 「一步归零」是最强的断点信号：之前每一步都有人，到这一步一个不剩
    cliff: steps[i].count > 0 && s.count === 0,
  }));

  const met = counts.registered >= goal.registered && counts.effective >= goal.effective;
  const gap = {
    registered: Math.max(0, goal.registered - counts.registered),
    effective: Math.max(0, goal.effective - counts.effective),
  };
  const cliff = dropoffs.find((d) => d.cliff) || null;

  return {
    steps,
    dropoffs,
    paths,
    counts,
    goal,
    gap,
    met,
    dropAt: cliff ? cliff.to : null,
    note: met
      ? `已达成 RQ-159：${counts.registered} 名外部用户注册、${counts.effective} 名有效完成。`
      : cliff
        ? `断点在「${cliff.from} → ${cliff.to}」（这一步归零）；还差 ${gap.registered} 名注册、${gap.effective} 名有效完成。`
        : `尚未达成：还差 ${gap.registered} 名注册、${gap.effective} 名有效完成。`,
  };
}

/* ------------------------------------------------------------------ *
 * 取数（注入 queryFn，便于无库单测）                                     *
 * ------------------------------------------------------------------ */

/** 邀请漏斗取数 SQL（唯一事实来源） */
export const INVITE_FUNNEL_SQL = `
  SELECT c.code, c.channel, c.label, c.created_at, c.registered_at,
         c.registered_user_id,
         m.started, m.decided, m.effective
    FROM invite_codes c
    LEFT JOIN LATERAL (
      SELECT (SELECT COUNT(*)::int FROM analytics_events e
               WHERE e.user_id = c.registered_user_id AND e.event = 'blind_start'
                 AND e.is_test = FALSE) AS started,
             (SELECT COUNT(*)::int FROM analytics_events e
               WHERE e.user_id = c.registered_user_id AND e.event = 'blind_decision'
                 AND e.is_test = FALSE) AS decided,
             (SELECT COUNT(*)::int FROM blind_sessions b
               WHERE b.user_id = c.registered_user_id AND b.effective_completed = TRUE) AS effective
    ) m ON TRUE
   WHERE ($1::int IS NULL OR c.created_at >= now() - ($1 || ' days')::interval)
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT $2`;

/**
 * 邀请漏斗（DB）。
 * @param {object} o { days, limit, queryFn, goal }
 */
export async function inviteFunnel({ days = null, limit = 200, queryFn = null, goal = null } = {}) {
  if (!queryFn) return { ok: false, reason: '未提供 queryFn', ...summarizeInviteFunnel([], { goal }) };
  const lim = Math.max(1, Math.min(500, int0(limit) || 200));
  const d = days === null || days === undefined || days === '' ? null : Math.max(1, Math.min(3650, int0(days)));
  try {
    const { rows } = await queryFn(INVITE_FUNNEL_SQL, [d, lim]);
    return { ok: true, days: d, ...summarizeInviteFunnel(rows || [], { goal }) };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e), ...summarizeInviteFunnel([], { goal }) };
  }
}

/**
 * 建码（DB）。撞唯一索引时换新码重试，而不是把错误抛给用户——
 * 生成邀请码是运营动作，重试一次对用户无感，报错则会让运营以为系统坏了。
 * @param {object} o { count, channel, label, createdBy, baseUrl, queryFn, rand }
 */
export async function createInvites({ count = 1, channel = 'manual', label = null, createdBy = null, baseUrl = null, queryFn = null, rand = null } = {}) {
  const plan = planInvites({ count, channel, label, baseUrl, rand });
  if (!queryFn) return { ok: false, written: 0, plan, reason: '未提供 queryFn' };
  let written = 0;
  const failed = [];
  for (const c of plan.codes) {
    try {
      const { rows } = await queryFn(
        `INSERT INTO invite_codes (code, channel, label, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, channel, label, created_at`,
        [c.code, c.channel, c.label, createdBy]
      );
      if (rows[0]) {
        written += 1;
        c.id = rows[0].id;
      } else {
        failed.push({ code: c.code, reason: 'code-collision' });
      }
    } catch (e) {
      failed.push({ code: c.code, reason: e?.message || String(e) });
    }
  }
  return {
    ok: failed.length === 0,
    written,
    failed,
    requested: plan.requested,
    codes: plan.codes.filter((c) => !failed.some((f) => f.code === c.code)),
    note: written > 0 ? `已生成 ${written} 个邀请码${baseUrl ? '，含分享链接' : ''}。` : '未生成任何邀请码。',
  };
}

/**
 * 注册时绑定邀请码（DB）。
 *
 * 幂等：一个码只绑第一个注册的人。第二个用同码注册的人**不再覆盖**
 * `registered_user_id` —— 否则「哪条码带来了哪个用户」这个事实会被后来者抹掉，
 * 而 RQ-159 要的正是按人回溯。
 */
export async function bindInvite({ code = null, userId = null, queryFn = null } = {}) {
  const c = normalizeInviteCode(code);
  const uid = int0(userId) || null;
  if (!c) return { bound: false, reason: '邀请码为空或非法' };
  if (!uid) return { bound: false, reason: '缺少 userId' };
  if (!queryFn) return { bound: false, reason: '未提供 queryFn' };
  try {
    const { rows } = await queryFn(
      `UPDATE invite_codes
          SET registered_user_id = COALESCE(registered_user_id, $2),
              registered_at      = COALESCE(registered_at, now())
        WHERE code = $1
          AND (registered_user_id IS NULL OR registered_user_id = $2)
        RETURNING id, code, registered_user_id, registered_at`,
      [c, uid]
    );
    if (!rows[0]) return { bound: false, reason: '邀请码不存在' };
    const owned = int0(rows[0].registered_user_id) === uid;
    return {
      bound: true,
      owned,
      code: c,
      registeredUserId: rows[0].registered_user_id ?? null,
      note: owned ? '邀请码已绑定到本次注册。' : '该邀请码已被更早的注册占用，本次注册不改写归属。',
    };
  } catch (e) {
    return { bound: false, reason: e?.message || String(e) };
  }
}

export default {
  INVITE_ALPHABET,
  INVITE_CODE_LEN,
  INVITE_GOAL,
  INVITE_STEPS,
  MAX_BATCH,
  normalizeInviteCode,
  newInviteCode,
  buildInviteLink,
  planInvites,
  inviteePath,
  summarizeInviteFunnel,
  inviteFunnel,
  createInvites,
  bindInvite,
  INVITE_FUNNEL_SQL,
};
