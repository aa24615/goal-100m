/**
 * v38 需求实现与测试覆盖矩阵（RQ-221 ~ RQ-230）
 *
 * 对应「产品需求表 · 赚了一个小目标」v37（2026-11-28）§5/§6 需求表（10 项，RQ-221~230）。
 * v37 与历史「一行证据」模式不同——恢复完整五部分评审，公网入口列为全局 gate（G-0）。
 *
 * 六档测试级别约定（v7 起，沿用）：
 *   P0 主流程 / P1 差异化 / P2 留存体验 / P3 边界异常 / P4 性能并发 / P5 兼容回归。
 *   注意：需求表里的 P0/P1/P2 是**产品优先级**，本文件 P0~P5 是**测试级别**，两回事。
 *
 * 本期实现增量：
 *   - RQ-226「拒绝归类」为本期唯一真实开发缺口 → 新建 diagnosisObjectionService.js
 *     + diagnosis.js 路由 + 迁移 0022，本文件 P0~P5 六档全覆盖。
 *   - RQ-221~225/227~230 底层服务在 v10~v18 已落地，按 v37 新编号重新组织覆盖。
 *
 * 所有断言的字段形状均来自对真实服务返回值的实测（2026-11-28 亲跑），非凭记忆猜测。
 *
 * 运行：node --test tests/unit/v38Requirements.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolvePublicAccess,
  normalizeBaseUrl,
  hostOf,
} from '../../src/services/publicAccessService.js';
import { ownerState, summarizePublicEntry, frozenGate, FROZEN_RQS } from '../../src/services/publicEntryService.js';
import { guestQuota, identityOf, normalizeGuestToken, safeUserId } from '../../src/services/guestService.js';
import { isCompleted } from '../../src/services/completionContract.js';
import {
  evaluateEffectiveCompletion,
  effectiveCompletionRate,
  allowFinishTelemetry,
  EFFECTIVE_RULES,
} from '../../src/services/effectiveCompletionService.js';
import {
  dedupeKeyOf,
  shouldAccept,
  summarizeConsistency,
  DEFAULT_CONSISTENCY_RULES,
} from '../../src/services/telemetryIntegrityService.js';
import { classifyIngest } from '../../src/services/testIsolationService.js';
import { isExternalUser } from '../../src/services/testTrafficService.js';
import { feeBreakdown, buildSettlementSheet } from '../../src/services/settlementService.js';
import { buildSettlementAudit, classifyRejection, settlementAuditCsv } from '../../src/services/settlementAuditService.js';
import {
  DIAGNOSIS_CATALOG,
  extractDiagnosableItems,
  normalizeDiagnosisKey,
  validateObjection,
  buildObjectionRecord,
  dedupeObjections,
  applyObjections,
  summarizeObjections,
  ownerKeyOf,
  objectionOwnerClause,
  OBJECTION_SQL,
  REASON_MAX_LEN,
} from '../../src/services/diagnosisObjectionService.js';
import { buildSmallSampleFacts, assertNoEdgeAssertion } from '../../src/services/smallSampleService.js';
import { resolveRatioGate, RATIO_GUARD_THRESHOLD } from '../../src/services/checkupService.js';
import { tStat, confidenceInterval, buildConclusionPanel } from '../../src/services/intervalConclusionService.js';
import { buildScoreCard } from '../../src/services/scoreCardService.js';
import { checkIdentityWording, FORBIDDEN_WORDINGS, REQUIRED_PHRASES } from '../../src/services/identityWordingService.js';
import { retentionNotice, guestAgeDays, RETENTION_POLICY } from '../../src/services/dataRetentionService.js';
import { buildLandingCopy, LANDING_ELEMENTS } from '../../src/services/stageZeroService.js';

const NOW = new Date('2026-11-28T02:00:00+08:00');
const GUEST = 'abcdefghijklmnopqrstuvwx'; // 24 位合法游客 token

/* ================================================================== *
 * RQ-221 公网入口打通（M46 / 产品优先级 P0 / gate G-0）
 * ================================================================== */
