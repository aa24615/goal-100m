/**
 * 跨层一致性 —— 后端测试
 *
 * 覆盖三类「文档/常量/代码说的不是同一件事」的漂移风险：
 *   RQ-53 README 与代码行为一致（第 5 行自相矛盾、第 167 行「默认 T+0」）
 *   RQ-72 口径文案集中管理（后端不再散落旧口径）
 *   RQ-77 / RQ-49 前后端门槛与规则同源
 *
 * 优先级：P5（合规与口径一致性）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_THRESHOLD } from '../../src/services/checkupService.js';
import { BOARD_RULES, ST_LIMIT } from '../../src/rules.js';
import { EVENTS } from '../../src/services/analyticsService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const README = read(join(ROOT, 'README.md'));

test('P5 · RQ-53 README 消除「所有行情…均为虚拟仿真（行情数据为真实 A 股公开数据）」的自相矛盾', () => {
  assert.ok(README.length > 0, 'README 应存在');
  assert.ok(!README.includes('行情与资金均为虚拟仿真'), 'README 仍含旧口径');
  assert.ok(!README.includes('资金与行情均为虚拟'), 'README 仍含旧口径');
  // 一句话里同时出现「虚拟」与「真实数据」即自相矛盾
  const contradictions = README.split('\n').filter(
    (l) => /虚拟仿真/.test(l) && /真实\s*A\s*股/.test(l)
  );
  assert.deepEqual(contradictions, [], `仍存在自相矛盾的表述：\n${contradictions.join('\n')}`);
});

test('P5 · RQ-53 README 不再声称「默认 T+0」', () => {
  assert.ok(!README.includes('默认 T+0'), 'README 仍写默认 T+0，与已实现的 T+1 矛盾');
  assert.ok(!/默认允许当日买卖/.test(README));
});

test('P5 · RQ-49 README 与规则表口径一致（四板块幅度逐项对上）', () => {
  assert.ok(README.includes('北交所'), 'README 应写明北交所规则');
  assert.ok(README.includes('±30%'), `北交所幅度应与 ${BOARD_RULES.BSE.limit} 一致`);
  assert.ok(README.includes('±20%'), '创业板/科创板 ±20%');
  assert.ok(README.includes('±5%'), 'ST ±5%');
  assert.equal(BOARD_RULES.BSE.limit, 0.3);
  assert.equal(BOARD_RULES.GEM.limit, 0.2);
  assert.equal(BOARD_RULES.STAR.limit, 0.2);
  assert.equal(BOARD_RULES.MAIN.limit, 0.1);
  assert.equal(ST_LIMIT, 0.05);
});

test('P5 · RQ-72 前端常量与后端门槛同源（50 笔）', () => {
  assert.equal(SAMPLE_THRESHOLD, 50);
  const fe = read(join(ROOT, 'frontend/src/constants.ts'));
  assert.match(fe, /SAMPLE_THRESHOLD\s*=\s*50/, '前端门槛常量应为 50');
});

test('P5 · RQ-72 前端免责声明与 README 口径一致（都强调真实行情 + 模拟资金）', () => {
  const fe = read(join(ROOT, 'frontend/src/constants.ts'));
  assert.match(fe, /真实 A 股行情/, '前端 DISCLAIMER 应写明真实行情');
  assert.match(fe, /模拟资金/, '前端 DISCLAIMER 应写明模拟资金');
  assert.ok(README.includes('真实 A 股行情'), 'README 口径应与前端一致');
  assert.ok(README.includes('模拟资金'), 'README 口径应与前端一致');
});

test('P5 · RQ-74 后端埋点事件表覆盖双盲与体检单节点', () => {
  for (const e of ['blind_start', 'blind_decision', 'blind_finish', 'checkup_view', 'checkin']) {
    assert.ok(EVENTS.includes(e), `后端缺少事件 ${e}`);
  }
  const feEvents = read(join(ROOT, 'frontend/src/utils/trackEvents.ts'));
  for (const e of ['blind_start', 'blind_decision', 'blind_finish', 'checkup_view']) {
    assert.ok(feEvents.includes(`'${e}'`), `前端白名单缺少 ${e}`);
  }
});

test('P5 · RQ-50 停牌建模已入库：迁移文件与 CHECK 约束存在', () => {
  const m = read(join(ROOT, 'backend/migrations/0014_trade_status.sql'));
  assert.match(m, /trade_status/, '迁移应新增 trade_status 列');
  assert.match(m, /HALTED/, '应支持 HALTED 状态');
  assert.match(m, /DELISTED/, '应支持 DELISTED 状态');
});

test('P5 · RQ-75 错误上报表与脱敏约束已入库', () => {
  const m = read(join(ROOT, 'backend/migrations/0015_observability.sql'));
  assert.match(m, /frontend_errors/, '应新建前端错误表');
  assert.match(m, /fingerprint/, '应按指纹聚合');
});

test('P5 · RQ-42 双盲表与真实账户隔离：blind_* 独立建表，不复用 transactions/holdings', () => {
  const m = read(join(ROOT, 'backend/migrations/0016_blind_training.sql'));
  for (const t of ['blind_sessions', 'blind_orders', 'blind_decisions']) {
    assert.match(m, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`), `缺少 ${t}`);
  }
  assert.ok(!m.includes('INSERT INTO transactions'), '双盲迁移不得写入真实流水表');
});

test('P5 · RQ-49 全后端不再有写死的 ±10% 涨跌停计算（规则统一走 rules.js）', () => {
  const files = [
    'backend/src/routes/trade.js',
    'backend/src/orders.js',
    'backend/src/services/replayService.js',
    'backend/src/services/tradeService.js',
  ];
  for (const f of files) {
    const src = read(join(ROOT, f));
    assert.ok(
      !/DAILY_LIMIT/.test(src),
      `${f} 仍在使用写死的 DAILY_LIMIT，应改为 rules.js 的分板块规则`
    );
  }
});
