import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMarket } from './useMarket';
import type { StockQuote } from '../types';

// P3：行情 hook，通过 mock ws.subscribe 注入行情快照，验证汇总计算。
vi.mock('../ws', () => ({
  subscribe: vi.fn((listener: (q: StockQuote[]) => void) => {
    listener([
      { code: 'A', name: 'A股', sector: '银行', prevClose: 10, open: 10, price: 11, high: 11, low: 10, volume: 1, change: 1, changePct: 10 },
      { code: 'B', name: 'B股', sector: '券商', prevClose: 10, open: 10, price: 9, high: 10, low: 9, volume: 1, change: -1, changePct: -10 },
      { code: 'C', name: 'C股', sector: '银行', prevClose: 10, open: 10, price: 10, high: 10, low: 10, volume: 1, change: 0, changePct: 0 },
    ]);
    return () => {};
  }),
}));

describe('useMarket (P3)', () => {
  it('订阅行情并派生大盘汇总', () => {
    const { result } = renderHook(() => useMarket());
    expect(result.current.quotes.length).toBe(3);
    expect(result.current.summary.up).toBe(1);
    expect(result.current.summary.down).toBe(1);
    expect(result.current.summary.flat).toBe(1);
    // indexValue = (11+9+10)/3 = 10
    expect(result.current.summary.indexValue).toBeCloseTo(10, 5);
    // base = 30, idx = 30 → indexPct = 0
    expect(result.current.summary.indexPct).toBeCloseTo(0, 5);
  });

  it('板块列表去重并带“全部”', () => {
    const { result } = renderHook(() => useMarket());
    expect(result.current.sectors).toEqual(['全部', '银行', '券商']);
  });
});
