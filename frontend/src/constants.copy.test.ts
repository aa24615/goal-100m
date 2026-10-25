/**
 * RQ-51 全局口径改写 / RQ-72 口径自证机制 —— 前端测试
 *
 * RQ-72 要求「口径文案集中到常量统一管理 + 上线前排查清单（防再次漂移）」。
 * 这里把排查清单做成**可执行断言**：一旦有人又把「行情与资金均为虚拟仿真」
 * 写回页面或文档，测试立刻失败。
 */
import { describe, it, expect } from 'vitest';
import {
  DISCLAIMER,
  DATA_SOURCE_STATEMENT,
  FORBIDDEN_WORDINGS,
  SAMPLE_THRESHOLD,
  RULE_HINTS,
} from './constants';

/**
 * 用 Vite 的 import.meta.glob 在构建期把源码文本读进来做全仓排查，
 * 避免在浏览器测试环境里引入 node:fs（前端没有 node 类型/运行时）。
 */
const SOURCE_MODULES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('RQ-51 口径改写（P0）', () => {
  it('P0 · 免责声明改为「真实 A 股行情 + 模拟资金与模拟交易」', () => {
    expect(DISCLAIMER).toContain('真实 A 股行情');
    expect(DISCLAIMER).toContain('模拟资金');
    expect(DISCLAIMER).toContain('不构成投资建议');
  });

  it('P0 · 不再声称「行情为虚拟」——与实际跑真实行情不符', () => {
    for (const bad of FORBIDDEN_WORDINGS) {
      expect(DISCLAIMER).not.toContain(bad);
    }
    // 反向保险：任何说行情虚拟的措辞都不允许
    expect(DISCLAIMER).not.toMatch(/行情[^，。]*虚拟/);
  });

  it('P0 · 数据来源声明说明真实来源 + 模拟撮合两层事实', () => {
    expect(DATA_SOURCE_STATEMENT).toContain('真实 A 股公开');
    expect(DATA_SOURCE_STATEMENT).toContain('模拟撮合');
    expect(DATA_SOURCE_STATEMENT).toMatch(/不构成|仅供学习研究/);
  });
});

describe('RQ-72 口径自证：全仓排查清单（P5）', () => {
  it('P5 · 前端源码中不存在任何旧口径文案（防再次漂移）', () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(SOURCE_MODULES)) {
      // 排除黑名单的「定义处」与「断言处」本身：constants.ts 存着 FORBIDDEN_WORDINGS，
      // 本文件引用它做断言，两者出现旧文案是设计使然，不是漂移。
      if (path.endsWith('constants.ts') || path.endsWith('constants.copy.test.ts')) continue;
      for (const bad of FORBIDDEN_WORDINGS) {
        if (text.includes(bad)) offenders.push(`${path} :: ${bad}`);
      }
    }
    expect(offenders, `发现旧口径残留：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('P5 · 扫描确实覆盖了足够多的源文件（防止 glob 失效变成空跑）', () => {
    expect(Object.keys(SOURCE_MODULES).length).toBeGreaterThan(20);
  });

  it('P5 · 前端不再硬编码「涨跌停 ±10%」的规则说明', () => {
    const hint = RULE_HINTS.find((h) => h.key === 'limit');
    expect(hint).toBeTruthy();
    expect(hint!.title).not.toContain('±10%');
    expect(hint!.desc).toContain('±20%');
    expect(hint!.desc).toContain('±30%');
  });

  it('P5 · 交易规则说明包含停牌不可交易（此前完全缺失）', () => {
    const halt = RULE_HINTS.find((h) => h.key === 'halt');
    expect(halt).toBeTruthy();
    expect(halt!.desc).toContain('停牌');
  });
});

describe('RQ-77 样本门槛常量一致性（P5）', () => {
  it('P5 · 前端展示用的门槛值与后端一致（50 笔）', () => {
    expect(SAMPLE_THRESHOLD).toBe(50);
  });
});
