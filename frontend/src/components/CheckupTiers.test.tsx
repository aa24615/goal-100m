/**
 * RQ-79 可信度分档 / RQ-80 升档进度 / RQ-85 冷启动 / RQ-83 训练处方 —— 前端测试
 *
 * 优先级覆盖：P0 主流程 · P1 差异化 · P3 边界 · P5 向后兼容
 *
 * 说明：CheckupPanel 刻意不持有路由与网络（副作用通过 props 注入），
 * 因此本文件可在无 Router 环境下直接渲染。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import CheckupPanel from './CheckupPanel';
import type { CheckupPayload, MetricHint, CheckupTier, CheckupProgress } from '../types';

const HINT: MetricHint = { label: 'x', meaning: 'm', whenToChange: 'w', formula: 'f' };

function tier(key: string, threshold: number, next: CheckupTier['next']): CheckupTier {
  return {
    key: key as CheckupTier['key'],
    label: key === 'behavior' ? '行为级' : key === 'performance' ? '绩效级' : key === 'strategy' ? '策略级' : '尚无样本',
    short: key,
    threshold,
    canTrust: key === 'none' ? [] : ['能信的事项 A'],
    cannotTrust: key === 'none' ? ['任何胜率、期望值结论'] : ['不能做的事 B'],
    summary: 'summary',
    reachedTop: !next,
    next,
    remaining: next ? next.threshold - threshold : 0,
    progressPercent: 50,
    sufficient: threshold >= 50,
  } as CheckupTier;
}

function progress(over: Partial<CheckupProgress> = {}): CheckupProgress {
  return {
    sampleSize: 75,
    tierKey: 'behavior',
    tierLabel: '行为级',
    nextTierKey: 'performance',
    nextTierLabel: '绩效级',
    nextThreshold: 100,
    remaining: 25,
    percent: 50,
    reachedTop: false,
    text: '还差 25 笔升到「绩效级」档',
    ...over,
  };
}

function mk(over: Partial<CheckupPayload> = {}): CheckupPayload {
  return {
    sampleSize: 75,
    threshold: 50,
    sufficient: true,
    remaining: 0,
    expectancy: {
      amount: 25, r: 0.5, avgWin: 100, avgLoss: 50, winRate: 50, lossRate: 50,
      winCount: 40, lossCount: 35, grossProfit: 600, grossLoss: 300, hint: HINT,
    },
    expectancyR: { value: 0.5, hint: HINT },
    rMultiple: { avgR: 0.5, count: 75, list: [], hint: HINT },
    holdTime: { winHoldDays: 2, lossHoldDays: 9, ratio: 4.5, winCount: 40, lossCount: 35, hint: HINT },
    discipline: { rate: 70, total: 10, recorded: 7, skipped: 3, note: 'n', hint: HINT },
    worstHabit: null,
    verdict: null,
    gate: { sufficient: true, sampleSize: 75, threshold: 50, remaining: 0, message: '已达门槛' },
    rawRounds: [],
    breakdown: { byHold: [], byWeekday: [], bySession: [], bySource: [] },
    ...over,
  };
}

const renderPanel = (data: CheckupPayload | null, props: Record<string, unknown> = {}) =>
  render(
    <ConfigProvider>
      <AntApp>
        <CheckupPanel data={data} {...props} />
      </AntApp>
    </ConfigProvider>
  );

/* ===================== P0 · RQ-79 可信度分档展示 ===================== */

