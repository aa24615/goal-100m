/**
 * v12 度量可信度 —— 集成测试（真实 HTTP + 真实 DB）
 *
 * 为什么必须有这一层：v10 修的两个阻断级缺陷（游客 userId=null 被算成 0 撞外键、
 * 游客当日额度用 UTC 时间戳比上海日期）**都只有真实链路才能暴露**，
 * 当时 v9 全绿却一直是坏的。本版新增的三处同样是「纯函数单测走不到」：
 *   1. RQ-143 去重依赖数据库**唯一索引**（dedupe_key），单测模拟不出来；
 *   2. RQ-147 有效完成要跨 blind_sessions / blind_orders 两张表；
 *   3. RQ-144 一致性对账本身就是「埋点数 vs 业务表行数」的查询。
 *
 * 覆盖：RQ-143 去重 / RQ-144 一致性 / RQ-147 有效完成 / RQ-149 打标 / RQ-150 结算审计
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/index.js';
import pool from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';
import { seedStocks } from '../../src/seed.js';
import { loadMarket } from '../../src/market.js';
import { seedScenarios } from '../../src/services/scenarioService.js';
import { resetDb } from './resetDb.js';
import { seedHistoryBars } from './seedHistory.js';

let server;
let base;

before(async () => {
  await resetDb(pool);
  await runMigrations(pool);
  await seedStocks();
  await seedScenarios();
  await seedHistoryBars(pool, { days: 220 });
  await loadMarket();
  const app = createApp();
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end().catch(() => {});
});

async function register(channel = 'community') {
  const username = `v12_${randomUUID().slice(0, 8)}`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: 'abc12345', channel }),
  });
  const d = await res.json();
  assert.equal(res.status, 200, `注册失败 ${JSON.stringify(d)}`);
  return d.token;
}

const call = (path, { token, guest, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(guest ? { 'X-Guest-Token': guest } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/* ==================== RQ-143 · P0 埋点去重（依赖唯一索引） ==================== */

test('P0 · RQ-143 blind_resume 同一会话重复上报只落 1 条（此前 714 条 / 2 用户）', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const sessionId = started.id;
  assert.ok(sessionId, '开局失败');

  // 前端此前是轮询式调用：这里连打 10 次模拟轮询
  for (let i = 0; i < 10; i += 1) {
    await call('/blind/resume', { token });
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM analytics_events
      WHERE event='blind_resume' AND payload->>'sessionId' = $1`,
    [String(sessionId)]
  );
  assert.ok(rows[0].c <= 1, `单会话 blind_resume 应 ≤1 条，实际 ${rows[0].c} 条`);
});

test('P0 · RQ-143 blind_finish 重复结算同一会话只落 1 条', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const id = started.id;
  await call(`/blind/${id}/finish`, { token, method: 'POST' });
  await call(`/blind/${id}/finish`, { token, method: 'POST' }).catch(() => {});

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM analytics_events
      WHERE event IN ('blind_finish','guest_training_finish') AND payload->>'sessionId' = $1`,
    [String(id)]
  );
  assert.ok(rows[0].c <= 1, `重复结算应被去重，实际 ${rows[0].c} 条`);
});

test('P3 · RQ-143 不同会话的同名事件互不影响（去重不得误削真实动作）', async () => {
  const token = await register();
  const a = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  await call(`/blind/${a.id}/abandon`, { token, method: 'POST' });
  const b = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  await call(`/blind/${b.id}/abandon`, { token, method: 'POST' });

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM analytics_events WHERE event='blind_abandon'`
  );
  assert.ok(rows[0].c >= 2, `两次放弃应各记一条，实际 ${rows[0].c} 条`);
});

/* ==================== RQ-144 · P0 埋点 ↔ 业务表一致性 ==================== */

test('P0 · RQ-144 blind_finish 埋点数 = FINISHED 会话数', async () => {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM analytics_events WHERE event IN ('blind_finish','guest_training_finish')) AS ev,
       (SELECT COUNT(*)::int FROM blind_sessions WHERE finished_at IS NOT NULL) AS tb`
  );
  const { ev, tb } = rows[0];
  assert.equal(ev, tb, `埋点 ${ev} 条 vs FINISHED 会话 ${tb} 条：不一致说明有重复上报或漏报`);
  assert.ok(tb > 0, '用例依赖至少一局已结算的训练，否则这条断言没有意义');
});

