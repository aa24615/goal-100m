#!/usr/bin/env python3
# 用途：第四轮模糊测试 —— **合法基线 body + 单个非法字段**。
# 背景：diag-fuzz-v12.py 的阶段 5 每次只提交 `{字段: 非法值}` 一个键，这类请求会在
#       **必填校验处短路**（例如缺 code 直接 400），永远到不了 SQL 层，属系统性漏检。
#       本脚本补上：先给一份能通过校验的合法 body，再逐字段替换成非法值。
# 运行：python backend/scripts/diag/diag-fuzz-body.py "$TOKEN" <blindId> <replayId>
# 安全：刻意跳过会改动真实账号数据的端点（account/reset、test-marks/apply、
#       blind finish/abandon、DELETE 类），它们要么不可逆要么只能跑一次。
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""
BLIND = sys.argv[2] if len(sys.argv) > 2 else "7"
REPLAY = sys.argv[3] if len(sys.argv) > 3 else "154"

NUMS = ["-1", "0", "1.5", "abc", "NaN", "Infinity", "-Infinity", "1e309",
        "2147483648", "9223372036854775808", "99999999999999999999", "1e20"]
OBJS = ["", "   ", "true", "null", "[]", "{}", "%27", "\\", "A" * 5000, "\U0001F600"]
BAD = NUMS + OBJS

# (路径模板, 合法基线 body, 要模糊的字段)
# 基线必须能通过校验，否则非法值根本到不了 SQL 层
CASES = [
    ("/api/blind/{blind}/decision", {"action": "hold", "reason": "probe", "stopPlan": 10},
     ["action", "reason", "stopPlan", "skipped"]),
    ("/api/blind/{blind}/step", {"bars": 1}, ["bars", "steps", "count"]),
    ("/api/blind/{blind}/trade", {"side": "buy", "shares": 100}, ["shares", "price", "side", "qty"]),
    ("/api/replay/{replay}/step", {"bars": 1}, ["bars", "steps", "count"]),
    ("/api/replay/{replay}/trade", {"code": "600519", "side": "buy", "shares": 100},
     ["shares", "price", "side", "code", "qty"]),
    ("/api/replay/start", {"startSeq": 8640, "endSeq": 8650},
     ["startSeq", "endSeq", "capital", "cash", "bars"]),
    ("/api/trade", {"code": "600519", "side": "buy", "shares": 100}, ["shares", "price", "side", "code"]),
    ("/api/orders", {"code": "600519", "side": "buy", "shares": 100, "price": 10},
     ["shares", "price", "side", "code"]),
    ("/api/watchlist", {"code": "600519"}, ["code", "groupId", "group"]),
    ("/api/challenge/join", {"templateId": 1}, ["templateId", "id"]),
    ("/api/challenge/streak/check", {}, ["days"]),
    ("/api/analytics/track", {"event": "checkup_view"}, ["event", "value", "count", "payload"]),
    ("/api/analytics/error", {"message": "probe", "kind": "error"},
     ["message", "code", "stack", "level", "url", "userAgent", "appVersion", "kind", "name"]),
    ("/api/attribution/attach", {"channel": "direct"}, ["channel", "value"]),
    ("/api/attribution/link", {"channel": "direct"}, ["channel", "value"]),
    ("/api/onboarding/checkin", {}, ["step", "day"]),
    ("/api/onboarding/guide", {}, ["step", "day"]),
    ("/api/market/next-day", {}, ["days", "steps"]),
    ("/api/review/_pair-check", {"days": 30}, ["days", "limit"]),
    ("/api/analytics/integrity/purge", {}, ["batch", "apply", "days"]),
    ("/api/guest/session", {}, ["days", "token"]),
    ("/api/public/access/env", {}, ["days", "env"]),
]

# 路径参数越界（真实 ID 替换成非法值）
PATHS = [
    "GET /api/blind/{blind}", "GET /api/blind/{blind}/card", "GET /api/blind/{blind}/decisions",
    "GET /api/blind/{blind}/parity", "GET /api/blind/{blind}/settlement",
    "GET /api/blind/{blind}/settlement/audit", "GET /api/blind/{blind}/baseline",
    "GET /api/replay/{replay}", "GET /api/replay/compare",
]


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


def fill(t):
    return t.replace("{blind}", BLIND).replace("{replay}", REPLAY)


def main():
    findings = []
    n = 0
    t0 = time.time()

    print("### B1 合法基线 + 单字段非法", flush=True)
    for tpl, base, fields in CASES:
        p = fill(tpl)
        st = call("POST", p, base)
        n += 1
        print(f"  基线 POST {p} -> {st}", flush=True)
        for f in fields:
            for v in BAD:
                body = dict(base)
                body[f] = v
                st = call("POST", p, body)
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("BODY", p, body, st))

    print("### B2 路径参数越界", flush=True)
    for spec in PATHS:
        m, tpl = spec.split(" ", 1)
        real = fill(tpl)
        st = call(m, real)
        n += 1
        print(f"  基线 {m} {real} -> {st}", flush=True)
        for v in NUMS + ["abc", "A" * 300]:
            cand = real.replace(BLIND, v, 1) if "{blind}" in tpl else real.replace(REPLAY, v, 1)
            st = call(m, cand)
            n += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("PATH", m + " " + cand, None, st))

    print(f"\n### 合计 {n} 用例，耗时 {time.time() - t0:.0f}s，5xx {len(findings)}", flush=True)
    seen = set()
    for kind, p, body, st in findings:
        key = (kind, p.split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{kind}] {p} -> {st}  {json.dumps(body, ensure_ascii=False)[:160] if body else ''}")


if __name__ == "__main__":
    main()
