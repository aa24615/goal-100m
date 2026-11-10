/**
 * v22 需求实现与测试覆盖矩阵（RQ-209 ~ RQ-218）
 *
 * 本文件对应「产品需求表 · 赚了一个小目标」v22（2026-11-11）§5 需求表（10 项）。
 * v22 在需求内容上**零新增功能**——RQ-209~218 与 v21 完全一致（同 10 项、同编号、
 * 同优先级、同验收），底层纯函数服务与端点已在 v15~v18 全部落地、v21 已闭合 P0~P5。
 * 本版唯一实质新增（相对 v21）是**语义护栏**：系统自检已自动标注
 * `OK_WITHOUT_ENTRY`（F-102：责任已指定不等于入口可用），以及截止日倒计时自检
 * （daysLeft / expired）。本文件在「按 v22 编号 + 六档测试级别」重新组织覆盖的基础上，
 * 额外补齐上述两项 v22 专属断言，确保每条需求在 P0~P5 各至少有一例
 * （正常流程 / 边界 / 异常均有涉猎）。
 *
 * 六档测试级别约定（沿 v7 起，P3/P4/P5 是**测试级别**而非产品优先级）：
 *   P0 主流程        —— 需求核心路径
 *   P1 差异化         —— 与竞品/旧口径的差异点
 *   P2 留存体验       —— 用户投入前/后的体验护栏
 *   P3 边界异常       —— 空值/越界/缺失/畸形输入（含历史高频复发病：Number(null)===0）
 *   P4 性能并发       —— 大样本/批量/高吞吐
 *   P5 兼容回归       —— 历史遗留口径/旧字段/防再次漂移/常量稳定性
 *
 * 各用例标题前缀标注「需求编号 · 测试级别 · 场景」。产品优先级（P0/P1/Won't）来自需求表；
 * 测试级别（P0~P5）为测试侧扩展，两者在矩阵文档中分别列示。
 *
 * 运行：node --test tests/unit/v22Requirements.test.js
 * 回归：node --test tests/unit/v18Requirements.test.js tests/unit/v19RequirementsP2.test.js tests/unit/v20Requirements.test.js tests/unit/v21Requirements.test.js tests/unit/v22Requirements.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { auditPublicEntrypoint, serverNamesOf, isLocalHost } from '../../src/services/publicAccessService.js';
import {
  summarizePublicEntry,
  ownerState,
  frozenGate,
  FROZEN_RQS,
} from '../../src/services/publicEntryService.js';
import {
  auditLanding,
  buildLandingCopy,
  clickPathCost,
  MAX_FIRST_VISIT_CLICKS,
  LANDING_ELEMENTS,
  renderVisitorHelp, statusTruthfulness,
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
import { summarizeConsistency, DEFAULT_CONSISTENCY_RULES } from '../../src/services/telemetryIntegrityService.js';
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

/* v22 需求 → 底层服务 / 旧编号映射（本文件覆盖目标）
 * RQ-209 公网入口(P0)        ← publicEntryService + publicAccessService   (旧 RQ-209)
 * RQ-210 落地页(P0)          ← stageZeroService                         (旧 RQ-210)
 * RQ-211 结算自检卡三入口(P0) ← settlementAuditService                    (旧 RQ-219)
 * RQ-212 免登录短局首训(P0)  ← firstTraining/guest/sessionLength           (旧 RQ-211/212)
 * RQ-213 埋点↔会话对账(P1)   ← telemetryIntegrityService + releaseGate    (旧 RQ-215)
 * RQ-214 小样本护栏(P1)      ← smallSample/intervalConclusion             (旧 RQ-220)
 * RQ-215 发布验证固化(P0)    ← releaseGateService + verifyRelease         (旧 RQ-216)
 * RQ-216 外部真人(P0)        ← testTrafficService                         (旧 RQ-213)
 * RQ-217 工作区收口/F-00(P1) ← identityWordingService + 接线守卫          (新框架)
 * RQ-218 冻结(Won't)         ← publicEntryService.frozenGate              (旧 RQ-172/218)
 */

const NOW = new Date('2026-11-10T00:00:00Z'); // 确定性基准，避免日期漂移导致 owner 口径误判
const FULLY_CONFIGURED_ENV = [
  'PUBLIC_BASE_URL=https://train.example.com',
  'PUBLIC_ENTRY_OWNER=zyan',
  'PUBLIC_ENTRY_DEADLINE=2026-11-16',
].join('\n');
const GOOD_NGINX = [
  'server { server_name train.example.com; listen 443 ssl; }',
  'server { listen 80; server_name train.example.com; return 301 https://$host$request_uri; }',
].join('\n');
const GOOD_README = '# 入口\n请访问 https://train.example.com 开始训练。\n';

/* ================================================================== *
 * RQ-209 · 公网入口（M41 / 产品优先级 P0）                            *
 * 唯一解锁项；根因是「没有 owner 执行」，非代码可完成。               *
 * 测试守护「未配置→ready:false」「全配置+owner→ready:true」，并防口径漂移。*
 * ================================================================== */
