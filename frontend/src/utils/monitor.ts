/**
 * 可观测底座：埋点（RQ-74）与前端运行时错误上报（RQ-75）。
 *
 * 为什么需要它：浏览器侧的崩溃与 unhandledrejection 在服务端日志里**完全不可见**，
 * 线上缺陷只能靠用户撞出来再从生产日志回溯（F-00 元级缺陷）。
 * 本模块是「先装仪表盘再修车」的那块仪表盘。
 *
 * 硬约束：
 * 1. **不采集任何未脱敏的个人身份信息** —— payload 里的 token / 密码 / 手机号 / 邮箱
 *    一律在出站前剔除，服务端还会再兜一层。
 * 2. **埋点失败绝不影响业务** —— 网络异常、接口 4xx 都只静默放弃，不抛错、不阻断交互。
 * 3. **同一错误在进程内去重** —— 一个死循环报错不能把上报接口打挂。
 */

import api from '../api';
import { TRACK_EVENTS } from './trackEvents';

// 需要剔除的敏感字段（键名匹配即丢弃，不区分大小写）
const PII_KEY = /(pass|token|secret|authorization|cookie|phone|mobile|email|idcard|cardno|身份证|手机|邮箱|密码)/i;
const MAX_TEXT = 2000;

export function sanitizePayload(payload?: Record<string, unknown>) {
  if (!payload || typeof payload !== 'object') return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(payload)) {
    if (n >= 20) break; // 兜住体积，避免把整页数据塞进上报
    if (PII_KEY.test(k)) continue;
    if (v == null) continue;
    if (typeof v === 'object') {
      out[k] = JSON.stringify(v).slice(0, 300);
    } else {
      out[k] = String(v).slice(0, 300);
    }
    n += 1;
  }
  return out;
}

const TRACKABLE = new Set<string>(TRACK_EVENTS);

/** 只允许上报白名单内的事件，避免后端被未知事件灌爆 */
export function isTrackable(event: string): boolean {
  return TRACKABLE.has(event);
}

let queue: Array<{ event: string; payload: Record<string, unknown> }> = [];
let flushing = false;

/**
 * 埋点上报。
 * @returns 是否进入上报流程（true 不代表成功——失败一律静默，业务不感知）
 */
export function track(event: string, payload?: Record<string, unknown>): boolean {
  if (!isTrackable(event)) {
    // 用 import.meta.env 而非 process：前端运行在浏览器，没有 node 的 process 全局
    if (import.meta.env?.DEV) {
      // 开发期提示拼写错误，避免「写了埋点但永远不上报」这种静默失效
      // eslint-disable-next-line no-console
      console.warn(`[track] 未知事件类型：${event}`);
    }
    return false;
  }
  queue.push({ event, payload: sanitizePayload(payload) });
  void flush();
  return true;
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    // 逐条发送：批量接口尚未提供，且埋点量级小（每次交互 1~2 条）
    for (const item of batch) {
      try {
        await api.post('/analytics/track', { event: item.event, payload: item.payload });
      } catch {
        // 静默：埋点失败不得影响业务，也不得弹错误提示
      }
    }
  } finally {
    flushing = false;
  }
  // flush 期间新产生的埋点继续处理
  if (queue.length > 0) void flush();
}

/* ------------------------------------------------------------------ *
 * RQ-75 错误上报                                                      *
 * ------------------------------------------------------------------ */

const sentFingerprints = new Set<string>();
const MAX_TRACKED = 200;

function fingerprintOf(name: string, message: string, stack?: string) {
  const first = String(stack || '')
    .split('\n')
    .find((l) => l.includes('at '));
  return `${name}|${message.slice(0, 120)}|${(first || '').trim().slice(0, 120)}`;
}

export interface ReportInput {
  kind?: 'error' | 'unhandledrejection' | 'manual';
  name?: string;
  message?: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/** 上报一条前端错误；重复指纹只报一次，失败静默 */
export function reportError(input: ReportInput): boolean {
  const name = String(input.name || 'Error');
  const message = String(input.message || '');
  if (!message && !input.stack) return false;

  const fp = fingerprintOf(name, message, input.stack);
  if (sentFingerprints.has(fp)) return false;
  if (sentFingerprints.size >= MAX_TRACKED) sentFingerprints.clear();
  sentFingerprints.add(fp);

  try {
    void api.post('/analytics/error', {
      kind: input.kind || 'error',
      name,
      message: message.slice(0, MAX_TEXT),
      stack: (input.stack || '').slice(0, MAX_TEXT),
      url: typeof window !== 'undefined' ? window.location.href.slice(0, 512) : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 512) : undefined,
      appVersion: APP_VERSION,
      context: sanitizePayload(input.context),
    });
    return true;
  } catch {
    return false;
  }
}

export const APP_VERSION = 'v6';

/** 安装全局捕获：window.onerror + unhandledrejection */
export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return () => {};

  const onError = (message: unknown, source?: string, lineno?: number, colno?: number, error?: unknown) => {
    reportError({
      kind: 'error',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(message),
      stack: error instanceof Error ? error.stack : `at ${source}:${lineno}:${colno}`,
      context: { source, lineno, colno },
    });
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    const r = ev.reason;
    reportError({
      kind: 'unhandledrejection',
      name: r instanceof Error ? r.name : 'UnhandledRejection',
      message: r instanceof Error ? r.message : String(r),
      stack: r instanceof Error ? r.stack : undefined,
      context: { type: 'unhandledrejection' },
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** 测试用：清空去重集合与队列 */
export function resetMonitorForTest() {
  sentFingerprints.clear();
  queue = [];
  flushing = false;
}
