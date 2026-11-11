/**
 * v23 需求实现与测试覆盖矩阵（RQ-209 ~ RQ-218）
 *
 * 本文件对应「产品需求表 · 赚了一个小目标」v23（2026-11-12）§5 需求表（10 项，RQ-209~218）。
 * v23 在 v22 基础上**重新洗牌了 RQ-209~218 的内容映射**，并新增两个此前未被覆盖的需求：
 *   - RQ-216 首训有效完成率 >0  → effectiveCompletionService（v22 未覆盖）
 *   - RQ-218 活动恢复监控(最后事件<12h 告警) → activityRegressionService（v22 未覆盖）
 * 同时 RQ-214 由 P1 升为 P0，且验收明确要求「verifyRelease.js 含埋点/会话一致性断言 + 连续两次留痕」，
 * 故本版对 RQ-214 额外断言 verifyRelease 确实导出 checkConsistency / checkTelemetry。
 *
 * 六档测试级别约定（沿 v7 起，P3/P4/P5 是**测试级别**而非产品优先级）：
 *   P0 主流程        —— 需求核心路径
 *   P1 差异化         —— 与竞品/旧口径的差异点
 *   P2 留存体验       —— 用户投入前/后的体验护栏
 *   P3 边界异常       —— 空值/越界/缺失/畸形输入（含历史高频复发病：Number(null)===0）
 *   P4 性能并发       —— 大样本/批量/高吞吐
 *   P5 兼容回归       —— 历史遗留口径/旧字段/防再次漂移/常量稳定性
 *
 * 产品优先级（来自 v23 需求表）：P0 = {209,210,211,212,214,216}；P1 = {213,215,217}；P2 = {218}。
 * 测试级别（P0~P5）为测试侧扩展，覆盖每条需求的正常/边界/异常。两者在矩阵文档中分别列示。
 *
 * 运行：node --test tests/unit/v23Requirements.test.js
 * 回归：node --test tests/unit/v18Requirements.test.js tests/unit/v19RequirementsP2.test.js tests/unit/v20Requirements.test.js tests/unit/v21Requirements.test.js tests/unit/v22Requirements.test.js tests/unit/v23Requirements.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  statusTruthfulness,
} from '../../src/services/stageZeroService.js';
import { summarizeGuideFunnel, GUIDE_STEPS, GUIDE_EVENTS } from '../../src/services/firstTrainingService.js';
import { DEFAULT_PRESET_KEY, DEFAULT_BARS, presetOf } from '../../src/services/sessionLengthService.js';
import { identityOf, safeUserId, guestQuota, GUEST_DAILY_LIMIT } from '../../src/services/guestService.js';
import {
  classifySignupBursts,
  isExternalUser,
  summarizeExternalFunnel,
  EXTERNAL_FUNNEL_STEPS,
  INTERNAL_CHANNELS,
} from '../../src/services/testTrafficService.js';
import {
  evaluateEffectiveCompletion,
  effectiveCompletionRate,
  allowFinishTelemetry,
  planEmptyRunFlag,
  EFFECTIVE_RULES,
} from '../../src/services/effectiveCompletionService.js';
import { reconcileConsistency, verificationStreak } from '../../src/services/releaseGateService.js';
import { summarizeConsistency, DEFAULT_CONSISTENCY_RULES } from '../../src/services/telemetryIntegrityService.js';
import { REQUIRED_ROUTES, checkConsistency, checkTelemetry, checkVerificationRecord } from '../../src/scripts/verifyRelease.js';
import { checkIdentityWording, FORBIDDEN_WORDINGS, REQUIRED_PHRASES } from '../../src/services/identityWordingService.js';
import { assessActivityRegression, ACTIVITY_RULES } from '../../src/services/activityRegressionService.js';

/* v23 需求 → 底层服务 / 旧编号映射（本文件覆盖目标）
 * RQ-209 公网入口(P0)        ← publicEntryService + publicAccessService   (旧 RQ-209)
 * RQ-210 落地页(P0)          ← stageZeroService                         (旧 RQ-210)
 * RQ-211 首训埋点四步(P0)    ← firstTraining/guest/sessionLength         (旧 RQ-211/212)
 * RQ-212 外部真人(P0)        ← testTrafficService                        (旧 RQ-213)
 * RQ-213 度量对账(P1)        ← telemetryIntegrityService + releaseGate   (旧 RQ-215)
 * RQ-214 发布验证固化(P0)    ← releaseGateService + verifyRelease        (旧 RQ-216，升 P0)
 * RQ-215 身份叙事纠偏(P1)    ← identityWordingService                    (旧 RQ-217 上半)
 * RQ-216 首训有效完成率>0(P0)← effectiveCompletionService                (新增，v22 未覆盖)
 * RQ-217 F-00 防复发(P1)     ← identityWordingService + 接线守卫         (旧 RQ-217 下半)
 * RQ-218 活动恢复监控(P2)    ← activityRegressionService                 (新增，v22 未覆盖)
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
 * ================================================================== */