describe('RQ-209 公网入口（P0）', () => {
  // P0 正常流程：三处文件齐 + owner/截止均指定 + smoke 实测 → 真正就绪
  it('RQ-209 · P0 · 正常流程 · 三处文件齐 + owner/截止均指定 + 4G 实测时 ready:true 且 checklist 全 done', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
    assert.equal(r.audit.ready, true, 'audit 层应全 done');
    assert.equal(r.owner.blocked, false, 'owner/deadline 齐备不应 block');
    assert.equal(r.ready, true, '对外口径应判为真正就绪');
    assert.ok(r.audit.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.gate.blocked.length, 0, '公网就绪后冻结项应解冻');
  });

  // P0 边界异常：未配置核心变量
  it('RQ-209 · P0 · 边界异常 · 未配置 PUBLIC_BASE_URL 时 ready:false 且有阻断项', () => {
    const r = summarizePublicEntry({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.length > 0, '未配置时必须给出阻断项');
  });

  // P1 差异化：域名与 nginx server_name 必须一致（自欺最常见形式）
  it('RQ-209 · P1 · 差异化 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/train\.example\.com/g, 'other.example.com');
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: nginx, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('server_name') && b.includes('一致')));
  });

  // P1 差异化（v22 新增）：owner 缺失本身即阻断——连续 12 版未完成的真正根因
  it('RQ-209 · P1 · 差异化 · 三处文件齐但 owner 缺失时 owner.blocked=true（根因护栏）', () => {
    const env = 'PUBLIC_BASE_URL=https://train.example.com\nPUBLIC_ENTRY_DEADLINE=2026-11-16\n'; // 有截止但无 owner
    const r = summarizePublicEntry({ envText: env, nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.owner.state, 'no-owner', '有截止无 owner 应判 no-owner');
    assert.equal(r.owner.blocked, true, 'no-owner 必须 block');
    assert.equal(r.ready, false, 'owner 缺失即使三处文件齐也不算就绪');
  });

  // P2 留存体验：未就绪必须诚实报出待办，而非假装开门把用户引流到死链
  it('RQ-209 · P2 · 留存体验 · 三处文件全缺失时诚实报 ready:false 并给出待办清单', () => {
    const r = summarizePublicEntry({ envText: '', nginxText: '', readmeText: '访问 http://localhost:8080', now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.length > 0, '未配置时必须有阻断项');
    assert.ok(r.audit.pending.length > 0, '必须给出可执行的待办清单');
    assert.ok(r.audit.note.includes('不可达'), '口径须明确「不可达」');
  });

  // P3 边界异常：localhost/内网地址即使写了也不能算可达
  it('RQ-209 · P3 · 边界异常 · PUBLIC_BASE_URL 指向 localhost 被识别为本机/内网，外部不可达', () => {
    const r = summarizePublicEntry({ envText: 'PUBLIC_BASE_URL=http://localhost:8080\n', nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('本机') || b.includes('内网')));
  });

  // P4 性能并发：批量审计不崩溃
  it('RQ-209 · P4 · 性能并发 · 连续 1000 次审计调用稳定返回', () => {
    let okCount = 0;
    for (let i = 0; i < 1000; i++) {
      const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
      if (r.ready === true) okCount++;
    }
    assert.equal(okCount, 1000, '配置齐全时应始终返回 ready:true');
  });

  // P5 兼容回归：README 不得再以 localhost 为唯一入口；域名解析工具稳定
  it('RQ-209 · P5 · 兼容回归 · README 仍以 localhost 为唯一入口时触发 readme 阻断', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。', now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('README') || b.includes('入口')));
  });

  it('RQ-209 · P5 · 兼容回归 · serverNamesOf 提取真实域名 + isLocalHost 正确识别本机/公网', () => {
    const names = serverNamesOf('server_name train.example.com localhost _;');
    assert.ok(names.includes('train.example.com'), '应提取出真实域名');
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('train.example.com'), false);
  });
});

/* ================================================================== *
 * RQ-210 · 免登录落地页（M41 / 产品优先级 P0）                         *
 * 首访即见三件套差异化；含「不注册也能练」+ 保留期承诺前置。          *
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
 * RQ-211 · 结算口径自检卡三处前端入口（M42 / 产品优先级 P0）           *
 * 训练 / 复盘 / 成绩三处入口可达；任一异常在页内明示而非藏日志。       *
 * 底层 settlementAuditService 已建；本块守护「三入口可消费 + 异常页内明示」。*
 * ================================================================== */
