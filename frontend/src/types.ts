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
  /** RQ-34：重置次数，>0 时榜单标注起点变化 */
  resetCount?: number;
  lastResetAt?: string | null;
  /**
   * 该行是否为「当前登录用户自己」。
   * 榜单只返回前 TOP_N 名，登录用户若排在榜外，服务端会追加这一行，
   * 保证名次与重置次数始终可见；前端据此高亮展示。
   */
  isSelf?: boolean;
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

export interface MarketStatus {
  tradeSeq: number;
  tradeDate: string;
  phase: 'TRADING' | 'BREAK' | 'CLOSED';
  sessionTick: number;
  sessionTicks: number;
  ticksToClose: number;
  breakLeft: number;
  realClock: boolean;
  inWindow: boolean;
  tickMs: number;
  dailyLimit: number;
}

/* ---------------- 回放训练（RQ-01 ~ RQ-06） ---------------- */

export interface DailyBar {
  seq: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  prevClose: number;
}

export interface ReplayRange {
  minSeq: number | null;
  maxSeq: number | null;
  barCount: number;
  maxBars: number;
  hasData: boolean;
}

export interface ReplayPosition {
  code: string;
  quantity: number;
  sellable: number;
  avgCost: number;
  price: number;
  marketValue: number;
  pnl: number;
  pnlPct: number;
}

export interface ReplayState {
  cursorSeq: number;
  startSeq: number;
  endSeq: number;
  status: string;
  cash: number;
  marketValue: number;
  totalAssets: number;
  realizedTotal: number;
  tradeCount: number;
  returnPct: number;
  maxDrawdown: number;
  positions: ReplayPosition[];
  equity: { seq: number; totalAssets: number }[];
}

export interface ReplaySession {
  id: number;
  startSeq: number;
  endSeq: number;
  cursorSeq: number;
  initialCapital: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number;
  result: ReplayScore | null;
}

export interface ReplayScore {
  initialCapital: number;
  finalAssets: number;
  profit: number;
  returnPct: number;
  maxDrawdown: number;
  tradeCount: number;
  durationSec: number;
}

/* ---------------- 复盘战绩（RQ-07 ~ RQ-11） ---------------- */

export interface ReviewRound {
  code: string;
  name: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number | null;
  avgCost: number;
  costBasis: number;
  realizedPnl: number;
  unrealizedPnl?: number | null;
  returnPct: number | null;
  openedAt: string | null;
  closedAt: string | null;
  holdDays: number;
  status: 'closed' | 'partial' | 'open';
  fee: number;
}

export interface Scorecard {
  roundCount: number;
  openCount: number;
  winRate: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  tradeFrequency: number;
  feeRatio: number;
  totalFee: number;
  totalRealized: number;
  avgHoldDays: number;
}

export interface ReviewReport {
  generatedAt: string;
  disclaimer: string;
  headline: { returnPct: number; benchmarkPct: number; excessPct: number; outcome: string };
  scorecard: Scorecard;
  traits: { key: string; label: string; detail: string }[];
  suggestions: string[];
  sampleSize: number;
  compliance: string;
}

export interface ReviewPayload {
  period: string;
  initialCapital: number;
  currentAssets: number;
  returnPct: number;
  benchmarkPct: number;
  excessPct: number;
  realizedTotal: number;
  consistency: { ok: boolean; diff: number };
  rounds: ReviewRound[];
  scorecard: Scorecard;
  report: ReviewReport;
}

export interface AbilityRadar {
  overall: number;
  dimensions: { key: string; label: string; desc: string; score: number }[];
  detail: Record<string, number>;
  note: string;
}

export interface ShareCard {
  displayName: string;
  usernameMasked: string;
  period: string;
  returnPct: number;
  excessPct: number;
  outcome: string;
  radar: { overall: number; dimensions: { label: string; score: number }[] } | null;
  disclaimer: string;
}

/* ---------------- 引导与成长（RQ-12 ~ RQ-15） ---------------- */

export interface GuideStep {
  step: number;
  key: string;
  title: string;
  desc: string;
}

export interface OnboardingTask {
  key: string;
  label: string;
  hint: string;
  unlocks: string;
  done: boolean;
  doneAt: string | null;
}

export interface OnboardingState {
  guideStep: number;
  guideDone: boolean;
  guideSkipped: boolean;
  steps: GuideStep[];
  tasks: OnboardingTask[];
  unlocked: string[];
  streak: { current: number; best: number; lastDate: string | null };
  milestones: { key: string; label: string; achievedAt: string }[];
}

/* ---------------- 剧本训练场（RQ-16 ~ RQ-19） ---------------- */

export interface Scenario {
  key: string;
  name: string;
  type: string;
  difficulty: 'easy' | 'medium' | 'hard';
  goal: string;
  brief: string;
  barCount: number;
  constraints: { initialCapital: number; maxTrades: number; maxDrawdownPct: number };
  bestScore: number | null;
  attempts: number;
  disclaimer: string;
}

export interface ScenarioBars {
  key: string;
  name: string;
  goal: string;
  brief: string;
  constraints: { initialCapital: number; maxTrades: number; maxDrawdownPct: number };
  disclaimer: string;
  series: { seq: number; open: number; high: number; low: number; close: number }[];
}

export interface ScenarioResult {
  metrics: { returnPct: number; finalAssets: number; maxDrawdown: number; tradeCount: number; rejected: unknown[] };
  score: {
    total: number;
    grade: string;
    passed: boolean;
    breakdown: { returnScore: number; drawdownScore: number; disciplineScore: number; decisionScore: number };
    violations: { key: string; detail: string; penalty: number }[];
  };
  hints: { node: string; detail: string }[];
}

/* ---------------- 房间赛（RQ-20 ~ RQ-22） ---------------- */

export interface Room {
  id: number;
  code: string;
  name: string;
  ownerId: number;
  initialCapital: number;
  startSeq: number;
  endSeq: number;
  durationSessions: number;
  status: string;
  memberCount?: number;
}

export interface RoomMember {
  userId: number;
  username: string;
  displayName: string;
  baseAssets: number;
  totalAssets: number;
  returnPct: number;
  rank: number;
  joinedAt: string;
}

export interface RoomDetail extends Room {
  note: string;
  progress: { currentSeq: number; remainSessions: number };
  members: RoomMember[];
}

/* ---------------- 自选分组（RQ-28） ---------------- */

export interface WatchItem {
  code: string;
  stockCode: string;
  group: string;
  note: string;
  createdAt: string;
}

/* ---------------- 偏好（RQ-33） ---------------- */

export interface Preferences {
  theme: 'light' | 'dark';
  density: 'compact' | 'normal' | 'loose';
}
