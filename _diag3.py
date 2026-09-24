# -*- coding: utf-8 -*-
"""验证修正方案（临时）：按 HAR 实测的分类别接口/参数逐类验证，并提取收藏接口参数。"""

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

# 依据 HAR 实测整理的类别 → 接口 / queryContent 映射
PLAN: dict[str, tuple[str, str]] = {
    "FANKC": ("elective/programCourse.do", "YCJX:2,MOOC:2,"),
    "FAWKC": ("elective/programCourse.do", "YCJX:2,MOOC:2,"),
    "TYKC": ("elective/programCourse.do", "YCJX:2,"),
    "FXKC": ("elective/programCourse.do", "YCJX:2,MOOC:2,"),
    "TJKC": ("elective/recommendedCourse.do", "YCJX:2,MOOC:2,"),
    "XGXK": ("elective/publicCourse.do", "YCJX:2,MOOC:2,"),
    "MOOC": ("elective/publicCourse.do", "YCJX:2,MOOC:1,"),
    "QXKC": ("elective/queryCourse.do", "YCJX:2,MOOC:2,"),
}


def headers() -> dict[str, str]:
    """与浏览器一致的请求头。"""
    return {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": BASE.rstrip("/"),
        "Referer": f"{SYS}*default/grablessons.do?token={TOKEN}",
        "token": TOKEN,
        "Cookie": COOKIE,
    }


def qs(tct: str, content: str, page: int = 0, size: int = 10) -> str:
    """按 HAR 结构构造 querySetting（pageNumber 为 0 基）。"""
    return json.dumps(
        {
            "data": {
                "studentCode": STU, "campus": "01", "electiveBatchCode": BATCH,
                "isMajor": "1", "teachingClassType": tct,
                "checkConflict": "2", "checkCapacity": "2", "queryContent": content,
            },
            "pageSize": str(size), "pageNumber": str(page), "order": "", "orderBy": "courseNumber",
        },
        ensure_ascii=False, separators=(",", ":"),
    )


async def main() -> None:
    """逐类验证 + 收藏接口参数提取。"""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        print("=== 分类别验证（pageNumber=0, pageSize=10）===")
        for code, (path, content) in PLAN.items():
            try:
                async with session.post(
                    SYS + path, headers=headers(),
                    data={"querySetting": qs(code, content)},
                    params={"timestamp": str(int(time.time() * 1000))},
                    allow_redirects=False,
                ) as resp:
                    text = await resp.text()
                    try:
                        data = json.loads(text)
                        dl = data.get("dataList") or []
                        tc_total = sum(len(c.get("tcList") or []) for c in dl if isinstance(c, dict))
                        flat = sum(1 for c in dl if isinstance(c, dict) and not c.get("tcList"))
                        print(f"  {code:5s} {resp.status} code={data.get('code')!r} msg={data.get('msg')!r} "
                              f"totalCount={data.get('totalCount')!r} dataList={len(dl)} tcList合计={tc_total} 扁平行={flat}")
                    except json.JSONDecodeError:
                        print(f"  {code:5s} {resp.status} 非JSON：{text[:100]}")
            except Exception as exc:  # noqa: BLE001
                print(f"  {code:5s} 异常 {type(exc).__name__}: {exc}")

        print("\n=== 收藏接口参数（来自 grablessons.js）===")
        async with session.get(RES + "js/grablessons/grablessons.js", headers={"User-Agent": UA}) as resp:
            js = await resp.text()
        for kw in ("favoriteTeachingClass", "favorite.do", "isFavorite"):
            for match in list(re.finditer(kw, js))[:3]:
                snippet = js[max(0, match.start() - 320): match.end() + 420].replace("\n", " ")
                print(f"\n[{kw}] …{snippet}…")


asyncio.run(main())
