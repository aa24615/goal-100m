/**
 * RQ-93 门面重排 / RQ-100 零使用功能降噪 —— 常量层契约测试
 *
 * 这两条需求本质是「门面合同」：内核早已是训练工具，首屏却写着模拟交易大厅（F-15），
 * 11 个一级入口里有一半是零使用功能（F-23）。
 * 把它固化在常量层的好处：**文案一旦漂回去，测试立即红**，不靠人眼巡检。
 */
import { describe, it, expect } from 'vitest';
import {
  HOME,
  BRAND,
  NAV_ORDER,
  NAV_GROUPS,
  LOW_USAGE_NAV,
  MENU_LABEL,
  FIRST_TRAINING,
  RATIO_GUARD_THRESHOLD,
  SAMPLE_THRESHOLD,
} from './constants';

/* ===================== P0 · RQ-93 门面 ===================== */

describe('RQ-93 门面与定位（P0）', () => {
  it('P0 · 首访落点是训练中心，而不是行情中心', () => {
    expect(HOME).toBe('/training');
    expect(MENU_LABEL[HOME]).toBeTruthy();
  });

  it('P0 · 首屏不再出现「模拟交易大厅」字样（F-15 的自证断言）', () => {
    expect(BRAND.header).not.toContain('模拟交易大厅');
    expect(BRAND.sub).not.toContain('模拟股票');
    for (const w of BRAND.forbidden) {
      expect(BRAND.header).not.toContain(w);
      expect(BRAND.sub).not.toContain(w);
    }
    expect(BRAND.header).toContain('训练');
    expect(BRAND.sub).toBe('训练场');
  });

  it('P0 · 训练类入口在一级导航前两位', () => {
    const first = NAV_GROUPS[0];
    expect(first.title).toBe('训练');
    expect(first.items[0]).toBe('/training');
    expect(first.items[1]).toBe('/blind');
    expect(NAV_ORDER[0]).toBe('/training');
    expect(NAV_ORDER[1]).toBe('/blind');
  });

  it('P0 · 交易类入口收进「账户」分组', () => {
    const account = NAV_GROUPS.find((g) => g.title === '账户');
    expect(account).toBeTruthy();
    expect(account!.items).toContain('/portfolio');
    expect(account!.items).toContain('/orders');
    expect(account!.items).toContain('/transactions');
  });
});

/* ===================== P0 · RQ-100 降噪 ===================== */

describe('RQ-100 零使用功能降噪（P0）', () => {
  it('P0 · 一级导航项数 ≤ 7（原来是 11 个）', () => {
    expect(NAV_GROUPS.length).toBeLessThanOrEqual(7);
  });

  it('P0 · 房间赛与剧本训练场不在任何一级分组中', () => {
    const rendered = NAV_GROUPS.flatMap((g) => g.items);
    for (const k of LOW_USAGE_NAV) {
      expect(rendered).not.toContain(k);
    }
    expect(LOW_USAGE_NAV).toContain('/rooms');
    expect(LOW_USAGE_NAV).toContain('/scenarios');
  });

  it('P1 · 折叠项仍保留路由与标题（降噪不等于删功能，书签仍可达）', () => {
    for (const k of LOW_USAGE_NAV) {
      expect(MENU_LABEL[k]).toBeTruthy();
      expect(NAV_ORDER).toContain(k as never);
    }
  });

  it('P1 · 每个渲染出来的导航项都有中文标题', () => {
    for (const g of NAV_GROUPS) {
      expect(g.title).toBeTruthy();
      for (const k of g.items) expect(MENU_LABEL[k]).toBeTruthy();
    }
  });

  it('P1 · 导航项不重复出现在多个分组', () => {
    const all = NAV_GROUPS.flatMap((g) => g.items);
    expect(new Set(all).size).toBe(all.length);
  });
});

/* ===================== P1 · RQ-92 首训口径 ===================== */

describe('RQ-92 首训直达（P1）', () => {
  it('P1 · 首训目标为 ≤60 秒 / ≤3 次点击，并给出明确 CTA', () => {
    expect(FIRST_TRAINING.goalSeconds).toBe(60);
    expect(FIRST_TRAINING.maxClicks).toBe(3);
    expect(FIRST_TRAINING.cta.length).toBeGreaterThan(0);
  });

  it('P1 · 首训步骤明示「不需要先有持仓、不需要先积累样本」', () => {
    // 注意：断言里别写 not.toContain('先有持仓') —— 否定句「不需要先有持仓」本身就含这个词，
    // 那样断言永远失败，等于什么都没守住。
    const text = FIRST_TRAINING.steps.join('|') + FIRST_TRAINING.note;
    expect(text).toContain('不需要先有持仓');
    expect(text).toContain('不需要先积累样本');
    expect(text).not.toContain('需先持有');
    expect(FIRST_TRAINING.steps.length).toBeGreaterThanOrEqual(3);
  });
});

/* ===================== P5 · 兼容性与回归 ===================== */

describe('样本门槛回归（P5）', () => {
  it('P5 · RQ-77 的 50 笔门槛与 RQ-95 的 30 笔护栏并存且数值不变', () => {
    expect(SAMPLE_THRESHOLD).toBe(50);
    expect(RATIO_GUARD_THRESHOLD).toBe(30);
    expect(RATIO_GUARD_THRESHOLD).toBeLessThan(SAMPLE_THRESHOLD);
  });
});
