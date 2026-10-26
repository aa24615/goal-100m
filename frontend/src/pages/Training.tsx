/**
 * 训练中心（RQ-92 首访直达 / RQ-93 门面 / RQ-94 看板与周报入口 / RQ-98 北极星 / RQ-104 站内提示）
 *
 * 这是 v8 之后的**默认首页**。它存在的理由只有一条：
 * 此前指标看板与训练周报的后端与 API 全齐，**页面零入口**（F-18），
 * 北极星与周报每天在生成，但没有任何人看得到。
 *
 * 三个 Tab 各自对应一个被点名的缺陷：
 *   首训 —— F-16（开始 4 次、决策 0 次）与 F-21（首访不指向训练）
 *   看板 —— F-18（有数据没入口）与 F-22（漏斗看不到断点）
 *   周报 —— F-18 / F-24（没有回来的理由）
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Card,
  Col,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import {
  ThunderboltOutlined,
  LineChartOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import {
  resumeBlind,
  startBlind,
  getNorthStar,
  getCheckup,
  getNotifications,
  getDashboard,
  getRetention,
  getFunnel,
  getWeeklyReport,
} from '../api';
import type {
  BlindResume,
  CheckupPayload,
  NorthStarPayload,
  InboxPayload,
  FunnelPayload,
} from '../types';
import FirstTrainingCard from '../components/FirstTrainingCard';
import Disclaimer from '../components/Disclaimer';
import { useIsMobile } from '../hooks/useIsMobile';
import { RATIO_GUARD_THRESHOLD, RESUME_HINT_PREFIX } from '../constants';

const { Text, Paragraph } = Typography;

/** RQ-104 已关闭提示的本地存储键（服务端不持久化 UI 状态） */
const DISMISS_KEY = 'mm8888.inbox.dismissed';

function loadDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveDismissed(list: string[]) {
  try {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式下 localStorage 不可用：提示会重复出现，但不影响功能 */
  }
}

/* ---------------- RQ-95 小样本护栏横幅 ---------------- */
function SampleGuardBanner({ checkup }: { checkup: CheckupPayload | null }) {
  if (!checkup) return null;
  const gate = checkup.ratioGate;
  const size = Number(checkup.sampleSize ?? 0);
  const threshold = gate?.threshold ?? RATIO_GUARD_THRESHOLD;
  const blocked = gate ? !gate.showRatios : size < RATIO_GUARD_THRESHOLD;
  if (!blocked) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="sample-guard-banner"
      message={`样本护栏：当前 ${size} 笔，未达 ${threshold} 笔`}
      description={gate?.reason || '样本不足时不展示胜率 / 期望值 / 排名类结论，只给出继续积累样本的动作。'}
    />
  );
}

/* ---------------- RQ-98 北极星 ---------------- */
function NorthStarPanel({ data }: { data: NorthStarPayload | null }) {
  if (!data) return null;
  return (
    <Card size="small" title="北极星" data-testid="north-star">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Statistic
            title={data.current.metric}
            value={data.current.value == null ? '—' : data.current.value}
            precision={data.current.value == null ? 0 : 2}
            suffix="%"
            valueStyle={{ color: '#0d9488' }}
          />
          <Text type="secondary" style={{ fontSize: 12 }} data-testid="north-star-current-note">
            {data.current.note}（目标：{data.current.target}）
          </Text>
        </Col>
        <Col xs={24} md={12}>
          <Statistic
            title={data.formal.metric}
            value={data.formal.enabled && data.formal.value != null ? data.formal.value : '—'}
            precision={data.formal.enabled && data.formal.value != null ? 2 : 0}
            suffix={data.formal.enabled ? '%' : ''}
          />
          <Tag color={data.formal.enabled ? 'green' : 'default'} data-testid="north-star-formal-tag">
            {data.formal.enabled ? '已启用' : '样本充足后启用'}
          </Tag>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }} data-testid="north-star-formal-reason">
              {data.formal.reason}
            </Text>
          </div>
        </Col>
      </Row>
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        {data.disclaimer}
      </Paragraph>
    </Card>
  );
}

