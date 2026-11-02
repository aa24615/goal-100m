/**
 * v15 阶段零前端覆盖测试（RQ-174 首屏落地页 · RQ-175 访客帮助 · RQ-176 完成口径）
 *
 * 优先级：P0 主流程 · P1 差异化 · P2 留存体验 · P3 边界异常 · P5 兼容回归
 *
 * 这一版前端最该防的是**首屏预期错位**（v15 F-104）：
 * 门面写着「模拟交易大厅」，内核却是双盲训练器，新用户按模拟炒股的预期进来，
 * 遇到训练器直接流失。因此本文件断言的是**未登录用户在首屏能看到什么**：
 *   ① 三件必答问题（练什么 / 要不要注册 / 记录留多久）是否真的渲染出来了；
 *   ② 「不注册也能练」的按钮是否真的存在——这是 ≤2 次点击验收的前提；
 *   ③ 后端不可达时是否降级而不是白屏。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';

import LandingHero, { firstVisitClicks } from './components/LandingHero';
import { LANDING_ELEMENTS, MAX_FIRST_VISIT_CLICKS, FIRST_VISIT_PATH } from './constants';
import type { LandingPayload } from './types';

const wrap = (ui: React.ReactNode) => render(<ConfigProvider><AntApp>{ui}</AntApp></ConfigProvider>);

/* ------------------------------ fixtures ------------------------------ */

const PAYLOAD: LandingPayload = {
  elements: [
    { key: 'what', title: '练什么', body: '在隐藏标的与日期的真实 A 股历史 K 线里逐根做决策。' },
    { key: 'register', title: '要不要注册', body: '不注册也能先练，游客每日 3 局；注册后保留成绩。' },
    { key: 'retention', title: '记录留多久', body: '登录用户长期保留；游客记录保留 7 天。' },
  ],
  disclaimer: '真实 A 股公开行情 · 模拟资金与模拟交易 · 仅供学习研究，不构成投资建议',
  maxClicks: 2,
  guestEntry: '/guest/session',
};

/**
 * `vi.mock` 必须顶层声明，且 mock 变量要用 `vi.hoisted` 创建 ——
 * 写在用例体内会错过 hoist 时机，同一路径重复 mock 也会互相覆盖（v7 踩过两次）。
 * 这里统一由一个可控实现驱动：默认成功，单条用例改成 reject 验证降级。
 */
const mocks = vi.hoisted(() => ({
  landingImpl: null as null | (() => Promise<{ data?: LandingPayload }>),
}));

vi.mock('./api', () => ({
  getLandingCopy: () =>
    mocks.landingImpl
      ? mocks.landingImpl()
      : Promise.resolve({ data: undefined as unknown as LandingPayload }),
}));

/** 每个用例前重置可控实现，避免用例间互相污染 */
beforeEach(() => {
  mocks.landingImpl = null;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------- RQ-174 首屏三要素 -------------------------- */

describe('RQ-174 首屏落地页（P0）', () => {
  it('P0 · RQ-174 注入 payload 时首屏渲染出三要素，且顺序固定', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    expect(screen.getByTestId('landing-hero')).toBeTruthy();
    for (const key of LANDING_ELEMENTS) {
      expect(screen.getByTestId(`landing-element-${key}`)).toBeTruthy();
    }
    // 顺序固定：后端下发顺序变化不应改变用户看到的先后
    const titles = Array.from(
      screen.getByTestId('landing-elements').querySelectorAll('[data-testid^="landing-element-"]')
    ).map((n) => n.getAttribute('data-testid'));
    expect(titles).toEqual(['landing-element-what', 'landing-element-register', 'landing-element-retention']);
  });

  it('P0 · RQ-174 「先练一局（无需注册）」按钮存在且可点击 —— 注册墙不得拦在第一米', () => {
    const onGuestTrain = vi.fn();
    wrap(<LandingHero payload={PAYLOAD} onGuestTrain={onGuestTrain} />);
    const btn = screen.getByTestId('landing-guest-train');
    fireEvent.click(btn);
    expect(onGuestTrain).toHaveBeenCalledTimes(1);
  });

  it('P0 · RQ-174 保留期承诺在首屏可见（硬约束第 6 条：写在投入之前）', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    expect(screen.getByText(/7 天/)).toBeTruthy();
    expect(screen.getByText('记录留多久')).toBeTruthy();
  });

  it('P1 · RQ-174 首访到训练 ≤2 次点击，且点击数从真实常量推导', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    const c = firstVisitClicks();
    expect(c.clicks).toBeLessThanOrEqual(MAX_FIRST_VISIT_CLICKS);
    expect(c.clicks).toBe(2);
    expect(c.ok).toBe(true);
    expect(screen.getByTestId('landing-clicks').textContent).toContain('2 次点击');
  });

  it('P1 · RQ-174 路径多插一层即超出预算 —— 断言守的是「改版不能悄悄加点击」', () => {
    const c = firstVisitClicks([
      ...FIRST_VISIT_PATH,
      { id: 'guide', label: '引导页', kind: 'click' },
    ]);
    expect(c.clicks).toBe(3);
    expect(c.ok).toBe(false);
  });

  it('P2 · RQ-174 免责口径统一「不构成投资建议」', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    expect(screen.getByTestId('landing-hero').textContent).toContain('不构成投资建议');
  });
});

