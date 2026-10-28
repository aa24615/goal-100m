/**
 * v9 增长需求前端测试（RQ-106 ~ RQ-118）
 *
 * 测试级别沿用 v7/v8 的六级划分（**测试级别，不是产品优先级**）：
 *   P0 主流程 / P1 差异化 / P2 留存体验 / P3 边界异常 / P4 性能并发 / P5 兼容回归
 *
 * 每条用例标题都写明对应的需求编号与优先级，便于按需求反查覆盖情况。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

import SmallSampleFacts from './components/SmallSampleFacts';
import DailyChallengeCard from './components/DailyChallengeCard';
import TierProgressCard from './components/TierProgressCard';
import ArchivedNotice from './components/ArchivedNotice';
import FirstTrainingCard from './components/FirstTrainingCard';
import Scenarios from './pages/Scenarios';
import Rooms from './pages/Rooms';
import {
  COMPLETION,
  FIRST_TRAINING,
  DEFAULT_BARS,
  MAX_DEFAULT_BARS,
  GUIDE_EVENTS,
  CHALLENGE_MIN_ROUNDS,
} from './constants';
import type { SmallSamplePayload, ChallengeBoardPayload, TierProgressPayload } from './types';

const wrap = (ui: React.ReactNode) =>
  render(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>{ui}</MemoryRouter>
      </AntApp>
    </ConfigProvider>
  );

/* ================================================================== *
 * RQ-109 统一「完成」口径（P0 ★）                                     *
 * ================================================================== */

