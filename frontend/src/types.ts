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

/** RQ-47 / RQ-57 行情数据源状态（后端 quoteFeedStatus） */
export interface QuoteFeedStatus {
  size: number;
  lastFetchAt: string | null;
  staleForMs: number | null;
  stale: boolean;
  interrupted: boolean;
  lastError: string | null;
  source: string;
  polls: number;
  pollMs: number;
  idleMs: number;
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
  inTradingWindow?: boolean;
  tickMs: number;
  dailyLimit: number;
  /** RQ-49 分板块涨跌停规则表 */
  boardRules?: {
    boards: Record<string, { label: string; limit: number }>;
    stLimit: number;
    newListingExemptDays: number;
  };
  dataSource?: string;
  stocks?: number;
  /** RQ-47：数据源状态，前端据此展示更新时间与中断提示 */
  quote?: QuoteFeedStatus;
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

/* ---------------- 交易体检单（RQ-76 / RQ-77 / RQ-78） ---------------- */

export interface MetricHint {
  label: string;
  meaning: string;
  whenToChange: string;
  formula: string;
}

export interface CheckupGate {
  sufficient: boolean;
  sampleSize: number;
  threshold: number;
  remaining: number;
  message: string;
}

export interface CheckupVerdict {
  hasEdge: boolean;
  grade: 'positive' | 'negative';
  summary: string;
  disclaimer: string;
}

export interface BreakdownGroup {
  key: string;
  label: string;
  count: number;
  pnl: number;
  sellIds: Array<number | string>;
}

export interface CheckupBreakdown {
  byHold: BreakdownGroup[];
  byWeekday: BreakdownGroup[];
  bySession: BreakdownGroup[];
  bySource: BreakdownGroup[];
}

export interface CheckupPayload {
  sampleSize: number;
  threshold: number;
  sufficient: boolean;
  remaining: number;
  expectancy: {
    amount: number;
    r: number | null;
    avgWin: number;
    avgLoss: number;
    winRate: number;
    lossRate: number;
    winCount: number;
    lossCount: number;
    grossProfit: number;
    grossLoss: number;
    hint: MetricHint;
  };
  expectancyR: { value: number | null; hint: MetricHint };
  rMultiple: {
    avgR: number | null;
    count: number;
    list: Array<{ sellId: number | string | null; code: string; r: number; planned: boolean }>;
    hint: MetricHint;
  };
  holdTime: {
    winHoldDays: number | null;
    lossHoldDays: number | null;
    ratio: number | null;
    winCount: number;
    lossCount: number;
    hint: MetricHint;
  };
  discipline: {
    rate: number | null;
    total: number;
    recorded: number;
    skipped: number;
    note: string;
    hint: MetricHint;
  };
  worstHabit:
    | {
        key: string;
        label: string;
        cost: number;
        detail: string;
        alternatives: Array<{ key: string; label: string; cost: number; detail: string }>;
        hint: MetricHint;
      }
    | null;
  verdict: CheckupVerdict | null;
  gate: CheckupGate;
  rawRounds: Array<Record<string, unknown>>;
  breakdown: CheckupBreakdown;
  /**
   * RQ-79 可信度分档：50 行为级 / 100 绩效级 / 200 策略级。
   *
   * 以下 7 个字段均为可选：后端新版本必定返回，但为了兼容「旧后端 + 新前端」
   * 与单测里不完整的 mock，组件必须能在字段缺失时降级而不是崩溃
   * （缺失即退化为 RQ-77 的「够 / 不够」两态）。
   */
  tier?: CheckupTier;
  tierLabel?: string;
  canTrust?: string[];
  cannotTrust?: string[];
  /** RQ-80 距下一档还差 N 笔 */
  progress?: CheckupProgress;
  /** RQ-80 达标当日提示（仅笔数刚好等于门槛时为 true，可关闭） */
  milestone?: {
    justReached: boolean;
    tierKey?: string;
    tierLabel?: string;
    message?: string;
    cannot?: string;
    dismissible?: boolean;
  };
  /** RQ-85 0 笔冷启动引导 */
  coldStart?: CheckupColdStart;
}

/** RQ-79 可信度档位 */
export interface CheckupTier {
  key: 'none' | 'behavior' | 'performance' | 'strategy';
  label: string;
  short: string;
  threshold: number;
  canTrust: string[];
  cannotTrust: string[];
  summary: string;
  reachedTop: boolean;
  next: { key: string; label: string; short: string; threshold: number } | null;
  remaining: number;
  progressPercent: number;
  sufficient: boolean;
}

/** RQ-80 升档进度 */
export interface CheckupProgress {
  sampleSize: number;
  tierKey: string;
  tierLabel: string;
  nextTierKey: string | null;
  nextTierLabel: string | null;
  nextThreshold: number | null;
  remaining: number;
  percent: number;
  reachedTop: boolean;
  text: string;
}

/** RQ-85 冷启动引导（0 笔用户） */
export interface CheckupColdStart {
  isCold: boolean;
  title?: string;
  steps?: string[];
  sessionsTarget?: number;
  action?: { label: string; path: string };
  note?: string;
}

/** RQ-83 训练处方：体检「最坏习惯」→ 定向训练计划 */
export interface TrainingPrescription {
  habitKey: string | null;
  habitLabel: string | null;
  habitCost: number | null;
  tag: 'trend' | 'range' | 'pullback' | 'volatile';
  tagLabel: string;
  title: string;
  why: string;
  requiredFields: string[];
  drill: string;
  sessions: number;
  bars: number;
  tierKey: string;
  sampleSize: number;
  note: string;
}

/** RQ-82 片段特征标签 */
export interface SegmentTag {
  key: 'trend' | 'range' | 'pullback' | 'volatile';
  label: string;
  desc: string;
}

/** RQ-81 训练粒度 */
export interface Granularity {
  key: string;
  label: string;
  available: boolean;
  note: string;
}

/* ---------------- 双盲训练（RQ-66 / RQ-67 / RQ-38 / RQ-41） ---------------- */

/** 遮蔽后的 K 线：只有相对序号与 OHLCV，不含代码与日期 */
export interface MaskedBar {
  i: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
}

export interface BlindStartResult {
  id: number;
  alias: string;
  status: string;
  // 只给长度，不给 seq —— seq 可对回交易日历从而推出日期
  totalBars: number;
  decisionInterval: number;
}

export interface BlindSession {
  id: number;
  alias: string;
  // 未结束时为 null —— 界面不得通过任何途径推断标的身份
  code: string | null;
  name: string | null;
  status: string;
  // 未结束为 null（同 RQ-66：不得泄露可反查日期的序号）
  startSeq: number | null;
  endSeq: number | null;
  totalBars?: number;
  cursorSeq?: number | null;
  score?: BlindScore | null;
  createdAt?: string;
  finishedAt?: string | null;
  revealed?: boolean;
}

export interface BlindView {
  id: number;
  alias: string;
  status: string;
  cursorIndex: number;
  totalBars: number;
  capital: number;
  cash: number;
  positions: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  rejected: Array<Record<string, unknown>>;
  equity: Array<{ i: number; cash: number; marketValue: number; totalAssets: number }>;
  realizedTotal: number;
  feeTotal: number;
  tradeCount: number;
  maxDrawdown: number;
  atEnd: boolean;
  decisionPoints: number[];
  decisions?: BlindDecision[];
  revealed?: { code: string; name: string; startSeq: number; endSeq: number } | null;
}

export interface BlindDecision {
  id: number;
  seq: number;
  action: 'BUY' | 'SELL' | 'HOLD';
  reason: string | null;
  stopPlan: number | null;
  skipped: boolean;
  createdAt?: string;
}

export interface BlindScore {
  returnPct: number;
  totalAssets: number;
  maxDrawdown: number;
  tradeCount: number;
  durationSec: number | null;
  decisionPoints: number;
  disciplineRate: number | null;
  discipline: { rate: number | null; total: number; recorded: number; skipped: number; note: string };
  sampleNote: string;
  realizedTotal: number;
  feeTotal: number;
  disclaimer: string;
}
