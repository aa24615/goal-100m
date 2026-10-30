// 双盲训练场路由（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 决策记录 / RQ-41 成绩）

import express from 'express';
import pool from '../db.js';
import { logger } from '../logger.js';
import { authMiddleware, optionalAuth } from '../auth.js';
import { asyncHandler, parseIdParam, businessError } from '../middleware.js';
import { identityOf, guestTokenFromRequest, guestQuota, normalizeGuestToken, GUEST_TODAY_SQL } from '../services/guestService.js';
import { resolveSessionLength, DEFAULT_BARS } from '../services/sessionLengthService.js';
import { COMPLETION, isCompleted } from '../services/completionContract.js';
import {
  startBlind,
  getBlindSession,
  stepBlind,
  recordDecision,
  tradeInBlind,
  finishBlind,
  listBlindSessions,
  listBlindDecisions,
  resumeBlind,
  abandonBlind,
  DECISION_INTERVAL,
  SEGMENT_TAGS,
  SEGMENT_TAG_ALIASES,
  GRANULARITIES,
  DEFAULT_GRANULARITY,
} from '../services/blindService.js';
import { buildPrescription } from '../services/checkupService.js';
import { track } from '../services/analyticsService.js';
import { trackOnce } from '../services/telemetryIntegrityService.js';
import { buildScoreCard } from '../services/scoreCardService.js';
import { buildSettlementSheet } from '../services/settlementService.js';
import { buildSettlementAudit, settlementAuditCsv } from '../services/settlementAuditService.js';
import { exportableSessions, trainingRecordsCsv, retentionNotice } from '../services/dataRetentionService.js';
import { buildDualBaseline } from '../services/dualBaselineService.js';
import {
  evaluateEffectiveCompletion,
  allowFinishTelemetry,
  EFFECTIVE_RULES,
} from '../services/effectiveCompletionService.js';
import { planAccountSync, checkRuleParity, RULES_MANIFEST } from '../services/ruleParityService.js';
import { buildReview } from '../services/reviewService.js';
import { getSnapshot } from '../market.js';

const router = express.Router();

/**
 * RQ-108 归属中间件：登录用户或游客均可，但**不允许匿名**。
 *
 * 与 authMiddleware 的区别：不再一律 401。此前注册是第一次训练的前置门槛（F-36），
 * 用户在体验到任何价值之前就被拦下。现在带 X-Guest-Token 即可开局。
 * 与 optionalAuth 的区别：无身份时明确 401，而不是放行——
 * 放行会让「没传身份」被 SQL 当成「不过滤」，那是能看到别人训练的事故。
 */
function blindIdentity(req, res, next) {
  optionalAuth(req, res, () => {
    const id = identityOf({ userId: req.userId ?? null, guestToken: guestTokenFromRequest(req) });
    if (id.anonymous) return res.status(401).json({ error: '未登录且未提供游客 token' });
    req.blindIdentity = id;
    next();
  });
}