describe('RQ-79 可信度分档（P0）', () => {
  it('P0 · 展示当前档位标签', () => {
    renderPanel(mk({ tier: tier('behavior', 50, { key: 'performance', label: '绩效级', short: '绩效级', threshold: 100 }) }));
    expect(screen.getByTestId('checkup-tier').textContent).toContain('行为级');
  });

  it('P0 · 同时展示「能信什么」与「还不能拿它做什么」', () => {
    renderPanel(mk({ tier: tier('behavior', 50, { key: 'performance', label: '绩效级', short: '绩效级', threshold: 100 }) }));
    const text = screen.getByTestId('checkup-tier').textContent || '';
    expect(text).toContain('能信');
    expect(text).toContain('还不能拿它做');
    expect(text).toContain('能信的事项 A');
    expect(text).toContain('不能做的事 B');
  });

  it('P0 · 60 笔用户绝不能看到「策略级」措辞（验收标准）', () => {
    renderPanel(
      mk({
        sampleSize: 60,
        tier: tier('behavior', 50, { key: 'performance', label: '绩效级', short: '绩效级', threshold: 100 }),
        progress: progress({ sampleSize: 60, remaining: 40, text: '还差 40 笔升到「绩效级」档' }),
      })
    );
    const text = document.body.textContent || '';
    expect(text).not.toContain('策略级');
    expect(text).toContain('行为级');
  });

  it('P0 · 已达顶档时不再提示「还差 N 笔」', () => {
    renderPanel(mk({ tier: tier('strategy', 200, null), progress: progress({ reachedTop: true, remaining: 0, percent: 100 }) }));
    expect(screen.queryByTestId('checkup-progress')).toBeNull();
    expect(screen.getByTestId('checkup-tier').textContent).toContain('已达最高档');
  });
});

/* ===================== P1 · RQ-80 升档进度与达标提示 ===================== */

describe('RQ-80 升档进度与达标提示（P1）', () => {
  it('P1 · 展示「还差 N 笔升到下一档」', () => {
    renderPanel(mk({ progress: progress() }));
    expect(screen.getByTestId('checkup-progress').textContent).toContain('还差 25 笔');
  });

  it('P1 · 达标当日提示可出现', () => {
    renderPanel(
      mk({
        milestone: { justReached: true, tierKey: 'behavior', tierLabel: '行为级', message: '已达成 50 笔', cannot: 'X', dismissible: true },
      })
    );
    expect(screen.getByTestId('checkup-milestone').textContent).toContain('已达成 50 笔');
  });

  it('P1 · 达标提示可关闭，关闭后不再出现', () => {
    renderPanel(
      mk({
        milestone: { justReached: true, tierKey: 'behavior', tierLabel: '行为级', message: '已达成 50 笔', cannot: 'X', dismissible: true },
      })
    );
    const closers = document.querySelectorAll('.ant-alert-close-icon');
    expect(closers.length).toBeGreaterThan(0);
    fireEvent.click(closers[0]);
    expect(screen.queryByTestId('checkup-milestone')).toBeNull();
  });

  it('P1 · 未达标（justReached=false）时不展示提示', () => {
    renderPanel(mk({ milestone: { justReached: false } }));
    expect(screen.queryByTestId('checkup-milestone')).toBeNull();
  });
});

/* ===================== P1 · RQ-85 冷启动 ===================== */

describe('RQ-85 冷启动引导（P1）', () => {
  it('P1 · 0 笔用户看到引导而不是空面板', () => {
    renderPanel(
      mk({
        sampleSize: 0,
        sufficient: false,
        remaining: 50,
        coldStart: {
          isCold: true,
          title: '先做 3 段盲测，体检单就有东西可看了',
          steps: ['进入双盲训练', '写一句话', '回来体检'],
          sessionsTarget: 3,
          action: { label: '去做第一段盲测', path: '/blind' },
          note: 'n',
        },
      })
    );
    const cold = screen.getByTestId('checkup-cold-start');
    expect(cold.textContent).toContain('先做 3 段盲测');
    expect(screen.getByTestId('cold-start-go').textContent).toContain('去做第一段盲测');
  });

  it('P1 · 冷启动按钮点击后触发父页面导航', () => {
    const onStartTraining = vi.fn();
    renderPanel(
      mk({
        sampleSize: 0,
        coldStart: { isCold: true, title: 't', steps: ['s'], action: { label: '去做第一段盲测', path: '/blind' }, note: 'n' },
      }),
      { onStartTraining }
    );
    fireEvent.click(screen.getByTestId('cold-start-go'));
    expect(onStartTraining).toHaveBeenCalledWith('/blind');
  });

  it('P1 · 有样本时不展示冷启动引导', () => {
    renderPanel(mk({ coldStart: { isCold: false } }));
    expect(screen.queryByTestId('checkup-cold-start')).toBeNull();
  });
});

