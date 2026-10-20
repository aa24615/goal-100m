import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { AuthProvider } from './auth';
import './index.css';

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
