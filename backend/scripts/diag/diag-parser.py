#!/usr/bin/env python3
# 用途：第四轮 —— Express qs parser 结构化查询串攻击（重复键 / 数组 / 嵌套对象 / 原型污染）
#        + 并发竞态（同一会话 8 并发 step）。
# 运行：python backend/scripts/diag/diag-parser.py "$TOKEN"
#!/usr/bin/env python3
"""第四轮：Express query parser 攻击 + 并发竞态。
前三轮灌的都是标量；本轮针对 Express 默认 qs parser 的**结构化**查询串
（`?a[]=1`、`?a[b]=c`、重复键），这类输入会让 req.query.x 变成数组/对象，
容易绕过 typeof 判断直接拼进 SQL。并补并发竞态面。
"""
import json
import sys
import threading
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1]

TARGETS = [
    "/api/replay/history", "/api/blind/history", "/api/market/history",
    "/api/review/benchmark", "/api/equity", "/api/stocks", "/api/orders",
    "/api/transactions", "/api/analytics/errors", "/api/leaderboard",
    "/api/review", "/api/watchlist", "/api/replay/range", "/api/replay/compare",
]

PAYLOADS = [
    ("重复键", "limit=5&limit=1e20"),
    ("重复键含非法", "limit=1&limit=abc"),
    ("数组字面量", "limit[]=1&limit[]=1e20"),
    ("数组下标", "limit[0]=1e20"),
    ("对象嵌套", "limit[x]=1"),
    ("深层嵌套", "limit[a][b][c]=1"),
    ("空键", "=1"),
    ("仅键无值", "limit"),
    ("百分号编码", "limit=%31e%33309"),
    ("加号空格", "limit=+1e20+"),
    ("原型污染", "__proto__[x]=1&limit=1e20"),
    ("超长键", "a" * 3000 + "=1"),
    ("超多参数", "&".join(f"p{i}=1e20" for i in range(200))),
]


def call(path, headers=None, timeout=25):
    h = {"Accept": "application/json", "Authorization": "Bearer " + TOKEN}
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "EXC:" + type(e).__name__


def main():
    findings = []
    n = 0

    print("### B1 query parser 结构化攻击", flush=True)
    for t in TARGETS:
        base = call(t)
        for name, q in PAYLOADS:
            st = call(t + "?" + q)
            n += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("B1", f"{t} [{name}]", q[:60], st))
        print(f"    {t} 基线={base}", flush=True)
    print(f"  B1 用例 {n}，5xx {len(findings)}", flush=True)

    before = len(findings)
    print("### B2 并发竞态：同一会话并发 step / trade", flush=True)
    n2 = 0
    results = []

    def worker(path, body, out):
        h = {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN}
        req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                out.append(r.status)
        except urllib.error.HTTPError as e:
            out.append(e.code)
        except Exception as e:
            out.append("EXC:" + type(e).__name__)

    for round_no in range(3):
        ts = []
        for i in range(8):
            t = threading.Thread(target=worker, args=("/api/blind/7/step", {"bars": 1}, ts))
            t.start()
            ts.append(t)
        for t in ts:
            if hasattr(t, "join"):
                t.join()
        n2 += 8
        codes = [x for x in ts if isinstance(x, int)]
        print(f"    第{round_no + 1}轮 8 并发 step -> {sorted(set(codes))}", flush=True)
        for c in codes:
            if c >= 500:
                findings.append(("B2", "POST /api/blind/7/step 并发", "", c))
    print(f"  B2 用例 {n2}，新增 5xx {len(findings) - before}", flush=True)

    print(f"\n### 合计 {n + n2} 用例，发现 {len(findings)}", flush=True)
    for kind, path, payload, st in findings:
        print(f"  [{kind}] {path} -> {st}  {payload}")


if __name__ == "__main__":
    main()
