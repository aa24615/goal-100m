import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/index.js';
import pool from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';
import { seedStocks } from '../../src/seed.js';
import { loadMarket, forceNextSession } from '../../src/market.js';
import { seedScenarios } from '../../src/services/scenarioService.js';
import { resetDb } from './resetDb.js';

let server;
let base;
let auth;
let alice;

before(async () => {
  // 先清空测试库，避免上一轮遗留数据影响本轮断言（尤其是排行榜 TOP_N 截断）
  await resetDb(pool);
  await runMigrations(pool);
  await seedStocks();
  await seedScenarios();
  await loadMarket();
  // 回放需要「至少两个已落库的交易日」：压缩模式下默认只有 1 个 seq，这里推进几个
  for (let i = 0; i < 3; i += 1) await forceNextSession();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}/api`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
});

async function registerUser(prefix = 'u') {
  const username = `${prefix}_${randomUUID().slice(0, 8)}`;
  const email = `${username}@example.com`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password: 'abc12345' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `注册失败: ${JSON.stringify(data)}`);
  return { token: data.token, user: data.user, username, email, password: 'abc12345' };
}

const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

const call = (path, { method = 'GET', token, body, query } = {}) => {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  return fetch(`${base}${path}${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
};

async function firstStock() {
  const r = await fetch(`${base}/stocks`);
  const arr = await r.json();
  return arr[0];
}

/* ============================================================
 * M1 行情时间机器（RQ-01 ~ RQ-06）· P0
 * ============================================================ */

test('P0 [RQ-01] 可回放区间覆盖已积累的全部交易日', async () => {
  auth = await registerUser('replay');
  const r = await call('/replay/range', { token: auth.token });
  const d = await j(r);
  assert.equal(r.status, 200);
  assert.equal(d.hasData, true);
  assert.ok(d.maxSeq > d.minSeq, `区间过短: ${JSON.stringify(d)}`);
});

test('P0 [RQ-01] 创建回放会话后行情从区间起点开始', async () => {
  const range = await j(await call('/replay/range', { token: auth.token }));
  const r = await call('/replay/start', {
    method: 'POST',
    token: auth.token,
    body: { startSeq: range.minSeq, endSeq: range.maxSeq },
  });
  const d = await j(r);
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.session.startSeq, range.minSeq);
  assert.equal(d.state.cursorSeq, range.minSeq);
  assert.equal(d.state.totalAssets, d.session.initialCapital);
  globalThis.__replay = d.session;
  globalThis.__range = range;
});

test('P1 [RQ-01] 非法区间被拒（越界 / 反转 / 过短）', async () => {
  const range = globalThis.__range;
  const bad = [
    { startSeq: range.minSeq - 1, endSeq: range.maxSeq },
    { startSeq: range.minSeq, endSeq: range.maxSeq + 1 },
    { startSeq: range.maxSeq, endSeq: range.minSeq },
    { startSeq: range.minSeq, endSeq: range.minSeq },
  ];
  for (const b of bad) {
    const r = await call('/replay/start', { method: 'POST', token: auth.token, body: b });
    assert.equal(r.status, 400, `应拒绝 ${JSON.stringify(b)}`);
  }
});

test('P0 [RQ-02] 单步推进与倒带后状态可复现', async () => {
  const s = globalThis.__replay;
  const fwd = await j(await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'next' } }));
  assert.equal(fwd.state.cursorSeq, s.startSeq + 1);

  const back = await j(await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'prev' } }));
  assert.equal(back.state.cursorSeq, s.startSeq);
  assert.equal(back.state.totalAssets, fwd.state.totalAssets === s.initialCapital ? s.initialCapital : back.state.totalAssets);

  // 定位到同一位置两次，状态必须完全一致
  const seek1 = await j(await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'seek', seq: s.startSeq + 1 } }));
  const seek2 = await j(await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'seek', seq: s.startSeq + 1 } }));
  assert.deepEqual(seek1.state, seek2.state);
});

test('P1 [RQ-02] 不支持的操作返回 400', async () => {
  const s = globalThis.__replay;
  const r = await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'teleport' } });
  assert.equal(r.status, 400);
});