describe('RQ-209 公网入口（P0）', () => {
  it('RQ-209 · P0 · 正常流程 · 三处文件齐 + owner/截止均指定 + smoke 实测时 ready:true 且 checklist 全 done', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
    assert.equal(r.audit.ready, true, 'audit 层应全 done');
    assert.equal(r.owner.blocked, false, 'owner/deadline 齐备不应 block');
    assert.equal(r.ready, true, '对外口径应判为真正就绪');
    assert.ok(r.audit.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.gate.blocked.length, 0, '公网就绪后冻结项应解冻');
  });

  it('RQ-209 · P0 · 边界异常 · 未配置 PUBLIC_BASE_URL 时 ready:false 且有阻断项', () => {
    const r = summarizePublicEntry({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.length > 0, '未配置时必须给出阻断项');
  });

  it('RQ-209 · P1 · 差异化 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/train\.example\.com/g, 'other.example.com');
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: nginx, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('server_name') && b.includes('一致')));
  });

  it('RQ-209 · P1 · 差异化 · 三处文件齐但 owner 缺失时 owner.blocked=true（根因护栏）', () => {
    const env = 'PUBLIC_BASE_URL=https://train.example.com\nPUBLIC_ENTRY_DEADLINE=2026-11-16\n';
    const r = summarizePublicEntry({ envText: env, nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.owner.state, 'no-owner', '有截止无 owner 应判 no-owner');
    assert.equal(r.owner.blocked, true, 'no-owner 必须 block');
    assert.equal(r.ready, false, 'owner 缺失即使三处文件齐也不算就绪');
  });

  it('RQ-209 · P2 · 留存体验 · 三处文件全缺失时诚实报 ready:false 并给出待办清单', () => {
    const r = summarizePublicEntry({ envText: '', nginxText: '', readmeText: '访问 http://localhost:8080', now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.length > 0, '未配置时必须有阻断项');
    assert.ok(r.audit.pending.length > 0, '必须给出可执行的待办清单');
    assert.ok(r.audit.note.includes('不可达'), '口径须明确「不可达」');
  });

  it('RQ-209 · P3 · 边界异常 · PUBLIC_BASE_URL 指向 localhost 被识别为本机/内网，外部不可达', () => {
    const r = summarizePublicEntry({ envText: 'PUBLIC_BASE_URL=http://localhost:8080\n', nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('本机') || b.includes('内网')));
  });

  it('RQ-209 · P4 · 性能并发 · 连续 1000 次审计调用稳定返回', () => {
    let okCount = 0;
    for (let i = 0; i < 1000; i++) {
      const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
      if (r.ready === true) okCount++;
    }
    assert.equal(okCount, 1000, '配置齐全时应始终返回 ready:true');
  });

  it('RQ-209 · P5 · 兼容回归 · README 仍以 localhost 为唯一入口时触发 readme 阻断', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。', now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('README') || b.includes('入口')));
  });
});

/* ================================================================== *
 * RQ-210 · 免登录落地页（M41 / 产品优先级 P0）                         *
 * ================================================================== */
