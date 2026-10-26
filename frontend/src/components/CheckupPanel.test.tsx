/**
 * RQ-76 / RQ-77 / RQ-78 交易体检单 —— 前端测试
 *
 * 最关键的一条：样本 < 50 笔时页面**不得出现任何评级 / 结论性标签**（RQ-77）。
 * 空面板正是该功能的价值，测试必须守住这条底线。
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import CheckupPanel from './CheckupPanel';
import type { CheckupPayload, MetricHint } from '../types';

const HINT: MetricHint = { label: 'x', meaning: 'm', whenToChange: 'w', formula: 'f' };

/**
 * 构造体检单。
 * ratioGate 由 sampleSize 推导（与后端同源）：<30 笔时比率类指标整块不渲染（RQ-95），
 * 因此**需要验证指标渲染的用例必须显式给一个 ≥30 笔的样本**。
 */
function mk(over: Partial<CheckupPayload> = {}): CheckupPayload {
  const sampleSize = over.sampleSize ?? 12;
  const sufficient = over.sufficient ?? sampleSize >= 50;
  const remaining = over.remaining ?? Math.max(0, 50 - sampleSize);
  const showRatios = sampleSize >= 30;
  return {
    sampleSize,
    threshold: 50,
    sufficient,
    remaining,
    ratioGate: {
      threshold: 30,
      sampleSize,
      showRatios,
      showRanking: showRatios,
      showStrategyLanguage: sampleSize >= 200,
      remaining: Math.max(0, 30 - sampleSize),
      action: showRatios ? null : { label: '继续积累样本', path: '/blind' },
      reason: showRatios
        ? `样本 ${sampleSize} 笔已达 30 笔护栏。`
        : `样本仅 ${sampleSize} 笔，未达 30 笔护栏：胜率 / 期望值（R）/ 平均 R 与排名暂不展示。`,
    },
    expectancy: {
      amount: 25,
      r: 0.5,
      avgWin: 100,
      avgLoss: 50,
      winRate: 50,
      lossRate: 50,
      winCount: 6,
      lossCount: 6,
      grossProfit: 600,
      grossLoss: 300,
      hint: HINT,
    },
    expectancyR: { value: 0.5, hint: HINT },
    rMultiple: { avgR: 0.5, count: 12, list: [], hint: HINT },
    holdTime: { winHoldDays: 2, lossHoldDays: 9, ratio: 4.5, winCount: 6, lossCount: 6, hint: HINT },
    discipline: { rate: null, total: 0, recorded: 0, skipped: 0, note: '尚无决策记录，指标未生成', hint: HINT },
    worstHabit: null,
    verdict: null,
    gate: {
      sufficient,
      sampleSize,
      threshold: 50,
      remaining,
      message:
        sufficient
          ? `已达到 50 笔可信样本门槛（当前 ${sampleSize} 笔）。`
          : `已记录 ${sampleSize} 笔，还差 ${remaining} 笔可生成可信评估。`,
    },
    rawRounds: [],
    breakdown: { byHold: [], byWeekday: [], bySession: [], bySource: [] },
    ...over,
  };
}

const renderPanel = (data: CheckupPayload | null) =>
  render(
    <ConfigProvider>
      <AntApp>
        <CheckupPanel data={data} />
      </AntApp>
    </ConfigProvider>
  );

describe('RQ-77 样本门槛（P0）', () => {
  it('P0 · 样本不足时展示「还差 N 笔」并说明为何不给结论', () => {
    renderPanel(mk());
    expect(screen.getByTestId('checkup-gate').textContent).toContain('还差 38 笔');
    expect(screen.getByText(/样本不足时不给结论/)).toBeInTheDocument();
  });

  it('P0 · 样本不足时不渲染任何结论（verdict 区块不存在）', () => {
    renderPanel(mk());
    expect(screen.queryByTestId('checkup-verdict')).toBeNull();
  });

  it('P0 · 样本不足时也不渲染评级/标签：页面不含「你的风格」类措辞', () => {
    renderPanel(mk());
    const text = document.body.textContent || '';
    expect(text).not.toContain('你的风格');
    expect(text).not.toContain('激进');
    expect(text).not.toContain('评级');
  });

  it('P0 · 样本不足时展示原始成交流水而非结论', () => {
    renderPanel(
      mk({
        rawRounds: [
          { sellId: 1, code: '600000', quantity: 100, sellPrice: 11, realizedPnl: 120, holdDays: 3 },
          { sellId: 2, code: '600001', quantity: 200, sellPrice: 9, realizedPnl: -80, holdDays: 7 },
        ],
      })
    );
    expect(screen.getByText('600000')).toBeInTheDocument();
    expect(screen.getByText('600001')).toBeInTheDocument();
  });

  it('P0 · 达标后输出结论并带免责声明', () => {
    renderPanel(
      mk({
        sampleSize: 60,
        sufficient: true,
        remaining: 0,
        verdict: {
          hasEdge: true,
          grade: 'positive',
          summary: '60 笔样本下每笔期望 ¥25（0.5R），策略具备可执行前提。',
          disclaimer: '以上结论基于模拟交易行为统计，不构成投资建议，不承诺任何收益。',
        },
        gate: { sufficient: true, sampleSize: 60, threshold: 50, remaining: 0, message: '已达到 50 笔可信样本门槛。' },
      })
    );
    expect(screen.getByTestId('checkup-verdict').textContent).toContain('不构成投资建议');
    expect(screen.queryByText(/样本不足时不给结论/)).toBeNull();
  });

  it('P3 · 边界：49 笔仍不达标、50 笔达标', () => {
    renderPanel(mk({ sampleSize: 49, remaining: 1, sufficient: false }));
    expect(screen.queryByTestId('checkup-verdict')).toBeNull();
    renderPanel(
      mk({
        sampleSize: 50,
        sufficient: true,
        remaining: 0,
        verdict: { hasEdge: false, grade: 'negative', summary: '负期望', disclaimer: 'd' },
        gate: { sufficient: true, sampleSize: 50, threshold: 50, remaining: 0, message: 'ok' },
      })
    );
    expect(screen.getByTestId('checkup-verdict')).toBeInTheDocument();
  });

  it('P4 · data 为 null 时展示空态，不崩溃', () => {
    renderPanel(null);
    expect(screen.queryByTestId('checkup-gate')).toBeNull();
  });
});

