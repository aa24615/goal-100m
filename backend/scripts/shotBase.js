/**
 * README 截图脚本的探测基址解析（配置漂移修复，方法论 #31）
 *
 * 背景：本机入口 2026-11-08 起改为 .env 的 WEB_PORT=8866（8080 被无关 python 服务占用）。
 * shot.mjs 曾写死 http://localhost:8080，运行后会截到无关服务的页面 —— 属配置漂移，
 * 不产生 5xx、日志与模糊测试都扫不到，只能靠周期性核对「脚本端口 vs compose/.env」发现。
 *
 * 口径与 verifyRelease.js 的 resolveVerifyPort 完全一致：
 *   显式环境变量优先；否则从 .env 的 WEB_PORT 解析宿主端口
 *   （与 docker-compose `${WEB_PORT:-8080}:80` 同口径）；无 .env / 非法配置回退 8080。
 * 抽成纯函数便于单测锁定「有 .env=8866 / 无 .env=8080 / 显式参数优先」三种口径。
 */
export function resolveShotBase({ envText = '', explicit = null } = {}) {
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const m = String(envText ?? '').match(/^\s*WEB_PORT\s*=\s*(\d+)\s*$/m);
  const port = m ? m[1] : '8080';
  return `http://localhost:${port}`;
}
