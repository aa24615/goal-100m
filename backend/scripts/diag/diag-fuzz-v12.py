#!/usr/bin/env python3
# 用途：第三轮模糊测试 —— **全路由自动派生**版（不依赖手工维护的路由表）。
# 背景：前两轮的路由表是手写的，v12（提交 d8d1123）新增的 analytics/attribution 路由
#      从未被覆盖过。本脚本直接从容器内枚举出的路由清单出发，自动替代 :param 占位，
#      对「单参数 / 成对参数 / POST body」三类做越界探测。
# 运行：python backend/scripts/diag/diag-fuzz-v12.py "$TOKEN" <routes.txt> <blindId> <replayId>
#   routes.txt 由 diag-routes.mjs 生成（每行 "GET /api/x/:id"）
# 注意：① 路径参数一律填**真实存在**的 ID，否则 404 短路会导致假阴性（第 10 条套路）；
#       ② 本脚本会用非法值调用创建型端点，可能产生少量会话，**跑完必须按时间核对后清理**。
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
ROUTES_FILE = sys.argv[2] if len(sys.argv) > 2 else "routes.txt"
BLIND = sys.argv[3] if len(sys.argv) > 3 else "7"
REPLAY = sys.argv[4] if len(sys.argv) > 4 else "153"
CODE = "600519"

# 数值越界候选：覆盖 int4 / int8 / numeric(p,s) / interval 四类列的上溢下溢
NUMS = ["-1", "0", "1.5", "abc", "NaN", "Infinity", "-Infinity",
        "1e309", "-1e309", "2147483648", "9223372036854775808",
        "99999999999999999999", "1e20"]

# 非数值候选：类型混淆 / 超长串 / 注入形貌
OBJS = ["", "   ", "true", "null", "[]", "{}", "%27", "\\", "A" * 5000,
        "600519; DROP TABLE users", "\U0001F600"]

BAD = NUMS + OBJS

# 通用查询参数名（按项目里出现过的命名习惯穷举，宁可多打不可漏打）
PARAMS = ["days", "limit", "offset", "page", "code", "gran", "granularity",
          "fmt", "format", "startSeq", "endSeq", "bars", "weeks", "status",
          "kw", "level", "type", "id", "value", "count", "threshold",
          "presetId", "templateId", "minSamples", "window", "bucket"]

# 成对组合：单参数探测扫不到「两个参数同时给出才进分支」的缺陷
PAIRS = [("days", "limit"), ("limit", "offset"), ("startSeq", "endSeq"),
         ("startSeq", "limit"), ("days", "offset"), ("limit", "page"),
         ("days", "gran"), ("bars", "gran")]

# 通用 POST 字段：非法值灌入，绝不与合法值同时全量提交（避免真的创建资源）
POST_FIELDS = ["days", "limit", "offset", "bars", "startSeq", "endSeq",
               "shares", "price", "count", "value", "threshold", "id",
               "templateId", "presetId", "minSamples", "window", "code"]

# 会真实建数据的端点：即使带非法值也可能因「回落默认值」而成功，需要事后清理
CREATING = ("/api/blind/start", "/api/blind/prescription/start",
            "/api/replay/start", "/api/orders", "/api/challenge/join",
            "/api/watchlist")


def call(method, path, body=None):
    headers = {"Accept": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
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


def fill(path):
    """把 :param 占位换成真实存在的资源句柄 —— 用不存在的 ID 会在业务层 404 短路。"""
    out = []
    for seg in path.split("/"):
        if not seg.startswith(":"):
            out.append(seg)
            continue
        name = seg[1:]
        if "blind" in path:
            out.append(BLIND)
        elif "replay" in path:
            out.append(REPLAY)
        elif name == "code":
            out.append(CODE)
        else:
            out.append(BLIND)
    return "/".join(out)


def main():
    routes = []
    with open(ROUTES_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("TOTAL"):
                continue
            m, _, p = line.partition(" ")
            routes.append((m, p))

    findings = []
    created = []
    n = 0
    t0 = time.time()

    print(f"### 载入 {len(routes)} 条路由", flush=True)

    # 阶段 1：基线（真实参数，确认端点可达且自证探测通道有效）
    print("### 阶段1 基线", flush=True)
    for m, p in routes:
        real = fill(p)
        st = call(m, real)
        n += 1
        if isinstance(st, int) and st >= 500:
            findings.append(("BASE", m, real, None, st))
        elif m == "POST" and st == 200 and any(k in real for k in CREATING):
            created.append(real)

    # 阶段 2：GET 单参数越界
    print("### 阶段2 GET 单参数", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        real = fill(p)
        for a in PARAMS:
            for v in BAD:
                q = urllib.parse.urlencode({a: v})
                st = call("GET", real + "?" + q)
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("GETQ", "GET", real, {a: v}, st))

    # 阶段 3：GET 成对参数
    print("### 阶段3 GET 成对参数", flush=True)
    for m, p in routes:
        if m != "GET":
            continue
        real = fill(p)
        for a, b in PAIRS:
            for v in BAD:
                q = urllib.parse.urlencode({a: v, b: v})
                st = call("GET", real + "?" + q)
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("GETPAIR", "GET", real, {a: v, b: v}, st))

    # 阶段 4：路径参数越界（用真实路由的占位段逐个替换）
    print("### 阶段4 路径参数越界", flush=True)
    for m, p in routes:
        if ":" not in p:
            continue
        real = fill(p)
        for v in NUMS + ["abc", "A" * 300]:
            cand = real
            for handle in (BLIND, REPLAY, CODE):
                if handle and handle in cand:
                    cand = cand.replace(handle, v, 1)
                    break
            st = call(m, cand)
            n += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("PATH", m, cand, None, st))

    # 阶段 5：写操作 body 越界（每个提交体至少含一个非法值）
    print("### 阶段5 写操作 body", flush=True)
    for m, p in routes:
        if m not in ("POST", "PUT", "PATCH"):
            continue
        real = fill(p)
        for f in POST_FIELDS:
            for v in BAD:
                st = call(m, real, {f: v})
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("BODY", m, real, {f: v}, st))
                elif st == 200 and any(k in real for k in CREATING):
                    created.append(real)

    dt = time.time() - t0
    print(f"\n### 合计 {n} 用例，耗时 {dt:.0f}s，5xx {len(findings)}", flush=True)
    seen = set()
    for kind, m, p, payload, st in findings:
        key = (kind, m, p.split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{kind}] {m} {p} -> {st}  {json.dumps(payload, ensure_ascii=False)[:160] if payload else ''}")
    if created:
        print(f"\n### 可能新建了资源（需清理）：{sorted(set(created))}")


if __name__ == "__main__":
    main()
