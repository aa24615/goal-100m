#!/usr/bin/env python3
# 用途：第二轮模糊测试 —— 针对**真实存在**的资源做参数攻击，穿透业务校验直达 SQL 层。
# 运行：python backend/scripts/diag/diag-fuzz-real.py "$TOKEN" <blindId> <replayId>
# 这是挖出 numeric(18,2) 越界（capital=1e20 -> 500）的脚本，第一轮没能覆盖。
# 注意：本脚本会真实创建资源，跑完必须按 created_at + user_id 核对后清理。
#!/usr/bin/env python3
"""第二轮：针对**真实存在**的资源做参数攻击，穿透业务校验直达 SQL 层。
第一轮用不存在的 ID 会在 404 短路，那是本方法的盲区；本脚本补上。
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1]
BLIND = sys.argv[2] if len(sys.argv) > 2 else "7"
REPLAY = sys.argv[3] if len(sys.argv) > 3 else "3"

NUMS = ["-1", "0", "-0", "1.5", "abc", "NaN", "Infinity", "-Infinity",
        "1e309", "-1e309", "2147483648", "9223372036854775808",
        "99999999999999999999", "1e20", "-2147483649"]

OBJS = [None, True, False, [], [1, 2, 3], {}, {"a": 1}, "", "   ",
        "A" * 5000, "600519; DROP TABLE users", "%27", "\\", "", "\U0001F600",
        "1,2", "0x10", "1e-309", "true", "null"]

BAD = NUMS + OBJS

GET_REAL = [
    ("/api/blind/{blind}", []),
    ("/api/blind/{blind}/card", ["limit", "offset"]),
    ("/api/blind/{blind}/decisions", ["limit", "offset"]),
    ("/api/blind/{blind}/parity", ["limit", "days"]),
    ("/api/blind/{blind}/settlement", ["limit", "days"]),
    ("/api/replay/{replay}", []),
    ("/api/replay/compare", ["startSeq", "endSeq"]),
]

# 真实资源上的 POST 端点：(路径模板, {字段: 基线值}, [要模糊的字段])
POST_REAL = [
    ("/api/blind/{blind}/step", {"bars": 1}, ["bars", "steps", "count"]),
    ("/api/blind/{blind}/trade", {"side": "buy", "shares": 100}, ["shares", "price", "side", "qty"]),
    ("/api/blind/{blind}/decision", {"action": "hold", "note": "x"}, ["action", "note", "confidence", "score"]),
    ("/api/replay/{replay}/step", {"bars": 1}, ["bars", "steps", "count"]),
    ("/api/replay/{replay}/trade", {"code": "600519", "side": "buy", "shares": 100}, ["shares", "price", "side", "code", "qty"]),
    ("/api/trade", {"code": "600519", "side": "buy", "shares": 100}, ["shares", "price", "side", "code", "qty"]),
    ("/api/orders", {"code": "600519", "side": "buy", "shares": 100, "price": 10}, ["shares", "price", "side", "code"]),
    ("/api/watchlist", {"code": "600519"}, ["code", "groupId", "group"]),
    ("/api/replay/start", {"startSeq": 8640, "endSeq": 8650}, ["startSeq", "endSeq", "capital", "cash"]),
    ("/api/blind/start", {"code": "600519"}, ["code", "bars", "startSeq", "endSeq", "granularity"]),
    ("/api/challenge/join", {"templateId": 1}, ["templateId", "id"]),
    ("/api/analytics/track", {"event": "diag"}, ["event", "value", "count", "payload"]),
    ("/api/analytics/error", {"message": "diag"}, ["message", "code", "stack", "level"]),
    ("/api/market/next-day", {}, ["days", "steps"]),
    ("/api/onboarding/guide", {}, ["step", "day"]),
    ("/api/onboarding/checkin", {}, ["step", "day"]),
]


def call(method, path, body=None):
    headers = {"Accept": "application/json", "Authorization": "Bearer " + TOKEN}
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

    print("### R1 真实资源 GET + 查询参数", flush=True)
    for tpl, params in GET_REAL:
        p = fill(tpl)
        st = call("GET", p)
        n += 1
        print(f"  基线 {p} -> {st}", flush=True)
        for a in params:
            for v in BAD:
                q = urllib.parse.urlencode({a: v if isinstance(v, str) else json.dumps(v)})
                st = call("GET", p + "?" + q)
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("GETQ", p, {a: v}, st))
        # 成对
        if len(params) >= 2:
            for i in range(len(params)):
                for j in range(i + 1, len(params)):
                    for v in NUMS:
                        q = urllib.parse.urlencode({params[i]: v, params[j]: v})
                        st = call("GET", p + "?" + q)
                        n += 1
                        if isinstance(st, int) and st >= 500:
                            findings.append(("GETPAIR", p, {params[i]: v, params[j]: v}, st))

    print("### R2 真实资源 POST body", flush=True)
    for tpl, base, fields in POST_REAL:
        p = fill(tpl)
        st = call("POST", p, base)
        n += 1
        print(f"  基线 POST {p} {json.dumps(base)} -> {st}", flush=True)
        for f in fields:
            for v in BAD:
                body = dict(base)
                body[f] = v
                st = call("POST", p, body)
                n += 1
                if isinstance(st, int) and st >= 500:
                    findings.append(("POST", p, body, st))

    print(f"\n### 合计 {n} 用例，5xx {len(findings)}", flush=True)
    seen = set()
    for kind, p, payload, st in findings:
        key = (kind, p, str(payload)[:80])
        if key in seen:
            continue
        seen.add(key)
        print(f"  [{kind}] {p} -> {st}  {json.dumps(payload, ensure_ascii=False)[:200]}")


if __name__ == "__main__":
    main()
