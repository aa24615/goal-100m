import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppShell, { type AppShellProps } from './AppShell';

const base: AppShellProps = {
  brand: <span>brand-logo</span>,
  nav: <div>nav-menu</div>,
  header: <div>header-content</div>,
  tabs: <div>tabs-content</div>,
  overlays: <div>overlay-content</div>,
  isMobile: false,
  siderTheme: 'light',
  pathname: '/market',
};

const page = <div>page-body</div>;

function renderShell(overrides: Partial<AppShellProps> = {}) {
  const props = { ...base, ...overrides };
  return { props, ...render(<AppShell {...props}>{page}</AppShell>) };
}

describe('AppShell 固定侧栏与顶栏、仅内容区滚动', () => {
  it('桌面端：侧栏/顶栏/标签栏都在滚动容器之外，只有一个滚动区', () => {
    const { container } = renderShell();

    expect(container.querySelector('.app-sider')).not.toBeNull();
    expect(container.querySelector('.app-sider-brand')?.textContent).toContain('brand-logo');
    expect(container.querySelector('.app-sider-scroll')?.textContent).toContain('nav-menu');
    expect(container.querySelector('.app-header')?.textContent).toContain('header-content');
    expect(container.querySelector('.app-tabs')?.textContent).toContain('tabs-content');

    const scrollAreas = container.querySelectorAll('.app-content');
    expect(scrollAreas).toHaveLength(1);

    const content = screen.getByTestId('app-content');
    expect(content.querySelector('.page-card')?.textContent).toContain('page-body');
    // 固定区与浮层绝不参与内容滚动
    for (const fixed of ['nav-menu', 'header-content', 'tabs-content', 'overlay-content']) {
      expect(content.textContent).not.toContain(fixed);
    }
  });

  it('路由变化时把右侧滚动位置复位到顶部', () => {
    const { props, rerender } = renderShell();
    const content = screen.getByTestId('app-content') as HTMLDivElement;
    content.scrollTop = 320;
    expect(content.scrollTop).toBe(320);

    rerender(
      <AppShell {...props} pathname="/portfolio">
        {page}
      </AppShell>
    );
    expect(content.scrollTop).toBe(0);
  });

  it('移动端：不渲染侧栏，内容区带 is-mobile 且浮层仍可用', () => {
    const { container } = renderShell({ isMobile: true });

    expect(container.querySelector('.app-sider')).toBeNull();
    expect(screen.getByTestId('app-content').className).toContain('is-mobile');
    expect(container.textContent).toContain('overlay-content');
    // 顶栏仍然固定存在
    expect(container.querySelector('.app-header')?.textContent).toContain('header-content');
  });

  it('深色侧栏主题透传给 antd Sider', () => {
    const { container } = renderShell({ siderTheme: 'dark' });
    expect(container.querySelector('.app-sider.ant-layout-sider-dark')).not.toBeNull();
  });
});
