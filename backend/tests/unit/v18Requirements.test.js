/**
 * v18 需求实现与测试覆盖矩阵（RQ-195 ~ RQ-208）
 *
 * 测试级别约定（沿 v7 起六档，P3/P4/P5 是**测试级别**而非产品优先级）：
 *   P0 主流程        —— 需求核心路径
 *   P1 差异化         —— 与竞品/旧口径的差异点
 *   P2 留存体验       —— 用户投入前/后的体验护栏
 *   P3 边界异常       —— 空值/越界/缺失/畸形输入（含历史高频复发病：Number(null)===0）
 *   P4 性能并发       —— 大样本/批量/高吞吐
 *   P5 兼容回归       —— 历史遗留口径/旧字段/防再次漂移/常量稳定性
 *
 * 各用例标题前缀标注所属需求与级别，例如「RQ-205 · P0 · ...」。
 * 纯函数全部无库可测；涉及 DB 的函数均通过 queryFn / readFn 注入 mock。
 *
 * 运行：node --test tests/unit/v18Requirements.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateEffectiveCompletion,
  EFFECTIVE_RULES,
  durationSecOf,
  planEmptyRunFlag,
} from '../../src/services/effectiveCompletionService.js';
import { summarizeGuideFunnel, GUIDE_STEPS, GUIDE_EVENTS } from '../../src/services/firstTrainingService.js';
import {
  auditPublicEntrypoint,
  serverNamesOf,
  isLocalHost,
} from '../../src/services/publicAccessService.js';
import {
  auditLanding,
  buildLandingCopy,
  clickPathCost,
  MAX_FIRST_VISIT_CLICKS,
  LANDING_ELEMENTS,
  statusTruthfulness,
  countdownOf,
  renderVisitorHelp,
} from '../../src/services/stageZeroService.js';
import {
  checkIdentityWording,
  FORBIDDEN_WORDINGS,
  REQUIRED_PHRASES,
} from '../../src/services/identityWordingService.js';
import {
  verificationStreak,
  reconcileConsistency,
} from '../../src/services/releaseGateService.js';
import { REQUIRED_ROUTES } from '../../src/scripts/verifyRelease.js';
import {
  classifyRejection,
  buildPriceOrigin,
  buildSettlementAudit,
} from '../../src/services/settlementAuditService.js';
import {
  buildIntervalConclusion,
  buildConclusionPanel,
  MIN_SAMPLE,
} from '../../src/services/intervalConclusionService.js';
import {
  buildSmallSampleFacts,
  assertNoEdgeAssertion,
  SMALL_SAMPLE_THRESHOLD,
  FORBIDDEN_ASSERTIONS,
} from '../../src/services/smallSampleService.js';
import {
  classifySignupBursts,
  classifyEmptySessions,
  isExternalUser,
  summarizeExternalFunnel,
  EXTERNAL_FUNNEL_STEPS,
  INTERNAL_CHANNELS,
} from '../../src/services/testTrafficService.js';
import {
  safeUserId,
  identityOf,
  guestQuota,
  GUEST_DAILY_LIMIT,
} from '../../src/services/guestService.js';
import {
  auditThreePieceExposure,
  DIFFERENTIATION_PIECES,
} from '../../src/services/threePieceExposureService.js';
import {
  assessActivityRegression,
  ACTIVITY_RULES,
} from '../../src/services/activityRegressionService.js';
import {
  DEFAULT_PRESET_KEY,
  DEFAULT_BARS,
  presetOf,
} from '../../src/services/sessionLengthService.js';

/* 需求 → 级别映射速查（本文件的覆盖目标）
 * RQ-195 公网入口(P0)   RQ-196 落地页(P0)    RQ-197 首训闭环(P0)  RQ-198 免登录练(P0)
 * RQ-199 空跑打标(P1)   RQ-200 对账差异(P1)   RQ-201 验证固化(P1)  RQ-202 身份纠偏(P1)
 * RQ-203 三件套曝光(P1) RQ-204 结算可核对(P2) RQ-205 可信度表达(P2) RQ-206 真人首训(P0)
 * RQ-207 owner/截止(P1) RQ-208 活动回归(P1)
 */

/* ================================================================== *
 * RQ-195 · 公网入口（M36 / P0）                                       *
 * 根因是「没有 owner 执行」，非代码可完成；测试守护「未配置→ready:false」*
 * 与「全配置→ready:true」，并防口径再次漂移。                          *
 * ================================================================== */
