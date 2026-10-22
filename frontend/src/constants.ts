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
  '/orders',
  '/transactions',
  '/replay',
  '/review',
  '/scenarios',
  '/rooms',
  '/leaderboard',
  '/profile',
] as const;

// 路由 -> 中文标题（菜单、标签栏、面包屑共用）
export const MENU_LABEL: Record<string, string> = {
  '/market': '行情中心',
  '/watchlist': '自选股',
  '/portfolio': '我的持仓',
  '/orders': '我的委托',
  '/transactions': '交易记录',
  '/replay': '回放训练',
  '/review': '复盘战绩',
  '/scenarios': '剧本训练场',
  '/rooms': '房间赛',
  '/leaderboard': '收益排行榜',
  '/profile': '个人资料',
};

// RQ-29 免责声明：交易与持仓等关键页面必须显著可见
export const DISCLAIMER = '模拟交易，不构成投资建议 · 行情与资金均为虚拟仿真';

// RQ-13 交易规则情景化说明（在下单面板就地展示，而非独立文档）
export const RULE_HINTS = [
  { key: 't1', title: 'T+1', desc: '当日买入的股份次日才能卖出，避免日内频繁进出。' },
  { key: 'limit', title: '涨跌停 ±10%', desc: '相对昨收 ±10% 即涨停/跌停，涨停买不进、跌停卖不出。' },
  { key: 'fee', title: '费用', desc: '佣金万3（最低 5 元）+ 卖出印花税万5 + 过户费万0.1，成本价含费。' },
  {
    key: 'lot',
    title: '最小单位',
    desc: 'A 股买入以「手」为单位，1 手 = 100 股，委托数量需为 100 的整数倍。',
  },
];

// RQ-02 回放播放器倍速档位
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;

// 剧本难度配色
export const DIFFICULTY_COLOR: Record<string, string> = {
  easy: 'green',
  medium: 'orange',
  hard: 'red',
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