describe('RQ-76 五项决定论指标（P0）', () => {
  it('P0 · 期望值 / 期望值R / R 倍数 / 持仓比 / 纪律执行率 全部渲染', () => {
    // 比率类指标需样本 ≥30 笔才展示（RQ-95），故这里显式给 75 笔
    renderPanel(mk({ sampleSize: 75, sufficient: true, remaining: 0 }));
    expect(screen.getByTestId('metric-expectancy')).toBeInTheDocument();
    expect(screen.getByTestId('metric-expectancy-r')).toBeInTheDocument();
    expect(screen.getByTestId('metric-r-multiple')).toBeInTheDocument();
    expect(screen.getByTestId('metric-hold-ratio')).toBeInTheDocument();
    expect(screen.getByTestId('metric-discipline')).toBeInTheDocument();
  });

  it('P0 · 无决策记录时纪律执行率显示「—」而不是 0%', () => {
    renderPanel(mk());
    expect(screen.getByTestId('metric-discipline').textContent).toContain('—');
    expect(screen.getByText(/先去双盲训练记录几次判断/)).toBeInTheDocument();
  });

  it('P0 · 有决策记录时展示百分比', () => {
    renderPanel(
      mk({
        discipline: { rate: 75, total: 8, recorded: 6, skipped: 2, note: '口径', hint: HINT },
      })
    );
    expect(screen.getByTestId('metric-discipline').textContent).toContain('75');
  });

  it('P0 · 最坏习惯以金额呈现，并给出改进行动指向', () => {
    renderPanel(
      mk({
        worstHabit: {
          key: 'fee_drag',
          label: '过度交易产生的手续费',
          cost: 1280.5,
          detail: '手续费累计较高。',
          alternatives: [],
          hint: HINT,
        },
      })
    );
    expect(screen.getByTestId('worst-habit').textContent).toContain('过度交易产生的手续费');
    expect(screen.getByTestId('worst-habit').textContent).toContain('1,280.50');
  });

  it('P3 · 全部盈利（R 无定义）时展示「—」而不是 Infinity', () => {
    renderPanel(
      mk({
        sampleSize: 75,
        sufficient: true,
        remaining: 0,
        expectancyR: { value: null, hint: HINT },
        rMultiple: { avgR: null, count: 0, list: [], hint: HINT },
      })
    );
    expect(screen.getByTestId('metric-expectancy-r').textContent).toContain('—');
    expect(document.body.textContent).not.toContain('Infinity');
  });

  it('P3 · 零样本时不出现 NaN', () => {
    renderPanel(
      mk({ sampleSize: 0, remaining: 50, expectancy: { ...mk().expectancy, amount: 0, r: null } })
    );
    expect(document.body.textContent).not.toContain('NaN');
  });
});

describe('RQ-78 拆解与口径提示（P1）', () => {
  it('P1 · 达标后展示四组拆解（持仓时长 / 时段 / 星期 / 来源）', () => {
    renderPanel(
      mk({
        sampleSize: 60,
        sufficient: true,
        remaining: 0,
        verdict: { hasEdge: true, grade: 'positive', summary: 's', disclaimer: 'd' },
        gate: { sufficient: true, sampleSize: 60, threshold: 50, remaining: 0, message: 'ok' },
        breakdown: {
          byHold: [{ key: 'd1', label: '1 日以内', count: 3, pnl: 120, sellIds: [1, 2, 3] }],
          bySession: [{ key: 'morning', label: '早盘 09-12', count: 2, pnl: 80, sellIds: [1] }],
          byWeekday: [{ key: '1', label: '周一', count: 1, pnl: 40, sellIds: [1] }],
          bySource: [{ key: 'REAL', label: '实时模拟账户', count: 3, pnl: 120, sellIds: [1] }],
        },
      })
    );
    expect(screen.getByText('按持仓时长')).toBeInTheDocument();
    expect(screen.getByText('按交易时段')).toBeInTheDocument();
    expect(screen.getByText('按星期')).toBeInTheDocument();
    expect(screen.getByText('按来源')).toBeInTheDocument();
    // 每条分组可回溯到原始成交行
    expect(screen.getByText('1 日以内')).toBeInTheDocument();
  });

  it('P1 · 每项指标都带口径说明 tooltip（说明什么 / 何时该改）', () => {
    renderPanel(mk({ sampleSize: 75, sufficient: true, remaining: 0 }));
    const panel = screen.getByTestId('checkup-panel');
    // 5 项指标各一个提示图标
    expect(panel.querySelectorAll('.anticon-info-circle').length).toBeGreaterThanOrEqual(5);
  });

  it('P1 · 未达标时不展示拆解表（避免用少量样本误导）', () => {
    renderPanel(mk());
    expect(screen.queryByText('按持仓时长')).toBeNull();
  });
});
