/**
 * RQ-123 发布后验证 —— 探测端口口径单测
 *
 * 背景：本机入口 2026-11-08 起改为 .env 的 WEB_PORT=8866（8080 被无关服务占用）。
 * verifyRelease.js 若写死 8080，会把健康的生产误判为 stage-zero/status-truth/
 * telemetry 三项 fetch failed —— 属配置漂移（方法论 #31），日志与模糊均扫不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVerifyPort } from '../../src/scripts/verifyRelease.js';

test('P0 · 无 .env 配置时回退 8080（与 compose ${WEB_PORT:-8080} 同口径）', () => {
  assert.equal(resolveVerifyPort(''), '8080');
  assert.equal(resolveVerifyPort('# only comments\n'), '8080');
});

test('P0 · 从 .env 解析 WEB_PORT=8866，跳过注释行', () => {
  const env = '# docker-compose 使用 ${WEB_PORT:-8080}\nSOME_URL=http://x:8080\nWEB_PORT=8866\nOTHER=1';
  assert.equal(resolveVerifyPort(env), '8866');
});

test('P1 · WEB_PORT 带空格 / 行首缩进仍可解析', () => {
  assert.equal(resolveVerifyPort('  WEB_PORT = 9000  \n'), '9000');
});

test('P1 · 非法 / 非数字 WEB_PORT 一律回退 8080', () => {
  assert.equal(resolveVerifyPort('WEB_PORT=abc'), '8080');
  assert.equal(resolveVerifyPort('WEB_PORT='), '8080');
  assert.equal(resolveVerifyPort('WEB_PORT=80x'), '8080');
});

test('P2 · 只认 WEB_PORT 键，不匹配 WEB_PORT_EXTRA 之类的相似键', () => {
  assert.equal(resolveVerifyPort('WEB_PORT_EXTRA=9999'), '8080');
});
