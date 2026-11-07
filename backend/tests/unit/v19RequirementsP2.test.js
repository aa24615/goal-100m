/**
 * v19 需求实现与测试覆盖矩阵 · P2（留存体验）补位
 *
 * 背景：v18（ed698d1）的 `v18Requirements.test.js` 已覆盖 RQ-195~208 的
 * 测试级别 P0 / P1 / P3 / P4 / P5（共 97 例），但**唯独 P2（留存体验）整层缺失**。
 * 本文件沿用 v15「按缺失级别单独补文件」的约定（v15StageZeroP4P5.test.js），
 * 专门补齐 P2 这一层，使六档测试级别（P0 主流程 / P1 差异化 / P2 留存体验 /
 * P3 边界异常 / P4 性能并发 / P5 兼容回归）对每条需求都闭合。
 *
 * P2（留存体验）关注「用户投入前/后的体验护栏」：首访是否因诚实承诺留下、
 * 训练闭环是否产出可续成绩、游客成果是否不被丢失、可核对/可信度/三件套是否以
 * 「用户能看见、能信任」的方式呈现、活动是否仍「屋内有人」。这些护栏的失败不会
 * 让用例崩溃，却会让真实用户悄悄流失——正是 P2 要守护的。
 *
 * 全部为纯函数单测（无 DB / 无 fs / 无网络），可直接 `node --test` 运行。
 * 运行：node --test tests/unit/v19RequirementsP2.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditPublicEntrypoint } from '../../src/services/publicAccessService.js';
import { buildLandingCopy, countdownOf } from '../../src/services/stageZeroService.js';
import { summarizeGuideFunnel } from '../../src/services/firstTrainingService.js';
import { safeUserId, guestQuota } from '../../src/services/guestService.js';
import {
  classifyEmptySessions,
  summarizeExternalFunnel,
} from '../../src/services/testTrafficService.js';
import { reconcileConsistency, verificationStreak } from '../../src/services/releaseGateService.js';
import { checkIdentityWording } from '../../src/services/identityWordingService.js';
import { auditThreePieceExposure } from '../../src/services/threePieceExposureService.js';
import { buildSettlementAudit } from '../../src/services/settlementAuditService.js';
import { buildSmallSampleFacts, assertNoEdgeAssertion } from '../../src/services/smallSampleService.js';
import { assessActivityRegression } from '../../src/services/activityRegressionService.js';

/* 需求 → 测试级别映射（本文件只覆盖 P2 这一层）
 * RQ-195 公网入口(P0)   RQ-196 落地页(P0)    RQ-197 首训闭环(P0)  RQ-198 免登录练(P0)
 * RQ-199 空跑打标(P1)   RQ-200 对账差异(P1)   RQ-201 验证固化(P1)  RQ-202 身份纠偏(P1)
 * RQ-203 三件套曝光(P1) RQ-204 结算可核对(P2) RQ-205 可信度表达(P2) RQ-206 真人首训(P0)
 * RQ-207 owner/截止(P1) RQ-208 活动回归(P1)
 */

/* ================================================================== *
 * RQ-195 · 公网入口（M36 / P0）· P2 留存体验                          *
 * 公网不开，任何留存/获客动作在物理上不可执行；审计必须诚实报「未就绪」  *
 * 而不是假装开着——装开只会让用户拿到打不开的链接后永久流失。          *
 * ================================================================== */
describe('RQ-195 公网入口（P2 留存体验）', () => {
  it('RQ-195 · P2 · 三处文件全缺失时诚实报 ready:false 并给出待办清单（而非假装已开放）', () => {
    const r = auditPublicEntrypoint({ envText: '', nginxText: '', readmeText: '访问 http://localhost:8080' });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.length > 0, '未配置时必须有阻断项');
    assert.ok(r.pending.length > 0, '必须给出可执行的待办清单');
    assert.ok(r.note.includes('不可达'), '口径须明确「不可达」');
  });
});

/* ================================================================== *
 * RQ-196 · 免登录落地页（M36 / P0）· P2 留存体验                      *
 * 首次访客在「要不要注册」与「记录留多久」上得到诚实承诺，才会留下。    *
 * ================================================================== */
