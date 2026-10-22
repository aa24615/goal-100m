// 导出与分享（RQ-11 / RQ-31 / RQ-32）
//
// 格式选择说明：CSV 直接产出（Excel 可开，带 UTF-8 BOM 防中文乱码）；
// 「PDF」采用 HTML 打印稿（可直接在浏览器打印/另存为 PDF）交付 ——
// 标准 PDF 内置字体不支持中文，自行拼装二进制 PDF 会让中文变乱码，工程上不可接受。

import { DISCLAIMER } from './reviewService.js';

const BOM = '\uFEFF';

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return BOM + lines.join('\r\n');
}

/** 交易流水导出（RQ-31） */
export function transactionsCsv(transactions = []) {
  return toCsv(
    ['成交时间', '代码', '名称', '方向', '数量', '成交价', '成交金额', '手续费', '已实现盈亏'],
    transactions.map((t) => [
      new Date(t.createdAt).toISOString().replace('T', ' ').slice(0, 19),
      t.stockCode,
      t.stockName,
      t.type === 'BUY' ? '买入' : '卖出',
      t.quantity,
      t.price,
      t.amount,
      t.fee,
      t.realizedPnl ?? '',
    ])
  );
}

/** 配对交易导出（RQ-11 / RQ-31） */
export function roundsCsv(rounds = []) {
  return toCsv(
    ['标的', '名称', '状态', '数量', '买入均价', '卖出价', '成本', '已实现盈亏', '收益率%', '建仓时间', '平仓时间', '持有天数'],
    rounds.map((r) => [
      r.code,
      r.name,
      r.status === 'open' ? '持仓中' : '已平仓',
      r.quantity,
      r.buyPrice,
      r.sellPrice ?? '',
      r.costBasis,
      r.realizedPnl,
      r.returnPct ?? '',
      r.openedAt ? new Date(r.openedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      r.closedAt ? new Date(r.closedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
      r.holdDays,
    ])
  );
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 复盘报告打印稿（HTML → 浏览器打印为 PDF） */
export function reviewHtml(payload, { displayName = '' } = {}) {
  const r = payload?.report || {};
  const sc = payload?.scorecard || {};
  const rows = (payload?.rounds || [])
    .map(
      (x) => `<tr>
        <td>${esc(x.code)} ${esc(x.name)}</td>
        <td>${x.status === 'open' ? '持仓中' : '已平仓'}</td>
        <td>${esc(x.quantity)}</td>
        <td>${esc(x.buyPrice)}</td>
        <td>${esc(x.sellPrice ?? '-')}</td>
        <td>${esc(x.realizedPnl)}</td>
        <td>${esc(x.returnPct ?? '-')}</td>
        <td>${esc(x.holdDays)}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>模拟交易复盘报告</title>
<style>
 body{font-family:-apple-system,"Microsoft YaHei",sans-serif;padding:32px;color:#1f2937;max-width:900px;margin:0 auto}
 h1{font-size:22px} .sub{color:#6b7280;font-size:12px;margin-bottom:24px}
 table{border-collapse:collapse;width:100%;font-size:12px;margin:12px 0}
 th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:right} th{background:#f3f4f6;text-align:right}
 th:first-child,td:first-child{text-align:left}
 .cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
 .card{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;min-width:120px}
 .card b{display:block;font-size:18px;margin-top:4px}
 .disc{margin-top:24px;padding:12px;border-left:3px solid #f59e0b;background:#fffbeb;font-size:12px}
 ul{font-size:13px;line-height:1.8}
</style></head><body>
<h1>模拟交易复盘报告</h1>
<div class="sub">用户：${esc(displayName)} ｜ 区间：${esc(payload?.period)} ｜ 生成时间：${esc(new Date().toLocaleString('zh-CN'))}</div>
<div class="cards">
  <div class="card">收益率<b>${esc(payload?.returnPct)}%</b></div>
  <div class="card">同期大盘<b>${esc(payload?.benchmarkPct)}%</b></div>
  <div class="card">超额收益<b>${esc(payload?.excessPct)}%</b></div>
  <div class="card">胜率<b>${esc(sc.winRate)}%</b></div>
  <div class="card">盈亏比<b>${esc(sc.profitFactor ?? '-')}</b></div>
  <div class="card">最大回撤<b>${esc(sc.maxDrawdown)}%</b></div>
  <div class="card">手续费占比<b>${esc(sc.feeRatio)}%</b></div>
</div>
<h3>行为特征</h3>
<ul>${(r.traits || []).map((t) => `<li><b>${esc(t.label)}</b>：${esc(t.detail)}</li>`).join('') || '<li>暂无显著特征，样本量不足</li>'}</ul>
<h3>改进建议</h3>
<ul>${(r.suggestions || []).map((s) => `<li>${esc(s)}</li>`).join('') || '<li>继续保持记录与复盘习惯</li>'}</ul>
<h3>逐笔配对</h3>
<table><thead><tr><th>标的</th><th>状态</th><th>数量</th><th>买入均价</th><th>卖出价</th><th>已实现盈亏</th><th>收益率%</th><th>持有天数</th></tr></thead><tbody>${rows}</tbody></table>
<div class="disc">${esc(r.disclaimer || DISCLAIMER)}</div>
</body></html>`;
}

/**
 * 战绩分享卡数据（RQ-32）
 * 脱敏原则：只输出昵称（截断）+ 脱敏后的用户名首字母，不输出邮箱 / 用户 ID / 手机号等身份信息
 */
export function buildShareCard({ displayName = '', username = '', returnPct = 0, excessPct = 0, radar = null, period = '30d' } = {}) {
  const rawName = String(displayName || '').trim();
  // 昵称未设置时会回落到用户名；此时直接展示用户名等于泄露账号，一律走匿名
  const safeName =
    (!rawName || rawName === username ? '匿名交易者' : rawName).slice(0, 12);
  const safeUser = String(username || '')
    .replace(/^(.{1,2}).*$/, '$1***'); // 只保留前 1-2 位，其余打码
  return {
    displayName: safeName,
    usernameMasked: safeUser,
    period,
    returnPct,
    excessPct,
    outcome: excessPct > 0 ? '跑赢大盘' : excessPct < 0 ? '跑输大盘' : '与大盘持平',
    radar: radar
      ? { overall: radar.overall, dimensions: radar.dimensions.map((d) => ({ label: d.label, score: d.score })) }
      : null,
    disclaimer: '本卡片为模拟交易成绩，不构成投资建议',
  };
}
