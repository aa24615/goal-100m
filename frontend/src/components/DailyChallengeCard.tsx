/**
 * 每日一题 · 连打 · 净胜局榜（RQ-113 / I-10 / F-41）
 *
 * 训练结束后没有默认的下一次（F-41），留存钩子在最上游就断了。
 * 因此给出：全站同题的每日一题 + 连打 streak + 净胜局榜。
 *
 * **硬约束 6**：榜只算净胜局（跑赢买入持有 +1 / 跑输 −1），打满 5 局才上榜，
 * **不展示任何绝对收益**。收益榜会奖励「抽到什么票」——抽到什么票不是本事。
 * 本组件因此**没有接收任何收益率字段**。
 */

import React from 'react';
import { Card, Space, Statistic, Tag, Typography, Table, Button, Alert } from 'antd';
import { FireOutlined, TrophyOutlined } from '@ant-design/icons';
import { CHALLENGE_MIN_ROUNDS } from '../constants';
import type { TodayChallengePayload, ChallengeBoardPayload } from '../types';
import StreakRecordCard from './StreakRecordCard';

const { Text } = Typography;

export interface DailyChallengeCardProps {
  today: TodayChallengePayload | null;
  board: ChallengeBoardPayload | null;
  loading?: boolean;
  /** 开始今日一题：由父页面负责开训 */
  onJoin?: () => void;
}

export default function DailyChallengeCard({ today, board, loading = false, onJoin }: DailyChallengeCardProps) {
  const streak = board?.streak ?? today?.streak ?? null;

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <FireOutlined style={{ color: '#f59e0b' }} />
          <span>每日一题</span>
        </Space>
      }
      data-testid="daily-challenge"
      extra={today?.date ? <Tag data-testid="challenge-date">{today.date}</Tag> : null}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={16} wrap>
          <Statistic
            title="连打"
            value={streak?.current ?? 0}
            suffix={streak?.longest ? `（最长 ${streak.longest} 天）` : ''}
            valueStyle={{ color: '#0d9488' }}
          />
          <Statistic
            title="上榜门槛"
            value={board?.minRounds ?? CHALLENGE_MIN_ROUNDS}
            suffix="局"
          />
        </Space>

        <Button
          type="primary"
          block
          loading={loading}
          onClick={() => onJoin?.()}
          data-testid="challenge-join"
        >
          做今日这一题
        </Button>

        <Alert
          type="info"
          showIcon={false}
          style={{ fontSize: 12 }}
          data-testid="challenge-metric-note"
          message={board?.metricDef || today?.note || '跑赢「一直拿着」+1 / 跑输 −1，累加；不看绝对收益。'}
        />

        {/**
         * RQ-126：活跃用户不足 100 时**整个公榜不渲染**，改为个人连打记录。
         * 只在 publicBoardEnabled 显式为 false 时切换——未返回该字段的旧响应
         * 保持原行为，避免把「没统计活跃用户」当成「活跃用户为 0」。
         */}
        {board && board.publicBoardEnabled === false ? (
          <div data-testid="challenge-board-disabled">
            <StreakRecordCard record={board.streakRecord} boardReason={board.boardReason} />
          </div>
        ) : board && board.board.length > 0 ? (
          <Table
            size="small"
            rowKey={(r) => r.ref}
            pagination={false}
            data-testid="challenge-board"
            dataSource={board.board}
            columns={[
              { title: '#', dataIndex: 'rank', width: 40 },
              { title: '训练者', dataIndex: 'displayName' },
              { title: '局数', dataIndex: 'rounds', width: 60 },
              {
                title: '净胜局',
                dataIndex: 'netWin',
                width: 80,
                render: (v: number) => (
                  <Tag color={v > 0 ? 'red' : v < 0 ? 'green' : 'default'} data-testid="challenge-netwin">
                    {v > 0 ? `+${v}` : v}
                  </Tag>
                ),
              },
            ]}
          />
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }} data-testid="challenge-board-empty">
            {board?.participants === 0
              ? '还没有人打满 5 局，榜是空的 —— 这不是故障，是还没有足够的数据。'
              : '榜单加载中…'}
          </Text>
        )}

        {board && board.waiting.length > 0 && (
          <div data-testid="challenge-waiting">
            {board.waiting.slice(0, 5).map((w) => (
              <Text key={w.displayName} type="secondary" style={{ fontSize: 12, display: 'block' }}>
                {w.displayName} 已打 {w.rounds} 局，再打 {w.remaining} 局上榜
              </Text>
            ))}
          </div>
        )}

        <Text type="secondary" style={{ fontSize: 12 }}>
          <TrophyOutlined /> 榜单只比「是否跑赢买入持有」的累计数；这里不做任何按赚赔多少排序的排名。
        </Text>
      </Space>
    </Card>
  );
}
