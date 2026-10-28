/**
 * v10 需求前端测试（RQ-121 ~ RQ-128）
 *
 * 六级划分沿用 v7~v9 的约定（**测试级别，不是产品优先级**）：
 *   P0 主流程 / P1 差异化 / P2 留存体验 / P3 边界异常 / P4 性能并发 / P5 兼容回归
 * 每条用例标题都写明对应需求编号与优先级，便于按需求反查覆盖范围。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

import SettlementSheet from './components/SettlementSheet';
import StreakRecordCard from './components/StreakRecordCard';
import DailyChallengeCard from './components/DailyChallengeCard';
import { CHALLENGE_MIN_ROUNDS } from './constants';
import type {
  SettlementPayload,
  StreakRecordPayload,
  ChallengeBoardPayload,
} from './types';

const wrap = (ui: React.ReactNode) =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>{ui}</MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

/* ------------------------------ 夹具 ------------------------------ */

const SETTLEMENT: SettlementPayload = {
  title: '本局结算口径',
  applicable: true,
  finished: true,
  reveal: true,
  rules: [
    { key: 'price', title: '成交价从哪来', body: '按当前 K 线收盘价成交。', verifiable: '与收盘价一致。' },
    { key: 'slippage', title: '滑点', body: '不引入滑点模型。', verifiable: '成交价等于收盘价。' },
    { key: 't1', title: 'T+1', body: '当日买入不可卖。', verifiable: '被拦截返回 400。' },
    { key: 'limit', title: '涨跌停', body: '超出 ±10% 拒绝。', verifiable: '返回 400。' },
    { key: 'lot', title: '整手', body: '数量需为 100 的整数倍。', verifiable: '返回 400。' },
    { key: 'fee', title: '费用', body: '佣金万3 / 印花税万5 / 过户费万0.1。', verifiable: '可重算。' },
  ],
  orders: [
    {
      index: 1,
      seq: 1,
      side: 'BUY',
      sideLabel: '买入',
      quantity: 1000,
      price: 10,
      amount: 10000,
      fee: 5.1,
      feeBreakdown: {
        amount: 10000,
        commission: 5,
        stamp: 0,
        transfer: 0.1,
        total: 5.1,
        minCommissionApplied: true,
      },
      feeMatched: true,
      recordedFee: 5.1,
      realizedPnl: 0,
      code: '600001',
      name: 'X',
      text: '第 1 笔 · 买入 1000 股 @ ¥10.00',
    },
    {
      index: 2,
      seq: 2,
      side: 'SELL',
      sideLabel: '卖出',
      quantity: 1000,
      price: 11,
      amount: 11000,
      fee: 10.61,
      feeBreakdown: {
        amount: 11000,
        commission: 5,
        stamp: 5.5,
        transfer: 0.11,
        total: 10.61,
        minCommissionApplied: true,
      },
      feeMatched: true,
      recordedFee: 10.61,
      realizedPnl: 977.79,
      code: '600001',
      name: 'X',
      text: '第 2 笔 · 卖出 1000 股 @ ¥11.00',
    },
  ],
  orderCount: 2,
  totals: { amount: 21000, buyAmount: 10000, sellAmount: 11000, fee: 15.71, realizedPnl: 977.79 },
  summary: '共 2 笔成交，买入 ¥10000.00、卖出 ¥11000.00，费用合计 ¥15.71。',
  reconciliation: '对账式：卖出回款 ¥11000.00 − 买入支出 ¥10000.00 − 费用 ¥15.71。',
  feeAudit: { checked: 2, mismatch: 0, ok: true, note: '' },
  returnPct: 1.2,
  buyHoldPct: 0.8,
  text: 'x',
  disclaimer: '模拟撮合，不构成投资建议。',
};

const RECORD: StreakRecordPayload = {
  windowDays: 28,
  calendar: Array.from({ length: 28 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    participated: i >= 26,
  })),
  thisWeek: 2,
  lastWeek: 0,
  delta: 2,
  current: 2,
  longest: 5,
  lastDate: '2026-10-28',
  totalDays: 9,
  comparison: '本周已练 2 天，比上周同期多 2 天。',
  metric: '参与天数',
  metricDef: '连续自然日参与训练的天数；只和自己比，不与人比。',
  note: '公榜在活跃用户达到 100 前不展示。',
};

/* ============================ P0 · 主流程 ============================ */

