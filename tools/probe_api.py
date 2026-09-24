# -*- coding: utf-8 -*-
"""只读接口探测工具：用于逆向校验课程查询接口的真实响应结构。

**安全约束**：
    - 本工具**只调用登录检查与查询类接口**，不含任何选课 / 退课写请求；
    - 凭证全部从环境变量读取，**不写入任何文件**；
    - 不做高频轮询，单次运行发出的请求数在 10 条以内。

用法（PowerShell）::

    $env:SZU_COOKIE = "<从浏览器复制的完整 cookie>"
    $env:SZU_TOKEN  = "<sessionStorage.token>"
    $env:SZU_STU    = "<学号>"
    $env:SZU_BATCH  = "<electiveBatchCode>"
    .\\.venv\\Scripts\\python.exe tools\\probe_api.py

对应的需求背景与已证结论见 ``docs/接口逆向记录.md``。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import config  # noqa: E402

SYS_BASE = config.BASE_URL + "xsxkapp/sys/xsxkapp/"


def headers_from_env() -> dict[str, str]:
    """从环境变量组装请求头。

    :return: 请求头字典。
    :raises SystemExit: 缺少必需的环境变量。
    """
    required = ("SZU_COOKIE", "SZU_TOKEN", "SZU_STU", "SZU_BATCH")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"缺少环境变量：{'、'.join(missing)}", file=sys.stderr)
        raise SystemExit(2)
    return {
        **config.DEFAULT_HEADERS,
        "Cookie": os.environ["SZU_COOKIE"],
        "token": os.environ["SZU_TOKEN"],
    }


def describe(text: str) -> str:
    """把响应文本压缩成一行可读描述。

    :param text: 响应正文。
    :return: 描述字符串（JSON 给出结构与条数，HTML 给出标题与长度）。
    """
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return f"疑似 JSON 但解析失败：{text[:150]}"
        parts = [f"JSON 顶层字段={sorted(data.keys())}"]
        data_list = data.get("dataList")
        if isinstance(data_list, list):
            parts.append(f"dataList 条数={len(data_list)}")
            if data_list and isinstance(data_list[0], dict):
                parts.append(f"课程级字段={sorted(data_list[0].keys())}")
                tc_list = data_list[0].get("tcList") or []
                parts.append(f"tcList 条数={len(tc_list)}")
                if tc_list and isinstance(tc_list[0], dict):
                    parts.append(f"教学班级字段={sorted(tc_list[0].keys())}")
                    parts.append(f"教学班样例={json.dumps(tc_list[0], ensure_ascii=False)[:800]}")
                parts.append(f"课程样例={json.dumps(data_list[0], ensure_ascii=False)[:800]}")
        return " | ".join(parts)
    if stripped.startswith("<") or "<!DOCTYPE" in text[:200]:
        return f"HTML 页面（长度={len(text)}）→ 判定为登录态失效"
    return f"未知内容（长度={len(text)}）：{text[:150]}"


async def probe(session: aiohttp.ClientSession, label: str, path: str, data: dict | None = None) -> None:
    """调用一个接口并打印结果。

    :param session: aiohttp 会话。
    :param label: 展示用名称。
    :param path: 相对 ``SYS_BASE`` 的接口路径。
    :param data: 表单数据。
    :return: ``None``
    """
    url = f"{SYS_BASE}{path}?timestamp={int(time.time() * 1000)}"
    try:
        async with session.post(
            url, headers=headers_from_env(), data=data or {}, allow_redirects=False
        ) as response:
            text = await response.text()
            print(f"\n[{label}] {path}\n  状态={response.status} 类型={response.headers.get('Content-Type','')}")
            print(f"  {describe(text)}")
    except Exception as exc:  # noqa: BLE001 - 探测工具需要打印任何失败原因
        print(f"\n[{label}] {path}\n  请求异常：{type(exc).__name__}: {exc}")


def query_setting(teaching_class_type: str) -> str:
    """构造课程查询的 ``querySetting``。

    :param teaching_class_type: 课程类别代码。
    :return: 紧凑 JSON 字符串。
    """
    return json.dumps(
        {
            "data": {
                "studentCode": os.environ["SZU_STU"],
                "campus": config.CAMPUS,
                "electiveBatchCode": os.environ["SZU_BATCH"],
                "isMajor": "1",
                "teachingClassType": teaching_class_type,
                "checkConflict": "2",
                "checkCapacity": "2",
                "queryContent": "MOOC:2,",
            },
            "pageSize": str(config.QUERY_PAGE_SIZE),
            "pageNumber": "1",
            "order": "",
            "orderBy": "courseNumber",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


async def main() -> None:
    """依次探测登录态与课程查询接口。"""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT_SECONDS * 3)) as session:
        print("=== 1. 登录态检查 ===")
        await probe(session, "登录检查", "student/check/login.do")
        print("\n=== 2. 选课批次（公开）===")
        await probe(session, "选课批次", "elective/batch.do")
        print("\n=== 3. 课程查询（需要登录）===")
        for code in ("FANKC", "XGXK"):
            await probe(
                session,
                f"课程查询 {code}",
                "elective/programCourse.do",
                {"querySetting": query_setting(code)},
            )
    print("\n完成。仅执行了只读请求，未调用任何写接口。")


if __name__ == "__main__":
    asyncio.run(main())
