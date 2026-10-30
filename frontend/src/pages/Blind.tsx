/**
 * 双盲训练场（RQ-66 双盲 / RQ-67 随机来一段 / RQ-38 强制决策记录 / RQ-41 成绩）
 *
 * 界面硬约束（验收标准）：**训练全程不得出现标的代码 / 名称 / 日期**。
 * 因此本页只渲染后端返回的 `alias` 与相对序号，不订阅行情快照、不跳个股详情，
 * 也不使用任何带 code 的字段——包括持仓与成交列表（后端已按 alias 覆盖）。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Card,
  Button,
  Space,
  Tag,
  Typography,
  InputNumber,
  Radio,
  Input,
  Modal,
  Progress,
  Alert,
  Statistic,
  Divider,
  Table,
  App as AntApp,
} from 'antd';
import { ThunderboltOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import {
  startBlind,
  getBlind,
  stepBlind,
  submitDecision,
  tradeBlind,
  finishBlind,
  resumeBlind,
  abandonBlind,
  getScoreCard,
  getSettlement,
  getSettlementAudit,
  getDualBaseline,
  settlementAuditCsvUrl,
} from '../api';
import SettlementSheet from '../components/SettlementSheet';
import SettlementAuditPanel from '../components/SettlementAuditPanel';
import { Select } from 'antd';
import type {
  BlindSession,
  BlindView,
  BlindScore,
  MaskedBar,
  BlindDecision,
  SegmentTag,
  Granularity,
  ResumeHint,
  ScoreCardPayload,
  SettlementPayload,
  SettlementAuditPayload,
  DualBaselinePayload,
  SessionPreset,
  EffectiveCompletionPayload,
} from '../types';
import { track } from '../utils/monitor';
import Disclaimer from '../components/Disclaimer';
import ScoreCard from '../components/ScoreCard';
import { formatMoney, formatNum, formatPct } from '../utils';
import { useIsMobile } from '../hooks/useIsMobile';
import api from '../api';

const { Title, Text, Paragraph } = Typography;
const DECISION_INTERVAL = 10;

export default function Blind() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { message, modal } = AntApp.useApp();
  // RQ-84 手机端：竖屏 / 单手 / 大按钮 / 不横向滚动
  const isMobile = useIsMobile();
  // RQ-82 片段类型筛选；RQ-81 粒度明示
  const [tags, setTags] = useState<SegmentTag[]>([]);
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [granularities, setGranularities] = useState<Granularity[]>([]);
  /**
   * RQ-146 局长度档位：默认 quick（12 根）。
   * 档位列表从服务端 `/blind/dict` 或 start 响应里取，不在前端硬编码 60。
   */
  const [presets, setPresets] = useState<SessionPreset[]>([]);
  const [preset, setPreset] = useState<string>('quick');
  const [session, setSession] = useState<BlindSession | null>(null);
  const [view, setView] = useState<BlindView | null>(null);
  const [bars, setBars] = useState<MaskedBar[]>([]);
  const [score, setScore] = useState<BlindScore | null>(null);
  const [qty, setQty] = useState(100);
  const [busy, setBusy] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decision, setDecision] = useState<{ action: 'BUY' | 'SELL' | 'HOLD'; reason: string; stopPlan?: number }>({
    action: 'HOLD',
    reason: '',
  });

  // RQ-91 断点提示；RQ-92 首训引导；RQ-99 成绩卡
  const [resumeHint, setResumeHint] = useState<ResumeHint | null>(null);
  const [card, setCard] = useState<ScoreCardPayload | null>(null);
  const [settlement, setSettlement] = useState<SettlementPayload | null>(null);
  // RQ-147 有效完成判定：未达门槛时不出成绩卡，改出「再来一次」（F-80）
  const [effective, setEffective] = useState<EffectiveCompletionPayload | null>(null);
  // RQ-150 结算口径说明书（审计层）与 RQ-137 双基准
  const [audit, setAudit] = useState<SettlementAuditPayload | null>(null);
  const [baseline, setBaseline] = useState<DualBaselinePayload | null>(null);
  const sessionParam = Number(params.get('session') || 0);
  const firstParam = params.get('first') === '1';
  const abandonParam = Number(params.get('abandon') || 0);

  // RQ-82 拉取服务端字典而不是把四类标签硬编码在前端，避免前后端口径漂移
  useEffect(() => {
    api
      .get<{ tags: SegmentTag[]; granularities: Granularity[] }>('/blind/tags')
      .then((r) => {
        setTags(r.data.tags || []);
        setGranularities(r.data.granularities || []);
      })
      .catch(() => {
        setTags([]);
        setGranularities([]);
      });
    // RQ-146 局长度档位：缺省 12 根；长局（60 根）作为可选项而不是默认
    api
      .get<{ presets?: SessionPreset[] }>('/blind/presets')
      .then((r) => {
        const list = (r.data.presets || []).filter((p) => !p.advanced);
        if (list.length) {
          setPresets(list);
          const d = list.find((p) => p.default) || list[0];
          // 守护：默认档位必须 ≤15 根，否则首训仍然是一局长局
          if (d && d.bars <= 15) setPreset(d.key);
        }
      })
      .catch(() => setPresets([]));
  }, []);

  const load = async (id: number) => {
    const r = await getBlind(id);
    setSession(r.data.session);
    setView(r.data.view);
    setBars(r.data.bars);
  };

  /**
   * RQ-91 进入页面时的恢复顺序：
   *   ?abandon=ID → 放弃这段；
   *   ?session=ID → 恢复指定会话（首训引导从训练中心跳转过来时带 first=1）；
   *   都没有      → 查一次断点续做，有就给「上次停在第 N 根」并直接接着练。
   * 这样「关掉页面再回来」不需要用户做任何额外操作。
   */
  useEffect(() => {
    const boot = async () => {
      try {
        if (abandonParam) {
          await abandonBlind(abandonParam);
          setResumeHint(null);
          setParams({}, { replace: true });
          return;
        }
        if (sessionParam) {
          await load(sessionParam);
          if (firstParam) track('first_training_start', { sessionId: sessionParam });
          return;
        }
        const r = await resumeBlind();
        setResumeHint(r.data.hint?.text ? r.data.hint : r.data.resumable ? r.data.hint : null);
        if (r.data.resumable && r.data.session) {
          await load(r.data.session.id);
          track('blind_resume', { sessionId: r.data.session.id });
        }
      } catch {
        /* 续做查询失败不应阻断手动开训 */
      }
    };
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionParam, abandonParam, firstParam]);

  const start = async () => {
    setBusy(true);
    try {
      /**
       * RQ-146 首训默认短局（≤15 根）。
       * 此前这里硬编码 `bars: 60`，是「一局要 6 次判断、三个会话全部半途而废」的直接来源（F-79）。
       * 现在默认走后端 quick 档（12 根 / 1–2 次判断），长局由用户在页面上显式切换。
       */
      const r = await startBlind({ preset, tag });
      setSession({
        id: r.data.id,
        alias: r.data.alias,
        code: null,
        name: null,
        status: r.data.status,
        startSeq: null,
        endSeq: null,
        totalBars: r.data.totalBars,
      });
      setScore(null);
      await load(r.data.id);
      message.success('已随机抽取一段真实历史行情，标的与日期已隐藏');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '生成盲测片段失败');
    } finally {
      setBusy(false);
    }
  };

  // 每推进到决策点，弹出决策记录（可跳过，但记为「未记录」→ 计入纪律执行率）
  useEffect(() => {
    if (!view || view.atEnd) return;
    const atPoint = view.cursorIndex > 0 && (view.cursorIndex - 1) % DECISION_INTERVAL === 0;
    if (atPoint && !view.decisions?.some((d: BlindDecision) => d.seq === 0)) {
      // 用「已记录条数 < 应到决策点数」判断是否需要补记，避免重复弹窗
      const expected = Math.floor((view.cursorIndex - 1) / DECISION_INTERVAL) + 1;
      const recorded = view.decisions?.length || 0;
      if (recorded < expected) setDecisionOpen(true);
    }
  }, [view]);

  const step = async (action: 'next' | 'prev') => {
    if (!session) return;
    try {
      const r = await stepBlind(session.id, action);
      setView(r.data.view);
      setBars(r.data.bars);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '推进失败');
    }
  };

  const doTrade = async (side: 'BUY' | 'SELL') => {
    if (!session) return;
    try {
      const r = await tradeBlind(session.id, side, qty);
      setView(r.data.view);
      setBars(r.data.bars);
      message.success(`${side === 'BUY' ? '买入' : '卖出'} ${qty} 股`);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '下单失败');
    }
  };

  const doDecision = async (skipped: boolean) => {
    if (!session) return;
    try {
      await submitDecision(session.id, {
        action: decision.action,
        reason: skipped ? '' : decision.reason,
        stopPlan: decision.stopPlan,
        skipped,
      });
      track('blind_decision', { skipped });
      if (firstParam) track('first_training_decision', { skipped });
      setDecisionOpen(false);
      setDecision({ action: 'HOLD', reason: '' });
      await load(session.id);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '记录失败');
    }
  };

  const finish = async () => {
    if (!session) return;
    try {
      const r = await finishBlind(session.id, firstParam);
      setScore(r.data.score);
      setSession(r.data.session);
      setView(r.data.view);
      /**
       * RQ-147：有效完成判定优先于一切展示。
       * 未达门槛（0 笔成交 / 走太快 / 没走完）时**不取成绩卡**，
       * 否则用户会拿到一张「成交 0 笔、纪律执行率 100%」的自相矛盾卡片（F-80）。
       */
      const eff = (r.data as any)?.effective || null;
      setEffective(eff);
      if (!eff || eff.scoreCard?.show !== false) {
        try {
          const c = await getScoreCard(session.id);
          setCard(c.data);
        } catch {
          setCard(null);
        }
      } else {
        setCard(null);
      }
      // RQ-125 结算口径说明书：让用户能逐笔复核成交价与费用，而不是选择相信我们
      try {
        const st = await getSettlement(session.id);
        setSettlement(st.data);
      } catch {
        setSettlement(null);
      }
      // RQ-150 审计层：撮合价溯源 + 拒绝原因归类（差异清单 ≥5 条，可一键复制）
      try {
        const a = await getSettlementAudit(session.id);
        setAudit(a.data);
      } catch {
        setAudit(null);
      }
      // RQ-137 双基准：买入持有 + 随机入场（运气基准）
      try {
        const b = await getDualBaseline(session.id, 0);
        setBaseline(b.data);
      } catch {
        setBaseline(null);
      }
      message.success(
        eff && eff.effective === false ? '训练结束，但本局未达有效完成门槛' : '训练结束，已揭示标的身份'
      );
    } catch (e: any) {
      message.error(e?.response?.data?.error || '生成成绩失败');
    }
  };

  const visible = bars.filter((b) => b.i <= (view?.cursorIndex ?? 0));
  const last = visible[visible.length - 1];
  // RQ-92 首训引导：只在「首次进入且还没做过任何决策」时出现，做完第一次就消失
  const guided = firstParam && (view?.decisions?.length ?? 0) === 0;

  return (
    <div className={isMobile ? 'blind-mobile' : undefined}>
      <Disclaimer />
      <Card
        title={
          <Space>
            <EyeInvisibleOutlined />
            <span>双盲训练 · {session ? session.alias : '未开始'}</span>
            {session && <Tag color={session.status === 'FINISHED' ? 'default' : 'blue'}>{session.status === 'FINISHED' ? '已结束' : '进行中'}</Tag>}
          </Space>
        }
        extra={
          <Space wrap>
            {/* RQ-82 按片段特征定向抽取 */}
            <Select
              allowClear
              placeholder="随机（不限类型）"
              value={tag}
              onChange={setTag}
              style={{ width: isMobile ? 120 : 150 }}
              options={tags.map((t) => ({ label: t.label, value: t.key }))}
              data-testid="blind-tag-select"
            />
            {/* RQ-146 局长度：默认快局（12 根），长局可选但不是默认 */}
            <Select
              value={preset}
              onChange={setPreset}
              style={{ width: isMobile ? 96 : 110 }}
              data-testid="blind-preset-select"
              options={(presets.length
                ? presets
                : [{ key: 'quick', label: '快局', bars: 12 }, { key: 'standard', label: '标准局', bars: 60 }]
              ).map((p) => ({
                label: `${p.label}（${p.bars} 根）`,
                value: p.key,
              }))}
            />
            <Button icon={<ThunderboltOutlined />} type="primary" loading={busy} onClick={start} data-testid="blind-start">
              随机来一段
            </Button>
            <Button onClick={() => navigate('/replay')}>回放训练</Button>
          </Space>
        }
      >
        {/* RQ-81 粒度明示：分钟级数据不可得时必须说清楚，不能让用户以为在练日内 */}
        {granularities.length > 0 && (
          <Alert
            type="info"
            showIcon={false}
            style={{ marginBottom: 12, fontSize: 12 }}
            data-testid="blind-granularity-note"
            message={`当前训练粒度：日线（${granularities
              .filter((g) => g.available)
              .map((g) => g.label)
              .join(' / ')}）。${granularities.find((g) => !g.available)?.note || ''}`}
          />
        )}
        {!session && (
          <Alert
            type="info"
            showIcon
            message="怎么练？"
            description="系统会随机抽取一段真实 A 股历史行情，隐藏标的代码、名称与日期，只给你 K 线与成交量。每 10 根 K 线会要求你记录一次判断（买/卖/观望 + 理由 + 计划止损），结束后完整揭示并给出「你当时的判断 vs 事后走势」。"
          />
        )}

        {/* RQ-91 断点提示：明确告知「上次停在第 N 根」，而不是让进度静默消失 */}
        {resumeHint?.resumable && resumeHint.text && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            data-testid="blind-resume-hint"
            message={resumeHint.text}
            description={
              <Space wrap>
                <a data-testid="blind-resume-abandon" onClick={() => setParams({ abandon: String(resumeHint.sessionId || '') })}>
                  放弃这段
                </a>
              </Space>
            }
          />
        )}

        {session && view && (
          <>
            {/* RQ-92 引导式第一次决策：系统给局面，用户只做一个选择（≤3 次点击） */}
            {guided && (
              <Card
                size="small"
                style={{ marginBottom: 12 }}
                data-testid="guided-decision"
                title="第一次判断：看走势，选一个方向"
              >
                <Space wrap>
                  {(['BUY', 'SELL', 'HOLD'] as const).map((a) => (
                    <Button
                      key={a}
                      size={isMobile ? 'large' : 'middle'}
                      type={decision.action === a ? 'primary' : 'default'}
                      data-testid={`guided-${a.toLowerCase()}`}
                      onClick={() => setDecision((d) => ({ ...d, action: a }))}
                    >
                      {a === 'BUY' ? '买' : a === 'SELL' ? '卖' : '观望'}
                    </Button>
                  ))}
                </Space>
                <Input.TextArea
                  rows={2}
                  style={{ marginTop: 8 }}
                  placeholder="为什么？（可留空，留空会被记为「未记录」并计入纪律执行率）"
                  value={decision.reason}
                  onChange={(e) => setDecision((d) => ({ ...d, reason: e.target.value }))}
                />
                <Button
                  type="primary"
                  block={isMobile}
                  style={{ marginTop: 8 }}
                  data-testid="guided-submit"
                  onClick={() => doDecision(false)}
                >
                  提交第一次判断
                </Button>
              </Card>
            )}

            <Space wrap style={{ marginBottom: 12 }}>
              <Tag icon={<EyeInvisibleOutlined />} color="blue" data-testid="blind-alias">
                {view.alias}（身份已隐藏）
              </Tag>
              <Text type="secondary">
                进度 {view.cursorIndex} / {view.totalBars} 根
              </Text>
              {last && last.close != null && (
                <Text strong data-testid="blind-last-close">
                  最新 ¥{formatNum(last.close)}
                </Text>
              )}
            </Space>
            <Progress percent={Math.round((view.cursorIndex / Math.max(1, view.totalBars)) * 100)} size="small" />

            {/* RQ-84 手机端：竖屏下改为纵向大按钮，单手可达，且不产生横向滚动 */}
            <Space
              direction={isMobile ? 'vertical' : 'horizontal'}
              wrap={!isMobile}
              style={{ margin: '12px 0', width: isMobile ? '100%' : undefined }}
            >
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                onClick={() => step('prev')}
                disabled={view.cursorIndex <= 1}
                data-testid="blind-prev"
              >
                上一根
              </Button>
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                type="primary"
                onClick={() => step('next')}
                disabled={view.atEnd}
                data-testid="blind-next"
              >
                下一根
              </Button>
              <InputNumber
                min={100}
                step={100}
                value={qty}
                onChange={(v) => setQty(Number(v) || 100)}
                style={{ width: isMobile ? '100%' : undefined }}
                size={isMobile ? 'large' : 'middle'}
              />
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                onClick={() => doTrade('BUY')}
                data-testid="blind-buy"
              >
                买入
              </Button>
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                onClick={() => doTrade('SELL')}
                data-testid="blind-sell"
              >
                卖出
              </Button>
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                onClick={() => setDecisionOpen(true)}
                data-testid="blind-decision-open"
              >
                记录决策
              </Button>
              <Button
                block={isMobile}
                size={isMobile ? 'large' : 'middle'}
                danger
                onClick={finish}
                disabled={session.status === 'FINISHED'}
                data-testid="blind-finish"
              >
                结束并揭示
              </Button>
            </Space>

            <Space size="large" wrap style={{ marginBottom: 12 }}>
              <Statistic title="现金" value={view.cash} precision={2} prefix="¥" />
              <Statistic title="交易次数" value={view.tradeCount} />
              <Statistic title="已实现盈亏" value={view.realizedTotal} precision={2} prefix="¥" />
              <Statistic title="最大回撤" value={view.maxDrawdown} precision={2} suffix="%" />
            </Space>

            {/* RQ-84 手机端只保留「序号 / 收 / 量」三列：
                六列在竖屏必然溢出产生横向滚动，而横向滚动会让 K 线与按钮区互相打架。 */}
            <Table
              size="small"
              rowKey="i"
              pagination={{ pageSize: isMobile ? 5 : 8, size: isMobile ? 'small' : 'default' }}
              dataSource={visible.slice().reverse()}
              scroll={isMobile ? undefined : undefined}
              columns={
                isMobile
                  ? [
                      { title: '序号', dataIndex: 'i', width: 60 },
                      { title: '收', dataIndex: 'close', render: (v: number) => formatNum(v) },
                      { title: '量', dataIndex: 'volume', render: (v: number) => (v == null ? '—' : v.toLocaleString('zh-CN')) },
                    ]
                  : [
                      { title: '序号', dataIndex: 'i', width: 70 },
                      { title: '开', dataIndex: 'open', render: (v: number) => formatNum(v) },
                      { title: '高', dataIndex: 'high', render: (v: number) => formatNum(v) },
                      { title: '低', dataIndex: 'low', render: (v: number) => formatNum(v) },
                      { title: '收', dataIndex: 'close', render: (v: number) => formatNum(v) },
                      { title: '量', dataIndex: 'volume' },
                    ]
              }
              locale={{ emptyText: '点击「下一根」开始推进行情' }}
            />

            {view.decisions && view.decisions.length > 0 && (
              <>
                <Divider orientation="left">决策记录</Divider>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {view.decisions.map((d) => (
                    <Text key={d.id} type={d.skipped ? 'secondary' : undefined}>
                      · 第 {d.seq} 根：{d.action === 'BUY' ? '买' : d.action === 'SELL' ? '卖' : '观望'}
                      {d.skipped ? '（未记录）' : ` —— ${d.reason}`}
                    </Text>
                  ))}
                </Space>
              </>
            )}
          </>
        )}

        {score && (
          <>
            <Divider orientation="left">
              <Space>
                <EyeOutlined /> 已揭示
              </Space>
            </Divider>
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="blind-reveal"
              message={`这段行情来自 ${session?.name}（${session?.code}）`}
              description={`日期区间对应 K 线序号 ${session?.startSeq} ~ ${session?.endSeq}，可在回放训练中按同一区间复盘。`}
            />
            <Space size="large" wrap>
              <Statistic title="收益率" value={score.returnPct} precision={2} suffix="%" valueStyle={{ color: score.returnPct >= 0 ? '#e0584f' : '#2fa06a' }} />
              <Statistic title="最大回撤" value={score.maxDrawdown} precision={2} suffix="%" />
              <Statistic title="交易次数" value={score.tradeCount} />
              <Statistic title="用时" value={score.durationSec ?? 0} suffix="秒" />
              <Statistic
                title="纪律执行率"
                value={score.disciplineRate == null ? '—' : score.disciplineRate}
                precision={score.disciplineRate == null ? 0 : 2}
                suffix={score.disciplineRate == null ? '' : '%'}
              />
            </Space>
            <Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
              {score.sampleNote}
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              纪律执行率 = 已写理由或计划止损的决策点 ÷ 全部决策点。{score.disclaimer}
            </Paragraph>
            {/* RQ-147 未达有效完成门槛：出「再来一次」而不是一张 0 笔成交的成绩卡 */}
            {effective && effective.scoreCard?.show === false && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                data-testid="blind-effective-gate"
                message={effective.scoreCard.fallback?.title || '这一局未达有效完成门槛'}
                description={
                  <div>
                    <div>{effective.scoreCard.fallback?.body}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>{effective.note}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                      门槛：至少 {effective.rules?.minTrades} 笔成交 · 走完全部 K 线 · 耗时不少于{' '}
                      {effective.rules?.minDurationSec} 秒
                    </div>
                    <Button
                      style={{ marginTop: 8 }}
                      data-testid="blind-effective-retry"
                      onClick={() => {
                        setScore(null);
                        setSession(null);
                        setView(null);
                        setBars([]);
                        setEffective(null);
                        setAudit(null);
                        setBaseline(null);
                        void start();
                      }}
                    >
                      {effective.scoreCard.fallback?.cta || '再来一局'}
                    </Button>
                  </div>
                }
              />
            )}
            {/* RQ-99 成绩卡：可复制带走的单次结论（仅在有效完成时展示） */}
            {(!effective || effective.scoreCard?.show !== false) && (
              <div style={{ marginTop: 12 }}>
                <ScoreCard data={card} isMobile={isMobile} />
              </div>
            )}
            {/* RQ-125 本局结算口径：逐笔可核对（I-13 / F-53） */}
            <div style={{ marginTop: 12 }}>
              <SettlementSheet data={settlement} />
            </div>
            {/* RQ-150 结算口径说明书 · 审计层：为什么是这个价 / 扣了多少费 / 为什么被拒 */}
            <div style={{ marginTop: 12 }}>
              <SettlementAuditPanel data={audit} sessionId={session?.id ?? null} />
            </div>
            {/* RQ-137 双基准：跑赢「一直拿着」还不够，还要跑赢「闭眼随便挑一天」 */}
            {baseline && baseline.verdict && (
              <Alert
                type={baseline.verdict.conclusive ? 'success' : 'info'}
                showIcon={false}
                style={{ marginTop: 12 }}
                data-testid="blind-dual-baseline"
                message="双基准对照"
                description={
                  <>
                    <div>{baseline.verdict.text}</div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>{baseline.method}</div>
                  </>
                }
              />
            )}
          </>
        )}
      </Card>

      <Modal
        open={decisionOpen}
        title="记录这一刻的判断"
        onCancel={() => doDecision(true)}
        okText="提交"
        cancelText="跳过（记为未记录）"
        onOk={() => doDecision(false)}
        data-testid="blind-decision-modal"
      >
        <Radio.Group
          value={decision.action}
          onChange={(e) => setDecision((d) => ({ ...d, action: e.target.value }))}
          style={{ marginBottom: 12 }}
        >
          <Radio value="BUY">买</Radio>
          <Radio value="SELL">卖</Radio>
          <Radio value="HOLD">观望</Radio>
        </Radio.Group>
        <Input.TextArea
          rows={3}
          placeholder="为什么这么做？（必填；不写会被记为「未记录」，影响纪律执行率）"
          value={decision.reason}
          onChange={(e) => setDecision((d) => ({ ...d, reason: e.target.value }))}
        />
        <InputNumber
          style={{ marginTop: 12, width: '100%' }}
          placeholder="计划止损价（选填）"
          min={0}
          step={0.01}
          value={decision.stopPlan}
          onChange={(v) => setDecision((d) => ({ ...d, stopPlan: v == null ? undefined : Number(v) }))}
        />
      </Modal>
    </div>
  );
}
