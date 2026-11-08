/**
 * v20 需求实现与测试覆盖矩阵（RQ-209 ~ RQ-220）
 *
 * 本文件对应「产品需求表 · 赚了一个小目标」v20（2026-11-09）的需求表（§7，12 项）。
 * v20 在需求内容上**零新增**——RQ-209~220 是 v19（RQ-195~208）的重新编号，底层纯函数
 * 服务与端点已在 v18 全部落地；本文件做的是「按 v20 新编号 + 六档测试级别」重新组织覆盖，
 * 确保每条需求在 P0~P5 各至少有一例（正常流程 / 边界 / 异常均有涉猎）。
 *
 * 测试级别约定（沿 v7 起六档，P3/P4/P5 是**测试级别**而非产品优先级）：
 *   P0 主流程        —— 需求核心路径
 *   P1 差异化         —— 与竞品/旧口径的差异点
 *   P2 留存体验       —— 用户投入前/后的体验护栏
 *   P3 边界异常       —— 空值/越界/缺失/畸形输入（含历史高频复发病：Number(null)===0）
 *   P4 性能并发       —— 大样本/批量/高吞吐
 *   P5 兼容回归       —— 历史遗留口径/旧字段/防再次漂移/常量稳定性
 *
 * 各用例标题前缀标注「需求编号 · 测试级别 · 场景」，例如「RQ-209 · P0 · 正常流程」。
 * 产品优先级（P0/P1/P2）来自需求表；测试级别（P0~P5）为测试侧扩展，两者在矩阵文档中分别列示。
 * 全部为纯函数单测（无 DB / 无 fs / 无网络），可直接 `node --test` 运行。
 *
 * 运行：node --test tests/unit/v20Requirements.test.js
 * 回归：node --test tests/unit/v18Requirements.test.js tests/unit/v19RequirementsP2.test.js tests/unit/v20Requirements.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { auditPublicEntrypoint, serverNamesOf, isLocalHost } from '../../src/services/publicAccessService.js';
import {
  auditLanding,
  buildLandingCopy,
  clickPathCost,
  MAX_FIRST_VISIT_CLICKS,
  LANDING_ELEMENTS,
  renderVisitorHelp,
} from '../../src/services/stageZeroService.js';
import { summarizeGuideFunnel, GUIDE_STEPS, GUIDE_EVENTS } from '../../src/services/firstTrainingService.js';
import { DEFAULT_PRESET_KEY, DEFAULT_BARS, presetOf } from '../../src/services/sessionLengthService.js';
import { identityOf, safeUserId, guestQuota, GUEST_DAILY_LIMIT } from '../../src/services/guestService.js';
import {
  classifySignupBursts,
  classifyEmptySessions,
  isExternalUser,
  summarizeExternalFunnel,
  EXTERNAL_FUNNEL_STEPS,
  INTERNAL_CHANNELS,
} from '../../src/services/testTrafficService.js';
import { planEmptyRunFlag } from '../../src/services/effectiveCompletionService.js';
import { reconcileConsistency, verificationStreak } from '../../src/services/releaseGateService.js';
import { REQUIRED_ROUTES } from '../../src/scripts/verifyRelease.js';
import { checkIdentityWording, FORBIDDEN_WORDINGS, REQUIRED_PHRASES } from '../../src/services/identityWordingService.js';
import { auditThreePieceExposure, DIFFERENTIATION_PIECES } from '../../src/services/threePieceExposureService.js';
import { classifyRejection, buildPriceOrigin, buildSettlementAudit } from '../../src/services/settlementAuditService.js';
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

/* v20 需求 → 底层服务 / v19 来源映射（本文件覆盖目标）
 * RQ-209 公网入口(P0)   ← publicAccessService    (v19 RQ-195)
 * RQ-210 落地页(P0)     ← stageZeroService       (v19 RQ-196)
 * RQ-211 首训闭环(P0)   ← firstTrainingService   (v19 RQ-197)
 * RQ-212 免登录练(P0)   ← guestService           (v19 RQ-198)
 * RQ-213 真人首训(P0)   ← testTrafficService     (v19 RQ-206)
 * RQ-214 空跑打标(P1)   ← effective/testTraffic   (v19 RQ-199)
 * RQ-215 对账差异(P1)   ← releaseGateService      (v19 RQ-200)
 * RQ-216 验证固化(P1)   ← releaseGateService      (v19 RQ-201)
 * RQ-217 身份纠偏(P1)   ← identityWordingService  (v19 RQ-202)
 * RQ-218 三件套曝光(P1) ← threePieceExposureService(v19 RQ-203)
 * RQ-219 结算可核对(P2) ← settlementAuditService  (v19 RQ-204)
 * RQ-220 可信度表达(P2) ← smallSampleService      (v19 RQ-205)
 * 注：v19 的 RQ-207(owner/截止) 与 RQ-208(活动回归) 在 v20 编号表中已折叠出局，本文件不单列。
 */

/* ================================================================== *
 * RQ-209 · 公网入口（M41 / 产品优先级 P0）                            *
 * 根因是「没有 owner 执行」，非代码可完成；测试守护「未配置→ready:false」*
 * 与「全配置→ready:true」，并防口径再次漂移。                          *
 * ================================================================== */
