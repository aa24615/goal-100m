import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePortfolio } from './usePortfolio';
import api from '../api';

// P3：持仓 hook，mock axios 实例验证拉取与重新加载。
vi.mock('../api', () => ({ default: { get: vi.fn() } }));

describe('usePortfolio (P3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('挂载即拉取并暴露持仓数据', async () => {
    (api.get as unknown as vi.Mock).mockResolvedValue({ data: { cash: 100, holdings: [] } });
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.cash).toBe(100);
    expect(api.get).toHaveBeenCalledWith('/portfolio');
  });

  it('reload 会再次调用接口', async () => {
    (api.get as unknown as vi.Mock).mockResolvedValue({ data: { cash: 200, holdings: [] } });
    const { result } = renderHook(() => usePortfolio());
    await waitFor(() => expect(result.current.data?.cash).toBe(200));
    (api.get as unknown as vi.Mock).mockResolvedValue({ data: { cash: 300, holdings: [] } });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data?.cash).toBe(300));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
