/**
 * RQ-74 埋点 / RQ-75 前端错误上报 —— 前端测试
 *
 * 覆盖：P0 正常流程 · P3 边界 · P4 异常降级 · P5 合规（不采集未脱敏个人信息）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 必须在 import 被测模块之前 mock api，否则会发出真实请求
vi.mock('../api', () => {
  const post = vi.fn(() => Promise.resolve({ data: { ok: true } }));
  return { default: { post }, __post: post };
});

import api from '../api';
import {
  track,
  reportError,
  sanitizePayload,
  isTrackable,
  installGlobalErrorHandlers,
  resetMonitorForTest,
} from './monitor';

const post = (api as unknown as { post: ReturnType<typeof vi.fn> }).post;

describe('RQ-74 埋点（P0 正常流程）', () => {
  beforeEach(() => {
    post.mockClear();
    resetMonitorForTest();
  });

  it('P0 · 合法事件被真实发出（此前全仓 0 处调用）', async () => {
    const ok = track('replay_start', { startSeq: 1 });
    expect(ok).toBe(true);
    expect(post).toHaveBeenCalled();
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/analytics/track');
    expect(body.event).toBe('replay_start');
  });

  it('P0 · 双盲与体检单事件都在白名单内', () => {
    for (const e of ['blind_start', 'blind_decision', 'blind_finish', 'checkup_view', 'checkin']) {
      expect(isTrackable(e)).toBe(true);
    }
  });

  it('P0 · 埋点携带的业务字段原样透传', async () => {
    track('review_view', { period: '30d' });
    expect(post.mock.calls[0][1].payload).toEqual({ period: '30d' });
  });
});

describe('RQ-74 埋点（P3 边界 / P4 异常）', () => {
  beforeEach(() => {
    post.mockClear();
    resetMonitorForTest();
  });

  it('P3 · 未知事件被丢弃，不发请求也不抛错', () => {
    expect(track('hack_event')).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('P3 · payload 为 null / 非法类型时安全降级为空对象', async () => {
    track('checkin', undefined);
    expect(post.mock.calls[0][1].payload).toEqual({});
  });

  it('P4 · 后端返回 4xx 时静默失败，不影响业务', async () => {
    post.mockRejectedValueOnce({ response: { status: 400 } });
    expect(() => track('replay_finish', {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(post).toHaveBeenCalled();
  });

  it('P4 · 网络完全不可用时也不抛错（埋点不得阻断交互）', async () => {
    post.mockRejectedValueOnce(new Error('Network Error'));
    expect(() => track('room_join', {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('RQ-75 错误上报（P0 正常流程）', () => {
  beforeEach(() => {
    post.mockClear();
    resetMonitorForTest();
  });
  afterEach(() => vi.restoreAllMocks());

  it('P0 · 错误被上报到 /analytics/error，并带上 url 与 ua', () => {
    const ok = reportError({ name: 'TypeError', message: 'boom', stack: 'at Foo (a.js:1:1)' });
    expect(ok).toBe(true);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/analytics/error');
    expect(body.name).toBe('TypeError');
    expect(body.message).toBe('boom');
    expect(typeof body.url).toBe('string');
  });

  it('P0 · 同一指纹只上报一次，避免死循环打挂上报接口', () => {
    reportError({ name: 'E', message: 'same', stack: 'at X (a.js:1:1)' });
    reportError({ name: 'E', message: 'same', stack: 'at X (a.js:1:1)' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('P0 · 不同位置的错误分别上报', () => {
    reportError({ name: 'E', message: 'm', stack: 'at A (a.js:1:1)' });
    reportError({ name: 'E', message: 'm', stack: 'at B (b.js:2:2)' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('P0 · window.onerror 与 unhandledrejection 均已安装', () => {
    const spyOn = vi.spyOn(window, 'addEventListener');
    const off = installGlobalErrorHandlers();
    const kinds = spyOn.mock.calls.map((c) => c[0]);
    expect(kinds).toContain('error');
    expect(kinds).toContain('unhandledrejection');
    off();
    spyOn.mockRestore();
  });

  it('P0 · 全局捕获能把 window error 事件转成上报', () => {
    resetMonitorForTest();
    installGlobalErrorHandlers();
    window.dispatchEvent(
      Object.assign(new Event('error'), { message: 'Uncaught boom', error: new Error('boom') })
    );
    expect(post).toHaveBeenCalled();
    expect(post.mock.calls[0][1].kind).toBe('error');
  });
});

describe('RQ-75 上报脱敏（P5 合规硬约束）', () => {
  beforeEach(() => {
    post.mockClear();
    resetMonitorForTest();
  });

  it('P5 · 埋点 payload 中的 token / password / 手机号被剔除', () => {
    track('checkin', {
      token: 'eyJhbGciOi',
      password: 'p@ss',
      phone: '13800001111',
      email: 'a@b.com',
      streak: 3,
    });
    const payload = post.mock.calls[0][1].payload;
    expect(payload.token).toBeUndefined();
    expect(payload.password).toBeUndefined();
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
    // 非敏感字段保留（统一字符串化，保证体积可控且可 JSON 序列化）
    expect(payload.streak).toBe('3');
  });

  it('P5 · 错误上下文同样脱敏', () => {
    reportError({ name: 'E', message: 'x', context: { authorization: 'Bearer a', route: '/market' } });
    const ctx = post.mock.calls[0][1].context;
    expect(ctx.authorization).toBeUndefined();
    expect(ctx.route).toBe('/market');
  });

  it('P5 · sanitizePayload 对非法输入返回空对象', () => {
    expect(sanitizePayload(undefined)).toEqual({});
    expect(sanitizePayload('x' as never)).toEqual({});
    expect(sanitizePayload(null as never)).toEqual({});
  });

  it('P5 · 超长文本被截断，不把整页数据塞进上报', () => {
    const out = sanitizePayload({ big: 'x'.repeat(5000) });
    expect(String(out.big).length).toBeLessThanOrEqual(300);
  });
});

describe('RQ-75 错误上报（P3 边界 / P4 异常）', () => {
  beforeEach(() => {
    post.mockClear();
    resetMonitorForTest();
  });

  it('P3 · 无 message 也无 stack 时不上报（避免空噪声）', () => {
    expect(reportError({ name: 'E' })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('P3 · 仅有 stack 时仍可上报', () => {
    expect(reportError({ name: 'E', stack: 'at X (a.js:1:1)' })).toBe(true);
  });

  it('P4 · 上报接口异常被吞掉，不向调用方抛出', () => {
    post.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    expect(() => reportError({ name: 'E', message: 'm' })).not.toThrow();
  });
});
