# -*- coding: utf-8 -*-
"""A 路线（外部 Edge + CDP）可行性 spike —— 也是 B+ 的**数据面**验证。

CDP 客户端与取数逻辑已抽到正式模块 :mod:`cdp_bridge`，
本脚本只负责拉起浏览器并把 4 项能力打印成 [OK]/[FAIL]。

用途：
    - 独立验证「外部 Edge + CDP」这条路（B+ 若嵌入失败可回退到它）；
    - 也可用于已登录 profile 的复测（``--headless`` 配合已有 profile）。

用法（**在普通 PowerShell 里运行**）::

    cd C:\\Project\\szu_bkxk
    .\\.venv\\Scripts\\python.exe tools\\spike_edge_login.py

会在独立 profile 里打开 Edge（不影响日常浏览器），请在其中完成登录。
本脚本不向学校站点主动发起任何业务请求，只旁听页面自身流量。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import cdp_bridge  # noqa: E402
import config  # noqa: E402

DEBUG_PORT = 9333
PROFILE_DIR = PROJECT_ROOT / ".edge_profile"
GRAB_URL = config.BASE_URL + config.EP_GRABLESSONS_PAGE


def describe(captured: list[cdp_bridge.CapturedResponse]) -> list[str]:
    """把捕获到的响应整理成可读行。

    :param captured: 捕获结果列表。
    :return: 每个接口一行的描述列表。
    """
    counts: dict[str, int] = {}
    lines: dict[str, str] = {}
    for item in captured:
        counts[item.endpoint] = counts.get(item.endpoint, 0) + 1
        if item.endpoint in lines:
            continue
        data = item.json_or_none()
        if not data:
            lines[item.endpoint] = f"（无 JSON 响应体：状态 {item.status}，{item.mime or '无类型'}）"
            continue
        text = f"code={data.get('code')!r} msg={data.get('msg')!r}"
        data_list = data.get("dataList")
        if isinstance(data_list, list):
            text += f" dataList={len(data_list)}条"
            if data_list and isinstance(data_list[0], dict):
                text += f" 课程级字段={sorted(data_list[0].keys())[:10]}"
                tc_list = data_list[0].get("tcList")
                if isinstance(tc_list, list) and tc_list and isinstance(tc_list[0], dict):
                    text += f" tcList={len(tc_list)}条"
        lines[item.endpoint] = text
    return [f"    {name} ×{counts[name]}\n        {lines[name]}" for name in sorted(counts)]


async def run(headless: bool, login_wait: float) -> int:
    """执行 spike。

    :param headless: 是否使用无头模式。
    :param login_wait: 等待人工登录的最长秒数。
    :return: 进程退出码。
    """
    results = {"CDP 连接": False, "执行 JS": False, "登录后读取 cookie": False, "被动捕获接口响应": False}

    print("=== 启动 Edge（独立 profile）===")
    process = cdp_bridge.launch_edge(DEBUG_PORT, PROFILE_DIR, url=config.BASE_URL, headless=headless)
    print(f"    PID={process.pid}  profile={PROFILE_DIR.name}")

    try:
        version = await cdp_bridge.wait_for_cdp(DEBUG_PORT, timeout=40)
    except Exception as exc:  # noqa: BLE001
        print(f"    [FAIL] {exc}")
        print("    提示：受限沙箱会因命名管道被拒而无法启动 Chromium，请在普通终端运行。")
        return 2
    print(f"    [OK] {version.get('Browser')} (CDP {version.get('Protocol-Version')})")
    results["CDP 连接"] = True

    target = await cdp_bridge.pick_target(DEBUG_PORT)
    print(f"    目标页面 = {str(target.get('url'))[:80]}")

    async with cdp_bridge.CdpClient(target["webSocketDebuggerUrl"]) as cdp:
        await cdp.enable()

        print("\n=== 执行 JS ===")
        print(f"    标题={await cdp.evaluate('document.title')!r}")
        print(f"    地址={str(await cdp.evaluate('location.href'))[:80]}")
        results["执行 JS"] = True

        print("\n=== 等待登录并读取凭证 ===")
        token = ""
        deadline = time.monotonic() + login_wait
        while not token and time.monotonic() < deadline:
            token = await cdp.session_storage("token")
            if token:
                break
            print("    …请在 Edge 窗口中完成统一身份认证登录", end="\r")
            await asyncio.sleep(2)
        print()
        print(f"    sessionStorage.token = {token[:10] + '…' if token else '(未取到)'}")
        cookie_header = await cdp.cookie_header(config.BASE_URL)
        names = [p.split("=")[0] for p in cookie_header.split("; ") if "=" in p]
        print(f"    Cookie 头长度 = {len(cookie_header)}，名称 = {names}")
        results["登录后读取 cookie"] = bool(cookie_header) and "JSESSIONID" in cookie_header

        if token:
            await cdp.navigate(f"{GRAB_URL}?token={token}")
        print("\n=== 被动捕获接口响应（零额外请求）===")
        captured = await cdp.capture(25)
        for line in describe(captured):
            print(line)
        results["被动捕获接口响应"] = any(item.json_or_none() for item in captured)

    print("\n=== spike 结论 ===")
    for name, ok in results.items():
        print(f"    {'[OK]' if ok else '[FAIL]'} {name}")
    all_ok = all(results.values())
    print("\n全部通过。" if all_ok else "\n存在未通过项，见上面逐项说明。")
    print("Edge 窗口保留（复用同一 profile，下次登录态可保持）。")
    return 0 if all_ok else 1


def main() -> int:
    """解析参数并执行 spike。

    :return: 进程退出码。
    """
    parser = argparse.ArgumentParser(description="Edge + CDP 可行性 spike")
    parser.add_argument("--headless", action="store_true", help="无头模式（无法人工登录）")
    parser.add_argument("--login-wait", type=float, default=300.0, help="等待登录的最长秒数")
    args = parser.parse_args()
    return asyncio.run(run(args.headless, args.login_wait))


if __name__ == "__main__":
    sys.exit(main())
