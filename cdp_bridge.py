# -*- coding: utf-8 -*-
"""CDP（Chrome DevTools Protocol）桥接层。

用途：通过 WebSocket 控制 Chromium 内核浏览器，实现三件事：
    1. 读取登录凭证（cookie 存储 + ``sessionStorage.token``）；
    2. 在页面里执行/注入 JS（例如在每个课程卡片上显示教学班ID）；
    3. **被动捕获页面自身 XHR 的响应体** —— 不主动向学校站点发业务请求，
       只旁听页面自己的流量，因此不会触发风控、不会把登录态挤掉。

可同时服务于两种运行形态：
    - 外部系统 Edge（``--remote-debugging-port`` 启动）；
    - 内嵌到 Qt 窗口的 WebView2（通过 ``AdditionalBrowserArguments`` 打开同一端口）。

设计要点：
    - **零第三方依赖**：只用已有的 aiohttp WebSocket 客户端；
    - 所有调用都跑在 asyncio 线程，与 Qt 主线程解耦（不占用界面线程）；
    - 只读旁听 + 本地 JS 注入，不构造也不发送任何选课/退课请求。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import aiohttp

#: 系统 Edge 的常见安装位置
EDGE_CANDIDATES: tuple[str, ...] = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)


@dataclass
class CapturedResponse:
    """被动捕获到的一条接口响应。

    :ivar url: 请求地址。
    :ivar status: HTTP 状态码。
    :ivar mime: 响应内容类型。
    :ivar body: 响应正文（完整，未截断）。
    :ivar request_id: CDP 的请求 id，便于排查。
    :ivar request_body: 对应的请求体（表单字符串），用于还原 ``querySetting`` 等参数。
    """

    url: str
    status: int = 0
    mime: str = ""
    body: str = ""
    request_id: str = ""
    request_body: str = ""

    @property
    def endpoint(self) -> str:
        """返回接口短名（路径最后一段，去掉查询串）。"""
        return self.url.split("/")[-1].split("?")[0]

    def json_or_none(self) -> dict[str, Any] | None:
        """尝试把响应体解析为 JSON 对象。

        :return: 解析成功返回字典，否则返回 ``None``。
        """
        try:
            data = json.loads(self.body)
        except (json.JSONDecodeError, TypeError):
            return None
        return data if isinstance(data, dict) else None

    def query_setting(self) -> dict[str, Any] | None:
        """从请求体中解析出 ``querySetting`` 参数并转为字典。

        :return: ``querySetting`` 字典；解析失败返回 ``None``。
        """
        if not self.request_body:
            return None
        for pair in self.request_body.split("&"):
            if not pair.startswith("querySetting="):
                continue
            raw = pair[len("querySetting=") :]
            try:
                from urllib.parse import unquote

                return json.loads(unquote(raw))
            except (json.JSONDecodeError, TypeError, ValueError):
                return None
        return None

    def teaching_class_type(self) -> str:
        """返回本次查询使用的 ``teachingClassType``（如 ``FANKC``）。

        :return: 类别代码；无法确定时返回空串。
        """
        setting = self.query_setting()
        if not isinstance(setting, dict):
            return ""
        data = setting.get("data")
        if isinstance(data, dict):
            return str(data.get("teachingClassType", "") or "")
        return ""


class CdpClient:
    """CDP 会话：发送命令、收集事件、抓取响应体。

    :ivar pending: 命令 id 到 future 的映射。
    :ivar events: 尚未被取走的异步事件列表。
    """

    def __init__(self, ws_url: str) -> None:
        """记录调试目标地址。

        :param ws_url: 目标的 WebSocket 调试地址。
        """
        self._ws_url = ws_url
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task[None] | None = None
        self._seq = 0
        self.pending: dict[int, asyncio.Future[dict]] = {}
        self.events: list[dict] = []
        self._fetched: set[str] = set()
        self._requests: dict[str, str] = {}

    # -- 生命周期 -----------------------------------------------------------
    async def __aenter__(self) -> "CdpClient":
        """建立 WebSocket 连接并启动消息读取协程。"""
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(self._ws_url, max_msg_size=0)
        self._reader = asyncio.create_task(self._read_loop())
        return self

    async def __aexit__(self, *exc: object) -> None:
        """关闭连接与会话。"""
        if self._reader is not None:
            self._reader.cancel()
        if self._ws is not None:
            await self._ws.close()
        if self._session is not None:
            await self._session.close()

    async def _read_loop(self) -> None:
        """读取消息：带 id 的作为响应分发，其余按事件收集。"""
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

    # -- 基础命令 -----------------------------------------------------------
    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> dict:
        """发送 CDP 命令并等待响应。

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

    async def evaluate(self, expression: str, timeout: float = 15.0) -> Any:
        """在页面里执行 JS 并返回其结果值。

        :param expression: JS 表达式，可使用 ``awaitPromise`` 返回 Promise 结果。
        :param timeout: 超时秒数。
        :return: 表达式的值。
        """
        response = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        return response.get("result", {}).get("result", {}).get("value")

    async def enable(self) -> None:
        """开启页面、网络与运行时三个域（捕获响应体前必须执行）。"""
        await self.call("Page.enable")
        await self.call("Network.enable")
        await self.call("Runtime.enable")

    async def add_binding(self, name: str) -> None:
        """注册一个 JS → Python 的通信绑定。

        注册后页面里会出现同名函数 ``window.<name>(字符串)``，
        JS 调用它时本端会收到 ``Runtime.bindingCalled`` 事件，
        可用 :meth:`take_bindings` 取走负载。

        :param name: 绑定函数名（建议用不易冲突的前缀）。
        """
        await self.call("Runtime.addBinding", {"name": name})

    def take_bindings(self, name: str) -> list[str]:
        """取出并清空指定绑定函数的调用负载。

        :param name: :meth:`add_binding` 注册的名字。
        :return: 每次调用传入的字符串负载列表。
        """
        payloads: list[str] = []
        keep: list[dict] = []
        for item in self.events:
            if item.get("method") == "Runtime.bindingCalled":
                params = item.get("params", {})
                if params.get("name") == name:
                    payloads.append(str(params.get("payload", "")))
                    continue
            keep.append(item)
        self.events = keep
        return payloads

    async def navigate(self, url: str) -> None:
        """导航到指定地址。

        :param url: 目标地址。
        """
        await self.call("Page.navigate", {"url": url})

    async def inject_on_new_document(self, script: str) -> None:
        """注册在每次新文档加载时自动执行的脚本（用于持久化 DOM 注入）。

        :param script: 待注入的 JS 源码。
        """
        await self.call("Page.addScriptToEvaluateOnNewDocument", {"source": script})

    def drain(self, method: str) -> list[dict]:
        """取出并清空指定方法的已收集事件。

        :param method: CDP 事件名。
        :return: 事件列表。
        """
        taken = [item for item in self.events if item.get("method") == method]
        self.events = [item for item in self.events if item.get("method") != method]
        return taken

    # -- 凭证 ---------------------------------------------------------------
    async def get_cookies(self, urls: Iterable[str] | None = None) -> list[dict]:
        """读取浏览器 cookie 存储（含 ``document.cookie`` 读不到的 HttpOnly cookie）。

        :param urls: 关注的目标地址；用于让 CDP 返回该地址会携带的 cookie。
        :return: cookie 字典列表。
        """
        merged: dict[tuple, dict] = {}
        attempts: list[tuple[str, dict]] = [("Storage.getCookies", {})]
        if urls:
            attempts.append(("Network.getCookies", {"urls": list(urls)}))
        for method, params in attempts:
            try:
                response = await self.call(method, params, timeout=10)
            except Exception:  # noqa: BLE001 - 某些目标不支持某个域，忽略即可
                continue
            for cookie in response.get("result", {}).get("cookies", []) or []:
                merged[(cookie.get("domain"), cookie.get("name"), cookie.get("path"))] = cookie
        return list(merged.values())

    async def cookie_header(self, url: str) -> str:
        """拼装可直接放进 HTTP 请求头的 Cookie 字符串。

        :param url: 目标接口地址，用于筛选域匹配的 cookie。
        :return: 形如 ``"a=1; b=2"`` 的字符串；无 cookie 时返回空串。
        """
        host = url.split("//")[-1].split("/")[0].split(":")[0]
        cookies = await self.get_cookies([url])
        parts: list[str] = []
        for cookie in cookies:
            domain = str(cookie.get("domain", "")).lstrip(".")
            if domain and not host.endswith(domain):
                continue
            parts.append(f"{cookie.get('name')}={cookie.get('value')}")
        if not parts:
            # 退化路径：直接读 document.cookie（HttpOnly 之外的部分）
            raw = await self.evaluate("document.cookie")
            return str(raw or "")
        return "; ".join(parts)

    async def session_storage(self, key: str = "token") -> str:
        """读取页面 ``sessionStorage`` 中的值。

        :param key: 存储键名，默认 ``token``。
        :return: 值；不存在时返回空串。
        """
        value = await self.evaluate(f"sessionStorage.getItem({json.dumps(key)})")
        return str(value or "")

    # -- 被动捕获 -----------------------------------------------------------
    async def poll_responses(self, want_do_only: bool = True) -> list[CapturedResponse]:
        """处理已就绪的响应事件，尽力抓取响应体（非阻塞，可循环调用）。

        .. note::
           响应体会被浏览器回收，因此必须在事件到达后尽快抓取；
           本方法对同一 ``requestId`` 只抓一次。
           同时会把请求体（``Network.requestWillBeSent`` 的 postData）关联过来，
           便于还原 ``querySetting`` 里的 ``teachingClassType`` 等参数。

        :param want_do_only: 只处理 ``.do`` 结尾的接口响应。
        :return: 本次新捕获到的响应列表。
        """
        # 先登记请求体，后面按 requestId 关联
        for event in self.drain("Network.requestWillBeSent"):
            params = event.get("params", {})
            request = params.get("request", {})
            post_data = request.get("postData")
            if post_data:
                self._requests[str(params.get("requestId", ""))] = str(post_data)

        results: list[CapturedResponse] = []
        for event in self.drain("Network.responseReceived"):
            params = event.get("params", {})
            response = params.get("response", {})
            url = str(response.get("url", ""))
            if want_do_only and ".do" not in url:
                continue
            request_id = str(params.get("requestId", ""))
            item = CapturedResponse(
                url=url,
                status=int(response.get("status", 0) or 0),
                mime=str(response.get("mimeType", "")),
                request_id=request_id,
                request_body=self._requests.get(request_id, ""),
            )
            if request_id and request_id not in self._fetched:
                self._fetched.add(request_id)
                try:
                    got = await self.call("Network.getResponseBody", {"requestId": request_id}, timeout=8)
                    item.body = str(got.get("result", {}).get("body", ""))
                except Exception:  # noqa: BLE001 - 响应体可能已被回收
                    item.body = ""
            results.append(item)
        return results

    async def capture(self, seconds: float, want_do_only: bool = True) -> list[CapturedResponse]:
        """在指定时长内持续旁听并收集接口响应。

        :param seconds: 旁听时长（秒）。
        :param want_do_only: 只收集 ``.do`` 接口响应。
        :return: 捕获到的响应列表（同一接口可能多次）。
        """
        collected: list[CapturedResponse] = []
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            collected.extend(await self.poll_responses(want_do_only=want_do_only))
            await asyncio.sleep(0.25)
        return collected