/** 游客今日已开始的局数（用于免登录额度） */
async function guestUsedToday(token) {
  const t = normalizeGuestToken(token);
  if (!t) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM blind_sessions
      WHERE guest_token=$1 AND ${GUEST_TODAY_SQL}`,
    [t]
  );
  return rows[0]?.c || 0;
}

/**
 * RQ-110 引导埋点：由调用方显式声明这是一次引导局，避免把直连 /blind 也算进引导路径。
 *
 * RQ-147：finish 一步**先过有效完成门槛再发**。埋点一旦发出就进了分母，
 * 事后清洗只能改数据库、改不了别人已经看到的数——所以在发送前拦。
 */
async function trackGuide(identity, step, extra = {}) {
  const map = {
    start: 'first_training_start',
    decision: 'first_training_decision',
    finish: 'first_training_finish',
  };
  const ev = map[step];
  if (!ev || !identity.userId) return false;
  return trackOnce(identity.userId, ev, extra, { guestToken: identity.guestToken });
}

/** RQ-147 引导结算埋点：未达有效完成门槛时改发 invalid 事件，保留可诊断性 */
async function trackGuideFinish(identity, evaluation, extra = {}) {
  if (!identity?.userId) return { sent: false };
  const gate = allowFinishTelemetry(evaluation);
  if (!gate.send) {
    // 不发 first_training_finish，但发一条可诊断的事件，避免「埋点没了就不知道发生了什么」
    await trackOnce(identity.userId, 'blind_finish', { ...extra, invalid: true, blockers: evaluation.blockerKeys })
      .catch(() => {});
    return { sent: false, reason: gate.reason, alternative: gate.alternative };
  }
  await trackOnce(identity.userId, 'first_training_finish', extra, { guestToken: identity.guestToken }).catch(() => {});
  return { sent: true, reason: 'effective' };
}

/**
 * RQ-147 把「有效完成」判定写回会话行。
 *
 * 为什么要落库而不是每次重算：`score` 是 JSONB，历史结构可能缺字段，
 * 重算会把「真走了 5 分钟但 score 没写 durationSec」误判成空跑（v12 id=8 就是 0）。
 * 落库后口径固定，也便于 RQ-148 的漏斗直接按 `effective_completed` 计数。
 */
async function persistEffective(sessionId, evaluation) {
  try {
    await pool.query(
      `UPDATE blind_sessions
          SET effective_completed = $2, effective_blockers = $3::jsonb
        WHERE id = $1`,
      [sessionId, evaluation.effective, JSON.stringify(evaluation.blockerKeys || [])]
    );
  } catch (e) {
    // 判定本身不落库也要能出成绩：这里失败只记日志，不能让整局白跑
    logger.warn('有效完成判定落库失败', { sessionId, err: e?.message || e });
  }
}

/** RQ-82 片段类型字典 + RQ-81 可用粒度：页面据此渲染筛选项，不硬编码在前端 */
router.get('/blind/tags', optionalAuth, (req, res) => {
  res.json({
    tags: Object.values(SEGMENT_TAGS),
    granularities: GRANULARITIES,
    defaultGranularity: DEFAULT_GRANULARITY,
    // Q6 未确认前分钟级数据不可得，页面必须明示粒度而不是假装支持
    intradayAvailable: GRANULARITIES.some((g) => g.key !== 'day' && g.available),
    note: '当前仅日线（day）有真实行情数据；分钟级数据源接入前，其余粒度会返回 400。',
  });
});

/**
 * RQ-83 训练处方：由体检单的「最坏习惯」生成定向训练计划。
 * 入参 checkup 由前端把 `/review/checkup` 的响应原样带回，
 * 后端不做二次取数 —— 保证处方依据的就是用户眼前那一份体检单。
 */
router.post(
  '/blind/prescription',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const checkup = req.body?.checkup;
    if (!checkup || typeof checkup !== 'object') {
      throw businessError('缺少体检单数据', 400);
    }
    res.json(buildPrescription(checkup));
  })
);

/**
 * 由体检单直接开训：处方生成 + 按标签抽取片段一步到位（RQ-83 的「一键」）。
 * 与 /blind/prescription 的区别是这里会真的创建会话。
 */
router.post(
  '/blind/prescription/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const checkup = req.body?.checkup;
    if (!checkup || typeof checkup !== 'object') {
      throw businessError('缺少体检单数据', 400);
    }
    const p = buildPrescription(checkup);
    const session = await startBlind({
      userId: req.userId,
      bars: Number(req.body?.bars) || p.bars,
      tag: p.tag,
      prescriptionKey: p.habitKey || 'default',
      granularity: req.body?.granularity,
    });
    await track(req.userId, 'prescription_start', { sessionId: session.id, habitKey: p.habitKey, tag: p.tag });
    res.json({
      id: session.id,
      alias: session.alias,
      status: session.status,
      totalBars: session.end_seq - session.start_seq + 1,
      decisionInterval: DECISION_INTERVAL,
      prescription: p,
    });
  })
);

// RQ-67 一键「随机来一段」：不传 code 即随机抽一段真实历史；传了则走定向片段（便于复测）
// RQ-82 传 tag 即按特征抽取；RQ-81 传 granularity 指定粒度（当前仅 day 可用）
router.post(
  '/blind/start',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const { bars, liquidOnly, code, startSeq, endSeq, tag, granularity, preset } = req.body || {};
    const id = req.blindIdentity;

    // RQ-108 免登录额度：游客每日 3 局，超出后明确提示注册，而不是静默失败
    let quota = null;
    if (id.isGuest) {
      quota = guestQuota(await guestUsedToday(id.guestToken));
      if (!quota.allowed) throw businessError(quota.message, 429);
    }

    // RQ-107 短局化：preset/bars 缺省一律走默认快局（12 根），长局需显式指定
    const len = resolveSessionLength(preset ?? bars ?? null);
    const session = await startBlind({
      userId: id.userId,
      guestToken: id.guestToken,
      bars: len.bars,
      liquidOnly: liquidOnly !== false,
      code,
      startSeq,
      endSeq,
      tag,
      granularity: granularity || DEFAULT_GRANULARITY,
      preset: len.key,
    });
    // RQ-143：开训同一会话只记一条（此前 blind_start 与 blind_resume 数量级完全对不上）
    await trackOnce(req.userId ?? null, id.isGuest ? 'guest_training_start' : 'blind_start', {
      sessionId: session.id,
      bars: session.end_seq - session.start_seq + 1,
      preset: len.key,
      guest: id.isGuest,
      tag: session.segment_tag || null,
      granularity: session.granularity || DEFAULT_GRANULARITY,
    }, { guestToken: id.guestToken }).catch(() => {});
    if (req.body?.guide === true) await trackGuide(id, 'start', { sessionId: session.id, preset: len.key });

    // 训练中绝不返回 stock_code / stock_name，也不返回 seq（seq 可对回交易日历 → 日期）
    // segment_tag 是统计口径不是身份信息，可以返回
    res.json({
      id: session.id,
      alias: session.alias,
      status: session.status,
      totalBars: session.end_seq - session.start_seq + 1,
      decisionInterval: DECISION_INTERVAL,
      segmentTag: session.segment_tag || null,
      granularity: session.granularity || DEFAULT_GRANULARITY,
      // RQ-107：让页面能回答「这一局多长、需要几次判断」
      preset: { key: len.key, label: len.label, bars: len.bars, desc: len.desc },
      // RQ-108：游客局要带回剩余额度与唯一的注册理由
      guest: id.isGuest ? { quota, signupReason: quota?.signupReason ?? null } : null,
      // RQ-109：完成口径随会话一起下发，避免前端另写一套文案
      completion: { definition: COMPLETION.definition, status: COMPLETION.sessionStatus },
      defaultBars: DEFAULT_BARS,
    });
  })
);

router.get(
  '/blind/history',
  blindIdentity,
  asyncHandler(async (req, res) => {
    res.json(await listBlindSessions(req.blindIdentity, Number(req.query.limit) || 20));
  })
);

/**
 * RQ-154 训练记录导出承诺（I-25）。
 *
 * 竞品 8 家无一明确保留期；FX Replay 免费档「1 周保留 / 50 笔」被测评定性为
 * 「永远攒不到 100 笔样本」——保留期是隐性劝退点。因此导出必须真的能用，
 * 而不是写在文案里：`?format=csv` 直接下载，列与页面逐行一致。
 *
 * 必须放在 `/blind/:id` 之前，否则会被当成 id=export 走 400 分支。
 */
router.get(
  '/blind/export',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const list = await exportableSessions(req.blindIdentity, { limit: Number(req.query.limit) || 500 });
    const notice = retentionNotice({
      isGuest: Boolean(req.blindIdentity.isGuest),
      sessionCount: list.length,
    });
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="training-records.csv"');
      return res.send(trainingRecordsCsv(list));
    }
    return res.json({ count: list.length, sessions: list, retention: notice });
  })
);

/**
 * RQ-91 断点续做：返回最近一个未结束的会话 + 「上次停在第 N 根」提示。
 * 必须放在 `/blind/:id` 之前，否则会被当成 id=resume 走 400 分支（那正是 F-25 的噪声来源之一）。
 */
router.get(
  '/blind/resume',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const r = await resumeBlind(req.blindIdentity);
    if (r.resumable) {
      // RQ-143：续做是会话级动作，同一会话只记一条。此前前端轮询导致
      // 714 条 blind_resume / 仅 2 个用户（单分钟 228 条），漏斗彻底不可读。
      await trackOnce(req.userId ?? null, 'blind_resume', {
        sessionId: r.session?.id ?? null,
        cursorIndex: r.hint?.cursorIndex ?? null,
        totalBars: r.hint?.totalBars ?? null,
      }, { guestToken: req.blindIdentity.guestToken }).catch(() => {});
    }
    res.json(r);
  })
);

/**
 * RQ-101 参数字典（唯一源）：前端一律从这里取标签与别名，
 * 不再各自硬编码，避免 sideways / range 两套写法漂移。
 */
router.get('/blind/dict', optionalAuth, (req, res) => {
  res.json({
    tags: Object.values(SEGMENT_TAGS),
    tagKeys: Object.keys(SEGMENT_TAGS),
    aliases: SEGMENT_TAG_ALIASES,
    granularities: GRANULARITIES,
    defaultGranularity: DEFAULT_GRANULARITY,
    decisionInterval: DECISION_INTERVAL,
    note: '标签以 tagKeys 为唯一规范写法；aliases 中的历史写法会被服务端归一化后接受，不再返回 400。',
  });
});

// RQ-91 放弃这段训练（与「继续」并列的两个出口）
router.post(
  '/blind/:id/abandon',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const s = await abandonBlind(req.blindIdentity, id);
    if (!s) throw businessError('没有可放弃的进行中训练', 404);
    await track(req.userId ?? null, 'blind_abandon', { sessionId: id });
    res.json({ ok: true, id });
  })
);

/**
 * RQ-99 训练成绩卡：可复制为纯文本的单次结论。
 * sampleSize 取自体检单（buildReview），保证「距下一档还差 N 笔」与体检单同源。
 */
router.get(
  '/blind/:id/card',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id, { reveal: true });
    if (!r) throw businessError('训练不存在', 404);
    // RQ-112 误差带进成绩页：样本量与 σ 优先取体检单，游客无体检单时按 0 处理（误差带会给出「无样本」文案）
    let sampleSize = 0;
    let sigma = null;
    let expectancyR = null;
    if (req.userId) {
      const priceMap = {};
      for (const q of getSnapshot()) priceMap[q.code] = q.price;
      const review = await buildReview(req.userId, '90d', priceMap);
      sampleSize = review?.checkup?.sampleSize ?? 0;
      sigma = review?.checkup?.sigma ?? null;
      expectancyR = review?.checkup?.expectancyR ?? null;
    }
    const card = buildScoreCard({
      session: r.session,
      score: r.session.score || null,
      sampleSize,
      sigma,
      expectancyR,
    });
    await track(req.userId ?? null, 'score_card_view', { sessionId: id });
    res.json({
      ...card,
      // RQ-109 完成口径随卡下发：完成 = 结算并出成绩卡
      completed: isCompleted(r.session),
      completion: { definition: COMPLETION.definition, status: COMPLETION.sessionStatus },
    });
  })
);

/**
 * RQ-125 结算口径说明书（I-13 / F-53）。
 *
 * 用户真正会怀疑的是「这个成交价是不是假的」。一旦怀疑成立，训练价值归零——
 * 所以这里把每一笔成交的成交价、金额、费用拆解与规则口径全部摊开，
 * 让用户能拿计算器逐笔复核，而不是让他相信我们。
 */
router.get(
  '/blind/:id/settlement',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);

    // 未揭示（训练中）刻意不 select stock_code / stock_name —— 与双盲同一条红线
    const { rows } = await pool.query(
      `SELECT seq, side, quantity, price, amount, fee, realized_pnl
         FROM blind_orders WHERE session_id=$1 ORDER BY seq ASC, id ASC`,
      [id]
    );

    const sheet = buildSettlementSheet({
      orders: rows,
      session: r.session,
      score: r.session?.score || null,
    });
    res.json(sheet);
  })
);

/**
 * RQ-150 结算口径说明书（I-22 / F-62 / F-78）。
 *
 * 与 `/blind/:id/settlement` 的分工：
 *   - settlement 给**费用与对账**（已经有了）；
 *   - settlement-audit 补三个验收必须回答的问题：
 *       「为什么是这个价」（撮合价溯源到具体哪一根 K 线）、
 *       「滑点多少」（如实写 0，不编造模型）、
 *       「被拒绝的委托去哪了」（拒绝原因归类到规则条款 + 怎么核对 + 下一步）。
 *
 * 命名刻意避开「逐笔」二字（F-81）：竞品语境里的逐笔 = L2 行情明细，
 * 我们给的是**结算口径说明书**，混用会让用户期待落空。
 *
 * `?format=csv` 返回与页面逐行一致的 CSV（含成交与拒绝两类）。
 */
router.get(
  '/blind/:id/settlement/audit',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);

    const finished = String(r.session?.status || '').toUpperCase() === 'FINISHED';

    // 撮合价溯源需要真实收盘价；**未揭示一律不取**，避免把标的行情提前送出去（双盲红线）
    let bars = [];
    if (finished && r.session.stock_code) {
      const { rows } = await pool.query(
        `SELECT seq, close FROM stock_daily
          WHERE code=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq ASC`,
        [r.session.stock_code, r.session.start_seq, r.session.end_seq]
      );
      bars = rows;
    }

    const { rows: orders } = await pool.query(
      `SELECT seq, side, quantity, price, amount, fee, realized_pnl
         FROM blind_orders WHERE session_id=$1 ORDER BY seq ASC, id ASC`,
      [id]
    );

    // 被拒绝的委托：撮合层把原因写进了 blind_decisions.reason，这里按 REJECT 语义取
    const { rows: rejections } = await pool.query(
      `SELECT seq, side, quantity, reason
         FROM blind_rejections WHERE session_id=$1 ORDER BY seq ASC, id ASC`,
      [id]
    ).catch(() => ({ rows: [] }));

    const audit = buildSettlementAudit({
      orders,
      rejections,
      bars,
      session: r.session,
      score: r.session?.score || null,
      reveal: finished,
    });

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="settlement-audit-${id}.csv"`);
      return res.send(settlementAuditCsv(audit));
    }
    return res.json(audit);
  })
);