test('P0 [RQ-03] 回放中下单成功，且 T+1 当日买入不可卖', async () => {
  const s = globalThis.__replay;
  const stock = await firstStock();
  await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'seek', seq: s.startSeq } });

  const buy = await j(await call(`/replay/${s.id}/trade`, { method: 'POST', token: auth.token, body: { code: stock.code, side: 'BUY', quantity: 100 } }));
  assert.equal(buy.ok, true, JSON.stringify(buy));
  assert.ok(buy.state.cash < s.initialCapital);
  assert.equal(buy.state.positions.length, 1);

  // 同一根 bar 卖出 → T+1 拦截
  const sameDay = await call(`/replay/${s.id}/trade`, { method: 'POST', token: auth.token, body: { code: stock.code, side: 'SELL', quantity: 100 } });
  const sameDayData = await j(sameDay);
  assert.equal(sameDay.status, 400);
  assert.match(sameDayData.error, /T\+1/);

  // 推进一根 bar 后可卖
  await call(`/replay/${s.id}/step`, { method: 'POST', token: auth.token, body: { action: 'seek', seq: s.startSeq + 1 } });
  const sell = await j(await call(`/replay/${s.id}/trade`, { method: 'POST', token: auth.token, body: { code: stock.code, side: 'SELL', quantity: 100 } }));
  assert.equal(sell.ok, true, JSON.stringify(sell));
  assert.equal(sell.state.positions.length, 0);
});

test('P2 [RQ-03] 数量非 100 整数倍 / 未知标的被拒', async () => {
  const s = globalThis.__replay;
  const bad = await call(`/replay/${s.id}/trade`, { method: 'POST', token: auth.token, body: { code: '600001', side: 'BUY', quantity: 55 } });
  assert.equal(bad.status, 400);
  const unknown = await call(`/replay/${s.id}/trade`, { method: 'POST', token: auth.token, body: { code: 'ZZZZZZ', side: 'BUY', quantity: 100 } });
  assert.equal(unknown.status, 404, '区间内无该标的行情应返回 404');
});

test('P0 [RQ-06] 回放操作完全隔离：真实账户与排行榜不受影响', async () => {
  const pf = await j(await call('/portfolio', { token: auth.token }));
  assert.equal(pf.holdings.length, 0, '回放持仓泄漏到真实账户');
  assert.equal(pf.cash, 1000000);

  const board = await j(await call('/leaderboard', { token: auth.token, query: { period: 'all' } }));
  const me = board.find((r) => r.id === auth.user.id);
  assert.ok(me, '自己应出现在排行榜');
  assert.equal(me.tradeCount, 0, '回放成交泄漏到排行榜交易次数');
});

test('P0 [RQ-04] 结束回放后 3 秒内出成绩，四项指标齐全', async () => {
  const s = globalThis.__replay;
  const t0 = Date.now();
  const r = await call(`/replay/${s.id}/finish`, { method: 'POST', token: auth.token });
  const d = await j(r);
  const cost = Date.now() - t0;
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.ok(cost < 3000, `出成绩耗时 ${cost}ms`);
  for (const k of ['returnPct', 'maxDrawdown', 'tradeCount', 'durationSec']) {
    assert.ok(d.score[k] !== undefined, `缺指标 ${k}`);
  }
  assert.equal(d.score.tradeCount, 2);
  assert.equal(d.session.status, 'FINISHED');
});

test('P1 [RQ-05] 历史成绩可查询，同区间多次成绩不覆盖', async () => {
  const range = globalThis.__range;
  const r1 = await j(await call('/replay/start', { method: 'POST', token: auth.token, body: { startSeq: range.minSeq, endSeq: range.maxSeq } }));
  await call(`/replay/${r1.session.id}/finish`, { method: 'POST', token: auth.token });
  const r2 = await j(await call('/replay/start', { method: 'POST', token: auth.token, body: { startSeq: range.minSeq, endSeq: range.maxSeq } }));
  await call(`/replay/${r2.session.id}/finish`, { method: 'POST', token: auth.token });

  const history = await j(await call('/replay/history', { token: auth.token }));
  assert.ok(history.length >= 3, `历史成绩数量 ${history.length}`);

  const cmp = await j(await call(`/replay/compare?startSeq=${range.minSeq}&endSeq=${range.maxSeq}`, { token: auth.token }));
  assert.ok(cmp.length >= 2, '同区间多次成绩应都可查询');
});

