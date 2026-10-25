/**
 * 训练中枢卡（RQ-55 休市即训练 / RQ-56 每日打卡 / RQ-46 新手起步清单 / RQ-67 双盲入口）
 *
 * 存在的理由：A 股每天只有 4 小时交易时段，休市时产品「无事可做」，用户打开即走。
 * 这里把静止时间变成训练时间，并把「每日打卡」前端调用补齐
 * —— 此前 `api.checkin` 在全仓 **0 处调用**（后端接口齐全），北极星指标无从谈起。
 *
 * 打卡为**纯荣誉**：不涉及任何实物或现金奖励（合规硬约束）。
 */

import React, { useEffect, useState } from 'react';
import { Card, Button, Space, Tag, Typography, Alert, App as AntApp } from 'antd';
import {
  CheckCircleOutlined,
  ThunderboltOutlined,
  ExperimentOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { checkin, getOnboarding } from '../api';
import { track } from '../utils/monitor';
import { DISCLAIMER } from '../constants';

const { Text, Paragraph } = Typography;

/** RQ-46 新手起步清单：少量高流动性标的，给新手一条明确起点 */
export const STARTER_CODES = ['600519', '601318', '000858', '600036', '300750'];

export interface CheckinState {
  streak: number;
  days: number;
  checkedToday: boolean;
}

export default function TrainingHub({
  inSession,
  lastUpdatedAt,
  sourceLabel,
}: {
  inSession: boolean;
  /** 行情最后更新时间（毫秒），为空表示数据源异常 */
  lastUpdatedAt?: number | null;
  sourceLabel?: string;
}) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [state, setState] = useState<CheckinState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getOnboarding()
      .then((r) => {
        const s = r.data;
        const last = s?.streak?.lastDate ? String(s.streak.lastDate).slice(0, 10) : null;
        // 今天是否已经打过卡：由 streak.lastDate 与本地上海日期比对得出，
        // 后端未直接给 checkedToday 字段时也不会误显示「未打卡」
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        setState({
          streak: Number(s?.streak?.current ?? 0),
          days: Number(s?.streak?.best ?? 0),
          checkedToday: last === today,
        });
      })
      .catch(() => setState(null));
  }, []);

  const doCheckin = async () => {
    if (busy || state?.checkedToday) return;
    setBusy(true);
    try {
      const r = await checkin();
      const d = r.data || {};
      setState({
        streak: Number(d.streakDays ?? d.streak ?? 0),
        days: Number(d.totalDays ?? d.days ?? 0),
        checkedToday: true,
      });
      // RQ-74：打卡是留存引擎的核心行为，必须可观测
      track('checkin', { streak: d.streakDays ?? null });
      message.success('今日练习打卡完成');
    } catch {
      // 已打卡/接口异常都不打断使用；文案避免让用户以为系统坏了
      message.info('今天已经打过卡了，明天继续');
    } finally {
      setBusy(false);
    }
  };

  const stale = lastUpdatedAt == null;
  const minutes =
    lastUpdatedAt == null ? null : Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 60000));

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space>
          <ExperimentOutlined />
          <span>训练中枢</span>
          <Tag color={inSession ? 'green' : 'blue'}>{inSession ? '交易时段' : '休市训练'}</Tag>
        </Space>
      }
      data-testid="training-hub"
    >
      {/* RQ-47 数据源状态可见：静默停更比报错更伤信任（F-06） */}
      {stale ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="quote-stale-alert"
          message="行情数据源暂未返回更新"
          description="当前价格可能已滞后。数据源恢复后本提示会自动消失；你仍可先做双盲训练。"
        />
      ) : (
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }} data-testid="quote-meta">
          行情来源：{sourceLabel || '公开行情接口'} · 更新于 {minutes === 0 ? '刚刚' : `${minutes} 分钟前`}
        </Text>
      )}

      {!inSession && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="offsession-tip"
          message="现在是休市时段"
          description="A 股每天只开市 4 小时，休市正是练盘感的时间：随机来一段真实历史行情做双盲训练。"
        />
      )}

      <Space wrap>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={() => navigate('/blind')}
          data-testid="goto-blind"
        >
          随机来一段（双盲训练）
        </Button>
        <Button
          icon={state?.checkedToday ? <CheckCircleOutlined /> : <ReloadOutlined />}
          onClick={doCheckin}
          loading={busy}
          disabled={Boolean(state?.checkedToday)}
          data-testid="checkin-btn"
        >
          {state?.checkedToday ? `今日已打卡 · 连续 ${state.streak} 天` : '今日打卡'}
        </Button>
        <Button onClick={() => navigate('/replay')}>回放训练</Button>
      </Space>

      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 4, fontSize: 12 }}>
        新手不知道从哪只练起？先从这几只高流动性标的开始：
        {STARTER_CODES.map((c) => (
          <Tag key={c} style={{ marginLeft: 4 }} onClick={() => navigate(`/stock/${c}`)}>
            {c}
          </Tag>
        ))}
      </Paragraph>
      <Text type="secondary" style={{ fontSize: 12 }}>{DISCLAIMER}</Text>
    </Card>
  );
}