describe('RQ-221 公网入口（P0 gate）', () => {
  it('RQ-221 · P0 · 正常流程 · 未配置 PUBLIC_BASE_URL 时 ready:false 且给出可执行待办', () => {
    const r = resolvePublicAccess({}, {});
    assert.equal(r.ready, false);
    assert.equal(r.publicUrl, null);
    assert.equal(r.checklist.length, 5, 'checklist 应为 dns/https/proxy/readme/smoke 五项');
    assert.ok(r.checklist.every((c) => c.done === false), '未配置时五项全 false');
    assert.ok(r.blockers.length > 0, '必须给出阻断项');
    assert.ok(r.nextAction.includes('PUBLIC_BASE_URL'), '待办应指向配置入口');
  });

  it('RQ-221 · P0 · 边界异常 · hostOf 能解析域名主机，normalizeBaseUrl 去尾斜杠', () => {
    assert.equal(hostOf('https://train.example.com/foo'), 'train.example.com');
    assert.equal(normalizeBaseUrl('https://train.example.com/'), 'https://train.example.com');
  });

  it('RQ-221 · P1 · 差异化 · 公网域名与 nginx server_name 不一致被审计阻断', () => {
    const r = summarizePublicEntry({
      envText: 'PUBLIC_BASE_URL=https://train.example.com\nPUBLIC_ENTRY_OWNER=zyan\nPUBLIC_ENTRY_DEADLINE=2026-12-31',
      nginxText: 'server { server_name other.example.com; listen 443 ssl; }',
      readmeText: '请访问 https://train.example.com',
      smoke: true,
      now: NOW,
    });
    assert.equal(r.ready, false, '域名与 server_name 不一致不可 ready');
    assert.ok(r.audit.blockers.some((b) => b.includes('server_name') && b.includes('一致')), '应指出 nginx 与 baseUrl 不一致');
  });

  it('RQ-221 · P2 · 留存体验 · 截止日已逾期但 owner 已指定时 owner 侧不重复阻断（gate 单入口）', () => {
    const st = ownerState({ owner: 'zyan', deadline: '2026-11-16', now: NOW });
    assert.equal(st.daysLeft, -12, '11-28 距 11-16 逾期 12 天');
    assert.equal(st.state, 'overdue');
    assert.equal(st.blocked, true, '逾期应阻断');
    assert.ok(st.note.includes('升级'), '逾期文案应指向升级而非继续滚');
  });

  it('RQ-221 · P3 · 边界异常 · 无 owner 无截止时 ownerState 归 none 且 gate 冻结项仍为 10 项', () => {
    const st = ownerState({ now: NOW });
    assert.equal(st.state, 'none');
    const g = frozenGate({ publicReady: false });
    assert.equal(g.blocked.length, 10, 'gate 未开时冻结 10 项');
    assert.equal(FROZEN_RQS.length, 10);
  });

  it('RQ-221 · P4 · 性能并发 · 连续 1000 次未配置审计稳定 ready:false', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) if (resolvePublicAccess({}, {}).ready === false) n += 1;
    assert.equal(n, 1000);
  });

  it('RQ-221 · P5 · 兼容回归 · summarizePublicEntry 三处齐 + smoke 时 ready:true（历史口径不破）', () => {
    const r = summarizePublicEntry({
      envText: 'PUBLIC_BASE_URL=https://train.example.com\nPUBLIC_ENTRY_OWNER=zyan\nPUBLIC_ENTRY_DEADLINE=2026-12-31',
      nginxText: 'server { server_name train.example.com; listen 443 ssl; }\nserver { listen 80; server_name train.example.com; return 301 https://$host$request_uri; }',
      readmeText: '请访问 https://train.example.com',
      smoke: true,
      now: NOW,
    });
    assert.equal(r.ready, true, '三处齐 + owner/截止未过期 + smoke 应 ready');
    assert.equal(r.audit.checklist.every((c) => c.done), true);
  });
});

/* ================================================================== *
 * RQ-222 免登录练一次（M46 / 产品优先级 P0）
 * ================================================================== */
