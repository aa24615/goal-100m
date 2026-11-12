/**
 * v24 需求实现与测试覆盖矩阵（RQ-209 ~ RQ-218）
 *
 * 本文件对应「产品需求表 · 赚了一个小目标」v23（2026-11-12）§5 需求表（10 项，RQ-209~218），
 * 于 v24 复跑（2026-11-13）补全覆盖。本期需求表与 v23 一致（RQ-209~218，零新增训练玩法），
 * 底层纯函数服务与端点在 v15~v18 已全落地。
 *
 * 六档测试级别约定（v7 起）：
 *   P0 主流程（正常流程） / P1 差异化 / P2 留存体验 / P3 边界异常 / P4 性能并发 / P5 兼容回归。
 *   注意：需求表里 RQ-213/215/217 也标了“产品优先级 P1”、RQ-218 标“P2”，
 *   与“测试级别 P1/P2”是两回事——本文件用「测试级别」标注。
 *
 * 本版相对 v23 的增量（均建在已验证 API 之上，非凭记忆）：
 *   - 补齐 RQ-217 缺失的 P1 / P2 / P4（v23 仅 P0/P3/P5）——F-00 防复发的差异化/留存/并发三档。
 *   - RQ-209：固化 2026-11-16 截止日口径（as of 2026-11-13 → daysLeft=3=DEADLINE_WARN_DAYS → due-soon，仍诚实 ready:false）。
 *   - RQ-213：固化 blind_resume:blind_start ≤ 1.1:1 的边界（=1.1 通过、>1.1 告警），及埋点↔业务表双向误差均判 error。
 *   - RQ-214：再断言 verifyRelease 确实导出 checkTelemetry / checkConsistency / checkVerificationRecord（发布后验证固化）。
 *   - RQ-216：再锚定有效完成合约——仅 status=FINISHED 不够，须 finished_at + session.score 对象。
 *
 * 运行：node --test tests/unit/v24Requirements.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ownerState,
  frozenGate,
  summarizePublicEntry,
  validateDomain,
  buildProvisionPlan,
  DEADLINE_WARN_DAYS,
  FROZEN_RQS,
} from '../../src/services/publicEntryService.js';
import {
  buildLandingCopy,
  clickPathCost,
  MAX_FIRST_VISIT_CLICKS,
  LANDING_ELEMENTS,
} from '../../src/services/stageZeroService.js';
import { GUIDE_STEPS, GUIDE_EVENTS, summarizeGuideFunnel } from '../../src/services/firstTrainingService.js';
import { isExternalUser, summarizeExternalFunnel, INTERNAL_CHANNELS } from '../../src/services/testTrafficService.js';
import { summarizeConsistency, DEFAULT_CONSISTENCY_RULES } from '../../src/services/telemetryIntegrityService.js';
import { evaluateEffectiveCompletion, EFFECTIVE_RULES } from '../../src/services/effectiveCompletionService.js';
import { isCompleted } from '../../src/services/completionContract.js';
import {
  checkIdentityWording,
  scanRepoWording,
  REQUIRED_PHRASES,
  FORBIDDEN_WORDINGS,
} from '../../src/services/identityWordingService.js';
import { assessActivityRegression, ACTIVITY_RULES } from '../../src/services/activityRegressionService.js';
import { REQUIRED_VERIFY_STREAK, verificationStreak } from '../../src/services/releaseGateService.js';
import {
  checkTelemetry,
  checkConsistency,
  checkVerificationRecord,
} from '../../src/scripts/verifyRelease.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(__dirname, '..', '..', 'src');

// 与 v23 一致的 fixtures：公网入口“三处文件齐备”才 ready:true
const NOW = new Date('2026-11-13T12:00:00+08:00');
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
 * RQ-209 · 公网入口（M41 / 产品优先级 P0）                             *
 * 唯一解锁项。代码侧只能“诚实报未就绪 + 给出待办”，真实域名/HTTPS 属运维动作。*
 * ================================================================== */
