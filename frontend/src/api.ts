import axios from 'axios';
import type {
  User,
  Order,
  Preferences,
  ReplayRange,
  ReplaySession,
  ReplayState,
  ReplayScore,
  ReviewPayload,
  AbilityRadar,
  ShareCard,
  GuideStep,
  OnboardingState,
  Scenario,
  ScenarioBars,
  ScenarioResult,
  Room,
  RoomDetail,
  WatchItem,
  MarketStatus,
  DailyBar,
  CheckupPayload,
  BlindStartResult,
  BlindSession,
  BlindView,
  BlindScore,
  BlindDecision,
  MaskedBar,
  TrainingPrescription,
  SegmentTag,
  Granularity,
  BlindResume,
  ScoreCardPayload,
  FunnelPayload,
  NorthStarPayload,
  AcquisitionPayload,
  InboxPayload,
  RuleParityPayload,
} from './types';

const api = axios.create({ baseURL: '/api' });

// 由 auth context 注册：清理内存态并回到登录页，而不是硬跳转根路径
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  unauthorizedHandler = fn;
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('pt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response && err.response.status === 401) {
      localStorage.removeItem('pt_token');
      if (unauthorizedHandler) unauthorizedHandler();
      else window.location.href = window.location.origin + '/';
    }
    return Promise.reject(err);
  }
);

export default api;

export interface ProfileUpdate {
  displayName?: string;
  avatar?: string | null;
}

export const getProfile = () => api.get<User>('/profile');
export const updateProfile = (data: ProfileUpdate) => api.put<User>('/profile', data);

/* ---------------- RQ-33 偏好 ---------------- */
export const getPreferences = () => api.get<Preferences>('/profile/preferences');
export const savePreferences = (p: Partial<Preferences>) => api.put<Preferences>('/profile/preferences', p);

/* ---------------- RQ-01 ~ RQ-06 回放训练 ---------------- */
export const getReplayRange = () => api.get<ReplayRange>('/replay/range');
export const startReplay = (startSeq: number, endSeq: number, capital?: number) =>
  api.post<{ session: ReplaySession; state: ReplayState }>('/replay/start', { startSeq, endSeq, capital });
export const getReplay = (id: number) =>
  api.get<{ session: ReplaySession; state: ReplayState }>(`/replay/${id}`);
export const stepReplay = (id: number, action: 'next' | 'prev' | 'seek' | 'hold', seq?: number) =>
  api.post<{ session: ReplaySession; state: ReplayState; atEnd: boolean }>(`/replay/${id}/step`, { action, seq });
export const tradeReplay = (id: number, code: string, side: 'BUY' | 'SELL', quantity: number) =>
  api.post<{ ok: boolean; price: number; state: ReplayState }>(`/replay/${id}/trade`, { code, side, quantity });
export const finishReplay = (id: number) =>
  api.post<{ session: ReplaySession; state: ReplayState | null; score: ReplayScore }>(`/replay/${id}/finish`);
export const listReplays = (limit = 20) => api.get<ReplaySession[]>('/replay/history', { params: { limit } });
export const compareReplays = (startSeq: number, endSeq: number) =>
  api.get<{ id: number; startedAt: string; durationSec: number; result: ReplayScore | null }[]>('/replay/compare', {
    params: { startSeq, endSeq },
  });

/* ---------------- RQ-07 ~ RQ-11 复盘战绩 ---------------- */
export const getReview = (period = '30d') => api.get<ReviewPayload>('/review', { params: { period } });
export const getLatestReview = (period = '30d') => api.get<ReviewPayload | { empty: boolean }>('/review/latest', { params: { period } });
export const getReviewBenchmark = (days = 30) => api.get('/review/benchmark', { params: { days } });
export const getAbility = (period = '30d') => api.get<AbilityRadar & { period: string }>('/review/ability', { params: { period } });
export const getShareCard = (period = '30d') => api.get<ShareCard>('/review/share-card', { params: { period } });
export const getOrders = (status?: string) => api.get<Order[]>('/orders', { params: status ? { status } : undefined });
export const cancelOrder = (id: number) => api.delete(`/orders/${id}`);
export const createOrder = (data: { code: string; side: 'BUY' | 'SELL'; price: number; quantity: number }) =>
  api.post('/orders', data);