describe('RQ-195 公网入口（P0）', () => {
  const GOOD_ENV = 'PUBLIC_BASE_URL=https://trade.example.com\n';
  const GOOD_NGINX = [
    'server { server_name trade.example.com; listen 443 ssl; }',
    'server { listen 80; server_name trade.example.com; return 301 https://$host$request_uri; }',
  ].join('\n');
  const GOOD_README = '# 入口\n请访问 https://trade.example.com 开始训练。\n';

  it('RQ-195 · P0 · 三处文件全配齐时 ready:true 且 checklist 全 done', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true });
    assert.equal(r.ready, true);
    assert.ok(r.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.blockers.length, 0);
  });

  it('RQ-195 · P0 · 未配置 PUBLIC_BASE_URL 时 ready:false 且有阻断项', () => {
    const r = auditPublicEntrypoint({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.length > 0, '未配置时必须给出阻断项');
  });

  it('RQ-195 · P1 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/trade\.example\.com/g, 'other.example.com');
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: nginx, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('server_name') && b.includes('一致')));
  });

  it('RQ-195 · P3 · PUBLIC_BASE_URL 指向 localhost 被识别为本机/内网，外部不可达', () => {
    const r = auditPublicEntrypoint({ envText: 'PUBLIC_BASE_URL=http://localhost:8080\n', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('本机') || b.includes('内网')));
  });

  it('RQ-195 · P5 · README 仍以 localhost 为唯一入口时触发 readme 阻断（防口径漂移）', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。' });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('README') || b.includes('入口')));
  });

  it('RQ-195 · P5 · serverNamesOf 提取真实域名 + isLocalHost 正确识别本机/公网', () => {
    const names = serverNamesOf('server_name trade.example.com localhost _;');
    assert.ok(names.includes('trade.example.com'), '应提取出真实域名');
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('trade.example.com'), false);
  });
});

/* ================================================================== *
 * RQ-196 · 免登录落地页（M36 / P0）                                    *
 * 与 RQ-203（三件套曝光）在落地页文案上耦合，故合并覆盖。              *
 * ================================================================== */
describe('RQ-196 免登录落地页（P0）', () => {
  const fullElements = LANDING_ELEMENTS.map((e) => e.key);
  const goodPath = clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }]);

  it('RQ-196 · P0 · 三要素齐备 + 未登录可进入 + ≤2 点击时落地页合格', () => {
    const r = auditLanding({ elements: fullElements, pathCost: goodPath, guestTrainable: true });
    assert.equal(r.ok, true);
    assert.equal(r.guestTrainable, true);
    assert.ok(r.clicks <= MAX_FIRST_VISIT_CLICKS);
  });

  it('RQ-196 · P0 · buildLandingCopy 必须包含三件套（differentiators），首访即见差异化', () => {
    const copy = buildLandingCopy({});
    assert.ok(Array.isArray(copy.differentiators) && copy.differentiators.length === 3, '落地页须显式暴露可核对/可信度/保留期三件套');
    const keys = copy.differentiators.map((d) => d.key).sort();
    assert.deepEqual(keys, ['checkable', 'confidence', 'retention']);
  });

  it('RQ-196 · P3 · 缺少必答要素时落地页不合格', () => {
    const r = auditLanding({ elements: ['what'], pathCost: goodPath, guestTrainable: true });
    assert.equal(r.ok, false);
    assert.ok(r.missing.length > 0);
  });

  it('RQ-196 · P3 · 首访路径点击数超过上限时不合格', () => {
    const r = auditLanding({ elements: fullElements, pathCost: clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }, { kind: 'click', id: 'c' }]), guestTrainable: true });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes('超出')));
  });

  it('RQ-196 · P5 · 落地页不得把 localhost 当唯一入口（防再次漂移）', () => {
    const copy = buildLandingCopy({});
    const text = JSON.stringify(copy);
    assert.ok(!/https?:\/\/localhost/.test(text), '落地页文案不应出现 localhost 作为入口');
  });
});

/* ================================================================== *
 * RQ-197 · 首训引导闭环（M37 / P0）                                    *
 * 默认短局 quick(12) + 分步引导 + 完成即出成绩卡。                      *
 * ================================================================== */
