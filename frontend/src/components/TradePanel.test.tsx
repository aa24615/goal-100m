/**
 * F-31「可用资金口径」—— 交易面板前端测试
 *
 * 事故回放（2026-10-29 00:30）：用户在个股页买入 601360 成交（现金 548,701.18 → 274,548.22），
 * 但面板里的「可用」仍是成交前的陈旧快照，于是「全仓」算出 472,800 股、本地校验通过，
 * 后端按真实现金拒绝，用户连试 472800 / 472700 / 472000 三次都被拒。
 *
 * 本文件锁住三件事：
 * 1. 面板打开（含切换标的）即以服务端为准刷新现金快照；
 * 2. 成交成功后立刻回拉快照，下一笔不沿用旧「可用」；
 * 3. 服务端返回资金不足时，把 need/cash/shortfall 说清楚并纠正本地快照。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import TradePanel from './TradePanel';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refreshAssets: vi.fn(),
  cash: { current: 548701.18 },
}));

vi.mock('../api', () => ({
  default: {
    get: vi.fn(() =>
      Promise.resolve({
        data: {
          commissionRate: 0.0003,
          stampRate: 0.0005,
          transferRate: 0.00001,
          minCommission: 5,
          t1Enabled: true,
          dailyLimit: 0.1,
          priceTolerance: 0.005,
        },
      })
    ),
    post: (...args: unknown[]) => mocks.post(...args),
  },
}));

vi.mock('../ws', () => ({
  getPrice: () => ({
    code: '600221',
    name: '测试标的',
    sector: '其他',
    prevClose: 1.17,
    open: 1.17,
    price: 1.16,
    high: 1.18,
    low: 1.15,
    volume: 100,
    change: -0.01,
    changePct: -0.85,
  }),
  subscribe: () => () => {},
}));

vi.mock('../auth', () => ({
  useAuth: () => ({
    assets: { cash: mocks.cash.current, totalAssets: mocks.cash.current },
    refreshAssets: mocks.refreshAssets,
  }),
}));

const renderPanel = (props: Partial<React.ComponentProps<typeof TradePanel>> = {}) =>
  render(
    <ConfigProvider>
      <AntApp>
        <TradePanel code="600221" initialQuantity={1000} {...props} />
      </AntApp>
    </ConfigProvider>
  );

beforeEach(() => {
  mocks.post.mockReset();
  mocks.refreshAssets.mockReset();
  mocks.refreshAssets.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue({ data: {} });
});

/* ===================== P0 · 现金快照时效 ===================== */

describe('F-31 交易面板现金快照（P0）', () => {
  it('P0 面板打开即以服务端为准刷新「可用」快照', async () => {
    renderPanel();
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalled());
  });

  it('P0 切换标的时重新拉取快照（避免沿用上一只股票打开时的现金）', async () => {
    const { rerender } = renderPanel();
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(1));
    rerender(
      <ConfigProvider>
        <AntApp>
          <TradePanel code="601360" initialQuantity={1000} />
        </AntApp>
      </ConfigProvider>
    );
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(2));
  });

  it('P0 成交成功后立即回拉快照，下一笔不沿用旧「可用」', async () => {
    renderPanel();
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('trade-submit'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    // 挂载 1 次 + 成交后 1 次
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(2));
  });
});

/* ===================== P0 · 资金不足要说清差多少 ===================== */

describe('F-31 资金不足提示（P0）', () => {
  it('P0 服务端资金不足时展示需要/可用/差额，并纠正本地快照', async () => {
    mocks.post.mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: '可用资金不足',
          need: 547689.73,
          cash: 274548.22,
          shortfall: 273141.51,
        },
      },
    });
    renderPanel();
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('trade-submit'));

    expect(await screen.findByText(/可用资金不足/)).toBeInTheDocument();
    expect(screen.getByText(/547,689\.73/)).toBeInTheDocument();
    expect(screen.getByText(/274,548\.22/)).toBeInTheDocument();
    expect(screen.getByText(/273,141\.51/)).toBeInTheDocument();
    // 用服务端权威数字覆盖前端陈旧快照
    await waitFor(() => expect(mocks.refreshAssets).toHaveBeenCalledTimes(2));
  });

  it('P1 无 need/cash 的普通错误仍走原文案，不误报差额', async () => {
    mocks.post.mockRejectedValue({ response: { status: 400, data: { error: '交易数量需为 100 的整数倍' } } });
    renderPanel();
    fireEvent.click(screen.getByTestId('trade-submit'));
    expect(await screen.findByText('交易数量需为 100 的整数倍')).toBeInTheDocument();
  });
});

/* ===================== P1 · 本地拦截 ===================== */

describe('F-31 本地资金校验（P1）', () => {
  it('P1 数量超过按当前快照算出的可买上限时本地拦截，不发请求', async () => {
    renderPanel({ initialQuantity: 472900 }); // cash 548,701.18 / 价 1.16 → 上限 472,800
    fireEvent.click(screen.getByTestId('trade-submit'));
    expect(await screen.findByText(/最多可买 472,800 股/)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('P1 面板展示的「可用」与快照一致', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('trade-cash-hint').textContent).toContain('548,701.18'));
  });
});
