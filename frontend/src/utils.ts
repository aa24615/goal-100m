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

export function changeClass(n: number): string {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}