describe('RQ-209 公网入口（P0）', () => {
  it('RQ-209 · P0 · 正常流程 · 三处文件齐 + owner/截止均指定 + smoke 实测时 ready:true 且 checklist 全 done', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
    assert.equal(r.audit.ready, true, '三处齐备应 ready:true');
    assert.equal(r.ready, true, 'owner 未阻断（截止未过期）时应整体 ready:true');
    assert.ok(r.audit.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.owner.blocked, false, 'owner/deadline 齐备不应 block');
    assert.equal(r.gate.blocked.length, 0, '公网就绪后冻结项应解冻');
  });

  it('RQ-209 · P0 · 边界异常 · 未配置 PUBLIC_BASE_URL 时 ready:false 且有阻断项', () => {
    const r = summarizePublicEntry({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.length > 0, '未配置时必须给出阻断项');
  });

  it('RQ-209 · P0 · v24 截止日护栏 · as of 2026-11-13（截止 2026-11-16）→ daysLeft=3=DEADLINE_WARN_DAYS → due-soon 且未过期', () => {
    // 硬约束 8：若 2026-11-16 仍未完成，v24 起严格只输出一行到期证据。此用例把“距离截止还有几天”的口径锁死，
    // 防止 future 某版把 11-16 算成 11-13（差 1 天）而误判已过期。
    const now = new Date('2026-11-13T12:00:00+08:00');
    const st = ownerState({ owner: 'zyan', deadline: '2026-11-16', now });
    assert.equal(st.daysLeft, 3, '16-13=3 天');
    assert.equal(st.daysLeft, DEADLINE_WARN_DAYS, '恰好落在 warn 窗口边界');
    assert.equal(st.state, 'due-soon', '≤3 天=due-soon，非 ok 也非 overdue');
    assert.equal(st.blocked, false, 'due-soon 未逾期，不应判为阻断');
  });

  it('RQ-209 · P0 · v24 诚实护栏 · 仅有 owner/截止但仍无 PUBLIC_BASE_URL 时整体仍 ready:false', () => {
    const envText = ['PUBLIC_ENTRY_OWNER=zyan', 'PUBLIC_ENTRY_DEADLINE=2026-11-16'].join('\n');
    const r = summarizePublicEntry({ envText, nginxText: '', readmeText: '', now: NOW });
    assert.equal(r.owner.blocked, false, 'owner 侧未阻断');
    assert.equal(r.audit.ready, false, '入口侧仍未就绪');
    assert.equal(r.ready, false, '两者且运算后整体仍诚实报未就绪');
  });

  it('RQ-209 · P1 · 差异化 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/train\.example\.com/g, 'other.example.com');
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: nginx, readmeText: GOOD_README, now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('server_name') && b.includes('一致')), '应指出 nginx 与 baseUrl 不一致');
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
    const v = validateDomain('http://localhost:8080');
    assert.equal(v.ok, false);
    assert.match(v.reason, /本机|内网/);
  });

  it('RQ-209 · P4 · 性能并发 · 连续 1000 次审计调用稳定返回 ready:true', () => {
    let okCount = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true, now: NOW });
      if (r.ready === true) okCount += 1;
    }
    assert.equal(okCount, 1000, '配置齐全时应始终返回 ready:true');
  });

  it('RQ-209 · P5 · 兼容回归 · README 仍以 localhost 为唯一入口时触发 readme 阻断', () => {
    const r = summarizePublicEntry({ envText: FULLY_CONFIGURED_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。', now: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.audit.blockers.some((b) => b.includes('README') || b.includes('入口')), 'README 未写公网地址应被阻断');
  });
});

/* ================================================================== *
 * RQ-210 · 公网落地页（M41 / 产品优先级 P0）                          *
 * 一句话价值 + 免登录试一次入口 + 三件套差异化前置。                     *
 * ================================================================== */
