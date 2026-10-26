/**
 * RQ-82 片段特征标签 / RQ-81 多周期粒度 —— 单元测试
 *
 * 优先级覆盖：P1 主流程 · P3 边界与异常 · P4 性能 · P5 兼容性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySegment,
  isValidTag,
  SEGMENT_TAGS,
  GRANULARITIES,
  DEFAULT_GRANULARITY,
  isGranularityAvailable,
  TAG_THRESHOLDS,
  startBlind,
  normalizeSegmentTag,
  resolveSegmentTag,
  SEGMENT_TAG_ALIASES,
} from '../../src/services/blindService.js';

/* 构造收盘价序列 */
function series(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

/* ===================== P1 · RQ-82 特征分类主流程 ===================== */

test('P1 · RQ-82 四类标签定义齐备', () => {
  assert.deepEqual(Object.keys(SEGMENT_TAGS).sort(), ['pullback', 'range', 'trend', 'volatile']);
  for (const t of Object.values(SEGMENT_TAGS)) {
    assert.ok(t.label && t.desc, `${t.key} 缺 label/desc`);
  }
});

test('P1 · RQ-82 单边上涨且效率高 → 趋势', () => {
  // 每天稳定 +1%，净涨幅大且几乎不回头
  const closes = series(60, (i) => 10 * Math.pow(1.01, i));
  const r = classifySegment(closes);
  assert.equal(r.tag, 'trend');
  assert.equal(r.label, '趋势');
  assert.ok(r.metrics.netReturn > 0);
  assert.ok(r.metrics.efficiency >= TAG_THRESHOLDS.trendEfficiency * 100);
});

test('P1 · RQ-82 横盘来回震荡 → 震荡', () => {
  // 小幅正弦，净收益接近 0、效率低
  const closes = series(60, (i) => 10 + Math.sin(i / 3) * 0.05);
  const r = classifySegment(closes);
  assert.equal(r.tag, 'range');
  assert.equal(r.label, '震荡');
});

test('P1 · RQ-82 高点大幅回落 → 回撤', () => {
  // 先涨 25% 再跌回来，最大回撤大、净收益为负
  const closes = series(60, (i) => (i < 25 ? 10 * (1 + i * 0.012) : 13 * Math.pow(0.985, i - 25)));
  const r = classifySegment(closes);
  assert.equal(r.tag, 'pullback');
  assert.ok(r.metrics.maxDrawdown >= TAG_THRESHOLDS.pullbackDD * 100);
  assert.ok(r.metrics.netReturn < TAG_THRESHOLDS.pullbackNetMax * 100);
});

test('P1 · RQ-82 大幅上下跳动 → 高波动', () => {
  // 每天 ±4% 交替，标准差远超阈值
  const closes = series(60, (i) => (i === 0 ? 10 : i % 2 === 0 ? 10 * 1.04 : 10 / 1.04));
  const r = classifySegment(closes);
  assert.equal(r.tag, 'volatile');
  assert.ok(r.metrics.volatility >= TAG_THRESHOLDS.volatileVol * 100);
});

test('P1 · RQ-82 分类结果是决定论的（同一序列两次结果一致）', () => {
  const closes = series(60, (i) => 10 + Math.sin(i) * 0.6 + i * 0.02);
  const a = classifySegment(closes);
  const b = classifySegment(closes);
  assert.deepEqual(a, b, '纯算术分类必须可复现，否则「按标签筛选」不可信');
});

test('P1 · RQ-82 isValidTag 只接受四类，大小写不敏感', () => {
  for (const k of Object.keys(SEGMENT_TAGS)) {
    assert.equal(isValidTag(k), true);
    assert.equal(isValidTag(k.toUpperCase()), true);
  }
  assert.equal(isValidTag('sideways'), false);
  assert.equal(isValidTag(''), false);
  assert.equal(isValidTag(null), false);
  assert.equal(isValidTag(undefined), false);
});

/* ===================== P3 · 边界与异常 ===================== */

test('P3 · RQ-82 数据不足返回 null 而不是抛错', () => {
  assert.equal(classifySegment([]), null);
  assert.equal(classifySegment([10]), null);
  assert.equal(classifySegment([10, 11]), null);
  assert.equal(classifySegment(null), null);
  assert.equal(classifySegment(undefined), null);
  assert.equal(classifySegment('not-an-array'), null);
});

test('P3 · RQ-82 含脏数据（NaN / 0 / 负数 / null）时过滤后仍能分类', () => {
  const dirty = [10, NaN, 10.2, null, 0, -3, 10.5, undefined, 10.8, '11', 11.2];
  assert.doesNotThrow(() => classifySegment(dirty));
  const r = classifySegment(dirty);
  if (r) {
    assert.ok(Number.isFinite(r.metrics.netReturn));
    assert.ok(Number.isFinite(r.metrics.volatility));
    assert.ok(Number.isFinite(r.metrics.maxDrawdown));
  }
});

test('P3 · RQ-82 常量价格序列不会除零或产生 Infinity/NaN', () => {
  const flat = series(60, () => 10);
  const r = classifySegment(flat);
  assert.ok(r);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('NaN'));
  assert.ok(!text.includes('Infinity'));
  assert.equal(r.metrics.volatility, 0);
  assert.equal(r.metrics.maxDrawdown, 0);
});

