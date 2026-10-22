import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyClientIp, TRUST_PROXY_HOPS } from '../../src/middleware.js';

// P1：WebSocket upgrade 不经过 Express，必须自行按「受信任跳数」回推真实客户端 IP。
// 日志里 8600+ 条鉴权失败记录的 ip 全是 nginx 容器地址，正是缺少这一步导致无法溯源。

function req(headers = {}, remote = '172.18.0.3') {
  return { headers, socket: { remoteAddress: remote } };
}

test('P1 trust proxy = 1 时取右起第二跳（真实客户端），忽略伪造前缀', () => {
  const r = req({ 'x-forwarded-for': '1.2.3.4, 192.168.96.1' });
  assert.equal(proxyClientIp(r), '192.168.96.1');
});

test('P1 只有一跳 XFF 时取该跳本身', () => {
  assert.equal(proxyClientIp(req({ 'x-forwarded-for': '192.168.96.1' })), '192.168.96.1');
});

test('P1 XFF 超过信任跳数时与 Express(proxy-addr) 结果一致（取 index=min(len-1,N)）', () => {
  // ["a","b","c"] 在 trust proxy=1 下，Express 返回 index 1 => "b"
  assert.equal(proxyClientIp(req({ 'x-forwarded-for': 'a, b, c' })), 'b');
  assert.equal(TRUST_PROXY_HOPS, 1);
});

test('P1 无 XFF 时退化为直连对端地址，不臆造来源', () => {
  assert.equal(proxyClientIp(req({}, '172.18.0.3')), '172.18.0.3');
});

test('P1 空/空白 XFF 头不会返回空字符串', () => {
  assert.equal(proxyClientIp(req({ 'x-forwarded-for': '   ' }, '172.18.0.3')), '172.18.0.3');
});

test('P1 缺少 socket 信息时返回 unknown 而非抛错', () => {
  assert.equal(proxyClientIp({ headers: {} }), 'unknown');
  assert.equal(proxyClientIp(undefined), 'unknown');
});