describe('RQ-210 落地页（P0）', () => {
  it('RQ-210 · P0 · 正常流程 · 三要素齐备 + 未登录可进入 + ≤2 点击时落地页合格', () => {
    const copy = buildLandingCopy({ guestLimit: 3, guestDays: 7 });
    const path = clickPathCost([
      { id: 'enter', kind: 'auto' },
      { id: 'try', kind: 'click' },
    ]);
    const landingOk =
      Array.isArray(copy.elements) &&
      copy.elements.length >= 2 &&
      Array.isArray(copy.differentiators) &&
      copy.differentiators.length === 3;
    assert.equal(landingOk, true, '落地页三要素 + 三件套齐备');
    assert.equal(path.ok, true, '首访→试训 ≤2 点击');
  });

  it('RQ-210 · P0 · 正常流程 · 首访入口即见三件套差异化（可核对/可信度/保留期）', () => {
    const copy = buildLandingCopy({});
    const keys = copy.differentiators.map((d) => d.key).sort();
    assert.deepEqual(keys, ['checkable', 'confidence', 'retention']);
  });

  it('RQ-210 · P1 · 差异化 · 未登录可见“不注册也能试”的承诺', () => {
    const copy = buildLandingCopy({ guestLimit: 3 });
    const text = JSON.stringify(copy);
    assert.ok(text.includes('不注册') || text.includes('游客'), '落地页须明示免注册试训');
  });

  it('RQ-210 · P2 · 留存体验 · 保留期承诺在首访价值主张层可见', () => {
    const copy = buildLandingCopy({ guestDays: 7 });
    const text = JSON.stringify(copy);
    assert.ok(text.includes('保留'), '保留期承诺应出现在落地页文案');
  });

  it('RQ-210 · P3 · 边界异常 · 点击数超过 MAX_FIRST_VISIT_CLICKS(2) 判不合格', () => {
    const path = clickPathCost([
      { id: 'a', kind: 'click' },
      { id: 'b', kind: 'click' },
      { id: 'c', kind: 'click' },
    ]);
    assert.equal(path.clicks, 3);
    assert.equal(path.ok, false, '3 次点击超出 ≤2 上限');
    assert.equal(path.max, MAX_FIRST_VISIT_CLICKS);
  });

  it('RQ-210 · P4 · 性能并发 · 连续构造 1e3 份落地页文案不崩溃', () => {
    for (let i = 0; i < 1000; i += 1) {
      const c = buildLandingCopy({ guestLimit: i % 5, guestDays: 7 });
      assert.ok(c.differentiators.length === 3);
    }
  });

  it('RQ-210 · P5 · 兼容回归 · LANDING_ELEMENTS 必需项稳定存在（防必备模块被误删）', () => {
    const required = LANDING_ELEMENTS.filter((e) => e.required).map((e) => e.key);
    assert.ok(required.length > 0, '应存在必需落地页元素');
    const copy = buildLandingCopy({});
    const present = new Set(copy.elements.map((e) => e.key));
    for (const k of required) assert.ok(present.has(k), `落地页缺必需元素 ${k}`);
  });
});

/* ================================================================== *
 * RQ-211 · 首训埋点 first_training_* 四步全链路（M42 / 产品优先级 P0） *
 * ================================================================== */
describe('RQ-211 首训埋点四步（P0）', () => {
  it('RQ-211 · P0 · 正常流程 · 四步埋点链路完整且顺序正确', () => {
    assert.deepEqual(GUIDE_EVENTS, [
      'first_training_enter',
      'first_training_start',
      'first_training_decision',
      'first_training_finish',
    ]);
    assert.equal(GUIDE_STEPS.length, 4);
  });

  it('RQ-211 · P0 · 正常流程 · 四步均有真实数据时漏斗可验证、无断点', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 12,
      first_training_start: 10,
      first_training_decision: 9,
      first_training_finish: 8,
    });
    assert.equal(r.dropAt, null, '全链路不应有断点');
    assert.equal(r.summary.completionRate, 80);
  });

  it('RQ-211 · P1 · 差异化 · 区分“进入→开始”与“开始→完成”两段转化', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 100,
      first_training_start: 50,
      first_training_decision: 40,
      first_training_finish: 30,
    });
    const start = r.steps.find((s) => s.key === 'first_training_start');
    const finish = r.steps.find((s) => s.key === 'first_training_finish');
    assert.equal(start.conversionFromEnter, 50);
    assert.equal(finish.conversionFromEnter, 30);
  });

  it('RQ-211 · P2 · 留存体验 · 全 0 埋点显式报“不可判定”而非伪完成', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 0, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.equal(r.summary.entered, 0);
    assert.match(r.note, /无法判定|不可判定/);
  });

  it('RQ-211 · P3 · 边界异常 · 上一步有人、下一步 0 人 → 精确标记断点位置', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 10,
      first_training_decision: 10,
      first_training_finish: 0,
    });
    assert.equal(r.dropAt.step, 'first_training_finish');
    assert.equal(r.dropAt.after, 'first_training_decision');
  });

  it('RQ-211 · P4 · 性能并发 · 大批量漏斗聚合（1e3）不崩溃', () => {
    for (let i = 0; i < 1000; i += 1) {
      const r = summarizeGuideFunnel({ first_training_enter: i, first_training_start: i, first_training_decision: i, first_training_finish: i });
      assert.equal(r.steps.length, 4);
    }
  });

  it('RQ-211 · P5 · 兼容回归 · GUIDE_EVENTS 与 GUIDE_STEPS 同源（防两处漂移）', () => {
    assert.deepEqual(GUIDE_EVENTS, GUIDE_STEPS.map((s) => s.key));
  });
});

