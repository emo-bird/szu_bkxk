# -*- coding: utf-8 -*-
"""只读接口探测工具：校验课程查询接口的真实响应结构。

**安全约束（务必遵守）**：
    - 本工具**只调用查询类接口**，不含任何选课 / 退课写请求；
    - 所有请求**强制经过项目自己的全局请求队列**，即每条请求间隔
      ``config.REQUEST_INTERVAL_MS``（500ms）—— 站点对高频请求会直接
      终止登录会话，绕过节流会导致凭证被踢；
    - 凭证全部从环境变量读取，**不写入任何文件**，日志中也不打印请求头；
    - 单次运行发出的请求数很少（默认 3 条），不会长时间轮询。

用法（PowerShell）::

    $env:SZU_COOKIE = "<从浏览器复制的完整 cookie>"
    $env:SZU_TOKEN  = "<sessionStorage.token>"
    $env:SZU_STU    = "<学号>"
    $env:SZU_BATCH  = "<electiveBatchCode>"
    .\\.venv\\Scripts\\python.exe tools\\probe_api.py

对应的需求背景与已验证结论见 ``docs/接口逆向记录.md``。

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
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import config  # noqa: E402
from api_client import ApiClient, ApiError, MissingCredentialsError, NotAuthenticatedError  # noqa: E402
from auth_model import Credentials  # noqa: E402
from logger_util import Logger  # noqa: E402
from request_queue import RequestQueue  # noqa: E402

#: 默认探测的课程类别（每类 1 条请求，全部经 500ms 限流队列）
DEFAULT_TYPES: tuple[str, ...] = ("FANKC", "XGXK")


def credentials_from_env() -> Credentials:
    """从环境变量读取四项凭证。

    :return: :class:`auth_model.Credentials` 实例。
    :raises SystemExit: 缺少必需的环境变量。
    """
    required = ("SZU_COOKIE", "SZU_TOKEN", "SZU_STU", "SZU_BATCH")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(f"缺少环境变量：{'、'.join(missing)}", file=sys.stderr)
        raise SystemExit(2)
    return Credentials(
        student_code=os.environ["SZU_STU"],
        elective_batch_code=os.environ["SZU_BATCH"],
        cookie=os.environ["SZU_COOKIE"],
        token=os.environ["SZU_TOKEN"],
    )


def describe(data: dict) -> str:
    """把接口响应压缩成可读描述。

    :param data: 接口返回的 JSON 对象。
    :return: 多行描述字符串。
    """
    lines = [
        f"    code={data.get('code')!r} msg={data.get('msg')!r} "
        f"totalCount={data.get('totalCount')!r}"
    ]
    data_list = data.get("dataList")
    if isinstance(data_list, list):
        lines.append(f"    dataList 条数={len(data_list)}")
        if data_list and isinstance(data_list[0], dict):
            first = data_list[0]
            lines.append(f"    课程级字段={sorted(first.keys())}")
            tc_list = first.get("tcList")
            if isinstance(tc_list, list) and tc_list and isinstance(tc_list[0], dict):
                lines.append(f"    tcList 条数={len(tc_list)}")
                lines.append(f"    教学班级字段={sorted(tc_list[0].keys())}")
                lines.append(f"    教学班样例={json.dumps(tc_list[0], ensure_ascii=False)[:600]}")
            else:
                lines.append("    （无 tcList，该类别为扁平行结构）")
    return "\n".join(lines)


async def main() -> None:
    """依次探测各类别的课程查询接口。"""
    credentials = credentials_from_env()
    logger = Logger()
    queue = RequestQueue(logger=logger)
    await queue.start()
    client = ApiClient(lambda: credentials, queue, logger)
    await client.start()

    print(f"调度间隔 = {queue.interval_ms}ms，队列上限 = {queue.max_size}，"
          f"本次共 {len(DEFAULT_TYPES)} 条查询请求")
    try:
        for teaching_class_type in DEFAULT_TYPES:
            label = config.TEACHING_CLASS_TYPES.get(teaching_class_type, teaching_class_type)
            print(f"\n=== 课程查询 {label}({teaching_class_type}) ===")
            try:
                data = await client.query_courses(
                    teaching_class_type,
                    page_number=config.QUERY_FIRST_PAGE,
                    priority=config.PRIORITY_HIGH,
                )
                print(describe(data))
            except MissingCredentialsError as exc:
                print(f"    凭证缺失：{exc}")
            except NotAuthenticatedError as exc:
                print(f"    登录态已失效：{exc}")
                break
            except ApiError as exc:
                print(f"    接口错误：{exc}")
    finally:
        await client.close()
        await queue.stop()
        print(f"\n队列统计 = {queue.stats()}")
        logger.close()
    print("完成。仅执行了只读请求，未调用任何写接口。")


if __name__ == "__main__":
    asyncio.run(main())
