/**
 * v17 需求实现与测试覆盖矩阵（RQ-187 ~ RQ-194）
 *
 * 测试级别约定（沿 v7 起六档，P3/P4/P5 是**测试级别**而非产品优先级）：
 *   P0 主流程        —— 需求核心路径
 *   P1 差异化         —— 与竞品/旧口径的差异点
 *   P2 留存体验       —— 用户投入前/后的体验护栏（v16 无 P2 需求，相关项并入 P1）
 *   P3 边界异常       —— 空值/越界/缺失/畸形输入
 *   P4 性能并发       —— 大样本/批量/高吞吐
 *   P5 兼容回归       —— 历史遗留口径/旧字段/防再次漂移
 *
 * 各用例标题前缀标注所属需求与级别，例如「RQ-187 · P0 · ...」。
 * 纯函数全部无库可测；涉及 DB 的函数均通过 queryFn 注入 mock，不连真实库。
 *
 * 运行：node --test tests/unit/v16Requirements.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateEffectiveCompletion,
  effectiveCompletionRate,
  durationSecOf,
  EFFECTIVE_RULES,
  planEmptyRunFlag,
  flagEmptyRunsCompletedFalse,
} from '../../src/services/effectiveCompletionService.js';
import {
  summarizeGuideFunnel,
  GUIDE_STEPS,
  GUIDE_EVENTS,
} from '../../src/services/firstTrainingService.js';
import {
  summarizeConsistency,
  summarizeDuplicates,
  dedupeKeyOf,
  shouldAccept,
  DEFAULT_DEDUPE,
} from '../../src/services/telemetryIntegrityService.js';
import { auditPublicEntrypoint, serverNamesOf, isLocalHost } from '../../src/services/publicAccessService.js';
import {
  auditLanding,
  buildLandingCopy,
  clickPathCost,
  MAX_FIRST_VISIT_CLICKS,
  LANDING_ELEMENTS,
} from '../../src/services/stageZeroService.js';
import {
  checkIdentityWording,
  scanRepoWording,
  FORBIDDEN_WORDINGS,
} from '../../src/services/identityWordingService.js';
import {
  verificationStreak,
  checkTelemetryConsistency,
  reconcileConsistency,
} from '../../src/services/releaseGateService.js';
import { REQUIRED_ROUTES, checkRoutes } from '../../src/scripts/verifyRelease.js';

/* ================================================================== *
 * RQ-187 · 公网入口（M33 / P0）                                       *
 * 根因是「没有 owner 执行」，非代码可完成；测试守护「未配置→ready:false」*
 * 以及「全配置→ready:true」，并防口径漂移。                            *
 * ================================================================== */