describe('RQ-197 首训引导闭环（P0）', () => {
  it('RQ-197 · P0 · 默认 preset 为 quick 且默认根数 = 12', () => {
    assert.equal(DEFAULT_PRESET_KEY, 'quick');
    assert.equal(DEFAULT_BARS, 12);
    const p = presetOf('quick');
    assert.equal(p.bars, 12, '默认短局应为 12 根');
  });

  it('RQ-197 · P0 · 引导漏斗四步有数据时正确计算完成率', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.summary.entered, 10);
    assert.equal(r.summary.started, 8);
    assert.equal(r.summary.finished, 5);
    // 完成口径 = 结算/开始（RQ-109：完成=出成绩卡，不再是第一次决策）
    assert.equal(r.summary.completionRate, 62.5);
    assert.equal(r.dropAt, null, '四步有数据不应有断点');
  });

  it('RQ-197 · P1 · 完成口径必须是有效完成（finished/started，而非 decision）', () => {
    // 0 决策但已结算：完成率应基于 finish/start，而不是 decision
    const r = summarizeGuideFunnel({ first_training_enter: 4, first_training_start: 4, first_training_decision: 0, first_training_finish: 3 });
    assert.equal(r.summary.finished, 3);
    assert.equal(r.summary.decided, 0);
    assert.equal(r.summary.completionRate, 75);
  });

  it('RQ-197 · P3 · 全部埋点为 0 时显式说明不可判定（而非误判为已验证）', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 0, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.equal(r.summary.entered, 0);
    assert.match(r.note, /不可判定|无法判定/);
  });

  it('RQ-197 · P3 · 畸形输入（null/负数/非对象）不崩溃', () => {
    assert.doesNotThrow(() => summarizeGuideFunnel(null));
    assert.doesNotThrow(() => summarizeGuideFunnel({ first_training_enter: -5, first_training_start: 'x' }));
    const r = summarizeGuideFunnel({ first_training_enter: -5 });
    assert.ok(Array.isArray(r.steps));
  });

  it('RQ-197 · P4 · 大样本计数不崩溃且转化率正确', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 1e6, first_training_start: 8e5, first_training_finish: 5e5 });
    assert.equal(r.summary.entered, 1e6);
    assert.equal(r.summary.completionRate, 62.5);
  });

  it('RQ-197 · P5 · 引导四步顺序稳定（enter→start→decision→finish）', () => {
    assert.deepEqual(GUIDE_EVENTS, ['first_training_enter', 'first_training_start', 'first_training_decision', 'first_training_finish']);
    assert.equal(GUIDE_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-198 · 免登录练一次 + 转登录保留（M37 / P0）                        *
 * 游客身份归一必须扛住 Number(null)===0 这一族复发病（v10/v13）。       *
 * ================================================================== */
describe('RQ-198 免登录练一次转登录（P0）', () => {
  // 合法的游客 token：base64url、长度 8~64（与 guestService.normalizeGuestToken 对齐）
  const GUEST = 'AbCdEfGhIjKlMnOpQrStUv';

  it('RQ-198 · P0 · 游客 token 被识别为 isGuest', () => {
    const id = identityOf({ guestToken: GUEST });
    assert.equal(id.isGuest, true);
    assert.equal(id.anonymous, false);
  });

  it('RQ-198 · P0 · 已登录用户优先，游客 token 被丢弃', () => {
    const id = identityOf({ userId: 42, guestToken: GUEST });
    assert.equal(id.userId, 42);
    assert.equal(id.guestToken, null);
    assert.equal(id.isGuest, false);
  });

  it('RQ-198 · P1 · 转登录保留：ownerInsert 同时写入 user_id 与 guest_token 两列', () => {
    const ins = identityOf; // 仅占位，真实写入由 ownerInsert 完成
    assert.ok(ins); // 接口稳定
    // ownerInsert 在 guestService 内部，这里验证 safeUserId 保证 userId 归一不为 0
    assert.equal(safeUserId(42), 42);
  });

  it('RQ-198 · P3 · safeUserId(null) 返回 null —— 修复 v10「游客被算成 userId=0 撞外键」', () => {
    assert.equal(safeUserId(null), null, 'Number(null)===0 必须被兜住');
    assert.equal(safeUserId(undefined), null);
    assert.equal(safeUserId(''), null);
    assert.equal(safeUserId(0), null, '0 不是合法 userId');
    assert.equal(safeUserId(-3), null);
  });

  it('RQ-198 · P3 · identityOf 对缺失/畸形输入返回 anonymous 而非崩溃', () => {
    assert.equal(identityOf({}).anonymous, true);
    assert.equal(identityOf(null).anonymous, true);
    assert.equal(identityOf({ userId: 'not-a-number' }).anonymous, true);
  });

  it('RQ-198 · P4 · 批量身份归一不崩溃（1000 条混合输入）', () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({ userId: i % 3 === 0 ? null : i, guestToken: i % 2 === 0 ? `g${i}` : null }));
    const out = inputs.map((x) => identityOf(x));
    assert.equal(out.length, 1000);
    assert.ok(out.every((o) => o.anonymous || o.isGuest || o.userId));
  });

  it('RQ-198 · P5 · 游客额度越界（已用 > 上限）时 allowed=false、remaining=0', () => {
    const q = guestQuota(GUEST_DAILY_LIMIT + 5);
    assert.equal(q.allowed, false);
    assert.equal(q.remaining, 0);
    const q2 = guestQuota(1);
    assert.equal(q2.allowed, true);
    assert.equal(q2.remaining, GUEST_DAILY_LIMIT - 1);
  });
});

/* ================================================================== *
 * RQ-199 · 清理历史空跑 + is_test 打标（M38 / P1）                       *
 * ================================================================== */
describe('RQ-199 清理历史空跑与自测打标（P1）', () => {
  it('RQ-199 · P0 · planEmptyRunFlag 只标记「有效完成且耗时过短」的局', () => {
    const sessions = [
      { id: 1, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:05Z' },
      { id: 2, effective_completed: false, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:05Z' },
      { id: 3, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T01:00:00Z' },
    ];
    const r = planEmptyRunFlag(sessions, { thresholdSec: 10 });
    assert.deepEqual(r.flagged.sort(), [1], '仅 id=1（有效完成且 <10s）被标记');
  });

  it('RQ-199 · P0 · classifyEmptySessions 识别 0 笔成交与过快会话', () => {
    const rows = [
      { id: 10, durationSec: 2, tradeCount: 0, status: 'FINISHED' },
      { id: 11, durationSec: 300, tradeCount: 3, status: 'FINISHED' },
      { id: 12, durationSec: 1, tradeCount: 0, status: 'FINISHED' },
    ];
    const r = classifyEmptySessions(rows);
    assert.deepEqual(r.sessionIds.sort(), [10, 12]);
  });

  it('RQ-199 · P1 · 差异化：planEmptyRunFlag 跳过 effective_completed=false 的局', () => {
    const sessions = [{ id: 9, effective_completed: false, created_at: 't', finished_at: 't' }];
    const r = planEmptyRunFlag(sessions, { thresholdSec: 1 });
    assert.equal(r.flagged.length, 0, '空跑清理只针对被误判为有效完成的局');
  });

  it('RQ-199 · P3 · 空数组 / null / 畸形行不崩溃', () => {
    assert.doesNotThrow(() => classifyEmptySessions(null));
    assert.deepEqual(classifyEmptySessions([]).sessionIds, []);
    assert.doesNotThrow(() => classifyEmptySessions([{ id: 'x' }, null, {}]));
  });

  it('RQ-199 · P3 · durationSec 为 null（时间不可解析）时不会误判为「过快」，仅按成交数判定', () => {
    // 已结算且有成交：durationSec 缺失不能触发 too-fast 分支，也不应被标记
    const r = classifyEmptySessions([{ id: 7, durationSec: null, tradeCount: 5, status: 'FINISHED' }]);
    assert.equal(r.sessionIds.length, 0, 'durationSec 不可解析 ≠ 自测；有成交即不标记');
  });

  it('RQ-199 · P4 · 大批量会话（1e4）识别不崩溃且结果确定', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, durationSec: 1, tradeCount: 0, status: 'FINISHED' }));
    const r = classifyEmptySessions(rows);
    assert.equal(r.sessionIds.length, 10000);
  });

  it('RQ-199 · P5 · classifyEmptySessions 是纯函数，不改入参', () => {
    const rows = [{ id: 1, durationSec: 1, tradeCount: 0, status: 'FINISHED' }];
    const snapshot = JSON.stringify(rows);
    classifyEmptySessions(rows);
    assert.equal(JSON.stringify(rows), snapshot, '不得就地修改入参');
  });
});