/* ---------------- RQ-96 训练漏斗 ---------------- */
function FunnelPanel({ data }: { data: FunnelPayload | null }) {
  if (!data) return <Card size="small" title="训练漏斗">加载中…</Card>;
  const max = Math.max(1, ...data.steps.map((s) => s.count || 0));
  return (
    <Card size="small" title="训练漏斗（按会话）" data-testid="funnel-panel">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {data.steps.map((s) => (
          <div key={s.key}>
            <Space size={8}>
              <Text style={{ minWidth: 120, fontSize: 13 }}>{s.label}</Text>
              <Text strong data-testid={`funnel-count-${s.key}`}>
                {s.count || 0}
              </Text>
            </Space>
            <Progress
              percent={Math.round(((s.count || 0) / max) * 100)}
              size="small"
              showInfo={false}
            />
          </div>
        ))}
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="funnel-conversion">
          开始→首次决策 {data.conversion.startToFirstDecision ?? '—'}% ｜ 首次决策→完成{' '}
          {data.conversion.firstToFinish ?? '—'}%
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="funnel-timing">
          开始→首次决策中位耗时 {data.timing.medianSecToFirstDecision ?? '—'} 秒（预算{' '}
          {data.timing.budgetSec} 秒，达标 {data.timing.withinBudgetCount} 次）
        </Text>
        <Table
          size="small"
          rowKey={(r) => `${r.sessionId}-${r.reached}`}
          pagination={{ pageSize: 5 }}
          dataSource={data.sessions}
          locale={{ emptyText: '窗口内还没有训练会话' }}
          columns={[
            { title: '会话', dataIndex: 'sessionId', width: 80 },
            { title: '到达', dataIndex: 'reachedLabel' },
            {
              title: '断点',
              dataIndex: 'breakpointLabel',
              render: (v: string | null) => (v ? <Tag color="orange">{v}</Tag> : <Tag>已走完</Tag>),
            },
            { title: '决策数', dataIndex: 'decisions', width: 80 },
            {
              title: '首次决策(秒)',
              dataIndex: 'secToFirstDecision',
              width: 110,
              render: (v: number | null) => (v == null ? '—' : v),
            },
          ]}
        />
      </Space>
    </Card>
  );
}

