import { describe, it, expect } from 'vitest';
import { formatMoney, formatNum, formatPct, changeClass } from './format';

// P0：纯数值格式化函数，无副作用、无外部依赖，最先覆盖。
describe('format utils (P0)', () => {
  it('formatMoney 带 ¥ 前缀并保留两位小数、千分位', () => {
    expect(formatMoney(1234.5)).toBe('¥1,234.50');
    expect(formatMoney(0)).toBe('¥0.00');
    expect(formatMoney(1000000)).toBe('¥1,000,000.00');
    expect(formatMoney(-99.9)).toBe('¥-99.90');
  });

  it('formatNum 默认两位小数，可指定精度', () => {
    expect(formatNum(12.3)).toBe('12.30');
    expect(formatNum(12.3456, 4)).toBe('12.3456');
    expect(formatNum(0)).toBe('0.00');
  });

  it('formatPct 正数带 + 号，负数无多余符号，固定两位小数', () => {
    expect(formatPct(1.23)).toBe('+1.23%');
    expect(formatPct(-2.5)).toBe('-2.50%');
    expect(formatPct(0)).toBe('+0.00%');
  });

  it('changeClass 涨跌平映射到 up/down/flat（A股红涨绿跌约定）', () => {
    expect(changeClass(0.01)).toBe('up');
    expect(changeClass(-0.01)).toBe('down');
    expect(changeClass(0)).toBe('flat');
  });
});
