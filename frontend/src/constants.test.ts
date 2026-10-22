import { describe, it, expect } from 'vitest';
import { DISCLAIMER, RULE_HINTS, NAV_ORDER, MENU_LABEL, REPLAY_SPEEDS, DIFFICULTY_COLOR } from './constants';

// 常量层：把散落在各页面的魔法值集中管理，测试即契约。

// RQ-13（P4）：交易规则情景化解释
describe('RULE_HINTS (RQ-13)', () => {
  it('覆盖 T+1 / 涨跌停 / 费用 / 最小单位四条核心规则', () => {
    const keys = RULE_HINTS.map((r) => r.key);
    expect(keys).toContain('t1');
    expect(keys).toContain('limit');
    expect(keys).toContain('fee');
    expect(keys).toContain('lot');
  });

  it('每条规则都有标题与说明，且不含收益承诺', () => {
    for (const r of RULE_HINTS) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.desc.length).toBeGreaterThan(0);
      expect(/稳赚|必涨|保证收益|翻倍/.test(r.desc)).toBe(false);
    }
  });
});

// RQ-29（P4）
describe('DISCLAIMER (RQ-29)', () => {
  it('同时包含模拟交易与不构成投资建议', () => {
    expect(DISCLAIMER).toContain('模拟交易');
    expect(DISCLAIMER).toContain('不构成投资建议');
  });
});

// RQ-25 / 新增导航（P5）
describe('导航常量', () => {
  it('每个导航项都有中文标题与图标位', () => {
    for (const key of NAV_ORDER) {
      expect(MENU_LABEL[key]).toBeTruthy();
    }
  });

  it('本轮新增的页面均已在导航中注册', () => {
    for (const p of ['/orders', '/replay', '/review', '/scenarios', '/rooms']) {
      expect(NAV_ORDER).toContain(p as never);
      expect(MENU_LABEL[p]).toBeTruthy();
    }
  });
});

// RQ-02（P5）：回放倍速档位
describe('REPLAY_SPEEDS (RQ-02)', () => {
  it('提供 0.5x ~ 8x 的多档倍速，且递增', () => {
    expect(REPLAY_SPEEDS[0]).toBe(0.5);
    expect(REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1]).toBe(8);
    for (let i = 1; i < REPLAY_SPEEDS.length; i += 1) {
      expect(REPLAY_SPEEDS[i]).toBeGreaterThan(REPLAY_SPEEDS[i - 1]);
    }
  });
});

// RQ-16（P5）
describe('DIFFICULTY_COLOR (RQ-16)', () => {
  it('三档难度均有配色', () => {
    expect(DIFFICULTY_COLOR.easy).toBeTruthy();
    expect(DIFFICULTY_COLOR.medium).toBeTruthy();
    expect(DIFFICULTY_COLOR.hard).toBeTruthy();
  });
});
