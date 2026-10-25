/**
 * RQ-47 数据源状态可见 / RQ-55 休市即训练 / RQ-56 每日打卡 / RQ-57 中断降级 —— 前端测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import TrainingHub, { STARTER_CODES } from './TrainingHub';
import { DISCLAIMER } from '../constants';

// mock 掉 api，避免发出真实 HTTP；同时暴露可控返回值
vi.mock('../api', () => {
  const getOnboarding = vi.fn(() => Promise.resolve({ data: { streak: { current: 3, best: 9, lastDate: null } } }));
  const checkin = vi.fn(() => Promise.resolve({ data: { streakDays: 4, totalDays: 5 } }));
  return { default: {}, getOnboarding, checkin };
});
vi.mock('../utils/monitor', () => ({ track: vi.fn() }));

import { getOnboarding, checkin } from '../api';
import { track } from '../utils/monitor';

const renderHub = (props: { inSession: boolean; lastUpdatedAt?: number | null; sourceLabel?: string }) =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <TrainingHub {...props} />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

describe('RQ-56 每日打卡（P0 正常流程）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 未打卡时展示打卡按钮并可点击', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    const btn = await screen.findByTestId('checkin-btn');
    expect(btn.textContent).toContain('今日打卡');
    expect(btn).not.toBeDisabled();
  });

  it('P0 · 点击打卡调用后端接口并上报埋点（此前前端 0 处调用）', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    const btn = await screen.findByTestId('checkin-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(checkin).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledWith('checkin', { streak: 4 });
  });

  it('P0 · 打卡成功后按钮变为「今日已打卡 · 连续 N 天」并禁用', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    fireEvent.click(await screen.findByTestId('checkin-btn'));
    await waitFor(() => expect(screen.getByTestId('checkin-btn').textContent).toContain('今日已打卡'));
    expect(screen.getByTestId('checkin-btn').textContent).toContain('4');
    expect(screen.getByTestId('checkin-btn')).toBeDisabled();
  });

  it('P0 · 打卡为纯荣誉：页面不出现任何奖励/兑付措辞', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    await screen.findByTestId('training-hub');
    const text = document.body.textContent || '';
    expect(text).not.toContain('奖励');
    expect(text).not.toContain('兑换');
    expect(text).not.toContain('现金');
  });
});

describe('RQ-47 / RQ-57 数据源状态可见（P0 / P4）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P0 · 数据源正常时展示来源与更新时间', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() - 3 * 60_000, sourceLabel: '东方财富' });
    const meta = await screen.findByTestId('quote-meta');
    expect(meta.textContent).toContain('东方财富');
    expect(meta.textContent).toContain('更新于');
  });

  it('P0 · 刚更新完展示「刚刚」', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    expect((await screen.findByTestId('quote-meta')).textContent).toContain('刚刚');
  });

  it('P4 · 数据源中断时展示明确告警，而不是静默停更', async () => {
    renderHub({ inSession: true, lastUpdatedAt: null });
    const alert = await screen.findByTestId('quote-stale-alert');
    expect(alert.textContent).toContain('行情数据源暂未返回更新');
    expect(screen.queryByTestId('quote-meta')).toBeNull();
  });

  it('P4 · 中断时仍提供训练降级入口（双盲按钮可用）', async () => {
    renderHub({ inSession: true, lastUpdatedAt: null });
    await screen.findByTestId('quote-stale-alert');
    expect(screen.getByTestId('goto-blind')).toBeInTheDocument();
    expect(screen.getByTestId('goto-blind')).not.toBeDisabled();
  });
});

describe('RQ-55 休市即训练（P1）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P1 · 休市时展示训练引导并解释为何要练', async () => {
    renderHub({ inSession: false, lastUpdatedAt: Date.now() });
    const tip = await screen.findByTestId('offsession-tip');
    expect(tip.textContent).toContain('休市');
    expect(document.body.textContent).toContain('双盲训练');
  });

  it('P1 · 交易时段内不展示休市引导', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    await screen.findByTestId('training-hub');
    expect(screen.queryByTestId('offsession-tip')).toBeNull();
  });

  it('P1 · 提供双盲入口，点击可跳转 /blind', async () => {
    renderHub({ inSession: false, lastUpdatedAt: Date.now() });
    expect((await screen.findByTestId('goto-blind')).textContent).toContain('随机来一段');
  });
});

describe('RQ-46 新手起步清单（P1）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P1 · 展示少量高流动性标的作为起点', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    await screen.findByTestId('training-hub');
    expect(STARTER_CODES.length).toBeGreaterThan(0);
    expect(STARTER_CODES.length).toBeLessThanOrEqual(8);
    for (const c of STARTER_CODES) expect(document.body.textContent).toContain(c);
  });
});

describe('P4 异常降级 / P5 合规口径', () => {
  beforeEach(() => vi.clearAllMocks());

  it('P4 · onboarding 接口失败时打卡按钮仍可用（不因单点故障卡死留存入口）', async () => {
    (getOnboarding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    const btn = await screen.findByTestId('checkin-btn');
    expect(btn).not.toBeDisabled();
  });

  it('P4 · 打卡重复提交（今日已打卡）时被静默处理并提示', async () => {
    (checkin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('已经打过卡'));
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    fireEvent.click(await screen.findByTestId('checkin-btn'));
    await waitFor(() => expect(screen.getByText(/今天已经打过卡了/)).toBeInTheDocument());
  });

  it('P5 · 中枢卡携带统一免责口径（真实行情 + 模拟资金）', async () => {
    renderHub({ inSession: true, lastUpdatedAt: Date.now() });
    await screen.findByTestId('training-hub');
    expect(document.body.textContent).toContain(DISCLAIMER);
    expect(DISCLAIMER).toContain('真实 A 股行情');
    expect(DISCLAIMER).toContain('模拟资金');
  });
});