test('P2 [RQ-01] 未登录访问回放接口返回 401', async () => {
  const r = await call('/replay/range');
  assert.equal(r.status, 401);
});

/* ============================================================
 * M2 复盘与战绩中心（RQ-07 ~ RQ-11）· P0
 * ============================================================ */

test('P0 [RQ-07] 卖出后生成买卖配对，且盈亏与账户已实现盈亏一致', async () => {
  alice = await registerUser('review');
  const stock = await firstStock();

  // 买入 → 跨日 → 卖出（先落到 startSeq+1 再卖，规避 T+1）
  const buy = await j(await call('/trade', { method: 'POST', token: alice.token, body: { code: stock.code, type: 'BUY', quantity: 100 } }));
  assert.equal(buy.ok, true, JSON.stringify(buy));

  const rv = await j(await call('/review?period=30d', { token: alice.token }));
  assert.equal(rv.consistency.ok, true, `盈亏不一致，差 ${rv.consistency.diff}`);
  assert.ok(rv.rounds.length >= 1);
  const open = rv.rounds.find((r) => r.status === 'open');
  assert.ok(open, '未平仓部分应单独成笔');
  assert.equal(open.code, stock.code);

  globalThis.__alice = alice;
  globalThis.__stock = stock;
});

test('P0 [RQ-08] 战绩卡五项指标齐全且非 NaN', async () => {
  const rv = await j(await call('/review?period=30d', { token: alice.token }));
  const c = rv.scorecard;
  for (const k of ['winRate', 'profitFactor', 'maxDrawdown', 'tradeFrequency', 'feeRatio']) {
    assert.ok(c[k] !== undefined, `缺指标 ${k}`);
    assert.equal(Number.isNaN(c[k]), false, `${k} 为 NaN`);
  }
  assert.ok(c.totalFee > 0);
});

test('P0 [RQ-10] AI 复盘报告携带免责声明且不含标的推荐', async () => {
  const rv = await j(await call('/review?period=30d', { token: alice.token }));
  const rep = rv.report;
  assert.match(rep.disclaimer, /不构成投资建议/);
  assert.equal(rep.compliance, 'passed');
  assert.ok(rep.suggestions.length >= 1 && rep.suggestions.length <= 3);
  const text = JSON.stringify(rep);
  assert.ok(!/必涨|稳赚|保证收益|翻倍/.test(text));
});

test('P1 [RQ-09] 净值曲线可叠加同期大盘', async () => {
  const r = await j(await call('/review/benchmark?days=30', { token: alice.token }));
  assert.ok(Array.isArray(r.series));
  assert.match(r.note, /超额收益/);
  assert.equal(typeof r.hasBenchmark, 'boolean');
});

test('P1 [RQ-11/RQ-31] 导出 CSV 带 BOM 且内容与页面同源', async () => {
  const r = await fetch(`${base}/review/export?format=csv&period=30d`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /csv/);
  // 注意：Fetch 规范的 UTF-8 解码会主动剥离 BOM，r.text() 永远看不到它，
  // 因此这里按原始字节校验，否则会误判「BOM 丢失」。
  const buf = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], 'CSV 缺 BOM，Excel 打开会乱码');
  const text = new TextDecoder('utf-8').decode(buf);
  assert.ok(text.includes('标的'));
});

test('P1 [RQ-31] 交易流水可导出', async () => {
  const r = await fetch(`${base}/transactions/export`, { headers: { Authorization: `Bearer ${alice.token}` } });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(text.includes('成交时间'));
  assert.ok(text.includes(globalThis.__stock.code));
});

test('P0 [RQ-32] 战绩分享卡对身份信息脱敏', async () => {
  const card = await j(await call('/review/share-card?period=30d', { token: alice.token }));
  assert.match(card.usernameMasked, /\*/);
  assert.ok(!JSON.stringify(card).includes(alice.username), '原始用户名泄露');
  assert.ok(!JSON.stringify(card).includes(alice.email), '邮箱泄露');
  assert.match(card.disclaimer, /不构成投资建议/);
});

test('P1 [RQ-24] 能力雷达四维齐全且落在 0~100', async () => {
  const r = await j(await call('/review/ability?period=30d', { token: alice.token }));
  assert.equal(r.dimensions.length, 4);
  for (const d of r.dimensions) {
    assert.ok(d.score >= 0 && d.score <= 100, `${d.label}=${d.score} 越界`);
  }
});