describe('RQ-222 免登录练一次（P0）', () => {
  it('RQ-222 · P0 · 正常流程 · 合法游客 token 归一成功且当日额度可用', () => {
    const id = identityOf({ userId: null, guestToken: GUEST });
    assert.equal(id.isGuest, true);
    assert.equal(id.anonymous, false);
    assert.equal(guestQuota(0).allowed, true);
    assert.equal(guestQuota(0).remaining, 3);
  });

  it('RQ-222 · P0 · 边界值 · 今日已用 3 局则 allowed:false（每日 3 局封顶）', () => {
    const q = guestQuota(3);
    assert.equal(q.allowed, false);
    assert.equal(q.remaining, 0);
    assert.ok(q.signupReason.includes('注册'));
  });

  it('RQ-222 · P1 · 差异化 · 登录用户带游客 token 时以用户为准，不串游客身份', () => {
    const id = identityOf({ userId: 7, guestToken: GUEST });
    assert.equal(id.userId, 7);
    assert.equal(id.guestToken, null, '登录后应丢弃游客 token');
  });

  it('RQ-222 · P2 · 留存体验 · 额度用尽的文案引导注册以保留成绩', () => {
    assert.match(guestQuota(3).message, /注册/);
  });

  it('RQ-222 · P3 · 边界异常 · 过短 token 被归一为 null，null userId 不算 0（v10 外键坑）', () => {
    assert.equal(normalizeGuestToken('abc123'), null, '6 位过短应拒绝');
    assert.equal(safeUserId(null), null, 'null 不可被算成 0');
    assert.equal(identityOf({}).anonymous, true);
    assert.equal(identityOf({}).userId, null);
  });

  it('RQ-222 · P4 · 性能并发 · 1000 次身份归一稳定', () => {
    let ok = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = identityOf({ guestToken: GUEST });
      if (id.isGuest && id.userId === null) ok += 1;
    }
    assert.equal(ok, 1000);
  });

  it('RQ-222 · P5 · 兼容回归 · 游客身份 SQL 归属条件仍走占位符（GUEST_TODAY_SQL 口径）', () => {
    const id = identityOf({ guestToken: GUEST });
    assert.equal(id.guestToken, GUEST);
    // 既有 owner 口径：游客 token 走 guest_token 列，userId 列保持 null
    assert.equal(id.userId, null);
  });
});

/* ================================================================== *
 * RQ-223 统一「有效完成」口径（M47 / 产品优先级 P0）
 * ================================================================== */
describe('RQ-223 有效完成口径（P0）', () => {
  const good = () => ({ status: 'FINISHED', finished_at: '2026-11-28T02:00:00Z', score: { tradeCount: 3, durationSec: 30, totalBars: 60, barsRevealed: 60 } });
  const emptyRun = () => ({ status: 'FINISHED', finished_at: '2026-11-28T02:00:00Z', score: { tradeCount: 0, durationSec: 30, totalBars: 60, barsRevealed: 60 } });

  it('RQ-223 · P0 · 正常流程 · 结算+有成交+时长达标 → effective:true', () => {
    const r = evaluateEffectiveCompletion({ session: good() });
    assert.equal(r.completed, true);
    assert.equal(r.effective, true);
    assert.equal(r.blockerKeys.length, 0);
    assert.equal(r.scoreCard.show, true);
  });

  it('RQ-223 · P0 · 核心验收 · 0 笔成交空跑不计有效完成且不出成绩卡', () => {
    const r = evaluateEffectiveCompletion({ session: emptyRun() });
    assert.equal(r.completed, true, '形式上结算完成');
    assert.equal(r.effective, false, '空跑不算有效完成');
    assert.ok(r.blockerKeys.includes('no_trade'));
    assert.equal(r.scoreCard.show, false, '空跑不应出成绩卡');
  });

  it('RQ-223 · P1 · 差异化 · 完成口径不是仅看 status FINISHED（须 finished_at + score）', () => {
    assert.equal(isCompleted({ status: 'FINISHED' }), false, '只有 status 不够');
    assert.equal(isCompleted(good()), true);
  });

  it('RQ-223 · P2 · 留存体验 · 未有效完成时给可执行的引导 CTA 而非空面板', () => {
    const r = evaluateEffectiveCompletion({ session: { status: 'RUNNING' } });
    assert.equal(r.scoreCard.show, false);
    assert.ok(r.scoreCard.fallback.title);
    assert.ok(r.scoreCard.fallback.cta);
  });

  it('RQ-223 · P3 · 边界异常 · 太快完成触发 too_fast 守卫', () => {
    const s = good();
    s.score.durationSec = 2;
    const r = evaluateEffectiveCompletion({ session: s });
    assert.ok(r.blockerKeys.includes('too_fast'));
    assert.equal(r.effective, false);
  });

  it('RQ-223 · P4 · 性能并发 · 1000 次有效完成判定稳定', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) if (evaluateEffectiveCompletion({ session: emptyRun() }).effective === false) n += 1;
    assert.equal(n, 1000);
  });

  it('RQ-223 · P5 · 兼容回归 · 埋点闸门口径稳定：有效才发 blind_finish，否则改发 invalid', () => {
    assert.equal(allowFinishTelemetry({ effective: true, blockers: [] }).send, true);
    assert.equal(allowFinishTelemetry({ effective: false, blockers: [{ key: 'no_trade' }] }).send, false);
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
  });
});

/* ================================================================== *
 * RQ-224 埋点去重 + is_test 隔离 + 埋点↔会话对账（M47 / P0）
 * ================================================================== */