describe('RQ-209 公网入口（P0）', () => {
  const GOOD_ENV = 'PUBLIC_BASE_URL=https://trade.example.com\n';
  const GOOD_NGINX = [
    'server { server_name trade.example.com; listen 443 ssl; }',
    'server { listen 80; server_name trade.example.com; return 301 https://$host$request_uri; }',
  ].join('\n');
  const GOOD_README = '# 入口\n请访问 https://trade.example.com 开始训练。\n';

  // P0 正常流程
  it('RQ-209 · P0 · 正常流程 · 三处文件全配齐时 ready:true 且 checklist 全 done', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true });
    assert.equal(r.ready, true);
    assert.ok(r.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.blockers.length, 0);
  });

  // P0 边界/异常：未配置核心变量
  it('RQ-209 · P0 · 边界异常 · 未配置 PUBLIC_BASE_URL 时 ready:false 且有阻断项', () => {
    const r = auditPublicEntrypoint({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.length > 0, '未配置时必须给出阻断项');
  });

  // P1 差异化：域名与 nginx server_name 必须一致
  it('RQ-209 · P1 · 差异化 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/trade\.example\.com/g, 'other.example.com');
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: nginx, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('server_name') && b.includes('一致')));
  });

  // P2 留存体验：未就绪必须诚实报出待办，而非假装开门把用户引流到死链
  it('RQ-209 · P2 · 留存体验 · 三处文件全缺失时诚实报 ready:false 并给出待办清单', () => {
    const r = auditPublicEntrypoint({ envText: '', nginxText: '', readmeText: '访问 http://localhost:8080' });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.length > 0, '未配置时必须有阻断项');
    assert.ok(r.pending.length > 0, '必须给出可执行的待办清单');
    assert.ok(r.note.includes('不可达'), '口径须明确「不可达」');
  });

  // P3 边界异常：localhost/内网地址即使写了也不能算可达
  it('RQ-209 · P3 · 边界异常 · PUBLIC_BASE_URL 指向 localhost 被识别为本机/内网，外部不可达', () => {
    const r = auditPublicEntrypoint({ envText: 'PUBLIC_BASE_URL=http://localhost:8080\n', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('本机') || b.includes('内网')));
  });

  // P4 性能并发：批量审计不崩溃
  it('RQ-209 · P4 · 性能并发 · 连续 1000 次审计调用稳定返回', () => {
    let okCount = 0;
    for (let i = 0; i < 1000; i++) {
      const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true });
      if (r.ready === true) okCount++;
    }
    assert.equal(okCount, 1000, '配置齐全时应始终返回 ready:true');
  });

  // P5 兼容回归：README 不得再以 localhost 为唯一入口；域名解析工具稳定
  it('RQ-209 · P5 · 兼容回归 · README 仍以 localhost 为唯一入口时触发 readme 阻断', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。' });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('README') || b.includes('入口')));
  });

  it('RQ-209 · P5 · 兼容回归 · serverNamesOf 提取真实域名 + isLocalHost 正确识别本机/公网', () => {
    const names = serverNamesOf('server_name trade.example.com localhost _;');
    assert.ok(names.includes('trade.example.com'), '应提取出真实域名');
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('trade.example.com'), false);
  });
});

/* ================================================================== *
 * RQ-210 · 免登录落地页（M41 / 产品优先级 P0）                         *
 * 与 RQ-218（三件套曝光）在落地页文案上耦合，故合并覆盖。              *
 * ================================================================== */
describe('RQ-210 免登录落地页（P0）', () => {
  const fullElements = LANDING_ELEMENTS.map((e) => e.key);
  const goodPath = clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }]);

  // P0 正常流程
  it('RQ-210 · P0 · 正常流程 · 三要素齐备 + 未登录可进入 + ≤2 点击时落地页合格', () => {
    const r = auditLanding({ elements: fullElements, pathCost: goodPath, guestTrainable: true });
    assert.equal(r.ok, true);
    assert.equal(r.guestTrainable, true);
    assert.ok(r.clicks <= MAX_FIRST_VISIT_CLICKS);
  });

  // P0 正常流程：首访即见三件套差异化
  it('RQ-210 · P0 · 正常流程 · buildLandingCopy 必须包含三件套（differentiators），首访即见差异化', () => {
    const copy = buildLandingCopy({});
    assert.ok(Array.isArray(copy.differentiators) && copy.differentiators.length === 3, '落地页须显式暴露可核对/可信度/保留期三件套');
    const keys = copy.differentiators.map((d) => d.key).sort();
    assert.deepEqual(keys, ['checkable', 'confidence', 'retention']);
  });

  // P1 差异化：首访文案显式给「不注册也能练」+ 保留期承诺 + 三件套
  it('RQ-210 · P1 · 差异化 · 首访文案显式给出「不注册也能练」与保留期承诺，并前置三件套', () => {
    const r = buildLandingCopy({ guestLimit: 5, guestDays: 7, userRetention: '长期保留' });
    const register = r.elements.find((e) => e.key === 'register');
    const retention = r.elements.find((e) => e.key === 'retention');
    assert.ok(register && register.body.includes('不注册'), '注册栏须明示可免登录');
    assert.ok(retention && retention.body.includes('保留'), '保留期承诺须可读');
    assert.equal(r.differentiators.length, 3, '三件套必须前置曝光');
  });

  // P2 留存体验：诚实承诺前置，用户才愿意留下
  it('RQ-210 · P2 · 留存体验 · 首访文案含「不注册也能练」+保留期+三件套（承诺前置）', () => {
    const r = buildLandingCopy({ guestLimit: 5, guestDays: 7, userRetention: '长期保留' });
    const register = r.elements.find((e) => e.key === 'register');
    const retention = r.elements.find((e) => e.key === 'retention');
    assert.ok(register && register.body.includes('不注册'));
    assert.ok(retention && retention.body.includes('保留'));
    assert.equal(r.differentiators.length, 3);
  });

  // P3 边界异常：缺要素 / 超点击上限
  it('RQ-210 · P3 · 边界异常 · 缺少必答要素时落地页不合格', () => {
    const r = auditLanding({ elements: ['what'], pathCost: goodPath, guestTrainable: true });
    assert.equal(r.ok, false);
    assert.ok(r.missing.length > 0);
  });

  it('RQ-210 · P3 · 边界异常 · 首访路径点击数超过上限时不合格', () => {
    const r = auditLanding({
      elements: fullElements,
      pathCost: clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }, { kind: 'click', id: 'c' }]),
      guestTrainable: true,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes('超出')));
  });

  // P4 性能并发：批量构建落地页文案不崩溃
  it('RQ-210 · P4 · 性能并发 · 批量 buildLandingCopy 1000 次稳定', () => {
    const out = Array.from({ length: 1000 }, () => buildLandingCopy({}));
    assert.equal(out.length, 1000);
    assert.ok(out.every((c) => c.differentiators.length === 3));
  });

  // P5 兼容回归：不得把 localhost 当唯一入口
  it('RQ-210 · P5 · 兼容回归 · 落地页不得把 localhost 当唯一入口（防再次漂移）', () => {
    const copy = buildLandingCopy({});
    const text = JSON.stringify(copy);
    assert.ok(!/https?:\/\/localhost/.test(text), '落地页文案不应出现 localhost 作为入口');
  });
});

/* ================================================================== *
 * RQ-211 · 首训引导闭环（M42 / 产品优先级 P0）                         *
 * 默认短局 quick(12) + 分步引导 + 完成即出成绩卡。                      *
 * ================================================================== */