/* ============================================================
 * M3 新手引导与成长体系（RQ-12 ~ RQ-15）· P0
 * ============================================================ */

test('P0 [RQ-12] 引导四步齐备，可逐步推进、可跳过', async () => {
  const steps = await j(await fetch(`${base}/onboarding/steps`));
  assert.equal(steps.steps.length, 4);
  assert.match(steps.disclaimer, /不构成投资建议/);

  const s1 = await j(await call('/onboarding', { token: alice.token }));
  assert.equal(s1.guideDone, false);

  const s2 = await j(await call('/onboarding/guide', { method: 'POST', token: alice.token, body: { action: 'step', step: 2 } }));
  assert.equal(s2.guideStep, 2);

  const s3 = await j(await call('/onboarding/guide', { method: 'POST', token: alice.token, body: { action: 'complete' } }));
  assert.equal(s3.guideDone, true);
});

test('P2 [RQ-12] 非法引导操作被拒', async () => {
  const r = await call('/onboarding/guide', { method: 'POST', token: alice.token, body: { action: 'step', step: 99 } });
  assert.equal(r.status, 400);
});

test('P0 [RQ-14] 新手任务由真实行为推导：完成首笔买入即标记完成', async () => {
  const s = await j(await call('/onboarding', { token: alice.token }));
  const buy = s.tasks.find((t) => t.key === 'first_buy');
  assert.ok(buy, '任务清单缺少 first_buy');
  assert.equal(buy.done, true, '已完成买入但任务未标记');
  assert.ok(buy.unlocks, '任务缺少解锁目标');
});

test('P1 [RQ-15] 连续练习打卡：首次 1 天，重复打卡不累加', async () => {
  const a = await j(await call('/onboarding/checkin', { method: 'POST', token: alice.token }));
  assert.equal(a.streak.current, 1);
  const b = await j(await call('/onboarding/checkin', { method: 'POST', token: alice.token }));
  assert.equal(b.repeated, true);
  assert.equal(b.streak.current, 1);
});

/* ============================================================
 * M4 剧本训练场（RQ-16 ~ RQ-19）· P1
 * ============================================================ */

test('P1 [RQ-16] 剧本题库不少于 8 关，目标与难度齐备', async () => {
  const list = await j(await call('/scenarios', { token: alice.token }));
  assert.ok(list.length >= 8, `题库仅 ${list.length} 关`);
  for (const s of list) {
    assert.ok(s.goal && s.brief && s.difficulty);
    assert.match(s.disclaimer, /不构成任何投资建议/);
    assert.ok(s.constraints.maxTrades > 0);
  }
  globalThis.__scenario = list[0];
});

test('P0 [RQ-16] 同一剧本两次拉取的行情完全一致（初始条件可复现）', async () => {
  const key = globalThis.__scenario.key;
  const a = await j(await call(`/scenarios/${key}/bars`, { token: alice.token }));
  const b = await j(await call(`/scenarios/${key}/bars`, { token: alice.token }));
  assert.deepEqual(a.series, b.series);
  assert.ok(a.series.length > 2);
});

test('P0 [RQ-18] 提交尝试后返回评分、评级与明细', async () => {
  const key = globalThis.__scenario.key;
  const bars = await j(await call(`/scenarios/${key}/bars`, { token: alice.token }));
  const lastSeq = bars.series[bars.series.length - 1].seq;
  const r = await call(`/scenarios/${key}/attempts`, {
    method: 'POST',
    token: alice.token,
    body: { trades: [{ seq: 2, side: 'BUY', quantity: 1000 }, { seq: lastSeq, side: 'SELL', quantity: 1000 }] },
  });
  const d = await j(r);
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.ok(typeof d.score.total === 'number');
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(d.score.grade));
  assert.ok(d.score.breakdown.decisionScore >= 0);
  assert.ok(Array.isArray(d.hints));
  globalThis.__lastSeq = lastSeq;
});