describe('RQ-210 免登录落地页（P0）', () => {
  const fullElements = LANDING_ELEMENTS.map((e) => e.key);
  const goodPath = clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }]);

  it('RQ-210 · P0 · 正常流程 · 三要素齐备 + 未登录可进入 + ≤2 点击时落地页合格', () => {
    const r = auditLanding({ elements: fullElements, pathCost: goodPath, guestTrainable: true });
    assert.equal(r.ok, true);
    assert.equal(r.guestTrainable, true);
    assert.ok(r.clicks <= MAX_FIRST_VISIT_CLICKS);
  });

  it('RQ-210 · P0 · 正常流程 · buildLandingCopy 必须包含三件套（differentiators），首访即见差异化', () => {
    const copy = buildLandingCopy({});
    assert.ok(Array.isArray(copy.differentiators) && copy.differentiators.length === 3, '落地页须显式暴露可核对/可信度/保留期三件套');
    const keys = copy.differentiators.map((d) => d.key).sort();
    assert.deepEqual(keys, ['checkable', 'confidence', 'retention']);
  });

  it('RQ-210 · P1 · 差异化 · 首访文案显式给出「不注册也能练」与保留期承诺', () => {
    const r = buildLandingCopy({ guestLimit: 5, guestDays: 7, userRetention: '长期保留' });
    const register = r.elements.find((e) => e.key === 'register');
    const retention = r.elements.find((e) => e.key === 'retention');
    assert.ok(register && register.body.includes('不注册'), '注册栏须明示可免登录');
    assert.ok(retention && retention.body.includes('保留'), '保留期承诺须可读');
    assert.equal(r.differentiators.length, 3, '三件套必须前置曝光');
  });

  it('RQ-210 · P2 · 留存体验 · 首访文案含「不注册也能练」+保留期+三件套（承诺前置）', () => {
    const r = buildLandingCopy({ guestLimit: 5, guestDays: 7, userRetention: '长期保留' });
    const register = r.elements.find((e) => e.key === 'register');
    const retention = r.elements.find((e) => e.key === 'retention');
    assert.ok(register && register.body.includes('不注册'));
    assert.ok(retention && retention.body.includes('保留'));
    assert.equal(r.differentiators.length, 3);
  });

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

  it('RQ-210 · P4 · 性能并发 · 批量 buildLandingCopy 1000 次稳定', () => {
    const out = Array.from({ length: 1000 }, () => buildLandingCopy({}));
    assert.equal(out.length, 1000);
    assert.ok(out.every((c) => c.differentiators.length === 3));
  });

  it('RQ-210 · P5 · 兼容回归 · 落地页不得把 localhost 当唯一入口（防再次漂移）', () => {
    const copy = buildLandingCopy({});
    const text = JSON.stringify(copy);
    assert.ok(!/https?:\/\/localhost/.test(text), '落地页文案不应出现 localhost 作为入口');
  });
});

/* ================================================================== *
 * RQ-211 · 首训埋点 first_training_* 四步全链路（M42 / 产品优先级 P0） *
 * 可观测「第一次训练能否发生」：外部用户触发后四步埋点均有真实数据。      *
 * ================================================================== */