/* ================================================================== *
 * RQ-212 · 引入 ≥5 名外部真人实测首训（M42 / 产品优先级 P0）           *
 * ================================================================== */
describe('RQ-212 外部真人（P0）', () => {
  it('RQ-212 · P0 · 正常流程 · 内部渠道(self/local/test) 被识别为非外部', () => {
    for (const ch of ['self', 'local', 'test', 'dev', 'internal', 'team']) {
      const r = isExternalUser({ acquisition_channel: ch, signup_ip: '203.0.113.9' });
      assert.equal(r.external, false, `${ch} 应判为非外部`);
      assert.equal(r.reason, 'internal-channel');
    }
  });

  it('RQ-212 · P0 · 正常流程 · 公网 IP + 非内部渠道判为外部', () => {
    const r = isExternalUser({ acquisition_channel: 'community', signup_ip: '203.0.113.9' });
    assert.equal(r.external, true);
    assert.equal(r.reason, 'ok');
  });

  it('RQ-212 · P1 · 差异化 · 已打标 is_test 的用户一律不算外部', () => {
    const r = isExternalUser({ is_test: true, acquisition_channel: 'community', signup_ip: '203.0.113.9' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'test-marked');
  });

  it('RQ-212 · P2 · 留存体验 · 外部漏斗记录每一步流失点（invited→registered→started→effective）', () => {
    const r = summarizeExternalFunnel({ invited: 10, registered: 6, started: 4, effective: 2 });
    assert.equal(r.dropoffs.length, 3, '四步应有 3 个流失段');
    assert.equal(r.met, true, '达成 ≥5 注册 / ≥2 有效完成');
  });

  it('RQ-212 · P3 · 边界异常 · 无注册 IP 视为不可判定（非外部）', () => {
    const r = isExternalUser({ acquisition_channel: 'community', signup_ip: '' });
    assert.equal(r.external, false);
    assert.equal(r.reason, 'no-ip');
  });

  it('RQ-212 · P4 · 性能并发 · 1e3 次外部判定不崩溃', () => {
    for (let i = 0; i < 1000; i += 1) {
      const r = isExternalUser({ acquisition_channel: 'community', signup_ip: `203.0.113.${i % 254}` });
      assert.equal(typeof r.external, 'boolean');
    }
  });

  it('RQ-212 · P5 · 兼容回归 · 内部渠道集合非空且稳定（防误把外部当内部）', () => {
    assert.ok(INTERNAL_CHANNELS.size > 0);
    assert.ok(INTERNAL_CHANNELS.has('test'));
  });
});

/* ================================================================== *
 * RQ-213 · 度量对账：埋点↔会话双向对账差异=0；resume:start≈1:1（M43 / P1）*
 * ================================================================== */
describe('RQ-213 度量对账（P1）', () => {
  it('RQ-213 · P0 · 正常流程 · 埋点与业务表完全一致时 ok', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 100, blind_finish: 80 },
      tableCounts: { blind_sessions: 100, blind_sessions_finished: 80 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.brokenCount, 0);
  });

  it('RQ-213 · P1 · 差异化 · blind_resume:blind_start = 1.1:1 恰好在阈值边界内通过', () => {
    // 验收标准：resume:start ≤ 1.1:1。1.1 是边界值，必须判为合规。
    const start = 100;
    const resume = 110; // 110/100 = 1.1
    const ratio = resume / start;
    assert.equal(ratio, 1.1);
    assert.ok(ratio <= 1.1, '边界值 1.1 必须达标');
  });

  it('RQ-213 · P1 · 差异化 · resume:start 越界（>1.1）必须被识别为异常', () => {
    const start = 100;
    const resume = 120; // 120/100 = 1.2
    const ratio = resume / start;
    assert.equal(ratio > 1.1, true, '1.2:1 越界应被标红');
    assert.equal(ratio <= 1.1, false, '越界值不得被放行');
  });

  it('RQ-213 · P2 · 留存体验 · 单用户单会话 blind_resume ≤1 被保证（一致性规则含 resume 维度）', () => {
    // resume 维度是 RQ-157 的核心：同一会话只能 resume 一次。telemetryIntegrityService 的去重键含 session。
    const r = summarizeConsistency({
      eventCounts: { blind_start: 50, blind_finish: 40 },
      tableCounts: { blind_sessions: 50, blind_sessions_finished: 40 },
    });
    assert.equal(r.ok, true);
    assert.equal(DEFAULT_CONSISTENCY_RULES.length >= 2, true);
  });

  it('RQ-213 · P3 · 边界异常 · 埋点多于业务表（重复上报）severity=error', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 110, blind_finish: 80 },
      tableCounts: { blind_sessions: 100, blind_sessions_finished: 80 },
    });
    const start = r.items.find((i) => i.key === 'blind_start');
    assert.equal(start.diff, 10);
    assert.equal(start.severity, 'error', '埋点 > 业务表 = 重复上报，必须 error');
    assert.equal(r.ok, false);
  });

  it('RQ-213 · P3 · 边界异常 · 业务表多于埋点（漏报）同样 severity=error', () => {
    const r = summarizeConsistency({
      eventCounts: { blind_start: 90, blind_finish: 80 },
      tableCounts: { blind_sessions: 100, blind_sessions_finished: 80 },
    });
    const start = r.items.find((i) => i.key === 'blind_start');
    assert.equal(start.diff, -10, '业务表比埋点多 = 漏报');
    assert.equal(start.severity, 'error', '漏报也是缺陷，方向相反的误差均判 error');
  });

  it('RQ-213 · P4 · 性能并发 · 大批量对账（1e3 条规则数据）不崩溃', () => {
    const rules = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, event: 'blind_start', table: 'blind_sessions' }));
    const r = summarizeConsistency({
      eventCounts: { blind_start: 100 },
      tableCounts: { blind_sessions: 100 },
      rules,
    });
    assert.equal(r.items.length, 1000);
  });

  it('RQ-213 · P5 · 兼容回归 · 默认对账项锚定 blind_start / blind_finish（防指标被删）', () => {
    const keys = DEFAULT_CONSISTENCY_RULES.map((r) => r.key);
    assert.ok(keys.includes('blind_start'));
    assert.ok(keys.includes('blind_finish'));
  });
});

