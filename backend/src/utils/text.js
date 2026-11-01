/**
 * 文本入参清洗：把「PostgreSQL 根本无法存储」的字符在进入 SQL 之前剥掉。
 *
 * 背景（2026-11-02 日志分析）：PG 的 text/varchar/jsonb 都**不接受 U+0000**。
 * 客户端只要在自由文本里带一个 NUL（`reason`、`note`、`message` 等），
 * 驱动就会抛 `22021 invalid byte sequence for encoding "UTF8": 0x00`，
 * 被 errorHandler 兜成 500 —— 用户侧看到的是「服务器内部错误」，
 * 而日志里却是 ERROR 级别，排障时极易被误判成服务端故障。
 *
 * 为什么只处理 U+0000 而不顺手清掉全部控制字符：
 *   - 实测（本次验证）U+0007 铃符、U+007F DEL、游离代理项、10 万字符超长文本
 *     均能被 PG 正常接受（返回 200），**只有 U+0000 会触发 22021**；
 *   - 清洗面越小，越不会误伤合法输入（例如密码里理论上可以含制表符）。
 *   收窄到「必须清洗的最小集合」，才能让「不破坏现有功能」这条硬约束成立。
 *
 * 为什么放在工具层 + 中间件，而不是逐个服务层改：
 *   这是**一族缺陷**（任何自由文本字段都会中招），逐个补必漏；
 *   在入口统一清洗，新增接口天然免疫。
 */

// 用转义写法而不是字面量：源码里出现真实 NUL 会让文件不可读、不可 diff。
const NUL = '\u0000';

/**
 * 去掉字符串里的 NUL；非字符串原样返回（保持调用方的类型语义不变）。
 * @param {unknown} v
 * @returns {unknown}
 */
export function stripNul(v) {
  if (typeof v !== 'string') return v;
  return v.indexOf(NUL) === -1 ? v : v.split(NUL).join('');
}

/** 深遍历上限：防止超大 body 的递归清洗本身变成 CPU 攻击面 */
const MAX_DEPTH = 8;
const MAX_NODES = 20000;

/**
 * 就地深遍历清洗一个对象/数组里的所有字符串。
 * 就地修改而不是返回新对象，是为了让 `req.query` 这类 getter 属性也能生效
 * —— 直接赋值 `req.query = x` 在部分 Express 版本上会失败。
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @param {{n: number}} [budget]
 * @returns {unknown} 清洗后的同一引用
 */
export function sanitizeDeep(value, depth = 0, budget = { n: 0 }) {
  if (depth > MAX_DEPTH || value == null) return value;
  budget.n += 1;
  if (budget.n > MAX_NODES) return value;

  if (typeof value === 'string') return stripNul(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const v = value[i];
      value[i] = typeof v === 'object' && v !== null ? sanitizeDeep(v, depth + 1, budget) : stripNul(v);
    }
    return value;
  }

  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const v = value[k];
      value[k] = typeof v === 'object' && v !== null ? sanitizeDeep(v, depth + 1, budget) : stripNul(v);
    }
  }
  return value;
}
