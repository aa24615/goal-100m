import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { AuthProvider } from './auth';
import { installGlobalErrorHandlers } from './utils/monitor';
import './index.css';

// RQ-75：越早安装越好——App 挂载期间的崩溃也要能被看见，
// 装晚了就漏掉「白屏」这一类最严重、也最该被上报的错误。
installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#0ea5a4',
          colorInfo: '#0ea5a4',
          colorBgLayout: '#f5faf9',
          borderRadius: 10,
          fontSize: 14,
        },
        components: {
          Menu: {
            itemSelectedBg: '#e6f7f5',
            itemSelectedColor: '#0d9488',
            itemActiveBg: '#f0fbfa',
          },
        },
      }}
    >
      <AntApp>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
