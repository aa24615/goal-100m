export interface StockQuote {
  code: string;
  name: string;
  sector: string;
  prevClose: number;
  open: number;
  price: number;
  high: number;
  low: number;
  volume: number;
  change: number;
  changePct: number;
}

export interface StockDetail extends StockQuote {
  history: { t: number; p: number }[];
}

export interface Holding {
  code: string;
  name: string;
  quantity: number;
  availableQty: number;
  avgCost: number;
  price: number;
  marketValue: number;
  pnl: number;
  pnlPct: number;
}

export interface Portfolio {
  cash: number;
  initialCapital: number;
  marketValue: number;
  costValue: number;
  totalAssets: number;
  totalPnl: number;
  totalPnlPct: number;
  holdings: Holding[];
}

export interface Transaction {
  id: number;
  stockCode: string;
  stockName: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  amount: number;
  fee: number;
  createdAt: string;
}

export interface LeaderRow {
  id: number;
  username: string;
  cash: number;
  marketValue: number;
  totalAssets: number;
  baseAssets: number;
  returnPct: number;
  excessPct: number;
  tradeCount: number;
  rank: number;
}

export interface User {
  id: number;
  username: string;
  email: string;
  displayName?: string;
  avatar?: string | null;
  cash: number;
  initialCapital: number;
  createdAt: string;
}

export interface EquityPoint {
  date: string;
  cash: number;
  marketValue: number;
  totalAssets: number;
  profit: number;
  returnPct: number;
}

export interface EquityResponse {
  initialCapital: number;
  days: number;
  gran: 'day' | 'minute';
  range: { from: string; to: string };
  accounts: { cash: number; marketValue: number; totalAssets: number };
  summary: { profit: number; returnPct: number; maxDrawdown: number; peak: number };
  series: EquityPoint[];
}

export interface Order {
  id: number;
  code: string;
  name: string;
  side: 'BUY' | 'SELL';
  limitPrice: number;
  quantity: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED';
  filledPrice: number | null;
  note: string | null;
  createdAt: string;
}

export interface MarketSummary {
  up: number;
  down: number;
  flat: number;
  total: number;
  indexValue: number;
  indexPct: number;
}