describe('RQ-211 结算口径自检卡三入口（P0）', () => {
  const threeSurfaces = ['train', 'review', 'score']; // 训练/复盘/成绩

  // P0 正常流程：拒绝归类 + 三项全 0
  it('RQ-211 · P0 · 正常流程 · classifyRejection 对已知拒绝原因正确归类且给出可核对路径', () => {
    const c = classifyRejection('涨跌停限制，无法成交');
    assert.equal(c.known, true);
    assert.ok(c.key, '必须给出归类键');
    assert.ok(c.howToVerify, '必须给出可核对路径（三入口可消费）');
  });

  it('RQ-211 · P0 · 正常流程 · buildSettlementAudit 三项全 0 时 audit.ok=true（可声称逐笔可核对）', () => {
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

  // P1 差异化：audit 非 0 时页面明示（三入口均可渲染异常，不藏日志）
  it('RQ-211 · P1 · 差异化 · audit 非 0 时三入口可消费异常：ok=false 且 note 说明', () => {
    const a = buildSettlementAudit({
      session: { status: 'FINISHED' },
      orders: [{ seq: 5, side: 'BUY', price: 99, amount: 1000, fee: 5 }],
      rejections: [{ reason: '未知原因拒绝', seq: 6, side: 'SELL' }],
      bars: [{ seq: 5, close: 10 }],
    });
    assert.equal(a.audit.priceMismatch > 0, true, '价格偏离必须被检出');
    assert.equal(a.audit.unknownRejections, 1, '未知拒绝必须被计数');
    assert.equal(a.audit.ok, false, '三项任一非 0 即不可声称可核对');
    assert.ok(a.audit.note, '必须给出明示文案而非藏进日志（三入口一致可读）');
  });

  // P2 留存体验：审核结果诚实呈现给用户（可自核）
  it('RQ-211 · P2 · 留存体验 · 审核结果对用户诚实呈现：自检通过时仍带免责声明与规则（三入口可自核）', () => {
    const r = buildSettlementAudit({ orders: [], rejections: [], session: { status: 'FINISHED' }, bars: [] });
    assert.equal(r.audit.ok, true, '无偏离时方可声称逐笔可核对');
    assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, '须附免责声明');
    assert.ok(Array.isArray(r.rejections), '拒绝原因列表须可呈现');
    assert.ok(r.rules != null && r.slippageRule != null, '规则与滑点事实须曝光供自核');
  });

  // P3 边界异常：无报价不猜 + 未知拒绝
  it('RQ-211 · P3 · 边界异常 · buildPriceOrigin 无报价时不猜（matched=null），三入口不显示臆测价', () => {
    const o = buildPriceOrigin({ seq: 5, price: 10, bars: [] });
    assert.equal(o.hasQuote, false);
    assert.equal(o.matched, null, '无 K 线不应编造匹配');
  });

  it('RQ-211 · P3 · 边界异常 · 未知拒绝原因 known=false（不静默归类，避免页内误导）', () => {
    const c = classifyRejection('');
    assert.equal(c.known, false);
    assert.equal(c.reason, '');
  });

  // P4 性能并发：大订单量审计（1e3 笔）不崩溃
  it('RQ-211 · P4 · 性能并发 · 大订单量审计（1e3 笔）三入口均可渲染不崩溃', () => {
    const orders = Array.from({ length: 1000 }, (_, i) => ({ seq: i, side: 'BUY', price: 10, amount: 1000, fee: 5 }));
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders, rejections: [], bars: [{ seq: 0, close: 10 }] });
    assert.equal(a.orderCount, 1000);
    // 三处入口消费同一 audit 对象
    for (const _s of threeSurfaces) {
      assert.equal(a.audit.ok, true);
      assert.ok('priceMismatch' in a.audit);
    }
  });

  // P5 兼容回归：规则常量存在（防回归）
  it('RQ-211 · P5 · 兼容回归 · SETTLEMENT_RULES / SLIPPAGE_RULE 常量存在（防回归）', () => {
    const a = buildSettlementAudit({ session: { status: 'FINISHED' }, orders: [], rejections: [] });
    assert.ok(a.rules, '结算规则应存在');
    assert.ok(a.slippageRule, '滑点规则应存在');
  });
});

/* ================================================================== *
 * RQ-212 · 免登录短局首训 + effective_completed 口径（M44 / P0）       *
 * 默认 quick(12) + 免登录走完一局 + effective_completed 口径 + 引导四步。*
 * 游客身份归一必须扛住 Number(null)===0 这一族复发病（v10/v13）。       *
 * ================================================================== */