# -- 外部 Edge 辅助 --------------------------------------------------------
def find_edge() -> str:
    """定位系统的 msedge.exe。

    :return: 可执行文件路径。
    :raises FileNotFoundError: 未找到 Edge。
    """
    for path in EDGE_CANDIDATES:
        if Path(path).exists():
            return path
    raise FileNotFoundError("未找到 msedge.exe")


def launch_edge(
    port: int,
    profile_dir: Path,
    url: str | None = None,
    app_mode: bool = False,
    headless: bool = False,
) -> subprocess.Popen:
    """以独立 profile 启动系统 Edge 并开启 CDP 端口。

    :param port: 远程调试端口。
    :param profile_dir: 专用用户数据目录（保存登录态，**不要用日常 profile**）。
    :param url: 打开的目标地址。
    :param app_mode: 以 ``--app`` 应用窗口模式打开（无地址栏，观感更接近工具的一部分）。
    :param headless: 无头模式（无法人工登录，仅供已登录 profile 复测）。
    :return: 进程对象。
    """
    args = [
        find_edge(),
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
    ]
    if headless:
        args.append("--headless")
    if url:
        args.append(f"--app={url}" if app_mode else url)
    return subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


async def wait_for_cdp(port: int, timeout: float = 40.0) -> dict:
    """等待 CDP 的 HTTP 端点就绪。

    :param port: 调试端口。
    :param timeout: 最长等待秒数。
    :return: ``/json/version`` 的内容。
    :raises TimeoutError: 超时未就绪。
    """
    deadline = time.monotonic() + timeout
    last_error = "unknown"
    async with aiohttp.ClientSession() as session:
        while time.monotonic() < deadline:
            try:
                async with session.get(f"http://127.0.0.1:{port}/json/version") as resp:
                    return await resp.json()
            except Exception as exc:  # noqa: BLE001
                last_error = type(exc).__name__
                await asyncio.sleep(0.6)
    raise TimeoutError(f"CDP 未就绪（{last_error}）")


async def pick_target(port: int, prefer_host: str = "szu.edu.cn") -> dict:
    """挑选一个可用的 page 调试目标。

    优先选择地址里含目标域名的目标，避免误选 ``about:blank``。

    :param port: 调试端口。
    :param prefer_host: 期望命中的主机名关键字。
    :return: 目标字典（含 ``webSocketDebuggerUrl``）。
    :raises RuntimeError: 没有可用目标。
    """
    async with aiohttp.ClientSession() as session:
        async with session.get(f"http://127.0.0.1:{port}/json/list") as resp:
            targets = await resp.json()
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("没有可用的 page 调试目标")
    preferred = [t for t in pages if prefer_host in str(t.get("url", ""))]
    return (preferred or pages)[0]


__all__ = [
    "CdpClient",
    "CapturedResponse",
    "find_edge",
    "launch_edge",
    "pick_target",
    "wait_for_cdp",
]