describe('RQ-211 首训埋点四步全链路（P0）', () => {
  it('RQ-211 · P0 · 正常流程 · 四步有数据时正确计算进入/开始/完成与完成率', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.summary.entered, 10);
    assert.equal(r.summary.started, 8);
    assert.equal(r.summary.finished, 5);
    assert.equal(r.summary.decided, 6);
    assert.equal(r.summary.completionRate, 62.5);
    assert.equal(r.dropAt, null, '四步有数据不应有断点');
  });

  it('RQ-211 · P0 · 正常流程 · 完成口径必须是有效完成（finished/started，而非 decision）', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 4, first_training_start: 4, first_training_decision: 0, first_training_finish: 3 });
    assert.equal(r.summary.finished, 3);
    assert.equal(r.summary.decided, 0);
    assert.equal(r.summary.completionRate, 75);
  });

  it('RQ-211 · P1 · 差异化 · 默认短局 quick(12) 让首访快速可观测', () => {
    assert.equal(DEFAULT_PRESET_KEY, 'quick');
    assert.equal(DEFAULT_BARS, 12);
    const p = presetOf('quick');
    assert.equal(p.bars, 12, '默认短局应为 12 根');
  });

  it('RQ-211 · P2 · 留存体验 · 四步均有数据时无断点且完成率可实时读数', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.dropAt, null, '四步不断点');
    assert.equal(r.summary.completionRate, 62.5, '完成率 = 5/8 = 62.5%');
  });

  it('RQ-211 · P3 · 边界异常 · 四步缺中间步（start=0）时 dropAt 标出断点', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 10, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.equal(r.summary.started, 0);
    assert.notEqual(r.dropAt, null, '进入后未开始必须标出断点');
  });

  it('RQ-211 · P3 · 边界异常 · safeUserId(null) 返回 null —— 修复 v10「游客被算成 userId=0 撞外键」', () => {
    assert.equal(safeUserId(null), null, 'Number(null)===0 必须被兜住');
    assert.equal(safeUserId(undefined), null);
    assert.equal(safeUserId(''), null);
    assert.equal(safeUserId(0), null, '0 不是合法 userId');
    assert.equal(safeUserId(-3), null);
  });

  it('RQ-211 · P4 · 性能并发 · 批量身份归一不崩溃（1000 条混合输入）', () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({ userId: i % 3 === 0 ? null : i, guestToken: i % 2 === 0 ? `g${i}` : null }));
    const out = inputs.map((x) => identityOf(x));
    assert.equal(out.length, 1000);
    assert.ok(out.every((o) => o.anonymous || o.isGuest || o.userId));
  });

  it('RQ-211 · P5 · 兼容回归 · 引导四步顺序稳定（enter→start→decision→finish）', () => {
    assert.deepEqual(GUIDE_EVENTS, ['first_training_enter', 'first_training_start', 'first_training_decision', 'first_training_finish']);
    assert.equal(GUIDE_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-212 · 引入 ≥5 名外部真人实测首训（M42 / 产品优先级 P0）           *
 * 5 名外部真人注册、≥2 有效完成、非同秒批量。                           *
 * ================================================================== */
describe('RQ-212 外部真人首训实测（P0）', () => {
  it('RQ-212 · P0 · 正常流程 · 达成目标（注册≥5、有效完成≥2）时 met=true', () => {
    const r = summarizeExternalFunnel({ invited: 20, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true);
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });

  it('RQ-212 · P0 · 正常流程 · isExternalUser 公网 IP + 非内部渠道 → 外部真人', () => {
    const r = isExternalUser(
      { acquisition_channel: 'wechat', signup_ip: '203.0.113.9' },
      { isPublicIpv4: (ip) => !/^(10\.|192\.168\.|127\.|0\.)/.test(ip), isLocalHost: () => false }
    );
    assert.equal(r.external, true);
  });

  it('RQ-212 · P1 · 差异化 · 非同秒批量：同分钟注册 ≥3 被识别为 burst', () => {
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, createdAt: new Date(now) }));
    const b = classifySignupBursts(rows);
    assert.ok(b.userIds.length >= 3, '同分钟 5 人应被识别为批量');
  });

  it('RQ-212 · P2 · 留存体验 · 外部漏斗达标（≥5 注册、≥2 有效完成）且无断点', () => {
    const r = summarizeExternalFunnel({ invited: 10, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true, '6 注册 / 3 有效完成 已达标');
    assert.equal(r.dropAt, null, '全链路无断点');
  });

  it('RQ-212 · P3 · 边界异常 · 已打标的用户不计入外部真人', () => {
    const r = isExternalUser({ is_test: true, acquisition_channel: 'wechat', signup_ip: '203.0.113.9' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'test-marked');
  });

  it('RQ-212 · P3 · 边界异常 · 未记录 IP 时无法判定为外部（no-ip）', () => {
    const r = isExternalUser({ acquisition_channel: 'wechat', signup_ip: '' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'no-ip');
  });

  it('RQ-212 · P4 · 性能并发 · 大批量用户（1e4）isExternalUser 不崩溃', () => {
    const users = Array.from({ length: 10000 }, (_, i) => ({ id: i, acquisition_channel: 'wechat', signup_ip: '203.0.113.1' }));
    const out = users.map((u) => isExternalUser(u, { isPublicIpv4: () => true, isLocalHost: () => false }));
    assert.equal(out.length, 10000);
    assert.ok(out.every((o) => o.external));
  });

  it('RQ-212 · P5 · 兼容回归 · INTERNAL_CHANNELS 含内部来源（防再次把自测当外部）', () => {
    for (const c of ['self', 'local', 'test', 'dev', 'internal', 'team']) {
      assert.ok(INTERNAL_CHANNELS.has(c), `${c} 应视为内部渠道`);
    }
    assert.equal(EXTERNAL_FUNNEL_STEPS.length, 4);
  });
});

/* ================================================================== *
 * RQ-213 · 度量对账：埋点↔会话双向对账，resume:start≈1:1（M43 / P1）   *
 * ================================================================== */
describe('RQ-213 埋点↔会话双向对账（P1）', () => {
  it('RQ-213 · P0 · 正常流程 · 埋点数等于业务表行数时 ok 且 brokenCount=0', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 10, blind_finish: 9 },
      tableCounts: { blind_sessions: 10, blind_sessions_finished: 9 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.brokenCount, 0);
    assert.ok(r.items.every((i) => i.match));
  });

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

  it('RQ-213 · P1 · 差异化 · 业务表比埋点多 → 判 error（漏报）', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 8, blind_finish: 9 },
      tableCounts: { blind_sessions: 10, blind_sessions_finished: 9 },
    });
    const start = r.items.find((i) => i.key === 'blind_start');
    assert.equal(start.diff, -2, '表比埋点多 2');
    assert.equal(start.severity, 'error');
    assert.equal(r.ok, false);
  });

  it('RQ-213 · P1 · 差异化 · 按 sessionId 双向对账：方向相反的误差不被总数抵消', () => {
    const r = reconcileConsistency(
      [{ id: 1, session_id: 1 }, { id: 2, session_id: 2 }],
      [{ session_id: 2 }, { session_id: 3 }]
    );
    assert.equal(r.ok, false, '按 id 对账应暴露方向相反的误差');
  });

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

  it('RQ-213 · P4 · 性能并发 · 大批量对账（各 2e3）不崩溃', () => {
    const ev = Array.from({ length: 2000 }, (_, i) => ({ id: i, session_id: i }));
    const ses = Array.from({ length: 2000 }, (_, i) => ({ session_id: i }));
    const r = reconcileConsistency(ev, ses);
    assert.equal(r.ok, true);
    assert.equal(r.matchedCount, 2000);
  });

  it('RQ-213 · P5 · 兼容回归 · DEFAULT_CONSISTENCY_RULES 含 blind_start/blind_finish（防端点被误删）', () => {
    const keys = DEFAULT_CONSISTENCY_RULES.map((r) => r.key);
    assert.ok(keys.includes('blind_start'));
    assert.ok(keys.includes('blind_finish'));
  });
});