test('P1 [RQ-17] 超出交易次数上限被判定违规', async () => {
  const list = await j(await call('/scenarios', { token: alice.token }));
  const def = list[0];
  const trades = [];
  for (let i = 2; i < 30 && trades.length < def.constraints.maxTrades + 4; i += 1) {
    trades.push({ seq: i, side: trades.length % 2 === 0 ? 'BUY' : 'SELL', quantity: 100 });
  }
  const d = await j(await call(`/scenarios/${def.key}/attempts`, { method: 'POST', token: alice.token, body: { trades } }));
  assert.ok(d.score.violations.some((v) => v.key === 'maxTrades'), JSON.stringify(d.score.violations));
  assert.equal(d.score.passed, false);
});

test('P1 [RQ-19] 未成交的尝试给出指向具体节点的提示', async () => {
  const list = await j(await call('/scenarios', { token: alice.token }));
  const d = await j(await call(`/scenarios/${list[0].key}/attempts`, { method: 'POST', token: alice.token, body: { trades: [] } }));
  assert.ok(d.hints.length > 0);
  assert.match(d.hints[0].node, /K 线|未成交/);
});

test('P2 [RQ-18] trades 非数组或过大被拒', async () => {
  const list = await j(await call('/scenarios', { token: alice.token }));
  const r1 = await call(`/scenarios/${list[0].key}/attempts`, { method: 'POST', token: alice.token, body: { trades: 'x' } });
  assert.equal(r1.status, 400);
  const big = Array.from({ length: 201 }, (_, i) => ({ seq: i + 1, side: 'BUY', quantity: 100 }));
  const r2 = await call(`/scenarios/${list[0].key}/attempts`, { method: 'POST', token: alice.token, body: { trades: big } });
  assert.equal(r2.status, 400);
});

test('P2 [RQ-16] 不存在的剧本返回 404', async () => {
  const r = await call('/scenarios/not_exist/bars', { token: alice.token });
  assert.equal(r.status, 404);
});

/* ============================================================
 * M5 房间赛与超额收益（RQ-20 ~ RQ-23）· P1
 * ============================================================ */

test('P1 [RQ-20] 创建房间赛返回邀请码，他人可用邀请码加入', async () => {
  const owner = await registerUser('owner');
  const guest = await registerUser('guest');
  const room = await j(await call('/rooms', { method: 'POST', token: owner.token, body: { name: '周五练一把', duration: '3d' } }));
  assert.ok(room.code, '缺少邀请码');
  assert.equal(room.durationSessions, 3);

  const joined = await j(await call('/rooms/join', { method: 'POST', token: guest.token, body: { code: room.code } }));
  assert.equal(joined.id, room.id);

  const detail = await j(await call(`/rooms/${room.id}`, { token: owner.token }));
  assert.equal(detail.members.length, 2);
  assert.match(detail.note, /统计窗口一致/);

  // 重复加入返回 409
  const again = await call('/rooms/join', { method: 'POST', token: guest.token, body: { code: room.code } });
  assert.equal(again.status, 409);

  globalThis.__room = room;
  globalThis.__owner = owner;
  globalThis.__guest = guest;
});

test('P1 [RQ-21] 房间排名实时返回且每位成员都有排名', async () => {
  const detail = await j(await call(`/rooms/${globalThis.__room.id}`, { token: globalThis.__owner.token }));
  for (const m of detail.members) {
    assert.ok(m.rank >= 1);
    assert.ok(typeof m.returnPct === 'number');
    assert.ok(m.baseAssets > 0);
  }
});

test('P1 [RQ-22] 结束房间赛生成战绩卡，非房主无权结束', async () => {
  const noPerm = await call(`/rooms/${globalThis.__room.id}/close`, { method: 'POST', token: globalThis.__guest.token });
  assert.equal(noPerm.status, 403);

  const closed = await j(await call(`/rooms/${globalThis.__room.id}/close`, { method: 'POST', token: globalThis.__owner.token }));
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.members.every((m) => m.rank >= 1));
});

test('P2 [RQ-20] 邀请码无效返回 404，非成员查看详情返回 403', async () => {
  const bad = await call('/rooms/join', { method: 'POST', token: globalThis.__owner.token, body: { code: 'ZZZZZZ' } });
  assert.equal(bad.status, 404);

  const outsider = await registerUser('outside');
  const r = await call(`/rooms/${globalThis.__room.id}`, { token: outsider.token });
  assert.equal(r.status, 403);
});