/**
 * 双基准个人能力对照（RQ-137 / I-19，本期顺带接线消除 F-78 零引用）。
 *
 * 单基准（跑赢买入持有）回答不了「这段时间买什么都涨」，
 * 因此同时给「闭眼随便挑一天进场」作运气基准；种子取会话 ID，刷新结论不变。
 */
router.get(
  '/blind/:id/baseline',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);

    const finished = String(r.session?.status || '').toUpperCase() === 'FINISHED';
    let closes = [];
    if (finished && r.session.stock_code) {
      const { rows } = await pool.query(
        `SELECT close FROM stock_daily
          WHERE code=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq ASC`,
        [r.session.stock_code, r.session.start_seq, r.session.end_seq]
      );
      closes = rows.map((x) => x.close);
    }

    res.json(
      buildDualBaseline({
        closes,
        returnPct: r.session?.score?.returnPct ?? null,
        sampleSize: Number(req.query.sampleSize) || 0,
        // 种子取会话 ID：同一局刷新永远得到同一个「随机」基准，这是可复核的前提
        seed: Number(id) || 1,
      })
    );
  })
);

/**
 * RQ-102 训练与真实规则账户同源：先出规则校验与落单计划。
 * 训练未结束（身份仍在遮蔽）时拒绝生成计划——否则落单动作会提前暴露标的（RQ-66）。
 */
