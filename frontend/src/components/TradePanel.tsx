import React, { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Segmented, Space, Statistic, App } from 'antd';
import api from '../api';
import { getPrice, subscribe } from '../ws';
import { formatMoney, formatNum } from '../utils';
import type { StockQuote } from '../types';

const COMMISSION_RATE = 0.0003;
const STAMP_RATE = 0.0005;
const TRANSFER_RATE = 0.00001;
const MIN_COMMISSION = 5;

function calcFees(amount: number, type: 'BUY' | 'SELL') {
  const commission = Math.max(MIN_COMMISSION, amount * COMMISSION_RATE);
  const stamp = type === 'SELL' ? amount * STAMP_RATE : 0;
  const transfer = amount * TRANSFER_RATE;
  return Math.round((commission + stamp + transfer) * 100) / 100;
}

export default function TradePanel({
  code,
  mode: lockedMode,
  initialQuantity,
  onTraded,
}: {
  code: string;
  mode?: 'BUY' | 'SELL';
  initialQuantity?: number;
  onTraded?: () => void;
}) {
  const { message } = App.useApp();
  const [mode, setMode] = useState<'BUY' | 'SELL'>(lockedMode || 'BUY');
  const [qty, setQty] = useState<number | null>(initialQuantity || null);
  const [submitting, setSubmitting] = useState(false);

  const [quote, setQuote] = useState<StockQuote | undefined>(getPrice(code));

  useEffect(() => {
    if (lockedMode) setMode(lockedMode);
  }, [lockedMode]);

  useEffect(() => {
    return subscribe((quotes) => {
      const q = quotes.find((x) => x.code === code);
      if (q) setQuote(q);
    });
  }, [code]);

  useEffect(() => {
    if (initialQuantity !== undefined) setQty(initialQuantity);
  }, [initialQuantity]);

  const price = quote?.price ?? 0;
  const amount = useMemo(() => (qty ? Math.round(price * qty * 100) / 100 : 0), [price, qty]);
  const fee = useMemo(() => calcFees(amount, mode), [amount, mode]);

  const submit = async () => {
    if (!qty || qty <= 0) {
      message.warning('请输入有效的交易数量');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/trade', { code, type: mode, quantity: qty });
      message.success(`${mode === 'BUY' ? '买入' : '卖出'} ${code} ${qty} 股 成功`);
      setQty(null);
      if (onTraded) onTraded();
    } catch (e: any) {
      message.error(e?.response?.data?.error || '交易失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {!lockedMode && (
        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as 'BUY' | 'SELL')}
          options={[
            { label: '买入', value: 'BUY' },
            { label: '卖出', value: 'SELL' },
          ]}
          style={{ marginBottom: 16 }}
        />
      )}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <div style={{ color: '#8c8c8c', marginBottom: 4 }}>当前价格</div>
          <div className={`money ${quote ? (quote.change >= 0 ? 'up' : 'down') : ''}`} style={{ fontSize: 22, fontWeight: 700 }}>
            {formatNum(price)}
          </div>
        </div>
        <div>
          <div style={{ color: '#8c8c8c', marginBottom: 4 }}>交易数量（股）</div>
          <InputNumber
            style={{ width: '100%' }}
            min={100}
            step={100}
            value={qty}
            onChange={(v) => setQty(v as number | null)}
            placeholder="100 股起，100 的整数倍"
            addonAfter="股"
          />
        </div>
        <Space size="large">
          <Statistic title="预计金额" value={amount} precision={2} prefix="¥" valueStyle={{ fontSize: 18 }} />
          <Statistic title="预计费用" value={fee} precision={2} prefix="¥" valueStyle={{ fontSize: 18 }} />
        </Space>
        <Button
          type="primary"
          block
          size="large"
          loading={submitting}
          onClick={submit}
          style={
            mode === 'SELL'
              ? { background: '#fff', color: '#0d9488', borderColor: '#0ea5a4' }
              : undefined
          }
        >
          {mode === 'BUY' ? '确认买入' : '确认卖出'}
        </Button>
        <div style={{ color: '#bfbfbf', fontSize: 12 }}>
          费用说明：佣金万3（最低5元）+ 卖出印花税万5 + 过户费万0.1
        </div>
      </Space>
    </div>
  );
}
