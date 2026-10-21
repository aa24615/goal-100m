import { useEffect, useMemo, useState } from 'react';
import { subscribe } from '../ws';
import type { StockQuote, MarketSummary } from '../types';

// 行情中心数据层：仅负责“订阅实时行情 + 派生大盘汇总”，UI 筛选/搜索留在页面里。
export function useMarket() {
  const [quotes, setQuotes] = useState<StockQuote[]>([]);

  useEffect(() => subscribe(setQuotes), []);

  const sectors = useMemo(
    () => ['全部', ...Array.from(new Set(quotes.map((q) => q.sector)))],
    [quotes]
  );

  const summary = useMemo<MarketSummary>(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    let idx = 0;
    let base = 0;
    for (const q of quotes) {
      if (q.change > 0) up += 1;
      else if (q.change < 0) down += 1;
      else flat += 1;
      idx += q.price;
      base += q.prevClose;
    }
    const total = quotes.length || 1;
    return {
      up,
      down,
      flat,
      total: quotes.length,
      indexValue: idx / total,
      indexPct: base ? ((idx - base) / base) * 100 : 0,
    };
  }, [quotes]);

  return { quotes, sectors, summary };
}