/* ---------------- RQ-12 ~ RQ-15 引导与成长 ---------------- */
export const getGuideSteps = () => api.get<{ steps: GuideStep[]; disclaimer: string }>('/onboarding/steps');
export const getOnboarding = () => api.get<OnboardingState>('/onboarding');
export const updateGuide = (action: 'step' | 'skip' | 'complete', step?: number) =>
  api.post<OnboardingState>('/onboarding/guide', { action, step });
export const checkin = () => api.post('/onboarding/checkin');

/* ---------------- RQ-16 ~ RQ-19 剧本训练场 ---------------- */
export const listScenarios = () => api.get<Scenario[]>('/scenarios');
export const getScenarioBars = (key: string) => api.get<ScenarioBars>(`/scenarios/${key}/bars`);
export const submitScenario = (key: string, trades: { seq: number; side: string; quantity: number }[]) =>
  api.post<ScenarioResult>(`/scenarios/${key}/attempts`, { trades });
export const listAttempts = (key?: string) => api.get('/scenarios/attempts', { params: key ? { key } : undefined });

/* ---------------- RQ-20 ~ RQ-22 房间赛 ---------------- */
export const createRoom = (name: string, duration = '1d') => api.post<Room>('/rooms', { name, duration });
export const joinRoom = (code: string) => api.post<Room>('/rooms/join', { code });
export const listRooms = () => api.get<Room[]>('/rooms');
export const getRoom = (id: number) => api.get<RoomDetail>(`/rooms/${id}`);
export const closeRoom = (id: number) => api.post<RoomDetail>(`/rooms/${id}/close`);

/* ---------------- RQ-27 交易日状态 ---------------- */
export const getMarketStatus = () => api.get<MarketStatus>('/market/status');
export const getStockDaily = (code: string, days = 120) =>
  api.get<{ code: string; count: number; bars: DailyBar[] }>(`/stocks/${code}/daily`, { params: { days } });

/* ---------------- RQ-28 自选分组与备注 ---------------- */
export const getWatchlist = () => api.get<WatchItem[]>('/watchlist');
export const getWatchGroups = () => api.get<{ group: string; count: number }[]>('/watchlist/groups');
export const addWatch = (code: string, group?: string, note?: string) =>
  api.post('/watchlist', { code, group, note });
export const updateWatch = (code: string, data: { group?: string; note?: string | null }) =>
  api.patch(`/watchlist/${code}`, data);
export const removeWatch = (code: string) => api.delete(`/watchlist/${code}`);

/* ---------------- RQ-30 密码找回 ---------------- */
export const forgotPassword = (email: string) => api.post<{ ok: boolean; message: string; devToken?: string; devLink?: string }>('/auth/forgot', { email });
export const resetPassword = (token: string, password: string) => api.post('/auth/reset', { token, password });

/* ---------------- RQ-34 重置约束 ---------------- */
export const getResetNotice = () =>
  api.get<{
    cooldownHours: number;
    cooldownLeftHours: number;
    canReset: boolean;
    resetCount: number;
    confirmText: string;
    impact: string[];
  }>('/account/reset/notice');
export const resetAccount = (confirm: string) => api.post('/account/reset', { confirm });

/* ---------------- RQ-66/67/38/41 双盲训练 ---------------- */
export const startBlind = (body?: {
  bars?: number;
  liquidOnly?: boolean;
  code?: string;
  startSeq?: number;
  endSeq?: number;
  /** RQ-82 片段特征标签：trend / range / pullback / volatile，不传即随机 */
  tag?: string;
  /** RQ-81 粒度，当前仅 day 可用 */
  granularity?: string;
  /**
   * RQ-107 局长度档位：quick(12) / standard(60) / long(120) / epic(200)。
   * 不传即走默认快局——以前页面写死 bars:60，是「一局要 6 次判断」的直接来源（F-35）。
   */
  preset?: string;
  /** RQ-110 声明这是一次引导局，用于把四步埋点补齐（进入/开始/决策/结算） */
  guide?: boolean;
  /** RQ-108 游客 token：未登录用户带上即可免登录练一次 */
  guestToken?: string;
}) => api.post<BlindStartResult>('/blind/start', body || {});

