// 全局共享常量：把散落在各页面的“魔法字符串/数组”集中管理，便于统一维护与测试。

/* ------------------------------------------------------------------ *
 * RQ-93 门面与定位：默认首页由「行情中心」改为「训练中心」             *
 * ------------------------------------------------------------------ *
 * v8 复核：内核早已是训练工具（双盲 + 体检单 + 真实规则），
 * 首屏却仍写着「A 股模拟交易大厅」，导航前 5 项全是行情/持仓/委托（F-15）。
 * 新用户按「模拟炒股」的预期进来，正面撞上同花顺 / 叩富的主场，
 * 而真正会留下来的「想练纪律的人」根本不知道这里有训练。
 * 因此：首访落点 = 训练，训练类入口前置，交易类收为「账户」。
 * ------------------------------------------------------------------ */

// 默认首页（训练中心）
export const HOME = '/training';

// 标签栏持久化键
export const TABS_STORAGE_KEY = 'qc_tabs';

/** 对外品牌口径：不再自称「模拟交易大厅」 */
export const BRAND = {
  name: '赚一个小目标',
  sub: '训练场',
  header: 'A 股训练场 · 练执行纪律',
  /** 自证测试的黑名单：这些旧门面文案一旦重现立即失败（防止悄悄漂回去） */
  forbidden: ['A 股模拟交易大厅', '模拟交易大厅'],
} as const;

// 左侧导航顺序（同时用于“当前路由命中哪个菜单”的判断）
// 注意：这里保持为**全量注册表**（含折叠项），渲染口径见 NAV_GROUPS。
export const NAV_ORDER = [
  '/training',
  '/blind',
  '/review',
  '/portfolio',
  '/orders',
  '/transactions',
  '/market',
  '/watchlist',
  '/replay',
  '/scenarios',
  '/rooms',
  '/leaderboard',
  '/profile',
] as const;

/**
 * RQ-93 / RQ-100 实际渲染的一级导航（分组）。
 * 硬约束：训练类入口在前两位；交易类收进「账户」；零使用功能不出现在一级导航。
 * 一级项 4 个（≤7），房间赛与剧本训练场已折叠出去。
 */
export const NAV_GROUPS: { key: string; title: string; items: string[] }[] = [
  { key: 'g-train', title: '训练', items: ['/training', '/blind', '/review'] },
  { key: 'g-account', title: '账户', items: ['/portfolio', '/orders', '/transactions'] },
  { key: 'g-market', title: '行情', items: ['/market', '/watchlist'] },
  { key: 'g-more', title: '更多', items: ['/replay', '/leaderboard', '/profile'] },
];

/**
 * RQ-100 零使用功能：房间赛 0 使用、剧本训练场 1 次（F-23）。
 * 它们**不进入任何一级分组**，但路由与 MENU_LABEL 保留，
 * 已收藏书签或直接输入地址的用户仍可访问——降噪不等于把功能删掉。
 */
export const LOW_USAGE_NAV = ['/scenarios', '/rooms'] as const;

// 路由 -> 中文标题（菜单、标签栏、面包屑共用）
export const MENU_LABEL: Record<string, string> = {
  '/training': '训练中心',
  '/market': '行情中心',
  '/watchlist': '自选股',
  '/portfolio': '我的持仓',
  '/orders': '我的委托',
  '/transactions': '交易记录',
  '/replay': '回放训练',
  '/blind': '双盲训练',
  '/review': '复盘战绩',
  '/scenarios': '剧本训练场',
  '/rooms': '房间赛',
  '/leaderboard': '收益排行榜',
  '/profile': '个人资料',
};

/* ------------------------------------------------------------------ *
 * RQ-92 首训直达（本期北极星的入场闸口）                              *
 * ------------------------------------------------------------------ *
 * 当前基线：开始 4 次 → 决策 0 次。用户卡在「不知道下一步做什么」。
 * 首训的目标不是教会规则，而是**让第一次判断真的发生**：
 * ≤3 次点击、≤60 秒、不需要先有持仓 / 先有样本 / 先懂规则。
 * ------------------------------------------------------------------ */
export const FIRST_TRAINING = {
  goalSeconds: 60,
  maxClicks: 3,
  title: '做一次训练',
  subtitle: '系统给你一段真实历史行情，你只需要做一个选择',
  cta: '开始第一次训练',
  decisionCta: '提交第一次判断',
  steps: [
    '点「开始第一次训练」，系统随机抽一段真实 A 股历史行情（看不到代码与日期）',
    '看走势，选一个方向：买 / 卖 / 观望，并写一句话说明为什么',
    // RQ-109：完成 = 结算并出成绩卡。旧文案「提交判断就完成了」与后端 FINISHED 口径冲突（F-32）
    '走到最后一根并结算，系统生成一张成绩卡 —— 这时这一局才算完成',
  ],
  note: '默认快局 12 根 K 线、1–2 次判断，约 1 分钟。不需要先有持仓，也不需要先积累样本。',
} as const;