router.get(
  '/blind/:id/parity',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);
    const { rows } = await pool.query(
      'SELECT seq, stock_code, stock_name, side, quantity FROM blind_orders WHERE session_id=$1 ORDER BY seq ASC',
      [id]
    );
    res.json({
      manifest: RULES_MANIFEST,
      parity: checkRuleParity({ trainingRules: RULES_MANIFEST.map((x) => x.key), accountRules: RULES_MANIFEST.map((x) => x.key) }),
      plan: planAccountSync({ session: r.session, orders: rows }),
    });
  })
);

router.get(
  '/blind/:id',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await getBlindSession(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);
    res.json({
      session: r.session.status === 'FINISHED'
        ? { ...toSessionDto(r.session), revealed: true }
        : toSessionDto(r.session),
      view: r.view,
      bars: r.maskedBars,
    });
  })
);

function toSessionDto(s) {
  const over = s.status === 'FINISHED';
  return {
    id: s.id,
    alias: s.alias,
    status: s.status,
    // RQ-109 完成口径唯一源：完成 = 结算并出成绩卡（不只是「走完 60 根」）
    completed: isCompleted(s),
    completionDefinition: COMPLETION.definition,
    // RQ-107 局长度档位（页面据此回答「这一局多长」）
    preset: s.preset || 'standard',
    // 未结束时不暴露身份字段
    code: over ? s.stock_code : null,
    name: over ? s.stock_name : null,
    // seq 与交易日历一一对应，未结束即等于送出了日期区间
    startSeq: over ? s.start_seq : null,
    endSeq: over ? s.end_seq : null,
    cursorSeq: over ? s.cursor_seq : null,
    totalBars: s.end_seq - s.start_seq + 1,
    cursorIndex: s.cursor_seq - s.start_seq + 1,
    score: s.score,
    createdAt: s.created_at,
    finishedAt: s.finished_at,
    // RQ-82 特征标签 / RQ-81 粒度：均为统计口径，不构成身份泄露
    segmentTag: s.segment_tag || null,
    segmentTagLabel: s.segment_tag ? SEGMENT_TAGS[s.segment_tag]?.label || null : null,
    granularity: s.granularity || DEFAULT_GRANULARITY,
  };
}

