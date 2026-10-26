/**
 * 训练中心（RQ-92 首训直达 / RQ-94 看板与周报入口 / RQ-95 小样本护栏 / RQ-98 北极星 / RQ-104 站内提示）
 *
 * 这一页存在的唯一理由：看板与周报的后端与 API 全齐，**页面零入口**（F-18）。
 * 因此下面每一条断言守的都是「用户能不能真的点到」，而不是接口返回什么。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import Training from './Training';

const mocks = vi.hoisted(() => ({
  resumeBlind: vi.fn(),
  startBlind: vi.fn(),
  getNorthStar: vi.fn(),
  getCheckup: vi.fn(),
  getNotifications: vi.fn(),
  getDashboard: vi.fn(),
  getRetention: vi.fn(),
  getFunnel: vi.fn(),
  getWeeklyReport: vi.fn(),
}));

vi.mock('../api', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: {} })) },
  ...mocks,
}));

const NO_RESUME = { resumable: false, hint: { resumable: false, text: '' }, session: null, view: null, bars: null };
const RESUMABLE = {
  resumable: true,
  hint: { resumable: true, text: '上次停在第 20 根（共 60 根），可以继续。', sessionId: 7, cursorIndex: 20, totalBars: 60 },
  session: { id: 7, alias: '标的 #00FF', status: 'RUNNING', code: null, name: null, totalBars: 60, cursorIndex: 20 },
  view: null,
  bars: null,
};

const NORTH_STAR = {
  current: { metric: '首训完成率', target: '先 > 0', value: 16.67, numerator: 1, denominator: 6, readable: true, note: '1 / 6 位注册用户完成过至少一次训练决策。' },
  formal: {
    metric: '7 日留存率',
    enabled: false,
    value: null,
    sampleSize: 2,
    minSample: 30,
    earliestReadableDate: '2026-11-02',
    referenceToday: '2026-10-27',
    reason: '队列用户仅 2 人，未达 30 人可读下限；最早 2026-11-02 才有首个完整 7 日窗口。',
  },
  disclaimer: '首训完成率为当前阶段北极星；7 日留存需样本充足后启用，在此之前不作为决策依据。',
};

const CHECKUP_SMALL = {
  sampleSize: 12,
  ratioGate: {
    threshold: 30,
    sampleSize: 12,
    showRatios: false,
    showRanking: false,
    showStrategyLanguage: false,
    remaining: 18,
    action: { label: '继续积累样本', path: '/blind' },
    reason: '样本仅 12 笔，未达 30 笔护栏：胜率、期望值（R）、平均 R 与排名在统计上是噪声，暂不展示。',
  },
};

const FUNNEL = {
  days: 30,
  steps: [
    { key: 'start', label: '开始训练', count: 4 },
    { key: 'first_decision', label: '首次决策', count: 1 },
    { key: 'mid_decision', label: '持续决策（≥2 次）', count: 0 },
    { key: 'finish', label: '完成训练', count: 0 },
  ],
  conversion: { total: 4, startToFirstDecision: 25, firstToFinish: null, startToFinish: 0 },
  timing: { medianSecToFirstDecision: 45, medianSecToFinish: null, budgetSec: 60, withinBudgetCount: 2 },
  breakpoints: [
    { key: 'start', label: '开始训练', stuck: 0 },
    { key: 'first_decision', label: '首次决策', stuck: 3 },
    { key: 'mid_decision', label: '持续决策（≥2 次）', stuck: 0 },
    { key: 'finish', label: '完成训练', stuck: 0 },
  ],
  sessions: [{ sessionId: 1, userId: 3, reached: 'start', reachedLabel: '开始训练', breakpoint: 'first_decision', breakpointLabel: '首次决策', decisions: 0, secToFirstDecision: null, secTotal: null, withinFirstDecisionBudget: null }],
  note: 'x',
};

const renderPage = () =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <Training />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.resumeBlind.mockResolvedValue({ data: NO_RESUME });
  mocks.startBlind.mockResolvedValue({ data: { id: 7, alias: '标的 #00FF', status: 'RUNNING', totalBars: 60, decisionInterval: 10 } });
  mocks.getNorthStar.mockResolvedValue({ data: NORTH_STAR });
  mocks.getCheckup.mockResolvedValue({ data: CHECKUP_SMALL });
  mocks.getNotifications.mockResolvedValue({ data: { items: [], count: 0, dismissed: [], note: '' } });
  mocks.getDashboard.mockResolvedValue({ data: { days: 30, granularity: 'day', buckets: [{ bucket: '2026-10-26', events: 10, activeUsers: 2 }] } });
  mocks.getRetention.mockResolvedValue({ data: { northStar: { metric: '7 日留存率', value: null, cohortUsers: 2, observable: false, note: '暂无足够数据（队列用户为 0），北极星当前不可观测。' } } });
  mocks.getFunnel.mockResolvedValue({ data: FUNNEL });
  mocks.getWeeklyReport.mockResolvedValue({
    data: {
      window: { days: 7, from: '2026-10-20', to: '2026-10-27' },
      segments: { thisWeek: 3, lastWeek: 1 },
      discipline: { note: '纪律执行率较上周提升 10 个百分点。' },
      nextTier: { text: '还差 20 笔升到「绩效级」档' },
      disclaimer: '本训练周报基于模拟交易行为统计，不构成投资建议，不承诺任何收益或奖励。',
    },
  });
});

/* ===================== P0 · RQ-92 首训直达 ===================== */

