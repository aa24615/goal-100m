# -*- coding: utf-8 -*-
"""生成《赚他一个小目标 - 模拟股票 产品需求表》xlsx"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '产品需求表-赚他一个小目标-模拟股票.xlsx')

THIN = Side(style='thin', color='D9D9D9')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

HEAD_FILL = PatternFill('solid', fgColor='1F3864')
HEAD_FONT = Font(color='FFFFFF', bold=True, size=11)
TITLE_FONT = Font(bold=True, size=14, color='1F3864')

SEV_FILL = {
    'P0 致命': PatternFill('solid', fgColor='FFC7CE'),
    'P1 严重': PatternFill('solid', fgColor='FFE0B2'),
    'P2 一般': PatternFill('solid', fgColor='FFF9C4'),
}
PRIO_FILL = {
    'S 立即': PatternFill('solid', fgColor='FFC7CE'),
    'A 高': PatternFill('solid', fgColor='FFE0B2'),
    'B 中': PatternFill('solid', fgColor='FFF9C4'),
    'C 低': PatternFill('solid', fgColor='E8F5E9'),
}

# ---------------------------------------------------------------- 缺陷清单
DEFECT_HEAD = ['编号', '模块', '严重等级', '缺陷标题', '问题描述',
               '证据位置（代码）', '用户/业务影响', '修复建议', '工作量', '优先级']
DEFECTS = [
    # ---- P0 ----
    ('D01', '行情引擎', 'P0 致命', '无交易日轮转，价格长期吸附涨跌停板',
     'prev_close 自 seed 后永不更新，涨跌停基准固定；vol=0.0019/tick、2 秒一跳，'
     '理论 1 小时波动标准差约 8%，运行 1~2 小时后大量标的被 min/max 硬截断在 ±10% 边界附近震荡，'
     '涨跌幅列表趋于同质化。',
     'backend/src/market.js tick() / loadMarket()；db/init.sql stocks.prev_close',
     '行情失真，"练盘感"这一核心价值直接失效；用户看到满屏 ±10% 会立即判定产品是玩具。',
     '引入交易日概念：每 N 个 tick 或到达收盘时间执行一次「收盘结算」，'
     '用当前 price 覆写 prev_close，重置 open/high/low/volume，并做小幅隔夜跳空。',
     'M', 'S 立即'),
    ('D02', '行情引擎', 'P0 致命', '今开价恒等于昨收，永远零跳空',
     'seed 时 open_price = prev_close；loadMarket 中 open = startP = prevClose；'
     'tick() 从不更新 open。详情页「今开」与「昨收」永远同值。',
     'backend/src/market.js:53 open: startP；seed.js:44 VALUES($1,$2,$3,$4,$4,$4,$4,$4,0)',
     '缺少隔夜跳空这一 A 股最典型的价格行为，训练场景不完整；用户会察觉数据造假感。',
     '收盘结算时按 GBM 生成隔夜缺口（如 σ=1.5%），开盘价 = 昨收 × (1+gap)，再进入盘中随机游走。',
     'S', 'S 立即'),
    ('D03', '行情引擎', 'P0 致命', '无交易时段，7×24 不间断推送',
     'startMarket() 用 setInterval 无条件常驻 tick，无开盘/午休/收盘/集合竞价概念，'
     '也无行情暂停开关。',
     'backend/src/market.js:159 startMarket()',
     '深夜仍在空转消耗 CPU/DB 写入；用户凌晨打开看到行情在跑，可信度下降；'
     '无法支撑「收盘结算」「隔日跳空」等后续能力。',
     '定义交易日历与时段（如 09:30-11:30 / 13:00-15:00），非交易时段降频或挂起；'
     '提供 TICK_MS 之外的 TRADING_HOURS 配置与手动暂停 API。',
     'M', 'S 立即'),
    ('D04', '交易', 'P0 致命', '成交价与用户所见价格不一致（无报价锁定）',
     '前端 TradePanel 用 WS 实时价计算「预计金额」，点击后后端以 getDetail(code).price '
     '（服务器最新 tick）成交。行情 2 秒一跳，所见价与成交价可能相差 1% 以上，'
     '且无二次确认、无价格保护。',
     'frontend/src/components/TradePanel.tsx:54；backend/src/routes/trade.js:75',
     '公平性事故：用户按 10.00 决策、按 10.12 成交，会认为是系统吞钱，投诉与信任崩塌风险极高。',
     '下单请求携带客户端展示价 clientPrice 与时间戳，服务端校验偏离超过阈值（如 ±0.5%）'
     '返回「行情已变动，请确认新价」；或直接改为限价单（见 I04）。',
     'S', 'S 立即'),
    ('D05', '交易', 'P0 致命', '缺少 T+1 约束',
     '买入后可立即卖出，无当日买入冻结逻辑（README 已自认该取舍）。',
     'backend/src/routes/trade.js:107 SELL 分支；db/init.sql holdings 无可卖数量字段',
     '作为「A 股练盘感」产品，T+1 是 A 股最核心的交易纪律约束之一；'
     '缺失会让训练结论无法迁移到真实市场。',
     'holdings 增加 t0_qty（当日买入锁定量）与 last_buy_date；'
     '卖出校验 quantity <= quantity - t0_qty；收盘结算时把 t0_qty 归零。做成可配置开关（练习模式默认关）。',
     'M', 'S 立即'),
    ('D06', '交易', 'P0 致命', '无撮合机制，任何价格必然成交',
     '交易直接读写内存价，无订单簿、无流动性概念；涨停板仍可随意买入，'
     '也不存在「排队」「部分成交」。',
     'backend/src/routes/trade.js:65 POST /trade',
     '涨停买入、跌停卖出在真实市场极难成交，模拟中却 100% 成交，'
     '会造成「打板策略无脑盈利」的错误训练反馈。',
     '轻量方案：涨停（price>=hi*0.999）时买入按排队概率成交或直接拒绝并提示；'
     '进阶方案：引入内存订单簿与深度，支持限价单撮合（见 I04）。',
     'M', 'A 高'),
    # ---- P1 ----
    ('D07', '行情中心', 'P1 严重', '大盘指数用等权平均价计算，指数失真',
     'indexValue = Σprice / N，把 5.60 元的华商银行与 1680.00 元的黔岭酒业等权平均，'
     '指数绝对值无意义，涨跌幅也会被高价股单方面主导。',
     'backend/src/market.js:154 indexValue；frontend/src/pages/Market.tsx:53 同款实现',
     '「模拟大盘」是行情中心首屏第一张卡片，数值错误会直接暴露产品专业性不足，'
     '且排行榜缺少可靠基准（连带影响 D21）。',
     '改为市值加权或基点法指数：以 prevClose 为权重基期，'
     'index = 1000 × Σ(price_i × shares_i) / Σ(prevClose_i × shares_i)。',
     'S', 'S 立即'),
    ('D08', '自选股', 'P1 严重', '自选仅存 localStorage，无后端持久化',
     'getWatchlist/setWatchlist 直接读写 localStorage["pt_watchlist"]，'
     '数据库无 watchlist 表，跨设备/清缓存即丢失。',
     'frontend/src/pages/Market.tsx:9；Watchlist.tsx:9；StockDetail.tsx:12；db/init.sql',
     '换电脑、换浏览器、无痕模式、清理缓存后自选全部消失；'
     '自选是留存核心功能，丢失直接劝退。',
     '新增 watchlist(user_id, stock_code, sort, created_at) 表与 /api/watchlist CRUD，'
     '前端改为接口读写，localStorage 仅作离线兜底。',
     'S', 'A 高'),
    ('D09', '交易', 'P1 严重', '卖出路径未对持仓行加行锁，存在超卖竞态',
     'BUY/SELL 仅对 users 行 SELECT ... FOR UPDATE，'
     'holdings 用普通 SELECT，check-then-act 存在并发窗口，快速连点或并发请求可能超卖。',
     'backend/src/routes/trade.js:82（有锁）vs :108（无锁）',
     '持仓数量可能变负或卖出超过实际持仓，属于资金类数据事故，且难以排查。',
     'holdings 查询统一改为 SELECT ... FOR UPDATE；'
     '并在 holdings 上增加 CHECK (quantity >= 0) 约束兜底。',
     'S', 'A 高'),
    ('D10', '持仓/盈亏', 'P1 严重', '成本价不含交易费用，盈亏与收益率虚高',
     '首次建仓 avg_cost = price（不含佣金），加仓 newAvg 分子用的是 amount（同样不含 fee）。'
     '真实券商摊薄成本价含买入佣金、卖出印花税。',
     'backend/src/routes/trade.js:96、:101 newAvg 计算',
     '持仓盈亏比真实情况偏乐观，用户拿模拟盘结论去实盘会产生系统性偏差；'
     '前端又单独展示「预计费用」，形成「费用扣了但成本没含费」的认知矛盾。',
     '建仓/加仓时把 fee 摊入 avg_cost；卖出时按摊薄成本计算已实现盈亏，'
     '并在 transactions 落库 realized_pnl 字段（配合 D19）。',
     'S', 'A 高'),
    ('D11', '工程', 'P1 严重', '费率常量前后端重复实现',
     'COMMISSION_RATE / STAMP_RATE / TRANSFER_RATE / MIN_COMMISSION 在 '
     'backend/routes/trade.js 与 frontend/components/TradePanel.tsx 各写一份。',
     'backend/src/routes/trade.js:9-12；frontend/src/components/TradePanel.tsx:8-11',
     '调费率需改两处，极易不同步；前端「预计费用」与实际扣费不一致会引发投诉。',
     '后端暴露 GET /api/config/fees 返回费率，前端启动时拉取并缓存，删除前端硬编码。',
     'S', 'B 中'),
    ('D12', '安全', 'P1 严重', 'JWT 默认密钥硬编码',
     "JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'，"
     '生产环境若未注入环境变量，攻击者可用默认密钥自签任意 userId 的 token。',
     'backend/src/auth.js:7',
     '直接可被任意用户身份登录、篡改他人账户与资产，属最高危安全问题。',
     '启动时校验：NODE_ENV=production 且 JWT_SECRET 为默认值时直接退出；'
     'docker-compose 强制要求 .env；同时加入密钥轮换机制。',
     'S', 'S 立即'),
    ('D13', '安全', 'P1 严重', '无限流、无验证码，接口可被脚本滥用',
     '注册/登录/交易均无频率限制与验证码，注册即送 100 万且直进排行榜。',
     'backend/src/index.js（仅 cors + json 中间件）；auth.js:28 register',
     '可批量注册成千上万账号刷榜，排行榜失去意义；数据库与行情写入被打爆。',
     '接入 express-rate-limit（按 IP + 账号维度），注册加图形/邮箱验证码，'
     '交易接口加幂等键与最小间隔；异常账号自动标记。',
     'M', 'A 高'),
    ('D14', '安全', 'P1 严重', 'CORS 全开无白名单',
     'app.use(cors()) 未配置 origin，任意站点可携带用户 token 调用 API。',
     'backend/src/index.js:14',
     '配合 XSS 可窃取用户资产操作权限；生产环境不应放开。',
     '按环境变量配置 ALLOWED_ORIGINS 白名单；凭据请求严格校验 Origin。',
     'S', 'A 高'),
    ('D15', '实时推送', 'P1 严重', 'WebSocket 无鉴权、无心跳',
     'wss.on(connection) 直接推送全量快照，不校验身份；无 ping/pong 心跳，'
     '断线只能依赖 TCP 超时，前端 2 秒重连策略粗糙。',
     'backend/src/index.js:35；frontend/src/ws.ts:66',
     '未登录也可拉取全量行情（虽非敏感，但属资源滥用）；'
     '半开连接长期占用导致广播变慢、僵尸连接堆积。',
     'WS 连接时校验 token（query 或首帧）；服务端 30s ping / 客户端 pong 超时主动断开；'
     '广播改为按订阅标的过滤。',
     'S', 'B 中'),
    ('D16', '行情引擎', 'P1 严重', '历史行情仅存内存，重启后价格跳变',
     'history 只在 Map 中；重启时 loadMarket 用 prevClose 重新生成 120 点假历史，'
     '并把 price 覆写成新的随机值，与 DB 中已持久化的 price/high/low 不一致。',
     'backend/src/market.js:27 loadMarket()；:48 state.set',
     '每次重启用户持仓市值、排行榜收益率都会突变一次，'
     '在 Docker 重启/更新场景下体验极差，且历史数据无法沉淀。',
     '新增 stock_ticks / stock_daily 表持久化行情；'
     '重启时用 DB 中最后价格作为基准继续游走，仅补齐缺口。同时为 I02 回放功能铺路。',
     'M', 'A 高'),
    ('D17', '行情引擎', 'P1 严重', '成交量语义错误，量价完全背离',
     'volume 每 tick 随机累加 2000~62000 且永不重置；用户真实买卖完全不计入成交量。',
     'backend/src/market.js:78 s.volume += Math.floor(Math.random()*60000)+2000',
     '成交量与价格、与真实成交无关，纯粹是随机数；'
     '「放量突破」「缩量回调」等盘感训练完全无法进行。',
     '成交量改为由成交驱动：基础随机量 + 用户实际成交量；'
     '收盘结算时重置；DB 增加 day_volume / day_amount 字段。',
     'S', 'A 高'),
    ('D18', '数据模型', 'P1 严重', 'open_price 字段定义后从不更新',
     'init.sql 定义 stocks.open_price，seed 时赋值为 prev_close，此后 tick 只更新 '
     'price/high/low/volume，open_price 恒为初始值。',
     'db/init.sql:19；backend/src/market.js:93 UPDATE 语句',
     '「今开」永远等于最初的播种价，与「昨收」脱节，详情页数据自相矛盾。',
     '随 D01/D02 的收盘结算一并更新 open_price = 当日开盘价。',
     'S', 'S 立即'),
    ('D19', '数据模型', 'P1 严重', 'transactions 缺已实现盈亏字段',
     '表结构只有 amount/fee，无 realized_pnl、无买入批次关联，'
     '无法计算单笔盈亏、胜率、盈亏比、最大回撤。',
     'db/init.sql:37 transactions 表',
     '所有复盘类、画像类、成绩单类能力（I01/I09/I15）都无法落地，'
     '产品只能停留在「能买卖」层面，无沉淀价值。',
     'transactions 增加 realized_pnl、cash_after、holding_qty_after；'
     '卖出时按摊薄成本计算并落库；同步建立持仓批次表（用于先进先出/移动加权）。',
     'M', 'A 高'),
    ('D20', '排行榜', 'P1 严重', '排行榜 N+1 查询且全量计算无缓存',
     '先查全部 users，再对每个 user 单独查 holdings，最后在内存排序；'
     '每次请求 O(N) 次 DB 往返，无缓存、无分页下推。',
     'backend/src/routes/leaderboard.js:8-28',
     '用户量到千级即明显变慢，万级直接拖垮数据库；排行榜是社交与荣誉核心入口。',
     '改为单条 SQL JOIN 后用内存价批量估值；结果缓存 10~30 秒；'
     '只取 TOP N 且下推到 SQL；长期改为异步物化视图/定时任务落表。',
     'S', 'A 高'),
    ('D21', '排行榜', 'P1 严重', '排行榜缺基准对比，空仓用户稀释榜单',
     'returnPct = (总资产 - 初始资金)/初始资金，未与同期大盘对比；'
     '0 交易的空仓用户也占据名次（收益率 0% 但排名靠前于亏损者）。',
     'backend/src/routes/leaderboard.js:26',
     '「跑赢大盘」才是有效Alpha，缺失基准让排名无法反映真实水平；'
     '空仓躺赢现象鼓励不参与，与产品目标相悖。',
     '增加「超越基准」列（相对大盘指数的超额收益）作为主排序；'
     '过滤交易次数为 0 或增设「活跃榜/新人榜」分榜（配合 I05 房间赛）。',
     'S', 'B 中'),
    ('D22', '账号', 'P1 严重', '用户名/邮箱大小写未归一化',
     '注册与登录均直接 WHERE username=$1 OR email=$1，未做 lower() 归一化，'
     'Postgres UNIQUE 区分大小写，"Admin" 与 "admin" 可并存。',
     'backend/src/auth.js:38 INSERT；:61 SELECT',
     '用户可用不同大小写重复注册同一名字（抢占/仿冒）；'
     '登录时大小写不符即失败，用户不明原因。',
     '存储时统一 lower 并加唯一索引（citext 或 lower(...) 表达式索引）；'
     '登录前对输入做 trim + lower。',
     'S', 'A 高'),
    ('D23', '账号', 'P1 严重', '宣称「邮箱用于找回」但无找回功能',
     '注册表单 placeholder 写「用于找回账号」，但全项目无找回密码/重置密码/改密接口。',
     'frontend/src/pages/Login.tsx:95；backend/src/auth.js（无相关路由）',
     '明示功能缺失属于宣传与实际不符，用户遗忘密码即永久失去账户，'
     '在有留存目标的产品中是硬伤。',
     '补齐 forgot-password / reset-password 流程（邮箱令牌）与已登录状态下的修改密码；'
     '在未上线前先移除该文案。',
     'M', 'A 高'),
    ('D24', '账号', 'P1 严重', '账户亏光后无法重置',
     '无重置账户入口，用户只能重新注册，而用户名/邮箱已唯一占用。',
     'db/init.sql users 表；backend/src/auth.js（无 reset 路由）',
     '模拟盘的核心玩法就是「搞砸了再来一次」，无法重置会直接阻断继续使用的路径，'
     '用户只能弃用。',
     '提供「重置模拟账户」：清空 holdings/transactions 并将 cash 与 initial_capital '
     '恢复为 100 万，保留账号；可限制重置次数或计入战绩历史。',
     'S', 'A 高'),
    ('D25', '持仓', 'P1 严重', '无净值曲线，只有当前快照',
     'portfolio 接口只返回当前总资产，无历史序列，无法看收益走势、回撤、波动。',
     'backend/src/routes/trade.js:22 GET /portfolio',
     '用户无法评估「我是怎么赚/亏的」，产品缺少最重要的正反馈载体；'
     '也阻断 I01 画像与 I15 成绩单。',
     '定时（每个 tick 或每分钟）快照 user_netvalue(user_id, ts, total_assets)；'
     '前端增加净值曲线图 + 最大回撤/夏普等指标。',
     'M', 'A 高'),
    # ---- P2 ----
    ('D26', '前端', 'P2 一般', '无移动端适配',
     'Layout/Sider 固定 width=200 且无 breakpoint/collapsed，Header 多个 Space 横向排布，'
     '手机竖屏下严重挤压不可用。',
     'frontend/src/App.tsx:50-59',
     '移动端流量无法承接，分享传播链路断裂。',
     'Sider 加 breakpoint 与 collapsed，Header 关键指标换行/收起；'
     '行情表格改卡片流；交易面板做底部抽屉。',
     'M', 'B 中'),
    ('D27', '前端', 'P2 一般', '买入前端不校验资金/持仓',
     'TradePanel 只校验数量 > 0，不判断可用资金与可卖数量，提交后依赖后端 400 报错。',
     'frontend/src/components/TradePanel.tsx:58',
     '每次超额都走一次网络往返才报错，体验割裂；无「最多可买 X 股」引导。',
     '传入 availableCash / availableQty，前端实时计算「最多可买/可卖」并提供快捷按钮'
     '（全仓/1/2/1/3 仓）。',
     'S', 'B 中'),
    ('D28', '前端', 'P2 一般', '分时图历史点时钟来源不一致',
     '初始 history 时间戳来自服务端 Date.now()，前端 subscribe 追加点用本地 Date.now()，'
     '两端时钟有偏差时曲线出现回折；前端上限 300，后端 MAX_HISTORY=240。',
     'frontend/src/pages/StockDetail.tsx:59；backend/src/market.js:4',
     '分时图偶发错乱、重叠，图表可信度受损。',
     '统一使用服务端 tick 时间（WS 消息中的 time 字段）作为 X 轴；两端上限统一常量。',
     'S', 'B 中'),
    ('D29', '前端', 'P2 一般', '行情列表每 tick 全量重渲染',
     'subscribe 每 2 秒推送全量 28 条，setQuotes 触发整表重渲染 + useMemo 全量重算，'
     '无节流/memo/虚拟滚动。',
     'frontend/src/pages/Market.tsx:24、:30',
     '标的数扩大（如 500 只）后明显掉帧；当前 28 只尚可，属前瞻性债务。',
     '表格行 memo 化；高频 tick 用 requestAnimationFrame 节流；列表加虚拟滚动。',
     'S', 'C 低'),
    ('D30', '账号', 'P2 一般', '注册校验过弱',
     '仅校验非空与密码 ≥ 6 位，无用户名长度/字符规则、无确认密码、无密码强度提示。',
     'frontend/src/pages/Login.tsx:91-99；backend/src/auth.js:30-35',
     '误输入用户名/密码即永久占用或无法登录；弱密码易被盗。',
     '用户名 3-20 位且限字符集；增加确认密码；密码强度提示；后端同步校验。',
     'S', 'B 中'),
    ('D31', '前端', 'P2 一般', '401 处理硬跳转根路径',
     "api.ts 拦截 401 后直接 window.location.href = '/'，未清理内存态，"
     '且部署在非根路径时会跳错。',
     'frontend/src/api.ts:18',
     '子路径部署下登录过期会跳到错误地址；偶发重定向循环。',
     '改为调用 auth context 的 logout + 路由跳转，并读取 base URL。',
     'S', 'C 低'),
    ('D32', '后端', 'P2 一般', '行情持久化逐条 UPDATE',
     'persist 对 28 只股票在单个事务里逐条 await UPDATE，每 2 秒一轮 28 次往返。',
     'backend/src/market.js:87 persist()',
     '标的数扩大后 DB 写入成为瓶颈，且事务持有时间过长。',
     '改为批量 UPDATE（unnest 或 CASE WHEN）或降低落库频率（如每 10 秒批量快照）。',
     'S', 'C 低'),
    ('D33', '部署', 'P2 一般', '容器无健康检查、后端无优雅关闭',
     'docker-compose 未配置 healthcheck，后端无 SIGTERM 处理，'
     '行情定时器与连接池不会优雅释放。',
     'docker-compose.yml；backend/src/index.js',
     '滚动更新时可能出现连接中断、数据写入中断；容器假死无法自愈。',
     'compose 加 healthcheck（/api/health）；后端监听 SIGTERM 关闭 server/定时器/连接池。',
     'S', 'B 中'),
    ('D34', '前端', 'P2 一般', '登录/注册共用 loading 状态',
     'Login 组件单一 loading 变量同时驱动登录与注册按钮。',
     'frontend/src/pages/Login.tsx:10',
     '切换 Tab 时按钮可能误显示 loading。',
     '拆分为 loginLoading / registerLoading。',
     'XS', 'C 低'),
    ('D35', '交易', 'P2 一般', '仅支持市价即时成交，无挂单/撤单',
     '只有 BUY/SELL 即时成交，无限价单、止损单、委托队列与撤单入口。',
     'backend/src/routes/trade.js；db/init.sql 无 orders 表',
     '无法训练「挂单纪律」「止盈止损」这类真正决定盈亏的行为；'
     '产品停留在点击级模拟。',
     '见创新需求 I04（条件单引擎）。',
     'L', 'A 高'),
]

# ---------------------------------------------------------------- 创新需求
INNO_HEAD = ['编号', '创新点', '需求描述', '解决什么问题 / 用户价值',
             '差异化（对比同花顺模拟炒股 / 雪球组合）', '技术可行性',
             '依赖缺陷修复', '优先级', '工作量', '验证指标']
INNO = [
    ('I01', 'AI 交易复盘教练 + 交易画像',
     '基于 transactions 自动计算胜率、盈亏比、平均持仓时长、换手率、最大回撤、'
     '「拿不住盈利/死扛亏损」倾向、「追涨杀跌指数」，生成交易性格画像（如「频繁交易型」'
     '「扛单型」「右侧追高型」），并给出针对性训练处方与下次开仓前的纪律提示。',
     '把「能模拟交易」升级为「能让人变强」。这是本产品唯一能形成长期留存与口碑的护城河，'
     '也是用户愿意付费/传播的理由。',
     '主流模拟盘只给收益曲线，不做行为诊断；雪球组合侧重社交展示。'
     '行为画像 + 处方在中文模拟盘赛道几乎空白。',
     '中：数据模型补齐后（D19）用规则引擎即可跑通 MVP，'
     '后续接 LLM 生成自然语言复盘报告。',
     'D19、D25', 'S 立即', 'L',
     '使用复盘功能的用户次周留存提升 ≥ 15%；人均复盘次数 ≥ 3 次/月'),
    ('I02', '行情回放 / 时间机器（Bar Replay）',
     '把自生成的 tick 序列完整落库，支持「回到 3 小时前」或「随机抽取一段历史行情」，'
     '以当时的价格序列逐 tick 推进，用户在被遮挡未来的状态下做定向下单训练，'
     '结束后揭晓成绩并与最优解对比。',
     '解决「新手无历史经验可练」的问题，把一次性的模拟盘变成可反复刷题的训练场；'
     '同时天然具备病毒传播属性（晒成绩）。',
     'TradingView 的 Bar Replay 是付费高级功能且针对真实行情；'
     '本产品行情自研，回放是全量可控、零成本、可无限次重开的独特优势。',
     '高：行情引擎本就自研，只需持久化 tick（D16 顺带完成）+ 播放器组件。',
     'D16', 'A 高', 'L',
     '回放模式人均完成局数 ≥ 5；回放用户占比 ≥ 20%'),
    ('I03', '关卡制训练营（游戏化）',
     '设计任务卡与徽章体系：「只用半导体板块，3 个交易日跑赢指数」「单笔亏损不超过 2%」'
     '「连续 5 笔按止损纪律离场」「满仓过夜不超过 1 次」。通关解锁徽章与段位（青铜→王者）。',
     '直击「注册一次就流失」的痛点，用目标感与成就感制造回访理由；'
     '同时把「交易纪律」这一抽象能力变成可度量的通关条件。',
     '竞品无结构化训练路径，用户进入后只会茫然乱买，7 日留存极低。',
     '高：纯业务规则 + 前端展示，无技术风险。',
     'D19、D25', 'A 高', 'M',
     '7 日留存从基线提升 ≥ 10pp；人均通关关卡 ≥ 2'),
    ('I04', '条件单引擎（限价 / 止损 / 移动止盈）',
     '服务端挂单：限价买入、止盈单、止损单、移动止损（回撤 N% 触发）、条件组合单。'
     'tick 时扫描触发，成交后 WS 推送成交通知。前端提供委托列表与撤单。',
     '真正决定盈亏的是「离场纪律」而非「买什么」。让用户先立纪律、由系统执行，'
     '再复盘纪律是否有效——这是市价点击无法提供的训练价值。同时顺带解决 D04 价格保护。',
     '同花顺模拟盘多为市价即时成交，不支持移动止损；'
     '本产品可在模拟环境里把条件单做成核心卖点。',
     '中高：需新增 orders 表 + 触发扫描器 + 与行情引擎同频，注意并发与幂等。',
     'D04、D16', 'A 高', 'L',
     '使用条件单的用户占比 ≥ 30%；条件单成交笔数占比 ≥ 20%'),
    ('I05', '房间赛 / 多人对战',
     '创建限时房间：同起始资金、同一段行情、限定标的池、可设禁止 T+0 等规则。'
     '支持「1 小时闪电赛」「每日挑战赛」，房间内实时排行榜经 WS 推送。',
     '彻底解决排行榜「不同期、不同起点不可比」的公平性问题（D21），'
     '并把单人练习变成有对抗、有社交、有倒计时的高频回访场景。',
     '竞品排行榜是全局静态榜，新人永远打不过老人，无参与感；房间赛让每个人都能当第一。',
     '中：复用现有撮合与净值计算，新增 rooms 表与房间内结算，行情需支持房间独立推进。',
     'D01、D16、D20、D21', 'A 高', 'L',
     '参赛用户周活跃 ≥ 2 次；房间赛带来新注册占比 ≥ 15%'),
    ('I06', '行情剧本注入引擎（Scenario Engine）',
     '允许按剧本驱动行情，而非纯随机游走：「某股 10 分钟直线拉涨停」'
     '「突发利空跳空低开 5% 后缓慢修复」「全天窄幅震荡磨人」「冲高回落诱多」。'
     '剧本可编排、可复用于训练营关卡与回放题目。',
     '纯随机游走练不出针对特定形态的盘感。剧本引擎把「练盘感」从玄学变成'
     '「可定向、可重复、可考核」的课程。这是自研行情引擎独有的、竞品抄不走的能力。',
     '依赖第三方行情源的模拟盘无法注入剧本（只能用历史回放，无法定制）；'
     '纯随机游走的模拟盘无形态可言。本产品两者皆非，独占该能力。',
     '中：在 tick 中按剧本时间表注入 drift/vol 覆盖参数，与随机游走并存、可切换。',
     'D01、D02', 'A 高', 'L',
     '剧本关卡完成率 ≥ 60%；用户对「行情真实感」评分 ≥ 4/5'),
    ('I07', '盘感小游戏（猜涨跌 / 分时博弈）',
     '轻量训练模块：展示一段分时图并遮挡后半段，让用户在 10 秒内猜方向/猜收盘区间，'
     '即时给出对错与解析（量能、均线、形态），累计盘感分与连胜纪录。',
     '门槛极低、单局 30 秒，填充碎片时间，是低成本的拉活与新手引导工具；'
     '也为 I01 画像提供额外的行为数据。',
     '竞品无游戏化训练；雪球/同花顺偏内容消费。小游戏在股票垂类属稀缺形态。',
     '高：复用 I02 的历史 tick 库即可出题，几乎零新增成本。',
     'D16', 'B 中', 'M',
     '人均日游戏局数 ≥ 8；游戏用户次日留存 ≥ 30%'),
    ('I08', '组合风险诊断仪表盘',
     '对当前持仓计算：行业集中度、单一标的最大占比、组合波动率与 Beta、'
     '在 -3%/-5% 市场冲击下的预估损失（压力测试）、仓位健康度评分与调仓建议。',
     '把「看盈亏」升级为「看风险」。新手最缺的是风险意识，'
     '这是能直接教会用户东西、且竞品普遍缺失的高价值模块。',
     '模拟盘普遍只显示盈亏，不做组合风险度量；真实券商的该功能也多藏在专业版。',
     '中：需行情历史计算波动率与协方差（依赖 D16），前端雷达图/仪表盘展示。',
     'D16、D25', 'B 中', 'M',
     '持仓用户查看率 ≥ 40%；诊断后 24h 内调仓率 ≥ 15%'),
    ('I09', '收益归因分析',
     '把总收益拆解为「选股收益 / 择时收益 / 费用损耗 / 现金拖累」四部分，'
     '明确告诉用户「你的收益有 X% 被手续费吃掉了」「你换手 80 次，'
     '如果只换手 20 次能多赚 Y 元」。',
     '本产品已完整仿真佣金/印花税/过户费，却没把这笔最有教育意义的账算给用户看。'
     '归因结论极具冲击力，是最容易引发传播与自省的功能。',
     '竞品只给收益率数字，从不拆解费用损耗；'
     '而这恰恰是新手亏损最主要、最容易被忽视的原因。',
     '中：依赖 D19 的逐笔数据，用经典 Brinson 简化模型即可。',
     'D19', 'A 高', 'M',
     '归因报告分享率 ≥ 10%；高换手用户换手率下降 ≥ 20%'),
    ('I10', '自选预警与异动推送',
     '支持按价格突破、涨跌幅阈值、成交量异动设置提醒，经 WebSocket 实时推送 + '
     '浏览器通知 + 可选的邮件/微信推送；提供「全市场异动雷达」页面。',
     '把用户从「必须盯着盘」中解放出来，制造被拉回产品的理由，'
     '是行情类应用最经典有效的留存手段。',
     '同花顺有该能力但面向真实行情；模拟盘普遍没有。'
     '在模拟场景里做预警，能训练「预设条件、等待触发」的纪律。',
     '高：复用现有 WS 通道 + 服务端阈值扫描，通知渠道可渐进接入。',
     'D08', 'B 中', 'M',
     '设置预警用户占比 ≥ 25%；预警带来的回访率 ≥ 20%'),
    ('I11', '虚构新闻事件流驱动行情',
     '为虚构标的生成虚构公告与新闻（业绩预增、政策利好、监管问询、大股东减持等），'
     '与 I06 剧本引擎联动，让价格波动「有故事」，并在详情页展示事件时间轴。',
     '解决纯随机行情「无因果、无记忆点」的问题，大幅提升沉浸感与真实感；'
     '训练「事件驱动交易」这一真实盘核心能力。',
     '依赖真实行情的模拟盘无法造事件；纯随机模拟盘无事件。'
     '虚构世界观 + 事件驱动是本项目可以独占的叙事层。',
     '中：事件模板库 + 与剧本引擎联动；可接 LLM 批量生成文本素材。',
     'D01、D02', 'B 中', 'M',
     '事件页人均浏览 ≥ 3 条；真实感评分提升 ≥ 0.5 分'),
    ('I12', '社交跟单 / 抄作业',
     '公开头部选手的持仓与操作流水（脱敏），支持一键「跟单」把其组合复制到自己的模拟盘，'
     '并展示「跟单收益 vs 原作者收益」的差异（反映执行偏差）。',
     '利用排行榜已有的社交势能制造强互动；「跟单收益 < 原作者收益」的反差'
     '本身就是极具教育意义的洞察。',
     '雪球组合可看但不可一键跟单复制；模拟盘赛道无此玩法。',
     '中：需 WS 或轮询同步头部用户交易，注意隐私开关与延迟设计。',
     'D20', 'B 中', 'M',
     '跟单用户占比 ≥ 15%；人均跟单组合 ≥ 1.5 个'),
    ('I13', '多策略子账户',
     '一个账号下可开多个独立子账户（如「价值长线」「打板短线」「网格做 T」），'
     '各自独立资金与净值曲线，首页并排对比，检验哪种策略更适合自己。',
     '解决「想试新策略但不想毁掉主账户战绩」的矛盾，'
     '显著提升重度用户的使用深度与停留时长。',
     '竞品多为单账户，切换策略只能重新注册小号，体验割裂。',
     '中：users 下增加 accounts 层，holdings/transactions 关联 account_id，改动面中等。',
     'D19、D25', 'C 低', 'L',
     '重度用户（交易 ≥ 50 笔）开通子账户比例 ≥ 20%'),
    ('I14', '数据导出（交割单 / CSV）',
     '支持按时间范围导出交易明细与每日净值，格式兼容常见复盘工具；'
     '提供美观的「年度成绩单」图片一键保存分享。',
     '数据可带走降低用户对「沉没成本」的顾虑（反而提升信任）；'
     '成绩单图片是零成本的社交流量入口。',
     '竞品普遍不提供导出，用户数据被困在系统内。',
     '高：纯查询 + 文件生成，成绩单可用前端 canvas 出图。',
     'D19、D25', 'C 低', 'S',
     '分享图带来新注册 ≥ 500/月'),
    ('I15', '净值曲线 + 成绩单',
     '用户主页展示净值曲线（可叠加同期大盘基准）、最大回撤、夏普比率、'
     '月度收益热力图、交易笔数、最佳/最差单笔，并生成可分享的成绩单。',
     '给用户的努力一个「可视化结果」，是最直接的正反馈与成就载体；'
     '也是 I01 画像与 I09 归因的共同展示层。',
     '竞品多为单数字收益率，无过程可视化，用户难以形成自我认知。',
     '高：依赖 D25 的净值快照，前端图表复用 ECharts。',
     'D25、D07', 'A 高', 'M',
     '主页人均停留时长提升 ≥ 30%；成绩单分享率 ≥ 8%'),
]

# ---------------------------------------------------------------- 路线图
ROAD_HEAD = ['阶段', '阶段目标', '包含需求编号', '建议周期', '验收标准 / 出口条件']
ROADMAP = [
    ('阶段一：止血与可信化',
     '让行情与交易「像真的」，消除致命失真与安全隐患，产品达到可对外演示的基本水准。',
     'D01 D02 D03 D07 D18 D12 D04 D05 D09 D10 D22',
     '1~2 周',
     '1) 连续运行 24h 后无标的长期贴板在 ±10%；2) 出现隔夜跳空与今开≠昨收；'
     '3) 大盘指数为基点法加权；4) 生产环境 JWT 缺失即拒绝启动；'
     '5) 下单价与展示价偏差超阈值被拒绝；6) 并发卖出 20 次无超卖。'),
    ('阶段二：数据地基',
     '把行情、成交、净值全部持久化，为所有分析与训练能力铺路。',
     'D16 D17 D19 D25 D20 D08 D06',
     '2~3 周',
     '1) 重启后价格与市值无跳变；2) 成交量由成交驱动且按日重置；'
     '3) 每笔卖出可查到 realized_pnl；4) 净值曲线可回溯 30 天；'
     '5) 1000 用户下排行榜响应 < 500ms；6) 自选跨设备同步。'),
    ('阶段三：留存引擎',
     '把一次性工具变成可反复使用的训练场，重点打留存与回访。',
     'I02 I03 I07 I15 I01 以及 D23 D24 D26 D27',
     '3~4 周',
     '1) 回放/关卡/小游戏任一入口周活跃用户占比 ≥ 20%；'
     '2) 7 日留存较基线提升 ≥ 10pp；3) 交易画像报告可自动生成；'
     '4) 移动端核心链路（看盘+下单）可用；5) 账户可重置、密码可找回。'),
    ('阶段四：差异化壁垒',
     '上线竞品无法复制的能力，形成口碑与传播。',
     'I04 I05 I06 I09 I11',
     '4~6 周',
     '1) 条件单成交笔数占比 ≥ 20%；2) 房间赛带来新注册占比 ≥ 15%；'
     '3) 剧本关卡完成率 ≥ 60%；4) 收益归因报告分享率 ≥ 10%。'),
    ('阶段五：社交与生态',
     '放大用户间的互动与传播，构建护城河。',
     'I08 I10 I12 I13 I14 以及 D13 D14 D15 D29 D32 D33',
     '4~6 周',
     '1) 跟单用户占比 ≥ 15%；2) 预警设置率 ≥ 25%、预警回访率 ≥ 20%；'
     '2) 安全项（限流/CORS/WS 鉴权）全部上线；4) 500 标的下列表无掉帧。'),
]

# ---------------------------------------------------------------- 健康度
HEALTH_HEAD = ['评估维度', '当前评分（/10）', '判断依据', '主要扣分项', '补齐后可达']
HEALTH = [
    ('行情仿真真实度', 3,
     '随机游走 + 涨跌停已具备雏形，但无交易日、无跳空、无时段、无撮合，长期运行失真。',
     'D01 D02 D03 D06 D17 D18', 8),
    ('交易规则还原度', 4,
     '费用仿真完整（佣金/印花税/过户费）是亮点，但缺 T+1、缺条件单、成本价不含费。',
     'D05 D04 D10 D35', 9),
    ('数据沉淀与分析', 2,
     '仅有当前快照，无净值曲线、无已实现盈亏、无历史行情，复盘能力为零。',
     'D16 D19 D25', 9),
    ('安全与稳定性', 4,
     'JWT/bcrypt 有基础，但默认密钥、无限流、CORS 全开、WS 无鉴权均为高危。',
     'D12 D13 D14 D15 D33', 8),
    ('核心体验完整度', 5,
     '买卖闭环流畅、UI 统一，但自选不落库、无移动端、无重置/找回等基础能力缺失。',
     'D08 D23 D24 D26 D27', 9),
    ('留存与成长机制', 2,
     '除排行榜外无任何目标感、成就感或回访钩子，典型「注册即流失」结构。',
     'D21 D25；全部创新需求缺位', 9),
    ('差异化与创新', 3,
     '自研行情引擎是可造壁垒的底座，但目前只用于随机游走，潜力未释放。',
     'I02 I06 I11 均未落地', 9),
    ('工程可维护性', 6,
     '分层清晰、结构规整，但存在前后端重复逻辑与 N+1 查询等债务。',
     'D11 D20 D29 D32', 8),
]


def style_sheet(ws, headers, rows, widths, title, sev_col=None, prio_col=None):
    ws.append([title])
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    c = ws.cell(row=1, column=1)
    c.font = TITLE_FONT
    c.alignment = Alignment(horizontal='left', vertical='center')
    ws.row_dimensions[1].height = 28

    ws.append([])
    ws.append(headers)
    hr = 3
    for i, _ in enumerate(headers, start=1):
        cell = ws.cell(row=hr, column=i)
        cell.fill = HEAD_FILL
        cell.font = HEAD_FONT
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[hr].height = 32

    for r in rows:
        ws.append(list(r))

    for ri in range(hr + 1, hr + 1 + len(rows)):
        for ci in range(1, len(headers) + 1):
            cell = ws.cell(row=ri, column=ci)
            cell.alignment = Alignment(vertical='top', wrap_text=True)
            cell.border = BORDER
            cell.font = Font(size=10)
        if sev_col:
            v = ws.cell(row=ri, column=sev_col).value
            if v in SEV_FILL:
                ws.cell(row=ri, column=sev_col).fill = SEV_FILL[v]
                ws.cell(row=ri, column=sev_col).alignment = Alignment(
                    horizontal='center', vertical='center', wrap_text=True)
        if prio_col:
            v = ws.cell(row=ri, column=prio_col).value
            if v in PRIO_FILL:
                ws.cell(row=ri, column=prio_col).fill = PRIO_FILL[v]
                ws.cell(row=ri, column=prio_col).alignment = Alignment(
                    horizontal='center', vertical='center', wrap_text=True)

    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = ws.cell(row=hr + 1, column=4)
    ws.auto_filter.ref = f'A{hr}:{get_column_letter(len(headers))}{hr + len(rows)}'


wb = Workbook()

ws1 = wb.active
ws1.title = '缺陷清单'
style_sheet(ws1, DEFECT_HEAD, DEFECTS,
            [7, 11, 10, 30, 52, 34, 40, 48, 8, 9],
            '一、产品缺陷清单（共 %d 项，已逐条定位到代码行）' % len(DEFECTS),
            sev_col=3, prio_col=10)

ws2 = wb.create_sheet('创新需求')
style_sheet(ws2, INNO_HEAD, INNO,
            [7, 24, 54, 46, 44, 30, 14, 9, 8, 30],
            '二、创新机会清单（共 %d 项，按差异化强度与可行性排序）' % len(INNO),
            prio_col=8)

ws3 = wb.create_sheet('迭代路线图')
style_sheet(ws3, ROAD_HEAD, ROADMAP, [22, 44, 40, 12, 62],
            '三、分阶段迭代路线图（先止血 → 再打地基 → 最后建壁垒）')

ws4 = wb.create_sheet('健康度评估')
style_sheet(ws4, HEALTH_HEAD, HEALTH, [20, 14, 52, 30, 12],
            '四、产品健康度评估（当前综合 3.6/10，主要失分在「数据沉淀」与「留存机制」）')

wb.save(OUT)
print('OK ->', OUT)
print('defects:', len(DEFECTS), '| innovation:', len(INNO),
      '| roadmap:', len(ROADMAP), '| health:', len(HEALTH))
