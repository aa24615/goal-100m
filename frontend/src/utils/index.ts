// 统一出口：页面里 `import { formatMoney } from './utils'` 仍可用，
// 实际实现下沉到 ./utils/format.ts，避免 utils.ts 文件与 utils/ 目录重名冲突。
export * from './format';
