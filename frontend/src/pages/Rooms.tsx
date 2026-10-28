/**
 * 房间赛 —— 已归档（RQ-116 / F-39）
 *
 * 房间赛使用量为 0；大赛与社区是券商主场（600 万级用户 + 交易所背书），
 * 不在我们的可赢范围（Won't 清单）。v9 决策：**下线而非折叠**。
 *
 * 后端 `/api/rooms` 同步返回 410 Gone（见 backend/src/index.js）。
 */

import React from 'react';
import ArchivedNotice from '../components/ArchivedNotice';

export default function Rooms() {
  return (
    <ArchivedNotice
      label="房间赛"
      reason="房间赛使用量为 0；大赛与社区属券商主场，不在本产品的可赢范围。已主动下线，不再维护。"
      replacement={{ path: '/training', label: '训练中心（每日一题与净胜局）' }}
    />
  );
}
