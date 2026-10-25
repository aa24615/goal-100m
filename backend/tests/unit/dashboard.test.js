/**
 * RQ-62 指标看板（北极星 7 日留存） / RQ-90 密码找回 —— 单元测试
 *
 * 优先级覆盖：P0 主流程 · P3 边界与异常 · P5 合规与兼容性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeRetention,
  RETENTION_DAYS,
  DASHBOARD_RETENTION_WINDOW,
  EVENTS,
  isValidEvent,
  sanitizeContext,
} from '../../src/services/analyticsService.js';
import { resetUnavailable } from '../../src/auth.js';

const NOW = new Date('2026-10-26T12:00:00+08:00');
const dayAgo = (n) => new Date(NOW.getTime() - n * 86400 * 1000);

/* ===================== P0 · RQ-62 指标看板 ===================== */

test('P0 · RQ-62 数据保留 ≥180 天（验收硬指标）', () => {
  assert.ok(RETENTION_DAYS >= 180, `保留天数 ${RETENTION_DAYS} 必须 ≥180`);
});

test('P0 · RQ-62 北极星默认窗口为 7 日', () => {
  assert.equal(DASHBOARD_RETENTION_WINDOW, 7);
});

test('P0 · RQ-62 留存率按「成熟队列」加权平均计算', () => {
  const rows = [
    { cohort_day: dayAgo(20), cohort: 100, retained: 40 },
    { cohort_day: dayAgo(15), cohort: 100, retained: 60 },
  ];
  const r = summarizeRetention(rows, { window: 7, now: NOW });
  assert.equal(r.northStar.value, 50, '(40+60)/200 = 50%');
  assert.equal(r.northStar.cohortUsers, 200);
  assert.equal(r.northStar.retainedUsers, 100);
  assert.equal(r.northStar.observable, true);
});

test('P0 · RQ-62 未满观察窗口的队列日不计入平均（否则留存天然偏低）', () => {
  const rows = [
    { cohort_day: dayAgo(2), cohort: 100, retained: 0 }, // 才过 2 天，窗口未满
    { cohort_day: dayAgo(20), cohort: 100, retained: 50 }, // 成熟
  ];
  const r = summarizeRetention(rows, { window: 7, now: NOW });
  assert.equal(r.rows[0].mature, false);
  assert.equal(r.rows[1].mature, true);
  assert.equal(r.northStar.value, 50, '未成熟队列必须被排除');
  assert.equal(r.northStar.cohortUsers, 100);
});

test('P0 · RQ-62 无数据时北极星明确标记为不可观测（不假装是 0%）', () => {
  const r = summarizeRetention([], { window: 7, now: NOW });
  assert.equal(r.northStar.value, null, '无数据应返回 null 而不是 0');
  assert.equal(r.northStar.observable, false);
  assert.match(r.northStar.note, /不可观测/);
});

test('P0 · RQ-62 窗口可配置（7 / 30 日）', () => {
  const rows = [{ cohort_day: dayAgo(40), cohort: 10, retained: 3 }];
  assert.equal(summarizeRetention(rows, { window: 7, now: NOW }).window, 7);
  assert.equal(summarizeRetention(rows, { window: 30, now: NOW }).window, 30);
  assert.equal(summarizeRetention(rows, { window: 30, now: NOW }).northStar.metric, '30 日留存率');
});

/* ===================== P3 · 边界与异常 ===================== */

test('P3 · RQ-62 留存入参为脏数据时不抛错、不产生 NaN', () => {
  assert.doesNotThrow(() => summarizeRetention(null));
  assert.doesNotThrow(() => summarizeRetention([null, undefined, {}]));
  const r = summarizeRetention([{ cohort_day: 'bad-date', cohort: null, retained: 'x' }], { now: NOW });
  assert.ok(!Number.isNaN(r.northStar.value));
  assert.equal(r.rows[0].cohort, 0);
  assert.equal(r.rows[0].rate, 0);
});

test('P3 · RQ-62 留存人数超过队列人数时被裁剪（脏数据兜底）', () => {
  const r = summarizeRetention([{ cohort_day: dayAgo(20), cohort: 10, retained: 99 }], { window: 7, now: NOW });
  assert.equal(r.rows[0].retained, 10);
  assert.equal(r.rows[0].rate, 100, '留存率不得超过 100%');
});

test('P3 · RQ-62 窗口越界时被夹取到 1~30', () => {
  // window=0 视为「未指定」，回落到默认 7 日（0 日留存没有业务含义）
  assert.equal(summarizeRetention([], { window: 0 }).window, DASHBOARD_RETENTION_WINDOW);
  assert.equal(summarizeRetention([], { window: -5 }).window, 1);
  assert.equal(summarizeRetention([], { window: 9999 }).window, 30);
  assert.equal(summarizeRetention([], { window: 'abc' }).window, DASHBOARD_RETENTION_WINDOW);
});

/* ===================== P5 · RQ-74 埋点口径兼容 ===================== */

test('P5 · RQ-62 看板依赖的埋点事件全部在白名单内', () => {
  for (const e of ['blind_start', 'blind_finish', 'blind_decision', 'checkup_view', 'weekly_report_view', 'prescription_start']) {
    assert.ok(EVENTS.includes(e), `看板依赖事件 ${e} 缺失`);
    assert.equal(isValidEvent(e), true);
  }
});

test('P5 · RQ-74 未知事件一律拒绝（避免噪声污染统计口径）', () => {
  assert.equal(isValidEvent('__proto__'), false);
  assert.equal(isValidEvent(''), false);
  assert.equal(isValidEvent(null), false);
  assert.equal(isValidEvent('blind_start_extra'), false);
});

test('P5 · RQ-62 埋点上下文脱敏仍然生效（合规硬约束 6）', () => {
  const ctx = sanitizeContext({ token: 'abc', password: 'x', phone: '13800000000', safe: 'ok' });
  assert.equal(ctx.token, undefined);
  assert.equal(ctx.password, undefined);
  assert.equal(ctx.phone, undefined);
  assert.equal(ctx.safe, 'ok');
});

/* ===================== P0 · RQ-90 密码找回 ===================== */

test('P0 · RQ-90 无邮件通道时响应体中绝不出现「已发送」', () => {
  const r = resetUnavailable('SMTP 未配置');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('已发送'), '邮件发不出去时不得宣称已发送（F-11）');
  assert.equal(r.delivered, false);
  assert.equal(r.channel, 'none');
});

test('P0 · RQ-90 无邮件通道时必须给出替代路径与时限', () => {
  const r = resetUnavailable('SMTP 未配置');
  assert.ok(Array.isArray(r.alternatives) && r.alternatives.length > 0, '替代路径必须真实可达');
  assert.equal(typeof r.ttlMinutes, 'number');
  assert.ok(r.ttlMinutes > 0, '时限必须明示');
  assert.ok(r.notice);
});

test('P0 · RQ-90 不泄露账号是否存在（与已注册/未注册返回同构）', () => {
  const r = resetUnavailable('SMTP 未配置');
  assert.ok(!JSON.stringify(r).includes('@'), '响应体不得回显邮箱地址');
  assert.equal(r.ok, true, '对外仍是成功响应，避免被枚举账号');
});

/* ===================== P3 · RQ-90 边界 ===================== */

test('P3 · RQ-90 未传原因时给出默认原因文案', () => {
  const r = resetUnavailable();
  assert.ok(r.reason);
  assert.equal(r.delivered, false);
});