/** RQ-83 训练处方：由体检单生成定向训练计划 */
export const buildPrescription = (checkup: unknown) =>
  api.post<TrainingPrescription>('/blind/prescription', { checkup });
/** RQ-83 一键开训：生成处方并直接创建会话 */
export const startPrescription = (checkup: unknown, bars?: number) =>
  api.post<{ id: number; prescription: TrainingPrescription }>('/blind/prescription/start', { checkup, bars });
/** RQ-82 片段类型字典 + RQ-81 可用粒度 */
export const getBlindTags = () =>
  api.get<{ tags: SegmentTag[]; granularities: Granularity[]; intradayAvailable: boolean }>('/blind/tags');
/** RQ-62 指标看板 */
export const getDashboard = (params?: { days?: number; granularity?: 'day' | 'week' }) =>
  api.get('/analytics/dashboard', { params });
/** RQ-62 北极星：N 日留存 */
export const getRetention = (params?: { days?: number; window?: number }) =>
  api.get('/analytics/retention', { params });
/** RQ-86 每周训练周报 */
export const getWeeklyReport = (params?: { days?: number }) => api.get('/analytics/weekly', { params });
export const getBlind = (id: number) =>
  api.get<{ session: BlindSession; view: BlindView; bars: MaskedBar[] }>(`/blind/${id}`);
export const stepBlind = (id: number, action: 'next' | 'prev' | 'seek' | 'hold', seq?: number) =>
  api.post<{ view: BlindView; bars: MaskedBar[] }>(`/blind/${id}/step`, { action, seq });
export const submitDecision = (id: number, data: { action: 'BUY' | 'SELL' | 'HOLD'; reason?: string; stopPlan?: number; skipped?: boolean }) =>
  api.post<{ id: number; skipped: boolean }>(`/blind/${id}/decision`, data);
export const listDecisions = (id: number) => api.get<BlindDecision[]>(`/blind/${id}/decisions`);
export const tradeBlind = (id: number, side: 'BUY' | 'SELL', quantity: number) =>
  api.post<{ ok: boolean; view: BlindView; bars: MaskedBar[] }>(`/blind/${id}/trade`, { side, quantity });
export const finishBlind = (id: number) =>
  api.post<{ session: BlindSession; score: BlindScore; view: BlindView }>(`/blind/${id}/finish`);
export const listBlind = (limit = 20) => api.get<BlindSession[]>('/blind/history', { params: { limit } });

/* ---------------- RQ-91 断点续做 ---------------- */
export const resumeBlind = () => api.get<BlindResume>('/blind/resume');
export const abandonBlind = (id: number) => api.post<{ ok: boolean; id: number }>(`/blind/${id}/abandon`);
/** RQ-101 参数字典唯一源 */
export const getBlindDict = () =>
  api.get<{
    tags: SegmentTag[];
    tagKeys: string[];
    aliases: Record<string, string>;
    granularities: Granularity[];
    defaultGranularity: string;
    decisionInterval: number;
  }>('/blind/dict');

/* ---------------- RQ-99 训练成绩卡 ---------------- */
export const getScoreCard = (id: number) => api.get<ScoreCardPayload>(`/blind/${id}/card`);

/* ---------------- RQ-102 训练与真实规则账户同源 ---------------- */
export const getRuleParity = (id: number) => api.get<RuleParityPayload>(`/blind/${id}/parity`);

/* ---------------- RQ-94 / RQ-96 / RQ-98 / RQ-105 / RQ-104 ---------------- */
export const getFunnel = (params?: { days?: number }) => api.get<FunnelPayload>('/analytics/funnel', { params });
export const getNorthStar = () => api.get<NorthStarPayload>('/analytics/north-star');
export const getAcquisition = (params?: { days?: number }) =>
  api.get<AcquisitionPayload>('/analytics/acquisition', { params });
