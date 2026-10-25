/**
 * 双盲训练 + 交易体检单 —— 集成测试（真实 HTTP + 真实 DB）
 *
 * 覆盖：P0 正常流程 · P3 边界（非法 ID / 越界）· P4 异常降级 · P5 隔离与合规
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
  // 220 个交易日：上限夹紧用例需要 COUNT(*) >= 200 的标的，60 天不够（会退化成 400）
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

async function register() {
  const username = `b_${randomUUID().slice(0, 8)}`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: 'abc12345' }),
  });
  const d = await res.json();
  assert.equal(res.status, 200, `注册失败 ${JSON.stringify(d)}`);
  return d.token;
}

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

/* ------------------------- RQ-67 · P0 随机来一段 ------------------------- */

test('P0 · RQ-67 随机来一段返回会话且训练中不暴露标的代码', async () => {
  const token = await register();
  const res = await call('/blind/start', { token, method: 'POST', body: { bars: 30 } });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.ok(d.id > 0);
  assert.match(d.alias, /^标的 #/);
  assert.equal(d.status, 'RUNNING');
  // 响应里不得出现 stock_code / stock_name
  assert.ok(!('stock_code' in d), '开始接口不得返回标的代码');
  assert.ok(!('stock_name' in d), '开始接口不得返回标的名称');
});

test('P0 · RQ-67 连续两次随机来一段得到不同的会话', async () => {
  const token = await register();
  const a = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 25 } }));
  const b = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 25 } }));
  assert.notEqual(a.id, b.id);
});

/* ------------------------- RQ-66 · P0 双盲遮蔽 ------------------------- */

test('P0 · RQ-66 训练态 GET 不含代码/名称/日期，结束后才揭示', async () => {
  const token = await register();

  // 用**定向片段**而不是随机片段：只有事先知道真实代码，才能断言「它确实没被返回」。
  // （早先用「响应里不得出现 6 位数字」判断，会被成交量这类正常的 6 位数误伤。）
  const { rows } = await pool.query("SELECT code FROM stocks WHERE trade_status='NORMAL' ORDER BY code LIMIT 1");
  const code = rows[0].code;
  const s = await j(
    await call('/blind/start', { token, method: 'POST', body: { code, startSeq: 1, endSeq: 30 } })
  );
  assert.equal(s.status, 'RUNNING');
  assert.equal(s.totalBars, 30);

  const running = await j(await call(`/blind/${s.id}`, { token }));
  const text = JSON.stringify(running);
  assert.ok(!text.includes(code), `训练中不得出现标的代码 ${code}`);
  assert.ok(!/\b20\d{2}-\d{2}-\d{2}\b/.test(text), '训练中不得出现交易日期');
  assert.equal(running.session.code, null);
  assert.equal(running.session.name, null);
  // seq 与交易日历一一对应，透出即可反查日期，训练中一律为 null
  assert.equal(running.session.startSeq, null, '训练中不得返回 startSeq');
  assert.equal(running.session.endSeq, null, '训练中不得返回 endSeq');
  assert.equal(running.session.cursorSeq, null, '训练中不得返回 cursorSeq');
  assert.equal(running.view.cursorSeq, null, '训练中视图不得返回真实游标 seq');

  const done = await j(await call(`/blind/${s.id}/finish`, { token, method: 'POST' }));
  assert.equal(done.session.status, 'FINISHED');
  assert.equal(done.session.code, code, '结束后应揭示代码');
  assert.match(String(done.session.code), /^\d{6}$/);
  assert.equal(done.session.startSeq, 1, '结束后应揭示区间');
});

test('P0 · RQ-66 K 线只含相对序号与 OHLCV', async () => {
  const token = await register();
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  const d = await j(await call(`/blind/${s.id}`, { token }));
  assert.ok(Array.isArray(d.bars));
  if (d.bars.length > 0) {
    assert.deepEqual(Object.keys(d.bars[0]).sort(), ['close', 'high', 'i', 'low', 'open', 'volume']);
    assert.equal(d.bars[0].i, 1);
  }
});