router.post(
  '/blind/:id/step',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await stepBlind(req.blindIdentity, id, String(req.body?.action || 'next'), req.body?.seq);
    if (!r) throw businessError('训练不存在', 404);
    res.json({ view: r.view, bars: r.maskedBars });
  })
);

// RQ-38 决策记录：未写理由记为「未记录」，计入纪律执行率
router.post(
  '/blind/:id/decision',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const { action, reason, stopPlan, skipped } = req.body || {};
    const r = await recordDecision({
      userId: req.blindIdentity.userId,
      guestToken: req.blindIdentity.guestToken,
      sessionId: id,
      action,
      reason,
      stopPlan,
      skipped,
    });
    if (!r) throw businessError('训练不存在', 404);
    await track(req.userId ?? null, 'blind_decision', { sessionId: id, skipped: r.skipped });
    if (req.body?.guide === true) await trackGuide(req.blindIdentity, 'decision', { sessionId: id });
    res.json(r);
  })
);

router.get(
  '/blind/:id/decisions',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const list = await listBlindDecisions(req.blindIdentity, id);
    if (!list) throw businessError('训练不存在', 404);
    res.json(list);
  })
);

router.post(
  '/blind/:id/trade',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await tradeInBlind({
      userId: req.blindIdentity.userId,
      guestToken: req.blindIdentity.guestToken,
      sessionId: id,
      side: req.body?.side,
      quantity: req.body?.quantity,
    });
    if (!r) throw businessError('训练不存在', 404);
    res.json({ ok: true, view: r.view, bars: r.maskedBars });
  })
);

