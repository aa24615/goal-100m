import '@testing-library/jest-dom';

// jsdom 未实现 matchMedia，antd 部分组件（Tabs 响应式）会用到，补一个空实现避免报错。
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
