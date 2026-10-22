import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { App } from 'antd';
import Orders from './Orders';
import api, { getOrders } from '../api';

// RQ-26（P4）：委托管理页 —— 补齐限价委托的最后一公里（查看状态 / 主动撤单）
vi.mock('../api', () => ({
  default: { get: vi.fn(), delete: vi.fn() },
  getOrders: vi.fn(),
  cancelOrder: vi.fn(),
}));

const ORDERS = [
  {
    id: 11,
    code: '600001',
    name: '启明智能',
    side: 'BUY' as const,
    limitPrice: 48.6,
    quantity: 100,
    status: 'PENDING',
    filledPrice: null,
    note: null,
    createdAt: '2026-10-22T02:00:00Z',
  },
  {
    id: 12,
    code: '000001',
    name: '鹏城银行',
    side: 'SELL' as const,
    limitPrice: 11.2,
    quantity: 200,
    status: 'FILLED',
    filledPrice: 11.25,
    note: null,
    createdAt: '2026-10-22T02:10:00Z',
  },
];

describe('Orders 委托管理页 (RQ-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getOrders as unknown as Mock).mockResolvedValue({ data: ORDERS });
    (api.get as unknown as Mock).mockResolvedValue({ data: ORDERS });
    (api.delete as unknown as Mock).mockResolvedValue({ data: { ok: true } });
  });

  const renderPage = () =>
    render(
      <App>
        <Orders />
      </App>
    );

  it('展示委托状态：等待成交 / 已成交', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('等待成交')).toBeInTheDocument());
    expect(screen.getByText('已成交')).toBeInTheDocument();
    expect(screen.getByText('启明智能 600001')).toBeInTheDocument();
  });

  it('仅未成交的委托提供撤单入口，已成交的没有', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('cancel-11')).toBeInTheDocument());
    expect(screen.queryByTestId('cancel-12')).toBeNull();
  });

  it('点击撤单调用删除接口并刷新列表', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('cancel-11')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cancel-11'));
    // Popconfirm 的确认按钮（不同 locale 下文案不同，按主按钮类名定位更稳）
    await waitFor(() => expect(document.querySelector('.ant-popconfirm')).not.toBeNull());
    fireEvent.click(document.querySelector('.ant-popconfirm .ant-btn-primary') as Element);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/orders/11'));
  });

  it('接口异常时页面不崩溃，仍渲染空态', async () => {
    (getOrders as unknown as Mock).mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('暂无委托记录')).toBeInTheDocument());
  });
});
