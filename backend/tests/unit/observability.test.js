/**
 * RQ-74 埋点口径 / RQ-75 前端运行时错误上报 —— 单元测试
 *
 * 重点验证两件事：
 *   1) 上报**不采集未脱敏的个人身份信息**（合规硬约束）
 *   2) 埋点与错误上报**失败不影响业务**（异常全部静默）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeContext,
  errorFingerprint,
  EVENTS,
  isValidEvent,
} from '../../src/services/analyticsService.js';

/* -------------------- RQ-74 · P0 埋点口径 -------------------- */

test('P0 · RQ-74 事件白名单覆盖全部必要节点（含双盲与体检单）', () => {
  const required = [
    'replay_start',
    'replay_finish',
    'review_view',
    'room_join',
    'room_create',
    'guide_complete',
    'task_complete',
    'checkin',
    'blind_start',
    'blind_decision',
    'blind_finish',
    'checkup_view',
  ];
  for (const e of required) {
    assert.ok(EVENTS.includes(e), `缺少埋点事件 ${e}`);
    assert.equal(isValidEvent(e), true);
  }
});

test('P0 · RQ-74 未知事件被拒绝（不写库，避免污染统计口径）', () => {
  for (const bad of ['', 'unknown_event', null, undefined, 123, 'REPLAY_START']) {
    assert.equal(isValidEvent(bad), false, `${bad} 不应被认定为合法事件`);
  }
});

test('P0 · RQ-74 checkin 事件存在——打卡此前前端 0 处调用，北极星指标无从谈起', () => {
  assert.ok(EVENTS.includes('checkin'));
});

/* -------------------- RQ-75 · P0 脱敏 -------------------- */

test('P0 · RQ-75 敏感字段一律剔除：token / password / 手机 / 邮箱', () => {
  const ctx = sanitizeContext({
    token: 'eyJhbGciOi...',
    password: '123456',
    Authorization: 'Bearer x',
    cookie: 'sid=1',
    phone: '13800001111',
    email: 'a@b.com',
    idcard: '110101199001011234',
    route: '/market',
    component: 'TrainingHub',
  });
  const text = JSON.stringify(ctx);
  assert.ok(!text.includes('eyJhbGciOi'));
  assert.ok(!text.includes('123456'));
  assert.ok(!text.includes('13800001111'));
  assert.ok(!text.includes('a@b.com'));
  assert.ok(!text.includes('110101199001011234'));
  // 非敏感的业务上下文必须保留，否则排障没有抓手
  assert.equal(ctx.route, '/market');
  assert.equal(ctx.component, 'TrainingHub');
});

test('P0 · RQ-75 嵌套对象与超长文本被截断', () => {
  const ctx = sanitizeContext({ deep: { a: 'x'.repeat(500) }, long: 'y'.repeat(5000) });
  assert.ok(JSON.stringify(ctx).length < 1200);
  assert.ok(String(ctx.deep).length <= 300);
});

/* -------------------- P3 边界条件 -------------------- */

test('P3 · RQ-75 空 / 非法上下文返回空对象，不抛错', () => {
  for (const input of [undefined, null, 'str', 123, [], true]) {
    assert.deepEqual(sanitizeContext(input), {});
  }
});

test('P3 · RQ-75 字段数量上限 20，防止整页 DOM 被塞进数据库', () => {
  const big = {};
  for (let i = 0; i < 500; i += 1) big[`k${i}`] = i;
  const out = sanitizeContext(big);
  assert.equal(Object.keys(out).length, 20);
});

test('P3 · RQ-75 null / undefined 值被丢弃而非写入字符串 "undefined"', () => {
  const out = sanitizeContext({ a: null, b: undefined, c: 'ok' });
  assert.deepEqual(Object.keys(out), ['c']);
});

/* -------------------- RQ-75 · P0/P4 指纹稳定性 -------------------- */

test('P0 · RQ-75 同一错误（相同堆栈）指纹一致，可聚合', () => {
  const a = errorFingerprint({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'map')",
    stack: 'TypeError: boom\n    at Foo.bar (http://localhost/a.js:1:2)\n    at Baz (http://localhost/b.js:3:4)',
  });
  const b = errorFingerprint({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'map')",
    stack: 'TypeError: boom\n    at Foo.bar (http://localhost/a.js:1:2)\n    at Baz (http://localhost/b.js:3:4)',
  });
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test('P0 · RQ-75 不同错误位置指纹不同，不会被错误合并', () => {
  const common = { name: 'TypeError', message: 'boom' };
  const a = errorFingerprint({ ...common, stack: 'at Foo (a.js:1:1)' });
  const b = errorFingerprint({ ...common, stack: 'at Foo (b.js:2:2)' });
  assert.notEqual(a, b);
});

test('P4 · RQ-75 缺 name / message / stack 时仍能生成指纹（不抛错）', () => {
  const fp = errorFingerprint({});
  assert.equal(typeof fp, 'string');
  assert.equal(fp.length, 32);
  const fp2 = errorFingerprint({});
  assert.equal(fp, fp2, '空输入的指纹必须稳定');
});

test('P4 · RQ-75 超长 message 不影响指纹长度', () => {
  const fp = errorFingerprint({ name: 'E', message: 'x'.repeat(100000), stack: 'at a' });
  assert.equal(fp.length, 32);
});