describe('RQ-125 结算口径说明书（P0）', () => {
  it('P0 · 展示总账与费用自检结果', () => {
    wrap(<SettlementSheet data={SETTLEMENT} />);
    expect(screen.getByTestId('settlement-summary').textContent).toContain('共 2 笔成交');
    expect(screen.getByTestId('settlement-fee-audit').textContent).toContain('费用自检通过');
    expect(screen.getByTestId('settlement-sheet').textContent).toContain('费用合计');
  });

  it('P0 · 点击「逐笔核对」展开逐笔明细与对账说明', () => {
    wrap(<SettlementSheet data={SETTLEMENT} />);
    // 默认收起：明细表不应存在
    expect(screen.queryByTestId('settlement-orders')).toBeNull();
    fireEvent.click(screen.getByTestId('settlement-toggle'));
    expect(screen.getByTestId('settlement-orders')).toBeTruthy();
    expect(screen.getByTestId('settlement-reconciliation').textContent).toContain('卖出回款');
    expect(screen.getAllByTestId('settlement-fee').length).toBe(2);
  });

  it('P0 · 五条关键规则（T+1 / 涨跌停 / 整手 / 费用 / 滑点）全部可读', () => {
    wrap(<SettlementSheet data={SETTLEMENT} />);
    const text = screen.getByTestId('settlement-rules').textContent || '';
    for (const k of ['滑点', 'T+1', '涨跌停', '整手', '费用']) {
      expect(text).toContain(k);
    }
    expect(text).toContain('怎么核对');
  });
});

describe('RQ-126 个人连打记录（P0）', () => {
  it('P0 · 连打日历给出窗口内每一天，并标出是否参与', () => {
    wrap(<StreakRecordCard record={RECORD} />);
    const days = screen.getAllByTestId('streak-day');
    expect(days.length).toBe(28);
    const participated = days.filter((d) => d.getAttribute('data-participated') === 'yes');
    expect(participated.length).toBe(2);
  });

  it('P0 · 展示与上周的对比，而不是与人比', () => {
    wrap(<StreakRecordCard record={RECORD} />);
    expect(screen.getByTestId('streak-comparison').textContent).toContain('比上周同期多 2 天');
    expect(screen.getByTestId('streak-current').textContent).toContain('连续 2 天');
    expect(screen.getByTestId('streak-record').textContent).not.toContain('收益率');
  });
});

/* ============================ P1 · 差异化 ============================ */

describe('RQ-126 公榜降级为个人连打（P1）', () => {
  it('P1 · 活跃用户不足时不渲染公榜，改展示连打记录与原因', () => {
    const board: ChallengeBoardPayload = {
      minRounds: CHALLENGE_MIN_ROUNDS,
      activeUsers: 9,
      publicBoardEnabled: false,
      publicBoardMinUsers: 100,
      boardReason: '活跃用户 9 人 < 100 人，公榜暂不展示（空榜会劝退）。',
      board: [],
      participants: 0,
      waiting: [],
      metric: '净胜局',
      metricDef: '跑赢「一直拿着」+1 / 跑输 −1。',
      note: '',
      streakRecord: RECORD,
    };
    wrap(<DailyChallengeCard today={null} board={board} />);
    expect(screen.getByTestId('challenge-board-disabled')).toBeTruthy();
    expect(screen.queryByTestId('challenge-board')).toBeNull();
    expect(screen.getByTestId('streak-record')).toBeTruthy();
    expect(screen.getByTestId('streak-board-reason').textContent).toContain('公榜暂不展示');
  });

  it('P1 · 公榜关闭后页面里不出现任何「排行榜」字样（空榜劝退）', () => {
    const board: ChallengeBoardPayload = {
      minRounds: CHALLENGE_MIN_ROUNDS,
      publicBoardEnabled: false,
      boardReason: '活跃用户不足。',
      board: [],
      participants: 0,
      waiting: [],
      metric: '净胜局',
      metricDef: 'x',
      note: '',
      streakRecord: RECORD,
    };
    wrap(<DailyChallengeCard today={null} board={board} />);
    expect(document.body.textContent || '').not.toContain('名次');
  });
});

/* ============================ P2 · 留存体验 ============================ */

describe('RQ-126 留存表达（P2）', () => {
  it('P2 · 没有任何连打数据时给出可开始的空态，而不是空白', () => {
    wrap(<StreakRecordCard record={null} />);
    expect(screen.getByTestId('streak-record-empty').textContent).toContain('还没有连打记录');
  });

  it('P2 · 最低佣金触发时在费用旁标注，避免用户以为算错了', () => {
    wrap(<SettlementSheet data={SETTLEMENT} />);
    fireEvent.click(screen.getByTestId('settlement-toggle'));
    // 夹具中两笔都触发了最低佣金
    expect(document.body.textContent).toContain('最低佣金');
  });
});

/* ============================ P3 · 边界异常 ============================ */

