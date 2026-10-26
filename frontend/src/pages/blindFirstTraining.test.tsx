/**
 * RQ-91 断点续做 / RQ-92 引导式第一次决策 / RQ-103 手机端首训可用性 —— 前端测试
 *
 * 这三件事指向同一个事实：开始 4 次 → 决策 0 次 → 表里 0 行。
 * 因此本文件的核心断言不是「页面渲染了什么」，而是
 * **「回来能不能接着练」与「第一次判断能不能在几次点击内发生」**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import Blind from './Blind';
import type { BlindSession, BlindView, MaskedBar } from '../types';

const mocks = vi.hoisted(() => ({
  resumeBlind: vi.fn(),
  abandonBlind: vi.fn(),
  getScoreCard: vi.fn(),
  getBlind: vi.fn(),
  startBlind: vi.fn(),
  stepBlind: vi.fn(),
  submitDecision: vi.fn(),
  tradeBlind: vi.fn(),
  finishBlind: vi.fn(),
}));

vi.mock('../api', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: { tags: [], granularities: [] } })) },
  ...mocks,
}));
vi.mock('../utils/monitor', () => ({ track: vi.fn() }));

import { track } from '../utils/monitor';

const SESSION: BlindSession = {
  id: 7,
  alias: '标的 #A1B2',
  code: null,
  name: null,
  status: 'RUNNING',
  startSeq: null,
  endSeq: null,
  totalBars: 60,
};

const VIEW: BlindView = {
  id: 7,
  alias: '标的 #A1B2',
  status: 'RUNNING',
  cursorIndex: 20,
  totalBars: 60,
  capital: 1000000,
  cash: 990000,
  positions: [],
  trades: [],
  rejected: [],
  equity: [],
  realizedTotal: 0,
  feeTotal: 0,
  tradeCount: 0,
  maxDrawdown: 0,
  atEnd: false,
  decisionPoints: [1, 11, 21, 31, 41, 51],
  decisions: [],
};

const BARS: MaskedBar[] = [{ i: 1, open: 10, high: 10.2, low: 9.8, close: 10.1, volume: 1000 }];

const RESUME_OK = {
  resumable: true,
  hint: {
    resumable: true,
    sessionId: 7,
    alias: '标的 #A1B2',
    cursorIndex: 20,
    totalBars: 60,
    text: '上次停在第 20 根（共 60 根），可以继续。',
    actions: { resume: { label: '继续训练', path: '/blind?session=7' }, abandon: { label: '放弃这段', path: '/blind?abandon=7' } },
  },
  session: SESSION,
  view: VIEW,
  bars: BARS,
};

const renderPage = (entry = '/blind') =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[entry]}>
          <Blind />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resumeBlind.mockResolvedValue({ data: { resumable: false, hint: { resumable: false, text: '' }, session: null, view: null, bars: null } });
  mocks.getBlind.mockResolvedValue({ data: { session: SESSION, view: VIEW, bars: BARS } });
  mocks.abandonBlind.mockResolvedValue({ data: { ok: true, id: 7 } });
  mocks.submitDecision.mockResolvedValue({ data: { id: 1, skipped: false } });
  mocks.startBlind.mockResolvedValue({ data: { id: 7, alias: '标的 #A1B2', status: 'RUNNING', totalBars: 60, decisionInterval: 10 } });
  mocks.getScoreCard.mockResolvedValue({
    data: { title: '训练成绩卡', subtitle: '已揭示标的身份', lines: ['收益率：+3.20%'], text: '【训练成绩卡】\n收益率：+3.20%', copyable: true, disclaimer: '不构成投资建议，不承诺任何收益。', tier: { key: 'behavior', label: '行为级', remaining: 40, nextLabel: '绩效级' } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ===================== P0 · RQ-91 断点续做 ===================== */

