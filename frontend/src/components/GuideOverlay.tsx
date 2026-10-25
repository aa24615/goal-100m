import React, { useEffect, useState } from 'react';
import { Modal, Steps, Button, Space, Typography, Alert } from 'antd';
import { getOnboarding, updateGuide } from '../api';
import type { OnboardingState } from '../types';
import { track } from '../utils/monitor';

const { Paragraph, Text } = Typography;

// RQ-12：新用户注册后无任何引导，直接进入 28 只标的与专业术语界面 —— 这是首日流失的主要来源。
// 这里实现四步分步引导：3 秒内出现、每步都有明确的「下一步」和「跳过」、可随时重看。
export default function GuideOverlay({ onFinished }: { onFinished?: () => void }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    getOnboarding()
      .then((r) => {
        if (!alive) return;
        setState(r.data);
        // 未完成且未跳过的新用户，注册后即时弹出
        if (!r.data.guideDone && !r.data.guideSkipped) setVisible(true);
      })
      .catch(() => {
        /* 引导失败不阻断主流程 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const steps = state?.steps || [];
  const current = Math.max(0, Math.min(steps.length - 1, (state?.guideStep || 1) - 1));

  const act = async (action: 'step' | 'skip' | 'complete', step?: number) => {
    setLoading(true);
    try {
      const r = await updateGuide(action, step);
      setState(r.data);
      if (action === 'skip' || action === 'complete') {
        // RQ-74：引导完成/跳过都要上报，否则无法衡量引导对首日留存的作用
        track('guide_complete', { action, step: step ?? null });
        setVisible(false);
        onFinished?.();
      }
    } finally {
      setLoading(false);
    }
  };

  const isLast = current >= steps.length - 1;

  return (
    <Modal
      open={visible}
      title="新手引导：5 分钟上手模拟交易"
      maskClosable={false}
      width={520}
      onCancel={() => act('skip')}
      footer={
        <Space>
          <Button onClick={() => act('skip')} data-testid="guide-skip">
            跳过
          </Button>
          {isLast ? (
            <Button type="primary" loading={loading} onClick={() => act('complete')} data-testid="guide-finish">
              完成引导
            </Button>
          ) : (
            <Button
              type="primary"
              loading={loading}
              onClick={() => act('step', current + 2)}
              data-testid="guide-next"
            >
              下一步
            </Button>
          )}
        </Space>
      }
    >
      <Steps
        size="small"
        current={current}
        direction="vertical"
        items={steps.map((s) => ({ title: s.title, description: s.desc }))}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 12, fontSize: 12 }}
        message="本平台为模拟交易训练环境，所有行情与资金均为虚构，不构成投资建议。"
      />
      <Paragraph style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c' }}>
        <Text type="secondary">引导可随时在页面右上角「重看引导」重新打开。</Text>
      </Paragraph>
    </Modal>
  );
}