export default function Training() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const isMobile = useIsMobile();

  const [tab, setTab] = useState('start');
  const [starting, setStarting] = useState(false);
  const [resume, setResume] = useState<BlindResume | null>(null);
  const [north, setNorth] = useState<NorthStarPayload | null>(null);
  const [checkup, setCheckup] = useState<CheckupPayload | null>(null);
  const [inbox, setInbox] = useState<InboxPayload | null>(null);
  const [funnel, setFunnel] = useState<FunnelPayload | null>(null);
  const [dash, setDash] = useState<Record<string, unknown> | null>(null);
  const [retention, setRetention] = useState<Record<string, unknown> | null>(null);
  const [weekly, setWeekly] = useState<Record<string, unknown> | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);

  const loadBase = useCallback(async () => {
    const [r, n, c] = await Promise.all([
      resumeBlind().catch(() => ({ data: { resumable: false, hint: { resumable: false, text: '' }, session: null, view: null, bars: null } as BlindResume })),
      getNorthStar().catch(() => ({ data: null })),
      getCheckup().catch(() => ({ data: null })),
    ]);
    setResume(r.data as BlindResume);
    setNorth((n.data as NorthStarPayload) || null);
    setCheckup((c.data as CheckupPayload) || null);
  }, []);

  const loadInbox = useCallback(async (off: string[]) => {
    try {
      const r = await getNotifications(off);
      setInbox(r.data);
    } catch {
      setInbox(null);
    }
  }, []);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  useEffect(() => {
    loadInbox(dismissed);
  }, [dismissed, loadInbox]);

  useEffect(() => {
    if (tab !== 'board') return;
    Promise.all([
      getDashboard({ days: 30 }).catch(() => ({ data: null })),
      getRetention({ days: 30 }).catch(() => ({ data: null })),
      getFunnel({ days: 30 }).catch(() => ({ data: null })),
    ]).then(([d, r, f]) => {
      setDash(d.data as Record<string, unknown> | null);
      setRetention(r.data as Record<string, unknown> | null);
      setFunnel(f.data as FunnelPayload | null);
    });
  }, [tab]);

  useEffect(() => {
    if (tab !== 'weekly') return;
    getWeeklyReport({ days: 7 })
      .then((r) => setWeekly(r.data as Record<string, unknown>))
      .catch(() => setWeekly(null));
  }, [tab]);

  const startTraining = async () => {
    setStarting(true);
    try {
      const r = await startBlind({ bars: 60 });
      message.success('已抽好一段真实历史行情');
      navigate(`/blind?session=${r.data.id}&first=1`);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '开训失败');
    } finally {
      setStarting(false);
    }
  };

  const resumeHint = resume?.hint;
  const canResume = Boolean(resume?.resumable && resumeHint?.text);

  return (
    <div className={isMobile ? 'blind-mobile' : undefined}>
      <Disclaimer />

      {/* RQ-91 断点提示：回到首页就能看到「上次停在第 N 根」，并给出继续 / 放弃两个出口 */}
      {canResume && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="resume-hint"
          message={resumeHint?.text}
          description={
            <Space wrap>
              <a
                data-testid="resume-go"
                onClick={() => navigate(`/blind?session=${resumeHint?.sessionId}`)}
              >
                继续训练
              </a>
              <a data-testid="resume-abandon" onClick={() => navigate(`/blind?abandon=${resumeHint?.sessionId}`)}>
                放弃这段
              </a>
            </Space>
          }
        />
      )}

      {/* RQ-104 站内提示：出现一次、可关闭 */}
      {(inbox?.items || []).length > 0 && (
        <div data-testid="inbox">
          {inbox!.items.map((it) => (
            <Alert
              key={it.key}
              type={it.kind === 'milestone' ? 'success' : 'info'}
              showIcon
              closable
              style={{ marginBottom: 8 }}
              data-testid={`inbox-${it.kind}`}
              message={it.title}
              description={
                <>
                  <div>{it.body}</div>
                  {it.cannot && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {it.cannot}
                    </Text>
                  )}
                </>
              }
              onClose={() => {
                const next = [...dismissed, it.key];
                setDismissed(next);
                saveDismissed(next);
              }}
            />
          ))}
        </div>
      )}

      <SampleGuardBanner checkup={checkup} />

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'start',
            label: (
              <span>
                <ThunderboltOutlined /> 首训
              </span>
            ),
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <FirstTrainingCard
                  hasRunningSession={canResume}
                  loading={starting}
                  onStart={startTraining}
                  isMobile={isMobile}
                />
                <NorthStarPanel data={north} />
              </Space>
            ),
          },
          {
            key: 'board',
            label: (
              <span>
                <LineChartOutlined /> 看板
              </span>
            ),
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <FunnelPanel data={funnel} />
                <Card size="small" title="活跃与事件量" data-testid="dashboard-panel">
                  {dash ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      窗口 {String((dash as any).days ?? '—')} 天 · 粒度{' '}
                      {String((dash as any).granularity ?? '—')} · 分桶{' '}
                      {Array.isArray((dash as any).buckets) ? (dash as any).buckets.length : 0} 个
                    </Text>
                  ) : (
                    <Text type="secondary">暂无看板数据</Text>
                  )}
                </Card>
                <Card size="small" title="N 日留存" data-testid="retention-panel">
                  {(() => {
                    const ns = (retention as any)?.northStar;
                    return (
                      <Text type="secondary" style={{ fontSize: 12 }} data-testid="retention-note">
                        {ns?.note || '暂无留存数据'}
                        {!ns?.observable && ' （当前不可读，见上方北极星说明）'}
                      </Text>
                    );
                  })()}
                </Card>
              </Space>
            ),
          },
          {
            key: 'weekly',
            label: (
              <span>
                <CalendarOutlined /> 周报
              </span>
            ),
            children: (() => {
              const w = weekly as any;
              return (
                <Card size="small" title="每周训练周报" data-testid="weekly-panel">
                  {!w && <Text type="secondary">暂无周报数据</Text>}
                  {w && (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 12 }} data-testid="weekly-window">
                        窗口 {w.window?.from} ~ {w.window?.to}
                      </Text>
                      <Statistic
                        title="本周训练段数"
                        value={w.segments?.thisWeek ?? 0}
                        suffix={`（上周 ${w.segments?.lastWeek ?? 0}）`}
                      />
                      <Text style={{ fontSize: 13 }} data-testid="weekly-discipline">
                        {w.discipline?.note || '—'}
                      </Text>
                      <Text style={{ fontSize: 13 }} data-testid="weekly-next-tier">
                        {w.nextTier?.text || '—'}
                      </Text>
                      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                        {w.disclaimer}
                      </Paragraph>
                    </Space>
                  )}
                </Card>
              );
            })(),
          },
        ]}
      />
    </div>
  );
}