test('P0 · RQ-144 /analytics/integrity 返回可断言的审计结果', async () => {
  const token = await register();
  const d = await j(await call('/analytics/integrity?days=30', { token }));
  assert.ok(d.consistency, '必须给出一致性对账');
  assert.ok(Array.isArray(d.consistency.items));
  assert.ok(Array.isArray(d.duplicates.byEvent));
  assert.equal(typeof d.ok, 'boolean');
});

/* ==================== RQ-147 · P0 有效完成门槛 ==================== */

test('P0 · RQ-147 0 笔成交的空跑：completed=true 但 effective=false，且不出成绩卡', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const id = started.id;
  const r = await j(await call(`/blind/${id}/finish`, { token, method: 'POST' }));

  assert.equal(r.completed, true, '形式完成仍为 true');
  assert.equal(r.effective.effective, false, '0 笔成交必须判为无效完成');
  assert.equal(r.effective.scoreCard.show, false, '未达门槛不得出成绩卡');
  assert.ok(r.effective.scoreCard.fallback.cta, '必须给出「再来一次」引导');
  assert.ok(r.effective.blockers.some((b) => b.key === 'no_trade'));
});

test('P0 · RQ-147 有效完成判定落库，北极星能直接按 effective_completed 计数', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE effective_completed = TRUE)::int AS ok,
            COUNT(*) FILTER (WHERE effective_completed = FALSE)::int AS bad
       FROM blind_sessions WHERE finished_at IS NOT NULL`
  );
  assert.ok(rows[0].bad >= 1, '至少应有 1 局被判为无效完成（本文件里的空跑局）');
  assert.equal(rows[0].ok + rows[0].bad > 0, true);
});

test('P0 · RQ-147 北极星接口同时给出有效完成率与被作废的旧口径值', async () => {
  const token = await register();
  const d = await j(await call('/analytics/north-star-effective?days=30', { token }));
  assert.equal(d.metric, '首训有效完成率');
  assert.equal(typeof d.value, d.denominator > 0 ? 'number' : 'object');
  assert.ok('formalValue' in d, '必须保留旧口径值以便对照说明「为什么 100% 是假的」');
  assert.ok('testExcluded' in d, '必须给出被排除的测试流量数');
});

/* ==================== RQ-149 · P1 自测批次标记 ==================== */

test('P1 · RQ-149 同分钟批量注册的用户被识别为测试流量', async () => {
  // 连续注册 3 个账号（同一分钟内）
  await register('community');
  await register('community');
  await register('community');

  const token = await register('community');
  const d = await j(await call('/analytics/test-marks?days=1', { token }));
  assert.ok(d.plan, '必须给出打标计划');
  assert.ok(d.plan.userIds.length >= 3, `同分钟注册 ≥3 人应被识别，实际 ${d.plan.userIds.length}`);
  assert.ok(d.plan.userReasons[0].detail.includes('人'), '理由要写清「为什么」');
});

test('P1 · RQ-149 打标后用户构成可区分真实/测试，指标分母排除测试流量', async () => {
  const token = await register('community');
  const plan = await j(await call('/analytics/test-marks?days=1', { token }));
  const applied = await j(await call('/analytics/test-marks/apply', { token, method: 'POST', body: { days: 1 } }));
  assert.ok(applied.applied.usersMarked >= 0);
  assert.ok(plan.mix, '必须给出用户构成');

  const mix = await j(await call('/analytics/user-mix?days=1', { token }));
  assert.equal(mix.total, mix.real + mix.test, '真实 + 测试 = 总数');
  assert.equal(mix.metricDenominator, mix.real, '指标分母必须是排除测试后的真实用户数');
});

/* ==================== RQ-150 · P1 结算口径说明书 ==================== */

test('P1 · RQ-150 /blind/:id/settlement/audit 返回撮合价溯源与拒绝归类', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const id = started.id;
  await call(`/blind/${id}/finish`, { token, method: 'POST' });

  const d = await j(await call(`/blind/${id}/settlement/audit`, { token }));
  assert.ok(Array.isArray(d.orders), '必须给出逐笔明细');
  assert.ok(d.rules.length >= 5, `差异清单应 ≥5 条，实际 ${d.rules.length}`);
  assert.equal(d.slippageRule.hasModel, false, '滑点必须如实写 0');
  assert.ok(d.audit, '必须给出自检三项');
  assert.equal(typeof d.audit.ok, 'boolean');
});

test('P3 · RQ-150 未揭示（训练中）不得泄露标的代码（双盲红线）', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const d = await j(await call(`/blind/${started.id}/settlement/audit`, { token }));
  assert.equal(d.reveal, false);
  for (const o of d.orders) {
    assert.equal(o.code, null, '未揭示时标的代码必须为 null');
  }
});

test('P1 · RQ-150 CSV 导出与页面行数一致（含成交与拒绝两类）', async () => {
  const token = await register();
  const started = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  const id = started.id;
  // 触发一次非整手委托，验证拒绝原因真的落库（RQ-150「被拒绝的委托去哪了」）
  await call(`/blind/${id}/trade`, { token, method: 'POST', body: { side: 'BUY', quantity: 101 } });
  await call(`/blind/${id}/finish`, { token, method: 'POST' });

  const res = await call(`/blind/${id}/settlement/audit?format=csv`, { token });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  const json = await j(await call(`/blind/${id}/settlement/audit`, { token }));
  assert.equal(
    lines.length,
    1 + json.orderCount + json.rejectionCount,
    'CSV 行数 = 表头 + 成交 + 拒绝'
  );
  assert.ok(json.rejectionCount >= 1, '非整手委托的拒绝原因必须落库，不能只 throw 400');
});

/* ==================== RQ-154 · P2 导出与保留期 ==================== */

test('P2 · RQ-154 /blind/export 返回训练记录与保留期承诺', async () => {
  const token = await register();
  const d = await j(await call('/blind/export?limit=50', { token }));
  assert.ok(Array.isArray(d.sessions));
  assert.ok(d.retention, '必须带回保留期承诺');
  assert.equal(d.retention.isGuest, false);
  assert.match(d.retention.title, /永久保留/);
});

test('P2 · RQ-154 CSV 导出含「有效完成」列，能区分空跑与有效局', async () => {
  const token = await register();
  const res = await call('/blind/export?format=csv&limit=50', { token });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes('有效完成'), '导出必须能区分有效完成与空跑');
});

test('P2 · RQ-154 保留期提示接口对游客给出 7 天口径', async () => {
  const d = await j(await call('/analytics/retention-notice'));
  assert.ok(d.policy, '必须给出保留期政策（登录永久 / 游客 7 天）');
  assert.equal(d.policy.loggedIn.days, null);
  assert.equal(d.policy.guest.days, 7);
});

/* ==================== RQ-152 / RQ-153 · P1 区间化结论 ==================== */

test('P1 · RQ-152/153 /analytics/conclusion 在小样本下只给三件事，不给点估计', async () => {
  const token = await register();
  const d = await j(await call('/analytics/conclusion', { token }));
  assert.ok(['three-facts', 'interval'].includes(d.mode));
  if (d.mode === 'three-facts') {
    assert.ok(d.facts, '小样本必须给三件事');
    assert.equal(d.interval, null, '小样本不得给区间结论');
    assert.ok(d.remaining > 0);
    for (const key of ['cost', 'behavior', 'benchmark']) {
      const f = (d.facts.facts || []).find((x) => x.key === key);
      assert.ok(f, `三件事里必须包含 ${key}`);
    }
  }
  assert.equal(d.guard.ok, true, '守卫必须确认「样本不足时无点估计」');
});

/* ==================== RQ-142 · P0 公网入口自检 ==================== */

test('P0 · RQ-142 /api/public/access 在配置缺失时明确给出 blocker（不是静默通过）', async () => {
  const d = await j(await call('/public/access'));
  assert.equal(typeof d.ready, 'boolean');
  assert.ok(Array.isArray(d.blockers));
  if (d.ready === false) {
    assert.ok(d.blockers.length > 0, '不可达时必须说明缺什么');
  }
});
