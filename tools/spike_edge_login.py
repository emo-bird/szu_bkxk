# -*- coding: utf-8 -*-
"""可行性 spike：用真实 Edge + CDP 完成「登录 + 读凭证 + 取课程数据」。

**零新增依赖**：只用已有的 aiohttp（WebSocket）与系统已安装的 Edge。

验证 4 项能力（对应重构方案的前提）：
    1. 能启动独立 profile 的 Edge 并接上 CDP 调试端口；
    2. 能在页面里执行 JS（读到 ``sessionStorage.token``）；
    3. 能读取浏览器 cookie 存储（含 HttpOnly，即 ``document.cookie`` 看不到的那些）；
    4. **能被动捕获页面自身 XHR 的响应体** —— 我们不需要额外发任何请求给学校，
       只是旁听页面自己的流量，因此不会触发风控、不会把登录态挤掉。

用法（**必须在普通终端里运行，不要在 AI 沙箱里**）::

    .\\.venv\\Scripts\\python.exe tools\\spike_edge_login.py

脚本会打开一个 Edge 窗口（独立 profile，不影响你日常用的 Edge）：
    - 如果还没登录：请在窗口里完成统一身份认证登录；
    - 登录后页面自身会加载选课数据，脚本会自动旁听并把结构打印出来；
    - 结束后窗口保留（加 ``--close`` 可自动关闭）。

本脚本不向学校站点主动发起任何业务请求。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import subprocess
import sys
import time
from typing import Any

import aiohttp

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import config  # noqa: E402

PORT = 9333
EDGE_CANDIDATES = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)
PROFILE_DIR = PROJECT_ROOT / ".edge_profile"
INDEX_URL = config.BASE_URL + config.EP_INDEX
GRAB_URL = config.BASE_URL + config.EP_GRABLESSONS_PAGE


def mask(value: str, keep: int = 10) -> str:
    """脱敏展示凭证。

    :param value: 原始字符串。
    :param keep: 保留的明文字符数。
    :return: 脱敏文本。
    """
    if not value:
        return "(空)"
    return f"{value[:keep]}…(len={len(value)})"


def find_edge() -> str:
    """定位 msedge.exe。

    :return: 可执行文件路径。
    :raises SystemExit: 未找到 Edge。
    """
    for path in EDGE_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    print("未找到 msedge.exe，请确认已安装 Edge。", file=sys.stderr)
    raise SystemExit(2)


def launch_edge(headful: bool) -> subprocess.Popen:
    """以独立 profile 启动 Edge 并开启远程调试端口。

    :param headful: ``True`` 打开可见窗口（登录用），``False`` 无头模式。
    :return: 进程对象。
    """
    args = [
        find_edge(),
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={PROFILE_DIR}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
    ]
    if not headful:
        args.append("--headless")
    args.append(INDEX_URL)
    return subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


class CdpSession:
    """极简 Chrome DevTools Protocol 会话（发送命令 + 收集事件）。

    :ivar pending: 命令 id 到 future 的映射。
    :ivar events: 尚未被取走的异步事件。
    """

    def __init__(self, session: aiohttp.ClientSession, ws_url: str) -> None:
        """记录连接参数（不建立连接）。

        :param session: 复用的 aiohttp 会话。
        :param ws_url: 调试目标的 WebSocket 地址。
        """
        self._session = session
        self._ws_url = ws_url
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task[None] | None = None
        self._seq = 0
        self.pending: dict[int, asyncio.Future[dict]] = {}
        self.events: list[dict] = []

    async def __aenter__(self) -> "CdpSession":
        """建立 WebSocket 连接并启动读取协程。"""
        self._ws = await self._session.ws_connect(self._ws_url, max_msg_size=0)
        self._reader = asyncio.create_task(self._read_loop())
        return self

    async def __aexit__(self, *exc: object) -> None:
        """关闭连接。"""
        if self._reader is not None:
            self._reader.cancel()
        if self._ws is not None:
            await self._ws.close()

    async def _read_loop(self) -> None:
        """把响应按 id 分发到对应 future，其余作为事件收集。"""
        assert self._ws is not None
        async for msg in self._ws:
            if msg.type is not aiohttp.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            if "id" in data:
                future = self.pending.pop(data["id"], None)
                if future is not None and not future.done():
                    future.set_result(data)
            else:
                self.events.append(data)

    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> dict:
        """发送 CDP 命令并等待结果。

        :param method: CDP 方法名。
        :param params: 命令参数。
        :param timeout: 超时秒数。
        :return: 完整响应字典。
        """
        assert self._ws is not None
        self._seq += 1
        cid = self._seq
        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self.pending[cid] = future
        await self._ws.send_json({"id": cid, "method": method, "params": params or {}})
        return await asyncio.wait_for(future, timeout)

    async def evaluate(self, expression: str) -> Any:
        """在页面里执行 JS 并返回其值。

        :param expression: JS 表达式。
        :return: 表达式的值（取不到时返回 ``None``）。
        """
        response = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        return response.get("result", {}).get("result", {}).get("value")

    def drain(self, method: str) -> list[dict]:
        """取出并清空指定方法的已收集事件。

        :param method: CDP 事件名。
        :return: 事件列表。
        """
        taken = [item for item in self.events if item.get("method") == method]
        self.events = [item for item in self.events if item.get("method") != method]
        return taken


async def wait_for_cdp(session: aiohttp.ClientSession, timeout: float = 40.0) -> dict:
    """等待 CDP 的 HTTP 端点就绪。

    :param session: aiohttp 会话。
    :param timeout: 最长等待秒数。
    :return: ``/json/version`` 的内容。
    """
    deadline = time.time() + timeout
    last_error = "unknown"
    while time.time() < deadline:
        try:
            async with session.get(f"http://127.0.0.1:{PORT}/json/version") as resp:
                return await resp.json()
        except Exception as exc:  # noqa: BLE001
            last_error = type(exc).__name__
            await asyncio.sleep(0.7)
    raise RuntimeError(f"CDP 未就绪：{last_error}")


async def pick_page_target(session: aiohttp.ClientSession) -> dict:
    """挑选一个 ``page`` 类型的调试目标。

    :param session: aiohttp 会话。
    :return: 目标字典（含 ``webSocketDebuggerUrl``）。
    """
    async with session.get(f"http://127.0.0.1:{PORT}/json/list") as resp:
        targets = await resp.json()
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("没有可用的 page 调试目标")
    return pages[0]


def describe_body(body: str) -> str:
    """把接口响应体压缩成结构描述。

    :param body: 响应文本。
    :return: 描述字符串。
    """
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return f"非 JSON（长度 {len(body)}）：{body[:120]!r}"
    parts = [f"code={data.get('code')!r} msg={data.get('msg')!r}"]
    data_list = data.get("dataList")
    if isinstance(data_list, list):
        parts.append(f"dataList={len(data_list)} 条")
        if data_list and isinstance(data_list[0], dict):
            parts.append(f"课程级字段={sorted(data_list[0].keys())[:16]}")
            tc_list = data_list[0].get("tcList")
            if isinstance(tc_list, list) and tc_list and isinstance(tc_list[0], dict):
                parts.append(f"tcList={len(tc_list)} 条")
                parts.append(f"教学班级字段={sorted(tc_list[0].keys())[:16]}")
    return " | ".join(parts)


async def run_spike(headful: bool, login_wait: float, close_after: bool) -> int:
    """执行 spike 主流程。

    :param headful: 是否显示浏览器窗口。
    :param login_wait: 等待人工登录的最长秒数。
    :param close_after: 结束后是否关闭浏览器。
    :return: 进程退出码。
    """
    results: dict[str, bool] = {"CDP 连接": False, "执行 JS": False, "读取 cookie": False, "被动捕获接口响应": False}

    print("=== 1. 启动 Edge（独立 profile，不影响日常浏览器）===")
    process = launch_edge(headful)
    print(f"    PID={process.pid}  profile={PROFILE_DIR.name}")

    async with aiohttp.ClientSession() as session:
        try:
            version = await wait_for_cdp(session)
        except RuntimeError as exc:
            print(f"    [FAIL] {exc}")
            print("    提示：若在受限沙箱中运行，Chromium 会因命名管道被拒而启动失败。")
            return 2
        print(f"    [OK] {version.get('Browser')}  (CDP {version.get('Protocol-Version')})")
        results["CDP 连接"] = True

        target = await pick_page_target(session)
        async with CdpSession(session, target["webSocketDebuggerUrl"]) as cdp:
            await cdp.call("Page.enable")
            await cdp.call("Network.enable")
            await cdp.call("Runtime.enable")

            print("\n=== 2. 在页面里执行 JS ===")
            title = await cdp.evaluate("document.title")
            href = await cdp.evaluate("location.href")
            print(f"    标题={title!r}")
            print(f"    地址={str(href)[:90]}")
            results["执行 JS"] = True
            print("    [OK] 可执行 JS")

            print("\n=== 3. 读取 cookie 存储（含 HttpOnly）===")
            cookies = (await cdp.call("Storage.getCookies")).get("result", {}).get("cookies", [])
            site_cookies = [c for c in cookies if "szu.edu.cn" in str(c.get("domain", ""))]
            for cookie in site_cookies:
                print(f"    {cookie.get('name'):18s} {mask(str(cookie.get('value', '')))} "
                      f"domain={cookie.get('domain')} httpOnly={cookie.get('httpOnly')}")
            if site_cookies:
                results["读取 cookie"] = True
                print(f"    [OK] 读到 {len(site_cookies)} 条站点 cookie（可拼成 Cookie 请求头）")
            else:
                print("    [FAIL] 未读到站点 cookie（尚未登录时属正常）")

            print("\n=== 4. 等待登录并被动捕获页面自身的接口响应 ===")
            token = await cdp.evaluate("sessionStorage.getItem('token')")
            deadline = time.time() + login_wait
            while not token and time.time() < deadline:
                print("    …请在 Edge 窗口中完成统一身份认证登录（脚本会自动继续）", end="\r")
                await asyncio.sleep(2)
                token = await cdp.evaluate("sessionStorage.getItem('token')")
            print()
            print(f"    sessionStorage.token = {mask(str(token or ''))}")

            if token:
                await cdp.call("Page.navigate", {"url": f"{GRAB_URL}?token={token}"})
            captured: dict[str, tuple[int, str]] = {}
            end = time.time() + 25
            while time.time() < end:
                for event in cdp.drain("Network.responseReceived"):
                    url = event["params"]["response"]["url"]
                    if ".do" not in url:
                        continue
                    key = url.split("/")[-1].split("?")[0]
                    count, _ = captured.get(key, (0, ""))
                    captured[key] = (count + 1, captured.get(key, (0, ""))[1])
                    if count == 0:
                        try:
                            got = await cdp.call(
                                "Network.getResponseBody",
                                {"requestId": event["params"]["requestId"]},
                                timeout=8,
                            )
                            captured[key] = (1, got.get("result", {}).get("body", "")[:6000])
                        except Exception as exc:  # noqa: BLE001
                            captured[key] = (1, f"<取响应体失败：{type(exc).__name__}>")
                await asyncio.sleep(0.3)

            print()
            for key, (count, body) in sorted(captured.items()):
                print(f"    [被动捕获] {key} ×{count}")
                print(f"        {describe_body(body)}")
            results["被动捕获接口响应"] = any(
                body.startswith("{") for _, body in captured.values()
            )
            if results["被动捕获接口响应"]:
                print("    [OK] 已能从页面自身流量中拿到接口 JSON（无需额外发请求）")

    print("\n=== spike 结论 ===")
    for name, passed in results.items():
        print(f"    {'[OK]' if passed else '[FAIL]'} {name}")

    ok = all(results.values())
    print("\n" + ("全部通过：可以按「Edge + CDP」路线重构。" if ok
                  else "存在未通过项，见上面逐项说明。"))
    if close_after:
        process.terminate()
        print("已关闭 spike 用的 Edge 窗口。")
    else:
        print("Edge 窗口保留（关闭它不影响；下次运行会复用同一 profile，登录态可保持）。")
    return 0 if ok else 1


def main() -> int:
    """解析参数并执行 spike。"""
    parser = argparse.ArgumentParser(description="Edge + CDP 可行性 spike")
    parser.add_argument("--headless", action="store_true", help="无头模式（无法人工登录，仅供已登录 profile 复测）")
    parser.add_argument("--login-wait", type=float, default=300.0, help="等待人工登录的最长秒数（默认 300）")
    parser.add_argument("--close", action="store_true", help="结束后关闭浏览器窗口")
    args = parser.parse_args()
    return asyncio.run(run_spike(not args.headless, args.login_wait, args.close))


if __name__ == "__main__":
    sys.exit(main())
