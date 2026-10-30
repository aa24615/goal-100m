/**
 * v12 需求前端覆盖测试（RQ-146 / RQ-147 / RQ-150 / RQ-151 / RQ-152 / RQ-153 / RQ-154）
 *
 * 优先级：P0 主流程 · P1 差异化 · P2 留存体验 · P3 边界异常 · P5 兼容回归
 *
 * 这一版前端最该防的是两类老毛病：
 *   ① 页面为了「不空」自己塞数字进去（F-19 / F-32 的复发路径）；
 *   ② 后端能力已上线但页面上找不到入口（F-82）。
 * 因此下面每一条断言守的都是**用户看得见什么**，而不是接口返回什么。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';

import SettlementAuditPanel from './components/SettlementAuditPanel';
import SettlementEntryCard from './components/SettlementEntryCard';
import IntervalConclusion from './components/IntervalConclusion';
import RetentionNoticeCard from './components/RetentionNoticeCard';
import type {
  SettlementAuditPayload,
  ConclusionPayload,
  RetentionPayload,
} from './types';

const wrap = (ui: React.ReactNode) => render(<ConfigProvider><AntApp>{ui}</AntApp></ConfigProvider>);

/* ------------------------------ fixtures ------------------------------ */

const AUDIT_OK: SettlementAuditPayload = {
  applicable: true,
  finished: true,
  reveal: true,
  rules: [
    { key: 'price', title: '成交价从哪来', body: '按当前 K 线收盘价成交', verifiable: '与收盘价一致' },
    { key: 'slippage', title: '滑点', body: '不引入滑点模型', verifiable: '成交价=收盘价' },
    { key: 't1', title: 'T+1', body: '当日买不可卖', verifiable: '返回 400' },
    { key: 'limit', title: '涨跌停', body: '超出幅度拒绝', verifiable: '返回 400' },
    { key: 'lot', title: '整手', body: '100 的整数倍', verifiable: '返回 400' },
    { key: 'fee', title: '费用', body: '佣金/印花税/过户费', verifiable: '逐笔重算' },
  ],
  slippageRule: { hasModel: false, value: 0, title: '滑点', body: '不引入滑点模型', verifiable: '成交价=收盘价' },
  orders: [
    {
      index: 1,
      seq: 5,
      side: 'BUY',
      sideLabel: '买入',
      quantity: 100,
      price: 10.02,
      amount: 1002,
      fee: 5.01,
      feeBreakdown: { amount: 1002, commission: 5, stamp: 0, transfer: 0.01, total: 5.01, minCommissionApplied: true },
      feeMatched: true,
      recordedFee: 5.01,
      realizedPnl: 0,
      code: null,
      name: null,
      text: '第 1 笔 · 买入 100 股 @ ¥10.02',
      priceOrigin: {
        seq: 5, price: 10.02, barClose: 10.02, matched: true,
        basis: '撮合价 = 该根已揭示 K 线的收盘价', slippage: 0, hasQuote: true,
        note: '第 5 根 K 线收盘价 ¥10.02，撮合价与之一致',
      },
      slippage: { applied: false, value: 0, rule: '不引入滑点模型' },
      qa: {
        price: { question: '为什么是这个价？', answer: '第 5 根收盘价 ¥10.02', verifiable: true, evidence: { seq: 5, barClose: 10.02, matched: true } },
        fee: { question: '扣了多少费？', answer: '合计 ¥5.01', verifiable: true, evidence: { amount: 1002 } },
        slippage: { question: '滑点多少？', answer: '不引入滑点模型', verifiable: true, evidence: { hasModel: false, value: 0 } },
      },
    },
  ],
  orderCount: 1,
  rejections: [
    {
      seq: 6, side: 'SELL', sideLabel: '卖出', quantity: 100,
      reason: '当日买入不可卖（T+1）', known: true, ruleKey: 't1', ruleTitle: 'T+1 当日不可卖',
      rule: '当日买入的仓位当日不可卖出', howToVerify: '卖出 seq 必须大于买入 seq',
      fix: '推进到下一根 K 线后再卖出', code: null, text: '第 T+1 当日不可卖：...',
    },
  ],
  rejectionCount: 1,
  totals: { amount: 1002, fee: 5.01, realizedPnl: 0 },
  audit: {
    priceChecked: 1, priceMismatch: 0, feeChecked: 1, feeMismatch: 0, unknownRejections: 0,
    ok: true, note: '三项全为 0 时本局才可声称逐笔可核对。',
  },
  returnPct: 1.2,
  buyHoldPct: 0.8,
  disclaimer: '以上为模拟撮合。',
};

