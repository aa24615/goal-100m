/**
 * 数据保留期与导出承诺（RQ-154 / I-25 / F-84）
 *
 * 竞品调研（v12 §3.3）：**「训练数据保留期承诺」是 8 家竞品全部 ✗ 的空位**。
 * FX Replay 免费档「1 周保留 / 50 笔」在测评里被定性为「永远攒不到 100 笔样本」——
 * 保留期短是隐性劝退点：用户不敢投入三个月，怕练完数据没了。
 *
 * 因此把承诺写成产品语言，并且**在用户投入之前就说清楚**，而不是藏在条款里：
 *   - 登录用户：**永久保留**；
 *   - 游客：**7 天**，且第 5 天起主动提醒转登录。
 *
 * 设计约束：
 *   - **承诺必须是常量且可被测试锁定**：文案散落在各页面时，改一处漏一处，
 *     最后变成「页面说永久、实际 7 天删」的信任事故。这里一处定义，页面只读。
 *   - **游客不承诺永久**：游客身份随浏览器存储消失，承诺永久是兑不了的承诺。
 *   - **纯函数**：天龄由调用方传入，可无库单测。
 */

import pool from '../db.js';

/** 保留期承诺（唯一事实来源，页面与接口共用） */
export const RETENTION_POLICY = {
  version: 'v12',
  loggedIn: {
    days: null, // null = 永久
    label: '永久保留',
    body: '登录后你的训练记录、成绩卡与结算明细永久保留，不因时间自动删除。',
  },
  guest: {
    days: 7,
    label: '保留 7 天',
    body: '未登录（游客）的训练记录保留 7 天；到期后随浏览器存储一起清理。',
  },
  /** 第 5 天开始提醒：留 2 天缓冲，避免「今天提醒、明天就没了」 */
  remindFromDay: 5,
  /** 导出格式承诺 */
  exportFormats: ['csv', 'json'],
  minSampleToPromise: 100,
};

/**
 * 保留期提示（纯函数）。
 *
 * @param {object} o
 * @param {boolean} [o.isGuest]      是否游客
 * @param {number}  [o.ageDays]      游客首局距今天数（登录用户不需要）
 * @param {number}  [o.sessionCount] 游客已有局数（用于提醒的措辞强度）
 */
export function retentionNotice(o) {
  const src = o && typeof o === 'object' ? o : {};
  const isGuest = Boolean(src.isGuest);
  const n = Number.isFinite(Number(src.ageDays)) ? Math.max(0, Math.floor(Number(src.ageDays))) : null;
  const sessions = Number.isFinite(Number(src.sessionCount)) ? Math.max(0, Math.floor(Number(src.sessionCount))) : 0;

  if (!isGuest) {
    return {
      isGuest: false,
      level: 'info',
      title: RETENTION_POLICY.loggedIn.label,
      body: RETENTION_POLICY.loggedIn.body,
      daysLeft: null,
      urgent: false,
      cta: null,
      exportHint: `随时可导出为 ${RETENTION_POLICY.exportFormats.join(' / ')}，导出内容与页面逐行一致。`,
      policy: RETENTION_POLICY,
    };
  }

  const total = RETENTION_POLICY.guest.days;
  const daysLeft = n == null ? null : Math.max(0, total - n);
  const urgent = daysLeft != null && daysLeft <= Math.max(0, total - RETENTION_POLICY.remindFromDay + 1);

  return {
    isGuest: true,
    level: urgent ? 'warn' : 'info',
    title: `游客记录${RETENTION_POLICY.guest.label}`,
    body:
      daysLeft == null
        ? RETENTION_POLICY.guest.body
        : `你已经练了 ${sessions} 局，游客记录将在 ${daysLeft} 天后清理。现在注册可以永久保留，且历史记录一并带走。`,
    daysLeft,
    // 第 5 天起（含）才提醒：天天提醒等于没有提醒，用户会直接关掉
    remind: n != null && n >= RETENTION_POLICY.remindFromDay,
    urgent,
    cta: urgent ? { label: '注册并保留记录', action: '/register' } : null,
    exportHint: `在清理前可导出为 ${RETENTION_POLICY.exportFormats.join(' / ')}；注册后记录永久保留。`,
    policy: RETENTION_POLICY,
  };
}

/**
 * 游客天龄（DB）。
 * 用 `MIN(created_at)` 而非 `created_at >= now() - 7 days`：
 * 后者在跨时区与跨日边界上会算错（v10 踩过同款：拿 UTC 时间戳比上海日期）。
 */
