# -*- coding: utf-8 -*-
"""诊断与逆向（临时）：用新 token 实测查询参数，并从公开 JS 提取字段名与收藏接口。"""

import asyncio
import json
import os
import re
import time

import aiohttp

BASE = "http://bkxk.szu.edu.cn/"
SYS = BASE + "xsxkapp/sys/xsxkapp/"
RES = "http://xkres.szu.edu.cn/products/jwfw/xsxkapp/public/"
TOKEN = os.environ["SZU_TOKEN"]
COOKIE = os.environ["SZU_COOKIE"]
STU = os.environ["SZU_STU"]
BATCH = os.environ["SZU_BATCH"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def headers(token: str, with_cookie: bool) -> dict[str, str]:
    """构造与浏览器一致的请求头。"""
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": BASE.rstrip("/"),
        "Referer": f"{SYS}*default/grablessons.do?token={token}",
        "token": token,
    }
    if with_cookie:
        h["Cookie"] = COOKIE
    return h


def qs(tct: str, page: str, content: str = "YCJX:2,MOOC:2,") -> str:
    """按 HAR 实测结构构造 querySetting。"""
    return json.dumps(
        {
            "data": {
                "studentCode": STU, "campus": "01", "electiveBatchCode": BATCH,
                "isMajor": "1", "teachingClassType": tct,
                "checkConflict": "2", "checkCapacity": "2", "queryContent": content,
            },
            "pageSize": "10", "pageNumber": page, "order": "", "orderBy": "courseNumber",
        },
        ensure_ascii=False, separators=(",", ":"),
    )


def summarize(text: str) -> str:
    """压缩描述响应。"""
    t = text.lstrip()
    if not t.startswith("{"):
        return f"非JSON（长度{len(text)}）：{t[:120]!r}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return f"JSON解析失败：{t[:150]}"
    parts = [f"code={data.get('code')!r} msg={data.get('msg')!r} totalCount={data.get('totalCount')!r}"]
    dl = data.get("dataList")
    if isinstance(dl, list):
        parts.append(f"dataList={len(dl)}条")
        if dl and isinstance(dl[0], dict):
            parts.append(f"课程级字段={sorted(dl[0].keys())}")
            tc = dl[0].get("tcList")
            if isinstance(tc, list) and tc and isinstance(tc[0], dict):
                parts.append(f"tcList={len(tc)}条 教学班级字段={sorted(tc[0].keys())}")
                parts.append(f"教学班样例={json.dumps(tc[0], ensure_ascii=False)[:600]}")
            parts.append(f"课程样例={json.dumps(dl[0], ensure_ascii=False)[:400]}")
    elif dl is None and "dataList" in data:
        parts.append("dataList=null")
    return " | ".join(parts)


async def probe(session, label, path, data=None, params=None, token=None, cookie=True, method="POST"):
    """发起一次请求并打印摘要。"""
    tk = token or TOKEN
    try:
        async with session.request(
            method, SYS + path, headers=headers(tk, cookie), data=data, params=params, allow_redirects=False
        ) as resp:
            text = await resp.text()
            print(f"\n[{label}] {resp.status} {path}")
            print("   ", summarize(text)[:1400])
    except Exception as exc:  # noqa: BLE001
        print(f"\n[{label}] 异常 {type(exc).__name__}: {exc}")


async def part_a(session) -> None:
    """新 token 实测：认证与分页。"""
    stamp = str(int(time.time() * 1000))
    print("=== A. 新 token 认证与分页对照 ===")
    await probe(session, "A1 登录检查", "student/check/login.do", data={}, params={"timestamp": stamp})
    await probe(session, "A2 FANKC pageNumber=1（当前程序行为）", "elective/programCourse.do",
                data={"querySetting": qs("FANKC", "1")})
    await probe(session, "A3 FANKC pageNumber=0（HAR 实测行为）", "elective/programCourse.do",
                data={"querySetting": qs("FANKC", "0")})
    await probe(session, "A4 FANKC pageNumber=0 无cookie", "elective/programCourse.do",
                data={"querySetting": qs("FANKC", "0")}, cookie=False)
    await probe(session, "A5 XGXK publicCourse.do", "elective/publicCourse.do",
                data={"querySetting": qs("XGXK", "0")})
    await probe(session, "A6 MOOC publicCourse.do", "elective/publicCourse.do",
                data={"querySetting": qs("MOOC", "0", "YCJX:2,MOOC:1,")})


async def part_b(session) -> None:
    """从公开 JS 提取字段名与收藏接口。"""
    print("\n=== B. 公开 JS 逆向（字段名 / 收藏接口）===")
    targets = [
        "js/grablessons/grablessonsBS.js",
        "js/grablessons/grablessons.js",
        "js/collection/collectionBS.min.js",
        "js/collection/collection.min.js",
        "js/selectedcourse/selectedcourseBS.js",
    ]
    for name in targets:
        try:
            async with session.get(RES + name, headers={"User-Agent": UA}) as resp:
                js = await resp.text()
        except Exception as exc:  # noqa: BLE001
            print(f"\n-- {name} 抓取失败 {type(exc).__name__}")
            continue
        print(f"\n-- {name}（{len(js)} 字符）--")
        eps = sorted(set(re.findall(r"[\w/]*\.do", js)))
        print("   端点:", [e for e in eps if "/" in e][:20])
        # 字段名：xxx['field'] / xxx.field
        fields = sorted(set(re.findall(r"\[['\"](\w{3,32})['\"]\]", js)))
        print("   可能字段名:", fields[:60])
        for kw in ("collection", "Collection", "favorite", "volunteer", "addParam", "teachClassId"):
            hits = [m.start() for m in re.finditer(kw, js)]
            if hits:
                snippet = js[max(0, hits[0] - 200): hits[0] + 400].replace("\n", " ")
                print(f"   [{kw}] ×{len(hits)}：…{snippet}…")


async def main() -> None:
    """执行两部分。"""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        await part_a(session)
        await part_b(session)


asyncio.run(main())