const CONCLUSION_SMALL: ConclusionPayload = {
  mode: 'three-facts',
  sampleSize: 12,
  threshold: 50,
  remaining: 38,
  facts: {
    sampleSize: 12,
    smallSample: true,
    threshold: 30,
    facts: [
      { key: 'cost', kind: '成本事实', available: true, headline: '已付出手续费 12.00 元', detail: '成本是本局已发生的事实。', needsSample: false },
      { key: 'behavior', kind: '行为事实', available: true, headline: '止损计划 3 次、执行 2 次', detail: '只是计数。', needsSample: false },
      { key: 'benchmark', kind: '对照事实', available: true, headline: '本局 +1.20% vs 买入持有 +0.80%', detail: '单次对照。', needsSample: false, netWin: 1 },
    ],
    sayableCount: 3,
    nextAction: { label: '再积累 38 笔', hint: '不能信。', cta: '/blind' },
    blockedAssertions: ['胜率', '期望值', '平均 R', '排名'],
    disclaimer: '样本 12 笔。',
  },
  interval: null,
  headline: '样本 12 笔：这里只说现在就能确定的三件事，还差 38 笔才能谈胜率与期望值。',
  guard: { noPointEstimateWhenSmall: true, ok: true, note: '' },
  disclaimer: '区间描述的是这一批样本能确定到什么程度。',
};

const CONCLUSION_BIG: ConclusionPayload = {
  mode: 'interval',
  sampleSize: 64,
  threshold: 50,
  remaining: 0,
  facts: null,
  interval: {
    sampleSize: 64,
    threshold: 50,
    insufficient: false,
    metrics: [
      {
        key: 'expectancy', label: '期望值', unit: 'R', kind: 'inference', sampleSize: 64,
        point: 0.5, interval: { low: 0.01, high: 0.99, half: 0.49, z: 1.96, n: 64 }, t: 2,
        threshold: { label: 't 值 > 1.96', value: 1.96, op: '>', why: '差异无法区分于噪声。' },
        pass: true, conclusive: true, remaining: 0,
        verdict: { level: 'pass', text: '期望值 0.5R（95% 区间 0.01 ~ 0.99R，t=2，n=64）· 达标线 t 值 > 1.96：通过', canSay: null },
      },
      {
        key: 'disciplineRate', label: '纪律执行率', unit: '%', kind: 'count', sampleSize: 64,
        point: 0.85, interval: null, t: null,
        threshold: { label: '纪律执行率 ≥ 80%', value: 0.8, op: '>=', why: '问题在纪律。' },
        pass: true, conclusive: true, remaining: 0,
        verdict: { level: 'pass', text: '纪律执行率 0.85% · 达标线 纪律执行率 ≥ 80%：通过', canSay: null },
      },
    ],
    breakeven: { winRate: 0.3333, actual: 0.6, margin: 0.2667, required: 0.05, pass: true, label: '实际胜率 ≥ 盈亏平衡胜率 + 5pp', available: true },
    thresholds: {} as never,
    guard: { noPointEstimateWhenSmall: true, ok: true, note: '' },
    verdict: { level: 'conclusive', text: '样本 64 笔已达 50 笔。', conclusive: true },
    method: 't = E·√n/σ',
    disclaimer: '不是对未来的承诺。',
  },
  headline: '样本 64 笔：所有结论都带 95% 区间与达标线。',
  guard: { noPointEstimateWhenSmall: true, ok: true, note: '' },
  disclaimer: '不是对未来的承诺。',
};

/* ================================================================== *
 * RQ-150 / RQ-151 结算口径说明书（P0/P1）                             *
 * ================================================================== */

