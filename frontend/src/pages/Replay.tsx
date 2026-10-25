import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  App,
  Empty,
  Descriptions,
} from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import api, {
  getReplayRange,
  startReplay,
  stepReplay,
  tradeReplay,
  finishReplay,
  listReplays,
  compareReplays,
  getStockDaily,
} from '../api';
import type { DailyBar, ReplaySession, ReplayState, ReplayScore } from '../types';
import { formatMoney, formatNum, formatPct } from '../utils';
import KLineChart from '../components/KLineChart';
import Disclaimer from '../components/Disclaimer';
import { track } from '../utils/monitor';
import { REPLAY_SPEEDS } from '../constants';

const { Title, Text } = Typography;

// 行情时间机器（RQ-01 ~ RQ-06）
// 播放器的「倍速 / 暂停 / 单步 / 倒带」由前端控制节奏，服务端保证任意 cursor 的状态唯一可复现。
const BASE_TICK_MS = 2000;

export default function Replay() {
  const { message } = App.useApp();
  const [range, setRange] = useState<{ minSeq: number; maxSeq: number; hasData: boolean } | null>(null);
  const [bounds, setBounds] = useState<[number, number]>([1, 20]);
  const [capital, setCapital] = useState<number>(1000000);
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [state, setState] = useState<ReplayState | null>(null);
  const [code, setCode] = useState<string>('');
  const [bars, setBars] = useState<DailyBar[]>([]);
  const [marks, setMarks] = useState<{ seq: number; label: string; side: 'BUY' | 'SELL' }[]>([]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [qty, setQty] = useState<number>(100);
  const [history, setHistory] = useState<ReplaySession[]>([]);
  const [compare, setCompare] = useState<{ id: number; startedAt: string; result: ReplayScore | null }[]>([]);
  const [score, setScore] = useState<ReplayScore | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    getReplayRange()
      .then((r) => {
        setRange({ minSeq: r.data.minSeq ?? 0, maxSeq: r.data.maxSeq ?? 0, hasData: r.data.hasData });
        const min = r.data.minSeq ?? 1;
        const max = r.data.maxSeq ?? 20;
        // 默认取最近 20 个交易日，避免一次拉太多
        setBounds([Math.max(min, max - 19), max]);
      })
      .catch(() => setRange({ minSeq: 0, maxSeq: 0, hasData: false }));
    listReplays().then((r) => setHistory(r.data)).catch(() => setHistory([]));
    api.get('/stocks').then((r) => setCode(r.data[0]?.code || '')).catch(() => setCode(''));
    return stopTimer;
  }, []);

  // 回放中：按倍速定时推进
  useEffect(() => {
    if (!playing || !session) return undefined;
    stopTimer();
    timerRef.current = window.setInterval(async () => {
      try {
        const r = await stepReplay(session.id, 'next');
        setState(r.data.state);
        setSession(r.data.session);
        if (r.data.atEnd) setPlaying(false);
      } catch {
        setPlaying(false);
      }
    }, BASE_TICK_MS / speed);
    return stopTimer;
  }, [playing, speed, session]);

  // 拉取当前标的在回放区间内的 K 线
  useEffect(() => {
    if (!session || !code) return;
    getStockDaily(code, 400)
      .then((r) => setBars(r.data.bars.filter((b) => b.seq >= session.startSeq && b.seq <= session.endSeq)))
      .catch(() => setBars([]));
  }, [session?.id, session?.startSeq, session?.endSeq, code]);

  const currentBar = useMemo(() => {
    if (!state || bars.length === 0) return null;
    return bars.find((b) => b.seq === state.cursorSeq) || null;
  }, [state, bars]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await startReplay(bounds[0], bounds[1], capital);
      setSession(r.data.session);
      setState(r.data.state);
      setScore(null);
      setMarks([]);
      // RQ-74 埋点：真实节点上报（此前全仓 0 处调用，北极星指标不可观测）
      track('replay_start', { startSeq: bounds[0], endSeq: bounds[1], capital });
    } catch (e: any) {
      message.error(e?.response?.data?.error || '创建回放失败');
    } finally {
      setBusy(false);
    }
  };

  const step = async (action: 'next' | 'prev' | 'seek', seq?: number) => {
    if (!session) return;
    try {
      const r = await stepReplay(session.id, action, seq);
      setState(r.data.state);
      setSession(r.data.session);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '推进失败');
    }
  };

  const trade = async (side: 'BUY' | 'SELL') => {
    if (!session || !code) return;
    try {
      const r = await tradeReplay(session.id, code, side, qty);
      setState(r.data.state);
      setMarks((m) => [...m, { seq: r.data.state.cursorSeq, label: side, side }]);
      message.success(`${side === 'BUY' ? '买入' : '卖出'} ${qty} 股 @ ¥${formatNum(r.data.price)}`);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '下单失败');
    }
  };

  const finish = async () => {
    if (!session) return;
    try {
      const r = await finishReplay(session.id);
      setScore(r.data.score);
      setSession(r.data.session);
      setPlaying(false);
      const h = await listReplays();
      setHistory(h.data);
      const c = await compareReplays(session.startSeq, session.endSeq);
      setCompare(c.data);
      track('replay_finish', {
        sessionId: session.id,
        returnPct: r.data.score?.returnPct ?? null,
        tradeCount: r.data.score?.tradeCount ?? 0,
      });
    } catch (e: any) {
      message.error(e?.response?.data?.error || '生成成绩失败');
    }
  };

  if (!range?.hasData) {
    return (
      <div>
        <Disclaimer />
        <Empty description="暂无可回放的历史行情，等行情引擎积累若干交易日后即可使用" />
      </div>
    );
  }

  return (
    <div>
      {/* RQ-06：明确告知训练与真实账户隔离 */}
      <Alert
        type="warning"
        showIcon
        banner
        message="回放训练为独立账本：所有操作不会影响你的真实资金、持仓与排行榜成绩"
        style={{ marginBottom: 12, fontSize: 12 }}
      />

      {!session && (
        <Card title="选择回放区间" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text type="secondary">
                可选区间：第 {range.minSeq} ~ {range.maxSeq} 个交易日（共 {range.maxSeq - range.minSeq + 1} 个）
              </Text>
              <Slider
                range
                min={range.minSeq}
                max={range.maxSeq}
                value={bounds}
                onChange={(v) => setBounds(v as [number, number])}
                disabled={range.minSeq >= range.maxSeq}
              />
            </div>
            <Space wrap>
              <span>
                起始{' '}
                <InputNumber
                  min={range.minSeq}
                  max={range.maxSeq}
                  value={bounds[0]}
                  onChange={(v) => setBounds([Number(v) || range.minSeq, bounds[1]])}
                />
              </span>
              <span>
                结束{' '}
                <InputNumber
                  min={range.minSeq}
                  max={range.maxSeq}
                  value={bounds[1]}
                  onChange={(v) => setBounds([bounds[0], Number(v) || range.maxSeq])}
                />
              </span>
              <span>
                初始资金{' '}
                <InputNumber
                  min={10000}
                  step={100000}
                  value={capital}
                  onChange={(v) => setCapital(Number(v) || 1000000)}
                />
              </span>
              <Button type="primary" loading={busy} onClick={start} data-testid="replay-start">
                开始回放
              </Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {bounds[1] - bounds[0] + 1} 个交易日
            </Text>
          </Space>
        </Card>
      )}

      {session && state && (
        <Card
          title={
            <Space wrap>
              <span>回放训练</span>
              <Tag color="blue">
                第 {state.cursorSeq} / {state.endSeq} 个交易日
              </Tag>
              <Tag color={session.status === 'FINISHED' ? 'default' : 'green'}>
                {session.status === 'FINISHED' ? '已结束' : '进行中'}
              </Tag>
            </Space>
          }
          extra={
            <Space>
              <Button onClick={() => setSession(null)}>结束并返回</Button>
              <Button type="primary" onClick={finish} disabled={session.status === 'FINISHED'} data-testid="replay-finish">
                结束并出成绩
              </Button>
            </Space>
          }
        >
          {/* RQ-02 播放器 */}
          <Space wrap style={{ marginBottom: 12 }}>
            <Button icon={<StepBackwardOutlined />} onClick={() => step('prev')} data-testid="replay-prev">
              倒带
            </Button>
            <Button
              type="primary"
              icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => setPlaying((p) => !p)}
              data-testid="replay-play"
            >
              {playing ? '暂停' : '播放'}
            </Button>
            <Button icon={<StepForwardOutlined />} onClick={() => step('next')} data-testid="replay-next">
              单步
            </Button>
            <Button icon={<RedoOutlined />} onClick={() => step('seek', session.startSeq)}>
              回到起点
            </Button>
            <span>
              倍速{' '}
              <Segmented
                size="small"
                value={speed}
                onChange={(v) => setSpeed(Number(v))}
                options={REPLAY_SPEEDS.map((s) => ({ label: `${s}x`, value: s }))}
              />
            </span>
          </Space>

          <Row gutter={16}>
            <Col xs={24} lg={14}>
              <Space style={{ marginBottom: 8 }} wrap>
                <Select
                  value={code}
                  onChange={setCode}
                  style={{ width: 180 }}
                  options={(state.positions.length > 0
                    ? state.positions.map((p) => ({ label: `${p.code}`, value: p.code }))
                    : [{ label: code, value: code }]
                  ).concat([{ label: '全部标的', value: '' }])}
                  placeholder="选择标的"
                />
                {currentBar && (
                  <Tag color={currentBar.close >= currentBar.prevClose ? 'red' : 'green'}>
                    收盘 ¥{formatNum(currentBar.close)}（{formatPct(((currentBar.close - currentBar.prevClose) / currentBar.prevClose) * 100)}）
                  </Tag>
                )}
              </Space>
              {bars.length > 0 ? (
                <KLineChart
                  bars={bars}
                  cursorSeq={state.cursorSeq}
                  marks={marks}
                  height={320}
                />
              ) : (
                <Empty description="该标的在本区间无行情" />
              )}

              {/* RQ-03 回放中下单 */}
              <Space wrap style={{ marginTop: 12 }}>
                <InputNumber min={100} step={100} value={qty} onChange={(v) => setQty(Number(v) || 100)} addonAfter="股" />
                <Button type="primary" danger onClick={() => trade('BUY')} data-testid="replay-buy">
                  买入
                </Button>
                <Button onClick={() => trade('SELL')} data-testid="replay-sell">
                  卖出
                </Button>
              </Space>
              <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 4 }}>
                以当前 bar 收盘价成交，T+1 / 涨跌停 / 费用规则与实时盘一致；需为 100 的整数倍
              </div>
            </Col>

            <Col xs={24} lg={10}>
              <Row gutter={[8, 8]}>
                <Col span={12}>
                  <Statistic title="可用资金" value={state.cash} precision={2} prefix="¥" />
                </Col>
                <Col span={12}>
                  <Statistic title="总资产" value={state.totalAssets} precision={2} prefix="¥" />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="收益率"
                    value={state.returnPct}
                    precision={2}
                    suffix="%"
                    valueStyle={{ color: state.returnPct >= 0 ? '#e0584f' : '#2fa06a' }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic title="最大回撤" value={state.maxDrawdown} precision={2} suffix="%" />
                </Col>
              </Row>
              <Table
                style={{ marginTop: 12 }}
                size="small"
                rowKey="code"
                pagination={false}
                dataSource={state.positions}
                locale={{ emptyText: '暂无持仓' }}
                columns={[
                  { title: '标的', dataIndex: 'code' },
                  { title: '数量', dataIndex: 'quantity' },
                  { title: '可卖', dataIndex: 'sellable' },
                  { title: '成本', dataIndex: 'avgCost', render: (v: number) => formatNum(v) },
                  {
                    title: '盈亏',
                    dataIndex: 'pnl',
                    render: (v: number) => (
                      <span className={v >= 0 ? 'up' : 'down'}>{formatMoney(v)}</span>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>
        </Card>
      )}

      {/* RQ-05 历史成绩与同区间对比 */}
      <Card title="历史成绩（同一区间可反复刷分，成绩不会被覆盖）" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="id"
          pagination={{ pageSize: 5 }}
          dataSource={history}
          locale={{ emptyText: '暂无训练记录' }}
          columns={[
            { title: '区间', render: (_: unknown, r: ReplaySession) => `${r.startSeq} ~ ${r.endSeq}` },
            { title: '开始时间', dataIndex: 'startedAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            {
              title: '收益率',
              render: (_: unknown, r: ReplaySession) =>
                r.result ? <span className={r.result.returnPct >= 0 ? 'up' : 'down'}>{r.result.returnPct}%</span> : '-',
            },
            { title: '最大回撤', render: (_: unknown, r: ReplaySession) => (r.result ? `${r.result.maxDrawdown}%` : '-') },
            { title: '交易次数', render: (_: unknown, r: ReplaySession) => r.result?.tradeCount ?? '-' },
            {
              title: '操作',
              render: (_: unknown, r: ReplaySession) => (
                <Button
                  size="small"
                  onClick={async () => {
                    const c = await compareReplays(r.startSeq, r.endSeq);
                    setCompare(c.data);
                  }}
                >
                  对比同区间
                </Button>
              ),
            },
          ]}
        />
        {compare.length > 0 && (
          <Descriptions bordered size="small" column={2} style={{ marginTop: 12 }} title="同区间多次成绩对比">
            {compare.map((c, i) => (
              <Descriptions.Item key={c.id} label={`第 ${i + 1} 次`}>
                {c.result
                  ? `收益 ${c.result.returnPct}% · 回撤 ${c.result.maxDrawdown}% · ${c.result.tradeCount} 笔`
                  : '未完成'}
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </Card>

      {/* RQ-04 成绩弹窗 */}
      <Modal open={!!score} title="本次训练成绩" footer={null} onCancel={() => setScore(null)}>
        {score && (
          <>
            <Row gutter={[8, 16]}>
              <Col span={12}>
                <Statistic title="收益率" value={score.returnPct} precision={2} suffix="%" valueStyle={{ color: score.returnPct >= 0 ? '#e0584f' : '#2fa06a' }} />
              </Col>
              <Col span={12}>
                <Statistic title="盈亏" value={score.profit} precision={2} prefix="¥" />
              </Col>
              <Col span={12}>
                <Statistic title="最大回撤" value={score.maxDrawdown} precision={2} suffix="%" />
              </Col>
              <Col span={12}>
                <Statistic title="交易次数" value={score.tradeCount} />
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              用时 {score.durationSec} 秒 · 初始资金 {formatMoney(score.initialCapital)} → 终值{' '}
              {formatMoney(score.finalAssets)}
            </Text>
            <Title level={5} style={{ marginTop: 12 }}>
              本次成绩未计入真实账户与排行榜
            </Title>
          </>
        )}
      </Modal>
      <Disclaimer />
    </div>
  );
}
