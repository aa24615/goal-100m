/**
 * v10 发布收口 —— 集成测试（真实 HTTP + 真实 DB）
 *
 * 覆盖 v10 阶段零中**只有跑起来才能验证**的部分：
 *   RQ-121 三个规范端点是否真的非 404
 *   RQ-108 游客能否免登录走完一局（且不污染 users 表）
 *   RQ-124 首训闭环能否产生 blind_finish 与四步引导埋点
 *   RQ-125 结算说明书能否对真实成交逐笔核对
 *   RQ-126 连打记录与公榜门槛
 *
 * 单测（tests/unit/v10Release.test.js）验证纯函数口径，本文件验证**链路**。
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

async function register(channel) {
  const username = `v10_${randomUUID().slice(0, 8)}`;
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

/* ==================== RQ-121 · P0 三个规范端点非 404 ==================== */

test('P0 · RQ-121 /api/public/access 返回 200 且给出可达性判定', async () => {
  const res = await call('/public/access');
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(typeof d.ready, 'boolean');
  assert.ok(Array.isArray(d.blockers));
  assert.ok(Array.isArray(d.checklist));
  assert.equal(typeof d.nextAction, 'string');
});

test('P0 · RQ-121 /api/guest/session 匿名访问也返回 200（不是 404）并告知如何取得身份', async () => {
  const res = await call('/guest/session');
  assert.equal(res.status, 200, '匿名查询游客会话不得 404');
  const d = await j(res);
  assert.equal(d.hasSession, false);
  assert.match(d.howTo, /POST/);
});

test('P0 · RQ-121 /api/growth/funnel 未登录返回 401 而非 404（路由存在）', async () => {
  const res = await call('/growth/funnel');
  assert.equal(res.status, 401, '401 证明路由已挂载，404 才是没发上去');
});

test('P0 · RQ-121 /api/growth/funnel 登录后返回漏斗四步口径', async () => {
  const token = await register();
  const res = await call('/growth/funnel', { token });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.ok(d.steps, '漏斗应给出分步计数');
});

/* ==================== RQ-108 · P0 游客免登录走完一局 ==================== */

test('P0 · RQ-108 游客可免登录完成一局，且不写入 users 表', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS c FROM users');

  const s = await j(await call('/guest/session', { method: 'POST' }));
  assert.equal(s.kind, 'guest');
  assert.ok(s.guestToken, '应下发游客 token');
  assert.equal(s.quota.allowed, true);

  const startRes = await call('/blind/start', { guest: s.guestToken, method: 'POST', body: { preset: 'quick' } });
  const start = await j(startRes);
  assert.equal(startRes.status, 200, `游客开局失败：${JSON.stringify(start)}`);
  // RQ-107 短局化：默认快局 12 根，一局 60 秒内可完成
  assert.ok(start.totalBars <= 15, `默认局应 ≤15 根，实际 ${start.totalBars}`);

  const fin = await j(await call(`/blind/${start.id}/finish`, { guest: s.guestToken, method: 'POST' }));
  assert.equal(fin.completed, true, '完成 = 结算并出成绩卡（RQ-109）');
  assert.equal(fin.session.status, 'FINISHED');

  const after = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  assert.equal(after.rows[0].c, before.rows[0].c, '游客局不得污染注册用户数（北极星分母）');
});

test('P0 · RQ-108 游客额度用尽后返回 429 并给出注册理由', async () => {
  const s = await j(await call('/guest/session', { method: 'POST' }));
  const limit = s.limit;
  for (let i = 0; i < limit; i += 1) {
    const r = await call('/blind/start', { guest: s.guestToken, method: 'POST', body: { preset: 'quick' } });
    assert.equal(r.status, 200, `第 ${i + 1} 局应允许`);
  }
  const over = await call('/blind/start', { guest: s.guestToken, method: 'POST', body: { preset: 'quick' } });
  assert.equal(over.status, 429);
  const d = await j(over);
  assert.ok(d.error.length > 0, '额度用尽必须给出可读原因，而不是静默失败');
});

test('P3 · RQ-108 非法游客 token 视为无身份，返回 401 而不是被当成合法游客', async () => {
  const res = await call('/blind/start', { guest: '!!bad!!', method: 'POST', body: {} });
  assert.equal(res.status, 401);
});