/* ================================================================== *
 * RQ-214 · 发布后验证固化（M41 / 产品优先级 P0，由 P1 升 P0）          *
 * 验收：verifyRelease.js 含埋点/会话一致性断言 + 连续两次留痕。          *
 * ================================================================== */
describe('RQ-214 发布后验证固化（P0）', () => {
  const mk = (commit, ok) => ({ git_commit: commit, ok: Boolean(ok), run_at: new Date() });

  it('RQ-214 · P0 · 正常流程 · 连续不同 commit 计为连续验证（连续两次留痕）', () => {
    const rows = [mk('aaa', true), mk('bbb', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, true, '连续 2 次不同提交应为连续');
  });

  it('RQ-214 · P0 · 正常流程 · verifyRelease 确实导出埋点/会话一致性断言（checkConsistency/checkTelemetry）', () => {
    assert.equal(typeof checkConsistency, 'function', 'verifyRelease 必须含 telemetry-consistency 断言');
    assert.equal(typeof checkTelemetry, 'function', 'verifyRelease 必须含埋点落库断言');
    assert.equal(typeof checkVerificationRecord, 'function', 'verifyRelease 必须含验证记录留痕');
  });

  it('RQ-214 · P1 · 差异化 · ok:false 会打断连续', () => {
    const rows = [mk('aaa', true), mk('bbb', false), mk('ccc', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '中间一次失败应打断连续');
  });

  it('RQ-214 · P2 · 留存体验 · 两个不同提交均验证通过才算连续达标；同提交重复跑不凑数', () => {
    const ok = verificationStreak([mk('a1', true), mk('b2', true)]);
    assert.equal(ok.streak, 2);
    assert.equal(ok.ok, true);
    const dup = verificationStreak([mk('a1', true), mk('a1', true)]);
    assert.equal(dup.streak, 1, '同提交去重');
    assert.equal(dup.ok, false, '未达连续 2 次，发布闸门须拦下');
  });

  it('RQ-214 · P3 · 边界异常 · 单次记录时 streak 不 ok，但记录本身仍算成功（不自杀）', () => {
    const rows = [mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '只有 1 次不达到连续阈值');
    assert.equal(s.streak, 1);
  });

  it('RQ-214 · P3 · 边界异常 · 同一 commit 重复跑不去重（不虚增连续）', () => {
    const rows = [mk('aaa', true), mk('aaa', true)];
    const s = verificationStreak(rows);
    assert.equal(s.ok, false, '同一次提交重复跑不算两次发布');
  });

  it('RQ-214 · P4 · 性能并发 · 大批量验证记录（1e3）统计不崩溃', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => mk(`c${i}`, true));
    const s = verificationStreak(rows);
    assert.equal(s.streak, 1000);
  });

  it('RQ-214 · P5 · 兼容回归 · REQUIRED_ROUTES 含阶段零端点（防端点被误删）', () => {
    const paths = REQUIRED_ROUTES.map((r) => r.path);
    for (const p of ['/api/public/stage-zero', '/api/public/status-truth', '/api/public/landing', '/api/public/help', '/api/guest/session']) {
      assert.ok(paths.includes(p), `REQUIRED_ROUTES 应含 ${p}`);
    }
  });
});

/* ================================================================== *
 * RQ-215 · 身份叙事纠偏：首屏「训练场」化 + 三处口径统一（M44 / P1）    *
 * 期望对齐，避免正面撞同花顺/叩富。                                    *
 * ================================================================== */
