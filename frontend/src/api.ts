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

/* ---------------- RQ-35 埋点 ---------------- */
export const trackEvent = (event: string, payload?: Record<string, unknown>) =>
  api.post('/analytics/track', { event, payload });
