#!/usr/bin/env python3
# 用途：第一轮模糊测试 —— 路径参数越界 / 成对查询参数 / POST body。使用不存在的资源 ID。
# 运行：TOKEN=$(容器内签发) python backend/scripts/diag/diag-fuzz.py "$TOKEN"
# 局限：不存在的资源会在业务层 404 短路，**到不了 SQL 层**，必须配合 diag-fuzz-real.py 使用。
#!/usr/bin/env python3
"""生产环境参数模糊探测：路径参数 / 成对查询参数 / POST body。
目标：发现应返回 4xx 却返回 5xx 的入参越界缺陷。
只灌非法值，不用合法值创建业务数据。
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1] if len(sys.argv) > 1 else ""

BAD = ["-1", "0", "-0", "1.5", "abc", "NaN", "Infinity", "-Infinity",
       "1e309", "-1e309", "2147483648", "9223372036854775808",
       "99999999999999999999", "1e20"]

# GET 路由：(模板, [查询参数名])
GET_ROUTES = [
    ("/api/blind/{id}", []),
    ("/api/blind/{id}/card", []),
    ("/api/blind/{id}/decisions", []),
    ("/api/blind/{id}/parity", []),
    ("/api/blind/{id}/settlement", []),
    ("/api/blind/history", ["limit", "offset", "page"]),
    ("/api/blind/presets", []),
    ("/api/blind/presets/resolve", ["code", "bars", "startSeq", "endSeq"]),
    ("/api/blind/resume", []),
    ("/api/blind/tags", ["limit", "offset"]),
    ("/api/challenge/board", ["limit", "days"]),
    ("/api/challenge/streak", ["days"]),
    ("/api/config/archived", []),
    ("/api/equity", ["gran", "days", "limit"]),
    ("/api/leaderboard", ["limit", "offset"]),
    ("/api/leaderboard/benchmark", ["days", "limit"]),
    ("/api/market/history", ["days", "period", "limit"]),
    ("/api/market/summary", ["days", "limit"]),
    ("/api/orders", ["limit", "offset", "page", "status"]),
    ("/api/portfolio", []),
    ("/api/replay/compare", ["left", "right", "a", "b"]),
    ("/api/replay/history", ["limit", "offset", "page"]),
    ("/api/replay/range", ["startSeq", "endSeq", "gran", "limit"]),
    ("/api/replay/{id}", []),
    ("/api/review", ["limit", "offset", "days"]),
    ("/api/review/ability", ["days", "limit"]),
    ("/api/review/benchmark", ["days", "limit"]),
    ("/api/review/checkup", ["days", "limit"]),
    ("/api/review/export", ["limit", "days", "fmt"]),
    ("/api/review/latest", ["limit"]),
    ("/api/review/share-card", ["days", "limit"]),
    ("/api/stocks", ["limit", "offset", "page", "kw"]),
    ("/api/stocks/{code}", []),
    ("/api/stocks/{code}/daily", ["startSeq", "endSeq", "limit", "gran"]),
    ("/api/transactions", ["limit", "offset", "page"]),
    ("/api/transactions/export", ["limit", "offset", "fmt"]),
    ("/api/watchlist", []),
    ("/api/watchlist/groups", []),
    ("/api/analytics/errors", ["limit", "offset", "days"]),
    ("/api/analytics/events", ["limit", "offset", "days"]),
    ("/api/analytics/dashboard", ["days", "limit"]),
    ("/api/analytics/overview", ["days", "limit"]),
    ("/api/analytics/funnel", ["days", "limit"]),
    ("/api/analytics/retention", ["days", "limit"]),
    ("/api/analytics/weekly", ["days", "limit", "weeks"]),
    ("/api/analytics/stats", ["days", "limit"]),
    ("/api/analytics/acquisition", ["days", "limit"]),
    ("/api/analytics/north-star", ["days", "limit"]),
    ("/api/analytics/tier-progress", ["days", "limit"]),
    ("/api/analytics/small-sample", ["days", "limit"]),
    ("/api/analytics/notifications", ["limit", "offset"]),
    ("/api/attribution/channels", ["days", "limit"]),
    ("/api/attribution/coverage", ["days", "limit"]),
    ("/api/growth/funnel", ["days", "limit"]),
    ("/api/public/access", []),
]

# POST 路由：(模板, {字段名: [候选值]}) —— 只灌非法值
POST_ROUTES = [
    ("/api/blind/start", {"code": ["600519"], "startSeq": BAD, "endSeq": BAD, "bars": BAD}),
    ("/api/blind/prescription", {"code": ["600519"], "bars": BAD, "startSeq": BAD, "endSeq": BAD}),
    ("/api/blind/prescription/start", {"presetId": BAD, "bars": BAD}),
    ("/api/blind/{id}/step", {"bars": BAD, "steps": BAD}),
    ("/api/blind/{id}/trade", {"shares": BAD, "price": BAD, "side": ["buy"], "action": ["buy"]}),
    ("/api/blind/{id}/finish", {"reason": ["test"]}),
    ("/api/blind/{id}/abandon", {"reason": ["test"]}),
    ("/api/trade", {"code": ["600519"], "side": ["buy"], "shares": BAD, "price": BAD}),
    ("/api/orders", {"code": ["600519"], "side": ["buy"], "shares": BAD, "price": BAD}),
    ("/api/replay/start", {"code": ["600519"], "startSeq": BAD, "endSeq": BAD, "bars": BAD, "cash": BAD}),
    ("/api/replay/{id}/step", {"bars": BAD, "steps": BAD}),
    ("/api/replay/{id}/trade", {"shares": BAD, "price": BAD, "side": ["buy"]}),
    ("/api/replay/{id}/finish", {"reason": ["test"]}),
    ("/api/challenge/join", {"templateId": BAD, "id": BAD}),
    ("/api/challenge/streak/check", {"days": BAD}),
    ("/api/challenge/board/check", {"days": BAD, "limit": BAD}),
    ("/api/market/next-day", {"days": BAD, "steps": BAD}),
    ("/api/watchlist", {"code": ["600519"], "groupId": BAD}),
    ("/api/onboarding/checkin", {"step": BAD, "day": BAD}),
    ("/api/onboarding/guide", {"step": BAD}),
    ("/api/onboarding/restart", {"step": BAD}),
    ("/api/analytics/track", {"event": ["diag"], "value": BAD, "count": BAD}),
    ("/api/analytics/error", {"message": ["diag"], "code": BAD}),
    ("/api/attribution/attach", {"channel": ["diag"], "value": BAD}),
    ("/api/attribution/link", {"channel": ["diag"], "value": BAD}),
    ("/api/review/_pair-check", {"days": BAD, "limit": BAD}),
    ("/api/guest/session", {"days": BAD}),
    ("/api/public/access/env", {"days": BAD}),
]


def call(method, path, body=None):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, time.time() - t0
    except Exception as e:
        return "EXC:" + type(e).__name__, time.time() - t0


def fill(tpl, id_val="1", code_val="600519"):
    return tpl.replace("{id}", id_val).replace("{code}", code_val)


def main():
    findings = []
    total = 0

    # 1) 路径参数越界
    print("### 阶段1 路径参数越界", flush=True)
    for tpl, _ in GET_ROUTES:
        if "{id}" not in tpl and "{code}" not in tpl:
            continue
        for v in BAD:
            for getter in (lambda t, x: fill(t, id_val=x), lambda t, x: fill(t, code_val=x)):
                p = getter(tpl, v)
                st, ms = call("GET", p)
                total += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("PATH", "GET", p, None, st))
    print(f"  路径用例 {total}，5xx {len(findings)}", flush=True)

    # 2) 成对查询参数
    print("### 阶段2 成对查询参数", flush=True)
    p2 = 0
    for tpl, params in GET_ROUTES:
        if len(params) < 2:
            continue
        for i in range(len(params)):
            for j in range(i + 1, len(params)):
                a, b = params[i], params[j]
                for v in BAD:
                    q = urllib.parse.urlencode({a: v, b: v})
                    p = fill(tpl) + "?" + q
                    st, ms = call("GET", p)
                    p2 += 1
                    if isinstance(st, int) and st >= 500:
                        findings.append(("PAIR", "GET", p, None, st))
    print(f"  成对用例 {p2}，累计5xx {len(findings)}", flush=True)

    # 3) POST body
    print("### 阶段3 POST body", flush=True)
    p3 = 0
    for tpl, fields in POST_ROUTES:
        # 基线：合法最小 body 先跑一次，确认端点可达（不统计为缺陷）
        base = {k: v[0] for k, v in fields.items()}
        base_path = fill(tpl)
        # 逐字段灌非法值
        for field, cands in fields.items():
            for v in cands:
                body = dict(base)
                body[field] = v
                st, ms = call("POST", base_path, body)
                p3 += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("BODY", "POST", base_path, body, st))
    print(f"  POST 用例 {p3}，累计5xx {len(findings)}", flush=True)

    print(f"\n### 合计 {total + p2 + p3} 用例，发现 5xx {len(findings)}")
    seen = set()
    for kind, method, p, body, st in findings:
        key = (kind, p.split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{kind}] {method} {p} -> {st}  body={json.dumps(body, ensure_ascii=False) if body else ''}")


if __name__ == "__main__":
    main()
