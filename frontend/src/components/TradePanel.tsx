import React, { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Segmented, Space, Statistic, App, Alert } from 'antd';
import api from '../api';
import { getPrice, subscribe } from '../ws';
import { useAuth } from '../auth';
import { formatMoney, formatNum } from '../utils';
import type { StockQuote } from '../types';

interface FeeConfig {
  commissionRate: number;
  stampRate: number;
  transferRate: number;
  minCommission: number;
  t1Enabled: boolean;
  dailyLimit: number;
  priceTolerance: number;
}

const DEFAULT_FEES: FeeConfig = {
  commissionRate: 0.0003,
  stampRate: 0.0005,
  transferRate: 0.00001,
  minCommission: 5,
  t1Enabled: true,
  dailyLimit: 0.1,
  priceTolerance: 0.005,
};

const LOT = 100;

export default function TradePanel({
  code,
  mode: lockedMode,
  initialQuantity,
  availableQty,
  onTraded,
}: {
  code: string;
  mode?: 'BUY' | 'SELL';
  initialQuantity?: number;
  /** 可卖数量（卖出场景由持仓页传入，T+1 冻结后的可卖股数） */
  availableQty?: number;
  onTraded?: () => void;
}) {
  const { message } = App.useApp();
  const { assets } = useAuth();
  const [mode, setMode] = useState<'BUY' | 'SELL'>(lockedMode || 'BUY');
  const [qty, setQty] = useState<number | null>(initialQuantity || null);
  const [submitting, setSubmitting] = useState(false);
  const [fees, setFees] = useState<FeeConfig>(DEFAULT_FEES);
  const [quote, setQuote] = useState<StockQuote | undefined>(getPrice(code));
  // 委托方式：市价即时成交 / 限价挂单（达到条件自动成交）
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState<number | null>(null);

  const price = quote?.price ?? 0;

  // 费率与交易规则由后端统一下发，前端不再硬编码
  useEffect(() => {
    api
      .get<FeeConfig>('/config/fees')
      .then((r) => setFees(r.data))
      .catch(() => setFees(DEFAULT_FEES));
  }, []);

  // 限价输入框默认跟随现价（用户未手动修改时）
  useEffect(() => {
    if (price && limitPrice === null) setLimitPrice(price);
  }, [price, limitPrice]);

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

  const cash = assets?.cash ?? 0;

  const calcFees = (amount: number, type: 'BUY' | 'SELL') => {
    const commission = Math.max(fees.minCommission, amount * fees.commissionRate);
    const stamp = type === 'SELL' ? amount * fees.stampRate : 0;
    const transfer = amount * fees.transferRate;
    return Math.round((commission + stamp + transfer) * 100) / 100;
  };

  // 限价委托下按委托价预估金额，市价单按当前价
  const unitPrice = orderType === 'LIMIT' && limitPrice ? limitPrice : price;
  const amount = useMemo(() => (qty ? Math.round(unitPrice * qty * 100) / 100 : 0), [unitPrice, qty]);
  const fee = useMemo(() => calcFees(amount, mode), [amount, mode, fees]);

  // 最多可买：按含费单价反推，取整到 100 股
  const maxBuy = useMemo(() => {
    if (!price || !cash) return 0;
    const per = price * (1 + fees.commissionRate + fees.transferRate);
    const q = Math.floor((cash - fees.minCommission) / per / LOT) * LOT;
    return Math.max(0, q);
  }, [price, cash, fees]);

  const maxSell = availableQty ?? 0;
  const maxQty = mode === 'BUY' ? maxBuy : maxSell;

  const limitUp = quote ? quote.prevClose * (1 + fees.dailyLimit) : 0;
  const limitDown = quote ? quote.prevClose * (1 - fees.dailyLimit) : 0;
  const atLimitUp = !!quote && price >= limitUp * 0.999;
  const atLimitDown = !!quote && price <= limitDown * 1.001;
  const blockedByLimit = (mode === 'BUY' && atLimitUp) || (mode === 'SELL' && atLimitDown);

  const submit = async () => {
    if (!qty || qty <= 0) {
      message.warning('请输入有效的交易数量');
      return;
    }
    if (qty % LOT !== 0) {
      message.warning('委托数量必须是 100 股的整数倍');
      return;
    }
    if (mode === 'BUY' && qty > maxBuy) {
      message.warning(`可用资金不足，最多可买 ${maxBuy} 股`);
      return;
    }
    if (mode === 'SELL' && availableQty !== undefined && qty > maxSell) {
      message.warning(`可卖数量不足，当前可卖 ${maxSell} 股`);
      return;
    }
    setSubmitting(true);
    try {
      if (orderType === 'LIMIT') {
        // 限价委托：服务端在行情达到条件时自动撮合
        await api.post('/orders', { code, side: mode, price: limitPrice, quantity: qty });
        message.success('委托已提交，行情达到条件后自动成交');
      } else {
        // 携带客户端展示价，服务端校验行情是否已大幅变动
        await api.post('/trade', { code, type: mode, quantity: qty, clientPrice: price });
        message.success(`${mode === 'BUY' ? '买入' : '卖出'} ${code} ${qty} 股 成功`);
      }
      setQty(null);
      if (onTraded) onTraded();
    } catch (e: any) {
      const data = e?.response?.data;
      if (e?.response?.status === 409 && data?.latestPrice) {
        message.warning(`行情已变动，最新价 ¥${formatNum(data.latestPrice)}，请确认后再下单`);
      } else {
        message.error(data?.error || '交易失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const quick = (ratio: number) => {
    const v = Math.floor((maxQty * ratio) / LOT) * LOT;
    setQty(v > 0 ? v : null);
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
      <Segmented
        block
        value={orderType}
        onChange={(v) => setOrderType(v as 'MARKET' | 'LIMIT')}
        options={[
          { label: '市价单', value: 'MARKET' },
          { label: '限价委托', value: 'LIMIT' },
        ]}
        style={{ marginBottom: 12 }}
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <div style={{ color: '#8c8c8c', marginBottom: 4 }}>当前价格</div>
          <div className={`money ${quote ? (quote.change >= 0 ? 'up' : 'down') : ''}`} style={{ fontSize: 22, fontWeight: 700 }}>
            {formatNum(price)}
          </div>
          <div style={{ color: '#bfbfbf', fontSize: 12, marginTop: 2 }}>
            涨停 ¥{formatNum(limitUp)} · 跌停 ¥{formatNum(limitDown)}
          </div>
        </div>
        {orderType === 'LIMIT' && (
          <div>
            <div style={{ color: '#8c8c8c', marginBottom: 4 }}>
              委托价格（元）
              <span style={{ float: 'right' }}>
                {mode === 'BUY' ? '委托价 ≥ 市价时成交' : '委托价 ≤ 市价时成交'}
              </span>
            </div>
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              step={0.01}
              precision={2}
              value={limitPrice}
              onChange={(v) => setLimitPrice(v as number | null)}
              addonAfter="元"
            />
          </div>
        )}
        <div>
          <div style={{ color: '#8c8c8c', marginBottom: 4 }}>
            交易数量（股）
            <span style={{ float: 'right' }}>
              {mode === 'BUY'
                ? `可用 ${formatMoney(cash)}，最多可买 ${maxBuy} 股`
                : availableQty !== undefined
                ? `可卖 ${maxSell} 股${fees.t1Enabled ? '（T+1）' : ''}`
                : ''}
            </span>
          </div>
          <InputNumber
            style={{ width: '100%' }}
            min={LOT}
            step={LOT}
            max={maxQty || undefined}
            value={qty}
            onChange={(v) => setQty(v as number | null)}
            placeholder="100 股起，100 的整数倍"
            addonAfter="股"
          />
          {maxQty > 0 && (
            <Space size={4} style={{ marginTop: 8 }}>
              <Button size="small" onClick={() => quick(1)}>
                全仓
              </Button>
              <Button size="small" onClick={() => quick(0.5)}>
                1/2
              </Button>
              <Button size="small" onClick={() => quick(1 / 3)}>
                1/3
              </Button>
            </Space>
          )}
        </div>
        <Space size="large">
          <Statistic title="预计金额" value={amount} precision={2} prefix="¥" valueStyle={{ fontSize: 18 }} />
          <Statistic title="预计费用" value={fee} precision={2} prefix="¥" valueStyle={{ fontSize: 18 }} />
        </Space>
        {blockedByLimit && (
          <Alert
            type="warning"
            showIcon
            message={mode === 'BUY' ? '已涨停，买单无法成交' : '已跌停，卖单无法成交'}
          />
        )}
        <Button
          type="primary"
          block
          size="large"
          loading={submitting}
          onClick={submit}
          disabled={blockedByLimit}
          style={
            mode === 'SELL'
              ? { background: '#fff', color: '#0d9488', borderColor: '#0ea5a4' }
              : undefined
          }
        >
          {orderType === 'LIMIT'
            ? '提交委托'
            : mode === 'BUY'
            ? '确认买入'
            : '确认卖出'}
        </Button>
        <div style={{ color: '#bfbfbf', fontSize: 12 }}>
          费用说明：佣金万3（最低5元）+ 卖出印花税万5 + 过户费万0.1
          {fees.t1Enabled && ' · T+1：当日买入的股份次日方可卖出'}
        </div>
      </Space>
    </div>
  );
}