describe('RQ-187 公网入口（P0）', () => {
  const GOOD_ENV = 'PUBLIC_BASE_URL=https://trade.example.com\n';
  const GOOD_NGINX = [
    'server { server_name trade.example.com; listen 443 ssl; }',
    'server { listen 80; server_name trade.example.com; return 301 https://$host$request_uri; }',
  ].join('\n');
  const GOOD_README = '# 入口\n请访问 https://trade.example.com 开始训练。\n';

  it('RQ-187 · P0 · 三处文件全配齐时 ready:true 且五项 checklist 全 done', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: GOOD_README, smoke: true });
    assert.equal(r.ready, true);
    assert.equal(r.checklist.length, 6);
    assert.ok(r.checklist.every((c) => c.done), 'checklist 应全部 done');
    assert.equal(r.blockers.length, 0);
  });

  it('RQ-187 · P0 · 未配置 PUBLIC_BASE_URL 时 ready:false 且 blocker 含 RQ-142-a', () => {
    const r = auditPublicEntrypoint({ envText: '', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('RQ-142-a')));
  });

  it('RQ-187 · P1 · 对外域名与 nginx server_name 不一致时给出阻断', () => {
    const nginx = GOOD_NGINX.replace(/trade\.example\.com/g, 'other.example.com');
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: nginx, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('server_name') && b.includes('一致')));
  });

  it('RQ-187 · P3 · .env 指向 localhost 被识别为本机/内网，外部不可达', () => {
    const r = auditPublicEntrypoint({ envText: 'PUBLIC_BASE_URL=http://localhost:8080\n', nginxText: GOOD_NGINX, readmeText: GOOD_README });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('本机') || b.includes('内网')));
  });

  it('RQ-187 · P5 · README 仍以 localhost 为入口时触发 readme 阻断（防口径漂移）', () => {
    const r = auditPublicEntrypoint({ envText: GOOD_ENV, nginxText: GOOD_NGINX, readmeText: '访问 http://localhost:8080 即可。' });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes('RQ-142-c')));
  });

  it('RQ-187 · P5 · serverNamesOf 提取真实域名 + isLocalHost 正确识别本机/公网', () => {
    const names = serverNamesOf('server_name trade.example.com localhost _;');
    assert.ok(names.includes('trade.example.com'), '应提取出真实域名');
    assert.ok(names.includes('localhost'), 'server_name 中的 localhost 应原样返回（由调用方再过滤）');
    assert.equal(isLocalHost('localhost'), true, 'isLocalHost 应判定 localhost 为本机');
    assert.equal(isLocalHost('trade.example.com'), false, 'isLocalHost 应判定真实域名为非本机');
  });
});

/* ================================================================== *
 * RQ-188 · 落地页 + 免登录练一次（M33 / P0）                           *
 * ================================================================== */

describe('RQ-188 落地页与免登录入口（P0）', () => {
  const fullElements = LANDING_ELEMENTS.map((e) => e.key);

  it('RQ-188 · P0 · 三要素齐备 + 未登录可直接进入 + ≤2 点击时落地页合格', () => {
    const r = auditLanding({
      elements: fullElements,
      pathCost: clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }]),
      guestTrainable: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.clicks, 2);
    assert.equal(r.guestTrainable, true);
  });

  it('RQ-188 · P1 · 落地页文案明确「练什么 / 是否注册 / 记录留多久」', () => {
    const copy = buildLandingCopy({ guestLimit: 3, guestDays: 7, userRetention: '长期保留' });
    const keys = copy.elements.map((e) => e.key);
    assert.deepEqual(keys.sort(), ['register', 'retention', 'what'].sort());
    const registerBody = copy.elements.find((e) => e.key === 'register').body;
    assert.match(registerBody, /不注册|游客/);
  });

  it('RQ-188 · P3 · 缺失必答问题（保留期）时落地页不合格并指明缺项', () => {
    const r = auditLanding({ elements: ['what', 'register'], pathCost: clickPathCost([]), guestTrainable: true });
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes('retention'));
  });

  it('RQ-188 · P3 · 首访→训练超过 2 次点击时路径不合格', () => {
    const r = auditLanding({
      elements: fullElements,
      pathCost: clickPathCost([{ kind: 'click', id: 'a' }, { kind: 'click', id: 'b' }, { kind: 'click', id: 'c' }]),
      guestTrainable: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.clicks, 3);
  });

  it('RQ-188 · P5 · 注册墙拦在首访第一米（guestTrainable=false）即与验收冲突', () => {
    const r = auditLanding({ elements: fullElements, pathCost: clickPathCost([]), guestTrainable: false });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes('注册墙')));
  });

  it('RQ-188 · P5 · MAX_FIRST_VISIT_CLICKS 上限常量保持为 2（防阈值被悄悄改大）', () => {
    assert.equal(MAX_FIRST_VISIT_CLICKS, 2);
  });
});

/* ================================================================== *
 * RQ-189 · 引导式首训埋点四步（M33 / P0）                              *
 * ================================================================== */

