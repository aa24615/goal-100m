/**
 * 阶段零「证据不足」护栏回归测试（2026-11-04 日志分析专项）
 *
 * 锁定的两类缺陷都不是 5xx，而是**看起来一切正常**的假象：
 *   F-01  空文档集被判 pass —— `auditDocsPublicness([]) -> ok:true` 的语义是
 *         「未发现违规」，但 `auditStageZero` 曾把它读成「审过且全部合格」。
 *         生产镜像只 COPY backend/，README.md / frontend/nginx.conf 不在 /app，
 *         因此 `?docs=1` 也是 0 份文档，RQ-175 永远绿。
 *   F-02  `ISOLATION_SQL()` 缺 import 抛 ReferenceError，被 try/catch 静默降级成
 *         null，表现为「查不到」而不是「取数炸了」。
 *
 * 约定沿用 v15：优先级前缀即测试级别，断言只锁**可观测行为**，不锁内部实现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditDocsPublicness,
  auditStageZero,
  ISOLATION_SQL,
  DEDUPE_SQL,
  collectVerificationEvidence,
} from '../../src/services/stageZeroService.js';

const BASE = {
  entry: { ready: true },
  owner: { state: 'ok', deadline: '2026-12-31' },
  readmeText: '对外唯一入口 https://tr.example.com',
  landing: {
    ok: true,
    note: 'ok',
    clicks: 2,
    maxClicks: 2,
    guestTrainable: true,
    missing: [],
    reasons: [],
  },
  now: new Date('2026-11-03T12:00:00+08:00'),
};

const itemOf = (r, rq) => r.items.find((i) => i.rq === rq);

/* ================================================================== *
 * F-01：0 份文档 ≠ 全部合格                                           *
 * ================================================================== */

test('P0 · 空文档集仍保持 ok=true 的既有契约，但 note 明确标注「无法判定」', () => {
  const d = auditDocsPublicness([]);
  assert.equal(d.total, 0);
  assert.equal(d.ok, true, 'ok 的语义是未发现违规，不得擅自改成 false 破坏旧调用方');
  assert.match(d.note, /无法判定|无证据/);
  assert.doesNotMatch(d.note, /均已包含对外地址/, '0 份文档不得表述为全部合格');
});

test('P0 · 有文档且以 localhost 为唯一入口时如实点名（对照，确保护栏不误伤）', () => {
  const d = auditDocsPublicness(
    [{ name: 'README.md', text: '访问 http://localhost:8080 开始训练' }],
    { publicUrl: null }
  );
  assert.equal(d.total, 1);
  assert.equal(d.ok, false);
  assert.deepEqual(d.offending, ['README.md']);
});

test('P0 · 总览对 0 份文档判 unknown，而不是 pass（生产假绿的根因）', () => {
  const r = auditStageZero({ ...BASE, docs: auditDocsPublicness([]) });
  const item = itemOf(r, 'RQ-175');
  assert.equal(item.status, 'unknown');
  assert.equal(item.ok, false);
  assert.equal(r.failed.includes('RQ-175'), false, '无证据不是「有据可查的失败」');
  assert.ok(r.unknown.includes('RQ-175'));
  assert.match(item.detail, /0 份|无法判定/);
});

test('P0 · 总览 note 在有 unknown 时不得宣称「全部通过」', () => {
  const r = auditStageZero({ ...BASE, docs: auditDocsPublicness([]) });
  assert.doesNotMatch(r.note, /全部通过/);
  assert.match(r.note, /缺少证据/);
});

test('P1 · 有 2 份真实文档且无违规时 RQ-175 仍判 pass（合法路径零变化）', () => {
  const docs = auditDocsPublicness(
    [
      { name: 'README.md', text: '对外唯一入口 https://tr.example.com' },
      { name: 'frontend/nginx.conf', text: 'server_name tr.example.com;' },
    ],
    { publicUrl: 'https://tr.example.com' }
  );
  const r = auditStageZero({ ...BASE, docs });
  assert.equal(docs.total, 2);
  assert.equal(itemOf(r, 'RQ-175').status, 'pass');
});

test('P5 · items 的 ok 布尔与 status 三态始终自洽（旧调用方兼容）', () => {
  for (const r of [auditStageZero(null), auditStageZero({ ...BASE, docs: auditDocsPublicness([]) })]) {
    for (const i of r.items) {
      assert.equal(typeof i.ok, 'boolean');
      assert.ok(['pass', 'fail', 'unknown'].includes(i.status));
      assert.equal(i.ok, i.status === 'pass');
    }
  }
});

/* ================================================================== *
 * F-02：取证 SQL 不得静默降级                                         *
 * ================================================================== */

test('P0 · ISOLATION_SQL() 可直接执行，不抛 ReferenceError', () => {
  assert.doesNotThrow(() => ISOLATION_SQL());
  const sql = ISOLATION_SQL();
  assert.equal(typeof sql, 'string');
  assert.match(sql, /analytics_events/);
  assert.match(sql, /e\.is_test/, '自测流量口径必须同时看事件与用户两侧');
  assert.match(sql, /u\.is_test/);
});

test('P0 · 取数正常时 isolation 拿到真实读数，不退化成 null', async () => {
  const r = await collectVerificationEvidence({
    queryFn: async (sql) => {
      if (sql === ISOLATION_SQL()) return { rows: [{ total: 100, test_rows: 10 }] };
      if (sql === DEDUPE_SQL) return { rows: [{ c: 0 }] };
      return { rows: [] };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.evidence.isolation.total, 100);
  assert.equal(r.evidence.isolation.testRows, 10);
  assert.equal(r.evidence.isolation.isTestCoverage, 0.1);
  assert.equal(r.evidence.dedupe.duplicates, 0);
});