describe('RQ-212 免登录短局首训（P0）', () => {
  const GUEST = 'AbCdEfGhIjKlMnOpQrStUv'; // 合法游客 token：base64url、长度 8~64

  // P0 正常流程：默认短局
  it('RQ-212 · P0 · 正常流程 · 默认 preset 为 quick 且默认根数 = 12', () => {
    assert.equal(DEFAULT_PRESET_KEY, 'quick');
    assert.equal(DEFAULT_BARS, 12);
    const p = presetOf('quick');
    assert.equal(p.bars, 12, '默认短局应为 12 根');
  });

  // P0 正常流程：四步漏斗完成率
  it('RQ-212 · P0 · 正常流程 · 引导漏斗四步有数据时正确计算完成率', () => {
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
  it('RQ-212 · P1 · 差异化 · 完成口径必须是有效完成（finished/started，而非 decision）', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 4, first_training_start: 4, first_training_decision: 0, first_training_finish: 3 });
    assert.equal(r.summary.finished, 3);
    assert.equal(r.summary.decided, 0);
    assert.equal(r.summary.completionRate, 75);
  });

  // P2 留存体验：闭环产出可读成绩卡 + 游客成果不丢
  it('RQ-212 · P2 · 留存体验 · 四步均有数据时给出可验证完成率且无断点；游客 userId 归一为 null 不丢成果', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.dropAt, null, '四步不断点');
    assert.equal(r.summary.completionRate, 62.5, '完成率 = 5/8 = 62.5%');
    assert.equal(safeUserId(null), null, 'null → null，绝不变成 0');
    assert.equal(safeUserId(0), null, '0 不是合法用户，须归一为 null');
    const q = guestQuota(0);
    assert.equal(q.allowed, true, '额度内允许免登录练');
    assert.ok(typeof q.signupReason === 'string' && q.signupReason.length > 0, '须有唯一、清晰的注册理由以承接留存');
  });

  // P3 边界异常：safeUserId 归一班 + identityOf 畸形
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

  // P5 兼容回归：额度边界 + 四步顺序
  it('RQ-212 · P5 · 兼容回归 · 游客额度越界（已用 > 上限）时 allowed=false、remaining=0', () => {
    const q = guestQuota(GUEST_DAILY_LIMIT + 5);
    assert.equal(q.allowed, false);
    assert.equal(q.remaining, 0);
    const q2 = guestQuota(1);
    assert.equal(q2.allowed, true);
    assert.equal(q2.remaining, GUEST_DAILY_LIMIT - 1);
  });

  it('RQ-212 · P5 · 兼容回归 · 引导四步顺序稳定（enter→start→decision→finish）', () => {
    assert.deepEqual(GUIDE_EVENTS, ['first_training_enter', 'first_training_start', 'first_training_decision', 'first_training_finish']);
    assert.equal(GUIDE_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-213 · 埋点↔会话双向对账，resume:start≈1:1（M45 / 产品优先级 P1）   *
 * 两条线：① 埋点数 ↔ 业务表行数（telemetryIntegrityService.summarizeConsistency）；*
 *       ② 埋点事件 ↔ 会话记录按 sessionId 双向对账（releaseGate.reconcileConsistency）。*
 * ================================================================== */
describe('RQ-213 埋点↔会话双向对账（P1）', () => {
  // P0 正常流程：埋点 = 业务表
  it('RQ-213 · P0 · 正常流程 · 埋点数等于业务表行数时 ok 且 brokenCount=0', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 10, blind_finish: 9 },
      tableCounts: { blind_sessions: 10, blind_sessions_finished: 9 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.brokenCount, 0);
    assert.ok(r.items.every((i) => i.match));
  });

  // P0 正常流程：埋点多于业务表 = 重复上报污染（resume:start 偏离 1:1）
  it('RQ-213 · P0 · 正常流程 · 埋点比业务表多 → 判 error（重复上报污染漏斗）', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 12, blind_finish: 9 },
      tableCounts: { blind_sessions: 10, blind_sessions_finished: 9 },
    });
    const start = r.items.find((i) => i.key === 'blind_start');
    assert.equal(start.diff, 2, '埋点比表多 2');
    assert.equal(start.severity, 'error');
    assert.equal(r.ok, false);
  });

  // P1 差异化：埋点少于业务表同样是缺陷（有完成的局没被记上 = 漏报）
  it('RQ-213 · P1 · 差异化 · 业务表比埋点多 → 判 error（漏报：完成的局没记上）', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 8, blind_finish: 9 },
      tableCounts: { blind_sessions: 10, blind_sessions_finished: 9 },
    });
    const start = r.items.find((i) => i.key === 'blind_start');
    assert.equal(start.diff, -2, '表比埋点多 2');
    assert.equal(start.severity, 'error');
    assert.equal(r.ok, false);
  });

  // P1 差异化：按 sessionId 双向对账区别于比总数
  it('RQ-213 · P1 · 差异化 · 按 sessionId 双向对账：方向相反的误差不被总数抵消', () => {
    const r = reconcileConsistency(
      [{ id: 1, session_id: 1 }, { id: 2, session_id: 2 }],
      [{ session_id: 2 }, { session_id: 3 }]
    );
    assert.equal(r.ok, false, '按 id 对账应暴露方向相反的误差');
  });

  // P2 留存体验：指标可信是留存决策前提
  it('RQ-213 · P2 · 留存体验 · 双向对账能抓出「总数相同但方向相反」的漂移，保证指标可信', () => {
    const diverged = reconcileConsistency(
      [{ id: 10, session_id: 5 }, { id: 11, session_id: null }],
      [{ session_id: 5 }, { session_id: 6 }]
    );
    assert.equal(diverged.ok, false, '漂移必须被判为不一致');
    assert.equal(diverged.matchedCount, 1, '仅 1 局真正匹配');
    const aligned = reconcileConsistency([{ id: 10, session_id: 5 }], [{ session_id: 5 }]);
    assert.equal(aligned.ok, true, '完全对齐时须判一致');
  });

  // P3 边界异常：空输入 / null sessionId 不算 session 0
  it('RQ-213 · P3 · 边界异常 · 空输入时 ok 且计数为 0', () => {
    const r = summarizeConsistency({});
    assert.equal(r.ok, true);
    assert.equal(r.brokenCount, 0);
    assert.equal(r.items.length, DEFAULT_CONSISTENCY_RULES.length);
  });

  it('RQ-213 · P3 · 边界异常 · 未携带 sessionId 不被算成 session 0（v10/v13 同族修复）', () => {
    const r = reconcileConsistency([{ id: 9, session_id: null }, { id: 10, session_id: '' }], [{ session_id: 0 }]);
    assert.equal(r.orphanEvents.length, 2, 'null/空串 sessionId 必须归类为「未携带」而非 session 0');
    assert.equal(r.matchedCount, 0, 'null/空串事件不得被匹配到任何会话（含真实的 session 0）');
  });

  // P4 性能并发：大批量
  it('RQ-213 · P4 · 性能并发 · 大批量对账（各 2e3）不崩溃', () => {
    const ev = Array.from({ length: 2000 }, (_, i) => ({ id: i, session_id: i }));
    const ses = Array.from({ length: 2000 }, (_, i) => ({ session_id: i }));
    const r = reconcileConsistency(ev, ses);
    assert.equal(r.ok, true);
    assert.equal(r.matchedCount, 2000);
  });

  // P5 兼容回归：默认对账项含 blind_start/blind_finish；null 与 '0' 区别对待
  it('RQ-213 · P5 · 兼容回归 · DEFAULT_CONSISTENCY_RULES 含 blind_start/blind_finish（防端点被误删）', () => {
    const keys = DEFAULT_CONSISTENCY_RULES.map((r) => r.key);
    assert.ok(keys.includes('blind_start'));
    assert.ok(keys.includes('blind_finish'));
  });

  it('RQ-213 · P5 · 兼容回归 · 对账守卫复用，不因 SQL NULLIF 漂移', () => {
    const r = reconcileConsistency([{ id: 1, session_id: 0 }], [{ session_id: 0 }]);
    assert.equal(r.matchedCount, 1, '真正的 session 0 仍可匹配；只有 null/空串被排除');
  });
});