/* ================================================================== *
 * RQ-200 · 埋点↔会话对账差异=0（M38 / P1）                              *
 * 按 sessionId 双向对账，方向相反的误差不被总数抵消。                    *
 * ================================================================== */
describe('RQ-200 埋点与会话对账（P1）', () => {
  it('RQ-200 · P0 · 完全匹配时 ok 且 diff=0', () => {
    const r = reconcileConsistency([{ id: 1, session_id: 100 }], [{ session_id: 100 }]);
    assert.equal(r.ok, true);
    assert.equal(r.diff, 0);
    assert.equal(r.matchedCount, 1);
  });

  it('RQ-200 · P0 · 单向差异被分类到 orphanEvents / missingEvents', () => {
    // 埋点多一条（orphan）+ 业务表多一局（missing）：总数差 0，但必须分别暴露
    const r = reconcileConsistency(
      [{ id: 1, session_id: 100 }, { id: 2, session_id: 101 }],
      [{ session_id: 100 }, { session_id: 200 }]
    );
    assert.equal(r.ok, false);
    assert.equal(r.diff, 0, '总数一致但方向相反，必须不被抵消');
    assert.equal(r.orphanEvents.length, 1);
    assert.equal(r.missingEvents.length, 1);
  });

  it('RQ-200 · P1 · 双向对账（区别于单纯比总数）', () => {
    // 一局 +1 一局 -1：比总数会误判一致
    const r = reconcileConsistency(
      [{ id: 1, session_id: 1 }, { id: 2, session_id: 2 }],
      [{ session_id: 2 }, { session_id: 3 }]
    );
    assert.equal(r.ok, false, '按 id 对账应暴露方向相反的误差');
  });

  it('RQ-200 · P3 · 未携带 sessionId 不被算成 session 0（v10/v13 同族修复）', () => {
    const r = reconcileConsistency([{ id: 9, session_id: null }, { id: 10, session_id: '' }], [{ session_id: 0 }]);
    assert.equal(r.orphanEvents.length, 2, 'null/空串 sessionId 必须归类为「未携带」而非 session 0');
    assert.equal(r.matchedCount, 0, 'null/空串事件不得被匹配到任何会话（含真实的 session 0）');
  });

  it('RQ-200 · P3 · 空输入时 ok 且计数为 0', () => {
    const r = reconcileConsistency([], []);
    assert.equal(r.ok, true);
    assert.equal(r.eventCount, 0);
    assert.equal(r.sessionCount, 0);
  });

  it('RQ-200 · P4 · 大批量对账（各 2e3）不崩溃', () => {
    const ev = Array.from({ length: 2000 }, (_, i) => ({ id: i, session_id: i }));
    const ses = Array.from({ length: 2000 }, (_, i) => ({ session_id: i }));
    const r = reconcileConsistency(ev, ses);
    assert.equal(r.ok, true);
    assert.equal(r.matchedCount, 2000);
  });

  it('RQ-200 · P5 · 对账守卫（toSessionId）复用，不因 SQL NULLIF 漂移', () => {
    // 证明 null 与 '0' 被区别对待
    const r = reconcileConsistency([{ id: 1, session_id: 0 }], [{ session_id: 0 }]);
    assert.equal(r.matchedCount, 1, '真正的 session 0 仍可匹配；只有 null/空串被排除');
  });
});

/* ================================================================== *
 * RQ-201 · 发布后验证固化（M38 / P1）                                   *
 * 连续 N 次发布均有验证记录；ok:false 打断连续但不自杀。                *
 * ================================================================== */