/* ==================== RQ-124 · P0 首训闭环 ==================== */

/**
 * RQ-147 改变了这条用例的前提（v12 头号修复）：
 * `first_training_finish` 现在**只在有效完成时发送**——≥1 笔成交、走完全部 K 线、耗时 ≥10 秒。
 * 原用例是「0 笔成交、0.29 秒」的空跑，正好是本期要拦掉的那一种：
 * 它把北极星刷成 100%，而分子里一次真正的训练都没有。
 *
 * 因此用例必须改造成**一次真实训练**，而不是放宽断言：
 *   ① 下至少一笔单；② 把 created_at 前移 30 秒模拟真实耗时（自动化跑不满 10 秒）。
 */
test('P0 · RQ-124 引导局产生四步埋点，可定位断点在哪一步', async () => {
  const token = await register();
  const start = await j(
    await call('/blind/start', { token, method: 'POST', body: { preset: 'quick', guide: true } })
  );
  await call(`/blind/${start.id}/decision`, {
    token,
    method: 'POST',
    body: { action: 'BUY', reason: '放量突破', guide: true },
  });
  // RQ-147 门槛①：至少一笔成交
  const trade = await call(`/blind/${start.id}/trade`, {
    token,
    method: 'POST',
    body: { side: 'BUY', quantity: 100 },
  });
  assert.equal(trade.status, 200, `下单失败，无法构造有效完成：${JSON.stringify(await j(trade))}`);
  // RQ-147 门槛②：耗时 ≥10 秒（自动化跑不满，这里把开训时间前移模拟真实用户）
  await pool.query(`UPDATE blind_sessions SET created_at = now() - interval '30 seconds' WHERE id=$1`, [start.id]);

  const fin = await j(await call(`/blind/${start.id}/finish`, { token, method: 'POST', body: { guide: true } }));
  assert.equal(fin.completed, true);
  assert.equal(fin.effective.effective, true, '真实训练（有成交、走完、耗时够）必须判为有效完成');
  assert.equal(fin.effective.scoreCard.show, true);

  const { rows } = await pool.query(
    `SELECT event FROM analytics_events
      WHERE event IN ('first_training_start','first_training_decision','first_training_finish')
      ORDER BY id ASC`
  );
  const events = new Set(rows.map((r) => r.event));
  assert.ok(events.has('first_training_start'), '缺少「进入 → 开始」埋点');
  assert.ok(events.has('first_training_decision'), '缺少决策埋点');
  assert.ok(events.has('first_training_finish'), '缺少结算埋点');
});

/**
 * RQ-147 的反向守护：空跑**不得**产生 first_training_finish。
 * 这条断言是本期头号结论的回归锁——没有它，v12 的修复随时可能被悄悄回退。
 */
test('P0 · RQ-147 空跑的引导局不产生 first_training_finish（北极星不再被刷满）', async () => {
  await pool.query(
    `DELETE FROM analytics_events WHERE event IN ('first_training_start','first_training_decision','first_training_finish')`
  );
  const token = await register();
  const start = await j(
    await call('/blind/start', { token, method: 'POST', body: { preset: 'quick', guide: true } })
  );
  const fin = await j(await call(`/blind/${start.id}/finish`, { token, method: 'POST', body: { guide: true } }));
  assert.equal(fin.completed, true, '形式完成仍为 true');
  assert.equal(fin.effective.effective, false, '0 笔成交必须是无效完成');

  const { rows } = await pool.query(
    `SELECT event FROM analytics_events WHERE event = 'first_training_finish'`
  );
  assert.equal(rows.length, 0, '空跑不得产生 first_training_finish，否则北极星又被空跑刷满');
});

test('P0 · RQ-124 完成一局后 blind_finish 埋点首次 >0（北极星可读）', async () => {
  await pool.query("DELETE FROM analytics_events WHERE event IN ('blind_finish','guest_training_finish')");
  const token = await register();
  const start = await j(await call('/blind/start', { token, method: 'POST', body: { preset: 'quick' } }));
  await call(`/blind/${start.id}/finish`, { token, method: 'POST' });

  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM analytics_events WHERE event='blind_finish'");
  assert.ok(rows[0].c > 0, '完成一局必须产生 blind_finish 埋点，否则北极星读不到数');
});

