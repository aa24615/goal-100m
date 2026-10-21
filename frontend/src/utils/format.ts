// 数值与百分比的纯展示函数：集中在此处，便于单元测试与多页面复用。
// 涨跌配色遵循 A 股习惯：涨红、跌绿（见 changeClass）。

export function formatMoney(n: number): string {
  return (
    '¥' +
    n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

export function formatNum(n: number, digits = 2): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPct(n: number): string {
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

// 返回用于 CSS class 的涨跌方向：up=涨红 / down=跌绿 / flat=平
export function changeClass(n: number): string {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}