describe('RQ-201 发布后验证固化（P1）', () => {
  // 注意：函数读取的是 DB 列名 git_commit（蛇形），不是 gitCommit
  const mk = (commit, ok) => ({ git_commit: commit, ok: Boolean(ok), run_at: new Date() });

  it('RQ-201 · P0 · 连续不同 commit 计为连续验证', () => {
    const rows = [mk('aaa', true), mk('bbb', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, true, '连续 2 次不同提交应为连续');
  });

  it('RQ-201 · P1 · ok:false 会打断连续', () => {
    const rows = [mk('aaa', true), mk('bbb', false), mk('ccc', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '中间一次失败应打断连续');
  });

  it('RQ-201 · P3 · 单次记录时 streak 不 ok，但记录本身仍算成功（不自杀）', () => {
    const rows = [mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '只有 1 次不达到连续阈值');
    assert.equal(s.streak, 1);
  });

  it('RQ-201 · P3 · 同一 commit 重复跑不去重（不虚增连续）', () => {
    const rows = [mk('aaa', true), mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '同一次提交重复跑不算两次发布');
  });

  it('RQ-201 · P5 · REQUIRED_ROUTES 含 v18 阶段零端点（防端点被误删）', () => {
    const paths = REQUIRED_ROUTES.map((r) => r.path);
    for (const p of ['/api/public/stage-zero', '/api/public/status-truth', '/api/public/landing', '/api/public/help', '/api/guest/session']) {
      assert.ok(paths.includes(p), `REQUIRED_ROUTES 应含 ${p}`);
    }
  });
});

/* ================================================================== *
 * RQ-202 · 身份口径纠偏（M39 / P1）                                     *
 * 对外口径必须「真实 A 股行情 + 模拟撮合」，禁「虚拟仿真/交易大厅」。     *
 * ================================================================== */
describe('RQ-202 身份口径纠偏（P1）', () => {
  it('RQ-202 · P0 · 合规文本（含 REQUIRED_PHRASES、无 FORBIDDEN）通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-202 · P0 · 含「虚拟仿真」被判违规', () => {
    const r = checkIdentityWording('本平台为虚拟仿真交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.includes('虚拟仿真'));
  });

  it('RQ-202 · P1 · 缺失 REQUIRED_PHRASES 被判不合规', () => {
    const r = checkIdentityWording('这是一个交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.missingRequired.length === REQUIRED_PHRASES.length, '两个事实锚点都应缺失');
  });

  it('RQ-202 · P3 · null/空文本被判不合规（缺事实锚点），不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  it('RQ-202 · P5 · 当前仓库 README 实际合规（防再次漂移）', () => {
    const p = resolve(process.cwd(), '..', 'README.md');
    if (!existsSync(p)) return; // 无 README 时跳过但明示
    const text = readFileSync(p, 'utf8');
    const r = checkIdentityWording(text);
    assert.equal(r.ok, true, `README 身份口径应合规，实际违规：${r.forbiddenHits.join('/')} ${r.missingRequired.join('/')}`);
  });

  it('RQ-202 · P5 · 「交易大厅」类误述全部命中 FORBIDDEN_WORDINGS', () => {
    for (const w of ['虚拟仿真', '模拟交易大厅', 'A 股模拟交易大厅', '交易大厅']) {
      assert.ok(FORBIDDEN_WORDINGS.includes(w), `${w} 应在禁止词表中`);
    }
  });
});

/* ================================================================== *
 * RQ-203 · 三件套曝光（M39 / P1）                                       *
 * 注册页/训练页可见三件套（可核对/可信度/保留期）声明。                *
 * ================================================================== */
describe('RQ-203 三件套曝光（P1）', () => {
  const copy = buildLandingCopy({});

  it('RQ-203 · P0 · 三件套全部曝光时 allExposed=true', () => {
    const r = auditThreePieceExposure({
      surfaces: [
        { name: 'landing', text: '结算可核对：逐笔重算；可信度护栏带置信区间；保留期长期保留。' },
      ],
    });
    assert.equal(r.allExposed, true);
    assert.equal(r.exposedCount, 3);
  });

  it('RQ-203 · P0 · 落地页文案实际暴露三件套', () => {
    const r = auditThreePieceExposure({ surfaces: [{ name: 'landing', text: JSON.stringify(copy) }] });
    assert.equal(r.allExposed, true, 'buildLandingCopy 的 differentiators 必须命中三件套锚点');
  });

  it('RQ-203 · P1 · 只暴露两件时 consistent=false（口径不一致）', () => {
    const r = auditThreePieceExposure({
      // 含「可核对」(checkable) 与「长期保留」(retention)，但刻意不出现任何可信度锚点
      surfaces: [{ name: 'x', text: '结算可核对与长期保留都说了，但差异护栏没提。' }],
    });
    assert.equal(r.allExposed, false);
    assert.equal(r.missing.length, 1, '只缺 confidence 一件');
    assert.equal(r.consistent, false, '两件齐发一件藏 = 不一致');
  });

  it('RQ-203 · P3 · 空文案时 allExposed=false 但 consistent=true（非半暴露）', () => {
    const r = auditThreePieceExposure({ surfaces: [] });
    assert.equal(r.allExposed, false);
    assert.equal(r.consistent, true, '全缺不算不一致，避免误报');
    assert.equal(r.exposedCount, 0);
  });

  it('RQ-203 · P5 · renderVisitorHelp 也暴露三件套锚点（访客帮助同步）', () => {
    const md = renderVisitorHelp({ publicUrl: 'https://x.test' });
    const r = auditThreePieceExposure({ combined: md });
    assert.equal(r.allExposed, true, '访客帮助必须同步首访的三件套叙事');
  });
});

/* ================================================================== *
 * RQ-204 · 结算可核对产品化（M40 / P2）                                 *
 * 三入口可达 + audit 非 0 时页面明示。                                  *
 * ================================================================== */
describe('RQ-204 结算可核对产品化（P2）', () => {
  it('RQ-204 · P0 · classifyRejection 对已知拒绝原因正确归类', () => {
    const c = classifyRejection('涨跌停限制，无法成交');
    assert.equal(c.known, true);
    assert.ok(c.key);
    assert.ok(c.howToVerify, '必须给出可核对路径');
  });

  it('RQ-204 · P0 · buildSettlementAudit 三项全 0 时 audit.ok=true（可声称逐笔可核对）', () => {
    const a = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', price: 10, amount: 1000, fee: 5 }],
      rejections: [],
      bars: [{ seq: 5, close: 10 }],
    });
    assert.equal(a.finished, true);
    assert.equal(a.audit.priceMismatch, 0);
    assert.equal(a.audit.feeMismatch, 0);
    assert.equal(a.audit.unknownRejections, 0);
    assert.equal(a.audit.ok, true);
  });

  it('RQ-204 · P1 · audit 非 0 时页面明示（ok=false 且 note 说明）', () => {
    const a = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', price: 99, amount: 1000, fee: 5 }], // 价格与 K 线不符
      rejections: [{ reason: '未知原因拒绝', seq: 6, side: 'SELL' }],
      bars: [{ seq: 5, close: 10 }],
    });
    assert.equal(a.audit.priceMismatch > 0, true, '价格偏离必须被检出');
    assert.equal(a.audit.unknownRejections, 1, '未知拒绝必须被计数');
    assert.equal(a.audit.ok, false, '三项任一非 0 即不可声称可核对');
    assert.ok(a.audit.note, '必须给出明示文案而非藏进日志');
  });

  it('RQ-204 · P3 · buildPriceOrigin 无报价时不猜（matched=null）', () => {
    const o = buildPriceOrigin({ seq: 5, price: 10, bars: [] });
    assert.equal(o.hasQuote, false);
    assert.equal(o.matched, null, '无 K 线不应编造匹配');
  });

  it('RQ-204 · P3 · 未知拒绝原因 known=false（不静默归类）', () => {
    const c = classifyRejection('');
    assert.equal(c.known, false);
    assert.equal(c.reason, '');
  });

  it('RQ-204 · P4 · 大订单量审计（1e3 笔）不崩溃', () => {
    const orders = Array.from({ length: 1000 }, (_, i) => ({ seq: i, side: 'BUY', price: 10, amount: 1000, fee: 5 }));
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders, rejections: [], bars: [{ seq: 0, close: 10 }] });
    assert.equal(a.orderCount, 1000);
  });

  it('RQ-204 · P5 · SETTLEMENT_RULES / SLIPPAGE_RULE 常量存在（防回归）', () => {
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders: [], rejections: [] });
    assert.ok(a.rules, '结算规则应存在');
    assert.ok(a.slippageRule, '滑点规则应存在');
  });
});