/* ------------------------------------------------------------------ *
 * RQ-109「完成」口径契约（与后端 completionContract.js 同源）          *
 * ------------------------------------------------------------------ *
 * v9 实地复核发现三个互相矛盾的「完成」口径：
 * 卡片说「提交第一次判断就完成了」、会话 FINISHED 要走完 60 根、
 * 北极星算的是首次决策。用户不知道自己到底做完没有（F-32）。
 * 因此：完成 = 结算并出成绩卡，三处共用同一个常量。
 */
export const COMPLETION = {
  definition: '完成 = 结算并出成绩卡',
  status: 'FINISHED',
  card: '走到最后一根并结算，这一局才算完成，会生成一张成绩卡。',
  done: '这一局已完成，成绩卡已生成。',
  notDone: '这一局还没结算，继续走到最后一根即可出成绩卡。',
  /** 自证黑名单：这些旧口径一旦重现立即失败 */
  forbidden: ['提交第一次判断就完成了', '判断完就完成', '只要判断一次'],
} as const;

/* ------------------------------------------------------------------ *
 * RQ-107 局长度默认档位（与后端 sessionLengthService 同源）            *
 * ------------------------------------------------------------------ *
 * 默认由 60 根改为 12 根：单局 6 次判断的心理门槛高于收益预期（F-35），
 * 且中断后永远停在半路（F-31）。长局保留为进阶选项，不再是默认。
 */
export const DEFAULT_PRESET = 'quick' as const;
export const DEFAULT_BARS = 12;
export const MAX_DEFAULT_BARS = 15;

/* ------------------------------------------------------------------ *
 * RQ-110 引导路径四步埋点（与后端 GUIDE_STEPS 同源）                   *
 * ------------------------------------------------------------------ */
export const GUIDE_EVENTS = {
  enter: 'first_training_enter',
  start: 'first_training_start',
  decision: 'first_training_decision',
  finish: 'first_training_finish',
} as const;

/** RQ-116 已归档功能（下线而非折叠） */
export const ARCHIVED_PATHS = ['/scenarios', '/rooms'] as const;

/** RQ-113 净胜局榜上榜门槛（打满 N 局才上榜，不看绝对收益） */
export const CHALLENGE_MIN_ROUNDS = 5;

/** RQ-91 断点续做提示口径（与后端 buildResumeHint 同源） */
export const RESUME_HINT_PREFIX = '上次停在第';

/* ------------------------------------------------------------------ *
 * RQ-51 / RQ-72 口径统一管理                                          *
 *                                                                     *
 * 系统跑的是**真实 A 股公开行情**（5576 只标的 + 真实日线），          *
 * 只有资金与成交是模拟的。此前文案写「行情与资金均为虚拟仿真」，      *
 * 与实际不符（F-01），且三处文案各自硬编码导致口径漂移（F-02）。      *
 * 这里把所有对外口径收敛为唯一常量源，页面禁止再写字面量。            *
 * ------------------------------------------------------------------ */

/** 对外口径一句话版：真实行情 + 模拟资金与模拟交易 */
export const DISCLAIMER = '真实 A 股行情 · 模拟资金与模拟交易 · 不构成投资建议';

/** 口径长版（需要解释数据来源的场合，如登录页、关于页） */
export const DATA_SOURCE_STATEMENT =
  '行情数据为真实 A 股公开历史与实时快照（来源：公开行情接口，仅供学习研究），资金、持仓与成交为模拟撮合，不涉及任何真实交易。';

/**
 * RQ-77 可信评估所需的最小已平仓笔数（与后端 checkupService.SAMPLE_THRESHOLD 同源）。
 * 前端只用于展示进度，判定一律以后端为准，避免两边各设一个数。
 */
export const SAMPLE_THRESHOLD = 50;

/**
 * RQ-95 小样本护栏：样本 < 30 笔时**不展示任何比率类结论**（胜率 / 期望值 R / 平均 R / 持仓比），
 * 也不参与排名展示。且与后端 checkupService.RATIO_GUARD_THRESHOLD 同源 —— 前端只做展示判断，
 * 真正判定一律以后端 ratioGate 为准，避免两边各设一个数。
 */
export const RATIO_GUARD_THRESHOLD = 30;

/** 禁止再出现的旧口径文案——RQ-72 自证测试的黑名单，一旦漂移立即失败 */
export const FORBIDDEN_WORDINGS = [
  '行情与资金均为虚拟仿真',
  '资金与行情均为虚拟',
  '行情与资金均为虚拟',
  '虚拟仿真行情',
];

/** RQ-13 交易规则情景化说明（按板块分档，不再写死 ±10%） */
export const RULE_HINTS = [
  { key: 't1', title: 'T+1', desc: '当日买入的股份次日才能卖出，避免日内频繁进出。' },
  {
    key: 'limit',
    title: '涨跌停按板块',
    desc: '主板 ±10%、创业板/科创板 ±20%、北交所 ±30%、主板 ST ±5%；新股上市前 5 日无涨跌幅限制。涨停买不进、跌停卖不出。',
  },
  {
    key: 'halt',
    title: '停牌不可交易',
    desc: '停牌、退市或无有效报价的标的不能下单，下单会被拒绝并给出原因。',
  },
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
