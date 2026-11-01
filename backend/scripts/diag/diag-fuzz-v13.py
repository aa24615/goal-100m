#!/usr/bin/env python3
# 用途：第十一轮模糊测试 —— **新列类型家族**版。
# 背景：前几轮已覆盖 int4(22003) / int8(22P02) / numeric(22003) / interval(22007/22015)
#       四类数值列。本轮按「第 11 条套路」横向扫**剩余列类型家族**：
#         date(22008) / timestamptz(22007) / boolean(22P02) / smallint(22003)
#         / varchar(N)(22001) / jsonb(22P02)
# 运行：python backend/scripts/diag/diag-fuzz-v13.py <routes.txt> <token3> <token4>
# 安全约定（第 15 条）：
#   ① 基线阶段**跳过不可逆端点**（reset/finish/abandon/apply/purge/DELETE），
#      上一轮曾因基线误调 finish 污染了会话 7。
#   ② 路径参数一律填**真实存在**的 ID（第 10 条），否则业务层 404 短路造成假阴性。
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:8080"
ROUTES_FILE = sys.argv[1] if len(sys.argv) > 1 else "routes.txt"
T3 = sys.argv[2] if len(sys.argv) > 2 else ""
T4 = sys.argv[3] if len(sys.argv) > 3 else ""

# 真实资源句柄：user3 -> blind 7；user4 -> blind 6 / replay 1
HANDLES = [("7", T3), ("5", T3), ("6", T4)]
REPLAY = "1"
CODE = "600519"

# ---- 新的取值族：按列类型分别构造越界值 ----
DATES = ["abc", "", "2026-13-45", "2026-02-30", "0000-00-00", "999999-01-01",
         "100000-01-01", "-1", "1e309", "Infinity", "2026-11-02T99:99:99Z"]
BOOLS = ["abc", "1.5", "[]", "{}", "yes", "TRUE_x", "2", "-1", "Infinity"]
SMALL = ["40000", "-40000", "1e20", "2147483648", "abc", "1.5", ""]
VARCHARS = ["A" * 5000, "A" * 300, "测" * 200]
JSONS = ["{", "[", "{\"a\":", "\"\\\"", "not-json", "1e309"]

BAD = DATES + BOOLS + SMALL + VARCHARS + JSONS

# 参数名：按列类型的常见命名穷举（日期族是上几轮完全没覆盖的）
DATE_PARAMS = ["date", "from", "to", "startDate", "endDate", "day", "tradeDate",
               "challengeDate", "deadline", "since", "until", "at", "start", "end",
               "startAt", "endAt", "expiresAt", "createdAt"]
BOOL_PARAMS = ["skipped", "isTest", "includeTest", "onlyTest", "force", "withTest",
               "external", "strict", "effective", "all", "done"]
SMALL_PARAMS = ["netWin", "net_win", "score", "level"]
OTHER_PARAMS = ["alias", "reason", "note", "kind", "name", "message", "period",
                "theme", "density", "preset", "tag", "label", "key"]

PARAMS = DATE_PARAMS + BOOL_PARAMS + SMALL_PARAMS + OTHER_PARAMS

# 成对组合：日期区间是典型的「两个参数同时给出才进分支」
PAIRS = [("from", "to"), ("startDate", "endDate"), ("since", "until"),
         ("start", "end"), ("date", "limit"), ("from", "limit")]

POST_FIELDS = ["skipped", "alias", "reason", "note", "code", "stockCode", "side",
               "action", "kind", "name", "message", "period", "theme", "density",
               "date", "tradeDate", "deadline", "netWin", "isTest", "preset", "tag"]

# 不可逆端点：一律不调用（基线 + 模糊 + 路径全部跳过）
DANGER = ("reset", "finish", "abandon", "apply", "purge", "delete",
          "/api/orders", "/api/watchlist")


def call(method, path, body=None, token=""):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "EXC:" + type(e).__name__


def dangerous(p):
    lp = p.lower()
    return any(d in lp for d in DANGER)


def variants(p):
    """返回 (填充后的路径, token) 列表：优先用真实句柄，其次用默认句柄。"""
    if ":code" in p:
        return [(p.replace(":code", CODE), T3)]
    out = []
    if "replay" in p:
        out.append((p.replace(":id", REPLAY), T4))
    elif "blind" in p:
        for h, t in HANDLES:
            out.append((p.replace(":id", h), t))
    else:
        for h, t in HANDLES[:1]:
            out.append((p.replace(":id", h), t))
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

    findings = []
    n = 0
    t0 = time.time()
    print(f"### 载入 {len(routes)} 条安全路由（已剔除不可逆端点）", flush=True)

    # 阶段 1：基线自证（只跑安全端点）
    print("### 阶段1 基线", flush=True)
    for m, p in routes:
        for real, tok in variants(p):
            st = call(m, real, None, tok)
            n += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("BASE", m, real, None, st))

    # 阶段 2：GET 日期/布尔/短整型/超长串 单参数
    print("### 阶段2 GET 单参数", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        for real, tok in variants(p):
            for a in PARAMS:
                for v in BAD:
                    q = urllib.parse.urlencode({a: v})
                    st = call("GET", real + "?" + q, None, tok)
                    n += 1
                    if isinstance(st, int) and st >= 500:
                        findings.append(("GETQ", "GET", real, {a: v[:40]}, st))

    # 阶段 3：GET 成对（日期区间类）
    print("### 阶段3 GET 成对参数", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        for real, tok in variants(p):
            for a, b in PAIRS:
                for v in BAD:
                    q = urllib.parse.urlencode({a: v, b: v})
                    st = call("GET", real + "?" + q, None, tok)
                    n += 1
                    if isinstance(st, int) and st >= 500:
                        findings.append(("GETPAIR", "GET", real, {a: v[:40], b: v[:40]}, st))

    # 阶段 4：写操作 body（新的列类型字段）
    print("### 阶段4 写操作 body", flush=True)
    for m, p in routes:
        if m not in ("POST", "PUT", "PATCH"):
            continue
        for real, tok in variants(p):
            for f in POST_FIELDS:
                for v in BAD:
                    st = call(m, real, {f: v}, tok)
                    n += 1
                    if isinstance(st, int) and st >= 500:
                        findings.append(("BODY", m, real, {f: v[:40]}, st))

    dt = time.time() - t0
    print(f"\n### 合计 {n} 用例，耗时 {dt:.0f}s，5xx {len(findings)}", flush=True)
    seen = set()
    for kind, m, p, payload, st in findings:
        key = (kind, m, p.split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{kind}] {m} {p} -> {st}  {json.dumps(payload, ensure_ascii=False)[:160] if payload else ''}")


if __name__ == "__main__":
    main()