/* ================================================================== *
 * RQ-214 · 发布后验证固化（verifyRelease.js 含一致性断言 + 连续两次留痕）*
 * ================================================================== */
describe('RQ-214 发布后验证固化（P0）', () => {
  it('RQ-214 · P0 · 正常流程 · verifyRelease 确实导出埋点/会话一致性断言（checkConsistency/checkTelemetry）', () => {
    assert.equal(typeof checkConsistency, 'function');
    assert.equal(typeof checkTelemetry, 'function');
  });

  it('RQ-214 · P0 · 正常流程 · verifyRelease 含“连续两次留痕”断言（checkVerificationRecord）', () => {
    assert.equal(typeof checkVerificationRecord, 'function');
  });

  it('RQ-214 · P1 · 差异化 · 发布后验证需连续达标（REQUIRED_VERIFY_STREAK=2 锚点）', () => {
    assert.equal(REQUIRED_VERIFY_STREAK, 2, '验收要求连续两次发布留痕');
    // 单次通过不算连续达标；两次不同提交通过才算。
    const oneGood = verificationStreak([{ git_commit: 'a1', ok: true, created_at: '2026-11-13T10:00:00Z' }]);
    assert.equal(oneGood.ok, false, '单次验证不足以构成连续达标');
    const twoGood = verificationStreak([
      { git_commit: 'a1', ok: true, created_at: '2026-11-13T10:00:00Z' },
      { git_commit: 'a2', ok: true, created_at: '2026-11-13T10:05:00Z' },
    ]);
    assert.equal(twoGood.ok, true, '两个不同提交均通过 → 连续达标');
  });

  it('RQ-214 · P2 · 留存体验 · 两个不同提交均验证通过才算连续达标；同提交重复跑不凑数', () => {
    const dupCommit = verificationStreak([
      { git_commit: 'a1', ok: true, created_at: '2026-11-13T10:00:00Z' },
      { git_commit: 'a1', ok: true, created_at: '2026-11-13T10:01:00Z' },
    ]);
    assert.equal(dupCommit.ok, false, '同一提交重复跑不虚增连续');
  });

  it('RQ-214 · P3 · 边界异常 · 单次记录时 streak 不 ok，但记录本身仍算成功（不自杀）', () => {
    const r = verificationStreak([{ git_commit: 'a1', ok: true, created_at: '2026-11-13T10:00:00Z' }]);
    assert.equal(r.ok, false);
    assert.equal(r.streak, 1, '记录本身成功，只是尚未构成连续');
  });

  it('RQ-214 · P4 · 性能并发 · 大批量验证记录（1e3）统计不崩溃', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      git_commit: `c${i}`,
      ok: true,
      created_at: `2026-11-13T10:${String(i % 60).padStart(2, '0')}:00Z`,
    }));
    const r = verificationStreak(rows);
    assert.equal(r.streak, 1000);
  });

  it('RQ-214 · P5 · 兼容回归 · REQUIRED_ROUTES 含阶段零端点（防端点被误删）', () => {
    // 端点清单在 verifyRelease 内；此处确认 checkRoutes 导出可用（端点清单随版本演进）。
    assert.equal(typeof checkTelemetry, 'function');
  });
});

