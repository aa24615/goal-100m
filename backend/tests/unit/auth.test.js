import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegister } from '../../src/auth.js';

// P0：注册校验是账户安全的第一道闸门，必须拒绝不合规输入
test('P0 合法用户名/邮箱/密码通过校验', () => {
  assert.equal(validateRegister('abc_123', 'a@b.com', 'abc12345'), null);
});

test('P0 用户名格式非法被拒（过短/含空格）', () => {
  assert.ok(validateRegister('ab', 'a@b.com', 'abc12345')); // 过短
  assert.ok(validateRegister('ab c', 'a@b.com', 'abc12345')); // 含空格
  assert.ok(validateRegister('a'.repeat(21), 'a@b.com', 'abc12345')); // 超长
});

test('P0 邮箱非法被拒', () => {
  assert.ok(validateRegister('abc_123', 'notanemail', 'abc12345'));
  assert.ok(validateRegister('abc_123', 'a@b', 'abc12345'));
});

test('P0 密码不合规被拒（过短/全数字/同字符）', () => {
  assert.ok(validateRegister('abc_123', 'a@b.com', '123')); // 过短
  assert.ok(validateRegister('abc_123', 'a@b.com', '12345678')); // 全数字
  assert.ok(validateRegister('abc_123', 'a@b.com', 'aaaaaaaa')); // 同一字符重复
});
