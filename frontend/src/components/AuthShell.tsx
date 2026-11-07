/**
 * 登录 / 注册页视觉骨架（AuthShell）
 *
 * 2026-11-08 修复「登录界面样式乱了」：
 * 旧版 Login.tsx 把 LandingHero（整块 Card）塞进 380px 左栏后，下面又重复了一整套
 * 品牌标题 / 说明 / 5 条特性，左栏被撑到 700+px，而右侧登录卡只有 ~360px；
 * 两栏 alignItems:center 导致顶部错位约 135px，外层 overflow:hidden 又把 footer 裁掉，
 * 窄屏 flexWrap 更会把登录卡挤到下一行。
 *
 * 本组件只负责**视觉骨架**，不含任何业务表单逻辑：
 *   - 两栏顶部对齐（高度不等也不会错位）
 *   - 装饰光斑放在独立的绝对定位裁切层，避免为裁光斑而把整页 overflow:hidden
 *   - 窄屏切单列，且登录卡通过 CSS order 置顶（首访先看到能操作的东西）
 *
 * 布局尺寸一律由 index.css 的 .auth-* 类控制，组件不写内联布局样式，
 * 这样媒体查询无需 !important 即可覆盖。
 */
import React from 'react';
import { DATA_SOURCE_STATEMENT } from '../constants';

export interface AuthShellProps {
  /** 左栏：品牌与首屏三要素 */
  brand: React.ReactNode;
  /** 右栏：登录 / 注册表单卡 */
  children: React.ReactNode;
}

export default function AuthShell({ brand, children }: AuthShellProps) {
  return (
    <div className="auth-shell">
      {/* 装饰光斑单独一层裁切：不能用外层 overflow:hidden，否则页脚会被裁掉 */}
      <div className="auth-glow-layer" aria-hidden="true">
        <div className="auth-glow-tr" />
        <div className="auth-glow-bl" />
      </div>

      <div className="auth-main">
        <div className="auth-grid">
          <div className="auth-brand">{brand}</div>
          <div className="auth-form">{children}</div>
        </div>
      </div>

      <footer className="auth-footer">
        <div>
          <span style={{ color: '#0d9488', fontWeight: 600 }}>赚一个小目标 · 模拟股票</span>
          <span>　|　仅供模拟练习，不构成任何投资建议</span>
        </div>
        <div>
          <a href="#" onClick={(e) => e.preventDefault()}>模拟交易说明</a>
          <a href="#" onClick={(e) => e.preventDefault()}>风险揭示</a>
          <a href="#" onClick={(e) => e.preventDefault()}>联系我们</a>
        </div>
        <div style={{ opacity: 0.8 }}>
          © {new Date().getFullYear()} 模拟股票实验室 · 模拟资金 ¥1,000,000 起 · {DATA_SOURCE_STATEMENT}
        </div>
      </footer>
    </div>
  );
}