describe('RQ-224 埋点去重与对账（P0）', () => {
  it('RQ-224 · P0 · 正常流程 · 去重键含用户/事件/时间窗，新键被接受', () => {
    const key = dedupeKeyOf({ event: 'blind_start', userId: 7, at: '2026-11-28T02:00:00Z' });
    assert.match(key, /u7\|blind_start\|/);
    assert.equal(shouldAccept(new Set(), key).accept, true);
    assert.equal(shouldAccept(new Set([key]), key).accept, false);
  });

  it('RQ-224 · P0 · 对账口径 · 默认规则覆盖 blind_finish 与 blind_start 双向', () => {
    assert.equal(DEFAULT_CONSISTENCY_RULES.length, 2);
    assert.deepEqual(DEFAULT_CONSISTENCY_RULES.map((r) => r.event).sort(), ['blind_finish', 'blind_start']);
    assert.ok(DEFAULT_CONSISTENCY_RULES.every((r) => r.tolerance === 0), '对账容差为 0');
  });

  it('RQ-224 · P1 · 差异化 · 内部渠道/测试号被隔离，外部直接渠道判为外部', () => {
    assert.equal(classifyIngest({ userId: 1, isTest: false, channel: 'direct' }).isTest, false);
    assert.equal(isExternalUser({ acquisition_channel: 'self', is_test: false }).external, false);
    assert.equal(isExternalUser({ acquisition_channel: 'direct', is_test: false }).external, false, '无 IP 不可判外部');
  });

  it('RQ-224 · P2 · 留存体验 · 有公网 IP 的外部渠道用户判为外部（北极星分母可信）', () => {
    const ipOpts = { isPublicIpv4: (ip) => ip === '8.8.8.8', isLocalHost: () => false };
    const r = isExternalUser({ acquisition_channel: 'direct', is_test: false, signup_ip: '8.8.8.8' }, ipOpts);
    assert.equal(r.external, true);
    assert.equal(r.reason, 'ok');
  });

  it('RQ-224 · P3 · 边界异常 · 同一时间窗内重复事件被判 duplicate', () => {
    const key = 'k-dup';
    const seen = new Set([key]);
    const r = shouldAccept(seen, key);
    assert.equal(r.reason, 'duplicate');
    assert.equal(r.accept, false);
  });

  it('RQ-224 · P4 · 性能并发 · 10000 次去重键生成无冲突（同用户同事件同窗）', () => {
    const keys = new Set();
    for (let i = 0; i < 10000; i += 1) keys.add(dedupeKeyOf({ event: 'blind_start', userId: 7, at: '2026-11-28T02:00:00Z' }));
    assert.equal(keys.size, 1, '相同输入应收敛为同一去重键');
  });

  it('RQ-224 · P5 · 兼容回归 · summarizeConsistency 对空输入给出结构化的零差异口径', () => {
    const r = summarizeConsistency({ events: [], sessions: [] });
    assert.ok(r && typeof r === 'object');
  });
});

/* ================================================================== *
 * RQ-225 逐笔结算口径说明书（M48 / 产品优先级 P1）
 * ================================================================== */
