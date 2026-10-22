import React from 'react';
import { Alert } from 'antd';
import { DISCLAIMER } from '../constants';

// RQ-29：此前免责声明只在登录页出现，交易与持仓页缺失 —— 这里是关键页面的强制补充。
// 用 Alert 而非纯文本，保证「显著位置可见」。
export default function Disclaimer({ text = DISCLAIMER, style }: { text?: string; style?: React.CSSProperties }) {
  return (
    <Alert
      type="info"
      showIcon
      banner
      message={text}
      style={{ marginBottom: 12, fontSize: 12, ...style }}
    />
  );
}
