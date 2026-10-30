#!/usr/bin/env python3
# 用途：第三轮 —— 非参数越界类攻击面：认证破损 / JSON 结构攻击 / 协议层 / 越权访问。
# 运行：python backend/scripts/diag/diag-abuse.py "$TOKEN"
#!/usr/bin/env python3
"""第三轮：非「参数越界」类的攻击面。
前两轮覆盖「入参 -> SQL 越界」，本轮换维度：
  A1 认证破损（无 token / 畸形 / 超长 / alg=none）
  A2 JSON 结构攻击（深嵌套、超大数组、类型替换）
  A3 协议层（超大 body、错误 Content-Type、错误方法）
  A4 越权访问（借用本人 token 访问他人资源）
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8080"
TOKEN = sys.argv[1]

PROTECTED = ["/api/blind/7", "/api/replay/3", "/api/orders", "/api/portfolio",
             "/api/watchlist", "/api/review", "/api/equity", "/api/me",
             "/api/replay/history", "/api/blind/history", "/api/analytics/errors"]

TAMPERED = [
    ("空", ""),
    ("纯空格", " "),
    ("Bearer 空", "Bearer "),
    ("缺 Bearer 前缀", TOKEN),
    ("大小写变异", "bearer " + TOKEN),
    ("截断签名", TOKEN[: len(TOKEN) // 2]),
    ("改一个字符", TOKEN[:-3] + "AAA"),
    ("超长 token", TOKEN * 200),
    ("Bearer 重复", "Bearer Bearer " + TOKEN),
    ("注入换行", "Bearer " + TOKEN + "\r\nX-Evil: 1"),
    ("空 JSON 结构的 alg=none", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOjN9."),
]


def call(path, method="GET", body=None, headers=None, raw_body=None):
    h = {"Accept": "application/json"}
    if headers:
        h.update(headers)
    data = None
    if raw_body is not None:
        data = raw_body
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "EXC:" + type(e).__name__


def main():
    findings = []
    n = 0

    print("### A1 认证破损", flush=True)
    for name, val in TAMPERED:
        for p in PROTECTED[:4]:
            st = call(p, headers={"Authorization": val} if val else {})
            n += 1
            # 期望：401/403。出现 5xx 或 200 均为异常（200 说明鉴权被绕过）
            if isinstance(st, int) and (st >= 500 or st == 200):
                findings.append(("A1", f"{p} [{name}]", "", st))
    print(f"  A1 用例 {n}，异常 {len(findings)}", flush=True)

    before = len(findings)
    print("### A2 JSON 结构攻击", flush=True)
    n2 = 0
    deep = {"a": 1}
    for _ in range(200):
        deep = {"n": deep}
    structures = [
        ("深嵌套200层", deep),
        ("超大数组", {"items": list(range(100000))}),
        ("数组替换对象", [1, 2, 3]),
        ("字符串替换对象", "not-an-object"),
        ("null", None),
        ("数字", 12345),
        ("布尔", True),
        ("巨大字符串字段", {"code": "6" * 1000000}),
        ("特殊 unicode", {"code": "\u0000\u001f\U0001F600"}),
        ("数值精度攻击", {"bars": 1e308, "code": "600519"}),
        ("负零与指数", {"startSeq": -0, "endSeq": 1e-320, "code": "600519"}),
    ]
    targets = [("/api/replay/start", "POST"), ("/api/blind/start", "POST"),
               ("/api/trade", "POST"), ("/api/orders", "POST"),
               ("/api/watchlist", "POST"), ("/api/analytics/track", "POST"),
               ("/api/analytics/error", "POST")]
    for path, method in targets:
        for name, payload in structures:
            st = call(path, method=method, body=payload)
            n2 += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("A2", f"{method} {path} [{name}]", str(payload)[:120], st))
    print(f"  A2 用例 {n2}，新增异常 {len(findings) - before}", flush=True)

    before = len(findings)
    print("### A3 协议层", flush=True)
    n3 = 0
    BIG = b'{"code":"' + b"6" * 3000000 + b'"}'
    proto = [
        ("超大 body 3MB", "/api/orders", "POST", {"Content-Type": "application/json"}, BIG),
        ("错误 Content-Type", "/api/orders", "POST", {"Content-Type": "text/plain"}, b'{"code":"600519"}'),
        ("缺 Content-Type", "/api/orders", "POST", {}, b'{"code":"600519"}'),
        ("畸形 JSON", "/api/orders", "POST", {"Content-Type": "application/json"}, b'{"code":'),
        ("空 body", "/api/orders", "POST", {"Content-Type": "application/json"}, b''),
        ("数组型 JSON", "/api/orders", "POST", {"Content-Type": "application/json"}, b'[1,2,3]'),
        ("重复键", "/api/orders", "POST", {"Content-Type": "application/json"},
         b'{"code":"600519","code":"000001","side":"buy","price":10,"quantity":100}'),
    ]
    for name, path, method, extra, raw in proto:
        h = dict(extra)
        h["Authorization"] = "Bearer " + TOKEN
        st = call(path, method=method, headers=h, raw_body=raw)
        n3 += 1
        print(f"    [{name}] {path} -> {st}", flush=True)
        if isinstance(st, int) and st >= 500:
            findings.append(("A3", f"{method} {path} [{name}]", "", st))
    # 错误方法
    for path in ["/api/orders", "/api/watchlist", "/api/equity", "/api/review"]:
        for method in ["PUT", "PATCH", "DELETE"]:
            st = call(path, method=method, headers={"Authorization": "Bearer " + TOKEN})
            n3 += 1
            if isinstance(st, int) and st >= 500:
                findings.append(("A3", f"{method} {path}", "", st))
    print(f"  A3 用例 {n3}，新增异常 {len(findings) - before}", flush=True)

    before = len(findings)
    print("### A4 越权访问他人资源", flush=True)
    n4 = 0
    others = ["/api/blind/1", "/api/blind/2", "/api/blind/4", "/api/blind/5", "/api/blind/6",
              "/api/blind/8", "/api/blind/9", "/api/replay/1", "/api/replay/2"]
    for p in others:
        st = call(p, headers={"Authorization": "Bearer " + TOKEN})
        n4 += 1
        print(f"    {p} -> {st}", flush=True)
        if isinstance(st, int) and st >= 500:
            findings.append(("A4", p, "", st))
        if st == 200:
            findings.append(("A4-越权", p, "", st))
    print(f"  A4 用例 {n4}，新增异常 {len(findings) - before}", flush=True)

    print(f"\n### 合计 {n + n2 + n3 + n4} 用例，发现 {len(findings)}", flush=True)
    for kind, path, payload, st in findings:
        print(f"  [{kind}] {path} -> {st}  {payload[:160]}")


if __name__ == "__main__":
    main()