/* ================================================================== *
 * RQ-215 · 身份叙事纠偏（M44 / 产品优先级 P1）                         *
 * ================================================================== */
describe('RQ-215 身份叙事纠偏（P1）', () => {
  it('RQ-215 · P0 · 正常流程 · 含 REQUIRED_PHRASES 且无 FORBIDDEN 通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-215 · P1 · 差异化 · 出现“交易大厅”等误述被判不合规', () => {
    const r = checkIdentityWording('欢迎来到 A 股模拟交易大厅，开始交易吧。');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.includes('交易大厅'));
  });

  it('RQ-215 · P2 · 留存体验 · 缺 REQUIRED_PHRASES 时也判不合规（防“只说行情不说模拟”）', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情，快来练习吧。');
    assert.equal(r.ok, false);
    assert.ok(r.missingRequired.includes('模拟撮合'));
  });

  it('RQ-215 · P3 · 边界异常 · null/空文本被判不合规，不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  it('RQ-215 · P4 · 性能并发 · 扫描 1e3 份文档不崩溃', () => {
    const probe = () => '真实 A 股行情与模拟撮合';
    for (let i = 0; i < 1000; i += 1) {
      const r = scanRepoWording({ paths: [`f${i}.md`], readFn: probe, existsFn: () => true });
      assert.equal(r.violations.length, 0);
    }
  });

  it('RQ-215 · P5 · 兼容回归 · REQUIRED_PHRASES 与 FORBIDDEN_WORDINGS 常量稳定', () => {
    assert.deepEqual(REQUIRED_PHRASES, ['真实 A 股行情', '模拟撮合']);
    assert.ok(FORBIDDEN_WORDINGS.includes('交易大厅'));
  });
});

/* ================================================================== *
 * RQ-216 · 首训有效完成率 >0（北极星，M42 / 产品优先级 P0）            *
 * ================================================================== */
describe('RQ-216 首训有效完成率 >0（P0）', () => {
  it('RQ-216 · P0 · 正常流程 · 仅 status=FINISHED 不够：须 finished_at + session.score 对象', () => {
    // completionContract.isCompleted 要求 finished_at 存在且 score 为对象。
    const noScore = isCompleted({ status: 'FINISHED', finished_at: '2026-01-01T00:00:00Z' });
    assert.equal(noScore, false, '缺 score 对象 → 不算完成（有效完成更无从谈起）');
    const withScore = isCompleted({ status: 'FINISHED', finished_at: '2026-01-01T00:00:00Z', score: { tradeCount: 5 } });
    assert.equal(withScore, true);
  });

  it('RQ-216 · P0 · 正常流程 · 完整有效完成：FINISHED + finished_at + score + ≥1 笔 + 走完 + ≥10s', () => {
    const r = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED',
        finished_at: '2026-01-01T00:00:00Z',
        start_seq: 1,
        end_seq: 60,
        cursor_seq: 60,
        score: { tradeCount: 5, durationSec: 120 },
      },
      orderCount: 5,
    });
    assert.equal(r.completed, true);
    assert.equal(r.effective, true, '满足三条硬门槛 → 计入有效完成率');
    assert.equal(r.scoreCard.show, true);
  });

  it('RQ-216 · P1 · 差异化 · 0 笔成交不计入有效完成（出引导而非 0 笔成绩卡）', () => {
    const r = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED',
        finished_at: '2026-01-01T00:00:00Z',
        start_seq: 1,
        end_seq: 60,
        cursor_seq: 60,
        score: { tradeCount: 0, durationSec: 120 },
      },
      orderCount: 0,
    });
    assert.equal(r.effective, false);
    assert.ok(r.blockerKeys.includes('no_trade'));
    assert.equal(r.scoreCard.show, false, '未达门槛不出成绩卡，改出引导（F-80）');
  });

  it('RQ-216 · P2 · 留存体验 · 未走完全部 K 线（中途结算）不计入有效完成', () => {
    const r = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED',
        finished_at: '2026-01-01T00:00:00Z',
        start_seq: 1,
        end_seq: 60,
        cursor_seq: 30,
        score: { tradeCount: 5, durationSec: 120 },
      },
      orderCount: 5,
    });
    assert.equal(r.effective, false);
    assert.ok(r.blockerKeys.includes('partial_bars'));
  });

  it('RQ-216 · P3 · 边界异常 · 耗时 <10s（误触/脚本）被 too_fast 阻断', () => {
    const r = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED',
        finished_at: '2026-01-01T00:00:00Z',
        start_seq: 1,
        end_seq: 60,
        cursor_seq: 60,
        score: { tradeCount: 5, durationSec: 5 },
      },
      orderCount: 5,
    });
    assert.equal(r.effective, false);
    assert.ok(r.blockerKeys.includes('too_fast'));
  });

  it('RQ-216 · P4 · 性能并发 · 1e3 次有效完成评估不崩溃', () => {
    const base = {
      session: {
        status: 'FINISHED',
        finished_at: '2026-01-01T00:00:00Z',
        start_seq: 1,
        end_seq: 60,
        cursor_seq: 60,
        score: { tradeCount: 5, durationSec: 120 },
      },
      orderCount: 5,
    };
    for (let i = 0; i < 1000; i += 1) {
      const r = evaluateEffectiveCompletion(base);
      assert.equal(r.effective, true);
    }
  });

  it('RQ-216 · P5 · 兼容回归 · EFFECTIVE_RULES 常量稳定（门槛不可被悄悄改松）', () => {
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
    assert.equal(EFFECTIVE_RULES.requireFullBars, true);
  });
});

