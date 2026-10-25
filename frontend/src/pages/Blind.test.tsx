/**
 * RQ-66 双盲训练页 —— 前端测试
 *
 * 验收标准要求「训练全程无法从界面推断标的身份与日期」，这里把它做成断言：
 * 训练态下页面上不得出现 6 位股票代码、标的名称或任何 YYYY-MM-DD 日期。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import Blind from './Blind';
import type { BlindSession, BlindView, MaskedBar, BlindScore } from '../types';

const SESSION: BlindSession = {
  id: 7,
  alias: '标的 #A1B2',
  code: null, // 训练中：身份字段必须为 null
  name: null,
  status: 'RUNNING',
  // 训练中：可反查日期的序号一律为 null
  startSeq: null,
  endSeq: null,
  totalBars: 60,
  cursorSeq: null,
};

const VIEW: BlindView = {
  id: 7,
  alias: '标的 #A1B2',
  status: 'RUNNING',
  cursorIndex: 2,
  totalBars: 60,
  capital: 1000000,
  cash: 990000,
  positions: [{ code: '标的 #A1B2', quantity: 100, marketValue: 1000 }],
  trades: [{ seq: 1, code: '标的 #A1B2', side: 'BUY', price: 10, quantity: 100 }],
  rejected: [],
  equity: [{ i: 1, cash: 1000000, marketValue: 0, totalAssets: 1000000 }],
  realizedTotal: 0,
  feeTotal: 3,
  tradeCount: 1,
  maxDrawdown: 0,
  atEnd: false,
  decisionPoints: [1, 11, 21, 31, 41, 51],
  decisions: [],
};

const BARS: MaskedBar[] = [
  { i: 1, open: 10, high: 10.2, low: 9.8, close: 10.1, volume: 1000 },
  { i: 2, open: 10.1, high: 10.4, low: 10, close: 10.3, volume: 1200 },
];

vi.mock('../api', () => ({
  // RQ-82：页面挂载后会拉取「片段类型 + 粒度」字典，默认 axios 实例需要 get 方法
  default: { get: vi.fn(() => Promise.resolve({ data: { tags: [], granularities: [] } })) },
  startBlind: vi.fn(() =>
    Promise.resolve({ data: { id: 7, alias: '标的 #A1B2', status: 'RUNNING', totalBars: 60, decisionInterval: 10 } })
  ),
  getBlind: vi.fn(() => Promise.resolve({ data: { session: SESSION, view: VIEW, bars: BARS } })),
  stepBlind: vi.fn(() => Promise.resolve({ data: { view: VIEW, bars: BARS } })),
  submitDecision: vi.fn(() => Promise.resolve({ data: { id: 1, skipped: false } })),
  tradeBlind: vi.fn(() => Promise.resolve({ data: { ok: true, view: VIEW, bars: BARS } })),
  finishBlind: vi.fn(() =>
    Promise.resolve({
      data: {
        session: { ...SESSION, status: 'FINISHED', code: '600519', name: '贵州茅台', startSeq: 8600, endSeq: 8659 },
        score: {
          returnPct: 3.2,
          totalAssets: 1032000,
          maxDrawdown: 1.5,
          tradeCount: 2,
          durationSec: 180,
          decisionPoints: 2,
          disciplineRate: 50,
          discipline: { rate: 50, total: 2, recorded: 1, skipped: 1, note: '' },
          sampleNote: '本次训练 2 笔，未达 50 笔可信门槛。',
          realizedTotal: 32000,
          feeTotal: 12,
          disclaimer: '模拟训练成绩基于真实历史行情，不构成投资建议。',
        } as BlindScore,
        view: { ...VIEW, revealed: { code: '600519', name: '贵州茅台', startSeq: 8600, endSeq: 8659 } },
      },
    })
  ),
}));
vi.mock('../utils/monitor', () => ({ track: vi.fn() }));

import { startBlind, submitDecision, finishBlind } from '../api';
import { track } from '../utils/monitor';

const renderPage = () =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <Blind />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

const SIX_DIGIT = /\b\d{6}\b/;
const DATE = /\b20\d{2}-\d{2}-\d{2}\b/;

describe('RQ-67 随机来一段（P0）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 点击后调用随机片段接口并进入训练', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await waitFor(() => expect(startBlind).toHaveBeenCalled());
    expect(await screen.findByTestId('blind-alias')).toBeInTheDocument();
  });
});

describe('RQ-66 训练中不得泄露身份（P0）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 训练态页面不含 6 位股票代码', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    const text = document.body.textContent || '';
    // 别名里可能带 4 位十六进制，六位代码才是泄露信号
    expect(SIX_DIGIT.test(text.replace(/标的 #\w+/g, ''))).toBe(false);
  });

  it('P0 · 训练态页面不含任何交易日期', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    expect(DATE.test(document.body.textContent || '')).toBe(false);
  });

  it('P0 · 只展示代号与相对进度', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    expect(screen.getByTestId('blind-alias').textContent).toContain('标的 #');
    expect(screen.getByText(/进度 2 \/ 60 根/)).toBeInTheDocument();
  });
});

describe('RQ-38 强制决策记录（P0）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 可打开决策弹窗并提交，提交后上报埋点', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    fireEvent.click(screen.getByTestId('blind-decision-open'));
    await waitFor(() => expect(screen.getByTestId('blind-decision-modal')).toBeInTheDocument());
    // antd 会在两字中文按钮里插入空格，用正则匹配避免拿不到
    fireEvent.click(screen.getByText(/提\s*交/));
    await waitFor(() => expect(submitDecision).toHaveBeenCalled());
    expect(track).toHaveBeenCalledWith('blind_decision', { skipped: false });
  });

  it('P0 · 跳过被记为「未记录」（用于纪律执行率）', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    fireEvent.click(screen.getByTestId('blind-decision-open'));
    await waitFor(() => expect(screen.getByTestId('blind-decision-modal')).toBeInTheDocument());
    fireEvent.click(screen.getByText('跳过（记为未记录）'));
    await waitFor(() => expect(submitDecision).toHaveBeenCalled());
    const arg = (submitDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(arg.skipped).toBe(true);
  });
});

describe('RQ-41 结束揭示与成绩（P0）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 结束后揭示标的身份', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    fireEvent.click(screen.getByTestId('blind-finish'));
    await waitFor(() => expect(finishBlind).toHaveBeenCalled());
    const reveal = await screen.findByTestId('blind-reveal');
    expect(reveal.textContent).toContain('600519');
    expect(reveal.textContent).toContain('贵州茅台');
  });

  it('P0 · 成绩含纪律执行率与口径说明', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    fireEvent.click(screen.getByTestId('blind-finish'));
    await waitFor(() => expect(finishBlind).toHaveBeenCalled());
    await screen.findByTestId('blind-reveal');
    expect(document.body.textContent).toContain('纪律执行率');
    expect(document.body.textContent).toContain('已写理由或计划止损的决策点');
    expect(document.body.textContent).toContain('不构成投资建议');
  });

  it('P0 · 单次训练明确不给能力结论（样本不足）', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('blind-start'));
    await screen.findByTestId('blind-alias');
    fireEvent.click(screen.getByTestId('blind-finish'));
    await screen.findByTestId('blind-reveal');
    expect(document.body.textContent).toContain('未达 50 笔可信门槛');
  });
});
