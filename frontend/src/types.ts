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
  /**
   * RQ-97 可信度误差带（±1.96σ/√n）。
   * 可选：兼容旧后端与单测里的不完整 mock，缺失时不渲染误差带而不是崩溃。
   */
  errorBand?: CheckupErrorBand;
  /** RQ-95 小样本护栏：缺失时按 sampleSize >= RATIO_GUARD_THRESHOLD 本地兜底 */
  ratioGate?: CheckupRatioGate;
  /** RQ-95 绩效类比率；样本未过护栏时为 null（页面据此整块隐藏） */
  ratios?: CheckupRatios | null;
}

/**
 * RQ-97 期望值误差带。
 * 竞品一律给满屏确定数字：60 笔就告诉你「期望值 0.31R」，
 * 却不告诉你 95% 置信下可能是 ±0.29R —— 连正负号都换得掉。
 */
export interface CheckupErrorBand {
  n: number;
  sigma: number;
  z: number;
  bandR: number | null;
  low: number | null;
  high: number | null;
  signUncertain: boolean;
  text: string;
  cannot: string;
}

/** RQ-95 小样本护栏判定结果 */
export interface CheckupRatioGate {
  threshold: number;
  sampleSize: number;
  showRatios: boolean;
  showRanking: boolean;
  showStrategyLanguage: boolean;
  remaining: number;
  action: { label: string; path: string } | null;
  reason: string;
}