test('P0 [RQ-23] 排行榜含超额收益列，并下发同期大盘基准', async () => {
  const board = await j(await fetch(`${base}/leaderboard?period=all`));
  const bench = await j(await fetch(`${base}/leaderboard/benchmark?period=all`));
  assert.ok(board.length > 0);
  for (const row of board) {
    assert.ok(row.excessPct !== undefined, '缺少超额收益');
    assert.equal(Number.isNaN(row.excessPct), false);
  }
  assert.ok(typeof bench.benchmarkPct === 'number');
});

/* ============================================================
 * M6 移动端与基础体验（RQ-26 ~ RQ-30）· P0/P1
 * ============================================================ */

test('P1 [RQ-26] 委托列表可查询，撤单后状态变为已撤', async () => {
  const u = await registerUser('order');
  const stock = await firstStock();
  const created = await j(await call('/orders', { method: 'POST', token: u.token, body: { code: stock.code, side: 'BUY', price: 0.01, quantity: 100 } }));
  assert.equal(created.status, 'PENDING');

  const list = await j(await call('/orders?status=PENDING', { token: u.token }));
  const found = list.find((o) => o.id === created.id);
  assert.ok(found, '委托未出现在列表中');

  const cancelled = await j(await call(`/orders/${created.id}`, { method: 'DELETE', token: u.token }));
  assert.equal(cancelled.ok, true);

  const after = await j(await call('/orders', { token: u.token }));
  assert.equal(after.find((o) => o.id === created.id).status, 'CANCELLED');
});

test('P2 [RQ-26] 撤销不存在的委托返回 404', async () => {
  const u = await registerUser('order2');
  const r = await call('/orders/99999999', { method: 'DELETE', token: u.token });
  assert.equal(r.status, 404);
});

test('P1 [RQ-27] 交易日状态接口返回当前交易日与收盘倒计时', async () => {
  const s = await j(await fetch(`${base}/market/status`));
  assert.ok(s.tradeSeq >= 1);
  assert.ok(['TRADING', 'BREAK', 'CLOSED'].includes(s.phase));
  assert.ok(s.ticksToClose >= 0);
});

test('P1 [RQ-01/F-01] 个股日 K 线可查询', async () => {
  const stock = await firstStock();
  const r = await j(await fetch(`${base}/stocks/${stock.code}/daily?days=120`));
  assert.ok(r.bars.length > 0, '无历史日线');
  const b = r.bars[0];
  for (const k of ['seq', 'open', 'high', 'low', 'close']) assert.ok(b[k] !== undefined, `缺字段 ${k}`);
});

test('P1 [RQ-28] 自选支持分组与备注，可持久化并修改', async () => {
  const u = await registerUser('watch');
  const stock = await firstStock();
  const added = await j(await call('/watchlist', { method: 'POST', token: u.token, body: { code: stock.code, group: '待观察', note: '放量突破，先看着' } }));
  assert.equal(added.group, '待观察');

  const list = await j(await call('/watchlist', { token: u.token }));
  const item = list.find((i) => i.code === stock.code);
  assert.equal(item.group, '待观察');
  assert.equal(item.note, '放量突破，先看着');

  await call(`/watchlist/${stock.code}`, { method: 'PATCH', token: u.token, body: { group: '已建仓', note: '已买入 100 股' } });
  const after = await j(await call('/watchlist', { token: u.token }));
  const updated = after.find((i) => i.code === stock.code);
  assert.equal(updated.group, '已建仓');
  assert.equal(updated.note, '已买入 100 股');

  const groups = await j(await call('/watchlist/groups', { token: u.token }));
  assert.ok(groups.some((g) => g.group === '已建仓'));
});

test('P2 [RQ-28] 添加不存在的标的返回 404', async () => {
  const u = await registerUser('watch2');
  const r = await call('/watchlist', { method: 'POST', token: u.token, body: { code: 'NOPE' } });
  assert.equal(r.status, 404);
});

test('P0 [RQ-30] 密码找回：邮箱未注册也返回统一提示，不泄露账号存在性', async () => {
  const real = await call('/auth/forgot', { method: 'POST', body: { email: 'nobody_xyz@example.com' } });
  const fake = await call('/auth/forgot', { method: 'POST', body: { email: alice.email } });
  const a = await j(real);
  const b = await j(fake);
  assert.equal(real.status, 200);
  assert.equal(a.message, b.message, '已注册与未注册返回了不同提示');
});

