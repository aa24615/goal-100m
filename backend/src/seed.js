import pool from './db.js';
import { logger } from './logger.js';

// 初始股票池（均为虚构的 A 股风格标的，仅用于模拟，不代表真实证券）
const STOCKS = [
  { code: '600001', name: '启明智能', sector: '半导体', prevClose: 48.60 },
  { code: '600002', name: '云海数据', sector: '计算机', prevClose: 32.15 },
  { code: '600003', name: '恒越医药', sector: '医药生物', prevClose: 56.80 },
  { code: '600010', name: '九州能源', sector: '电力', prevClose: 7.42 },
  { code: '600018', name: '远东制造', sector: '机械设备', prevClose: 14.30 },
  { code: '600028', name: '广源化工', sector: '化工', prevClose: 9.18 },
  { code: '600036', name: '盛通金融', sector: '银行', prevClose: 18.75 },
  { code: '600050', name: '天翼通信', sector: '通信', prevClose: 25.60 },
  { code: '600276', name: '康源药业', sector: '医药生物', prevClose: 42.10 },
  { code: '600519', name: '黔岭酒业', sector: '食品饮料', prevClose: 1680.00 },
  { code: '600585', name: '皖江水泥', sector: '建筑材料', prevClose: 28.40 },
  { code: '600888', name: '环球免税', sector: '商贸零售', prevClose: 96.50 },
  { code: '000001', name: '鹏城银行', sector: '银行', prevClose: 11.20 },
  { code: '000002', name: '华远地产', sector: '房地产', prevClose: 6.85 },
  { code: '000333', name: '美家居', sector: '家用电器', prevClose: 58.30 },
  { code: '000651', name: '冷风电器', sector: '家用电器', prevClose: 39.70 },
  { code: '000858', name: '蜀原股份', sector: '食品饮料', prevClose: 152.40 },
  { code: '002415', name: '海康威新', sector: '计算机', prevClose: 35.90 },
  { code: '300001', name: '新元生物', sector: '医药生物', prevClose: 22.65 },
  { code: '300015', name: '安康医疗', sector: '医药生物', prevClose: 47.20 },
  { code: '300033', name: '智赢软件', sector: '计算机', prevClose: 29.80 },
  { code: '300059', name: '聚财网络', sector: '计算机', prevClose: 16.40 },
  { code: '300122', name: '锦绣传媒', sector: '传媒', prevClose: 9.95 },
  { code: '300274', name: '旭日新能', sector: '电力设备', prevClose: 31.55 },
  { code: '601318', name: '泰和保险', sector: '保险', prevClose: 41.30 },
  { code: '601398', name: '华商银行', sector: '银行', prevClose: 5.60 },
  { code: '688001', name: '芯辰半导体', sector: '半导体', prevClose: 88.70 },
  { code: '688981', name: '晶宇微', sector: '半导体', prevClose: 63.20 },
];

export async function seedStocks() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM stocks');
  if (rows[0].c > 0) {
    logger.info('标的已存在，跳过播种', { count: rows[0].c });
    return;
  }
  try {
    for (const s of STOCKS) {
      await pool.query(
        `INSERT INTO stocks (code, name, sector, prev_close, open_price, price, high, low, volume)
         VALUES ($1, $2, $3, $4, $4, $4, $4, $4, 0)
         ON CONFLICT (code) DO NOTHING`,
        [s.code, s.name, s.sector, s.prevClose]
      );
    }
  } catch (e) {
    logger.error('播种标的失败', { total: STOCKS.length, err: e });
    throw e;
  }
  logger.info('播种标的完成', { count: STOCKS.length });
}
