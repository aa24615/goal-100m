import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEquity } from './useEquity';
import api from '../api';

// P4/P5：资产曲线 hook，验证“日级点不足自动回退分时”的兜底逻辑。
vi.mock('../api', () => ({ default: { get: vi.fn() } }));

const base = { summary: {}, range: {}, initialCapital: 1000000, accounts: {} };

describe('useEquity (P4/P5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('日级点数充足（>=3）时直接返回，不触发回退', async () => {
    const day = { ...base, gran: 'day', days: 30, series: [1, 2, 3, 4].map((i) => ({ date: `d${i}` })) };
    (api.get as unknown as vi.Mock).mockResolvedValue({ data: day });
    const { result } = renderHook(() => useEquity(30));
    await waitFor(() => expect(result.current.equity).not.toBeNull());
    expect(result.current.equity?.gran).toBe('day');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('日级点数不足（<3）时回退到分时粒度', async () => {
    const shortDay = { ...base, gran: 'day', days: 30, series: [{ date: 'd1' }] };
    const minute = { ...base, gran: 'minute', days: 1, series: [{ date: 'm1' }, { date: 'm2' }] };
    (api.get as unknown as vi.Mock).mockImplementation((_url: string, cfg: any) =>
      Promise.resolve({ data: cfg?.params?.gran === 'minute' ? minute : shortDay })
    );
    const { result } = renderHook(() => useEquity(30));
    await waitFor(() => expect(result.current.equity?.gran).toBe('minute'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