/* ===================== P1 · RQ-83 训练处方入口 ===================== */

describe('RQ-83 训练处方入口（P1）', () => {
  const withHabit = mk({
    worstHabit: { key: 'revenge_trade', label: '亏损后当日再次交易', cost: 1280.5, detail: 'd', alternatives: [], hint: HINT },
  });

  it('P1 · 最坏习惯处出现「就练这个」入口', () => {
    renderPanel(withHabit);
    expect(screen.getByTestId('prescription-start').textContent).toContain('就练这个');
  });

  it('P1 · 点击「就练这个」把当前体检单交给父页面开训', async () => {
    const onStartPrescription = vi.fn().mockResolvedValue(undefined);
    renderPanel(withHabit, { onStartPrescription });
    fireEvent.click(screen.getByTestId('prescription-start'));
    expect(onStartPrescription).toHaveBeenCalledTimes(1);
    const arg = onStartPrescription.mock.calls[0][0] as CheckupPayload;
    expect(arg.worstHabit?.key).toBe('revenge_trade');
  });

  it('P1 · 无最坏习惯时不出现处方按钮', () => {
    renderPanel(mk({ worstHabit: null }));
    expect(screen.queryByTestId('prescription-start')).toBeNull();
  });
});

/* ===================== P3 · 边界与异常 ===================== */

describe('边界与异常（P3）', () => {
  it('P3 · 后端未返回 tier / progress 时降级渲染，不崩溃（向后兼容）', () => {
    expect(() => renderPanel(mk({ tier: undefined, progress: undefined }))).not.toThrow();
    expect(screen.getByTestId('checkup-panel')).toBeTruthy();
  });

  it('P3 · data 为 null 时展示空态', () => {
    renderPanel(null);
    expect(document.body.textContent).toContain('暂无体检数据');
  });

  it('P3 · 缺失 coldStart 字段时不渲染引导', () => {
    renderPanel(mk({ coldStart: undefined }));
    expect(screen.queryByTestId('checkup-cold-start')).toBeNull();
  });

  it('P3 · 分档数据为脏值（空数组）时不产生 undefined 文案', () => {
    renderPanel(mk({ tier: { ...tier('none', 0, null), canTrust: [], cannotTrust: [] } }));
    const text = screen.getByTestId('checkup-tier').textContent || '';
    expect(text).not.toContain('undefined');
    expect(text).toContain('暂时什么都还不能下结论');
  });
});

/* ===================== P5 · 兼容性与回归 ===================== */

describe('兼容性与回归（P5）', () => {
  it('P5 · 旧的「还差 N 笔」gate 文案仍然展示（不因分档改造而消失）', () => {
    renderPanel(
      mk({
        sampleSize: 12,
        sufficient: false,
        remaining: 38,
        gate: { sufficient: false, sampleSize: 12, threshold: 50, remaining: 38, message: '已记录 12 笔，还差 38 笔可生成可信评估。' },
      })
    );
    expect(screen.getByTestId('checkup-gate').textContent).toContain('还差 38 笔');
  });

  it('P5 · 五项决定论指标的 testid 保持不变（回归）', () => {
    renderPanel(mk());
    for (const id of ['metric-expectancy', 'metric-expectancy-r', 'metric-r-multiple', 'metric-hold-ratio', 'metric-discipline']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('P5 · 未注入 onStartPrescription 时点击处方按钮不抛错', () => {
    const withHabit = mk({
      worstHabit: { key: 'fee_drag', label: '手续费', cost: 10, detail: 'd', alternatives: [], hint: HINT },
    });
    expect(() => {
      renderPanel(withHabit);
      fireEvent.click(screen.getByTestId('prescription-start'));
    }).not.toThrow();
  });
});