describe('RQ-196 落地页（P2 留存体验）', () => {
  it('RQ-196 · P2 · 首访文案显式给出「不注册也能练」与保留期承诺，并前置三件套', () => {
    const r = buildLandingCopy({ guestLimit: 5, guestDays: 7, userRetention: '长期保留' });
    const register = r.elements.find((e) => e.key === 'register');
    const retention = r.elements.find((e) => e.key === 'retention');
    assert.ok(register && register.body.includes('不注册'), '注册栏须明示可免登录');
    assert.ok(retention && retention.body.includes('保留'), '保留期承诺须可读');
    assert.equal(r.differentiators.length, 3, '三件套必须前置曝光');
    const keys = r.differentiators.map((d) => d.key).sort().join(',');
    assert.equal(keys, 'checkable,confidence,retention');
  });
});

/* ================================================================== *
 * RQ-197 · 首训引导闭环（M37 / P0）· P2 留存体验                     *
 * 闭环必须产出可读的「完成率」——用户走完一局能看到成绩卡，才谈得上续练。*
 * ================================================================== */
describe('RQ-197 首训闭环（P2 留存体验）', () => {
  it('RQ-197 · P2 · 四步均有数据时给出可验证完成率，且无断点（成绩卡可续）', () => {
    const r = summarizeGuideFunnel({
      first_training_enter: 10,
      first_training_start: 8,
      first_training_decision: 6,
      first_training_finish: 5,
    });
    assert.equal(r.dropAt, null, '四步不断点');
    assert.equal(r.summary.completionRate, 62.5, '完成率 = 5/8 = 62.5%');
    assert.ok(r.note.includes('可验证'), '口径须可验证而非空白');
  });
});

/* ================================================================== *
 * RQ-198 · 免登录练一次（M37 / P0）· P2 留存体验                     *
 * 游客 userId 必须归一为 null 而非 0——否则会话被算成 user 0 撞外键、   *
 * 成果丢失，等于把刚产生兴趣的用户赶走。                              *
 * ================================================================== */
describe('RQ-198 免登录练（P2 留存体验）', () => {
  it('RQ-198 · P2 · 游客 userId 归一为 null（不丢成果），且额度内给出唯一注册理由', () => {
    assert.equal(safeUserId(null), null, 'null → null，绝不变成 0');
    assert.equal(safeUserId(0), null, '0 不是合法用户，须归一为 null');
    assert.equal(safeUserId(3), 3, '合法登录用户保持不变');
    const q = guestQuota(0);
    assert.equal(q.allowed, true, '额度内允许免登录练');
    assert.ok(typeof q.signupReason === 'string' && q.signupReason.length > 0, '须有唯一、清晰的注册理由以承接留存');
  });
});

/* ================================================================== *
 * RQ-199 · 清理历史空跑 + is_test 打标（M38 / P1）· P2 留存体验       *
 * 空跑被识别并隔离（而非删除）——真实成果得以保留，指标分母不被稀释，   *
 * 用户对「我的完成率」的信任才站得住。                                *
 * ================================================================== */
describe('RQ-199 空跑打标（P2 留存体验）', () => {
  it('RQ-199 · P2 · 空跑被识别隔离、真实一局被保留（打标而非删除）', () => {
    const r = classifyEmptySessions([
      { id: 1, durationSec: 0.2, status: 'FINISHED', tradeCount: 0 }, // 点一下就结束 → 空跑
      { id: 2, durationSec: 120, status: 'FINISHED', tradeCount: 3 }, // 真实一局 → 保留
    ]);
    assert.equal(r.hits.length, 1, '仅 1 局被标为空跑');
    assert.deepEqual(r.sessionIds, [1], '只隔离空跑局，真实局不被误伤');
  });
});

/* ================================================================== *
 * RQ-200 · 埋点↔会话对账差异 = 0（M38 / P1）· P2 留存体验            *
 * 总数一致但方向相反的错误会被互相抵消；按 sessionId 双向对账才能       *
 * 让产品自己的数字可信——数字不可信，所有留存决策都是空谈。           *
 * ================================================================== */