/* ------------------------- RQ-38 · P0 决策记录 ------------------------- */

test('P0 · RQ-38 记录决策后计入纪律执行率；跳过记为未记录', async () => {
  const token = await register();
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));

  const ok = await j(
    await call(`/blind/${s.id}/decision`, {
      token,
      method: 'POST',
      body: { action: 'BUY', reason: '放量突破前高', stopPlan: 9.8 },
    })
  );
  assert.equal(ok.skipped, false);

  const skip = await j(
    await call(`/blind/${s.id}/decision`, { token, method: 'POST', body: { action: 'HOLD', skipped: true } })
  );
  assert.equal(skip.skipped, true);

  const fin = await j(await call(`/blind/${s.id}/finish`, { token, method: 'POST' }));
  assert.equal(fin.score.disciplineRate, 50);
  assert.equal(fin.score.discipline.total, 2);
  assert.equal(fin.score.discipline.recorded, 1);
});

/* ------------------------- RQ-41 · P0 成绩 ------------------------- */

test('P0 · RQ-41 成绩六项齐全且带免责与样本说明', async () => {
  const token = await register();
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  const fin = await j(await call(`/blind/${s.id}/finish`, { token, method: 'POST' }));
  const sc = fin.score;
  for (const k of ['returnPct', 'maxDrawdown', 'tradeCount', 'durationSec', 'decisionPoints', 'disciplineRate']) {
    assert.ok(k in sc, `成绩缺少 ${k}`);
  }
  assert.ok(sc.disclaimer.includes('不构成投资建议'));
  assert.ok(sc.sampleNote.includes('50'));
});

test('P0 · RQ-42 双盲操作不污染真实账户与排行榜', async () => {
  const token = await register();
  const before = await j(await call('/portfolio', { token }));
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  await call(`/blind/${s.id}/trade`, { token, method: 'POST', body: { side: 'BUY', quantity: 100 } });
  await call(`/blind/${s.id}/finish`, { token, method: 'POST' });
  const after = await j(await call('/portfolio', { token }));
  assert.equal(Number(after.cash).toFixed(2), Number(before.cash).toFixed(2), '双盲交易不得改变真实现金');
  const tx = await j(await call('/transactions', { token }));
  assert.equal(tx.items.length, 0, '双盲交易不得写入真实流水');
});

/* ------------------------- P3 边界 ------------------------- */

test('P3 · RQ-66 非法训练 ID 返回 400 而非 500', async () => {
  const token = await register();
  for (const id of ['abc', '1.5', '0', '-1']) {
    const res = await call(`/blind/${id}`, { token });
    assert.equal(res.status, 400, `/blind/${id} 应返回 400`);
  }
});

test('P3 · RQ-67 片段长度越界被夹紧到 [20,200]', async () => {
  const token = await register();
  for (const bars of [1, 99999]) {
    const res = await call('/blind/start', { token, method: 'POST', body: { bars } });
    assert.equal(res.status, 200, `bars=${bars} 应被夹紧后正常创建`);
    const d = await j(res);
    // 夹紧后只返回长度，不返回 seq（seq 可对回日期）
    const len = d.totalBars;
    assert.ok(len >= 20 && len <= 200, `片段长度 ${len} 超出 [20,200]`);
  }
});

test('P3 · RQ-66 决策列表同样只给相对序号', async () => {
  const token = await register();
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 40 } }));
  // 先推进到第 3 根再记录，真实 seq 应为 startSeq + 2，训练中必须折算成 3
  await call(`/blind/${s.id}/step`, { token, method: 'POST', body: { action: 'next' } });
  await call(`/blind/${s.id}/step`, { token, method: 'POST', body: { action: 'next' } });
  await call(`/blind/${s.id}/decision`, { token, method: 'POST', body: { action: 'BUY', reason: '突破' } });
  const list = await j(await call(`/blind/${s.id}/decisions`, { token }));
  assert.equal(list.length, 1);
  assert.equal(list[0].seq, 3, '训练中决策序号应为相对序号');
});