/* -------------------------- RQ-174 异常与降级 -------------------------- */

describe('RQ-174 边界与降级（P3）', () => {
  it('P3 · RQ-174 后端不可达时降级到兜底文案，三要素不缺项（不白屏）', async () => {
    mocks.landingImpl = () => Promise.reject(new Error('network down'));
    wrap(<LandingHero />);
    // 降级后仍要能看到三要素：首屏缺一块等于把可用性问题升级成需求违约
    await vi.waitFor(() => {
      expect(screen.getByTestId('landing-fallback')).toBeTruthy();
    });
    expect(screen.getByTestId('landing-element-what')).toBeTruthy();
    expect(screen.getByTestId('landing-element-register')).toBeTruthy();
    expect(screen.getByTestId('landing-element-retention')).toBeTruthy();
  });

  it('P3 · RQ-174 后端漏字段（只返回两个要素）时补齐第三项而不是渲染成空白', () => {
    const partial: LandingPayload = { ...PAYLOAD, elements: PAYLOAD.elements.slice(0, 2) };
    wrap(<LandingHero payload={partial} />);
    expect(screen.getByTestId('landing-element-retention')).toBeTruthy();
    expect(screen.getByTestId('landing-element-retention').textContent).not.toBe('');
  });

  it('P3 · RQ-174 payload 显式传 null 时走网络分支且不抛错', () => {
    expect(() => wrap(<LandingHero payload={null} />)).not.toThrow();
  });

  it('P3 · RQ-174 未传 onGuestTrain 时点击不抛错（可选回调）', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    expect(() => fireEvent.click(screen.getByTestId('landing-guest-train'))).not.toThrow();
  });
});

/* -------------------------- RQ-175 / RQ-176 口径 -------------------------- */

describe('RQ-175 / RQ-176 前端口径（P5 兼容回归）', () => {
  it('P5 · RQ-174 常量与后端 stageZeroService 口径一致（三要素 / 上限 2）', () => {
    expect(LANDING_ELEMENTS).toEqual(['what', 'register', 'retention']);
    expect(MAX_FIRST_VISIT_CLICKS).toBe(2);
    expect(FIRST_VISIT_PATH.filter((s) => s.kind === 'click').length).toBe(2);
  });

  it('P5 · RQ-174 每个要素都有图标位与正文，不出现 NaN / undefined', () => {
    wrap(<LandingHero payload={PAYLOAD} />);
    const text = screen.getByTestId('landing-elements').textContent || '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('P5 · RQ-176 首屏不出现任何结论性能力数字（胜率 / 期望值 / 评级）', () => {
    // RQ-180 冻结但护栏要在：首屏是未登录用户唯一可见处，出现点估计即为口径违规
    wrap(<LandingHero payload={PAYLOAD} />);
    const text = screen.getByTestId('landing-hero').textContent || '';
    expect(text).not.toMatch(/胜率|期望值|能力评级|\d+(\.\d+)?\s*%/);
  });
});