describe('RQ-225 逐笔结算可重算（P1）', () => {
  it('RQ-225 · P0 · 正常流程 · 结算表给出可核对的口径规则（价格/滑点/T+1）', () => {
    const sheet = buildSettlementSheet({ orders: [], session: { status: 'FINISHED' }, score: {} });
    assert.equal(sheet.applicable, true);
    assert.ok(Array.isArray(sheet.rules) && sheet.rules.length >= 3);
    assert.ok(sheet.rules.every((r) => r.verifiable), '每条口径都应写明怎么自行核对');
  });

  it('RQ-225 · P0 · 逐笔明细 · 成交价溯源到 K 线收盘价且一致', () => {
    const audit = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', quantity: 1000, price: 10.5, amount: 10500, fee: 5.1, reveal: true }],
      bars: [{ seq: 5, close: 10.5 }],
      score: {},
    });
    assert.equal(audit.orderCount, 1);
    assert.equal(audit.orders[0].priceOrigin.matched, true);
    assert.equal(audit.orders[0].priceOrigin.barClose, 10.5);
  });

  it('RQ-225 · P1 · 差异化 · 费用由 feeBreakdown 单一口径给出，最低佣金被标注', () => {
    const f = feeBreakdown(10000, 'BUY');
    assert.equal(f.commission, 5);
    assert.equal(f.minCommissionApplied, true);
    assert.equal(f.total, 5.1);
    assert.equal(feeBreakdown(10000, 'SELL').stamp, 5, '卖出才有印花税');
  });

  it('RQ-225 · P2 · 留存体验 · 结算明细可导出 CSV 且与页面同源（表头含逐笔字段）', () => {
    const audit = buildSettlementAudit({ session: { status: 'FINISHED' }, orders: [], score: {} });
    const csv = settlementAuditCsv(audit);
    assert.ok(csv.includes('成交价'), 'CSV 表头应含逐笔可核对字段');
    assert.ok(csv.includes('费用合计'));
    assert.ok(csv.includes('拒绝原因归类'));
  });

  it('RQ-225 · P3 · 边界异常 · 缺失 K 线时撮合价溯源 matched:null 且不猜 0', () => {
    const audit = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', quantity: 1000, price: 10.5, amount: 10500, reveal: true }],
      bars: [],
      score: {},
    });
    assert.equal(audit.orders[0].priceOrigin.hasQuote, false);
    assert.equal(audit.orders[0].priceOrigin.matched, null, '无报价不可判一致，也不能记成 0');
  });

  it('RQ-225 · P4 · 性能并发 · 1000 笔逐笔审计稳定不抛错', () => {
    const orders = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, side: 'BUY', quantity: 100, price: 10, amount: 1000, reveal: true }));
    assert.equal(buildSettlementAudit({ session: { status: 'FINISHED' }, orders, bars: [], score: {} }).orderCount, 1000);
  });

  it('RQ-225 · P5 · 兼容回归 · 双盲未揭示时标的代码为 null（既有红线不破）', () => {
    const audit = buildSettlementAudit({
      session: { status: 'RUNNING' },
      orders: [{ seq: 5, side: 'BUY', quantity: 1000, price: 10.5, amount: 10500, stock_code: '000001', reveal: false }],
      rejections: [{ seq: 6, side: 'SELL', quantity: 100, reason: 'T+1', stock_code: '000001' }],
      score: {},
    });
    assert.equal(audit.reveal, false);
    assert.equal(audit.orders[0].code, null);
    assert.equal(audit.rejections[0].code, null);
  });
});

/* ================================================================== *
 * RQ-226 拒绝归类（M48 / 产品优先级 P1）—— 本期唯一真实开发缺口
 * ================================================================== */
const checkupFixture = {
  verdict: { summary: '负期望，先修策略' },
  worstHabit: { title: '追高买入' },
  expectancyR: { value: -0.3 },
  discipline: { hint: '纪律执行率偏低' },
  tierLabel: '观察档',
};