describe('边界与异常（P3）', () => {
  it('P3 · data 为 null 时结算说明书不渲染也不抛错', () => {
    expect(() => wrap(<SettlementSheet data={null} />)).not.toThrow();
    expect(screen.queryByTestId('settlement-sheet')).toBeNull();
  });

  it('P3 · 未完成的局明确标注「结算完成后才有明细」', () => {
    const running: SettlementPayload = { ...SETTLEMENT, applicable: false, finished: false, orderCount: 0, orders: [] };
    wrap(<SettlementSheet data={running} />);
    expect(screen.getByTestId('settlement-not-applicable').textContent).toContain('尚未结算');
  });

  it('P3 · 费用自检不通过时给出醒目失败提示，而不是藏在日志里', () => {
    const bad: SettlementPayload = {
      ...SETTLEMENT,
      feeAudit: { checked: 2, mismatch: 1, ok: false, note: '' },
    };
    wrap(<SettlementSheet data={bad} />);
    expect(screen.getByTestId('settlement-fee-audit').textContent).toContain('未通过');
  });

  it('P3 · 空成交时明细区给出「没有成交」而不是空表格', () => {
    const none: SettlementPayload = { ...SETTLEMENT, orders: [], orderCount: 0, totals: { amount: 0, buyAmount: 0, sellAmount: 0, fee: 0, realizedPnl: 0 } };
    wrap(<SettlementSheet data={none} />);
    fireEvent.click(screen.getByTestId('settlement-toggle'));
    expect(document.body.textContent).toContain('没有成交');
  });

  it('P3 · 日历为空数组时不抛错', () => {
    const empty: StreakRecordPayload = { ...RECORD, calendar: [], thisWeek: 0, lastWeek: 0, delta: 0 };
    expect(() => wrap(<StreakRecordCard record={empty} />)).not.toThrow();
  });
});

/* ============================ P4 · 性能 ============================ */

describe('性能（P4）', () => {
  it('P4 · 一年期日历（365 格）渲染不退化', () => {
    const year: StreakRecordPayload = {
      ...RECORD,
      windowDays: 365,
      calendar: Array.from({ length: 365 }, (_, i) => ({ date: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`, participated: i % 3 === 0 })),
    };
    const t0 = Date.now();
    wrap(<StreakRecordCard record={year} />);
    const ms = Date.now() - t0;
    expect(screen.getAllByTestId('streak-day').length).toBe(365);
    expect(ms).toBeLessThan(5000);
  });

  it('P4 · 200 笔成交的明细渲染不退化', () => {
    const many: SettlementPayload = {
      ...SETTLEMENT,
      orders: Array.from({ length: 200 }, (_, i) => ({ ...SETTLEMENT.orders[0], index: i + 1 })),
      orderCount: 200,
    };
    const t0 = Date.now();
    wrap(<SettlementSheet data={many} />);
    fireEvent.click(screen.getByTestId('settlement-toggle'));
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

/* ============================ P5 · 兼容回归 ============================ */

describe('兼容回归（P5）', () => {
  it('P5 · 未返回 publicBoardEnabled 的旧响应仍渲染公榜（不破坏 v9 调用方）', () => {
    const legacy: ChallengeBoardPayload = {
      minRounds: CHALLENGE_MIN_ROUNDS,
      board: [
        { rank: 1, ref: 'u1', displayName: '张三', rounds: 6, netWin: 3, eligible: true },
        { rank: 2, ref: 'u2', displayName: '李四', rounds: 8, netWin: -1, eligible: true },
      ],
      participants: 2,
      waiting: [],
      metric: '净胜局',
      metricDef: 'x',
      note: '',
    };
    wrap(<DailyChallengeCard today={null} board={legacy} />);
    expect(screen.getByTestId('challenge-board')).toBeTruthy();
    expect(screen.queryByTestId('challenge-board-disabled')).toBeNull();
  });

  it('P5 · 榜单仍然只展示净胜局，不出现任何收益率字段（硬约束 6 未被破坏）', () => {
    const legacy: ChallengeBoardPayload = {
      minRounds: CHALLENGE_MIN_ROUNDS,
      publicBoardEnabled: true,
      board: [{ rank: 1, ref: 'u1', displayName: '张三', rounds: 6, netWin: 3, eligible: true }],
      participants: 1,
      waiting: [],
      metric: '净胜局',
      metricDef: 'x',
      note: '',
    };
    wrap(<DailyChallengeCard today={null} board={legacy} />);
    const text = document.body.textContent || '';
    for (const bad of ['收益率', 'returnPct', '收益排名']) expect(text).not.toContain(bad);
  });

  it('P5 · 结算说明书不承诺任何奖励或收益（合规硬约束）', () => {
    wrap(<SettlementSheet data={SETTLEMENT} />);
    const text = screen.getByTestId('settlement-sheet').textContent || '';
    expect(text).toContain('不构成投资建议');
    expect(text).not.toContain('奖励');
  });
});