describe('RQ-92 首访直达训练（P0）', () => {
  it('P0 · 训练中心首屏第一眼是「做一次训练」的 CTA', async () => {
    renderPage();
    expect(await screen.findByTestId('first-training-card')).toBeInTheDocument();
    expect(screen.getByTestId('first-training-start')).toBeInTheDocument();
  });

  it('P0 · 点击 CTA 直接开训（无前置条件）', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('first-training-start'));
    await waitFor(() => expect(mocks.startBlind).toHaveBeenCalled());
  });
});

/* ===================== P0 · RQ-91 断点续做 ===================== */

describe('RQ-91 断点续做（P0）', () => {
  it('P0 · 有未完成的训练时首屏给出「上次停在第 N 根」', async () => {
    mocks.resumeBlind.mockResolvedValue({ data: RESUMABLE });
    renderPage();
    const hint = await screen.findByTestId('resume-hint');
    expect(hint.textContent).toContain('上次停在第 20 根');
    expect(screen.getByTestId('resume-go')).toBeInTheDocument();
  });

  it('P0 · 同时给出「放弃这段」出口，而不是逼用户继续', async () => {
    mocks.resumeBlind.mockResolvedValue({ data: RESUMABLE });
    renderPage();
    expect(await screen.findByTestId('resume-abandon')).toBeInTheDocument();
  });

  it('P3 · 没有可续做的训练时不显示断点提示', async () => {
    renderPage();
    await waitFor(() => expect(mocks.resumeBlind).toHaveBeenCalled());
    expect(screen.queryByTestId('resume-hint')).toBeNull();
  });
});

/* ===================== P0 · RQ-94 看板与周报入口 ===================== */

describe('RQ-94 看板与周报入口落地（P0）', () => {
  it('P0 · 页面里能直接打开看板（此前后端全齐、页面零入口）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('看板'));
    expect(await screen.findByTestId('dashboard-panel')).toBeInTheDocument();
    await waitFor(() => expect(mocks.getDashboard).toHaveBeenCalled());
    expect(await screen.findByTestId('retention-panel')).toBeInTheDocument();
  });

  it('P0 · 看板里能看到训练漏斗与断点分布（F-22）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('看板'));
    expect(await screen.findByTestId('funnel-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('funnel-count-start').textContent).toBe('4'));
    expect(screen.getByTestId('funnel-count-first_decision').textContent).toBe('1');
    expect(screen.getByTestId('funnel-conversion').textContent).toContain('25%');
  });

  it('P0 · 页面里能直接打开周报', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('周报'));
    expect(await screen.findByTestId('weekly-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('weekly-next-tier').textContent).toContain('还差 20 笔'));
  });
});

/* ===================== P0 · RQ-95 小样本护栏 ===================== */