describe('RQ-215 身份叙事纠偏（P1）', () => {
  it('RQ-215 · P0 · 正常流程 · 合规文本（含 REQUIRED_PHRASES、无 FORBIDDEN）通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-215 · P0 · 正常流程 · 含「虚拟仿真」被判违规', () => {
    const r = checkIdentityWording('本平台为虚拟仿真交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.includes('虚拟仿真'));
  });

  it('RQ-215 · P1 · 差异化 · 缺失 REQUIRED_PHRASES 被判不合规', () => {
    const r = checkIdentityWording('这是一个交易大厅。');
    assert.equal(r.ok, false);
    assert.ok(r.missingRequired.length === REQUIRED_PHRASES.length, '两个事实锚点都应缺失');
  });

  it('RQ-215 · P2 · 留存体验 · 合规口径判 ok；含禁止误述则判违规', () => {
    const good = checkIdentityWording('我们用真实 A 股行情与模拟撮合做训练');
    assert.equal(good.ok, true);
    assert.deepEqual(good.forbiddenHits, []);
    assert.deepEqual(good.missingRequired, []);
    const bad = checkIdentityWording('这是一套虚拟仿真交易大厅');
    assert.equal(bad.ok, false);
    assert.ok(bad.forbiddenHits.includes('虚拟仿真'));
    assert.ok(bad.forbiddenHits.includes('交易大厅'));
  });

  it('RQ-215 · P3 · 边界异常 · null/空文本被判不合规（缺事实锚点），不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  it('RQ-215 · P4 · 性能并发 · 批量 checkIdentityWording 1e3 次不崩溃', () => {
    const texts = Array.from({ length: 1000 }, () => '真实 A 股行情与模拟撮合训练');
    const out = texts.map((t) => checkIdentityWording(t));
    assert.equal(out.length, 1000);
    assert.ok(out.every((r) => r.ok === true));
  });

  it('RQ-215 · P5 · 兼容回归 · 「交易大厅」类误述全部命中 FORBIDDEN_WORDINGS', () => {
    for (const w of ['虚拟仿真', '模拟交易大厅', 'A 股模拟交易大厅', '交易大厅']) {
      assert.ok(FORBIDDEN_WORDINGS.includes(w), `${w} 应在禁止词表中`);
    }
  });
});

/* ================================================================== *
 * RQ-216 · 首训有效完成率 >0（M42 / 产品优先级 P0）                    *
 * 北极星：把「来了也走不完」转为「走完了」；effective_completed>0。      *
 * 底层 effectiveCompletionService 已建（v12 落地），此前未被 v21/v22 覆盖。*
 * ================================================================== */