export const getNotifications = (dismissed: string[] = []) =>
  api.get<InboxPayload>('/analytics/notifications', { params: { dismissed: dismissed.join(',') } });

/* ---------------- RQ-76/77/78 交易体检单 ---------------- */
export const getCheckup = (period = '30d') => api.get<CheckupPayload>('/review/checkup', { params: { period } });

/* ---------------- RQ-35 埋点 ---------------- */
export const trackEvent = (event: string, payload?: Record<string, unknown>) =>
  api.post('/analytics/track', { event, payload });

/* ================= v9 增长需求（RQ-106 ~ 118） ================= */

/* ---------------- RQ-106 公网可达 ---------------- */
export const getPublicAccess = () => api.get<import('./types').PublicAccessPayload>('/config/public-access');

/* ---------------- RQ-107 局长度档位 ---------------- */
export const getSessionPresets = () => api.get<import('./types').PresetsPayload>('/blind/presets');

/* ---------------- RQ-110 引导四步漏斗 ---------------- */
export const getGuideFunnel = (params?: { days?: number }) =>
  api.get<import('./types').GuideFunnelPayload>('/analytics/guide-funnel', { params });

/* ---------------- RQ-111 小样本能说的三件事 ---------------- */
export const getSmallSample = () => api.get<import('./types').SmallSamplePayload>('/analytics/small-sample');

/* ---------------- RQ-113 每日一题 / 净胜局 / 连打 ---------------- */
export const getTodayChallenge = () => api.get<import('./types').TodayChallengePayload>('/challenge/today');
export const joinChallenge = (body: { sessionId: number; returnPct: number; buyHoldPct: number }) =>
  api.post<{ ok: boolean; date: string; netWin: number; recorded: boolean }>('/challenge/join', body);
export const getChallengeBoard = (params?: { days?: number }) =>
  api.get<import('./types').ChallengeBoardPayload>('/challenge/board', { params });
export const getChallengeStreak = () =>
  api.get<{ current: number; longest: number; days: string[]; lastDate: string | null }>('/challenge/streak');

/* ---------------- RQ-114 获客归因 ---------------- */
export const buildShareLink = (channel: string, path?: string) =>
  api.post<import('./types').ShareLinkPayload>('/attribution/link', { channel, path });
export const attachChannel = (channel: string) => api.post<{ ok: boolean; channel: string }>('/attribution/attach', { channel });

/* ---------------- RQ-116 归档清单 ---------------- */
export const getArchived = () => api.get<{ items: import('./types').ArchivedItem[]; note: string }>('/config/archived');

/* ---------------- RQ-117 达标进度 ---------------- */
export const getTierProgress = (dismissed: string[] = []) =>
  api.get<import('./types').TierProgressPayload>('/analytics/tier-progress', {
    params: { dismissed: dismissed.join(',') },
  });

/* ---------------- RQ-121 / RQ-122 公网可达与游客会话 ---------------- */
/**
 * 规范端点（v10 RQ-121）。上方 RQ-106 的 `/config/public-access` 保留为兼容别名，
 * 两者返回同一 payload 结构；新增调用一律走这里。
 */
export const getPublicAccessStatus = () => api.get<import('./types').PublicAccessPayload>('/public/access');
export const getGuestSession = () => api.get<import('./types').GuestSessionPayload>('/guest/session');
export const createGuestSession = (guestToken?: string | null) =>
  api.post<import('./types').GuestSessionPayload>('/guest/session', guestToken ? { guestToken } : {});

/* ---------------- RQ-125 结算口径说明书 ---------------- */
export const getSettlement = (sessionId: number) =>
  api.get<import('./types').SettlementPayload>(`/blind/${sessionId}/settlement`);

/* ---------------- RQ-126 个人连打记录 ---------------- */
export const getStreakRecord = (windowDays = 28) =>
  api.get<import('./types').StreakRecordPayload>('/challenge/streak/record', { params: { windowDays } });