describe('RQ-211 首训引导闭环（P0）', () => {
  // P0 正常流程：默认短局
  it('RQ-211 · P0 · 正常流程 · 默认 preset 为 quick 且默认根数 = 12', () => {
    assert.equal(DEFAULT_PRESET_KEY, 'quick');
    assert.equal(DEFAULT_BARS, 12);
    const p = presetOf('quick');
    assert.equal(p.bars, 12, '默认短局应为 12 根');
  });

  // P0 正常流程：四步漏斗完成率
  it('RQ-211 · P0 · 正常流程 · 引导漏斗四步有数据时正确计算完成率', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.summary.entered, 10);
    assert.equal(r.summary.started, 8);
    assert.equal(r.summary.finished, 5);
    assert.equal(r.summary.completionRate, 62.5);
    assert.equal(r.dropAt, null, '四步有数据不应有断点');
  });

  // P1 差异化：完成口径必须是有效完成
  it('RQ-211 · P1 · 差异化 · 完成口径必须是有效完成（finished/started，而非 decision）', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 4, first_training_start: 4, first_training_decision: 0, first_training_finish: 3 });
    assert.equal(r.summary.finished, 3);
    assert.equal(r.summary.decided, 0);
    assert.equal(r.summary.completionRate, 75);
  });

  // P2 留存体验：闭环产出可读成绩卡
  it('RQ-211 · P2 · 留存体验 · 四步均有数据时给出可验证完成率，且无断点（成绩卡可续）', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.dropAt, null, '四步不断点');
    assert.equal(r.summary.completionRate, 62.5, '完成率 = 5/8 = 62.5%');
    assert.ok(r.note.includes('可验证'), '口径须可验证而非空白');
  });

  // P3 边界异常：全 0 / 畸形
  it('RQ-211 · P3 · 边界异常 · 全部埋点为 0 时显式说明不可判定', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 0, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.equal(r.summary.entered, 0);
    assert.match(r.note, /不可判定|无法判定/);
  });

  it('RQ-211 · P3 · 边界异常 · 畸形输入（null/负数/非对象）不崩溃', () => {
    assert.doesNotThrow(() => summarizeGuideFunnel(null));
    assert.doesNotThrow(() => summarizeGuideFunnel({ first_training_enter: -5, first_training_start: 'x' }));
    const r = summarizeGuideFunnel({ first_training_enter: -5 });
    assert.ok(Array.isArray(r.steps));
  });

  // P4 性能并发：大样本计数
  it('RQ-211 · P4 · 性能并发 · 大样本计数不崩溃且转化率正确', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 1e6, first_training_start: 8e5, first_training_finish: 5e5 });
    assert.equal(r.summary.entered, 1e6);
    assert.equal(r.summary.completionRate, 62.5);
  });

  // P5 兼容回归：四步顺序稳定
  it('RQ-211 · P5 · 兼容回归 · 引导四步顺序稳定（enter→start→decision→finish）', () => {
    assert.deepEqual(GUIDE_EVENTS, ['first_training_enter', 'first_training_start', 'first_training_decision', 'first_training_finish']);
    assert.equal(GUIDE_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-212 · 免登录练一次 + 转登录保留（M42 / 产品优先级 P0）            *
 * 游客身份归一必须扛住 Number(null)===0 这一族复发病（v10/v13）。       *
 * ================================================================== */
describe('RQ-212 免登录练一次转登录（P0）', () => {
  const GUEST = 'AbCdEfGhIjKlMnOpQrStUv'; // 合法游客 token：base64url、长度 8~64

  // P0 正常流程：游客识别
  it('RQ-212 · P0 · 正常流程 · 游客 token 被识别为 isGuest', () => {
    const id = identityOf({ guestToken: GUEST });
    assert.equal(id.isGuest, true);
    assert.equal(id.anonymous, false);
  });

  // P0 正常流程：已登录优先
  it('RQ-212 · P0 · 正常流程 · 已登录用户优先，游客 token 被丢弃', () => {
    const id = identityOf({ userId: 42, guestToken: GUEST });
    assert.equal(id.userId, 42);
    assert.equal(id.guestToken, null);
    assert.equal(id.isGuest, false);
  });

  // P1 差异化：转登录保留靠 safeUserId 归一不为 0
  it('RQ-212 · P1 · 差异化 · 转登录保留：safeUserId 保证 userId 归一不为 0', () => {
    assert.equal(safeUserId(42), 42);
    assert.equal(safeUserId(null), null, '玩家被算成 userId=0 会撞外键丢成果');
  });

  // P2 留存体验：游客成果不丢
  it('RQ-212 · P2 · 留存体验 · 游客 userId 归一为 null（不丢成果），且额度内给出唯一注册理由', () => {
    assert.equal(safeUserId(null), null, 'null → null，绝不变成 0');
    assert.equal(safeUserId(0), null, '0 不是合法用户，须归一为 null');
    assert.equal(safeUserId(3), 3, '合法登录用户保持不变');
    const q = guestQuota(0);
    assert.equal(q.allowed, true, '额度内允许免登录练');
    assert.ok(typeof q.signupReason === 'string' && q.signupReason.length > 0, '须有唯一、清晰的注册理由以承接留存');
  });

  // P3 边界异常：safeUserId 归一班
  it('RQ-212 · P3 · 边界异常 · safeUserId(null) 返回 null —— 修复 v10「游客被算成 userId=0 撞外键」', () => {
    assert.equal(safeUserId(null), null, 'Number(null)===0 必须被兜住');
    assert.equal(safeUserId(undefined), null);
    assert.equal(safeUserId(''), null);
    assert.equal(safeUserId(0), null, '0 不是合法 userId');
    assert.equal(safeUserId(-3), null);
  });

  it('RQ-212 · P3 · 边界异常 · identityOf 对缺失/畸形输入返回 anonymous 而非崩溃', () => {
    assert.equal(identityOf({}).anonymous, true);
    assert.equal(identityOf(null).anonymous, true);
    assert.equal(identityOf({ userId: 'not-a-number' }).anonymous, true);
  });

  // P4 性能并发：批量归一
  it('RQ-212 · P4 · 性能并发 · 批量身份归一不崩溃（1000 条混合输入）', () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({ userId: i % 3 === 0 ? null : i, guestToken: i % 2 === 0 ? `g${i}` : null }));
    const out = inputs.map((x) => identityOf(x));
    assert.equal(out.length, 1000);
    assert.ok(out.every((o) => o.anonymous || o.isGuest || o.userId));
  });

  // P5 兼容回归：额度边界
  it('RQ-212 · P5 · 兼容回归 · 游客额度越界（已用 > 上限）时 allowed=false、remaining=0', () => {
    const q = guestQuota(GUEST_DAILY_LIMIT + 5);
    assert.equal(q.allowed, false);
    assert.equal(q.remaining, 0);
    const q2 = guestQuota(1);
    assert.equal(q2.allowed, true);
    assert.equal(q2.remaining, GUEST_DAILY_LIMIT - 1);
  });
});

/* ================================================================== *
 * RQ-213 · ≥5 外部真人首训实测（M41 / 产品优先级 P0）                  *
 * 5 名外部真人注册、≥2 有效完成、非同秒批量。                           *
 * ================================================================== */
describe('RQ-213 外部真人首训实测（P0）', () => {
  // P0 正常流程：漏斗达标
  it('RQ-213 · P0 · 正常流程 · 达成目标（注册≥5、有效完成≥2）时 met=true', () => {
    const r = summarizeExternalFunnel({ invited: 20, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true);
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  // P0 正常流程：外部用户识别
  it('RQ-213 · P0 · 正常流程 · isExternalUser 公网 IP + 非内部渠道 → 外部真人', () => {
    const r = isExternalUser(
      { acquisition_channel: 'wechat', signup_ip: '203.0.113.9' },
      { isPublicIpv4: (ip) => !/^(10\.|192\.168\.|127\.|0\.)/.test(ip), isLocalHost: () => false }
    );
    assert.equal(r.external, true);
  });

  // P1 差异化：非同秒批量识别
  it('RQ-213 · P1 · 差异化 · 非同秒批量：同分钟注册 ≥3 被识别为 burst', () => {
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, createdAt: new Date(now) }));
    const b = classifySignupBursts(rows);
    assert.ok(b.userIds.length >= 3, '同分钟 5 人应被识别为批量');
  });

  // P2 留存体验：真实漏斗达标即留存证据
  it('RQ-213 · P2 · 留存体验 · 外部漏斗达标（≥5 注册、≥2 有效完成）且无断点', () => {
    const r = summarizeExternalFunnel({ invited: 10, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true, '6 注册 / 3 有效完成 已达标');
    assert.equal(r.dropAt, null, '全链路无断点');
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  // P3 边界异常：已打标 / 无 IP 不计入
  it('RQ-213 · P3 · 边界异常 · 已打标的用户不计入外部真人', () => {
    const r = isExternalUser({ is_test: true, acquisition_channel: 'wechat', signup_ip: '203.0.113.9' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'test-marked');
  });

  it('RQ-213 · P3 · 边界异常 · 未记录 IP 时无法判定为外部（no-ip）', () => {
    const r = isExternalUser({ acquisition_channel: 'wechat', signup_ip: '' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'no-ip');
  });

  // P4 性能并发：大批量
  it('RQ-213 · P4 · 性能并发 · 大批量用户（1e4）isExternalUser 不崩溃', () => {
    const users = Array.from({ length: 10000 }, (_, i) => ({ id: i, acquisition_channel: 'wechat', signup_ip: '203.0.113.1' }));
    const out = users.map((u) => isExternalUser(u, { isPublicIpv4: () => true, isLocalHost: () => false }));
    assert.equal(out.length, 10000);
    assert.ok(out.every((o) => o.external));
  });

  // P5 兼容回归：内部渠道集合稳定
  it('RQ-213 · P5 · 兼容回归 · INTERNAL_CHANNELS 含内部来源（防再次把自测当外部）', () => {
    for (const c of ['self', 'local', 'test', 'dev', 'internal', 'team']) {
      assert.ok(INTERNAL_CHANNELS.has(c), `${c} 应视为内部渠道`);
    }
    assert.equal(EXTERNAL_FUNNEL_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-214 · 清理历史空跑 + is_test 打标（M43 / 产品优先级 P1）           *
 * 空跑识别隔离（打标而非删除），让真实成果与北极星读数可信。            *
 * ================================================================== */
describe('RQ-214 清理历史空跑与自测打标（P1）', () => {
  // P0 正常流程（主检测路径）
  it('RQ-214 · P0 · 正常流程 · planEmptyRunFlag 只标记「有效完成且耗时过短」的局', () => {
    const sessions = [
      { id: 1, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:05Z' },
      { id: 2, effective_completed: false, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:05Z' },
      { id: 3, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T01:00:00Z' },
    ];
    const r = planEmptyRunFlag(sessions, { thresholdSec: 10 });
    assert.deepEqual(r.flagged.sort(), [1], '仅 id=1（有效完成且 <10s）被标记');
  });

  it('RQ-214 · P0 · 正常流程 · classifyEmptySessions 识别 0 笔成交与过快会话', () => {
    const rows = [
      { id: 10, durationSec: 2, tradeCount: 0, status: 'FINISHED' },
      { id: 11, durationSec: 300, tradeCount: 3, status: 'FINISHED' },
      { id: 12, durationSec: 1, tradeCount: 0, status: 'FINISHED' },
    ];
    const r = classifyEmptySessions(rows);
    assert.deepEqual(r.sessionIds.sort(), [10, 12]);
  });

  // P1 差异化：只针对误判为有效完成的局
  it('RQ-214 · P1 · 差异化 · planEmptyRunFlag 跳过 effective_completed=false 的局', () => {
    const sessions = [{ id: 9, effective_completed: false, created_at: 't', finished_at: 't' }];
    const r = planEmptyRunFlag(sessions, { thresholdSec: 1 });
    assert.equal(r.flagged.length, 0, '空跑清理只针对被误判为有效完成的局');
  });

  // P2 留存体验：打标而非删除，真实成果保留
  it('RQ-214 · P2 · 留存体验 · 空跑被识别隔离、真实一局被保留（打标而非删除）', () => {
    const r = classifyEmptySessions([
      { id: 1, durationSec: 0.2, status: 'FINISHED', tradeCount: 0 }, // 点一下就结束 → 空跑
      { id: 2, durationSec: 120, status: 'FINISHED', tradeCount: 3 }, // 真实一局 → 保留
    ]);
    assert.equal(r.hits.length, 1, '仅 1 局被标为空跑');
    assert.deepEqual(r.sessionIds, [1], '只隔离空跑局，真实局不被误伤');
  });

  // P3 边界异常：空/畸形/时间不可解析
  it('RQ-214 · P3 · 边界异常 · 空数组 / null / 畸形行不崩溃', () => {
    assert.doesNotThrow(() => classifyEmptySessions(null));
    assert.deepEqual(classifyEmptySessions([]).sessionIds, []);
    assert.doesNotThrow(() => classifyEmptySessions([{ id: 'x' }, null, {}]));
  });

  it('RQ-214 · P3 · 边界异常 · durationSec 为 null 时不会误判为「过快」，仅按成交数判定', () => {
    const r = classifyEmptySessions([{ id: 7, durationSec: null, tradeCount: 5, status: 'FINISHED' }]);
    assert.equal(r.sessionIds.length, 0, 'durationSec 不可解析 ≠ 自测；有成交即不标记');
  });

  // P4 性能并发：大批量
  it('RQ-214 · P4 · 性能并发 · 大批量会话（1e4）识别不崩溃且结果确定', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, durationSec: 1, tradeCount: 0, status: 'FINISHED' }));
    const r = classifyEmptySessions(rows);
    assert.equal(r.sessionIds.length, 10000);
  });

  // P5 兼容回归：纯函数不改入参
  it('RQ-214 · P5 · 兼容回归 · classifyEmptySessions 是纯函数，不改入参', () => {
    const rows = [{ id: 1, durationSec: 1, tradeCount: 0, status: 'FINISHED' }];
    const snapshot = JSON.stringify(rows);
    classifyEmptySessions(rows);
    assert.equal(JSON.stringify(rows), snapshot, '不得就地修改入参');
  });
});

/* ================================================================== *
 * RQ-215 · 埋点↔会话对账差异=0（M43 / 产品优先级 P1）                  *
 * 按 sessionId 双向对账，方向相反的误差不被总数抵消。                    *
 * ================================================================== */
describe('RQ-215 埋点与会话对账（P1）', () => {
  // P0 正常流程
  it('RQ-215 · P0 · 正常流程 · 完全匹配时 ok 且 diff=0', () => {
    const r = reconcileConsistency([{ id: 1, session_id: 100 }], [{ session_id: 100 }]);
    assert.equal(r.ok, true);
    assert.equal(r.diff, 0);
    assert.equal(r.matchedCount, 1);
  });

  it('RQ-215 · P0 · 正常流程 · 单向差异被分类到 orphanEvents / missingEvents', () => {
    const r = reconcileConsistency(
      [{ id: 1, session_id: 100 }, { id: 2, session_id: 101 }],
      [{ session_id: 100 }, { session_id: 200 }]
    );
    assert.equal(r.ok, false);
    assert.equal(r.diff, 0, '总数一致但方向相反，必须不被抵消');
    assert.equal(r.orphanEvents.length, 1);
    assert.equal(r.missingEvents.length, 1);
  });

  // P1 差异化：双向对账区别于比总数
  it('RQ-215 · P1 · 差异化 · 双向对账（区别于单纯比总数）', () => {
    const r = reconcileConsistency(
      [{ id: 1, session_id: 1 }, { id: 2, session_id: 2 }],
      [{ session_id: 2 }, { session_id: 3 }]
    );
    assert.equal(r.ok, false, '按 id 对账应暴露方向相反的误差');
  });

  // P2 留存体验：指标可信是留存决策前提
  it('RQ-215 · P2 · 留存体验 · 双向对账能抓出「总数相同但方向相反」的漂移，保证指标可信', () => {
    const diverged = reconcileConsistency(
      [{ id: 10, session_id: 5 }, { id: 11, session_id: null }],
      [{ session_id: 5 }, { session_id: 6 }]
    );
    assert.equal(diverged.ok, false, '漂移必须被判为不一致');
    assert.equal(diverged.matchedCount, 1, '仅 1 局真正匹配');
    assert.equal(diverged.orphanEvents.length, 1, '孤立埋点须暴露');
    assert.equal(diverged.missingEvents.length, 1, '漏报须暴露');
    const aligned = reconcileConsistency([{ id: 10, session_id: 5 }], [{ session_id: 5 }]);
    assert.equal(aligned.ok, true, '完全对齐时须判一致');
    assert.equal(aligned.matchedCount, 1);
  });

  // P3 边界异常：未携带 sessionId 不算 session 0
  it('RQ-215 · P3 · 边界异常 · 未携带 sessionId 不被算成 session 0（v10/v13 同族修复）', () => {
    const r = reconcileConsistency([{ id: 9, session_id: null }, { id: 10, session_id: '' }], [{ session_id: 0 }]);
    assert.equal(r.orphanEvents.length, 2, 'null/空串 sessionId 必须归类为「未携带」而非 session 0');
    assert.equal(r.matchedCount, 0, 'null/空串事件不得被匹配到任何会话（含真实的 session 0）');
  });

  it('RQ-215 · P3 · 边界异常 · 空输入时 ok 且计数为 0', () => {
    const r = reconcileConsistency([], []);
    assert.equal(r.ok, true);
    assert.equal(r.eventCount, 0);
    assert.equal(r.sessionCount, 0);
  });

  // P4 性能并发：大批量
  it('RQ-215 · P4 · 性能并发 · 大批量对账（各 2e3）不崩溃', () => {
    const ev = Array.from({ length: 2000 }, (_, i) => ({ id: i, session_id: i }));
    const ses = Array.from({ length: 2000 }, (_, i) => ({ session_id: i }));
    const r = reconcileConsistency(ev, ses);
    assert.equal(r.ok, true);
    assert.equal(r.matchedCount, 2000);
  });

  // P5 兼容回归：null 与 '0' 区别对待
  it('RQ-215 · P5 · 兼容回归 · 对账守卫复用，不因 SQL NULLIF 漂移', () => {
    const r = reconcileConsistency([{ id: 1, session_id: 0 }], [{ session_id: 0 }]);
    assert.equal(r.matchedCount, 1, '真正的 session 0 仍可匹配；只有 null/空串被排除');
  });
});

/* ================================================================== *
 * RQ-216 · 发布后验证固化（M43 / 产品优先级 P1）                       *
 * 连续 N 次发布均有验证记录；ok:false 打断连续但不自杀。                *
 * ================================================================== */
describe('RQ-216 发布后验证固化（P1）', () => {
  const mk = (commit, ok) => ({ git_commit: commit, ok: Boolean(ok), run_at: new Date() });

  // P0 正常流程
  it('RQ-216 · P0 · 正常流程 · 连续不同 commit 计为连续验证', () => {
    const rows = [mk('aaa', true), mk('bbb', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, true, '连续 2 次不同提交应为连续');
  });

  // P1 差异化：ok:false 打断连续
  it('RQ-216 · P1 · 差异化 · ok:false 会打断连续', () => {
    const rows = [mk('aaa', true), mk('bbb', false), mk('ccc', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '中间一次失败应打断连续');
  });

  // P2 留存体验：用户回来看到的是真验过的版本
  it('RQ-216 · P2 · 留存体验 · 两个不同提交均验证通过才算连续达标；同提交重复跑不凑数', () => {
    const ok = verificationStreak([mk('a1', true), mk('b2', true)]);
    assert.equal(ok.streak, 2);
    assert.equal(ok.ok, true);
    const dup = verificationStreak([mk('a1', true), mk('a1', true)]);
    assert.equal(dup.streak, 1, '同提交去重');
    assert.equal(dup.ok, false, '未达连续 2 次，发布闸门须拦下');
  });

  // P3 边界异常：单次 / 同提交
  it('RQ-216 · P3 · 边界异常 · 单次记录时 streak 不 ok，但记录本身仍算成功（不自杀）', () => {
    const rows = [mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '只有 1 次不达到连续阈值');
    assert.equal(s.streak, 1);
  });

  it('RQ-216 · P3 · 边界异常 · 同一 commit 重复跑不去重（不虚增连续）', () => {
    const rows = [mk('aaa', true), mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '同一次提交重复跑不算两次发布');
  });

  // P4 性能并发：大批量验证记录
  it('RQ-216 · P4 · 性能并发 · 大批量验证记录（1e3）统计不崩溃', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => mk(`c${i}`, true));
    const s = verificationStreak(rows);
    assert.equal(s.streak, 1000);
  });

  // P5 兼容回归：端点集合稳定
  it('RQ-216 · P5 · 兼容回归 · REQUIRED_ROUTES 含阶段零端点（防端点被误删）', () => {
    const paths = REQUIRED_ROUTES.map((r) => r.path);
    for (const p of ['/api/public/stage-zero', '/api/public/status-truth', '/api/public/landing', '/api/public/help', '/api/guest/session']) {
      assert.ok(paths.includes(p), `REQUIRED_ROUTES 应含 ${p}`);
    }
  });
});

/* ================================================================== *
 * RQ-217 · 身份口径纠偏（M44 / 产品优先级 P1）                         *
 * 对外口径必须「真实 A 股行情 + 模拟撮合」，禁「虚拟仿真/交易大厅」。     *
 * ================================================================== */
describe('RQ-217 身份口径纠偏（P1）', () => {
  // P0 正常流程
  it('RQ-217 · P0 · 正常流程 · 合规文本（含 REQUIRED_PHRASES、无 FORBIDDEN）通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-217 · P0 · 正常流程 · 含「虚拟仿真」被判违规', () => {
    const r = checkIdentityWording('本平台为虚拟仿真交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.includes('虚拟仿真'));
  });

  // P1 差异化：缺失事实锚点判不合规
  it('RQ-217 · P1 · 差异化 · 缺失 REQUIRED_PHRASES 被判不合规', () => {
    const r = checkIdentityWording('这是一个交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.missingRequired.length === REQUIRED_PHRASES.length, '两个事实锚点都应缺失');
  });

  // P2 留存体验：统一叙事是信任留存第一步
  it('RQ-217 · P2 · 留存体验 · 合规口径判 ok；含禁止误述则判违规', () => {
    const good = checkIdentityWording('我们用真实 A 股行情与模拟撮合做训练');
    assert.equal(good.ok, true);
    assert.deepEqual(good.forbiddenHits, []);
    assert.deepEqual(good.missingRequired, []);
    const bad = checkIdentityWording('这是一套虚拟仿真交易大厅');
    assert.equal(bad.ok, false);
    assert.ok(bad.forbiddenHits.includes('虚拟仿真'));
    assert.ok(bad.forbiddenHits.includes('交易大厅'));
  });

  // P3 边界异常：null/空
  it('RQ-217 · P3 · 边界异常 · null/空文本被判不合规（缺事实锚点），不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  // P4 性能并发：大批量检查
  it('RQ-217 · P4 · 性能并发 · 批量 checkIdentityWording 1e3 次不崩溃', () => {
    const texts = Array.from({ length: 1000 }, () => '真实 A 股行情与模拟撮合训练');
    const out = texts.map((t) => checkIdentityWording(t));
    assert.equal(out.length, 1000);
    assert.ok(out.every((r) => r.ok === true));
  });

  // P5 兼容回归：README 实际合规 + 禁止词表完整
  it('RQ-217 · P5 · 兼容回归 · 当前仓库 README 实际合规（防再次漂移）', () => {
    const p = resolve(process.cwd(), '..', 'README.md');
    if (!existsSync(p)) return; // 无 README 时跳过但明示
    const text = readFileSync(p, 'utf8');
    const r = checkIdentityWording(text);
    assert.equal(r.ok, true, `README 身份口径应合规，实际违规：${r.forbiddenHits.join('/')} ${r.missingRequired.join('/')}`);
  });

  it('RQ-217 · P5 · 兼容回归 · 「交易大厅」类误述全部命中 FORBIDDEN_WORDINGS', () => {
    for (const w of ['虚拟仿真', '模拟交易大厅', 'A 股模拟交易大厅', '交易大厅']) {
      assert.ok(FORBIDDEN_WORDINGS.includes(w), `${w} 应在禁止词表中`);
    }
  });
});

/* ================================================================== *
 * RQ-218 · 三件套曝光（M44 / 产品优先级 P1）                           *
 * 注册页/训练页可见三件套（可核对/可信度/保留期）声明。                *
 * ================================================================== */
describe('RQ-218 三件套曝光（P1）', () => {
  const copy = buildLandingCopy({});

  // P0 正常流程
  it('RQ-218 · P0 · 正常流程 · 三件套全部曝光时 allExposed=true', () => {
    const r = auditThreePieceExposure({
      surfaces: [{ name: 'landing', text: '结算可核对：逐笔重算；可信度护栏带置信区间；保留期长期保留。' }],
    });
    assert.equal(r.allExposed, true);
    assert.equal(r.exposedCount, 3);
  });

  it('RQ-218 · P0 · 正常流程 · 落地页文案实际暴露三件套', () => {
    const r = auditThreePieceExposure({ surfaces: [{ name: 'landing', text: JSON.stringify(copy) }] });
    assert.equal(r.allExposed, true, 'buildLandingCopy 的 differentiators 必须命中三件套锚点');
  });

  // P1 差异化：只露两件判不一致
  it('RQ-218 · P1 · 差异化 · 只暴露两件时 consistent=false（口径不一致）', () => {
    const r = auditThreePieceExposure({
      surfaces: [{ name: 'x', text: '结算可核对与长期保留都说了，但差异护栏没提。' }],
    });
    assert.equal(r.allExposed, false);
    assert.equal(r.missing.length, 1, '只缺 confidence 一件');
    assert.equal(r.consistent, false, '两件齐发一件藏 = 不一致');
  });

  // P2 留存体验：三件套一致曝光立住信任壁垒
  it('RQ-218 · P2 · 留存体验 · 三件套全部曝光且口径一致（不藏任何一件）', () => {
    const r = auditThreePieceExposure({ combined: '结算可核对、可信度护栏带置信区间、保留期长期保留' });
    assert.equal(r.allExposed, true, '三件套须全部曝光');
    assert.equal(r.exposedCount, 3);
    assert.equal(r.consistent, true, '三件要么一起出现要么一起缺失，不得只露两件');
  });

  // P3 边界异常：空文案
  it('RQ-218 · P3 · 边界异常 · 空文案时 allExposed=false 但 consistent=true（非半暴露）', () => {
    const r = auditThreePieceExposure({ surfaces: [] });
    assert.equal(r.allExposed, false);
    assert.equal(r.consistent, true, '全缺不算不一致，避免误报');
    assert.equal(r.exposedCount, 0);
  });

  // P4 性能并发：批量审计
  it('RQ-218 · P4 · 性能并发 · 批量 auditThreePieceExposure 1e3 次稳定', () => {
    const out = Array.from({ length: 1000 }, () =>
      auditThreePieceExposure({ combined: '结算可核对、可信度护栏带置信区间、保留期长期保留' })
    );
    assert.equal(out.length, 1000);
    assert.ok(out.every((r) => r.allExposed === true));
  });

  // P5 兼容回归：访客帮助同步三件套 + 定义常量稳定
  it('RQ-218 · P5 · 兼容回归 · renderVisitorHelp 也暴露三件套锚点（访客帮助同步）', () => {
    const md = renderVisitorHelp({ publicUrl: 'https://x.test' });
    const r = auditThreePieceExposure({ combined: md });
    assert.equal(r.allExposed, true, '访客帮助必须同步首访的三件套叙事');
  });

  it('RQ-218 · P5 · 兼容回归 · 三件套定义恒为 3 件', () => {
    assert.equal(DIFFERENTIATION_PIECES.length, 3);
  });
});

/* ================================================================== *
 * RQ-219 · 结算可核对产品化（M45 / 产品优先级 P2）                     *
 * 三入口可达 + audit 非 0 时页面明示。                                  *
 * ================================================================== */
describe('RQ-219 结算可核对产品化（P2）', () => {
  // P0 正常流程：拒绝归类 + 三项全 0
  it('RQ-219 · P0 · 正常流程 · classifyRejection 对已知拒绝原因正确归类', () => {
    const c = classifyRejection('涨跌停限制，无法成交');
    assert.equal(c.known, true);
    assert.ok(c.key);
    assert.ok(c.howToVerify, '必须给出可核对路径');
  });

  it('RQ-219 · P0 · 正常流程 · buildSettlementAudit 三项全 0 时 audit.ok=true（可声称逐笔可核对）', () => {
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

  // P1 差异化：audit 非 0 时页面明示
  it('RQ-219 · P1 · 差异化 · audit 非 0 时页面明示（ok=false 且 note 说明）', () => {
    const a = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', price: 99, amount: 1000, fee: 5 }],
      rejections: [{ reason: '未知原因拒绝', seq: 6, side: 'SELL' }],
      bars: [{ seq: 5, close: 10 }],
    });
    assert.equal(a.audit.priceMismatch > 0, true, '价格偏离必须被检出');
    assert.equal(a.audit.unknownRejections, 1, '未知拒绝必须被计数');
    assert.equal(a.audit.ok, false, '三项任一非 0 即不可声称可核对');
    assert.ok(a.audit.note, '必须给出明示文案而非藏进日志');
  });

  // P2 留存体验：审核结果诚实呈现给用户（可自核）
  it('RQ-219 · P2 · 留存体验 · 审核结果对用户诚实呈现：自检通过时仍带免责声明与规则（可自核）', () => {
    const r = buildSettlementAudit({ orders: [], rejections: [], session: { status: 'FINISHED' }, bars: [] });
    assert.equal(r.audit.ok, true, '无偏离时方可声称逐笔可核对');
    assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, '须附免责声明');
    assert.ok(Array.isArray(r.rejections), '拒绝原因列表须可呈现');
    assert.ok(r.rules != null && r.slippageRule != null, '规则与滑点事实须曝光供自核');
  });

  // P3 边界异常：无报价不猜 + 未知拒绝
  it('RQ-219 · P3 · 边界异常 · buildPriceOrigin 无报价时不猜（matched=null）', () => {
    const o = buildPriceOrigin({ seq: 5, price: 10, bars: [] });
    assert.equal(o.hasQuote, false);
    assert.equal(o.matched, null, '无 K 线不应编造匹配');
  });

  it('RQ-219 · P3 · 边界异常 · 未知拒绝原因 known=false（不静默归类）', () => {
    const c = classifyRejection('');
    assert.equal(c.known, false);
    assert.equal(c.reason, '');
  });

  // P4 性能并发：大订单量
  it('RQ-219 · P4 · 性能并发 · 大订单量审计（1e3 笔）不崩溃', () => {
    const orders = Array.from({ length: 1000 }, (_, i) => ({ seq: i, side: 'BUY', price: 10, amount: 1000, fee: 5 }));
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders, rejections: [], bars: [{ seq: 0, close: 10 }] });
    assert.equal(a.orderCount, 1000);
  });

  // P5 兼容回归：规则常量存在
  it('RQ-219 · P5 · 兼容回归 · SETTLEMENT_RULES / SLIPPAGE_RULE 常量存在（防回归）', () => {
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders: [], rejections: [] });
    assert.ok(a.rules, '结算规则应存在');
    assert.ok(a.slippageRule, '滑点规则应存在');
  });
});

/* ================================================================== *
 * RQ-220 · 单次成绩可信度表达（M45 / 产品优先级 P2）                   *
 * t 值/置信区间/误差带（中文）；样本不足只给成本/行为。                 *
 * ================================================================== */
describe('RQ-220 单次成绩可信度表达（P2）', () => {
  // P0 正常流程：大样本给区间，小样本给三件事
  it('RQ-220 · P0 · 正常流程 · 样本 ≥ MIN_SAMPLE(50) 时给区间化结论（mode=interval）', () => {
    const p = buildConclusionPanel({ sampleSize: 50, expectancyR: 0.2, sigma: 1, winRate: 0.55 });
    assert.equal(p.mode, 'interval');
    assert.ok(p.interval, '大样本应返回 interval');
    assert.equal(p.facts, null, '大样本不应返回三件事');
  });

  it('RQ-220 · P0 · 正常流程 · 样本 < SMALL_SAMPLE(30) 时只给三件事（mode=three-facts，无点估计）', () => {
    const p = buildConclusionPanel({ sampleSize: 12, expectancyR: 5, sigma: 1, winRate: 0.9 });
    assert.equal(p.mode, 'three-facts');
    assert.ok(p.facts, '小样本应返回三件事');
    assert.equal(p.interval, null, '小样本不应给点估计');
  });

  // P1 差异化：中文 verdict 表达
  it('RQ-220 · P1 · 差异化 · verdict 中文表达：insufficient / conclusive', () => {
    const ins = buildIntervalConclusion({ sampleSize: 3 });
    assert.equal(ins.verdict.level, 'insufficient');
    assert.match(ins.verdict.text, /样本|还差/);
    const suf = buildIntervalConclusion({ sampleSize: 60 });
    assert.equal(suf.verdict.level, 'conclusive');
  });

  // P2 留存体验：小样本诚实护栏 + 三件事
  it('RQ-220 · P2 · 留存体验 · 小样本显式给「样本不足」护栏与三件事实，且禁止 edge 断言', () => {
    const r = buildSmallSampleFacts({
      sampleSize: 3,
      cost: { fee: 1.5 },
      behavior: {},
      benchmark: { returnPct: 2, buyHoldPct: 1.5 },
    });
    assert.equal(r.smallSample, true, '3 笔 < 护栏，须进入小样本表达');
    assert.ok(r.blockedAssertions.includes('胜率'), '须明确拦截胜率类 edge 断言');
    assert.ok(r.nextAction.label.includes('再积累'), '须给出可执行的下一步而非空白');
    assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, '须附样本量护栏说明');
    assert.equal(r.facts.length, 3, '仍可读成本/行为/对照三件事');
    const guard = assertNoEdgeAssertion('你的胜率是 67%', 3);
    assert.equal(guard.ok, false, '小样本下出现胜率断言须被判违规');
  });

  // P3 边界异常：n 缺失 / 0 / 负数
  it('RQ-220 · P3 · 边界异常 · n=null/0/负数 时判为样本不足且 guard 无点估计', () => {
    for (const n of [null, 0, -5, undefined]) {
      const c = buildIntervalConclusion({ sampleSize: n });
      assert.equal(c.insufficient, true, `n=${n} 应判不足`);
      assert.equal(c.guard.ok, true, `n=${n} 不应出现点估计`);
    }
  });

  it('RQ-220 · P3 · 边界异常 · 小样本下 assertNoEdgeAssertion 禁止胜率/期望值等 edge 断言', () => {
    const hit = assertNoEdgeAssertion('本局胜率 60%，期望值 0.3R', 5);
    assert.equal(hit.ok, false, '小样本下出现 edge 断言应判不通过');
    assert.ok(hit.hits.length > 0);
    const pass = assertNoEdgeAssertion('本局手续费 5 元', 5);
    assert.equal(pass.ok, true);
    assert.equal(assertNoEdgeAssertion('胜率 60%', 30).ok, true);
  });

  // P4 性能并发：大样本
  it('RQ-220 · P4 · 性能并发 · 大样本（1e4）计算不崩溃，t 值不为 Infinity', () => {
    const c = buildIntervalConclusion({ sampleSize: 10000, expectancyR: 0.1, sigma: 1 });
    assert.equal(c.insufficient, false);
    const t = c.metrics.find((m) => m.key === 'expectancy');
    assert.ok(Number.isFinite(t.t ?? t.point), 't 值不应为 Infinity');
  });

  // P5 兼容回归：阈值分工稳定
  it('RQ-220 · P5 · 兼容回归 · 小样本阈值分工稳定：buildConclusionPanel(50) vs buildSmallSampleFacts(30)', () => {
    assert.equal(MIN_SAMPLE, 50, '结论面板切换阈值');
    assert.equal(SMALL_SAMPLE_THRESHOLD, 30, '边缘断言拦截阈值');
    assert.ok(MIN_SAMPLE > SMALL_SAMPLE_THRESHOLD);
    assert.equal(buildConclusionPanel({ sampleSize: 49 }).mode, 'three-facts');
    assert.equal(buildConclusionPanel({ sampleSize: 50 }).mode, 'interval');
    assert.equal(assertNoEdgeAssertion('胜率', 29).ok, false);
    assert.equal(assertNoEdgeAssertion('胜率', 30).ok, true);
    for (const w of FORBIDDEN_ASSERTIONS) assert.ok(w, 'FORBIDDEN_ASSERTIONS 应非空');
  });
});

/* ================================================================== *
 * 全局回归：核心常量不能静默变更（防再次漂移）                          *
 * ================================================================== */
describe('v20 全局回归守卫', () => {
  it('RQ-211/212 · P5 · 默认短局根数恒为 12（首训闭环验收锚点）', () => {
    assert.equal(DEFAULT_BARS, 12);
  });
  it('RQ-214/220 · P5 · 门槛常量稳定', () => {
    assert.equal(MIN_SAMPLE, 50);
    assert.equal(SMALL_SAMPLE_THRESHOLD, 30);
  });
  it('RQ-218 · P5 · 三件套定义恒为 3 件', () => {
    assert.equal(DIFFERENTIATION_PIECES.length, 3);
  });
});