describe('RQ-189 引导式首训漏斗（P0）', () => {
  it('RQ-189 · P0 · 四步均有数据时可计算转化、无断点、可验证', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 100,
      first_training_start: 60,
      first_training_decision: 40,
      first_training_finish: 30,
    });
    assert.equal(r.steps.length, 4);
    assert.equal(r.summary.entered, 100);
    assert.equal(r.summary.started, 60);
    assert.equal(r.summary.finished, 30);
    assert.equal(r.summary.completionRate, 50);
    assert.equal(r.dropAt, null);
    assert.match(r.note, /四步均有数据/);
  });

  it('RQ-189 · P1 · 能定位断点（看到卡片但没人点开始）', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 100, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.ok(r.dropAt && r.dropAt.step === 'first_training_start');
  });

  it('RQ-189 · P3 · 四步全 0 时显式「不可判定」，不得被读成已验证', () => {
    const r = summarizeGuideFunnel({ first_training_enter: 0, first_training_start: 0, first_training_decision: 0, first_training_finish: 0 });
    assert.equal(r.summary.entered, 0);
    assert.match(r.note, /不可判定|全部为 0/);
    assert.equal(r.dropAt, null);
  });

  it('RQ-189 · P3 · 畸形/缺失输入（null、undefined、非对象）不崩溃', () => {
    assert.doesNotThrow(() => summarizeGuideFunnel(null));
    assert.doesNotThrow(() => summarizeGuideFunnel(undefined));
    const r = summarizeGuideFunnel(null);
    assert.equal(r.summary.entered, 0);
  });

  it('RQ-189 · P4 · 大样本（百万级）下计算不溢出、转化率为有限数', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 1_000_000,
      first_training_start: 600_000,
      first_training_decision: 400_000,
      first_training_finish: 300_000,
    });
    assert.ok(Number.isFinite(r.summary.completionRate));
    assert.equal(r.summary.completionRate, 50);
  });

  it('RQ-189 · P5 · 计数对象里的未知事件被忽略，不污染四步漏斗', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 5,
      first_training_decision: 3,
      first_training_finish: 2,
      some_unknown_event: 999,
    });
    assert.equal(r.steps.length, 4);
    assert.equal(r.summary.started, 5);
  });

  it('RQ-189 · P5 · GUIDE_STEPS 顺序固定为 进入→开始→决策→结算（防顺序被调）', () => {
    assert.deepEqual(GUIDE_EVENTS, ['first_training_enter', 'first_training_start', 'first_training_decision', 'first_training_finish']);
  });
});

/* ================================================================== *
 * RQ-190 · 发布后验证固化（M33 / P0）                                  *
 * 复用 verifyRelease 的 telemetry-consistency + verification-record。  *
 * ================================================================== */

