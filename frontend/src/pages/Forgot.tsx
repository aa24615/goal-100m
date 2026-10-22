import React, { useState } from 'react';
import { Button, Card, Form, Input, Steps, Typography, App, Alert } from 'antd';
import { useNavigate, Link } from 'react-router-dom';
import { forgotPassword, resetPassword } from '../api';

const { Text, Paragraph } = Typography;

// RQ-30 密码找回：此前忘记密码即永久失联，只能弃号重开。
// 流程：申请（邮箱）→ 拿到令牌（生产环境走邮件，开发环境直接返回）→ 设置新密码。
// 无论邮箱是否注册都返回同一句提示，不泄露账号存在性。
export default function Forgot() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  const request = async (email: string) => {
    setLoading(true);
    try {
      const r = await forgotPassword(email);
      setNotice(r.data.message);
      // 仅开发环境：SMTP 未配置时服务端直接回传令牌，便于本地跑通全流程
      if (r.data.devToken) {
        setToken(r.data.devToken);
        message.info('开发环境未配置 SMTP，已直接返回重置令牌');
      }
      setStep(1);
    } catch (e: any) {
      message.error(e?.response?.data?.error || '申请失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const reset = async (v: { token: string; password: string }) => {
    setLoading(true);
    try {
      await resetPassword(v.token, v.password);
      message.success('密码已重置，请使用新密码登录');
      navigate('/');
    } catch (e: any) {
      message.error(e?.response?.data?.error || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: '40px auto' }}>
      <Card title="找回密码">
        <Steps
          size="small"
          current={step}
          items={[{ title: '申请重置' }, { title: '设置新密码' }]}
          style={{ marginBottom: 20 }}
        />
        {notice && <Alert type="success" showIcon message={notice} style={{ marginBottom: 12, fontSize: 12 }} />}

        {step === 0 && (
          <Form layout="vertical" onFinish={(v) => request(v.email)}>
            <Form.Item
              name="email"
              label="注册邮箱"
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
            >
              <Input placeholder="you@example.com" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              发送重置链接
            </Button>
          </Form>
        )}

        {step === 1 && (
          <Form layout="vertical" onFinish={reset} initialValues={{ token }}>
            <Form.Item name="token" label="重置令牌" rules={[{ required: true, message: '请输入邮件中的令牌' }]}>
              <Input placeholder="邮件中的重置令牌" data-testid="reset-token" />
            </Form.Item>
            <Form.Item
              name="password"
              label="新密码"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 8, max: 32, message: '8-32 位' },
                {
                  validator: (_, val) =>
                    !val || /^\d+$/.test(val) ? Promise.reject(new Error('密码不能全为数字')) : Promise.resolve(),
                },
              ]}
            >
              <Input.Password placeholder="8-32 位，建议字母+数字" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认新密码"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入' },
                ({ getFieldValue }) => ({
                  validator: (_, val) =>
                    !val || val === getFieldValue('password')
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次输入不一致')),
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              确认重置
            </Button>
          </Form>
        )}

        <Paragraph style={{ marginTop: 16, fontSize: 12 }}>
          <Text type="secondary">想起密码了？</Text> <Link to="/">返回登录</Link>
        </Paragraph>
      </Card>
    </div>
  );
}
