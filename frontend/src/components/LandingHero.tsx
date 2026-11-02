/**
 * 首屏落地页（v15 RQ-174）
 *
 * v15 §v15-4 的 F-104 原话：**「首屏门面仍以『A 股模拟交易大厅』呈现，
 * 实际差异化是双盲训练与复盘。新用户按『模拟炒股 / 排行榜』预期进入，
 * 遇到的是训练器，预期错位直接流失。」**
 *
 * 因此本组件只做三件事，且都发生在**注册之前**：
 *   1. 练什么 —— 一句话说清「在隐藏标的与日期的真实历史 K 线里做决策」；
 *   2. 要不要注册 —— 明确「不注册也能先练」，把注册墙从第一米挪走；
 *   3. 记录留多久 —— 保留期承诺写在用户投入之前（硬约束第 6 条）。
 *
 * 关键设计：**不注册也能进入训练**。
 * 「首访 → 训练 ≤2 次点击」的验收判据里，注册是最贵的一次点击——
 * 它要求用户输入邮箱、想密码、确认密码，且发生在他还没看到任何价值之前。
 * 游客入口把它变成 0 次：点「先练一局」→ 点「开始」，共 2 次。
 *
 * 免责口径：统一「仅供练习、不构成投资建议」（RQ-174 第 5 点），
 * 文案取自后端下发的 landing 接口，前端不复制——运营参数会变，复制必漂移。
 */

import React, { useEffect, useState } from 'react';
import { Card, Typography, Space, Button, Skeleton, Alert } from 'antd';
import { ThunderboltOutlined, UserOutlined, FieldTimeOutlined } from '@ant-design/icons';
import { getLandingCopy } from '../api';
import { LANDING_ELEMENTS, MAX_FIRST_VISIT_CLICKS, FIRST_VISIT_PATH } from '../constants';
import type { LandingPayload } from '../types';

const { Title, Paragraph, Text } = Typography;

/** 三要素的图标固定映射：缺图标时卡片区会视觉失衡，且顺序与后端下发一致 */
const ELEMENT_ICONS: Record<string, React.ReactNode> = {
  what: <ThunderboltOutlined />,
  register: <UserOutlined />,
  retention: <FieldTimeOutlined />,
};

export interface LandingHeroProps {
  /** 点击「登录 / 注册」：交给上层决定是切换 Tab 还是跳路由 */
  onRegister?: () => void;
  /** 点击「先练一局」：游客进入训练（0 次注册成本） */
  onGuestTrain?: () => void;
  /** 注入用：跳过网络请求直接给定文案（测试与降级场景） */
  payload?: LandingPayload | null;
}

/**
 * 点击成本自检：把「首访 → 训练 ≤2 次点击」做成运行时可断言的事实。
 *
 * 为什么不只在测试里断言：路径会随改版漂移（多插一层引导页就变 3 次），
 * 而测试里的常量是手工维护的，改版时没人会同步更新断言。
 * 从真实常量推导，断言才不会与实现各说各话。
 */
export function firstVisitClicks(path = FIRST_VISIT_PATH) {
  const clicks = path.filter((s) => s.kind === 'click').length;
  return { clicks, max: MAX_FIRST_VISIT_CLICKS, ok: clicks > 0 && clicks <= MAX_FIRST_VISIT_CLICKS };
}

export default function LandingHero({ onRegister, onGuestTrain, payload: injected = null }: LandingHeroProps) {
  const [payload, setPayload] = useState<LandingPayload | null>(injected);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // 注入优先：测试与后端不可达时都要能渲染出三要素，不能白屏
    if (injected) {
      setPayload(injected);
      return;
    }
    let alive = true;
    getLandingCopy()
      .then((r) => {
        if (alive) setPayload(r.data || null);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [injected]);

  /**
   * 后端不可达时**降级到本地兜底文案**而不是隐藏整块。
   * 首屏三要素是 RQ-174 的验收判据，接口挂一次就让首屏缺一块，
   * 等于把一个可用性问题升级成需求违约。
   */
  const fallback: LandingPayload = {
    elements: [
      { key: 'what', title: '练什么', body: '在隐藏标的与日期的真实 A 股历史 K 线里逐根做决策，练的是盘感与纪律。' },
      { key: 'register', title: '要不要注册', body: '不注册也能先练一局；注册后才会保留成绩与连打记录。' },
      { key: 'retention', title: '记录留多久', body: '登录用户长期保留；游客记录请在注册前不要依赖长期留存。' },
    ],
    disclaimer: '真实 A 股公开行情 · 模拟资金与模拟交易 · 仅供学习研究，不构成投资建议',
    maxClicks: MAX_FIRST_VISIT_CLICKS,
    guestEntry: '/guest/session',
  };

  const data = payload || (failed ? fallback : null);
  const elements = data?.elements || [];

  // 按固定顺序渲染，且不因后端漏字段而缺项：任一要素缺失即补兜底文案
  const ordered = LANDING_ELEMENTS.map(
    (key) => elements.find((e) => e.key === key) || fallback.elements.find((e) => e.key === key)!
  ).filter(Boolean);

  return (
    <Card
      data-testid="landing-hero"
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: 20 } }}
      variant="outlined"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }} data-testid="landing-title">
            在真实历史行情里练决策，不用真钱试错
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data ? data.disclaimer : '真实 A 股公开行情 · 模拟资金与模拟交易 · 仅供学习研究，不构成投资建议'}
          </Text>
        </div>

        <div data-testid="landing-elements">
          {ordered.map((e) => (
            <div
              key={e.key}
              data-testid={`landing-element-${e.key}`}
              style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}
            >
              <span style={{ color: '#0d9488', marginTop: 2 }}>{ELEMENT_ICONS[e.key]}</span>
              <div>
                <Text strong>{e.title}</Text>
                <div>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {e.body}
                  </Text>
                </div>
              </div>
            </div>
          ))}
          {!data && <Skeleton active paragraph={{ rows: 3 }} />}
        </div>

        <Space wrap>
          <Button
            type="primary"
            data-testid="landing-guest-train"
            icon={<ThunderboltOutlined />}
            onClick={() => onGuestTrain?.()}
          >
            先练一局（无需注册）
          </Button>
          <Button data-testid="landing-register" onClick={() => onRegister?.()}>
            登录 / 注册保留成绩
          </Button>
        </Space>

        <Text type="secondary" style={{ fontSize: 12 }} data-testid="landing-clicks">
          首访到开始训练 {firstVisitClicks().clicks} 次点击
        </Text>

        {failed && (
          <Alert
            data-testid="landing-fallback"
            type="info"
            showIcon
            message="已使用本地兜底文案（配置服务暂不可用）"
            style={{ fontSize: 12 }}
          />
        )}
      </Space>
    </Card>
  );
}
