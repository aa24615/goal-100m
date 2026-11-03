/**
 * v15 阶段零测试补全（P4 性能并发 / P5 兼容回归）
 *
 * 主单测文件 `v15StageZero.test.js` 已覆盖 RQ-173~177 的 P0/P1/P2/P3/P5（以及 RQ-176/177 的 P4）。
 * 本文件补齐被遗漏的测试级别：
 *   - RQ-173 / RQ-174 缺 P4（纯函数无 IO，仅做轻量规模回归，防止未来引入循环热点）
 *   - RQ-175 缺 P4（正则改写大文档）与 P5（不回退到部署者视角 / 兼容 IPv6 形态）
 *
 * 每条用例名前缀即其优先级，括号内为对应需求编号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countdownOf,
  buildLandingCopy,
  clickPathCost,
  auditDocsPublicness,
  renderVisitorHelp,
  scanDocEntry,
  rewriteDocForPublic,
} from '../../src/services/stageZeroService.js';

/* ================================================================== *
 * RQ-173（P5）时区边界：纯日期按上海时区当天末尾解析，不因 UTC 误判逾期
 * 与 v13 RQ-160 P5（纯日期截止日按上海时区当天末尾）同源，防回归
 * ================================================================== */

test('P5 · RQ-173 countdownOf 北京时间 23:30 仍算当天，不因 UTC 误判逾期', () => {
  // 上海 23:30 == UTC 15:30；若误按 UTC 解析，2026-11-16 会被算成「已过期 -1 天」
  const r = countdownOf({ deadline: '2026-11-16', now: new Date('2026-11-16T23:30:00+08:00') });
  assert.equal(r.daysLeft, 0, '上海当天末尾不算逾期');
  assert.equal(r.expired, false);
});

test('P5 · RQ-173 countdownOf 跨日边界：上海 23:30 看次日难度应为 1 天而非 0 天', () => {
  // UTC 视角下 2026-11-16T23:30+08:00 = 2026-11-16T15:30Z，到 11-17 00:00Z 还差 8.5h → 0 天；
  // 上海视角下 11-16 23:30 到 11-17 00:00 还差 30min → 1 天。必须取后者。
  const r = countdownOf({ deadline: '2026-11-17', now: new Date('2026-11-16T23:30:00+08:00') });
  assert.equal(r.daysLeft, 1, '按上海自然日应为 1 天，UTC 误算为 0 天');
  assert.equal(r.expired, false);
});

/* ================================================================== *
 * RQ-174（P5）落地页文案不得回退为部署者视角（F-110 回归）
 * ================================================================== */

test('P5 · RQ-174 buildLandingCopy 三要素文案不含部署者术语（docker/compose/npm）', () => {
  const c = buildLandingCopy({ guestLimit: 3, guestDays: 7, userRetention: '长期保留' });
  const joined = c.elements.map((e) => e.body).join('\n');
  assert.doesNotMatch(joined, /docker|compose|npm run|kubectl|ssh/i);
  // 且三要素顺序固定
  assert.deepEqual(c.elements.map((e) => e.key), ['what', 'register', 'retention']);
});

test('P5 · RQ-174 buildLandingCopy 始终带合规免责，不随游客额度缺失而消失', () => {
  const a = buildLandingCopy({});
  const b = buildLandingCopy({ guestLimit: 5, guestDays: 7 });
  for (const c of [a, b]) {
    assert.match(c.disclaimer, /不构成投资建议/);
  }
});

/* ================================================================== *
 * RQ-174（P4）规模回归：超长首访路径不引入 O(n²) 或正则灾难
 * ================================================================== */

test('P4 · RQ-174 clickPathCost 处理 5000 步路径在 1 秒内完成且结果稳定', () => {
  const path = Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, label: `step ${i}`, kind: i % 3 === 0 ? 'auto' : 'click' }));
  const t0 = Date.now();
  let last = null;
  for (let i = 0; i < 50; i += 1) last = clickPathCost(path);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `50 次 5000 步路径耗时 ${ms}ms，不应 O(n²)`);
  // 5000 步里有 2/3 是 click → 约 3333 次点击，远超上限 → 必然不通过
  assert.equal(last.clicks > 0, true);
  assert.equal(last.ok, false);
});

/* ================================================================== *
 * RQ-175（P4）性能：大批量文档审计不引入灾难性回溯
 * ================================================================== */

test('P4 · RQ-175 auditDocsPublicness 审计 500 份文档在 1 秒内完成', () => {
  const docs = Array.from({ length: 500 }, (_, i) => ({
    name: `doc-${i}.md`,
    // 交替出现：一半含对外地址（通过），一半仅 localhost（点名）
    text: i % 2 === 0 ? '入口 https://tr.example.com/start' : '启动：http://localhost:8080/api/health',
  }));
  const t0 = Date.now();
  const r = auditDocsPublicness(docs, { publicUrl: 'https://tr.example.com' });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `500 份文档审计耗时 ${ms}ms，不应出现隐式 O(n²)`);
  assert.equal(r.total, 500);
  assert.equal(r.offending.length, 250, '仅 localhost 的 250 份应被点名');
});

test('P4 · RQ-175 大文档（1MB）改写不产生灾难性回溯', () => {
  const big = '访问 http://localhost:8080 与 http://127.0.0.1:3001\n'.repeat(20000);
  const t0 = Date.now();
  const out = rewriteDocForPublic(big, 'https://tr.example.com');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `耗时 ${ms}ms 过长（正则灾难性回溯）`);
  assert.doesNotMatch(out, /localhost/);
});

/* ================================================================== *
 * RQ-175（P5）兼容回归：IPv6 / 端口形态 + 访客帮助不回退部署者视角
 * ================================================================== */

test('P5 · RQ-175 scanDocEntry 兼容 IPv6 [::1] 与带端口的本机形态', () => {
  const r = scanDocEntry('本地：http://[::1]:8080 或 http://127.0.0.1:3001', 'https://tr.example.com');
  assert.equal(r.localhostOnly, true, 'IPv6 回环地址也应被识别为唯一本机入口');
  assert.equal(r.localhostCount, 2);
});

test('P5 · RQ-175 renderVisitorHelp 始终含合规免责且不含部署者命令（F-110 回归）', () => {
  for (const url of [null, 'https://tr.example.com']) {
    const md = renderVisitorHelp({ publicUrl: url, guestLimit: 3, guestDays: 7 });
    assert.match(md, /不构成投资建议/);
    assert.doesNotMatch(md, /docker-compose|npm run|curl -H/i);
  }
});

test('P5 · RQ-175 rewriteDocForPublic 只替换 http(s) 本机地址，不误伤相对路径与查询串', () => {
  const text = '入口 http://localhost:8080/path?x=1 ，相对路径 ./setup 不受影响';
  const out = rewriteDocForPublic(text, 'https://tr.example.com');
  assert.match(out, /https:\/\/tr\.example\.com\/path\?x=1/);
  assert.match(out, /相对路径 \.\/setup 不受影响/);
});