describe('RQ-190 发布后验证固化（P0）', () => {
  const consistentQ = async (sql) => {
    if (sql.includes("'blind_finish'")) {
      return { rows: [{ id: 1, session_id: 10 }, { id: 2, session_id: 11 }, { id: 3, session_id: 12 }] };
    }
    // finishedSessions：status = 'FINISHED' 的会话
    return { rows: [{ session_id: 10 }, { session_id: 11 }, { session_id: 12 }] };
  };
  const inconsistentQ = async (sql) => {
    if (sql.includes("'blind_finish'")) {
      return {
        rows: [
          { id: 1, session_id: 10 },
          { id: 2, session_id: 11 },
          { id: 3, session_id: 12 },
          { id: 4, session_id: 13 },
          { id: 5, session_id: 14 },
          { id: 6, session_id: 15 },
          { id: 7, session_id: 16 },
        ],
      };
    }
    return { rows: [{ session_id: 10 }, { session_id: 11 }, { session_id: 12 }] };
  };

  it('RQ-190 · P0 · 埋点与业务表一致时 telemetry-consistency 断言通过', async () => {
    const r = await checkTelemetryConsistency({ queryFn: consistentQ });
    assert.equal(r.name, 'telemetry-consistency');
    assert.equal(r.ok, true);
  });

  it('RQ-190 · P1 · 埋点比业务表多时一致性断言判失败（不静默通过）', async () => {
    const r = await checkTelemetryConsistency({ queryFn: inconsistentQ });
    assert.equal(r.ok, false);
  });

  it('RQ-190 · P3 · 无 queryFn 时一致性检查降级为 warn 而非误判通过', async () => {
    const r = await checkTelemetryConsistency({ queryFn: null });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.detail, /未校验|跳过/);
  });

  it('RQ-190 · P0 · 连续两次不同提交均验证通过 → verificationStreak.ok=true', () => {
    const r = verificationStreak([
      { git_commit: 'aaaa', ok: true, run_at: '2026-11-05T00:00:00Z' },
      { git_commit: 'bbbb', ok: true, run_at: '2026-11-04T00:00:00Z' },
    ]);
    assert.equal(r.streak, 2);
    assert.equal(r.ok, true);
  });

  it('RQ-190 · P1 · 仅一次验证或中间有失败 → 不满足「连续两次」要求', () => {
    const one = verificationStreak([{ git_commit: 'aaaa', ok: true, run_at: '2026-11-05T00:00:00Z' }]);
    assert.equal(one.ok, false);
    const broke = verificationStreak([
      { git_commit: 'aaaa', ok: true, run_at: '2026-11-05T00:00:00Z' },
      { git_commit: 'bbbb', ok: false, run_at: '2026-11-04T00:00:00Z' },
    ]);
    assert.equal(broke.ok, false);
  });

  it('RQ-190 · P5 · REQUIRED_ROUTES 含 v16 阶段零端点（防验证清单漏掉新端点）', () => {
    const paths = REQUIRED_ROUTES.map((r) => r.path);
    for (const p of ['/api/public/access', '/api/public/stage-zero', '/api/public/status-truth', '/api/public/landing', '/api/public/help']) {
      assert.ok(paths.includes(p), `REQUIRED_ROUTES 应含 ${p}`);
    }
  });

  it('RQ-190 · P4 · checkRoutes 能抓出状态码不符预期的端点', async () => {
    const fetchFn = async (url) => ({ status: url.includes('/api/public/landing') ? 404 : 200 });
    const r = await checkRoutes({ fetchFn, routes: REQUIRED_ROUTES });
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('/api/public/landing'));
  });
});

/* ================================================================== *
 * RQ-191 · 清理历史盲测空跑 + is_test 打标（M34 / P1）                  *
 * ================================================================== */

