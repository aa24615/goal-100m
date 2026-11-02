#!/usr/bin/env python3
# 用途：第十二轮探测 —— v13 新增路由 + 结构化 query 全路由扩展 + 真实 JSON 类型混淆。
# 运行：python backend/scripts/diag/diag-fuzz-v14.py <routes.txt> <token3> [token4]
#
# 历史已覆盖（勿重复）：标量越界 int4/int8/numeric/interval、U+0000 字符集、
#   结构化 query（仅 14 个老路由）、并发竞态、基线 body 单字段（仅字符串标量）。
# 本轮新增维度：
#   ① 结构化 query（重复键 / 数组 / 嵌套对象）扩展到全部路由，尤其 v13 新增 8 条；
#   ② 合法基线 body + 单字段替换为「真实 JSON 类型」(null/bool/array/object/number)
#      —— 旧脚本 BAD 全为字符串标量，真实类型从未进过业务层；
#   ③ v13 新增端点专项。
# 安全（第 15/19 条）：排除不可逆与创建型端点；发现 5xx 立即把响应体打印出来
#   （第 18 条：日志按大小轮转只留 5 份，必须当场取证）。
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
ROUTES_FILE = sys.argv[1]
T3 = sys.argv[2]
T4 = sys.argv[3] if len(sys.argv) > 3 else T3

# 真实 JSON 类型值：与「字符串标量」有本质区别。
# 10**400 序列化成 401 位整数，JS 的 JSON.parse 会得到 Infinity —— 用来测
# 「数值类型（而非字符串）直接进业务层」的越界路径。
TYPES = [
    None, True, False, 0, -1, 1.5, 10 ** 400, -(10 ** 400),
    [], [1, 2], ["a"], {}, {"a": 1}, {"$gt": ""}, [{"a": 1}], [None],
    "", " ", "abc", "1e309", "Infinity", "A" * 5000, "\u0000",
    "2026-13-45", "0000-00-00",
]

# 结构化 query：让 req.query.x 变成数组 / 对象（Express 默认 qs parser）
STRUCT_Q = [
    "days=1&days=1e309", "days[]=1&days[]=1e309", "days[x]=1",
    "days[a][b]=1", "limit=1&limit=1e20", "limit[]=1&limit[]=abc",
    "limit[x]=1", "from=2026-13-45&to=2026-13-45",
    "start=Infinity&end=Infinity", "startDate=0000-00-00&endDate=0000-00-00",
    "isTest=abc&isTest=TRUE", "gran=abc&gran[]=x", "rq=a&rq=b",
    "ip=a&ip=b", "event=a&event=b", "scope=a&scope=b", "code=a&code=b",
    "goalRegistered=1e309&goalEffective=1e309", "days=1.5&limit=1.5",
    "apply=1&apply=0", "batch=1.5&top=1.5", "window=1.5&days=1.5",
    "days=-1&limit=-1", "days=2147483648&limit=2147483648",
]

# 合法基线 body：字段名必须真实，否则必填校验短路造成假阴性（第 14 条）
# 只挑「纯插入 / 可清理」的端点，避免推进会话、重置、建资源。
CASES = [
    ("/api/analytics/track", {"event": "probe"}, ["event", "payload", "value", "count"]),
    ("/api/analytics/error", {"message": "probe", "kind": "error"},
     ["message", "code", "stack", "level", "url", "userAgent", "appVersion", "kind", "name"]),
    ("/api/review/_pair-check", {"days": 30}, ["days", "limit"]),
    ("/api/public/access/env", {}, ["days", "env"]),
]

# v13 新增 GET 路由专项（相对 routes-1102.txt 新增 8 条）
V13_GET = [
    "/api/analytics/isolation",
    "/api/analytics/isolation/backfill",
    "/api/invite/codes",
    "/api/invite/funnel",
    "/api/public/gate",
]
V13_Q = STRUCT_Q + [
    "days=1e309", "days[]=1e309", "limit=1e309", "limit[]=1e309",
    "goalRegistered[]=1&goalEffective[]=1", "rq=1&rq=2", "ip=1&ip=2",
    "days=1&days=2&days=3", "limit=1.5", "days=abc",
]

HANDLES = ["7", "5", "6"]
REPLAY = "1"
CODE = "600519"