describe('RQ-216 首训有效完成率 >0（P0）', () => {
  // P0 正常流程：有效完成判定全过
  it('RQ-216 · P0 · 正常流程 · 已结算 + ≥1 笔成交 + 走完 + ≥10s → effective=true 且出成绩卡', () => {
    const e = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED', finished_at: '2026-01-01T00:05:00Z',
        score: { tradeCount: 3, durationSec: 120 },
        start_seq: 1, end_seq: 12, cursor_seq: 12,
      },
    });
    assert.equal(e.completed, true);
    assert.equal(e.effective, true, '三项门槛全过应为有效完成');
    assert.equal(e.blockers.length, 0);
    assert.equal(e.scoreCard.show, true, '有效完成才出成绩卡');
  });

  // P0 正常流程：北极星有效完成率可实时读数（排除测试流量）
  it('RQ-216 · P0 · 正常流程 · effectiveCompletionRate 排除测试流量给出 readable 读数', () => {
    const r = effectiveCompletionRate({ started: 5, finished: 3, effective: 2, testExcluded: 1 });
    assert.equal(r.metric, '首训有效完成率');
    assert.equal(r.value, 40, '有效完成 2/5 = 40%');
    assert.equal(r.formalValue, 60, '形式完成 3/5 = 60%，对照说明 100% 是假的');
    assert.equal(r.readable, true, 'N≥5 数字可读');
    assert.equal(r.numerator, 2);
    assert.equal(r.denominator, 5);
  });

  // P1 差异化：未达门槛只给动作不给数字（不出 0 笔成绩卡）
  it('RQ-216 · P1 · 差异化 · 0 笔成交的局不计入有效完成，且不出成绩卡改出引导', () => {
    const e = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED', finished_at: '2026-01-01T00:05:00Z',
        score: { tradeCount: 0, durationSec: 120 },
        start_seq: 1, end_seq: 12, cursor_seq: 12,
      },
    });
    assert.equal(e.effective, false, '0 笔成交不属于有效完成');
    assert.ok(e.blockerKeys.includes('no_trade'));
    assert.equal(e.scoreCard.show, false, '未达有效完成不出成绩卡（F-80）');
    assert.equal(e.scoreCard.reason, 'no_trade');
  });

  // P1 差异化：N<5 时数字不可读，拒绝拿 1/1=100% 误导（F-73 复发路径）
  it('RQ-216 · P1 · 差异化 · started<5 时 readable=false，不把 1/1 当作达标', () => {
    const r = effectiveCompletionRate({ started: 1, finished: 1, effective: 1 });
    assert.equal(r.value, 100, '数字仍可算但');
    assert.equal(r.readable, false, '样本不足不得作为达标判断');
    assert.match(r.note, /样本|参考/);
  });

  // P2 留存体验：埋点守卫——未达有效完成不发 first_training_finish（避免污染分母）
  it('RQ-216 · P2 · 留存体验 · allowFinishTelemetry 仅在 effective 时发送埋点，否则改发诊断事件', () => {
    const good = allowFinishTelemetry({ effective: true, blockerKeys: [] });
    assert.equal(good.send, true);
    assert.equal(good.alternative, null);
    const bad = allowFinishTelemetry({ effective: false, blockerKeys: ['no_trade'] });
    assert.equal(bad.send, false);
    assert.equal(bad.reason, 'blocked:no_trade');
    assert.equal(bad.alternative, 'blind_finish_invalid');
  });

  // P3 边界异常：未结算 / too_fast / partial_bars 各自触发对应 blocker
  it('RQ-216 · P3 · 边界异常 · 未结算（RUNNING）触发 not_finished 守卫', () => {
    const e = evaluateEffectiveCompletion({ session: { status: 'RUNNING' } });
    assert.equal(e.effective, false);
    assert.ok(e.blockerKeys.includes('not_finished'));
  });

  it('RQ-216 · P3 · 边界异常 · 耗时 <10s 触发 too_fast 守卫', () => {
    const e = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED', finished_at: '2026-01-01T00:00:05Z',
        score: { tradeCount: 2, durationSec: 5 },
        start_seq: 1, end_seq: 12, cursor_seq: 12,
      },
    });
    assert.equal(e.effective, false);
    assert.ok(e.blockerKeys.includes('too_fast'));
  });

  it('RQ-216 · P3 · 边界异常 · 未走完（cursor<total）触发 partial_bars 守卫', () => {
    const e = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED', finished_at: '2026-01-01T00:05:00Z',
        score: { tradeCount: 2, durationSec: 120 },
        start_seq: 1, end_seq: 12, cursor_seq: 6,
      },
    });
    assert.equal(e.effective, false);
    assert.ok(e.blockerKeys.includes('partial_bars'));
  });

  // P4 性能并发：大批量 evaluateEffectiveCompletion 不崩溃
  it('RQ-216 · P4 · 性能并发 · 批量 evaluateEffectiveCompletion 1e3 次稳定', () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      session: {
        status: 'FINISHED', finished_at: '2026-01-01T00:05:00Z',
        score: { tradeCount: i % 2, durationSec: 120 },
        start_seq: 1, end_seq: 12, cursor_seq: 12,
      },
    }));
    const out = sessions.map((x) => evaluateEffectiveCompletion(x));
    assert.equal(out.length, 1000);
    assert.ok(out.every((e) => e.completed === true));
  });

  // P5 兼容回归：EFFECTIVE_RULES 门槛常量稳定 + 历史空跑清理幂等
  it('RQ-216 · P5 · 兼容回归 · 有效完成三门槛常量稳定（防再次漂移）', () => {
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
    assert.equal(EFFECTIVE_RULES.requireFullBars, true);
  });

  it('RQ-216 · P5 · 兼容回归 · planEmptyRunFlag 只标记 effective_completed 且耗时<阈值，幂等', () => {
    const r = planEmptyRunFlag([
      { id: 1, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:00.5Z' }, // 0.5s < 1s
      { id: 2, effective_completed: false, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z' },
      { id: 3, effective_completed: true, created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:05:00Z' }, // 300s
    ]);
    assert.deepEqual(r.flagged, [1], '只标记 effective 且耗时的空跑');
    assert.equal(r.count, 1);
  });
});

/* ================================================================== *
 * RQ-217 · F-00 防复发：新增后端服务须接 routes（M41 / 产品优先级 P1）   *
 * 切断「写完即算完」的元级缺陷。                                       *
 * ================================================================== */
describe('RQ-217 工作区收口 / F-00 防复发（P1）', () => {
  it('RQ-217 · P0 · 正常流程 · 合规文本（含 REQUIRED_PHRASES、无 FORBIDDEN）通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-217 · P3 · 边界异常 · null/空文本被判不合规，不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  it('RQ-217 · P5 · 兼容回归 · 当前仓库 README 实际合规（防再次漂移）', () => {
    const p = resolve(process.cwd(), '..', 'README.md');
    if (!existsSync(p)) return;
    const text = readFileSync(p, 'utf8');
    const r = checkIdentityWording(text);
    assert.equal(r.ok, true, `README 身份口径应合规，实际违规：${r.forbiddenHits.join('/')} ${r.missingRequired.join('/')}`);
  });

  it('RQ-217 · P5 · 兼容回归 · F-00 接线守卫：publicEntryService/telemetryIntegrityService 已被 src 引用', () => {
    const publicJs = resolve(process.cwd(), 'src/routes/public.js');
    const authJs = resolve(process.cwd(), 'src/auth.js');
    assert.ok(existsSync(publicJs) && readFileSync(publicJs, 'utf8').includes('publicEntryService'), 'routes/public.js 必须引用 publicEntryService');
    assert.ok(existsSync(authJs) && readFileSync(authJs, 'utf8').includes('telemetryIntegrityService'), 'auth.js 必须引用 telemetryIntegrityService');
  });
});