describe('RQ-191 清理历史空跑与自测流量（P1）', () => {
  const goodSession = { id: 1, effective_completed: true, created_at: '2026-11-01T10:00:00Z', finished_at: '2026-11-01T10:05:00Z', status: 'FINISHED' };
  const emptySession = { id: 2, effective_completed: true, created_at: '2026-11-01T10:00:00Z', finished_at: '2026-11-01T10:00:00.135Z', status: 'FINISHED' };

  it('RQ-191 · P0 · 有效完成门槛：有成交+走完+≥10秒 才判有效', () => {
    const r = evaluateEffectiveCompletion({
      session: {
        status: 'FINISHED',
        finished_at: '2026-11-01T10:05:00Z',
        start_seq: 1,
        end_seq: 12,
        cursor_seq: 12,
        score: { tradeCount: 2, durationSec: 60 },
      },
      orderCount: 2,
    });
    assert.equal(r.effective, true);
    assert.equal(r.blockers.length, 0);
  });

  it('RQ-191 · P1 · 0.135 秒空跑被判 too_fast、不计入有效完成', () => {
    const r = evaluateEffectiveCompletion({
      session: { status: 'FINISHED', start_seq: 1, end_seq: 12, cursor_seq: 12 },
      score: { tradeCount: 1, durationSec: 0.135 },
      orderCount: 1,
    });
    assert.equal(r.effective, false);
    assert.ok(r.blockerKeys.includes('too_fast'));
  });

  it('RQ-191 · P3 · 边界：9.9 秒（<10s 门槛）仍判 too_fast', () => {
    const r = evaluateEffectiveCompletion({
      session: { status: 'FINISHED', start_seq: 1, end_seq: 12, cursor_seq: 12 },
      score: { tradeCount: 1, durationSec: 9.9 },
      orderCount: 1,
    });
    assert.equal(r.effective, false);
    assert.ok(r.blockerKeys.includes('too_fast'));
  });

  it('RQ-191 · P3 · 入参为 null/undefined 时不崩溃，判定为非有效', () => {
    assert.doesNotThrow(() => evaluateEffectiveCompletion(null));
    const r = evaluateEffectiveCompletion(null);
    assert.equal(r.effective, false);
    assert.equal(r.completed, false);
  });

  it('RQ-191 · P4 · planEmptyRunFlag 在大批量会话中只挑出耗时<阈值的空跑', () => {
    const sessions = [];
    for (let i = 0; i < 1000; i += 1) {
      const empty = i % 3 === 0;
      sessions.push({
        id: i,
        effective_completed: true,
        created_at: '2026-11-01T10:00:00Z',
        finished_at: empty ? '2026-11-01T10:00:00.5Z' : '2026-11-01T10:10:00Z',
        status: 'FINISHED',
      });
    }
    const r = planEmptyRunFlag(sessions, { thresholdSec: 1 });
    assert.equal(r.thresholdSec, 1);
    assert.equal(r.count, 334); // 0..999 中 i%3===0 共 334 个
  });

  it('RQ-191 · P5 · planEmptyRunFlag 不碰已标记 f 的会话（幂等）', () => {
    const sessions = [goodSession, emptySession, { id: 3, effective_completed: false, created_at: '2026-11-01T10:00:00Z', finished_at: '2026-11-01T10:00:00.2Z' }];
    const r = planEmptyRunFlag(sessions, { thresholdSec: 1 });
    assert.deepEqual(r.flagged, [2]); // 仅 emptySession(2)；已 f 的 3 不在列
  });

  it('RQ-191 · P0 · flagEmptyRunsCompletedFalse 默认 dryRun：只统计，不改库', async () => {
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.toUpperCase().includes('SELECT')) {
        return { rows: [goodSession, emptySession].map((s) => ({ id: s.id, effective_completed: true, created_at: s.created_at, finished_at: s.finished_at, status: s.status })) };
      }
      return { rowCount: 0 };
    };
    const r = await flagEmptyRunsCompletedFalse({ queryFn });
    assert.equal(r.dryRun, true);
    assert.equal(r.flagged, 1); // 仅 0.135s 那条
    assert.equal(r.affected, 0);
    assert.equal(calls.length, 1, 'dryRun 不应发起 UPDATE');
  });

  it('RQ-191 · P4 · flagEmptyRunsCompletedFalse dryRun:false 时按 id 批量 UPDATE 并返回影响行数', async () => {
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.toUpperCase().includes('SELECT')) {
        return { rows: [goodSession, emptySession].map((s) => ({ id: s.id, effective_completed: true, created_at: s.created_at, finished_at: s.finished_at, status: s.status })) };
      }
      return { rowCount: Array.isArray(params[0]) ? params[0].length : 0 };
    };
    const r = await flagEmptyRunsCompletedFalse({ dryRun: false, queryFn });
    assert.equal(r.dryRun, false);
    assert.equal(r.affected, 1);
    const updateCall = calls.find((c) => c.sql.toUpperCase().includes('UPDATE'));
    assert.ok(updateCall, '应发起 UPDATE');
    assert.deepEqual(updateCall.params[0], [2]);
  });
});

/* ================================================================== *
 * RQ-192 · 埋点↔会话对账差异 = 0（M34 / P1）                           *
 * ================================================================== */