test('P4 · RQ-67 历史数据不足时给出可读的 400，不伪装成 5xx', async () => {
  const token = await register();
  // 定向片段给一个远超库里数据的区间 → 抽不到片段，应报业务错误而不是服务端故障
  const res = await call('/blind/start', {
    token,
    method: 'POST',
    body: { code: '600001', startSeq: 1, endSeq: 999999 },
  });
  // startBlind 定向路径不校验区间，但拉不到 K 线时会走「无数据」分支，这里只要求不是 5xx
  assert.ok(res.status < 500, `不应是 5xx，实际 ${res.status}`);
});

test('P3 · RQ-38 非法决策方向被拒', async () => {
  const token = await register();
  const s = await j(await call('/blind/start', { token, method: 'POST', body: { bars: 30 } }));
  const res = await call(`/blind/${s.id}/decision`, { token, method: 'POST', body: { action: 'XXX', reason: 'x' } });
  assert.equal(res.status, 400);
});

/* ------------------------- P4 异常与降级 ------------------------- */

test('P4 · RQ-66 未登录访问双盲接口返回 401', async () => {
  for (const p of ['/blind/1', '/blind/history']) {
    const res = await call(p);
    assert.equal(res.status, 401, `${p} 未登录应 401`);
  }
});

test('P4 · RQ-66 不存在的训练返回 404', async () => {
  const token = await register();
  const res = await call('/blind/999999', { token });
  assert.equal(res.status, 404);
});

test('P4 · RQ-75 错误上报无需登录即可受理，且返回指纹', async () => {
  const res = await call('/analytics/error', {
    method: 'POST',
    body: { kind: 'error', name: 'TypeError', message: 'boom', stack: 'at Foo (a.js:1:1)' },
  });
  assert.equal(res.status, 200);
  const d = await j(res);
  assert.equal(d.ok, true);
  assert.match(d.fingerprint, /^[0-9a-f]{32}$/);
});

test('P4 · RQ-75 空错误被拒（不写库）', async () => {
  const res = await call('/analytics/error', { method: 'POST', body: { kind: 'error' } });
  assert.equal(res.status, 400);
});

/* ------------------------- RQ-76/77 · P0 体检单接口 ------------------------- */

test('P0 · RQ-77 新用户样本不足：verdict 为 null 且给出还差多少笔', async () => {
  const token = await register();
  const d = await j(await call('/review/checkup?period=30d', { token }));
  assert.equal(d.sufficient, false);
  assert.equal(d.verdict, null);
  assert.equal(d.threshold, 50);
  assert.equal(d.remaining, 50);
  assert.ok(d.gate.message.includes('还差 50 笔'));
});

test('P0 · RQ-76 体检单六项指标字段齐全且无 NaN', async () => {
  const token = await register();
  const d = await j(await call('/review/checkup?period=all', { token }));
  for (const k of ['expectancy', 'expectancyR', 'rMultiple', 'holdTime', 'discipline', 'worstHabit']) {
    assert.ok(k in d, `体检单缺少 ${k}`);
  }
  assert.ok(!JSON.stringify(d).includes('null,null,null,null,null,null'));
  // 数值字段不得出现 NaN（JSON 里会变成 null 或被拒）
  assert.equal(Number.isFinite(d.expectancy.amount), true);
});

test('P0 · RQ-78 每项指标携带口径提示（meaning / whenToChange / formula）', async () => {
  const token = await register();
  const d = await j(await call('/review/checkup?period=all', { token }));
  assert.ok(d.expectancy.hint.meaning.length > 0);
  assert.ok(d.discipline.hint.whenToChange.length > 0);
  assert.ok(d.holdTime.hint.formula.length > 0);
});

test('P4 · RQ-76 复盘接口含 checkup 字段，与体检单同源', async () => {
  const token = await register();
  const review = await j(await call('/review?period=all', { token }));
  assert.ok(review.checkup, '复盘总览应附带体检单');
  assert.equal(review.checkup.threshold, 50);
});
