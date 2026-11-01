import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripNul, sanitizeDeep } from '../../src/utils/text.js';
import { sanitizeTextInput } from '../../src/middleware.js';

const NUL = '\u0000';

test('stripNul · 去掉字符串中的 NUL', () => {
  assert.equal(stripNul(`a${NUL}b`), 'ab');
  assert.equal(stripNul(`${NUL}${NUL}`), '');
  assert.equal(stripNul(`a${NUL}b${NUL}c`), 'abc');
});

test('stripNul · 无 NUL 时返回原引用（零拷贝，不改变既有行为）', () => {
  const s = '正常文本';
  assert.equal(stripNul(s), s);
});

test('stripNul · 非字符串原样返回，类型语义不变', () => {
  assert.equal(stripNul(123), 123);
  assert.equal(stripNul(null), null);
  assert.equal(stripNul(undefined), undefined);
  assert.equal(stripNul(true), true);
  const o = { a: 1 };
  assert.equal(stripNul(o), o);
  const arr = ['x'];
  assert.equal(stripNul(arr), arr);
});

test('stripNul · 保留换行/制表符等合法空白（不扩大清洗面）', () => {
  assert.equal(stripNul(`a\nb\tc${NUL}`), 'a\nb\tc');
  assert.equal(stripNul('a\u0007b'), 'a\u0007b', 'U+0007 PG 能接受，不应被清洗');
});

test('sanitizeDeep · 递归清洗嵌套对象与数组', () => {
  const v = { reason: `a${NUL}b`, nested: { note: [`x${NUL}`, { deep: `y${NUL}z` }] }, n: 5 };
  const out = sanitizeDeep(v);
  assert.equal(out.reason, 'ab');
  assert.equal(out.nested.note[0], 'x');
  assert.equal(out.nested.note[1].deep, 'yz');
  assert.equal(out.n, 5, '非字符串字段必须原样保留');
  assert.equal(out, v, '就地清洗：返回同一引用');
});

test('sanitizeDeep · 深度与节点数有上限，超大结构不会拖垮事件循环', () => {
  let deep = { s: `a${NUL}` };
  for (let i = 0; i < 50; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => sanitizeDeep(deep));

  const big = [];
  for (let i = 0; i < 5000; i += 1) big.push({ a: `x${NUL}`, b: { c: 'y' } });
  const t0 = Date.now();
  assert.doesNotThrow(() => sanitizeDeep(big));
  assert.ok(Date.now() - t0 < 2000, '清洗应在 2s 内完成');
});

test('sanitizeDeep · 空值与循环引用安全', () => {
  assert.equal(sanitizeDeep(null), null);
  assert.equal(sanitizeDeep(undefined), undefined);
  const cyc = { s: `a${NUL}` };
  cyc.self = cyc;
  assert.doesNotThrow(() => sanitizeDeep(cyc), '循环引用由深度上限兜住，必须终止而不是栈溢出');
});

test('sanitizeTextInput · 中间件清洗 body / query / params 三条入参通道', () => {
  const req = {
    body: { reason: `a${NUL}b` },
    query: { kw: `c${NUL}d` },
    params: { id: `7${NUL}` },
  };
  let called = false;
  sanitizeTextInput(req, {}, () => {
    called = true;
  });
  assert.equal(called, true, '必须调用 next()');
  assert.equal(req.body.reason, 'ab');
  assert.equal(req.query.kw, 'cd');
  assert.equal(req.params.id, '7');
});

test('回归 · 合法中文/emoji/引号零变化（不得误伤）', () => {
  const cases = ['正常理由', 'emoji 🚀', '引号 "x" 与 \'y\'', '多行\n文本', '{json:"like"}'];
  for (const c of cases) assert.equal(stripNul(c), c);
});