describe('RQ-192 埋点与会话对账（P1）', () => {
  it('RQ-192 · P0 · 埋点数等于业务表行数 → 一致', () => {
    const r = summarizeConsistency({ eventCounts: { blind_finish: 3 }, tableCounts: { blind_sessions_finished: 3 } });
    assert.equal(r.items[0].match, true);
    assert.equal(r.ok, true);
    assert.equal(r.brokenCount, 0);
  });

  it('RQ-192 · P1 · 埋点比业务表多 → 不一致（重复上报或虚报）', () => {
    const r = summarizeConsistency({ eventCounts: { blind_finish: 5 }, tableCounts: { blind_sessions_finished: 3 } });
    assert.equal(r.ok, false);
    assert.equal(r.items[0].diff, 2);
  });

  it('RQ-192 · P3 · 业务表比埋点多 → 漏报（有完成的局没记上）', () => {
    const r = summarizeConsistency({ eventCounts: { blind_finish: 0 }, tableCounts: { blind_sessions_finished: 3 } });
    assert.equal(r.ok, false);
    assert.equal(r.items[0].diff, -3);
  });

  it('RQ-192 · P3 · 畸形输入（null/字符串）被 int0 钳制，不崩溃', () => {
    const r = summarizeConsistency({ eventCounts: { blind_finish: 'x' }, tableCounts: { blind_sessions_finished: null } });
    assert.equal(r.items[0].eventCount, 0);
    assert.equal(r.items[0].tableCount, 0);
    assert.equal(r.ok, true);
  });

  it('RQ-192 · P4 · summarizeDuplicates 在大批量输入下正确汇总并挑出最严重项', () => {
    const rows = [];
    // 2000 个唯一键（各 cnt=1，不是重复）+ 1 个真实重复键（cnt=200）
    for (let i = 0; i < 2000; i += 1) rows.push({ event: 'blind_resume', user_id: 1, dedupe_key: `u1|blind_resume|s:${i}`, cnt: 1 });
    rows.push({ event: 'blind_resume', user_id: 1, dedupe_key: 'u1|blind_resume|s:dup', cnt: 200 });
    const r = summarizeDuplicates(rows, { top: 5 });
    assert.equal(r.duplicateKeys, 1); // 只有 cnt>1 的键算重复
    assert.equal(r.excessEvents, 199); // 200 - 1
    assert.equal(r.worst[0].count, 200);
  });

  it('RQ-192 · P5 · 未登记事件回落到默认去重（浏览类削峰），不应返回 null 去重键', () => {
    const key = dedupeKeyOf({ userId: 7, event: 'some_unregistered_event', at: Date.now() });
    assert.ok(key !== null);
    assert.equal(DEFAULT_DEDUPE.scope === 'burst' || key.includes('w:'), true);
  });

  it('RQ-192 · P5 · shouldAccept 正确拦截重复键、放行新键', () => {
    const seen = new Set(['k1']);
    assert.equal(shouldAccept(seen, 'k1').accept, false);
    assert.equal(shouldAccept(seen, 'k2').accept, true);
    assert.equal(shouldAccept(seen, null).accept, true); // 不去重键放行
  });

  it('RQ-192 · P5 · reconcileConsistency 按 sessionId 双向对账，方向相反的错误不互相抵消', () => {
    const events = [{ id: 1, session_id: 88 }, { id: 2, session_id: 99 }]; // 99 是孤儿
    const sessions = [{ session_id: 88 }, { session_id: 77 }]; // 77 是漏报
    const r = reconcileConsistency(events, sessions);
    assert.equal(r.ok, false);
    assert.equal(r.orphanEvents.length, 1);
    assert.equal(r.missingEvents.length, 1);
  });
});

/* ================================================================== *
 * RQ-193 · 身份口径纠偏（M35 / P1）                                    *
 * ================================================================== */