describe('RQ-200 对账差异（P2 留存体验）', () => {
  it('RQ-200 · P2 · 双向对账能抓出「总数相同但方向相反」的漂移，保证指标可信', () => {
    const diverged = reconcileConsistency(
      [
        { id: 10, session_id: 5 },
        { id: 11, session_id: null }, // 埋点未携带 sessionId → 孤立
      ],
      [
        { session_id: 5 },
        { session_id: 6 }, // 业务表有、埋点无 → 漏报
      ]
    );
    assert.equal(diverged.ok, false, '漂移必须被判为不一致');
    assert.equal(diverged.matchedCount, 1, '仅 1 局真正匹配');
    assert.equal(diverged.orphanEvents.length, 1, '孤立埋点须暴露');
    assert.equal(diverged.missingEvents.length, 1, '漏报须暴露');

    const aligned = reconcileConsistency([{ id: 10, session_id: 5 }], [{ session_id: 5 }]);
    assert.equal(aligned.ok, true, '完全对齐时须判一致');
    assert.equal(aligned.matchedCount, 1);
  });
});

/* ================================================================== *
 * RQ-201 · 发布后验证固化（M38 / P1）· P2 留存体验                   *
 * 连续发布验证留痕，确保用户回来时看到的是「真的跑过验证」的版本，     *
 * 而非「写完没发 / 发了没验」的半成品。                              *
 * ================================================================== */
describe('RQ-201 验证固化（P2 留存体验）', () => {
  it('RQ-201 · P2 · 两个不同提交均验证通过才算连续达标；同提交重复跑不凑数', () => {
    const ok = verificationStreak([
      { git_commit: 'a1', ok: true },
      { git_commit: 'b2', ok: true },
    ]);
    assert.equal(ok.streak, 2);
    assert.equal(ok.ok, true);

    const dup = verificationStreak([
      { git_commit: 'a1', ok: true },
      { git_commit: 'a1', ok: true }, // 同一提交重复跑 → 去重后只算 1 次
    ]);
    assert.equal(dup.streak, 1, '同提交去重');
    assert.equal(dup.ok, false, '未达连续 2 次，发布闸门须拦下');
  });
});

/* ================================================================== *
 * RQ-202 · 身份口径纠偏（M39 / P1）· P2 留存体验                     *
 * 登录页/免责/README 三处口径一致，第一印象才不会被「虚拟仿真/交易大厅」*
 * 这类错位文案劝退——统一叙事是信任留存的第一步。                     *
 * ================================================================== */
describe('RQ-202 身份纠偏（P2 留存体验）', () => {
  it('RQ-202 · P2 · 合规口径（真实行情+模拟撮合）判 ok；含禁止误述则判违规', () => {
    const good = checkIdentityWording('我们用真实 A 股行情与模拟撮合做训练');
    assert.equal(good.ok, true);
    assert.deepEqual(good.forbiddenHits, []);
    assert.deepEqual(good.missingRequired, []);

    const bad = checkIdentityWording('这是一套虚拟仿真交易大厅');
    assert.equal(bad.ok, false);
    assert.ok(bad.forbiddenHits.includes('虚拟仿真'));
    assert.ok(bad.forbiddenHits.includes('交易大厅'));
  });
});

/* ================================================================== *
 * RQ-203 · 差异化叙事前置（M39 / P1）· P2 留存体验                   *
 * 三件套（可核对/可信度/保留期）在首访入口一致曝光，信任壁垒才立得住。 *
 * ================================================================== */
describe('RQ-203 三件套曝光（P2 留存体验）', () => {
  it('RQ-203 · P2 · 三件套全部曝光且口径一致（不藏任何一件）', () => {
    const r = auditThreePieceExposure({
      combined: '结算可核对、可信度护栏带置信区间、保留期长期保留',
    });
    assert.equal(r.allExposed, true, '三件套须全部曝光');
    assert.equal(r.exposedCount, 3);
    assert.equal(r.consistent, true, '三件要么一起出现要么一起缺失，不得只露两件');
  });
});

/* ================================================================== *
 * RQ-204 · 结算可核对产品化（M40 / P2）· P2 留存体验                 *
 * 审核结果须以「用户看得见、能自核」的诚实方式呈现（免责声明 + 规则 +  *
 * 自检结论），而不是藏在日志里——这是竞品全无的信任壁垒。            *
 * ================================================================== */