/** RQ-95 绩效类比率（未过护栏时为 null） */
export interface CheckupRatios {
  winRate: number;
  expectancyR: number | null;
  avgR: number | null;
  holdRatio: number | null;
  bandR: number | null;
  signUncertain: boolean;
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

/* ---------------- RQ-91 断点续做 ---------------- */

/** 「上次停在第 N 根」提示 */
export interface ResumeHint {
  resumable: boolean;
  reason?: string;
  sessionId?: number | null;
  alias?: string | null;
  status?: string;
  cursorIndex?: number;
  totalBars?: number;
  percent?: number;
  text: string;
  updatedAt?: string | null;
  actions?: {
    resume: { label: string; path: string };
    abandon: { label: string; path: string };
  };
}

export interface BlindResume {
  resumable: boolean;
  hint: ResumeHint;
  session: BlindSession | null;
  view: BlindView | null;
  bars: MaskedBar[] | null;
}

/* ---------------- RQ-99 训练成绩卡 ---------------- */

export interface ScoreCardPayload {
  title: string;
  subtitle: string;
  lines: string[];
  text: string;
  copyable: boolean;
  disclaimer: string;
  tier: { key: string; label: string; remaining: number; nextLabel: string | null };
}

/* ---------------- RQ-96 训练漏斗 ---------------- */

export interface FunnelStep {
  key: string;
  label: string;
  event?: string;
  count?: number;
}

export interface FunnelSessionRow {
  sessionId: number | null;
  userId: number | null;
  reached: string;
  reachedLabel: string;
  breakpoint: string | null;
  breakpointLabel: string | null;
  decisions: number;
  secToFirstDecision: number | null;
  secTotal: number | null;
  withinFirstDecisionBudget: boolean | null;
}

export interface FunnelPayload {
  days: number;
  steps: FunnelStep[];
  conversion: {
    total: number;
    startToFirstDecision: number | null;
    firstToFinish: number | null;
    startToFinish: number | null;
  };
  timing: {
    medianSecToFirstDecision: number | null;
    medianSecToFinish: number | null;
    budgetSec: number;
    withinBudgetCount: number;
  };
  breakpoints: { key: string; label: string; stuck: number }[];
  sessions: FunnelSessionRow[];
  note: string;
}

/* ---------------- RQ-98 北极星 ---------------- */

export interface NorthStarPayload {
  current: {
    metric: string;
    target: string;
    value: number | null;
    numerator: number;
    denominator: number;
    readable: boolean;
    note: string;
  };
  formal: {
    metric: string;
    enabled: boolean;
    value: number | null;
    sampleSize: number;
    minSample: number;
    earliestReadableDate: string | null;
    referenceToday: string | null;
    reason: string;
  };
  disclaimer: string;
}

/* ---------------- RQ-105 获客实验 ---------------- */

export interface AcquisitionPayload {
  days: number;
  channels: {
    channel: string;
    registered: number;
    firstDecision: number;
    finished: number;
    firstTrainingRate: number | null;
    medianSecToFirstDecision: number | null;
  }[];
  total: { registered: number; firstDecision: number; firstTrainingRate: number | null };
  target: { registered: number; withinDays: number };
  note: string;
}

/* ---------------- RQ-104 站内提示 ---------------- */

export interface InboxItem {
  key: string;
  kind: 'milestone' | 'weekly';
  title: string;
  body: string;
  cannot: string;
  once: boolean;
  dismissible: boolean;
  createdAt: string;
  action?: { label: string; path: string };
}

export interface InboxPayload {
  items: InboxItem[];
  count: number;
  dismissed: string[];
  note: string;
}

/* ---------------- RQ-102 训练与真实规则账户同源 ---------------- */

export interface RuleManifestItem {
  key: string;
  label: string;
  desc: string;
  source: string;
}

export interface RuleParityPayload {
  manifest: RuleManifestItem[];
  parity: {
    consistent: boolean;
    manifest: string[];
    trainingRules: string[];
    accountRules: string[];
    missingInAccount: string[];
    missingInTraining: string[];
    summary: string;
  };
  plan: {
    sessionId: number | null;
    eligible: boolean;
    blockedReason: string | null;
    orders: {
      seq: number | null;
      code: string | null;
      name: string | null;
      side: string | null;
      quantity: number;
      repricedAtMarket: boolean;
      appliedRules: string[];
      note: string;
    }[];
    rules: string[];
  };
}

/* ================= v9 增长需求（RQ-106 ~ 118） ================= */

/** RQ-106 公网可达性 */
export interface PublicAccessPayload {
  ready: boolean;
  publicUrl: string | null;
  host: string | null;
  https: boolean;
  source: string | null;
  blockers: string[];
  checklist: { key: string; label: string; done: boolean }[];
  downstream: string[];
  note: string;
}

/** RQ-107 局长度档位 */
export interface SessionPreset {
  key: string;
  label: string;
  bars: number;
  decisionInterval: number;
  default: boolean;
  advanced: boolean;
  desc: string;
  bestFor: string;
  source?: string;
}
export interface PresetsPayload {
  presets: SessionPreset[];
  defaultBars: number;
  shortByDefault: boolean;
  note: string;
}

/** RQ-110 引导四步漏斗 */
export interface GuideFunnelPayload {
  days: number;
  steps: {
    key: string;
    label: string;
    count: number;
    conversionFromPrev: number | null;
    conversionFromEnter: number | null;
  }[];
  dropAt: { step: string; label: string; after: string } | null;
  summary: {
    entered: number;
    started: number;
    decided: number;
    finished: number;
    completionRate: number | null;
    medianSecToFinish: number | null;
  };
  note: string;
}

/** RQ-111 小样本能说的三件事 */
export interface SmallSamplePayload {
  sampleSize: number;
  smallSample: boolean;
  threshold: number;
  facts: { key: string; kind: string; available: boolean; headline: string; detail: string; needsSample: boolean; netWin?: number | null }[];
  sayableCount: number;
  nextAction: { label: string; hint: string; cta: string };
  blockedAssertions: string[];
  disclaimer: string;
}

/** RQ-113 每日一题 */
export interface TodayChallengePayload {
  date: string;
  bars: number;
  created: boolean;
  minRounds: number;
  streak: { current: number; longest: number; days: string[]; lastDate: string | null } | null;
  metric: string;
  note: string;
}
export interface ChallengeBoardPayload {
  minRounds: number;
  /** RQ-126：活跃用户不足 100 时公榜不产出内容（空榜会劝退） */
  activeUsers?: number | null;
  publicBoardEnabled?: boolean;
  publicBoardMinUsers?: number;
  boardReason?: string | null;
  board: { rank: number; ref: string; displayName: string; rounds: number; netWin: number; eligible: boolean }[];
  participants: number;
  waiting: { displayName: string; rounds: number; remaining: number }[];
  metric: string;
  metricDef: string;
  note: string;
  streak?: { current: number; longest: number; days: string[]; lastDate: string | null } | null;
  /** RQ-126 主角：个人连打记录（连打日历 + 与上周的自己比） */
  streakRecord?: StreakRecordPayload | null;
}

/** RQ-126 个人连打记录 */
export interface StreakRecordPayload {
  windowDays: number;
  calendar: { date: string; participated: boolean }[];
  thisWeek: number;
  lastWeek: number;
  delta: number;
  current: number;
  longest: number;
  lastDate: string | null;
  totalDays: number;
  comparison: string;
  metric: string;
  metricDef: string;
  note: string;
}

/** RQ-125 结算口径说明书 */
export interface SettlementRule {
  key: string;
  title: string;
  body: string;
  verifiable: string;
}
export interface SettlementOrderLine {
  index: number;
  seq: number | null;
  side: string;
  sideLabel: string;
  quantity: number;
  price: number | null;
  amount: number;
  fee: number;
  feeBreakdown: {
    amount: number;
    commission: number;
    stamp: number;
    transfer: number;
    total: number;
    minCommissionApplied: boolean;
  };
  feeMatched: boolean | null;
  recordedFee: number | null;
  realizedPnl: number | null;
  code: string | null;
  name: string | null;
  text: string;
}
export interface SettlementPayload {
  title: string;
  applicable: boolean;
  finished: boolean;
  reveal: boolean;
  rules: SettlementRule[];
  orders: SettlementOrderLine[];
  orderCount: number;
  totals: {
    amount: number;
    buyAmount: number;
    sellAmount: number;
    fee: number;
    realizedPnl: number;
  };
  summary: string;
  reconciliation: string;
  feeAudit: { checked: number; mismatch: number; ok: boolean; note: string };
  returnPct: number | null;
  buyHoldPct: number | null;
  text: string;
  disclaimer: string;
}

/** RQ-122 公网可达性 */
export interface PublicAccessPayload {
  ready: boolean;
  publicUrl: string | null;
  host: string | null;
  https: boolean;
  blockers: string[];
  checklist: { key: string; label: string; done: boolean }[];
  nextAction: string;
  suggestion: { domain: string; env: string; note: string } | null;
}

/** RQ-108 游客会话 */
export interface GuestSessionPayload {
  kind: 'guest' | 'user' | 'anonymous';
  hasSession?: boolean;
  userId: number | null;
  guestToken: string | null;
  created?: boolean;
  limit?: number;
  quota: {
    allowed: boolean;
    used: number;
    remaining: number;
    limit: number;
    signupReason: string;
    message: string;
  } | null;
  howTo?: string;
}

/** RQ-114 归因 */
export interface ShareLinkPayload {
  ok: boolean;
  url: string | null;
  channel: string;
  reason: string | null;
  publicReady?: boolean;
  note?: string;
}

/** RQ-116 归档 */
export interface ArchivedItem {
  path: string;
  label: string;
  apiPrefix: string;
  archivedAt: string;
  reason: string;
  replacement: { path: string; label: string } | null;
}

/** RQ-117 达标进度 */
export interface TierProgressPayload {
  sampleSize: number;
  finishedRounds: number;
  tier: { key: string; label: string; threshold: number };
  next: { key: string; label: string; threshold: number } | null;
  remainingToNext: number;
  reachedTop: boolean;
  gates: { key: string; label: string; threshold: number; current: number; remaining: number; reached: boolean }[];
  notices: { key: string; kind: string; title: string; body: string; cannot: string; once: boolean; dismissible: boolean }[];
  progressPct: number;
  message: string;
  note: string;
}