describe('RQ-91 会话持久化与断点续做（P0）', () => {
  it('P0 · 进入页面自动恢复未完成的训练并给出「上次停在第 N 根」', async () => {
    mocks.resumeBlind.mockResolvedValue({ data: RESUME_OK });
    renderPage();
    const hint = await screen.findByTestId('blind-resume-hint');
    expect(hint.textContent).toContain('上次停在第 20 根');
    await waitFor(() => expect(mocks.getBlind).toHaveBeenCalledWith(7));
  });

  it('P0 · 续做时埋点上报 blind_resume（让「回来了」这件事可度量）', async () => {
    mocks.resumeBlind.mockResolvedValue({ data: RESUME_OK });
    renderPage();
    await waitFor(() => expect(track).toHaveBeenCalledWith('blind_resume', expect.objectContaining({ sessionId: 7 })));
  });

  it('P0 · 给出「放弃这段」出口，放弃后不再提示', async () => {
    mocks.resumeBlind.mockResolvedValue({ data: RESUME_OK });
    renderPage();
    expect(await screen.findByTestId('blind-resume-abandon')).toBeInTheDocument();
  });

  it('P0 · 带 ?abandon=ID 进入时调用放弃接口', async () => {
    renderPage('/blind?abandon=7');
    await waitFor(() => expect(mocks.abandonBlind).toHaveBeenCalledWith(7));
  });

  it('P0 · 带 ?session=ID 进入时直接恢复指定会话', async () => {
    renderPage('/blind?session=7');
    await waitFor(() => expect(mocks.getBlind).toHaveBeenCalledWith(7));
    expect(await screen.findByTestId('blind-alias')).toBeInTheDocument();
  });
});

/* ===================== P3 · RQ-91 边界与异常 ===================== */

describe('RQ-91 边界与异常（P3）', () => {
  it('P3 · 续做查询失败不阻断手动开训', async () => {
    mocks.resumeBlind.mockRejectedValue(new Error('fail'));
    renderPage();
    fireEvent.click(await screen.findByTestId('blind-start'));
    await waitFor(() => expect(mocks.startBlind).toHaveBeenCalled());
  });

  it('P3 · 无可续做内容时不显示断点提示，也不报错', async () => {
    renderPage();
    await waitFor(() => expect(mocks.resumeBlind).toHaveBeenCalled());
    expect(screen.queryByTestId('blind-resume-hint')).toBeNull();
  });
});

/* ===================== P0 · RQ-92 引导式第一次决策 ===================== */

describe('RQ-92 引导式第一次决策（P0）', () => {
  it('P0 · ?first=1 进入时出现「选一个方向」的引导卡片', async () => {
    renderPage('/blind?session=7&first=1');
    expect(await screen.findByTestId('guided-decision')).toBeInTheDocument();
    expect(screen.getByTestId('guided-buy')).toBeInTheDocument();
    expect(screen.getByTestId('guided-sell')).toBeInTheDocument();
    expect(screen.getByTestId('guided-hold')).toBeInTheDocument();
  });

  it('P0 · 选方向 + 提交 = 2 次点击完成第一次判断', async () => {
    renderPage('/blind?session=7&first=1');
    fireEvent.click(await screen.findByTestId('guided-buy'));
    fireEvent.click(screen.getByTestId('guided-submit'));
    await waitFor(() => expect(mocks.submitDecision).toHaveBeenCalled());
    expect(mocks.submitDecision.mock.calls[0][1]).toMatchObject({ action: 'BUY' });
  });

  it('P0 · 首训决策上报 first_training_decision 埋点（本期北极星的分子）', async () => {
    renderPage('/blind?session=7&first=1');
    fireEvent.click(await screen.findByTestId('guided-buy'));
    fireEvent.click(screen.getByTestId('guided-submit'));
    await waitFor(() => expect(track).toHaveBeenCalledWith('first_training_decision', expect.anything()));
  });

  it('P0 · ?first=1 进入时上报 first_training_start', async () => {
    renderPage('/blind?session=7&first=1');
    await waitFor(() => expect(track).toHaveBeenCalledWith('first_training_start', expect.objectContaining({ sessionId: 7 })));
  });
});

/* ===================== P1 · RQ-92 引导消失条件 ===================== */

