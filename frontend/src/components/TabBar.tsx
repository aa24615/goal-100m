import React from 'react';
import { Tabs, Dropdown, Button } from 'antd';
import { DownOutlined } from '@ant-design/icons';

export interface TabItem {
  key: string;
  label: string;
  closable: boolean;
}

interface Props {
  activeKey: string;
  items: TabItem[];
  onChange: (key: string) => void;
  onRemove: (key: string) => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}

// 顶部标签栏组件：把 App 中“可关闭的路由标签页”逻辑收敛出来，
// 负责渲染、关闭、关闭其他/全部，具体状态仍由 App 持有。
export default function TabBar({ activeKey, items, onChange, onRemove, onCloseOthers, onCloseAll }: Props) {
  return (
    <div className="tabbar">
      <Tabs
        hideAdd
        size="small"
        type="editable-card"
        activeKey={activeKey}
        items={items.map((t) => ({ key: t.key, label: t.label, closable: t.closable }))}
        onChange={onChange}
        onEdit={(e, action) => {
          if (action === 'remove') onRemove(String(e));
        }}
        tabBarExtraContent={{
          right: (
            <Dropdown
              menu={{
                items: [
                  { key: 'others', label: '关闭其他' },
                  { key: 'all', label: '关闭全部' },
                ],
                onClick: ({ key }) => {
                  if (key === 'others') onCloseOthers();
                  else if (key === 'all') onCloseAll();
                },
              }}
            >
              <Button size="small" type="text">
                标签操作 <DownOutlined />
              </Button>
            </Dropdown>
          ),
        }}
      />
    </div>
  );
}
