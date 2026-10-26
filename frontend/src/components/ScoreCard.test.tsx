/**
 * RQ-99 训练成绩卡 —— 前端测试
 *
 * 解决 F-24：训练成绩带不走。成绩卡要能**一键复制为纯文本**，
 * 且数字与体检单同源、不承诺任何实物或现金奖励。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import ScoreCard, { ScoreCardEmpty, copyText } from './ScoreCard';
import type { ScoreCardPayload } from '../types';

const CARD: ScoreCardPayload = {
  title: '训练成绩卡',
  subtitle: '已揭示标的身份',
  lines: [
    '标的：贵州茅台（600519）',
    '片段类型：趋势｜粒度：day',
    '收益率：+3.25%',
    '纪律执行率：83.33%',
    '累计样本：60 笔，当前可信度「行为级」档',
    '距下一档「绩效级」还差 40 笔',
  ],
  text: '【训练成绩卡 · 赚一个小目标】\n标的：贵州茅台（600519）\n片段类型：趋势｜粒度：day\n收益率：+3.25%\n纪律执行率：83.33%\n累计样本：60 笔，当前可信度「行为级」档\n距下一档「绩效级」还差 40 笔\n模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益。',
  copyable: true,
  disclaimer: '模拟训练成绩基于真实历史行情，不构成投资建议，不承诺任何收益。',
  tier: { key: 'behavior', label: '行为级', remaining: 40, nextLabel: '绩效级' },
};

const renderCard = (props: Partial<React.ComponentProps<typeof ScoreCard>> = {}) =>
  render(
    <ConfigProvider>
      <AntApp>
        <ScoreCard data={CARD} {...props} />
      </AntApp>
    </ConfigProvider>
  );

/** 装一个可写的剪贴板桩，用来断言真的复制了 */
function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ===================== P0 · 成绩卡主流程 ===================== */

describe('RQ-99 训练成绩卡（P0）', () => {
  beforeEach(() => stubClipboard());

  it('P0 · 成绩卡展示做了什么 / 纪律执行率 / 样本贡献 / 距下一档', () => {
    renderCard();
    const text = screen.getByTestId('score-card').textContent || '';
    expect(text).toContain('贵州茅台');
    expect(text).toContain('纪律执行率：83.33%');
    expect(text).toContain('累计样本：60 笔');
    expect(text).toContain('还差 40 笔');
  });

  it('P0 · 一键复制把纯文本写进剪贴板', async () => {
    const writeText = stubClipboard();
    const onCopied = vi.fn();
    renderCard({ onCopied });
    fireEvent.click(screen.getByTestId('score-card-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(CARD.text);
    await waitFor(() => expect(onCopied).toHaveBeenCalled());
  });

  it('P0 · 复制成功后按钮给出「已复制」反馈', async () => {
    stubClipboard();
    renderCard();
    fireEvent.click(screen.getByTestId('score-card-copy'));
    await waitFor(() => expect(screen.getByTestId('score-card-copy').textContent).toContain('已复制'));
  });
});

/* ===================== P1 · 档位口径 ===================== */

describe('RQ-99 档位口径（P1）', () => {
  beforeEach(() => stubClipboard());

  it('P1 · 展示当前可信度档位（与体检单同源）', () => {
    renderCard();
    expect(screen.getByTestId('score-card-tier').textContent).toContain('行为级');
  });
});

/* ===================== P3 · 边界与异常 ===================== */

describe('RQ-99 边界与异常（P3）', () => {
  it('P3 · 无数据时渲染空态而不是崩溃', () => {
    render(
      <ConfigProvider>
        <AntApp>
          <ScoreCardEmpty />
        </AntApp>
      </ConfigProvider>
    );
    expect(screen.getByTestId('score-card-empty')).toBeInTheDocument();
  });

  it('P3 · 剪贴板不可用时降级为手动复制提示，不抛错', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderCard();
    expect(() => fireEvent.click(screen.getByTestId('score-card-copy'))).not.toThrow();
  });

  it('P3 · copyText 在无 clipboard 且 execCommand 失败时返回 false', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    // jsdom 没有 execCommand，得先造一个才能验证降级分支
    (document as unknown as { execCommand?: (c: string) => boolean }).execCommand = () => false;
    const ok = await copyText('x');
    expect(ok).toBe(false);
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('P3 · lines 为空数组时仍可渲染（脏数据不崩）', () => {
    render(
      <ConfigProvider>
        <AntApp>
          <ScoreCard data={{ ...CARD, lines: [] }} />
        </AntApp>
      </ConfigProvider>
    );
    expect(screen.getByTestId('score-card')).toBeInTheDocument();
  });
});

/* ===================== P5 · 兼容性与回归 ===================== */

describe('RQ-99 合规回归（P5）', () => {
  beforeEach(() => stubClipboard());

  it('P5 · 成绩卡不承诺任何实物或现金奖励', () => {
    renderCard();
    const text = screen.getByTestId('score-card').textContent || '';
    expect(text).not.toContain('红包');
    expect(text).not.toContain('提现');
    expect(screen.getByTestId('score-card-disclaimer').textContent).toContain('不承诺任何收益');
  });
});