// RQ-41 结束 → 揭示身份并出成绩（含纪律执行率）
router.post(
  '/blind/:id/finish',
  blindIdentity,
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) throw businessError('训练 ID 无效', 400);
    const r = await finishBlind(req.blindIdentity, id);
    if (!r) throw businessError('训练不存在', 404);

    /**
     * RQ-147 有效完成判定：必须在出成绩卡**之前**算。
     * 顺序反了就会先给用户一张 0 笔成交的成绩卡，再告诉他不算数。
     */
    const { rows: orderRows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM blind_orders WHERE session_id=$1',
      [id]
    );
    const evaluation = evaluateEffectiveCompletion({
      session: r.session,
      score: r.session.score || null,
      orderCount: orderRows[0]?.c ?? null,
    });
    await persistEffective(id, evaluation);

    // RQ-143：blind_finish 按会话去重 —— 埋点数必须等于 FINISHED 会话数（RQ-144 的验收式）
    await trackOnce(req.userId ?? null, req.blindIdentity.isGuest ? 'guest_training_finish' : 'blind_finish', {
      sessionId: id,
      returnPct: r.session.score?.returnPct ?? null,
      disciplineRate: r.session.score?.disciplineRate ?? null,
      effective: evaluation.effective,
      tradeCount: evaluation.tradeCount,
      durationSec: evaluation.durationSec,
    }, { guestToken: req.blindIdentity.guestToken }).catch(() => {});

    // RQ-147：未达有效完成门槛时不发 first_training_finish，北极星分子不再被空跑刷满
    const guideTelemetry = req.body?.guide === true
      ? await trackGuideFinish(req.blindIdentity, evaluation, { sessionId: id })
      : { sent: false, reason: 'not-guide' };

    res.json({
      // RQ-109：完成 = 结算并出成绩卡。这里把 completed 与口径一起下发，
      // 避免前端再写一套「提交判断就算完成」的旧文案（F-32）。
      completed: isCompleted(r.session),
      completion: { definition: COMPLETION.definition, status: COMPLETION.sessionStatus },
      // RQ-147：形式完成之外再给有效完成，前端据此决定出成绩卡还是出「再来一次」
      effective: {
        effective: evaluation.effective,
        tradeCount: evaluation.tradeCount,
        durationSec: evaluation.durationSec,
        bars: evaluation.bars,
        blockers: evaluation.blockers,
        rules: EFFECTIVE_RULES,
        scoreCard: evaluation.scoreCard,
        note: evaluation.note,
        guideTelemetry,
      },
      session: toSessionDto(r.session),
      score: r.session.score,
      view: r.view,
      // RQ-113：净胜局由本局收益率与买入持有收益率的差算出，供「每日一题」直接取用
      netWin:
        Number.isFinite(Number(r.session.score?.returnPct)) && Number.isFinite(Number(r.session.score?.buyHoldPct))
          ? Number(r.session.score.returnPct) > Number(r.session.score.buyHoldPct)
            ? 1
            : Number(r.session.score.returnPct) < Number(r.session.score.buyHoldPct)
              ? -1
              : 0
          : null,
    });
  })
);

export default router;