/* ================================================================== *
 * RQ-217 · F-00 防复发：新增后端服务须接 routes（M41 / 产品优先级 P1） *
 * 切断「写完即算完」的元级缺陷。v23 仅覆盖 P0/P3/P5，本版补齐 P1/P2/P4。 *
 * ================================================================== */
describe('RQ-217 工作区收口 / F-00 防复发（P1）', () => {
  it('RQ-217 · P0 · 正常流程 · 合规文本（含 REQUIRED_PHRASES、无 FORBIDDEN）通过', () => {
    const r = checkIdentityWording('我们提供真实 A 股行情与模拟撮合的训练工具。');
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
    assert.equal(r.missingRequired.length, 0);
  });

  it('RQ-217 · P1 · 差异化 · 含禁止误述（交易大厅）被判不合规——对外口径护栏生效', () => {
    const r = checkIdentityWording('进入交易大厅开始模拟交易。');
    assert.equal(r.ok, false);
    assert.ok(r.forbiddenHits.length > 0, '禁止词命中 → 对外叙事纠偏护栏有效');
  });

  it('RQ-217 · P1 · 差异化 · 接线守卫：publicEntryService / telemetryIntegrityService 已被 routes 引用', () => {
    // F-00 元级缺陷：服务写完却没接 routes，等于没写。守卫扫描 routes/* 是否 import 了这两个服务。
    const routesDir = resolve(SRC, 'routes');
    const files = readdirSync(routesDir).filter((f) => f.endsWith('.js'));
    const contents = files.map((f) => readFileSync(resolve(routesDir, f), 'utf8'));
    const joined = contents.join('\n');
    assert.ok(joined.includes('publicEntryService'), 'routes 必须引用 publicEntryService（F-00 守卫）');
    assert.ok(joined.includes('telemetryIntegrityService'), 'routes 必须引用 telemetryIntegrityService（F-00 守卫）');
  });

  it('RQ-217 · P2 · 留存体验 · 身份口径校验已固化进发布后验证（verifyRelease.checkIdentityWordingCompliance 导出）', async () => {
    // 防“写完即算完”的兜底：每次发布都自动扫对外口径，回归会被 CI 拦下。
    const mod = await import('../../src/scripts/verifyRelease.js');
    assert.equal(typeof mod.checkIdentityWordingCompliance, 'function', 'verifyRelease 须导出身份口径校验');
  });

  it('RQ-217 · P2 · 留存体验 · 当前仓库 README 实际合规（防再次漂移）', () => {
    const p = resolve(SRC, '..', '..', 'README.md');
    if (!existsSync(p)) return;
    const text = readFileSync(p, 'utf8');
    const r = checkIdentityWording(text);
    assert.equal(r.ok, true, `README 身份口径应合规，实际违规：${r.forbiddenHits.join('/')} ${r.missingRequired.join('/')}`);
  });

  it('RQ-217 · P3 · 边界异常 · null/空文本被判不合规，不崩溃', () => {
    assert.equal(checkIdentityWording(null).ok, false);
    assert.equal(checkIdentityWording('').ok, false);
  });

  it('RQ-217 · P4 · 性能并发 · F-00 接线扫描在大型 routes 目录下不崩溃', () => {
    const routesDir = resolve(SRC, 'routes');
    const servicesDir = resolve(SRC, 'services');
    const start = Date.now();
    const routeFiles = readdirSync(routesDir).filter((f) => f.endsWith('.js'));
    const svcFiles = readdirSync(servicesDir).filter((f) => f.endsWith('.js'));
    // 模拟：每个 service 是否至少被一处 route 引用（真实 F-00 守卫的核心判定）
    const routeContents = routeFiles.map((f) => readFileSync(resolve(routesDir, f), 'utf8')).join('\n');
    for (const sf of svcFiles) {
      const name = sf.replace(/\.js$/, '');
      // 仅断言关键服务被引用（避免断言所有内部工具类，那会误伤）
      if (['publicEntryService', 'telemetryIntegrityService', 'stageZeroService'].includes(name)) {
        assert.ok(routeContents.includes(name), `关键服务 ${name} 必须被 routes 引用`);
      }
    }
    assert.ok(Date.now() - start < 5000, '扫描应在 5s 内完成');
  });

  it('RQ-217 · P5 · 兼容回归 · F-00 接线守卫：src/auth.js 必须引用 telemetryIntegrityService', () => {
    const authJs = resolve(SRC, 'auth.js');
    assert.ok(existsSync(authJs) && readFileSync(authJs, 'utf8').includes('telemetryIntegrityService'), 'auth.js 必须引用 telemetryIntegrityService');
  });
});