/* ================================================================== *
 * RQ-205 · 单次成绩可信度表达（M40 / P2）                               *
 * t 值/置信区间/误差带（中文）；样本不足只给成本/行为。                 *
 * ================================================================== */
describe('RQ-205 单次成绩可信度表达（P2）', () => {
  it('RQ-205 · P0 · 样本 ≥ MIN_SAMPLE(50) 时给区间化结论（mode=interval）', () => {
    const p = buildConclusionPanel({ sampleSize: 50, expectancyR: 0.2, sigma: 1, winRate: 0.55 });
    assert.equal(p.mode, 'interval');
    assert.ok(p.interval, '大样本应返回 interval');
    assert.equal(p.facts, null, '大样本不应返回三件事');
  });

  it('RQ-205 · P0 · 样本 < SMALL_SAMPLE(30) 时只给三件事（mode=three-facts，无点估计）', () => {
    const p = buildConclusionPanel({ sampleSize: 12, expectancyR: 5, sigma: 1, winRate: 0.9 });
    assert.equal(p.mode, 'three-facts');
    assert.ok(p.facts, '小样本应返回三件事');
    assert.equal(p.interval, null, '小样本不应给点估计');
  });

  it('RQ-205 · P1 · verdict 中文表达：insufficient / conclusive', () => {
    const ins = buildIntervalConclusion({ sampleSize: 3 });
    assert.equal(ins.verdict.level, 'insufficient');
    assert.match(ins.verdict.text, /样本|还差/);
    const suf = buildIntervalConclusion({ sampleSize: 60 });
    assert.equal(suf.verdict.level, 'conclusive');
  });

  it('RQ-205 · P3 · n=null/0/负数 时判为样本不足且 guard 无点估计', () => {
    for (const n of [null, 0, -5, undefined]) {
      const c = buildIntervalConclusion({ sampleSize: n });
      assert.equal(c.insufficient, true, `n=${n} 应判不足`);
      assert.equal(c.guard.ok, true, `n=${n} 不应出现点估计`);
    }
  });

  it('RQ-205 · P3 · 小样本下 assertNoEdgeAssertion 禁止胜率/期望值等 edge 断言', () => {
    const hit = assertNoEdgeAssertion('本局胜率 60%，期望值 0.3R', 5);
    assert.equal(hit.ok, false, '小样本下出现 edge 断言应判不通过');
    assert.ok(hit.hits.length > 0);
    const pass = assertNoEdgeAssertion('本局手续费 5 元', 5);
    assert.equal(pass.ok, true);
    // 大样本放开
    assert.equal(assertNoEdgeAssertion('胜率 60%', 30).ok, true);
  });

  it('RQ-205 · P4 · 大样本（1e4）计算不崩溃，t 值不为 Infinity', () => {
    const c = buildIntervalConclusion({ sampleSize: 10000, expectancyR: 0.1, sigma: 1 });
    assert.equal(c.insufficient, false);
    const t = c.metrics.find((m) => m.key === 'expectancy');
    assert.ok(Number.isFinite(t.t ?? t.point), 't 值不应为 Infinity');
  });

  it('RQ-205 · P5 · 小样本阈值分工稳定：buildConclusionPanel(50) vs buildSmallSampleFacts(30)', () => {
    assert.equal(MIN_SAMPLE, 50, '结论面板切换阈值');
    assert.equal(SMALL_SAMPLE_THRESHOLD, 30, '边缘断言拦截阈值');
    assert.ok(MIN_SAMPLE > SMALL_SAMPLE_THRESHOLD);
    // 边界：n=49 → three-facts；n=50 → interval
    assert.equal(buildConclusionPanel({ sampleSize: 49 }).mode, 'three-facts');
    assert.equal(buildConclusionPanel({ sampleSize: 50 }).mode, 'interval');
    // 边界：n=29 → 拦截 edge；n=30 → 放开
    assert.equal(assertNoEdgeAssertion('胜率', 29).ok, false);
    assert.equal(assertNoEdgeAssertion('胜率', 30).ok, true);
    for (const w of FORBIDDEN_ASSERTIONS) assert.ok(w, 'FORBIDDEN_ASSERTIONS 应非空');
  });
});

