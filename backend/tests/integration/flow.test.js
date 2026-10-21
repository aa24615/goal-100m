import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/index.js';
import pool from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';
import { seedStocks } from '../../src/seed.js';
import { loadMarket } from '../../src/market.js';
import { createOrder, matchOrders, listOrders } from '../../src/orders.js';

let server;
let base;
let auth; // 主测试账号 { token, user, username, email }

async function setup() {
  // 确保隔离测试库存在（与运行中的开发库 papertrade 互不干扰）
  const admin = new pg.Pool({
    connectionString: process.env.DATABASE_URL.replace('/papertrade_test', '/postgres'),
  });
  const ex = await admin.query("SELECT 1 FROM pg_database WHERE datname='papertrade_test'");
  if (ex.rows.length === 0) await admin.query('CREATE DATABASE papertrade_test');
  await admin.end();

  await runMigrations(pool);
  await seedStocks();
  await loadMarket();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}/api`;
}

async function teardown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
}

before(setup);
after(teardown);

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
  return { token: data.token, user: data.user, username, email };
}

async function firstStock() {
  const res = await fetch(`${base}/stocks`);
  const arr = await res.json();
  return arr[0];
}

const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

// ---------- P0：注册 / 登录 / 鉴权 ----------
test('P0 注册成功并返回 token 与用户资料', async () => {
  auth = await registerUser('p0');
  assert.ok(auth.token, '应返回 token');
  assert.equal(auth.user.username, auth.username);
  assert.equal(auth.user.initialCapital, 1000000);
});

test('P0 登录成功并可凭 token 访问受保护接口', async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: auth.username, password: 'abc12345' }),
  });
  const data = await j(res);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.ok(data.token);

  const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${data.token}` } });
  const meData = await j(me);
  assert.equal(meData.username, auth.username);
});

test('P0 重复注册返回 409', async () => {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: auth.username, email: 'dup@example.com', password: 'abc12345' }),
  });
  assert.equal(res.status, 409);
});

test('P0 弱密码被拒（长度 < 8）', async () => {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `weak_${randomUUID().slice(0, 8)}`, email: 'w@example.com', password: '123' }),
  });
  assert.equal(res.status, 400);
});

// ---------- P0/P1：买入 / 持仓 / 交易记录 ----------
test('P0 买入成功后持仓与交易记录各 +1', async () => {
  const stock = await firstStock();
  const price = stock.price;
  const res = await fetch(`${base}/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ code: stock.code, type: 'BUY', quantity: 100, clientPrice: price }),
  });
  const data = await j(res);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);

  const pf = await fetch(`${base}/portfolio`, { headers: { Authorization: `Bearer ${auth.token}` } });
  const pdata = await j(pf);
  assert.equal(pdata.holdings.length, 1);
  assert.equal(pdata.holdings[0].code, stock.code);
  assert.equal(pdata.holdings[0].quantity, 100);

  const tx = await fetch(`${base}/transactions`, { headers: { Authorization: `Bearer ${auth.token}` } });
  const tdata = await j(tx);
  assert.equal(tdata.total, 1);
  assert.equal(tdata.items[0].type, 'BUY');
});

// ---------- P1：T+1 当日买入不可卖 ----------
test('P1 T+1 当日买入部分不可卖出', async () => {
  const stock = await firstStock();
  const price = stock.price;
  const res = await fetch(`${base}/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ code: stock.code, type: 'SELL', quantity: 100, clientPrice: price }),
  });
  const data = await j(res);
  assert.equal(res.status, 400, JSON.stringify(data));
  assert.match(data.error, /T\+1|冻结/);
});

// ---------- P1：资金不足拒绝 ----------
test('P1 资金不足买入被拒', async () => {
  const stock = await firstStock();
  const res = await fetch(`${base}/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ code: stock.code, type: 'BUY', quantity: 100000, clientPrice: stock.price }),
  });
  const data = await j(res);
  assert.equal(res.status, 400);
  assert.match(data.error, /资金/);
});

// ---------- P1：报价偏离保护 ----------
test('P1 报价偏离过大被拒（409）', async () => {
  const stock = await firstStock();
  const res = await fetch(`${base}/trade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ code: stock.code, type: 'BUY', quantity: 100, clientPrice: stock.price * 0.5 }),
  });
  const data = await j(res);
  assert.equal(res.status, 409);
});

// ---------- P2：排行榜包含本用户 ----------
test('P2 排行榜包含本用户并带超额收益列', async () => {
  const res = await fetch(`${base}/leaderboard?period=all`);
  const data = await j(res);
  assert.ok(Array.isArray(data));
  const me = data.find((x) => x.username === auth.username);
  assert.ok(me, '排行榜应包含本用户');
  assert.ok('excessPct' in me);
  assert.ok('returnPct' in me);
});

// ---------- P2：资产曲线结构正确 ----------
test('P2 资产曲线返回账户分账与序列', async () => {
  const res = await fetch(`${base}/equity?gran=day&days=30`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const data = await j(res);
  assert.equal(res.status, 200);
  assert.ok(data.accounts && 'totalAssets' in data.accounts);
  assert.ok(data.summary && 'maxDrawdown' in data.summary);
  assert.ok(Array.isArray(data.series) && data.series.length >= 1);
});

// ---------- P3：限价委托撮合 ----------
test('P3 限价买单在市价达标后成交', async () => {
  const stock = await firstStock();
  const limitPrice = Number(stock.price); // 等于市价，BUY 条件 market>=limit 成立
  const created = await createOrder({
    userId: auth.user.id,
    code: stock.code,
    side: 'BUY',
    limitPrice,
    quantity: 100,
  });
  assert.equal(created.status, 'PENDING');

  const filled = await matchOrders();
  assert.ok(filled >= 1, '应撮合至少 1 笔');

  const list = await listOrders(auth.user.id);
  const order = list.find((o) => o.id === created.id);
  assert.equal(order.status, 'FILLED');
});

// ---------- P3：个人资料更新 ----------
test('P3 更新昵称与头像生效', async () => {
  const res = await fetch(`${base}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ displayName: '小狐狸', avatar: 'fox' }),
  });
  const data = await j(res);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.displayName, '小狐狸');
  assert.equal(data.avatar, 'fox');
});

test('P3 无效头像被拒', async () => {
  const res = await fetch(`${base}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ avatar: 'not_a_avatar' }),
  });
  assert.equal(res.status, 400);
});

// ---------- P3：重置账户 ----------
test('P3 重置账户清空持仓并恢复初始资金', async () => {
  const res = await fetch(`${base}/account/reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const data = await j(res);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.cash, 1000000);

  const pf = await fetch(`${base}/portfolio`, { headers: { Authorization: `Bearer ${auth.token}` } });
  const pdata = await j(pf);
  assert.equal(pdata.holdings.length, 0);
});