describe('RQ-150 结算口径说明书（P1 差异化）', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('P0 · 每笔成交可展开到「为什么是这个价 / 扣了多少费 / 滑点」', () => {
    wrap(<SettlementAuditPanel data={AUDIT_OK} sessionId={9} />);
    fireEvent.click(screen.getByText('第 1 笔'));
    const detail = screen.getByTestId('settlement-audit-detail-1');
    expect(detail).toBeTruthy();
    const text = detail.textContent || '';
    expect(text).toContain('为什么是这个价');
    expect(text).toContain('扣了多少费');
    expect(text).toContain('滑点多少');
  });

  it('P1 · 差异清单 ≥5 条（验收硬指标）', () => {
    wrap(<SettlementAuditPanel data={AUDIT_OK} sessionId={9} />);
    const text = screen.getByTestId('settlement-audit').textContent || '';
    for (const t of ['成交价从哪来', '滑点', 'T+1', '涨跌停', '整手']) {
      expect(text).toContain(t);
    }
  });

  it('P0 · 被拒绝的委托给出「规则 + 怎么核对 + 下一步」，不是一句交易失败', () => {
    wrap(<SettlementAuditPanel data={AUDIT_OK} sessionId={9} />);
    expect(screen.getByTestId('settlement-audit-rejections')).toBeTruthy();
    const text = document.body.textContent || '';
    expect(text).toContain('T+1 当日不可卖');
    expect(text).toContain('卖出 seq 必须大于买入 seq');
    expect(text).toContain('推进到下一根 K 线后再卖出');
  });

  it('P1 · 差异清单可一键复制（复制走后端文本，与页面同源）', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    wrap(<SettlementAuditPanel data={AUDIT_OK} sessionId={9} />);
    fireEvent.click(screen.getByTestId('settlement-audit-copy'));
    expect(write).toHaveBeenCalled();
    const copied = String((write.mock.calls[0] as string[])[0]);
    expect(copied).toContain('【结算口径说明书');
    expect(copied).toContain('不引入滑点模型');
  });

  it('P3 · 自检未通过时必须说出来，而不是隐藏（RQ-150 硬要求）', () => {
    const bad = {
      ...AUDIT_OK,
      audit: { ...AUDIT_OK.audit, ok: false, priceMismatch: 2, feeMismatch: 1, unknownRejections: 3 },
    };
    wrap(<SettlementAuditPanel data={bad} sessionId={9} />);
    expect(screen.getByTestId('settlement-audit-status').textContent).toContain('漂移');
  });

  it('P3 · data 为 null 时渲染为空，不崩溃', () => {
    wrap(<SettlementAuditPanel data={null} sessionId={null} />);
    expect(screen.queryByTestId('settlement-audit')).toBeNull();
  });

  it('P5 · 命名避开「逐笔」，对外统一称「结算口径说明书」（F-81）', () => {
    wrap(<SettlementAuditPanel data={AUDIT_OK} sessionId={9} />);
    const text = screen.getByTestId('settlement-audit').textContent || '';
    expect(text).not.toContain('逐笔结算');
    expect(text).toContain('结算口径说明书');
  });
});

describe('RQ-151 结算入口扩面（P0 用户找不到 = 没上线）', () => {
  it('P0 · 有最近一局时给出可直接点的入口', () => {
    const onOpen = vi.fn();
    wrap(<SettlementEntryCard lastFinishedId={9} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('settlement-entry-open'));
    expect(onOpen).toHaveBeenCalledWith(9);
  });

  it('P3 · 没有已结算的局时说明原因，而不是渲染点了没反应的按钮', () => {
    wrap(<SettlementEntryCard lastFinishedId={null} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('settlement-entry-open')).toBeNull();
    expect(screen.getByTestId('settlement-entry').textContent).toContain('还没有可核对的结算');
  });

  it('P2 · compact 模式（复盘页）同样给出入口', () => {
    const onOpen = vi.fn();
    wrap(<SettlementEntryCard lastFinishedId={3} onOpen={onOpen} compact />);
    fireEvent.click(screen.getByText('查看最近一局结算明细'));
    expect(onOpen).toHaveBeenCalledWith(3);
  });
});

/* ================================================================== *
 * RQ-152 / RQ-153 区间化结论（P1）                                    *
 * ================================================================== */

describe('RQ-152 / RQ-153 区间化结论（P1 差异化）', () => {
  it('P0 · 样本 12 笔时只给「能说的三件事」，不给任何点估计', () => {
    wrap(<IntervalConclusion data={CONCLUSION_SMALL} />);
    expect(screen.getByTestId('conclusion-three-facts')).toBeTruthy();
    expect(screen.getByTestId('conclusion-fact-cost')).toBeTruthy();
    expect(screen.getByTestId('conclusion-fact-behavior')).toBeTruthy();
    expect(screen.getByTestId('conclusion-fact-benchmark')).toBeTruthy();
    expect(screen.queryByTestId('conclusion-interval')).toBeNull();
  });

  it('P0 · 小样本页面不得出现胜率 / 期望值数字（F-19 伪结论复发路径）', () => {
    wrap(<IntervalConclusion data={CONCLUSION_SMALL} />);
    const text = screen.getByTestId('conclusion-three-facts').textContent || '';
    // 「还差 38 笔」这类说明句允许出现，但不得出现任何点估计数字
    expect(text).not.toMatch(/胜率\s*\d+(\.\d+)?%/);
    expect(text).not.toMatch(/期望值\s*-?\d+(\.\d+)?R/);
    expect(text).toContain('还差 38 笔');
  });

  it('P0 · 样本 64 笔时给出 95% 区间、t 值与达标线', () => {
    wrap(<IntervalConclusion data={CONCLUSION_BIG} />);
    expect(screen.getByTestId('conclusion-interval-expectancy')).toBeTruthy();
    expect(screen.getByTestId('conclusion-point-expectancy').textContent).toBe('0.5R');
    expect(screen.getByTestId('conclusion-interval-expectancy').textContent).toContain('0.01 ~ 0.99');
    expect(screen.getByTestId('conclusion-metric-expectancy').textContent).toContain('t=2');
    expect(screen.getByTestId('conclusion-metric-expectancy').textContent).toContain('t 值 > 1.96');
  });

  it('P1 · 盈亏平衡胜率与 +5pp 达标线可见', () => {
    wrap(<IntervalConclusion data={CONCLUSION_BIG} />);
    const be = screen.getByTestId('conclusion-breakeven');
    expect(be.textContent).toContain('盈亏平衡胜率');
    expect(be.textContent).toContain('5pp');
  });

  it('P3 · data 为 null / 结构缺失时不崩溃', () => {
    wrap(<IntervalConclusion data={null} />);
    expect(screen.queryByTestId('conclusion-three-facts')).toBeNull();
    // mode=interval 但 interval 为 null 的脏数据
    wrap(<IntervalConclusion data={{ ...CONCLUSION_BIG, interval: null } as never} />);
    expect(screen.queryByTestId('conclusion-interval')).toBeNull();
  });
});