# 不可逆 / 创建型端点：一律跳过（第 19 条：返回 200 不等于没副作用）
DANGER = ("reset", "finish", "abandon", "/apply", "purge", "delete",
          "/api/orders", "/api/watchlist", "/api/blind/start",
          "/api/blind/prescription/start", "/api/replay/start",
          "/api/challenge/join", "/api/trade", "/api/market/next-day",
          "/api/account", "/api/guest/session", "/api/invite/codes",
          "/api/invite/bind", "/api/analytics/isolation/backfill")


def dangerous(p):
    lp = p.lower()
    return any(d in lp for d in DANGER)


def call(method, path, body=None, token=None, raw=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = raw
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read(1200).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read(1200).decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return "EXC:" + type(e).__name__, ""


def variants(p):
    if ":code" in p:
        return [(p.replace(":code", CODE), T3)]
    out = []
    if "replay" in p:
        out.append((p.replace(":id", REPLAY), T4))
    elif "blind" in p:
        for h in HANDLES:
            out.append((p.replace(":id", h), T3))
    else:
        out.append((p.replace(":id", HANDLES[0]), T3))
    return out


def main():
    routes = []
    with open(ROUTES_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("TOTAL"):
                continue
            m, _, p = line.partition(" ")
            if dangerous(p):
                continue
            routes.append((m, p))
    print(f"### 载入 {len(routes)} 条安全路由", flush=True)

    findings = []
    n = 0
    t0 = time.time()

    def record(tag, method, path, payload, st, text):
        findings.append((tag, method, path, payload, st))
        print(
            f"  >>> [5xx] {tag} {method} {path} -> {st} "
            f"payload={json.dumps(payload, ensure_ascii=False, default=str)[:180]} "
            f"body={text[:300]}",
            flush=True,
        )

    # 阶段 1：GET 全路由基线（自证通道有效，第 12 条）
    print("### 阶段1 GET 基线", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        for real, tok in variants(p):
            st, text = call("GET", real, token=tok)
            n += 1
            if isinstance(st, int) and st >= 500:
                record("BASE", "GET", real, None, st, text)

    # 阶段 2：GET 全路由 + 结构化 query（新维度 ①）
    print("### 阶段2 GET 结构化 query（全路由）", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        for real, tok in variants(p):
            for q in STRUCT_Q:
                sep = "&" if "?" in real else "?"
                st, text = call("GET", real + sep + q, token=tok)
                n += 1
                if isinstance(st, int) and st >= 500:
                    record("GETQ", "GET", real + sep + q, q, st, text)

    # 阶段 3：v13 新增 GET 专项（新维度 ③）
    print("### 阶段3 v13 新增 GET 专项", flush=True)
    for real in V13_GET:
        for q in V13_Q:
            sep = "&" if "?" in real else "?"
            st, text = call("GET", real + sep + q, token=T3)
            n += 1
            if isinstance(st, int) and st >= 500:
                record("V13", "GET", real + sep + q, q, st, text)

    # 阶段 4：合法基线 body + 单字段替换为真实 JSON 类型（新维度 ②）
    print("### 阶段4 基线 body + 真实 JSON 类型替换", flush=True)
    for path, base, fields in CASES:
        st, text = call("POST", path, body=base, token=T3)
        n += 1
        print(f"  基线 POST {path} -> {st}", flush=True)
        if isinstance(st, int) and st >= 500:
            record("BODY-BASE", "POST", path, base, st, text)
        for f in fields:
            for v in TYPES:
                body = dict(base)
                body[f] = v
                st, text = call("POST", path, body=body, token=T3)
                n += 1
                if isinstance(st, int) and st >= 500:
                    record("BODY", "POST", path, body, st, text)

    dt = time.time() - t0
    print(f"\n### 合计 {n} 用例，耗时 {dt:.0f}s，5xx {len(findings)}", flush=True)
    seen = set()
    for tag, m, p, payload, st in findings:
        key = (tag, m, p.split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        print(
            f"  [{tag}] {m} {p} -> {st}  "
            f"{json.dumps(payload, ensure_ascii=False, default=str)[:160] if payload else ''}",
            flush=True,
        )


if __name__ == "__main__":
    main()
