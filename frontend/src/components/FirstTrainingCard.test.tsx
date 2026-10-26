/**
 * RQ-92 首访直达训练 —— 前端测试
 *
 * 背景：开始 4 次 → 决策 0 次。首训卡片要解决的不是「教会规则」，
 * 而是**让第一次判断真的发生**：≤3 次点击、≤60 秒、不要求先有持仓或样本。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProvider, App as AntApp } from 'antd';
import FirstTrainingCard from './FirstTrainingCard';

const renderCard = (props: Partial<React.ComponentProps<typeof FirstTrainingCard>> = {}) => {
  const onStart = props.onStart ?? vi.fn();
  return {
    onStart,
    ...render(
      <ConfigProvider>
        <AntApp>
          <FirstTrainingCard onStart={onStart} {...props} />
        </AntApp>
      </ConfigProvider>
    ),
  };
};

/* ===================== P0 · 首训卡片主流程 ===================== */

describe('RQ-92 首训直达（P0）', () => {
  it('P0 · 首屏主 CTA 是「做一次训练」而不是行情浏览', () => {
    renderCard();
    expect(screen.getByTestId('first-training-card')).toBeInTheDocument();
    expect(screen.getByTestId('first-training-start')).toBeInTheDocument();
    expect(screen.getByTestId('first-training-start').textContent).toContain('开始第一次训练');
  });

  it('P0 · 点击主 CTA 触发开训（交给父页面执行副作用）', () => {
    const { onStart } = renderCard();
    fireEvent.click(screen.getByTestId('first-training-start'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('P0 · 明示 ≤60 秒 / ≤3 次点击的目标（这是本期北极星的入场闸口）', () => {
    renderCard();
    expect(screen.getByTestId('first-training-budget').textContent).toContain('60 秒');
    expect(screen.getByTestId('first-training-budget').textContent).toContain('3 次点击');
  });
});

/* ===================== P1 · 引导内容 ===================== */

describe('RQ-92 引导内容（P1）', () => {
  it('P1 · 给出「不需要先有持仓、也不需要先积累样本」的说明', () => {
    renderCard();
    const note = screen.getByTestId('first-training-note').textContent || '';
    expect(note).toContain('不需要先有持仓');
    expect(note).toContain('不需要先积累样本');
  });

  it('P1 · 引导步骤覆盖「抽一段 → 选方向 → 写理由」三步', () => {
    renderCard();
    const items = document.querySelectorAll('ol li');
    expect(items.length).toBeGreaterThanOrEqual(3);
    const text = Array.from(items).map((li) => li.textContent).join('|');
    expect(text).toContain('随机');
    expect(text).toContain('买 / 卖 / 观望');
  });

  it('P1 · 已有进行中训练时主按钮改为「继续上一次训练」', () => {
    renderCard({ hasRunningSession: true });
    expect(screen.getByTestId('first-training-start').textContent).toContain('继续上一次训练');
  });
});

/* ===================== P3 · 边界与异常 ===================== */

describe('RQ-92 边界与异常（P3）', () => {
  it('P3 · 加载中不重复触发开训', () => {
    const { onStart } = renderCard({ loading: true });
    fireEvent.click(screen.getByTestId('first-training-start'));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('P3 · 卡片不出现收益承诺类措辞（合规硬约束）', () => {
    renderCard();
    const text = screen.getByTestId('first-training-card').textContent || '';
    for (const w of ['稳赚', '必涨', '保证收益', '翻倍']) {
      expect(text).not.toContain(w);
    }
  });
});

/* ===================== P5 · 兼容性与回归 ===================== */

describe('RQ-92 手机端（P5）', () => {
  it('P5 · 手机端按钮放大并占满宽度（单手可达）', () => {
    renderCard({ isMobile: true });
    const btn = screen.getByTestId('first-training-start');
    expect(btn.className).toContain('ant-btn-lg');
    expect(btn.className).toContain('ant-btn-block');
  });
});
