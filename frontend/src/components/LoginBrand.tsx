/**
 * 登录页左栏：品牌 + 首屏三要素（LoginBrand）
 *
 * 2026-11-08 修复：旧版把 LandingHero 整块 Card 与「品牌标题 / 副标题 / 说明 /
 * 分隔线 / 5 条特性」并列堆叠，两套内容语义重复，左栏高度是右栏的两倍。
 *
 * 现在只保留一条主线，不重复任何信息：
 *   1. 品牌名与副标题（识别用，一行搞定）
 *   2. LandingHero（练什么 / 要不要注册 / 记录留多久 + 两个 CTA + 免责）
 *      —— 这是 RQ-174 的验收判据，不能删、不能折叠
 *   3. 一行精简的真实规则说明（涨跌停按板块 / T+1 / 费用），把原来 5 条长列表压成小字
 *
 * 所有布局尺寸由 index.css 的 .auth-* 类控制。
 */
import React from 'react';
import { Typography } from 'antd';
import LandingHero from './LandingHero';

const { Title, Text } = Typography;

export interface LoginBrandProps {
  onGuestTrain?: () => void;
  /** 点击「登录 / 注册保留成绩」：切到右侧注册 Tab */
  onRegister?: () => void;
}

export default function LoginBrand({ onGuestTrain, onRegister }: LoginBrandProps) {
  return (
    <div className="brand-pitch">
      <header className="auth-brand-head">
        <Title level={2} className="auth-brand-title">
          赚一个小目标
        </Title>
        <div className="auth-brand-sub">模 拟 股 票</div>
      </header>

      {/* RQ-174 首屏三要素：未登录即可见，且「不注册也能先练」的入口在这里 */}
      <LandingHero onRegister={onRegister} onGuestTrain={onGuestTrain} />

      <Text type="secondary" className="auth-rule-line">
        零风险练盘感，百万模拟金起步 · 涨跌停按板块（主板 ±10% / 创业板·科创板 ±20% / 北交所 ±30% / 主板 ST ±5%）
        · T+1 当日买入不可卖 · 停牌与退市标的不可交易 · 佣金 / 印花税 / 过户费全仿真
      </Text>
    </div>
  );
}
