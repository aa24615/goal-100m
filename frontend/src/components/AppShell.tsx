import React, { useEffect, useRef } from 'react';
import { Layout } from 'antd';
import './AppShell.css';

const { Sider, Header, Content } = Layout;

export interface AppShellProps {
  /** 侧栏顶部品牌区（仅桌面端渲染） */
  brand?: React.ReactNode;
  /** 导航菜单：桌面侧栏与移动端抽屉共用同一份 */
  nav?: React.ReactNode;
  /** 顶栏内容 */
  header?: React.ReactNode;
  /** 顶栏之下的标签栏 */
  tabs?: React.ReactNode;
  /** 需要挂在 Layout 内的浮层（抽屉 / 引导等），不参与滚动 */
  overlays?: React.ReactNode;
  isMobile?: boolean;
  siderTheme?: 'light' | 'dark';
  /** 路由变化时把右侧滚动区复位到顶部 */
  pathname?: string;
  children?: React.ReactNode;
}

/**
 * 应用主框架：左侧 Sider + 顶部 Header/TabBar 固定，
 * 只有右侧 .app-content 滚动。
 *
 * 旧实现是 `<Layout minHeight:100vh>`，整页挂在 body 的滚动条上，
 * 于是长列表一滚，侧栏菜单和顶栏资产信息一起被推走。
 * 这里把根容器锁死为一屏高，滚动职责唯一交给内容区：
 *   .app-shell(100dvh, hidden) → .app-main(column, hidden)
 *     → .app-header / .app-tabs (flex: 0 0 auto)
 *     → .app-content-frame (flex: 1, hidden) → .app-content (auto 滚动)
 *
 * 注意：不给 html/body 设 overflow:hidden —— 登录页 AuthShell 内容
 * 超过一屏时仍需要 body 能滚动，否则页脚会被切掉。
 */
export default function AppShell({
  brand,
  nav,
  header,
  tabs,
  overlays,
  isMobile = false,
  siderTheme = 'light',
  pathname,
  children,
}: AppShellProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 换页后右侧回到顶部：滚动容器不再随路由重建，不复位会停在上一个页面的中段。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [pathname]);

  return (
    <Layout className="app-shell" data-testid="app-shell">
      {!isMobile && (
        <Sider
          className="app-sider"
          theme={siderTheme}
          width={200}
          breakpoint="lg"
          collapsedWidth={0}
        >
          <div className="app-sider-brand logo">
            {brand}
          </div>
          <div className="app-sider-scroll">{nav}</div>
        </Sider>
      )}

      <Layout className="app-main">
        <Header
          className="app-header"
          style={{ background: siderTheme === 'dark' ? '#141414' : '#fff' }}
        >
          {header}
        </Header>

        {tabs && <div className="app-tabs">{tabs}</div>}

        <Content className="app-content-frame">
          <div
            ref={scrollRef}
            className={`app-content${isMobile ? ' is-mobile' : ''}`}
            data-testid="app-content"
          >
            <div className="page-card">{children}</div>
          </div>
        </Content>
      </Layout>

      {overlays}
    </Layout>
  );
}