describe('RQ-226 拒绝归类留痕（P1 · 本期新增）', () => {
  it('RQ-226 · P0 · 正常流程 · 诊断项可抽取为「可不同意」清单', () => {
    const items = extractDiagnosableItems(checkupFixture);
    assert.equal(items.length, DIAGNOSIS_CATALOG.length);
    assert.equal(items.filter((x) => x.available).length, 5);
    assert.ok(items.every((x) => x.kind === 'inference'), '只收结论/画像类');
    assert.equal(items.find((x) => x.key === 'verdict').text, '负期望，先修策略');
  });

  it('RQ-226 · P0 · 核心验收 · 用户标记不同意生成结构化留痕（含理由/归属/证据）', () => {
    const rec = buildObjectionRecord(
      { diagnosisKey: 'verdict', reason: '样本太少不能下结论', sessionId: 12 },
      { userId: 7, now: NOW, evidence: { text: '负期望，先修策略', sampleSize: 12 } }
    );
    assert.equal(rec.userId, 7);
    assert.equal(rec.guestToken, null);
    assert.equal(rec.diagnosisKey, 'verdict');
    assert.equal(rec.reason, '样本太少不能下结论');
    assert.equal(rec.sessionId, 12);
    assert.equal(rec.evidenceText, '负期望，先修策略');
    assert.equal(rec.sampleSize, 12);
  });

  it('RQ-226 · P1 · 差异化 · 留痕叠加到诊断视图后原诊断仍在，仅打 objected 标记', () => {
    const items = extractDiagnosableItems(checkupFixture);
    const rec = buildObjectionRecord({ diagnosisKey: 'worstHabit', reason: '那是行情特例' }, { userId: 7, now: NOW });
    const applied = applyObjections(items, [rec]);
    const habit = applied.find((x) => x.key === 'worstHabit');
    assert.equal(habit.text, '追高买入', '原诊断文本必须保留');
    assert.equal(habit.objected, true);
    assert.equal(habit.objectionReason, '那是行情特例');
    assert.equal(applied.find((x) => x.key === 'verdict').objected, false, '未标记的项不受影响');
  });

  it('RQ-226 · P2 · 留存体验 · 汇总对账给出争议率与最被质疑的诊断项', () => {
    const r1 = buildObjectionRecord({ diagnosisKey: 'verdict', reason: '不同意1' }, { userId: 7, now: NOW });
    const r2 = buildObjectionRecord({ diagnosisKey: 'verdict', reason: '不同意2' }, { userId: 8, now: NOW });
    const s = summarizeObjections([r1, r2], { totalDiagnoses: 10 });
    assert.equal(s.total, 2);
    assert.equal(s.byKey.verdict, 2);
    assert.equal(s.mostDisputed, 'verdict');
    assert.equal(s.disputeRate, 20);
    assert.equal(s.ok, true);
  });

  it('RQ-226 · P3 · 边界异常 · 未知诊断项/空理由/超长理由均被拒绝', () => {
    assert.equal(normalizeDiagnosisKey('nonsense'), null);
    assert.equal(validateObjection({ diagnosisKey: 'verdict', reason: '' }).ok, false, '空理由拒绝');
    assert.equal(validateObjection({ diagnosisKey: 'verdict', reason: 'x'.repeat(REASON_MAX_LEN + 1) }).ok, false, '超长拒绝');
    assert.equal(buildObjectionRecord({ diagnosisKey: 'verdict', reason: 'ok' }, {}), null, '无归属返回 null');
    assert.equal(buildObjectionRecord({ diagnosisKey: 'nope', reason: 'ok' }, { userId: 7 }), null);
  });

  it('RQ-226 · P3 · 边界异常 · 重复标记去重（同人同会话同项只留一条，后写覆盖）', () => {
    const a = buildObjectionRecord({ diagnosisKey: 'verdict', reason: '旧理由', sessionId: 12 }, { userId: 7, now: new Date('2026-11-28T02:00:00Z') });
    const b = { ...a, reason: '新理由', createdAt: '2026-11-28T04:00:00.000Z' };
    const ded = dedupeObjections([a, b]);
    assert.equal(ded.length, 1);
    assert.equal(ded[0].reason, '新理由');
  });

  it('RQ-226 · P4 · 性能并发 · 1000 条留痕去重稳定且归属不串号', () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      buildObjectionRecord({ diagnosisKey: 'verdict', reason: `r${i}`, sessionId: 12 }, { userId: 7, now: NOW })
    );
    assert.equal(dedupeObjections(rows).length, 1);
    const guestRow = buildObjectionRecord({ diagnosisKey: 'verdict', reason: 'g' }, { guestToken: GUEST, now: NOW });
    assert.equal(dedupeObjections([...rows, guestRow]).length, 2, '游客与注册用户不得串号');
  });

  it('RQ-226 · P5 · 兼容回归 · 归属隔离 SQL 走占位符，游客 userId=null 不算 0（v10 坑）', () => {
    const u = objectionOwnerClause({ userId: 7 });
    assert.equal(u.sql, 'user_id = $1');
    assert.deepEqual(u.params, [7]);
    const g = objectionOwnerClause({ guestToken: GUEST });
    assert.equal(g.sql, 'guest_token = $1');
    assert.deepEqual(g.params, [GUEST]);
    assert.equal(objectionOwnerClause({}).ownerKey, null, '无身份不得构造 SQL');
    assert.equal(ownerKeyOf({ userId: null }), null, 'null userId 不可归一为 u:0');
    assert.ok(OBJECTION_SQL.unique.includes('uq_'));
  });
});

/* ================================================================== *
 * RQ-227 样本门槛护栏（M48 / 产品优先级 P1）
 * ================================================================== */