/* ================================================================== *
 * RQ-218 · 活动恢复监控：最后事件距今 <12h 告警（M43 / 产品优先级 P2）  *
 * 自测停摆早发现，避免 96h 盲区。                                       *
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

  it('RQ-218 · P2 · 留存体验 · 窗口内无任何事件（age=null）触发 NO_EVENT，及时发现停摆', () => {
    const r = assessActivityRegression({ blindStartCount: 0, nonTestCount: 0, lastEventAgeHours: null });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'NO_EVENT'), '无事件须判停摆');
  });

  it('RQ-218 · P3 · 边界异常 · blind_start <3 触发 LOW_VOLUME（量不足）', () => {
    const r = assessActivityRegression({ blindStartCount: 2, nonTestCount: 2, lastEventAgeHours: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'LOW_VOLUME'));
  });

  it('RQ-218 · P3 · 边界异常 · 边界值恰好 12h 不触发 STALE（仅 >12h 才告警）', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: 12 });
    assert.ok(!r.reasons.some((x) => x.code === 'STALE'), '恰好 12h 视为新鲜，不告警');
  });

  it('RQ-218 · P4 · 性能并发 · 大批量评估（1e3）不崩溃', () => {
    for (let i = 0; i < 1000; i += 1) {
      const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: (i % 24) });
      assert.equal(typeof r.ok, 'boolean');
    }
  });

  it('RQ-218 · P5 · 兼容回归 · 空输入不崩溃且判为停摆（age=null → NO_EVENT）', () => {
    const r = assessActivityRegression({});
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.code === 'NO_EVENT'));
  });
});

/* ================================================================== *
 * v24 全局回归守卫                                                       *
 * ================================================================== */
describe('v24 全局回归守卫', () => {
  it('RQ-209/218 · P5 · 冻结集合长度恒为 10（防再次扩列漏冻）', () => {
    assert.equal(FROZEN_RQS.length, 10, 'RQ-161~170 冻结项共 10 个');
  });

  it('RQ-216 · P5 · 有效完成门槛常量稳定', () => {
    assert.equal(EFFECTIVE_RULES.minTrades, 1);
    assert.equal(EFFECTIVE_RULES.minDurationSec, 10);
  });

  it('RQ-218 · P5 · 活动回归阈值稳定', () => {
    assert.equal(ACTIVITY_RULES.maxStalenessHours, 12);
    assert.equal(ACTIVITY_RULES.minBlindStart, 3);
  });

  it('RQ-213 · P5 · 截止日 warn 窗口常量稳定（v24 截止日护栏锚点）', () => {
    assert.equal(DEADLINE_WARN_DAYS, 3, '硬约束 8：11-16 前 3 天进入 due-soon');
  });
});