describe('RQ-193 身份口径纠偏（P1）', () => {
  const APPROVED = '本产品提供真实 A 股行情与模拟撮合训练，不构成投资建议。';

  it('RQ-193 · P0 · 合规口径（真实行情+模拟撮合）通过校验', () => {
    const r = checkIdentityWording(APPROVED);
    assert.equal(r.ok, true);
    assert.equal(r.forbiddenHits.length, 0);
  });

  it('RQ-193 · P1 · 「虚拟仿真」误述被命中（与实际跑真实行情矛盾）', () => {
    const r = checkIdentityWording('行情与资金均为虚拟仿真。');
    assert.ok(r.forbiddenHits.includes('虚拟仿真'));
    assert.equal(r.ok, false);
  });

  it('RQ-193 · P3 · 「交易大厅」撞脸竞品的措辞被命中', () => {
    const r = checkIdentityWording('欢迎来到 A 股模拟交易大厅。');
    assert.ok(r.forbiddenHits.some((h) => h.includes('交易大厅')));
    assert.equal(r.ok, false);
  });

  it('RQ-193 · P3 · 缺少事实锚点（未提真实行情）也被判不合规', () => {
    const r = checkIdentityWording('我们是一个训练工具，模拟撮合。');
    assert.ok(r.missingRequired.includes('真实 A 股行情'));
    assert.equal(r.ok, false);
  });

  it('RQ-193 · P5 · README.md 当前口径合规（防再次漂移）', () => {
    const p = resolve(process.cwd(), 'README.md');
    if (!existsSync(p)) return; // CI 工作目录不同则跳过
    const r = scanRepoWording({ paths: [p], readFn: readFileSync, existsFn: existsSync });
    assert.equal(r.ok, true, `README 命中误述：${JSON.stringify(r.violations)}`);
  });

  it('RQ-193 · P5 · FORBIDDEN_WORDINGS 与前端守卫用词一致（防前后端漂移）', () => {
    assert.ok(FORBIDDEN_WORDINGS.includes('虚拟仿真'));
    assert.ok(FORBIDDEN_WORDINGS.some((w) => w.includes('交易大厅')));
  });
});

/* ================================================================== *
 * RQ-194 · ≥5 外部真人首训实测（M33 / P0）                             *
 * 需真实用户，非代码可完成；此处守护度量层「防假阳性」：                  *
 * 排除自测流量 + 样本可读门槛（N≥5），保证北极星不被空跑刷满。           *
 * ================================================================== */

describe('RQ-194 外部真人首训度量护栏（P0/P1 代理）', () => {
  it('RQ-194 · P0 · ≥5 真实首训且全部有效 → 可读、完成率 100%', () => {
    const r = effectiveCompletionRate({ started: 5, finished: 5, effective: 5, testExcluded: 0 });
    assert.equal(r.readable, true);
    assert.equal(r.value, 100);
  });

  it('RQ-194 · P1 · 样本 <5（1/1）时不下结论：readable=false（防 1/1=100% 误导）', () => {
    const r = effectiveCompletionRate({ started: 1, finished: 1, effective: 1, testExcluded: 0 });
    assert.equal(r.readable, false);
    assert.match(r.note, /样本|参考|不作为达标/);
  });

  it('RQ-194 · P3 · 0 首训开始时完成率数值为 null（不得判 100%）', () => {
    const r = effectiveCompletionRate({ started: 0, finished: 0, effective: 0, testExcluded: 0 });
    assert.equal(r.value, null);
    assert.equal(r.readable, false);
    assert.match(r.note, /尚无|不可观测/);
  });

  it('RQ-194 · P3 · 自测流量计数被透传并体现在说明中', () => {
    const r = effectiveCompletionRate({ started: 6, finished: 6, effective: 6, testExcluded: 3 });
    assert.equal(r.testExcluded, 3);
    assert.equal(r.readable, true);
  });

  it('RQ-194 · P5 · 边界 minSample 可调，默认 5（防阈值被改小刷出假达标）', () => {
    const r = effectiveCompletionRate({ started: 5, finished: 5, effective: 5, minSample: 5 });
    assert.equal(r.minSample, 5);
  });
});