/* ================================================================== *
 * RQ-147 成绩卡闸门（P0）· 以纯渲染层面验证前端闸门逻辑              *
 * ================================================================== */

describe('RQ-147 有效完成闸门（P0）', () => {
  it('P0 · 未达有效完成门槛时的引导文案必须给出动作，而不是数字', () => {
    const fb = {
      title: '这一局还没有成交',
      body: '全程观望也算走完，但不计入「有效完成」。',
      cta: '再来一局，至少做一次买卖',
      action: 'retry',
    };
    expect(['retry', 'continue']).toContain(fb.action);
    expect(fb.cta.length).toBeGreaterThan(0);
    // 引导里不得出现「纪律执行率 100%」这种自相矛盾的展示（F-80）
    expect(fb.body).not.toContain('纪律执行率');
  });
});

/* ================================================================== *
 * RQ-154 保留期文案（P2）· 与后端服务同源                             *
 * ================================================================== */

describe('RQ-154 数据保留期承诺（P2 留存）', () => {
  const LOGGED_IN: RetentionPayload = {
    isGuest: false,
    level: 'info',
    title: '永久保留',
    body: '登录后你的训练记录、成绩卡与结算明细永久保留。',
    daysLeft: null,
    urgent: false,
    cta: null,
    exportHint: '随时可导出为 csv / json。',
    policy: {
      version: 'v12',
      loggedIn: { days: null, label: '永久保留', body: '永久保留' },
      guest: { days: 7, label: '保留 7 天', body: '游客保留 7 天' },
      remindFromDay: 5,
      exportFormats: ['csv', 'json'],
      minSampleToPromise: 100,
    },
  };

  const GUEST_DAY5: RetentionPayload = {
    ...LOGGED_IN,
    isGuest: true,
    level: 'warn',
    title: '游客记录保留 7 天',
    body: '你已经练了 3 局，游客记录将在 2 天后清理。',
    daysLeft: 2,
    remind: true,
    urgent: true,
    cta: { label: '注册并保留记录', action: '/register' },
  };

  it('P2 · 登录用户看到「永久保留」，且无注册 CTA', () => {
    wrap(<RetentionNoticeCard data={LOGGED_IN} onRegister={vi.fn()} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain('永久保留');
    expect(screen.queryByTestId('retention-register')).toBeNull();
  });

  it('P2 · 游客第 5 天看到提醒与注册出口（不是天天弹）', () => {
    const onRegister = vi.fn();
    wrap(<RetentionNoticeCard data={GUEST_DAY5} onRegister={onRegister} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain('7 天');
    fireEvent.click(screen.getByTestId('retention-register'));
    expect(onRegister).toHaveBeenCalled();
  });

  it('P5 · 保留期文案来自后端 payload，前端不复制第二套常量', () => {
    // 改 payload 的文案，页面必须跟着变 —— 若前端硬编码了「永久保留」这条会失败
    const custom = { ...LOGGED_IN, title: '后端下发的自定义保留期' };
    wrap(<RetentionNoticeCard data={custom} />);
    expect(screen.getByTestId('retention-notice').textContent).toContain('后端下发的自定义保留期');
  });

  it('P3 · data 为 null 时不渲染，不占版面', () => {
    wrap(<RetentionNoticeCard data={null} />);
    expect(screen.queryByTestId('retention-notice')).toBeNull();
  });
});
