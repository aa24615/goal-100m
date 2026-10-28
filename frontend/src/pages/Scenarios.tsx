/**
 * 剧本训练场 —— 已归档（RQ-116 / F-39 / F-44）
 *
 * v8 只是把它「折叠」出一级导航，路由与服务都还在，结果是：
 *   - 产品侧持续维护两套世界观（剧本用合成行情，双盲用真实历史），成绩不可比（F-44）；
 *   - 用户侧老书签 / 直达地址进来的仍是空页面，且没有任何解释（F-39）。
 *
 * v9 决策：**下线而非折叠**。原实现不再挂载，命中此路由一律展示归档说明与替代入口。
 * 后端 `/api/scenario` 同步返回 410 Gone（见 backend/src/index.js）。
 */

import React from 'react';
import ArchivedNotice from '../components/ArchivedNotice';

export default function Scenarios() {
  return (
    <ArchivedNotice
      label="剧本训练场"
      reason="合成行情与真实历史两套世界观会让训练成绩不可比（F-44），且使用量仅 1 次。已主动下线，不再维护。"
      replacement={{ path: '/blind', label: '双盲训练（真实历史行情）' }}
    />
  );
}