test('P3 · RQ-81 分钟级粒度一律不可用（数据未接入，Q6 未答）', () => {
  assert.equal(isGranularityAvailable('day'), true);
  for (const g of ['m60', 'm30', 'm15', 'm5']) {
    assert.equal(isGranularityAvailable(g), false, `${g} 在无数据时不得宣称可用`);
  }
  assert.equal(isGranularityAvailable('week'), false);
  assert.equal(isGranularityAvailable(''), false);
  assert.equal(isGranularityAvailable(null), false);
  assert.equal(DEFAULT_GRANULARITY, 'day');
});

test('P3 · RQ-81 请求分钟级粒度被明确拒绝（400 业务拒绝，不是 500）', async () => {
  await assert.rejects(
    () => startBlind({ userId: 1, bars: 60, granularity: 'm60' }),
    (e) => {
      assert.equal(e.status, 400, '粒度不支持是业务规则拒绝，不能打成 5xx');
      assert.equal(e.business, true, '必须打 business 标记，否则会混进「请求报文非法」告警桶');
      assert.match(e.message, /暂不支持|仅提供日线/);
      return true;
    }
  );
});

test('P3 · RQ-82 请求未知标签被明确拒绝', async () => {
  await assert.rejects(
    () => startBlind({ userId: 1, bars: 60, tag: 'banana' }),
    (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.business, true);
      assert.match(e.message, /未知的片段类型/);
      return true;
    }
  );
});

/* ===================== P3 · RQ-101 标签字典唯一源 ===================== */

test('P3 · RQ-101 历史写法 sideways 被归一为 range，不再产生 400 噪声', async () => {
  // F-25 的成因就是 sideways / range 两套写法各说各话。
  // 归一化后：历史写法被接受并折算为规范标签，而不是每次调用吃一个 400。
  assert.equal(normalizeSegmentTag('sideways'), 'range');
  assert.equal(normalizeSegmentTag('SIDEWAYS'), 'range');
  assert.equal(normalizeSegmentTag(' Range '), 'range');
  // 真正无法识别的写法仍然返回 null，由调用方决定报错
  assert.equal(normalizeSegmentTag('banana'), null);
  assert.equal(normalizeSegmentTag(null), null);
  assert.equal(normalizeSegmentTag(''), null);
  assert.equal(normalizeSegmentTag(123), null);
});

test('P3 · RQ-101 所有别名都指向规范标签（不存在悬空映射）', () => {
  for (const [alias, canonical] of Object.entries(SEGMENT_TAG_ALIASES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SEGMENT_TAGS, canonical),
      `别名 ${alias} 指向了不存在的规范标签 ${canonical}`
    );
    assert.equal(normalizeSegmentTag(alias), canonical);
  }
  // 规范标签自身不能被别名表覆盖
  for (const k of Object.keys(SEGMENT_TAGS)) {
    assert.equal(normalizeSegmentTag(k), k);
  }
});

test('P3 · RQ-101 resolveSegmentTag 对未知标签给出可选值清单', () => {
  const bad = resolveSegmentTag('banana');
  assert.equal(bad.ok, false);
  assert.equal(bad.tag, null);
  assert.ok(Array.isArray(bad.allowed) && bad.allowed.length > 0, '错误信息必须列出规范值');

  const good = resolveSegmentTag('sideways');
  assert.equal(good.ok, true);
  assert.equal(good.tag, 'range');
});

/* ===================== P4 · 性能 ===================== */

test('P4 · RQ-82 1000 次分类计算在预算内完成', () => {
  const closes = series(200, (i) => 10 + Math.sin(i / 5) * 0.8 + i * 0.01);
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) classifySegment(closes);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `1000 次分类耗时 ${ms}ms`);
});

test('P4 · RQ-82 超长序列（5000 根）不栈溢出且给出结果', () => {
  const closes = series(5000, (i) => 10 * Math.pow(1.0005, i));
  assert.doesNotThrow(() => classifySegment(closes));
  const r = classifySegment(closes);
  assert.equal(r.metrics.bars, 5000);
});

/* ===================== P5 · 兼容性与回归 ===================== */

test('P5 · RQ-81 粒度字典自解释且覆盖日线与分钟级（页面据此渲染）', () => {
  const keys = GRANULARITIES.map((g) => g.key);
  assert.ok(keys.includes('day'));
  assert.ok(keys.includes('m60'));
  for (const g of GRANULARITIES) {
    assert.ok(g.label);
    assert.equal(typeof g.available, 'boolean');
    assert.ok(g.note, `${g.key} 必须说明可用/不可用的原因，页面要原样展示`);
  }
  assert.equal(
    GRANULARITIES.filter((g) => g.available).length,
    1,
    '当前仅日线可用，若新增周期必须同步更新此处（RQ-81 要求规则同步生效）'
  );
});

test('P5 · RQ-82 分类阈值集中定义，便于按 A 股波动水平校准', () => {
  for (const [k, v] of Object.entries(TAG_THRESHOLDS)) {
    assert.equal(typeof v, 'number', `${k} 必须是数值`);
    assert.ok(Number.isFinite(v));
  }
});