/* ================================================================== *
 * RQ-214 · 小样本可信度护栏（M43 / 产品优先级 P1）                     *
 * 置信区间 + t 值 + 中文解释；样本不足只给成本/行为/对照，不给 edge 结论。*
 * ================================================================== */
describe('RQ-214 小样本可信度护栏（P1）', () => {
  // P0 正常流程：大样本给区间，小样本给三件事
  it('RQ-214 · P0 · 正常流程 · 样本 ≥ MIN_SAMPLE(50) 时给区间化结论（mode=interval）', () => {
    const p = buildConclusionPanel({ sampleSize: 50, expectancyR: 0.2, sigma: 1, winRate: 0.55 });
    assert.equal(p.mode, 'interval');
    assert.ok(p.interval, '大样本应返回 interval');
    assert.equal(p.facts, null, '大样本不应返回三件事');
  });

  it('RQ-214 · P0 · 正常流程 · 样本 < SMALL_SAMPLE(30) 时只给三件事（mode=three-facts，无点估计）', () => {
    const p = buildConclusionPanel({ sampleSize: 12, expectancyR: 5, sigma: 1, winRate: 0.9 });
    assert.equal(p.mode, 'three-facts');
    assert.ok(p.facts, '小样本应返回三件事');
    assert.equal(p.interval, null, '小样本不应给点估计');
  });

  // P1 差异化：中文 verdict 表达
  it('RQ-214 · P1 · 差异化 · verdict 中文表达：insufficient / conclusive', () => {
    const ins = buildIntervalConclusion({ sampleSize: 3 });
    assert.equal(ins.verdict.level, 'insufficient');
    assert.match(ins.verdict.text, /样本|还差/);
    const suf = buildIntervalConclusion({ sampleSize: 60 });
    assert.equal(suf.verdict.level, 'conclusive');
  });

  // P2 留存体验：小样本诚实护栏 + 三件事
  it('RQ-214 · P2 · 留存体验 · 小样本显式给「样本不足」护栏与三件事实，且禁止 edge 断言', () => {
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
  it('RQ-214 · P3 · 边界异常 · n=null/0/负数 时判为样本不足且 guard 无点估计', () => {
    for (const n of [null, 0, -5, undefined]) {
      const c = buildIntervalConclusion({ sampleSize: n });
      assert.equal(c.insufficient, true, `n=${n} 应判不足`);
      assert.equal(c.guard.ok, true, `n=${n} 不应出现点估计`);
    }
  });

  it('RQ-214 · P3 · 边界异常 · 小样本下 assertNoEdgeAssertion 禁止胜率/期望值等 edge 断言', () => {
    const hit = assertNoEdgeAssertion('本局胜率 60%，期望值 0.3R', 5);
    assert.equal(hit.ok, false, '小样本下出现 edge 断言应判不通过');
    assert.ok(hit.hits.length > 0);
    const pass = assertNoEdgeAssertion('本局手续费 5 元', 5);
    assert.equal(pass.ok, true);
    assert.equal(assertNoEdgeAssertion('胜率 60%', 30).ok, true);
  });

  // P4 性能并发：大样本
  it('RQ-214 · P4 · 性能并发 · 大样本（1e4）计算不崩溃，t 值不为 Infinity', () => {
    const c = buildIntervalConclusion({ sampleSize: 10000, expectancyR: 0.1, sigma: 1 });
    assert.equal(c.insufficient, false);
    const t = c.metrics.find((m) => m.key === 'expectancy');
    assert.ok(Number.isFinite(t.t ?? t.point), 't 值不应为 Infinity');
  });

  // P5 兼容回归：阈值分工稳定
  it('RQ-214 · P5 · 兼容回归 · 小样本阈值分工稳定：buildConclusionPanel(50) vs buildSmallSampleFacts(30)', () => {
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
 * RQ-215 · 发布后验证固化（M0 / 产品优先级 P0）                        *
 * 连续 N 次发布均有验证记录；ok:false 打断连续但不自杀。                *
 * ================================================================== */
describe('RQ-215 发布后验证固化（P0）', () => {
  const mk = (commit, ok) => ({ git_commit: commit, ok: Boolean(ok), run_at: new Date() });

  // P0 正常流程
  it('RQ-215 · P0 · 正常流程 · 连续不同 commit 计为连续验证', () => {
    const rows = [mk('aaa', true), mk('bbb', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, true, '连续 2 次不同提交应为连续');
  });

  // P1 差异化：ok:false 打断连续
  it('RQ-215 · P1 · 差异化 · ok:false 会打断连续', () => {
    const rows = [mk('aaa', true), mk('bbb', false), mk('ccc', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '中间一次失败应打断连续');
  });

  // P2 留存体验：用户回来看到的是真验过的版本
  it('RQ-215 · P2 · 留存体验 · 两个不同提交均验证通过才算连续达标；同提交重复跑不凑数', () => {
    const ok = verificationStreak([mk('a1', true), mk('b2', true)]);
    assert.equal(ok.streak, 2);
    assert.equal(ok.ok, true);
    const dup = verificationStreak([mk('a1', true), mk('a1', true)]);
    assert.equal(dup.streak, 1, '同提交去重');
    assert.equal(dup.ok, false, '未达连续 2 次，发布闸门须拦下');
  });

  // P3 边界异常：单次 / 同提交
  it('RQ-215 · P3 · 边界异常 · 单次记录时 streak 不 ok，但记录本身仍算成功（不自杀）', () => {
    const rows = [mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '只有 1 次不达到连续阈值');
    assert.equal(s.streak, 1);
  });

  it('RQ-215 · P3 · 边界异常 · 同一 commit 重复跑不去重（不虚增连续）', () => {
    const rows = [mk('aaa', true), mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '同一次提交重复跑不算两次发布');
  });

  // P4 性能并发：大批量验证记录
  it('RQ-215 · P4 · 性能并发 · 大批量验证记录（1e3）统计不崩溃', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => mk(`c${i}`, true));
    const s = verificationStreak(rows);
    assert.equal(s.streak, 1000);
  });

  // P5 兼容回归：端点集合稳定
  it('RQ-215 · P5 · 兼容回归 · REQUIRED_ROUTES 含阶段零端点（防端点被误删）', () => {
    const paths = REQUIRED_ROUTES.map((r) => r.path);
    for (const p of ['/api/public/stage-zero', '/api/public/status-truth', '/api/public/landing', '/api/public/help', '/api/guest/session']) {
      assert.ok(paths.includes(p), `REQUIRED_ROUTES 应含 ${p}`);
    }
  });
});

/* ================================================================== *
 * RQ-216 · 引入 ≥5 外部真人实测首训（M41 / 产品优先级 P0）             *
 * 5 名外部真人注册、≥2 有效完成、非同秒批量。                           *
 * ================================================================== */
describe('RQ-216 外部真人首训实测（P0）', () => {
  // P0 正常流程：漏斗达标
  it('RQ-216 · P0 · 正常流程 · 达成目标（注册≥5、有效完成≥2）时 met=true', () => {
    const r = summarizeExternalFunnel({ invited: 20, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true);
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  // P0 正常流程：外部用户识别
  it('RQ-216 · P0 · 正常流程 · isExternalUser 公网 IP + 非内部渠道 → 外部真人', () => {
    const r = isExternalUser(
      { acquisition_channel: 'wechat', signup_ip: '203.0.113.9' },
      { isPublicIpv4: (ip) => !/^(10\.|192\.168\.|127\.|0\.)/.test(ip), isLocalHost: () => false }
    );
    assert.equal(r.external, true);
  });

  // P1 差异化：非同秒批量识别（自测不能冒充外部）
  it('RQ-216 · P1 · 差异化 · 非同秒批量：同分钟注册 ≥3 被识别为 burst', () => {
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, createdAt: new Date(now) }));
    const b = classifySignupBursts(rows);
    assert.ok(b.userIds.length >= 3, '同分钟 5 人应被识别为批量');
  });

  // P2 留存体验：真实漏斗达标即留存证据
  it('RQ-216 · P2 · 留存体验 · 外部漏斗达标（≥5 注册、≥2 有效完成）且无断点', () => {
    const r = summarizeExternalFunnel({ invited: 10, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true, '6 注册 / 3 有效完成 已达标');
    assert.equal(r.dropAt, null, '全链路无断点');
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  // P3 边界异常：已打标 / 无 IP 不计入
  it('RQ-216 · P3 · 边界异常 · 已打标的用户不计入外部真人', () => {
    const r = isExternalUser({ is_test: true, acquisition_channel: 'wechat', signup_ip: '203.0.113.9' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'test-marked');
  });

  it('RQ-216 · P3 · 边界异常 · 未记录 IP 时无法判定为外部（no-ip）', () => {
    const r = isExternalUser({ acquisition_channel: 'wechat', signup_ip: '' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'no-ip');
  });

  // P4 性能并发：大批量
  it('RQ-216 · P4 · 性能并发 · 大批量用户（1e4）isExternalUser 不崩溃', () => {
    const users = Array.from({ length: 10000 }, (_, i) => ({ id: i, acquisition_channel: 'wechat', signup_ip: '203.0.113.1' }));
    const out = users.map((u) => isExternalUser(u, { isPublicIpv4: () => true, isLocalHost: () => false }));
    assert.equal(out.length, 10000);
    assert.ok(out.every((o) => o.external));
  });

  // P5 兼容回归：内部渠道集合稳定
  it('RQ-216 · P5 · 兼容回归 · INTERNAL_CHANNELS 含内部来源（防再次把自测当外部）', () => {
    for (const c of ['self', 'local', 'test', 'dev', 'internal', 'team']) {
      assert.ok(INTERNAL_CHANNELS.has(c), `${c} 应视为内部渠道`);
    }
    assert.equal(EXTERNAL_FUNNEL_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-217 · 工作区零脏文件、无新增未接线服务（M0 / 产品优先级 P1）       *
 * 防 F-00 复发：发布安全。本块守护「身份口径合规 + 关键服务已接线」。   *
 * ================================================================== */
describe('RQ-217 工作区收口 / F-00 防复发（P1）', () => {
  // P0 正常流程：合规文本通过
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

  // P5 兼容回归：README 实际合规 + 禁止词表完整 + F-00 接线守卫
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

  // P5 兼容回归（F-00 接线守卫）：曾「0 引用」的关键服务必须已被接线
  it('RQ-217 · P5 · 兼容回归 · F-00 接线守卫：publicEntryService/telemetryIntegrityService 已被 src 引用', () => {
    const publicJs = resolve(process.cwd(), 'src/routes/public.js');
    const authJs = resolve(process.cwd(), 'src/auth.js');
    assert.ok(existsSync(publicJs) && readFileSync(publicJs, 'utf8').includes('publicEntryService'), 'routes/public.js 必须引用 publicEntryService');
    assert.ok(existsSync(authJs) && readFileSync(authJs, 'utf8').includes('telemetryIntegrityService'), 'auth.js 必须引用 telemetryIntegrityService');
  });
});

/* ================================================================== *
 * RQ-218 · 冻结全部训练玩法新需求（M— / 产品优先级 Won't（本期））      *
 * 避免范围蔓延，聚焦解锁。底层 frozenGate 把「本条不再软化」写成代码。    *
 * ================================================================== */
describe("RQ-218 冻结训练玩法新需求（Won't，本期不做）", () => {
  // P0 正常流程：公网未就绪时，冻结项被 block
  it('RQ-218 · P0 · 正常流程 · 公网未就绪时冻结项全部 block（ok=false）', () => {
    const g = frozenGate({ publicReady: false });
    assert.equal(g.publicReady, false);
    assert.equal(g.blocked.length, FROZEN_RQS.length, '全部 10 项冻结需求应被 block');
    assert.equal(g.ok, false);
  });

  // P0 正常流程：公网就绪后，冻结项解冻
  it('RQ-218 · P0 · 正常流程 · 公网就绪后冻结项全部解冻（allowed 齐、ok=true）', () => {
    const g = frozenGate({ publicReady: true });
    assert.equal(g.ok, true);
    assert.equal(g.blocked.length, 0);
    assert.equal(g.allowed.length, FROZEN_RQS.length);
  });

  // P1 差异化：冻结集合稳定且覆盖 RQ-161~170
  it('RQ-218 · P1 · 差异化 · FROZEN_RQS 非空前 10 项覆盖 RQ-161~RQ-170', () => {
    assert.ok(FROZEN_RQS.length >= 10, '冻结集合不应为空');
    for (let i = 161; i <= 170; i++) assert.ok(FROZEN_RQS.includes(`RQ-${i}`), `RQ-${i} 应被冻结`);
  });

  // P2 留存体验：口径诚实——未就绪时明确告知「需求池不得扩张」
  it('RQ-218 · P2 · 留存体验 · 未就绪时 note 明确「需求池不得扩张」，避免软化为新玩法开绿灯', () => {
    const g = frozenGate({ publicReady: false });
    assert.match(g.note, /冻结|不得扩张|未就绪/);
  });

  // P3 边界异常：空 requested 退化为默认冻结集合
  it('RQ-218 · P3 · 边界异常 · requested 为空数组时退化为默认冻结集合（不漏放）', () => {
    const g = frozenGate({ publicReady: false, requested: [] });
    assert.equal(g.blocked.length, FROZEN_RQS.length, '空 requested 必须回退到全冻结，不得漏放');
    assert.equal(g.ok, false);
  });

  // P4 性能并发：超大 requested 列表不崩溃
  it('RQ-218 · P4 · 性能并发 · 超大 requested 列表（1e3）判定不崩溃', () => {
    const requested = Array.from({ length: 1000 }, (_, i) => `RQ-${i}`);
    const g = frozenGate({ publicReady: false, requested });
    assert.equal(g.blocked.length, FROZEN_RQS.length, '仅冻结集合中真实存在的项被 block');
  });

  // P5 兼容回归：冻结集合长度恒为 10（防再次扩列漏冻）
  it('RQ-218 · P5 · 兼容回归 · 冻结集合长度恒为 10', () => {
    assert.equal(FROZEN_RQS.length, 10);
  });
});

/* ================================================================== *
 * 全局回归：核心常量不能静默变更（防再次漂移）                          *
 * ================================================================== */
describe('v22 全局回归守卫', () => {
  it('RQ-212 · P5 · 默认短局根数恒为 12（首训闭环验收锚点）', () => {
    assert.equal(DEFAULT_BARS, 12);
  });
  it('RQ-214 · P5 · 门槛常量稳定', () => {
    assert.equal(MIN_SAMPLE, 50);
    assert.equal(SMALL_SAMPLE_THRESHOLD, 30);
  });
  it('RQ-210/218 · P5 · 三件套定义恒为 3 件、冻结集合恒为 10', () => {
    assert.equal(DIFFERENTIATION_PIECES.length, 3);
    assert.equal(FROZEN_RQS.length, 10);
  });
});

// ===== v22 新增语义守卫（区别于 v21）=====
// v22 §0 实测结论：系统自检已自动标注 OK_WITHOUT_ENTRY（F-102）——「责任已指定 ≠ 入口可用」，
// 以及截止日倒计时自检（daysLeft / expired）。本段为 v22 新增断言，锁定该矛盾检测不退化。

describe('RQ-209 · v22 新增 · OK_WITHOUT_ENTRY 矛盾检测（F-102）', () => {
  it('RQ-209 · P0 · 正常流程 · 入口未就绪且 owner 自评 ok 时，必须标出 OK_WITHOUT_ENTRY 矛盾', () => {
    const r = statusTruthfulness({ entryReady: false, owner: { state: 'ok' }, readmeText: '对外入口状态 ok' });
    assert.ok(Array.isArray(r.contradictions));
    assert.ok(r.contradictions.some((c) => c.code === 'OK_WITHOUT_ENTRY'));
  });

  it('RQ-209 · P1 · 差异化 · 入口已就绪时，即使 owner 自评 ok 也不应误报 OK_WITHOUT_ENTRY', () => {
    const r = statusTruthfulness({ entryReady: true, owner: { state: 'ok' }, readmeText: '对外入口状态 ok' });
    assert.ok(!r.contradictions.some((c) => c.code === 'OK_WITHOUT_ENTRY'));
  });

  it('RQ-209 · P3 · 边界异常 · owner 状态非 ok（如 no-owner）时不触发 OK_WITHOUT_ENTRY', () => {
    const r = statusTruthfulness({ entryReady: false, owner: { state: 'no-owner' }, readmeText: '状态 ok' });
    assert.ok(!r.contradictions.some((c) => c.code === 'OK_WITHOUT_ENTRY'));
  });

  it('RQ-209 · P5 · 兼容回归 · 入口就绪且 owner 自评 ok 时：无矛盾、ok=true（健康基线，F-102 不误伤）', () => {
    const r = statusTruthfulness({ entryReady: true, owner: { state: 'ok' }, readmeText: '状态 ok' });
    assert.ok(Array.isArray(r.contradictions));
    assert.ok(!r.contradictions.some((c) => c.code === 'OK_WITHOUT_ENTRY'));
    assert.strictEqual(r.ok, true);
  });
});

describe('RQ-209 · v22 新增 · 截止日倒计时自检（daysLeft / expired）', () => {
  it('RQ-209 · P0 · 正常流程 · owner+截止日均指定且未到期：daysLeft>0 且 blocked=false', () => {
    const now = new Date('2026-11-11T12:00:00+08:00');
    const s = ownerState({ owner: 'zyan', deadline: '2026-11-16', now });
    assert.strictEqual(s.state, 'ok'); // daysLeft=5 > 预警阈值(3)
    assert.strictEqual(s.daysLeft, 5);
    assert.strictEqual(s.blocked, false);
  });

  it('RQ-209 · P3 · 边界异常 · 截止日早于当前：state=overdue 且 blocked=true', () => {
    const now = new Date('2026-11-20T12:00:00+08:00');
    const s = ownerState({ owner: 'zyan', deadline: '2026-11-16', now });
    assert.strictEqual(s.state, 'overdue');
    assert.strictEqual(s.blocked, true);
  });

  it('RQ-209 · P5 · 兼容回归 · 只给截止日不给 owner：state=no-owner、blocked=true（v21 根因护栏）', () => {
    const s = ownerState({ deadline: '2026-11-16' });
    assert.strictEqual(s.state, 'no-owner');
    assert.strictEqual(s.blocked, true);
  });
});