export async function guestAgeDays(guestToken, { queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const t = String(guestToken ?? '').trim();
  if (!t) return { ageDays: null, sessionCount: 0 };
  const { rows } = await q(
    `SELECT COUNT(*)::int AS c,
            EXTRACT(EPOCH FROM (now() - MIN(created_at)))::bigint AS oldest_sec
       FROM blind_sessions WHERE guest_token = $1`,
    [t]
  );
  const sec = Number(rows[0]?.oldest_sec);
  return {
    ageDays: Number.isFinite(sec) && sec >= 0 ? Math.floor(sec / 86400) : null,
    sessionCount: rows[0]?.c || 0,
  };
}

/* ------------------------------------------------------------------ *
 * 训练记录导出（RQ-154「导出可用」）                                   *
 * ------------------------------------------------------------------ */

/** CSV 转义：只处理分隔符、引号与换行，不引依赖 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 把会话行渲染成导出表（纯函数，页面列与导出列同源） */
export function trainingRecordsCsv(sessions = []) {
  const list = Array.isArray(sessions) ? sessions : [];
  const header = [
    '训练ID',
    '别名',
    '状态',
    '局长',
    '已结算',
    '有效完成',
    '收益率%',
    '买入持有%',
    '成交笔数',
    '耗时秒',
    '纪律执行率%',
    '开始时间',
    '完成时间',
    '标的',
  ];
  const rows = list.map((s) => {
    const sc = s?.score && typeof s.score === 'object' ? s.score : {};
    return [
      s?.id ?? '',
      s?.alias ?? '',
      s?.status ?? '',
      s?.preset ?? '',
      s?.completed ? '是' : '否',
      s?.effective === null || s?.effective === undefined ? '未知' : s.effective ? '是' : '否',
      Number.isFinite(Number(sc.returnPct)) ? Number(sc.returnPct) : '',
      Number.isFinite(Number(sc.buyHoldPct)) ? Number(sc.buyHoldPct) : '',
      Number.isFinite(Number(sc.tradeCount)) ? Number(sc.tradeCount) : '',
      Number.isFinite(Number(sc.durationSec)) ? Number(sc.durationSec) : '',
      Number.isFinite(Number(sc.disciplineRate)) ? Number(sc.disciplineRate) : '',
      s?.createdAt ?? s?.created_at ?? '',
      s?.finishedAt ?? s?.finished_at ?? '',
      s?.code ?? s?.stock_code ?? '',
    ];
  });
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  return `\uFEFF${body}\r\n`;
}

/**
 * 取可导出的训练记录（DB）。
 * 游客按 guest_token 取；登录用户按 user_id 取，**两者不混**
 * （v9 起的分层约定：注册用户数与完成率的分母不能被游客污染）。
 */
export async function exportableSessions(identity, { limit = 500, queryFn = null } = {}) {
  const q = queryFn || ((sql, params) => pool.query(sql, params));
  const id = identity && typeof identity === 'object' ? identity : {};
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500));

  if (id.userId != null) {
    const { rows } = await q(
      `SELECT id, alias, status, preset, score, created_at, finished_at,
              stock_code, stock_name, effective_completed,
              (finished_at IS NOT NULL) AS completed
         FROM blind_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [id.userId, lim]
    );
    return rows.map((r) => ({
      id: r.id,
      alias: r.alias,
      status: r.status,
      preset: r.preset,
      score: r.score,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      code: r.stock_code,
      name: r.stock_name,
      completed: Boolean(r.completed),
      effective: r.effective_completed === null ? null : Boolean(r.effective_completed),
    }));
  }

  const t = String(id.guestToken ?? '').trim();
  if (!t) return [];
  const { rows } = await q(
    `SELECT id, alias, status, preset, score, created_at, finished_at,
            stock_code, stock_name, effective_completed,
            (finished_at IS NOT NULL) AS completed
       FROM blind_sessions
      WHERE guest_token = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [t, lim]
  );
  return rows.map((r) => ({
    id: r.id,
    alias: r.alias,
    status: r.status,
    preset: r.preset,
    score: r.score,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    code: r.stock_code,
    name: r.stock_name,
    completed: Boolean(r.completed),
    effective: r.effective_completed === null ? null : Boolean(r.effective_completed),
  }));
}