test('P0 [RQ-30] 用令牌可重置密码，令牌一次性', async () => {
  const res = await call('/auth/forgot', { method: 'POST', body: { email: alice.email } });
  const d = await j(res);
  assert.ok(d.devToken, '开发环境未回传令牌，无法验证流程');

  const weak = await call('/auth/reset', { method: 'POST', body: { token: d.devToken, password: '123' } });
  assert.equal(weak.status, 400, '弱密码应被拒');

  const ok = await call('/auth/reset', { method: 'POST', body: { token: d.devToken, password: 'newpass123' } });
  assert.equal(ok.status, 200);

  const reused = await call('/auth/reset', { method: 'POST', body: { token: d.devToken, password: 'another123' } });
  assert.equal(reused.status, 400, '令牌应一次性');

  const login = await j(await call('/auth/login', { method: 'POST', body: { account: alice.username, password: 'newpass123' } }));
  assert.ok(login.token, '新密码无法登录');
});

test('P2 [RQ-30] 无效/过期令牌被拒', async () => {
  const r = await call('/auth/reset', { method: 'POST', body: { token: 'deadbeef', password: 'newpass123' } });
  assert.equal(r.status, 400);
});

test('P0 [RQ-34] 账户重置需二次确认，冷却期生效并记录次数', async () => {
  const u = await registerUser('reset');
  const notice = await j(await call('/account/reset/notice', { token: u.token }));
  assert.equal(notice.canReset, true);
  assert.ok(notice.cooldownHours > 0);

  const noConfirm = await call('/account/reset', { method: 'POST', token: u.token, body: {} });
  assert.equal(noConfirm.status, 400, '未二次确认竟然通过了');

  const done = await j(await call('/account/reset', { method: 'POST', token: u.token, body: { confirm: '确认重置' } }));
  assert.equal(done.resetCount, 1);

  const cooldown = await call('/account/reset', { method: 'POST', token: u.token, body: { confirm: '确认重置' } });
  assert.equal(cooldown.status, 429, '冷却期未生效');

  // 带登录态取数：名次在 TOP_N 之外也会被钉住，确保读到最新重置记录
  const board = await j(await call('/leaderboard', { token: u.token, query: { period: 'week' } }));
  const me = board.find((r) => r.id === u.user.id);
  assert.ok(me, '自己应出现在周榜');
  assert.equal(me.resetCount, 1, '排行榜未标注重置次数');
});

/* ============================================================
 * M7 数据资产与分享层（RQ-31 ~ RQ-33）· P2
 * ============================================================ */

test('P2 [RQ-33] 偏好可读写并持久化', async () => {
  const u = await registerUser('pref');
  const saved = await j(await call('/profile/preferences', { method: 'PUT', token: u.token, body: { theme: 'dark', density: 'compact' } }));
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.density, 'compact');

  const read = await j(await call('/profile/preferences', { token: u.token }));
  assert.equal(read.theme, 'dark');

  const noop = await call('/profile/preferences', { method: 'PUT', token: u.token, body: {} });
  assert.equal(noop.status, 400);
});

/* ============================================================
 * 全局 埋点（RQ-35）· P0
 * ============================================================ */

test('P0 [RQ-35] 关键行为埋点可记录并可按日统计', async () => {
  const r = await call('/analytics/track', { method: 'POST', token: alice.token, body: { event: 'review_view', payload: { period: '30d' } } });
  assert.equal(r.status, 200);

  const unknown = await call('/analytics/track', { method: 'POST', token: alice.token, body: { event: 'hack_event' } });
  assert.equal(unknown.status, 400, '未知事件应被拒');

  const stats = await j(await call('/analytics/stats?event=review_view&days=30', { token: alice.token }));
  assert.equal(stats.event, 'review_view');
  assert.ok(Array.isArray(stats.rows));

  const overview = await j(await call('/analytics/overview?days=7', { token: alice.token }));
  assert.ok(Array.isArray(overview.events));

  const doc = await j(await fetch(`${base}/analytics/events`));
  assert.ok(doc.events.includes('replay_finish'));
  assert.ok(doc.events.includes('review_view'));
  assert.ok(doc.retentionDays >= 90, '埋点保留期不足 90 天');
});
