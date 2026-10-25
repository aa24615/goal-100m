import React, { useEffect, useState } from 'react';
import {
  Alert,
  Card,
  Col,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Button,
  Tabs,
  Empty,
  App,
  Descriptions,
  Modal,
} from 'antd';
import { DownloadOutlined, ShareAltOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api, { getReview, getAbility, getShareCard, getCheckup, startPrescription } from '../api';
import type { ReviewPayload, AbilityRadar, ShareCard, CheckupPayload } from '../types';
import { formatMoney, formatNum, formatPct } from '../utils';
import ScoreRadar from '../components/ScoreRadar';
import CheckupPanel from '../components/CheckupPanel';
import Disclaimer from '../components/Disclaimer';
import { track } from '../utils/monitor';
import { SAMPLE_THRESHOLD } from '../constants';

const { Title, Text, Paragraph } = Typography;

const PERIODS = [
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '90天', value: '90d' },
  { label: '全部', value: 'all' },
];

// 复盘与战绩中心（RQ-07 ~ RQ-11 + RQ-24 + RQ-31 + RQ-32）
export default function Review() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [ability, setAbility] = useState<AbilityRadar | null>(null);
  const [card, setCard] = useState<ShareCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkup, setCheckup] = useState<CheckupPayload | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([getReview(period), getAbility(period)])
      .then(([r, a]) => {
        setData(r.data);
        setAbility(a.data);
        // RQ-74：复盘查看是全站最关键的复访行为之一
        track('review_view', { period });
      })
      .catch(() => {
        setData(null);
        setAbility(null);
      })
      .finally(() => setLoading(false));
    // RQ-76/77：体检单与复盘同页展示，样本门槛由后端裁决
    getCheckup(period)
      .then((r) => setCheckup(r.data))
      .catch(() => setCheckup(null));
  }, [period]);

  const exportUrl = (fmt: 'csv' | 'html') => `/api/review/export?format=${fmt}&period=${period}`;

  const loadCard = async () => {
    try {
      const r = await getShareCard(period);
      setCard(r.data);
    } catch {
      message.error('生成分享卡失败');
    }
  };

  const sc = data?.scorecard;
  const rep = data?.report;

  return (
    <div>
      <Disclaimer />

      {/* RQ-76 / RQ-77 / RQ-78 交易体检单：放在页面最上方，先讲可信度再讲数字 */}
      <div style={{ marginBottom: 16 }}>
        <CheckupPanel
          data={checkup}
          loading={loading && !checkup}
          // RQ-85 冷启动：0 笔用户点「去做第一段盲测」直接进入训练
          onStartTraining={(path) => navigate(path)}
          // RQ-83 训练处方：体检「最坏习惯」→ 一键开训，闭环的最后一公里
          onStartPrescription={async (c) => {
            try {
              const r = await startPrescription(c);
              navigate(`/blind/${r.data.id}`);
            } catch (e: any) {
              message.error(e?.response?.data?.error || '生成训练处方失败，请稍后重试');
            }
          }}
        />
      </div>

      <Card
        title="周期战绩卡"
        loading={loading}
        extra={
          <Segmented value={period} onChange={(v) => setPeriod(String(v))} options={PERIODS} />
        }
      >
        {data && sc ? (
          <>
            <Row gutter={[12, 16]}>
              <Col xs={12} md={6}>
                <Statistic
                  title="收益率"
                  value={data.returnPct}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: data.returnPct >= 0 ? '#e0584f' : '#2fa06a' }}
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="同期大盘" value={data.benchmarkPct} precision={2} suffix="%" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title="超额收益"
                  value={data.excessPct}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: data.excessPct >= 0 ? '#e0584f' : '#2fa06a' }}
                />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  超额收益 = 我的收益率 − 同期大盘收益率
                </Text>
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="已实现盈亏" value={data.realizedTotal} precision={2} prefix="¥" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="胜率" value={sc.winRate} precision={2} suffix="%" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="盈亏比" value={sc.profitFactor ?? '-'} />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="最大回撤" value={sc.maxDrawdown} precision={2} suffix="%" />
              </Col>
              <Col xs={12} md={6}>
                <Statistic title="手续费占比" value={sc.feeRatio} precision={2} suffix="%" />
              </Col>
            </Row>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              口径说明：胜率 = 盈利回合 / 已平仓回合；盈亏比 = 总盈利 / 总亏损；最大回撤按净值历史高点计算；
              交易频率 {sc.tradeFrequency} 笔/活跃日；平均持仓 {sc.avgHoldDays} 天。
              {data.consistency.ok ? ' 配对盈亏与账户已实现盈亏一致。' : ' 数据一致性校验未通过，请刷新重试。'}
            </Paragraph>
          </>
        ) : (
          <Empty description="暂无交易数据，完成一次买入与卖出后再来看看" />
        )}
      </Card>

      <Tabs
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'rounds',
            label: `逐笔配对（${data?.rounds.length ?? 0}）`,
            children: (
              <Card>
                {/* RQ-07 买卖配对 */}
                <Table
                  size="small"
                  rowKey={(r) => `${r.code}-${r.openedAt}-${r.status}`}
                  scroll={{ x: true }}
                  dataSource={data?.rounds || []}
                  locale={{ emptyText: '暂无配对交易' }}
                  columns={[
                    { title: '标的', render: (_: unknown, r) => `${r.name} ${r.code}`, fixed: 'left' },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      render: (v: string) => (
                        <Tag color={v === 'open' ? 'blue' : v === 'partial' ? 'orange' : 'default'}>
                          {v === 'open' ? '持仓中' : v === 'partial' ? '部分平仓' : '已平仓'}
                        </Tag>
                      ),
                    },
                    { title: '数量', dataIndex: 'quantity' },
                    { title: '买入均价', dataIndex: 'buyPrice', render: (v: number) => formatNum(v) },
                    { title: '卖出价', dataIndex: 'sellPrice', render: (v: number | null) => (v == null ? '-' : formatNum(v)) },
                    {
                      title: '已实现盈亏',
                      dataIndex: 'realizedPnl',
                      render: (v: number, r) =>
                        r.status === 'open' ? (
                          <span className={(r.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}>
                            {formatMoney(r.unrealizedPnl ?? 0)}（浮动）
                          </span>
                        ) : (
                          <span className={v >= 0 ? 'up' : 'down'}>{formatMoney(v)}</span>
                        ),
                    },
                    {
                      title: '收益率',
                      dataIndex: 'returnPct',
                      render: (v: number | null) => (v == null ? '-' : `${v}%`),
                    },
                    { title: '持有天数', dataIndex: 'holdDays' },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'ai',
            label: 'AI 行为复盘',
            children: (
              <Card>
                {rep ? (
                  <>
                    {/* RQ-10 报告：行为诊断 + 1~3 条建议 + 显著免责 */}
                    <Alert
                      type="warning"
                      showIcon
                      banner
                      message={rep.disclaimer}
                      style={{ marginBottom: 12, fontSize: 12 }}
                    />
                    <Title level={5}>本期结论</Title>
                    <Paragraph>
                      收益率 {rep.headline.returnPct}%，同期大盘 {rep.headline.benchmarkPct}%，
                      <Tag color={rep.headline.excessPct >= 0 ? 'red' : 'green'}>{rep.headline.outcome}</Tag>
                      （超额 {rep.headline.excessPct}%），样本 {rep.sampleSize} 笔完整交易。
                    </Paragraph>
                    <Title level={5}>行为特征</Title>
                    {rep.traits.length === 0 ? (
                      <Paragraph type="secondary">样本量较少，暂无显著行为特征。</Paragraph>
                    ) : (
                      <ul>
                        {rep.traits.map((t) => (
                          <li key={t.key}>
                            <b>{t.label}</b>：{t.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                    <Title level={5}>改进建议</Title>
                    <ol>
                      {rep.suggestions.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      报告生成于 {new Date(rep.generatedAt).toLocaleString('zh-CN')} · 合规校验：{rep.compliance}
                    </Text>
                  </>
                ) : (
                  <Empty description="暂无复盘报告" />
                )}
              </Card>
            ),
          },
          {
            key: 'radar',
            label: '能力雷达',
            children: (
              <Card>
                {ability ? (
                  <Row gutter={16}>
                    <Col xs={24} md={14}>
                      <ScoreRadar dimensions={ability.dimensions} overall={ability.overall} />
                    </Col>
                    <Col xs={24} md={10}>
                      <Descriptions column={1} size="small" bordered>
                        {ability.dimensions.map((d) => (
                          <Descriptions.Item key={d.key} label={d.label}>
                            <b>{d.score}</b>
                            <div style={{ fontSize: 12, color: '#8c8c8c' }}>{d.desc}</div>
                          </Descriptions.Item>
                        ))}
                      </Descriptions>
                      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                        {ability.note}
                      </Paragraph>
                    </Col>
                  </Row>
                ) : (
                  <Empty description="暂无能力数据" />
                )}
              </Card>
            ),
          },
        ]}
      />

      {/* RQ-11 / RQ-31 / RQ-32 导出与分享 */}
      <Card title="导出与分享" style={{ marginTop: 16 }}>
        <Space wrap>
          <Button icon={<DownloadOutlined />} href={exportUrl('csv')} data-testid="export-csv">
            导出配对交易（CSV）
          </Button>
          <Button icon={<DownloadOutlined />} href={exportUrl('html')} target="_blank" data-testid="export-pdf">
            导出复盘报告（打印为 PDF）
          </Button>
          <Button href="/api/transactions/export">导出交易流水（CSV）</Button>
          <Button icon={<ShareAltOutlined />} onClick={loadCard} data-testid="share-card">
            生成战绩分享卡
          </Button>
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          PDF 采用 HTML 打印稿交付：标准 PDF 内置字体不支持中文，直接拼装二进制 PDF 会让中文变乱码。
        </Paragraph>
      </Card>

      <Modal open={!!card} title="战绩分享卡（已脱敏）" footer={null} onCancel={() => setCard(null)}>
        {card && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="昵称">{card.displayName}</Descriptions.Item>
              <Descriptions.Item label="账号">{card.usernameMasked}</Descriptions.Item>
              <Descriptions.Item label="区间">{card.period}</Descriptions.Item>
              <Descriptions.Item label="收益率">{card.returnPct}%</Descriptions.Item>
              <Descriptions.Item label="超额收益">{card.excessPct}%（{card.outcome}）</Descriptions.Item>
            </Descriptions>
            {card.radar && (
              <ScoreRadar dimensions={card.radar.dimensions} overall={card.radar.overall} height={240} />
            )}
            <Alert type="info" showIcon banner message={card.disclaimer} style={{ fontSize: 12, marginTop: 8 }} />
          </>
        )}
      </Modal>
    </div>
  );
}