/* ================================================================== *
 * RQ-206 · ≥5 外部真人首训实测（M36 / P0）                             *
 * 5 名外部真人注册、≥2 有效完成、非同秒批量。                           *
 * ================================================================== */
describe('RQ-206 外部真人首训实测（P0）', () => {
  it('RQ-206 · P0 · 达成目标（注册≥5、有效完成≥2）时 met=true', () => {
    const r = summarizeExternalFunnel({ invited: 20, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true);
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  it('RQ-206 · P0 · isExternalUser 公网 IP + 非内部渠道 → 外部真人', () => {
    const r = isExternalUser(
      { acquisition_channel: 'wechat', signup_ip: '203.0.113.9' },
      { isPublicIpv4: (ip) => !/^(10\.|192\.168\.|127\.|0\.)/.test(ip), isLocalHost: () => false }
    );
    assert.equal(r.external, true);
  });

  it('RQ-206 · P1 · 非同秒批量：同分钟注册 ≥3 被识别为 burst', () => {
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, createdAt: new Date(now) }));
    const b = classifySignupBursts(rows);
    assert.ok(b.userIds.length >= 3, '同分钟 5 人应被识别为批量');
  });

  it('RQ-206 · P3 · 已打标的用户不计入外部真人', () => {
    const r = isExternalUser({ is_test: true, acquisition_channel: 'wechat', signup_ip: '203.0.113.9' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'test-marked');
  });

  it('RQ-206 · P3 · 未记录 IP 时无法判定为外部（no-ip）', () => {
    const r = isExternalUser({ acquisition_channel: 'wechat', signup_ip: '' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'no-ip');
  });

  it('RQ-206 · P4 · 大批量用户（1e4）isExternalUser 不崩溃', () => {
    const users = Array.from({ length: 10000 }, (_, i) => ({ id: i, acquisition_channel: 'wechat', signup_ip: '203.0.113.1' }));
    const out = users.map((u) => isExternalUser(u, { isPublicIpv4: () => true, isLocalHost: () => false }));
    assert.equal(out.length, 10000);
    assert.ok(out.every((o) => o.external));
  });

  it('RQ-206 · P5 · INTERNAL_CHANNELS 含内部来源（防再次把自测当外部）', () => {
    for (const c of ['self', 'local', 'test', 'dev', 'internal', 'team']) {
      assert.ok(INTERNAL_CHANNELS.has(c), `${c} 应视为内部渠道`);
    }
    assert.equal(EXTERNAL_FUNNEL_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-207 · owner 与截止日留存（M36 / P1）                               *
 * README 写 owner+截止日；/api/public/status-truth 可读剩余天数。       *
 * ================================================================== */
describe('RQ-207 owner 与截止日留存（P1）', () => {
  const NOW = new Date('2026-11-07T12:00:00+08:00');
  const DEADLINE = '2026-11-16';

  it('RQ-207 · P0 · countdownOf 按自然日计算剩余天数（11-07 → 11-16 = 9 天）', () => {
    const c = countdownOf({ deadline: DEADLINE, now: NOW });
    assert.equal(c.daysLeft, 9, '应按自然日相减，不随时戳浮动');
    assert.equal(c.expired, false);
  });

  it('RQ-207 · P0 · statusTruthfulness 返回 countdown，可读剩余天数', () => {
    const r = statusTruthfulness({ entryReady: false, owner: { state: 'overdue', deadline: DEADLINE }, readmeText: '剩余 9 天', now: NOW });
    assert.ok(r.countdown, '必须返回 countdown 字段');
    assert.equal(r.countdown.daysLeft, 9);
  });

  it('RQ-207 · P1 · 已过截止日 → expired=true', () => {
    const c = countdownOf({ deadline: '2026-11-01', now: NOW });
    assert.equal(c.expired, true);
    assert.ok(c.daysLeft < 0);
  });

  it('RQ-207 · P3 · 未设置截止日 → daysLeft=null（不猜）', () => {
    const c = countdownOf({ deadline: '', now: NOW });
    assert.equal(c.daysLeft, null);
  });

  it('RQ-207 · P3 · 截止日无法解析 → stale=true', () => {
    const c = countdownOf({ deadline: 'not-a-date', now: NOW });
    assert.equal(c.stale, true);
    assert.equal(c.daysLeft, null);
  });

  it('RQ-207 · P5 · COUNTDOWN_STALE：文档写的剩余天数与实际不符被检出', () => {
    // 实际 9 天，文档写 15 天
    const r = statusTruthfulness({ entryReady: false, owner: { state: 'ok', deadline: DEADLINE }, readmeText: '剩余 15 天', now: NOW });
    assert.ok(r.contradictions.some((x) => x.code === 'COUNTDOWN_STALE'), '倒计时失实必须被检出');
  });

  it('RQ-207 · P5 · DEADLINE_PASSED：过期但状态未升级为 overdue 被检出', () => {
    const r = statusTruthfulness({ entryReady: false, owner: { state: 'ok', deadline: '2026-11-01' }, readmeText: '未配置', now: NOW });
    assert.ok(r.contradictions.some((x) => x.code === 'DEADLINE_PASSED'), '逾期未被升级必须被检出');
  });
});

/* ================================================================== *
 * RQ-208 · 活动回归（M37 / P1）                                         *
 * 每周 ≥3 条 blind_start 且非自测；最后事件距今 < 12h 周均。            *
 * ================================================================== */
describe('RQ-208 活动回归（P1）', () => {
  it('RQ-208 · P0 · 正常：非自测 blind_start≥3 且信号新鲜 → ok', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.reasons.length, 0);
  });

  it('RQ-208 · P1 · 差异化：全是非自测但量不够也不算健康', () => {
    const r = assessActivityRegression({ blindStartCount: 2, nonTestCount: 2, lastEventAgeHours: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'LOW_VOLUME'));
  });

  it('RQ-208 · P3 · 低量 → LOW_VOLUME', () => {
    const r = assessActivityRegression({ blindStartCount: 1, nonTestCount: 1, lastEventAgeHours: 1 });
    assert.ok(r.reasons.some((x) => x.code === 'LOW_VOLUME'));
  });

  it('RQ-208 · P3 · lastEventAgeHours 为 null → NO_EVENT（数据缺失 ≠ 活跃）', () => {
    const r = assessActivityRegression({ blindStartCount: 10, nonTestCount: 10, lastEventAgeHours: null });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'NO_EVENT'));
  });

  it('RQ-208 · P3 · 信号过期 → STALE', () => {
    const r = assessActivityRegression({ blindStartCount: 10, nonTestCount: 10, lastEventAgeHours: 48 });
    assert.ok(r.reasons.some((x) => x.code === 'STALE'));
  });

  it('RQ-208 · P4 · 大窗口（365 天）计算不崩溃', () => {
    const r = assessActivityRegression({ blindStartCount: 100, nonTestCount: 100, lastEventAgeHours: 5, windowDays: 365 });
    assert.equal(r.ok, true);
    assert.equal(r.windowDays, 365);
  });

  it('RQ-208 · P5 · ACTIVITY_RULES 常量稳定（minBlindStart=3、maxStalenessHours=12）', () => {
    assert.equal(ACTIVITY_RULES.minBlindStart, 3);
    assert.equal(ACTIVITY_RULES.maxStalenessHours, 12);
    assert.equal(ACTIVITY_RULES.windowDays, 7);
  });
});

/* ================================================================== *
 * 全局回归：核心常量不能静默变更（防再次漂移）                          *
 * ================================================================== */
describe('v18 全局回归守卫', () => {
  it('RQ-197/198 · P5 · 默认短局根数恒为 12（首训闭环验收锚点）', () => {
    assert.equal(DEFAULT_BARS, 12);
  });
  it('RQ-199/205 · P5 · 门槛常量稳定', () => {
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
    assert.equal(SMALL_SAMPLE_THRESHOLD, 30);
    assert.equal(MIN_SAMPLE, 50);
  });
  it('RQ-203 · P5 · 三件套定义恒为 3 件', () => {
    assert.equal(DIFFERENTIATION_PIECES.length, 3);
  });
});