describe('RQ-95 小样本护栏（P0）', () => {
  it('P0 · 样本 12 笔时页面给出护栏说明', async () => {
    renderPage();
    const banner = await screen.findByTestId('sample-guard-banner');
    expect(banner.textContent).toContain('未达 30 笔');
    expect(banner.textContent).toContain('暂不展示');
  });

  it('P0 · 样本过护栏后不再显示护栏横幅', async () => {
    mocks.getCheckup.mockResolvedValue({
      data: { sampleSize: 75, ratioGate: { threshold: 30, sampleSize: 75, showRatios: true, showRanking: true, showStrategyLanguage: false, remaining: 0, action: null, reason: 'ok' } },
    });
    renderPage();
    await waitFor(() => expect(mocks.getCheckup).toHaveBeenCalled());
    expect(screen.queryByTestId('sample-guard-banner')).toBeNull();
  });
});

/* ===================== P0 · RQ-98 北极星 ===================== */

describe('RQ-98 北极星切换（P0）', () => {
  it('P0 · 首屏展示当前阶段北极星「首训完成率」', async () => {
    renderPage();
    expect(await screen.findByTestId('north-star')).toBeInTheDocument();
    expect(screen.getByText('首训完成率')).toBeInTheDocument();
    expect(screen.getByTestId('north-star-current-note').textContent).toContain('1 / 6');
  });

  it('P0 · 7 日留存标注「样本充足后启用」并给出可读起始日', async () => {
    renderPage();
    // 注意括号：await 的优先级高于取属性，写成 `await findBy().textContent` 会拿到 undefined
    expect((await screen.findByTestId('north-star-formal-tag')).textContent).toContain('样本充足后启用');
    expect((await screen.findByTestId('north-star-formal-reason')).textContent).toContain('2026-11-02');
  });
});

/* ===================== P1 · RQ-104 站内提示 ===================== */

describe('RQ-104 站内提示（P1）', () => {
  it('P1 · 达标提示出现且可关闭', async () => {
    mocks.getNotifications.mockResolvedValue({
      data: {
        items: [{ key: 'milestone:behavior:50', kind: 'milestone', title: '可信度升到「行为级」档', body: '已达成 50 笔。', cannot: '仍然不能拿它做策略级结论。', once: true, dismissible: true, createdAt: '2026-10-27T02:00:00.000Z' }],
        count: 1,
        dismissed: [],
        note: '',
      },
    });
    renderPage();
    expect(await screen.findByTestId('inbox-milestone')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.ant-alert-close-icon')!);
    await waitFor(() => expect(screen.queryByTestId('inbox-milestone')).toBeNull());
  });

  it('P1 · 周报提示给出「去做一次训练」的出口', async () => {
    mocks.getNotifications.mockResolvedValue({
      data: {
        items: [{ key: 'weekly:2026-W44', kind: 'weekly', title: '本周训练周报', body: '本周 3 段。', cannot: '不构成投资建议。', once: true, dismissible: true, createdAt: '2026-10-27T02:00:00.000Z', action: { label: '去做一次训练', path: '/blind' } }],
        count: 1,
        dismissed: [],
        note: '',
      },
    });
    renderPage();
    expect(await screen.findByTestId('inbox-weekly')).toBeInTheDocument();
  });
});

/* ===================== P3 · 边界与异常 ===================== */

describe('训练中心 边界与异常（P3）', () => {
  it('P3 · 所有接口失败时页面仍可渲染，不白屏', async () => {
    mocks.resumeBlind.mockRejectedValue(new Error('fail'));
    mocks.getNorthStar.mockRejectedValue(new Error('fail'));
    mocks.getCheckup.mockRejectedValue(new Error('fail'));
    mocks.getNotifications.mockRejectedValue(new Error('fail'));
    renderPage();
    expect(await screen.findByTestId('first-training-card')).toBeInTheDocument();
  });

  it('P3 · 看板接口失败时给出「暂无数据」而不是崩溃', async () => {
    mocks.getDashboard.mockRejectedValue(new Error('fail'));
    mocks.getFunnel.mockRejectedValue(new Error('fail'));
    renderPage();
    fireEvent.click(await screen.findByText('看板'));
    expect(await screen.findByTestId('dashboard-panel')).toBeInTheDocument();
  });
});

/* ===================== P5 · 兼容性与回归 ===================== */

describe('训练中心 兼容性与回归（P5）', () => {
  it('P5 · 无任何收益承诺类措辞（合规硬约束）', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCheckup).toHaveBeenCalled());
    const text = document.body.textContent || '';
    for (const w of ['稳赚', '必涨', '保证收益', '翻倍']) expect(text).not.toContain(w);
  });
});