/* ================================================================== *
 * RQ-218 · 活动恢复监控：最后事件距今 <12h 告警（M43 / 产品优先级 P2）  *
 * 自测停摆早发现，避免 96h 盲区。底层 activityRegressionService 已建。    *
 * ================================================================== */
describe('RQ-218 活动恢复监控（P2）', () => {
  it('RQ-218 · P0 · 正常流程 · 周≥3 非自测 blind_start 且最后事件<12h → ok=true', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.reasons.length, 0);
    assert.match(r.verdict, /正常/);
  });

  it('RQ-218 · P0 · 正常流程 · ACTIVITY_RULES 阈值常量稳定（验收锚点）', () => {
    assert.equal(ACTIVITY_RULES.minBlindStart, 3);
    assert.equal(ACTIVITY_RULES.maxStalenessHours, 12);
    assert.equal(ACTIVITY_RULES.requireNonTest, true);
  });

  it('RQ-218 · P1 · 差异化 · 最后事件距今 >12h 触发 STALE 告警', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: 20 });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'STALE'), '超 12h 必须告警');
  });

  it('RQ-218 · P1 · 差异化 · 全部自测号（非自测为 0）触发 TEST_DOMINATED', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 0, lastEventAgeHours: 3 });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'TEST_DOMINATED'), '纯自测流量不能算活动');
  });

  it('RQ-218 · P2 · 留存体验 · 窗口内无任何事件（age=null）触发 NO_EVENT，及时发现停摆', () => {
    const r = assessActivityRegression({ blindStartCount: 0, nonTestCount: 0, lastEventAgeHours: null });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'NO_EVENT'), '无事件须判为停摆风险');
  });

  it('RQ-218 · P3 · 边界异常 · blind_start <3 触发 LOW_VOLUME（量不足）', () => {
    const r = assessActivityRegression({ blindStartCount: 2, nonTestCount: 2, lastEventAgeHours: 3 });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'LOW_VOLUME'));
  });

  it('RQ-218 · P3 · 边界异常 · 边界值恰好 12h 不触发 STALE（仅 >12h 才告警）', () => {
    const r = assessActivityRegression({ blindStartCount: 3, nonTestCount: 3, lastEventAgeHours: 12 });
    assert.equal(r.ok, true, '恰好等于阈值（≤12h）不应告警');
  });

  it('RQ-218 · P4 · 性能并发 · 大批量评估（1e3）不崩溃', () => {
    const out = Array.from({ length: 1000 }, (_, i) => assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: (i % 20) }));
    assert.equal(out.length, 1000);
    assert.ok(out.every((r) => typeof r.ok === 'boolean'));
  });

  it('RQ-218 · P5 · 兼容回归 · 空输入不崩溃且判为停摆（age=null → NO_EVENT）', () => {
    const r = assessActivityRegression({});
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'NO_EVENT'));
  });
});

/* ================================================================== *
 * 全局回归：v23 关键常量与映射不能静默变更（防再次漂移）                *
 * ================================================================== */
describe('v23 全局回归守卫', () => {
  it('RQ-209/218 · P5 · 冻结集合长度恒为 10（防再次扩列漏冻）', () => {
    assert.equal(FROZEN_RQS.length, 10);
  });
  it('RQ-216 · P5 · 有效完成门槛常量稳定', () => {
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
  });
  it('RQ-218 · P5 · 活动回归阈值稳定', () => {
    assert.equal(ACTIVITY_RULES.minBlindStart, 3);
    assert.equal(ACTIVITY_RULES.maxStalenessHours, 12);
  });
});
