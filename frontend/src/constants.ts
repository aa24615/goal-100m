// 全局共享常量：把散落在各页面的“魔法字符串/数组”集中管理，便于统一维护与测试。

// 默认首页（行情中心）
export const HOME = '/market';

// 标签栏持久化键
export const TABS_STORAGE_KEY = 'qc_tabs';

// 左侧导航顺序（同时用于“当前路由命中哪个菜单”的判断）
export const NAV_ORDER = [
  '/market',
  '/watchlist',
  '/portfolio',
  '/transactions',
  '/leaderboard',
  '/profile',
] as const;

// 路由 -> 中文标题（菜单、标签栏、面包屑共用）
export const MENU_LABEL: Record<string, string> = {
  '/market': '行情中心',
  '/watchlist': '自选股',
  '/portfolio': '我的持仓',
  '/transactions': '交易记录',
  '/leaderboard': '收益排行榜',
  '/profile': '个人资料',
};

// 资产曲线时间区间（与 Portfolio 页 Segmented 一致）
export const EQUITY_PERIOD_OPTIONS = [
  { label: '7天', value: 7 },
  { label: '30天', value: 30 },
  { label: '90天', value: 90 },
  { label: '全部', value: 0 },
] as const;

// 资产曲线指标维度
export const EQUITY_METRIC_OPTIONS = [
  { label: '总资产', value: 'total' },
  { label: '收益额', value: 'profit' },
  { label: '收益率', value: 'returnPct' },
] as const;

// 排行榜周期（与后端 leaderboard PERIODS 保持一致）
export const LEADERBOARD_PERIODS = ['day', 'week', 'month', 'total'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

// 头像白名单（仅校验用，渲染数据来自 avatars.ts）
export const AVATAR_KEYS = [
  'none',
  'panda',
  'fox',
  'tiger',
  'cat',
  'dog',
  'rabbit',
  'owl',
  'monkey',
  'lion',
  'frog',
  'penguin',
  'crab',
] as const;