describe('RQ-204 结算可核对（P2 留存体验）', () => {
  it('RQ-204 · P2 · 审核结果对用户诚实呈现：自检通过时仍带免责声明与规则（可自核）', () => {
    const r = buildSettlementAudit({
      orders: [],
      rejections: [],
      session: { status: 'FINISHED' },
      bars: [],
    });
    assert.equal(r.audit.ok, true, '无偏离时方可声称逐笔可核对');
    assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, '须附免责声明');
    assert.ok(Array.isArray(r.rejections), '拒绝原因列表须可呈现');
    assert.ok(r.rules != null && r.slippageRule != null, '规则与滑点事实须曝光供自核');
  });
});

/* ================================================================== *
 * RQ-205 · 单次成绩可信度表达（M40 / P2）· P2 留存体验               *
 * 小样本时诚实展示「样本不足」护栏 + 仍能说的三件事，而不是编造胜率—— *
 * 诚实是留住用户的最强手段。                                        *
 * ================================================================== */
describe('RQ-205 可信度表达（P2 留存体验）', () => {
  it('RQ-205 · P2 · 小样本显式给「样本不足」护栏与三件事实，且禁止 edge 断言', () => {
    const r = buildSmallSampleFacts({
      sampleSize: 3,
      cost: { fee: 1.5 },
      behavior: {},
      benchmark: { returnPct: 2, buyHoldPct: 1.5 },
    });
    assert.equal(r.smallSample, true, '3 笔 < 护栏，须进入小样本表达');
    assert.ok(r.blockedAssertions.includes('胜率'), '须明确拦截胜率类 edge 断言');
    assert.ok(r.nextAction.label.includes('再积累'), '须给出可执行的下一步而非空白');
    assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, '须附样本量护栏说明');
    assert.equal(r.facts.length, 3, '仍可读成本/行为/对照三件事');

    const guard = assertNoEdgeAssertion('你的胜率是 67%', 3);
    assert.equal(guard.ok, false, '小样本下出现胜率断言须被判违规');
  });
});

/* ================================================================== *
 * RQ-206 · ≥5 外部真人首训实测（M36 / P0）· P2 留存体验              *
 * 真实用户走完有效训练，是留存最直接的证据；漏斗须给出达标判定。      *
 * ================================================================== */
describe('RQ-206 真人首训（P2 留存体验）', () => {
  it('RQ-206 · P2 · 外部漏斗达标（≥5 注册、≥2 有效完成）且无断点', () => {
    const r = summarizeExternalFunnel({ invited: 10, registered: 6, started: 5, effective: 3 });
    assert.equal(r.met, true, '6 注册 / 3 有效完成 已达标');
    assert.equal(r.dropAt, null, '全链路无断点');
    assert.equal(r.summary.registered, 6);
    assert.equal(r.summary.effective, 3);
  });
});

/* ================================================================== *
 * RQ-207 · 公网 owner 与截止日留存（M36 / P1）· P2 留存体验         *
 * 倒计时须可读出剩余天数——责任不悬空，用户看到团队在守承诺。        *
 * ================================================================== */
describe('RQ-207 owner/截止（P2 留存体验）', () => {
  it('RQ-207 · P2 · 截止日未到时给出可读剩余天数（责任可见、可问责）', () => {
    const r = countdownOf({ deadline: '2026-11-16', now: new Date('2026-11-08T12:00:00+08:00') });
    assert.equal(r.daysLeft, 8, '11-08 → 11-16 自然日差 8 天');
    assert.equal(r.expired, false);
    assert.ok(r.text.includes('还有 8 天'), '须可读出剩余天数口径');
  });
});

/* ================================================================== *
 * RQ-208 · 活动回归（M37 / P1）· P2 留存体验                        *
 * 活动未退化（每周有非自测训练且信号新鲜），用户回来时「屋内有人」。  *
 * ================================================================== */
describe('RQ-208 活动回归（P2 留存体验）', () => {
  it('RQ-208 · P2 · 活动健康时不报退化（用户回来仍有活人信号）', () => {
    const r = assessActivityRegression({ blindStartCount: 5, nonTestCount: 5, lastEventAgeHours: 3 });
    assert.equal(r.ok, true, '达标不报退化');
    assert.equal(r.reasons.length, 0);
    assert.ok(r.verdict.includes('正常'), '须给出健康结论');
  });
});
