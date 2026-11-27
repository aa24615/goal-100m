/**
 * README 截图脚本探测基址口径单测（配置漂移修复，方法论 #31）
 *
 * 背景：本机入口 2026-11-08 起改为 .env 的 WEB_PORT=8866（8080 被无关 python 服务占用）。
 * shot.mjs 曾写死 8080，会截到无关服务页面 —— 日志与模糊均扫不到，
 * 只能靠周期性核对「脚本端口 vs compose/.env」发现并锁定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShotBase } from '../../scripts/shotBase.js';

test('P0 · 无 .env 配置时回退 8080（与 compose ${WEB_PORT:-8080} 同口径）', () => {
  assert.equal(resolveShotBase({}), 'http://localhost:8080');
  assert.equal(resolveShotBase({ envText: '# only comments\n' }), 'http://localhost:8080');
});

test('P0 · 从 .env 解析 WEB_PORT=8866，跳过注释行', () => {
  const env = '# docker-compose 使用 ${WEB_PORT:-8080}\nSOME_URL=http://x:8080\nWEB_PORT=8866\nOTHER=1';
  assert.equal(resolveShotBase({ envText: env }), 'http://localhost:8866');
});

test('P1 · WEB_PORT 带空格 / 行首缩进仍可解析', () => {
  assert.equal(resolveShotBase({ envText: '  WEB_PORT = 9000  \n' }), 'http://localhost:9000');
});

test('P1 · 非法 / 非数字 WEB_PORT 一律回退 8080', () => {
  assert.equal(resolveShotBase({ envText: 'WEB_PORT=abc' }), 'http://localhost:8080');
  assert.equal(resolveShotBase({ envText: 'WEB_PORT=' }), 'http://localhost:8080');
  assert.equal(resolveShotBase({ envText: 'WEB_PORT=80x' }), 'http://localhost:8080');
});

test('P1 · 显式 SHOT_BASE_URL 优先，并去掉尾部斜杠', () => {
  assert.equal(
    resolveShotBase({ envText: 'WEB_PORT=8866', explicit: 'http://example.com/' }),
    'http://example.com',
  );
});

test('P2 · 只认 WEB_PORT 键，不匹配 WEB_PORT_EXTRA 之类的相似键', () => {
  assert.equal(resolveShotBase({ envText: 'WEB_PORT_EXTRA=9999' }), 'http://localhost:8080');
});