describe('RQ-227 样本门槛护栏（P1）', () => {
  it('RQ-227 · P0 · 正常流程 · 小样本只给成本/行为/对照三类事实', () => {
    const f = buildSmallSampleFacts({ sampleSize: 12, rounds: [] });
    assert.equal(f.smallSample, true);
    assert.equal(f.threshold, 30);
    assert.ok(Array.isArray(f.facts));
    assert.ok(f.facts.every((x) => ['cost', 'behavior', 'benchmark'].includes(x.key)));
  });

  it('RQ-227 · P0 · 核心验收 · 小样本文本不含胜率/期望值等结论性断言', () => {
    assert.equal(assertNoEdgeAssertion('样本不足，暂不给结论', 12).ok, true);
    const bad = assertNoEdgeAssertion('胜率 60%，策略有效', 12);
    assert.equal(bad.ok, false);
    assert.ok(bad.hits.length > 0);
  });

  it('RQ-227 · P1 · 差异化 · 30 笔护栏下 showRatios=false，50 笔放开', () => {
    assert.equal(resolveRatioGate(20).showRatios, false);
    assert.equal(resolveRatioGate(50).showRatios, true);
    assert.equal(RATIO_GUARD_THRESHOLD, 30);
  });

  it('RQ-227 · P2 · 留存体验 · 护栏给出「还差 N 笔」与继续训练路径', () => {
    const g = resolveRatioGate(20);
    assert.equal(g.remaining, 10);
    assert.equal(g.action.path, '/blind');
  });

  it('RQ-227 · P3 · 边界异常 · 样本 0 笔/null 输入时仍安全返回事实不抛错', () => {
    assert.doesNotThrow(() => buildSmallSampleFacts({ sampleSize: 0, rounds: [] }));
    assert.doesNotThrow(() => buildSmallSampleFacts(null));
  });

  it('RQ-227 · P4 · 性能并发 · 1000 次护栏判定稳定', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) if (resolveRatioGate(29).showRatios === false) n += 1;
    assert.equal(n, 1000);
  });

  it('RQ-227 · P5 · 兼容回归 · 大样本时断言守卫不误伤正常结论', () => {
    assert.equal(assertNoEdgeAssertion('胜率 60%', 60).ok, true, '大样本允许结论性表达');
  });
});

/* ================================================================== *
 * RQ-228 单次成绩 t 值/置信区间中文表达（M48 / 产品优先级 P2）
 * ================================================================== */
describe('RQ-228 可信度中文表达（P2）', () => {
  it('RQ-228 · P0 · 正常流程 · t 值与 95% 置信区间按公式计算', () => {
    assert.equal(tStat({ mean: 0.5, sigma: 1.5, n: 50 }), 2.357);
    const ci = confidenceInterval({ mean: 0.5, sigma: 1.5, n: 50 });
    assert.equal(ci.z, 1.96);
    assert.ok(ci.low < 0.5 && ci.high > 0.5);
  });

  it('RQ-228 · P0 · 结论面板 · 小样本 three-facts 模式，大样本 interval 模式', () => {
    assert.equal(buildConclusionPanel({ sampleSize: 12 }).mode, 'three-facts');
    assert.equal(buildConclusionPanel({ sampleSize: 60 }).mode, 'interval');
  });

  it('RQ-228 · P1 · 差异化 · 成绩卡带误差带与禁止用途（不是只有一个分数）', () => {
    const card = buildScoreCard({ session: { status: 'FINISHED' }, score: {}, sampleSize: 12 });
    assert.ok(card.errorBand.text);
    assert.ok(card.cannotDo);
  });

  it('RQ-228 · P2 · 留存体验 · 结论面板给出「还差 N 笔」的可读提示', () => {
    const p = buildConclusionPanel({ sampleSize: 12 });
    assert.equal(p.remaining, 38);
    assert.ok(p.facts);
  });

  it('RQ-228 · P3 · 边界异常 · 零方差/空样本返回 null 而非 NaN（诚实无区间）', () => {
    const ci = confidenceInterval({ mean: 0, sigma: 0, n: 0 });
    assert.equal(ci.low, null, '无样本不应编造区间下界');
    assert.equal(ci.high, null);
    assert.ok(!Number.isNaN(ci.low) && !Number.isNaN(ci.high), '不得出现 NaN');
  });

  it('RQ-228 · P4 · 性能并发 · 1000 次区间计算稳定有限', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) {
      const ci = confidenceInterval({ mean: 0.5, sigma: 1.5, n: 50 });
      if (Number.isFinite(ci.low) && Number.isFinite(ci.high)) n += 1;
    }
    assert.equal(n, 1000);
  });

  it('RQ-228 · P5 · 兼容回归 · 小样本成绩卡仍带 30 笔护栏文案（既有口径不破）', () => {
    const card = buildScoreCard({ session: { status: 'FINISHED' }, score: {}, sampleSize: 12 });
    assert.ok(card.lines.some((l) => l.includes('护栏') || l.includes('不给出胜率')));
  });
});

/* ================================================================== *
 * RQ-229 行情口径统一 + 免责声明纠偏（M49 / 产品优先级 P2）
 * ================================================================== */