describe('RQ-92 引导消失（P1）', () => {
  it('P1 · 已有决策记录时不再显示引导卡片（不重复打扰）', async () => {
    mocks.getBlind.mockResolvedValue({
      data: { session: SESSION, view: { ...VIEW, decisions: [{ id: 1, seq: 1, action: 'BUY', reason: 'x', stopPlan: null, skipped: false }] }, bars: BARS },
    });
    renderPage('/blind?session=7&first=1');
    await waitFor(() => expect(mocks.getBlind).toHaveBeenCalled());
    expect(screen.queryByTestId('guided-decision')).toBeNull();
  });

  it('P1 · 非首训进入时不显示引导卡片', async () => {
    renderPage('/blind?session=7');
    await waitFor(() => expect(mocks.getBlind).toHaveBeenCalled());
    expect(screen.queryByTestId('guided-decision')).toBeNull();
  });
});

/* ===================== P3 · RQ-92 边界与异常 ===================== */

describe('RQ-92 边界与异常（P3）', () => {
  it('P3 · 理由留空时提交仍成功，只是被记为「未记录」（诚实计入纪律执行率）', async () => {
    renderPage('/blind?session=7&first=1');
    fireEvent.click(await screen.findByTestId('guided-hold'));
    fireEvent.click(screen.getByTestId('guided-submit'));
    await waitFor(() => expect(mocks.submitDecision).toHaveBeenCalled());
    expect(mocks.submitDecision.mock.calls[0][1]).toMatchObject({ action: 'HOLD', reason: '' });
  });

  it('P3 · 提交失败时不展示成功态，也不抛出未捕获异常', async () => {
    mocks.submitDecision.mockRejectedValue(new Error('fail'));
    renderPage('/blind?session=7&first=1');
    fireEvent.click(await screen.findByTestId('guided-buy'));
    expect(() => fireEvent.click(screen.getByTestId('guided-submit'))).not.toThrow();
  });
});

/* ===================== P5 · RQ-103 手机端首训可用性 ===================== */

describe('RQ-103 手机端首训可用性（P5）', () => {
  const setMobile = (matches: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width') ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  };

  it('P5 · 手机视口下引导按钮放大并占满宽度（单手可达、不易误触）', async () => {
    setMobile(true);
    renderPage('/blind?session=7&first=1');
    const buy = await screen.findByTestId('guided-buy');
    expect(buy.className).toContain('ant-btn-lg');
    const submit = screen.getByTestId('guided-submit');
    expect(submit.className).toContain('ant-btn-block');
    setMobile(false);
  });

  it('P5 · 手机视口下页面套用 blind-mobile 容器（不产生横向滚动）', async () => {
    setMobile(true);
    const { container } = renderPage('/blind?session=7&first=1');
    await screen.findByTestId('guided-decision');
    expect(container.querySelector('.blind-mobile')).toBeTruthy();
    setMobile(false);
  });
});

/* ===================== P1 · RQ-99 成绩卡 ===================== */

describe('RQ-99 成绩卡（P1）', () => {
  it('P1 · 结束训练后拉取成绩卡（数字与体检单同源）', async () => {
    mocks.finishBlind.mockResolvedValue({
      data: {
        session: { ...SESSION, status: 'FINISHED', code: '600519', name: '贵州茅台' },
        score: { returnPct: 3.2, maxDrawdown: 1.5, tradeCount: 2, durationSec: 180, decisionPoints: 2, disciplineRate: 50, discipline: { rate: 50, total: 2, recorded: 1, skipped: 1, note: '' }, sampleNote: 'x', realizedTotal: 32000, feeTotal: 12, disclaimer: 'd' },
        view: { ...VIEW, revealed: { code: '600519', name: '贵州茅台', startSeq: 8600, endSeq: 8659 } },
      },
    });
    renderPage('/blind?session=7');
    fireEvent.click(await screen.findByTestId('blind-finish'));
    await waitFor(() => expect(mocks.getScoreCard).toHaveBeenCalledWith(7));
    expect(await screen.findByTestId('score-card')).toBeInTheDocument();
  });
});
