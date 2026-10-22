import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarketStatusBar, { ThemeControls } from './MarketStatusBar';

// RQ-27（P4）：交易日状态可见，消除「价格不动是不是卡住了」的困惑
const base = {
  tradeSeq: 42,
  tradeDate: '2026-10-22',
  phase: 'TRADING' as const,
  sessionTick: 10,
  sessionTicks: 120,
  ticksToClose: 110,
  inWindow: true,
  realClock: false,
};

describe('MarketStatusBar (RQ-27)', () => {
  it('交易中展示交易日序号与距收盘信息', () => {
    render(<MarketStatusBar status={base} />);
    expect(screen.getByTestId('market-phase').textContent).toContain('交易中');
    expect(screen.getByText(/第 42 个交易日/)).toBeInTheDocument();
    expect(screen.getByText(/距收盘/)).toBeInTheDocument();
  });

  it('休市时明确提示下一次开盘后价格继续变动', () => {
    render(<MarketStatusBar status={{ ...base, phase: 'BREAK', inWindow: false }} />);
    expect(screen.getByTestId('market-phase').textContent).toContain('休市');
    expect(screen.getByText(/休市中/)).toBeInTheDocument();
  });

  it('已收盘展示对应状态', () => {
    render(<MarketStatusBar status={{ ...base, phase: 'CLOSED' }} />);
    expect(screen.getByTestId('market-phase').textContent).toContain('已收盘');
  });
});

// RQ-33（P5）：深色模式与信息密度个性化
describe('ThemeControls (RQ-33)', () => {
  it('展示当前主题并可在浅色/深色间切换', () => {
    const onChange = vi.fn();
    render(<ThemeControls theme="light" density="normal" onChange={onChange} />);
    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle.textContent).toContain('浅色');
    toggle.click();
    expect(onChange).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('深色模式下回传 light', () => {
    const onChange = vi.fn();
    render(<ThemeControls theme="dark" density="compact" onChange={onChange} />);
    expect(screen.getByTestId('density-toggle').textContent).toContain('紧凑');
    screen.getByTestId('theme-toggle').click();
    expect(onChange).toHaveBeenCalledWith({ theme: 'light' });
  });
});