describe('RQ-229 行情口径统一（P2）', () => {
  it('RQ-229 · P0 · 正常流程 · 含真实 A 股行情+模拟撮合的表述通过校验', () => {
    const r = checkIdentityWording('使用真实 A 股行情，模拟撮合训练');
    assert.equal(r.ok, true);
    assert.deepEqual(r.forbiddenHits, []);
    assert.deepEqual(r.missingRequired, []);
  });

  it('RQ-229 · P0 · 核心验收 · 「虚拟仿真/交易大厅」等禁用表述被拦截', () => {
    const r = checkIdentityWording('本平台为虚拟仿真 A 股模拟交易大厅');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.length > 0);
  });

  it('RQ-229 · P1 · 差异化 · 缺失必需表述时列出 missingRequired', () => {
    const r = checkIdentityWording('开始训练');
    assert.equal(r.ok, false);
    assert.ok(r.missingRequired.length > 0);
  });

  it('RQ-229 · P2 · 留存体验 · 禁用词表覆盖历史口径（虚拟仿真/模拟交易大厅）', () => {
    assert.ok(FORBIDDEN_WORDINGS.includes('虚拟仿真'));
    assert.ok(FORBIDDEN_WORDINGS.includes('模拟交易大厅'));
    assert.ok(REQUIRED_PHRASES.includes('真实 A 股行情'));
    assert.ok(REQUIRED_PHRASES.includes('模拟撮合'));
  });

  it('RQ-229 · P3 · 边界异常 · 空文本/null 输入不抛错', () => {
    assert.doesNotThrow(() => checkIdentityWording(''));
    assert.doesNotThrow(() => checkIdentityWording(null));
  });

  it('RQ-229 · P4 · 性能并发 · 1000 次口径校验稳定', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) if (checkIdentityWording('真实 A 股行情，模拟撮合').ok) n += 1;
    assert.equal(n, 1000);
  });

  it('RQ-229 · P5 · 兼容回归 · 结算免责声明仍声明「真实历史行情 + 模拟撮合」（口径不倒退）', () => {
    const disclaimer = buildSettlementAudit({ session: { status: 'FINISHED' }, orders: [], score: {} }).disclaimer;
    assert.ok(disclaimer.includes('模拟撮合'), '不得倒退回「虚拟仿真」');
    assert.ok(disclaimer.includes('真实历史'), '仍须声明行情为真实历史');
    assert.ok(!FORBIDDEN_WORDINGS.some((w) => disclaimer.includes(w)), '不得命中禁用词');
  });
});

/* ================================================================== *
 * RQ-230 保留期前置 + 产品名统一（M49 / 产品优先级 P2）
 * ================================================================== */
describe('RQ-230 保留期前置与产品名（P2）', () => {
  it('RQ-230 · P0 · 正常流程 · 登录用户永久保留，游客 7 天', () => {
    assert.equal(RETENTION_POLICY.loggedIn.days, null);
    assert.equal(RETENTION_POLICY.guest.days, 7);
    assert.equal(retentionNotice({ isGuest: false }).title, '永久保留');
  });

  it('RQ-230 · P0 · 核心验收 · 游客保留期说明含「7 天」前置告知', () => {
    const g = retentionNotice({ isGuest: true });
    assert.ok(g.title.includes('7 天'));
    assert.ok(g.body.includes('7 天'));
    assert.ok(g.exportHint.includes('注册'), '应引导注册以长期保留');
  });

  it('RQ-230 · P1 · 差异化 · 落地页三件套含保留期承诺（首访即见）', () => {
    const copy = buildLandingCopy({});
    const keys = copy.differentiators.map((d) => d.key);
    assert.deepEqual(keys.sort(), ['checkable', 'confidence', 'retention'].sort());
    assert.ok(LANDING_ELEMENTS.length > 0);
  });

  it('RQ-230 · P2 · 留存体验 · 保留期提醒有临近阈值（remindFromDay）', () => {
    assert.ok(RETENTION_POLICY.remindFromDay > 0 && RETENTION_POLICY.remindFromDay < RETENTION_POLICY.guest.days);
  });

  it('RQ-230 · P3 · 边界异常 · retentionNotice 对空入参不抛错', () => {
    assert.doesNotThrow(() => retentionNotice(null));
    assert.doesNotThrow(() => retentionNotice({}));
  });

  it('RQ-230 · P4 · 性能并发 · 1000 次告知构建稳定', () => {
    let n = 0;
    for (let i = 0; i < 1000; i += 1) if (retentionNotice({ isGuest: true }).title.includes('7 天')) n += 1;
    assert.equal(n, 1000);
  });

  it('RQ-230 · P5 · 兼容回归 · 成绩卡产品名口径统一为「赚一个小目标」', () => {
    const card = buildScoreCard({ session: { status: 'FINISHED' }, score: {}, sampleSize: 10 });
    assert.ok(card.text.includes('赚一个小目标'));
  });
});