describe('RQ-109 完成口径统一（P0）', () => {
  it('P0 · 引导卡片展示的完成口径与后端契约一致', () => {
    wrap(<FirstTrainingCard onStart={() => {}} />);
    const el = screen.getByTestId('first-training-completion');
    expect(el.textContent).toContain(COMPLETION.definition);
    expect(el.textContent).toContain('成绩卡');
  });

  it('P0 · 引导步骤里不再出现「提交判断就完成」的旧口径（F-32）', () => {
    wrap(<FirstTrainingCard onStart={() => {}} />);
    const text = document.body.textContent || '';
    for (const bad of COMPLETION.forbidden) expect(text).not.toContain(bad);
    // 步骤三必须落到「结算出成绩卡」
    expect(FIRST_TRAINING.steps[2]).toContain('成绩卡');
  });

  it('P3 · 不传 onEnter 时组件不抛错（埋点由父页面可选注入）', () => {
    expect(() => wrap(<FirstTrainingCard onStart={() => {}} />)).not.toThrow();
  });

  it('P1 · 传入 onEnter 时在挂载时上报「进入」这一步（引导四步的第一步）', () => {
    const onEnter = vi.fn();
    wrap(<FirstTrainingCard onStart={() => {}} onEnter={onEnter} />);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== *
 * RQ-107 短局化（P0 ★）                                               *
 * ================================================================== */

describe('RQ-107 首训短局化（P0）', () => {
  it('P0 · 常量层保证默认一局 ≤15 根', () => {
    expect(DEFAULT_BARS).toBeLessThanOrEqual(MAX_DEFAULT_BARS);
  });

  it('P0 · 引导卡片展示默认档位描述（用户开训前就知道这一局多长）', () => {
    wrap(<FirstTrainingCard onStart={() => {}} presetLabel="默认快局：12 根 K 线，1–2 次判断" />);
    expect(screen.getByTestId('first-training-preset').textContent).toContain('12 根');
  });
});

/* ================================================================== *
 * RQ-111 小样本「能说的三件事」（P0 ★）                                *
 * ================================================================== */

const SMALL: SmallSamplePayload = {
  sampleSize: 2,
  smallSample: true,
  threshold: 30,
  facts: [
    { key: 'cost', kind: '成本事实', available: true, headline: '已付出手续费 12.00 元', detail: '本局已发生的事实。', needsSample: false },
    { key: 'behavior', kind: '行为事实', available: true, headline: '止损计划 3 次、执行 2 次（66.7%）', detail: '只是计数，不是推断。', needsSample: false },
    { key: 'benchmark', kind: '对照事实', available: true, headline: '本局 +1.20% vs 买入持有 +0.80%', detail: '单次对照。', needsSample: false, netWin: 1 },
  ],
  sayableCount: 3,
  nextAction: { label: '再积累 28 笔，胜率与期望值才可读', hint: '不是算不出来，是算出来也不能信。', cta: '/blind' },
  blockedAssertions: ['胜率', '期望值', '排名'],
  disclaimer: '样本 2 笔：成本、行为与对照三类事实不需要样本即可确认。',
};

describe('RQ-111 小样本能说的三件事（P0）', () => {
  it('P0 · 2 笔样本也渲染出三条事实（页面不再空白）', () => {
    wrap(<SmallSampleFacts data={SMALL} />);
    expect(screen.getByTestId('small-sample-fact-cost').textContent).toContain('手续费');
    expect(screen.getByTestId('small-sample-fact-behavior').textContent).toContain('止损');
    expect(screen.getByTestId('small-sample-fact-benchmark').textContent).toContain('买入持有');
  });

  it('P0 · 给出下一步动作与跳转出口', () => {
    const onAction = vi.fn();
    wrap(<SmallSampleFacts data={SMALL} onAction={onAction} />);
    fireEvent.click(screen.getByTestId('small-sample-action-cta'));
    expect(onAction).toHaveBeenCalledWith('/blind');
  });

  it('P1 · 小样本时显式列出被拦住的断言（避免用户以为是为 0）', () => {
    wrap(<SmallSampleFacts data={SMALL} />);
    const blocked = screen.getByTestId('small-sample-blocked').textContent || '';
    expect(blocked).toContain('胜率');
    expect(blocked).toContain('期望值');
  });

  it('P3 · 数据为 null 时不渲染且不抛错', () => {
    const { container } = wrap(<SmallSampleFacts data={null} />);
    expect(container.querySelector('[data-testid="small-sample-facts"]')).toBeNull();
  });

  it('P3 · 事实全部不可用时仍渲染骨架，不白屏', () => {
    const empty: SmallSamplePayload = { ...SMALL, facts: SMALL.facts.map((f) => ({ ...f, available: false })), sayableCount: 0 };
    wrap(<SmallSampleFacts data={empty} />);
    expect(screen.getByTestId('small-sample-facts')).toBeInTheDocument();
  });

  it('P5 · 页面上不出现任何 edge 类断言（胜率 / 期望值 / 排名作为结论）', () => {
    wrap(<SmallSampleFacts data={SMALL} />);
    const shown = document.body.textContent || '';
    // 免责与「暂不展示」清单里出现这些词是合规要求的否定式表达，单独排除
    const withoutGuard = shown.split('暂不展示')[0];
    expect(withoutGuard).not.toContain('胜率 60');
    expect(withoutGuard).not.toContain('期望值 0.3');
  });
});

/* ================================================================== *
 * RQ-113 每日一题 · 连打 · 净胜局榜（P1）                             *
 * ================================================================== */

const BOARD: ChallengeBoardPayload = {
  minRounds: CHALLENGE_MIN_ROUNDS,
  board: [
    { rank: 1, ref: 'u1', displayName: '张三', rounds: 6, netWin: 3, eligible: true },
    { rank: 2, ref: 'u2', displayName: '李四', rounds: 8, netWin: -1, eligible: true },
  ],
  participants: 2,
  waiting: [{ displayName: '王五', rounds: 2, remaining: 3 }],
  metric: '净胜局',
  metricDef: '跑赢「一直拿着」+1 / 跑输 −1，累加；不看绝对收益。',
  note: '',
  streak: { current: 3, longest: 5, days: ['2026-10-26', '2026-10-27', '2026-10-28'], lastDate: '2026-10-28' },
};

describe('RQ-113 每日一题与净胜局榜（P1）', () => {
  it('P1 · 展示连打天数与上榜门槛', () => {
    wrap(<DailyChallengeCard today={null} board={BOARD} />);
    expect(screen.getByTestId('daily-challenge').textContent).toContain('连打');
    expect(document.body.textContent).toContain(String(CHALLENGE_MIN_ROUNDS));
  });

  it('P1 · 榜单只显示净胜局，页面不出现任何收益率字段（硬约束 6）', () => {
    wrap(<DailyChallengeCard today={null} board={BOARD} />);
    const text = document.body.textContent || '';
    for (const bad of ['收益率', 'returnPct', '收益排名']) expect(text).not.toContain(bad);
    expect(screen.getAllByTestId('challenge-netwin').length).toBe(2);
  });

  it('P1 · 未打满门槛的人看到「还差几局上榜」（护栏改为牵引）', () => {
    wrap(<DailyChallengeCard today={null} board={BOARD} />);
    expect(screen.getByTestId('challenge-waiting').textContent).toContain('再打 3 局上榜');
  });

  it('P3 · 空榜单给出「还没有人打满」的说明，而不是把空表当成故障', () => {
    const empty: ChallengeBoardPayload = { ...BOARD, board: [], participants: 0, waiting: [] };
    wrap(<DailyChallengeCard today={null} board={empty} />);
    expect(screen.getByTestId('challenge-board-empty').textContent).toContain('还没有人打满');
  });

  it('P3 · today 与 board 都为 null 时不抛错', () => {
    expect(() => wrap(<DailyChallengeCard today={null} board={null} />)).not.toThrow();
  });

  it('P1 · 点击「做今日这一题」触发父页面开训', () => {
    const onJoin = vi.fn();
    wrap(<DailyChallengeCard today={null} board={BOARD} onJoin={onJoin} />);
    fireEvent.click(screen.getByTestId('challenge-join'));
    expect(onJoin).toHaveBeenCalled();
  });
});

/* ================================================================== *
 * RQ-116 零使用功能下线（P1）                                         *
 * ================================================================== */

describe('RQ-116 零使用功能下线（P1）', () => {
  it('P1 · 归档页显式标注「已归档」并给出替代入口', () => {
    wrap(<ArchivedNotice label="剧本训练场" />);
    expect(screen.getByTestId('archived-notice').textContent).toContain('已归档');
    expect(screen.getByTestId('archived-replacement')).toBeInTheDocument();
    expect(screen.getByTestId('archived-reason').textContent).toBeTruthy();
  });

  it('P1 · /scenarios 页面渲染归档说明而不是空列表', () => {
    wrap(<Scenarios />);
    expect(screen.getByTestId('archived-notice').textContent).toContain('剧本训练场');
  });

  it('P1 · /rooms 页面渲染归档说明而不是空列表', () => {
    wrap(<Rooms />);
    expect(screen.getByTestId('archived-notice').textContent).toContain('房间赛');
  });

  it('P3 · 无替代入口时不渲染跳转按钮', () => {
    wrap(<ArchivedNotice label="房间赛" replacement={null} />);
    expect(screen.queryByTestId('archived-replacement')).toBeNull();
  });
});

/* ================================================================== *
 * RQ-117 距下一档还差 N 笔（P2）                                      *
 * ================================================================== */

const TIER: TierProgressPayload = {
  sampleSize: 12,
  finishedRounds: 2,
  tier: { key: 'none', label: '尚无样本', threshold: 0 },
  next: { key: 'behavior', label: '行为级', threshold: 50 },
  remainingToNext: 38,
  reachedTop: false,
  gates: [
    { key: 'ratio', label: '比率类指标（胜率 / 期望值）', threshold: 30, current: 12, remaining: 18, reached: false },
    { key: 'tier', label: '可信度升到「行为级」档', threshold: 50, current: 12, remaining: 38, reached: false },
  ],
  notices: [],
  progressPct: 24,
  message: '当前 12 笔（尚无样本档），距下一档「行为级」还差 38 笔。',
  note: '护栏从「拦截」改为「牵引」。',
};

describe('RQ-117 达标进度与「还差 N 笔」（P2）', () => {
  it('P2 · 未达标时显示还差多少笔', () => {
    wrap(<TierProgressCard data={TIER} />);
    expect(screen.getByTestId('tier-message').textContent).toContain('还差 38 笔');
    expect(screen.getByTestId('tier-gate-ratio').textContent).toContain('还差 18 笔');
  });

  it('P2 · 达标提示可关闭并把 key 回传给父页面', () => {
    const withNotice: TierProgressPayload = {
      ...TIER,
      notices: [{ key: 'tier:ratio:30', kind: 'tier', title: '已跨过 30 笔', body: '比率类指标可读', cannot: '不承诺任何收益或奖励。', once: true, dismissible: true }],
    };
    const onDismiss = vi.fn();
    wrap(<TierProgressCard data={withNotice} onDismiss={onDismiss} />);
    expect(screen.getByTestId('tier-notice-tier')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.ant-alert-close-icon')!);
    expect(onDismiss).toHaveBeenCalledWith('tier:ratio:30');
  });

  it('P3 · 数据为 null 时不渲染', () => {
    const { container } = wrap(<TierProgressCard data={null} />);
    expect(container.querySelector('[data-testid="tier-progress"]')).toBeNull();
  });

  it('P3 · 已达顶档时不出现「还差 N 笔」的误导文案', () => {
    const top: TierProgressPayload = {
      ...TIER,
      reachedTop: true,
      next: null,
      remainingToNext: 0,
      message: '已达最高档「策略级」，无需再凑样本。',
      gates: [{ key: 'ratio', label: '比率类指标', threshold: 30, current: 300, remaining: 0, reached: true }],
    };
    wrap(<TierProgressCard data={top} />);
    expect(screen.getByTestId('tier-message').textContent).not.toContain('还差');
  });
});

/* ================================================================== *
 * P5 · 兼容性与回归（跨需求）                                         *
 * ================================================================== */

describe('v9 兼容性与回归（P5）', () => {
  it('P5 · 引导四步埋点事件名与后端 GUIDE_EVENTS 顺序一致', () => {
    expect(GUIDE_EVENTS.enter).toBe('first_training_enter');
    expect(GUIDE_EVENTS.start).toBe('first_training_start');
    expect(GUIDE_EVENTS.decision).toBe('first_training_decision');
    expect(GUIDE_EVENTS.finish).toBe('first_training_finish');
  });

  it('P5 · 所有 v9 组件均不出现收益承诺类措辞（合规硬约束）', () => {
    wrap(
      <>
        <SmallSampleFacts data={SMALL} />
        <DailyChallengeCard today={null} board={BOARD} />
        <TierProgressCard data={TIER} />
      </>
    );
    const text = document.body.textContent || '';
    for (const bad of ['稳赚', '必涨', '保证收益', '翻倍', '现金奖励', '红包']) {
      expect(text).not.toContain(bad);
    }
  });

  it('P5 · 完成口径常量保持单一定义（三处共用，不出现第二套）', () => {
    expect(COMPLETION.definition).toBe('完成 = 结算并出成绩卡');
    expect(COMPLETION.status).toBe('FINISHED');
  });
});