test('P0 · RQ-124 北极星给出首训完成率读数（分母为注册用户数）', async () => {
  const token = await register();
  const d = await j(await call('/analytics/north-star', { token }));
  assert.ok(d, '北极星接口应返回数据');
  assert.ok('firstTrainingRate' in d || 'completionRate' in d || JSON.stringify(d).includes('首训'), `北极星缺少首训完成率：${JSON.stringify(d)}`);
});

/* ==================== RQ-125 · P0 结算口径说明书 ==================== */

test('P0 · RQ-125 完成后的局可逐笔核对，费用与公开费率一致', async () => {
  const token = await register();
  const start = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  // 先买后卖，产生两笔可核对的成交
  await call(`/blind/${start.id}/trade`, { token, method: 'POST', body: { side: 'BUY', quantity: 100 } });
  await call(`/blind/${start.id}/step`, { token, method: 'POST', body: { action: 'next' } });
  await call(`/blind/${start.id}/trade`, { token, method: 'POST', body: { side: 'SELL', quantity: 100 } });
  await call(`/blind/${start.id}/finish`, { token, method: 'POST' });

  const res = await call(`/blind/${start.id}/settlement`, { token });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(d.applicable, true, '未完成不应出具结算说明');
  assert.ok(d.orderCount >= 1, '真实成交应出现在明细里');
  assert.equal(d.feeAudit.ok, true, `记账费用与重算不一致 ${JSON.stringify(d.feeAudit)}`);
  assert.ok(d.rules.length >= 5, '规则说明应覆盖 T+1/涨跌停/整手/费用/滑点');
  for (const o of d.orders) {
    assert.ok(o.price > 0, '成交价必须为正数');
    assert.ok(o.fee >= 0, '费用不得为负');
  }
});

test('P3 · RQ-125 未完成的局不出具完整结算说明（避免提前暴露）', async () => {
  const token = await register();
  const start = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  const d = await j(await call(`/blind/${start.id}/settlement`, { token }));
  assert.equal(d.finished, false);
  assert.equal(d.applicable, false);
});

test('P3 · RQ-125 非法训练 ID 返回 400，不进数据库', async () => {
  const token = await register();
  const res = await call('/blind/abc/settlement', { token });
  assert.equal(res.status, 400);
});

/* ==================== RQ-126 · P1 连打与公榜 ==================== */

test('P1 · RQ-126 连打记录给出日历与周对比', async () => {
  const token = await register();
  const res = await call('/challenge/streak/record', { token });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(d.calendar.length, d.windowDays);
  assert.equal(typeof d.thisWeek, 'number');
  assert.equal(typeof d.lastWeek, 'number');
  assert.equal(d.delta, d.thisWeek - d.lastWeek);
  assert.match(d.comparison, /本周已练/);
});

test('P1 · RQ-126 活跃用户不足时公榜不展示，且给出原因', async () => {
  const token = await register();
  const res = await call('/challenge/board', { token });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(typeof d.publicBoardEnabled, 'boolean');
  if (!d.publicBoardEnabled) {
    assert.equal(d.board.length, 0, '未达门槛不得产出榜单');
    assert.ok(d.boardReason, '必须说明为什么不展示，而不是给一个空壳');
  }
});

/* ==================== RQ-128 · P2 渠道归因 ==================== */

test('P2 · RQ-128 注册时带入渠道即落到用户行（跨会话归因不漂移）', async () => {
  await register('community');
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE acquisition_channel='community'");
  assert.ok(rows[0].c > 0, '渠道应在注册时就落库，而不是依赖埋点顺序');
});

test('P3 · RQ-128 未登记的渠道归入 unknown，不产生脏渠道', async () => {
  await register('not-a-real-channel');
  const { rows } = await pool.query(
    'SELECT acquisition_channel FROM users ORDER BY id DESC LIMIT 1'
  );
  assert.equal(rows[0].acquisition_channel, 'unknown');
});

/* ==================== P5 兼容回归 ==================== */

test('P5 · RQ-116 已下线路由返回 410 而非 404', async () => {
  const res = await call('/rooms');
  assert.equal(res.status, 410, '410 才是主动下线；404 会被监控系统当成故障');
});

test('P5 · RQ-121 v9 既有路径仍可访问，不因新增规范端点而失效', async () => {
  const res = await call('/config/public-access');
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(typeof d.ready, 'boolean');
});
