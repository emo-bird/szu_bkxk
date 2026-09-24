# -*- coding: utf-8 -*-
"""B+ 路线可行性 spike：把 WebView2 内嵌进 PyQt6 窗口，并验证 6 项能力。

架构（B+）：
    - **pythonnet + 官方 WebView2 SDK（Core API）** 把 WebView2 嵌进 Qt 控件：
      ``CoreWebView2Environment.CreateAsync`` → ``CreateCoreWebView2ControllerAsync(parentHwnd)``，
      **不依赖 WinForms**；
    - 通过 ``AdditionalBrowserArguments = --remote-debugging-port=N`` 打开 CDP 端口，
      于是**数据面全部走 CDP**（复用 ``cdp_bridge``）：读 cookie/token、
      注入 JS 在课程卡片上显示教学班ID、被动捕获页面自身 XHR 响应体；
    - 抢课提交仍由 Python 的 aiohttp 走全局限流队列（本 spike 不涉及）。

验证清单：
    [1] WebView2 能否内嵌进 Qt 窗口（controller 创建 + Bounds 尺寸同步）
    [2] CDP 端口是否可达
    [3] 能否执行 JS / 读取 sessionStorage.token
    [4] 登录后能否读到 cookie（含 HttpOnly）
    [5] 能否在课程卡片上注入显示教学班ID
    [6] 能否被动捕获 programCourse.do 的 JSON 响应体（零额外请求）

用法（**在普通 PowerShell 里运行**）::

    cd C:\\Project\\szu_bkxk
    .\\.venv\\Scripts\\python.exe tools\\spike_webview2_embed.py

窗口内请完成统一身份认证登录；脚本会自动继续并打印 [OK]/[FAIL] 结论。
本脚本不向学校站点主动发起任何业务请求。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import threading
import time
import traceback

# pythonnet 在本机必须走 .NET Core 运行时（默认 netfx 会加载失败），
# 且必须在 import clr 之前设置。
os.environ.setdefault("PYTHONNET_RUNTIME", "coreclr")

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from PyQt6.QtCore import QTimer  # noqa: E402
from PyQt6.QtWidgets import (  # noqa: E402
    QApplication,
    QLabel,
    QMainWindow,
    QVBoxLayout,
    QWidget,
)

import cdp_bridge  # noqa: E402
import config  # noqa: E402

CORE_DLL = PROJECT_ROOT / "vendor" / "webview2" / "lib" / "net462" / "Microsoft.Web.WebView2.Core.dll"
DEBUG_PORT = 9340
PROFILE_DIR = PROJECT_ROOT / ".webview2_profile"
GRAB_URL = config.BASE_URL + config.EP_GRABLESSONS_PAGE
CHECK_TIMEOUT = 600.0

#: 在课程卡片上显示教学班ID —— 页面卡片 DOM 本身带 ``tcId`` 属性
INJECT_TCID_SCRIPT = r"""
(function () {
  if (window.__szuTcidHook) { return; }
  window.__szuTcidHook = true;
  function tag() {
    var cards = document.querySelectorAll('.cv-course-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.querySelector('.cv-tcid')) { continue; }
      var tid = card.getAttribute('tcId') || '';
      if (!tid) { continue; }
      var box = document.createElement('div');
      box.className = 'cv-tcid';
      box.style.cssText = 'color:#d00;font-weight:700;font-size:12px;margin-top:2px';
      box.textContent = '教学班ID: ' + tid;
      card.appendChild(box);
    }
  }
  var timer = null;
  new MutationObserver(function () {
    clearTimeout(timer);
    timer = setTimeout(tag, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tag, 1500);
  tag();
})();
"""


class WebContainer(QWidget):
    """承载内嵌 WebView2 的容器。

    WebView2 是原生子窗口（HWND），无法参与 Qt 的布局绘制，
    因此**必须在每次尺寸变化时手动同步它的 Bounds**，这就是本容器存在的原因。
    """

    def __init__(self, on_resize) -> None:
        """初始化容器。

        :param on_resize: 尺寸变化回调（无参）。
        """
        super().__init__()
        self._on_resize = on_resize

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 约定的驼峰命名
        """窗口尺寸变化时回调外部同步逻辑。

        :param event: Qt 尺寸事件。
        """
        super().resizeEvent(event)
        self._on_resize()


def load_webview2_types():
    """加载 WebView2 的 .NET 类型。

    :return: ``(CoreWebView2Environment, CoreWebView2EnvironmentOptions)``。
    :raises SystemExit: 程序集缺失或加载失败。
    """
    if not CORE_DLL.exists():
        print(f"[FAIL] 未找到 WebView2 SDK：{CORE_DLL}")
        print("       请下载官方 NuGet 包并解压到 vendor/webview2/")
        raise SystemExit(2)
    try:
        import clr

        clr.AddReference(str(CORE_DLL))
        for extra in ("System.Drawing.Primitives", "System.Drawing.Common"):
            try:
                clr.AddReference(extra)
            except Exception:  # noqa: BLE001 - 缺哪个都不致命
                continue
        from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
            CoreWebView2Environment,
            CoreWebView2EnvironmentOptions,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 加载 WebView2 程序集失败：{type(exc).__name__}: {exc}")
        raise SystemExit(2) from exc
    return CoreWebView2Environment, CoreWebView2EnvironmentOptions


def make_rect(x: int, y: int, width: int, height: int):
    """构造 ``System.Drawing.Rectangle``。

    :param x: 左坐标。
    :param y: 上坐标。
    :param width: 宽。
    :param height: 高。
    :return: Rectangle 实例；不可用时退回元组。
    """
    try:
        import System.Drawing  # noqa: F401

        return System.Drawing.Rectangle(x, y, width, height)
    except Exception:  # noqa: BLE001
        return (x, y, width, height)


def to_intptr(value: int):
    """把 Python int 转成 .NET ``System.IntPtr``。

    pythonnet **不做** int → IntPtr 的隐式转换，直接传 int 会报
    ``'int' value cannot be converted to System.IntPtr``，因此必须显式构造。

    :param value: 原生窗口句柄数值。
    :return: ``System.IntPtr`` 实例。
    """
    import System

    return System.IntPtr(value)


def ensure_com_initialized() -> None:
    """确保当前线程已初始化 COM（WebView2 要求 STA 套间）。

    Qt 通常已在 GUI 线程初始化过 COM，所以正常运行时无需干预；
    这里做一次幂等兜底，避免换调用场景时出现
    ``CO_E_NOTINITIALIZED (0x800401F0): 尚未调用 CoInitialize``。
    任何失败都忽略——真正的错误会在后续调用中显式暴露。
    """
    try:
        import ctypes

        # COINIT_APARTMENTTHREADED = 2；返回 S_OK/S_FALSE/RPC_E_CHANGED_MODE 均不做处理
        ctypes.windll.ole32.CoInitializeEx(None, 2)
    except Exception:  # noqa: BLE001
        pass


def run_cdp_checks(results: dict[str, bool], state: dict) -> None:
    """后台线程入口：跑完 CDP 数据面检查。

    :param results: 结果字典，就地更新。
    :param state: 共享状态字典，用于通知 Qt 侧退出。
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_cdp_checks(results))
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] CDP 检查异常：{type(exc).__name__}: {exc}")
    finally:
        loop.close()
        state["done"] = True


async def _cdp_checks(results: dict[str, bool]) -> None:
    """通过 CDP 完成凭证读取、DOM 注入与被动捕获。

    :param results: 结果字典，就地更新。
    """
    print("\n=== [2] 连接 CDP ===")
    try:
        version = await cdp_bridge.wait_for_cdp(DEBUG_PORT, timeout=30)
        print(f"    [OK] {version.get('Browser')} (CDP {version.get('Protocol-Version')})")
        results["CDP 端口可达"] = True
    except Exception as exc:  # noqa: BLE001
        print(f"    [FAIL] {exc}")
        return

    target = await cdp_bridge.pick_target(DEBUG_PORT)
    print(f"    目标页面 = {str(target.get('url'))[:80]}")
    async with cdp_bridge.CdpClient(target["webSocketDebuggerUrl"]) as cdp:
        await cdp.enable()

        print("\n=== [3] 执行 JS ===")
        title = await cdp.evaluate("document.title")
        href = await cdp.evaluate("location.href")
        print(f"    标题 = {title!r}  地址 = {str(href)[:70]}")
        results["执行 JS"] = True

        print("\n=== [4] 等待登录，然后读取凭证 ===")
        token = ""
        deadline = time.monotonic() + CHECK_TIMEOUT
        while not token and time.monotonic() < deadline:
            token = await cdp.session_storage("token")
            if token:
                break
            print("    …请在窗口中完成统一身份认证登录", end="\r")
            await asyncio.sleep(2)
        print()
        if token:
            print(f"    sessionStorage.token = {token[:10]}…(len={len(token)})")
        else:
            print("    [警告] 未取到 token，后续检查可能失败")
        cookie_header = await cdp.cookie_header(config.BASE_URL)
        cookie_names = [p.split("=")[0] for p in cookie_header.split("; ") if "=" in p]
        print(f"    Cookie 头长度 = {len(cookie_header)}，名称 = {cookie_names}")
        results["登录后读取 cookie"] = bool(cookie_header) and "JSESSIONID" in cookie_header

        print("\n=== [5] 在课程卡片上注入教学班ID ===")
        await cdp.inject_on_new_document(INJECT_TCID_SCRIPT)
        if token:
            await cdp.navigate(f"{GRAB_URL}?token={token}")
        await asyncio.sleep(5)
        injected = await cdp.evaluate(
            "(function(){var cards=document.querySelectorAll('.cv-course-card');"
            "var tags=document.querySelectorAll('.cv-tcid');"
            "return JSON.stringify({cards:cards.length,tags:tags.length,"
            "sample:tags.length?tags[0].textContent:''});})()"
        )
        print(f"    注入结果 = {injected}")
        try:
            stats = json.loads(str(injected))
            results["卡片注入教学班ID"] = int(stats.get("tags", 0)) > 0
            if stats.get("sample"):
                print(f"    卡片上显示 = {stats['sample']}")
        except Exception:  # noqa: BLE001
            results["卡片注入教学班ID"] = False

        print("\n=== [6] 被动捕获接口响应（零额外请求）===")
        captured = await cdp.capture(20)
        counts: dict[str, int] = {}
        samples: dict[str, str] = {}
        for item in captured:
            counts[item.endpoint] = counts.get(item.endpoint, 0) + 1
            if item.endpoint in samples:
                continue
            data = item.json_or_none()
            if not data:
                continue
            desc = f"code={data.get('code')!r} msg={data.get('msg')!r}"
            data_list = data.get("dataList")
            if isinstance(data_list, list):
                desc += f" dataList={len(data_list)}条"
                if data_list and isinstance(data_list[0], dict):
                    desc += f" 课程级字段={sorted(data_list[0].keys())[:12]}"
                    tc_list = data_list[0].get("tcList")
                    if isinstance(tc_list, list) and tc_list and isinstance(tc_list[0], dict):
                        desc += f" tcList={len(tc_list)}条 教学班级字段={sorted(tc_list[0].keys())[:12]}"
            samples[item.endpoint] = desc
        print(f"    捕获接口数 = {len(counts)}，总条数 = {len(captured)}")
        for endpoint, count in sorted(counts.items()):
            print(f"      {endpoint} ×{count}")
            if endpoint in samples:
                print(f"          {samples[endpoint]}")
        results["被动捕获接口响应"] = any(item.json_or_none() for item in captured)


def main() -> int:
    """执行 spike。

    :return: 进程退出码。
    """
    CoreWebView2Environment, CoreWebView2EnvironmentOptions = load_webview2_types()

    results: dict[str, bool] = {
        "WebView2 内嵌到 Qt 窗口": False,
        "CDP 端口可达": False,
        "执行 JS": False,
        "登录后读取 cookie": False,
        "卡片注入教学班ID": False,
        "被动捕获接口响应": False,
    }
    state: dict = {"env_task": None, "ctl_task": None, "controller": None, "done": False}

    def current_ratio() -> float:
        """返回当前窗口的 DPI 缩放比。

        :return: 缩放比（至少 1.0）。
        """
        try:
            return float(window.devicePixelRatioF()) or 1.0
        except Exception:  # noqa: BLE001
            return 1.0

    def apply_bounds() -> None:
        """把 WebView2 绘制区域同步到容器尺寸（按物理像素并设置缩放比）。"""
        controller = state.get("controller")
        if controller is None:
            return
        ratio = current_ratio()
        width = int(container.width() * ratio)
        height = int(container.height() * ratio)
        try:
            controller.Bounds = make_rect(0, 0, width, height)
            controller.RasterizationScale = ratio
        except Exception as exc:  # noqa: BLE001
            print(f"    [警告] 同步 Bounds 失败：{type(exc).__name__}: {exc}")

    app = QApplication(sys.argv)
    window = QMainWindow()
    window.setWindowTitle("B+ spike：WebView2 内嵌 + CDP")
    window.resize(1100, 820)
    central = QWidget()
    layout = QVBoxLayout(central)
    layout.setContentsMargins(0, 0, 0, 0)
    hint = QLabel("正在创建内嵌 WebView2 …（若长时间无变化，请看控制台输出）")
    layout.addWidget(hint)
    container = WebContainer(apply_bounds)
    container.setStyleSheet("background:#eee;")
    layout.addWidget(container, 1)
    window.setCentralWidget(central)
    window.show()
    app.processEvents()

    hwnd = int(container.winId())
    print("=== [1] 创建内嵌 WebView2 ===")
    print(f"    父窗口 HWND = {hwnd}，容器逻辑尺寸 = {container.width()}x{container.height()}，DPR = {current_ratio()}")

    options = CoreWebView2EnvironmentOptions()
    options.AdditionalBrowserArguments = f"--remote-debugging-port={DEBUG_PORT}"
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    ensure_com_initialized()
    state["env_task"] = CoreWebView2Environment.CreateAsync(None, str(PROFILE_DIR), options)

    def poll() -> None:
        """轮询 .NET Task 完成情况。

        刻意不使用阻塞等待：WebView2 的异步创建依赖调用线程的消息泵，
        阻塞会死锁，因此靠 Qt 事件循环持续泵消息并用定时器轮询完成状态。

        .. note::
           本函数是 Qt 槽函数，**必须吞掉所有异常** —— PyQt 对槽函数里逸出的
           未捕获异常会直接 ``abort()``，表现为「界面突然消失」。
        """
        try:
            env_task = state.get("env_task")
            ctl_task = state.get("ctl_task")
            if env_task is not None and env_task.IsCompleted:
                state["env_task"] = None
                try:
                    environment = env_task.Result
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"CreateAsync 失败：{exc}") from exc
                print("    CreateAsync 完成，正在创建 Controller …")
                state["ctl_task"] = environment.CreateCoreWebView2ControllerAsync(to_intptr(hwnd))
            elif ctl_task is not None and ctl_task.IsCompleted:
                state["ctl_task"] = None
                try:
                    controller = ctl_task.Result
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"CreateControllerAsync 失败：{exc}") from exc
                state["controller"] = controller
                try:
                    controller.IsVisible = True
                except Exception:  # noqa: BLE001
                    pass
                apply_bounds()
                results["WebView2 内嵌到 Qt 窗口"] = True
                hint.setText("内嵌 WebView2 已就绪，请完成登录")
                print("    [OK] Controller 创建成功，Bounds 已同步")
                controller.CoreWebView2.Navigate(GRAB_URL)
                threading.Thread(target=run_cdp_checks, args=(results, state), daemon=True).start()
                timer.stop()
        except Exception as exc:  # noqa: BLE001 - 槽函数绝不能抛出
            timer.stop()
            state["error"] = f"{type(exc).__name__}: {exc}"
            print(f"[FAIL] 创建内嵌 WebView2 失败：{state['error']}")
            print("       详细堆栈：")
            traceback.print_exc()

    timer = QTimer()
    timer.setInterval(60)
    timer.timeout.connect(poll)
    timer.start()

    def watch() -> None:
        """收尾：检查后台任务是否结束或出错，并强制超时退出。"""
        if state.get("error"):
            print(f"[FAIL] {state['error']}")
            app.quit()
        elif state.get("done"):
            app.quit()
        elif time.monotonic() - state.setdefault("start", time.monotonic()) > CHECK_TIMEOUT + 60:
            print("[FAIL] 总时长超时，强制退出")
            app.quit()

    guard = QTimer()
    guard.setInterval(300)
    guard.timeout.connect(watch)
    guard.start()

    code = app.exec()

    controller = state.get("controller")
    if controller is not None:
        try:
            controller.Close()
        except Exception:  # noqa: BLE001
            pass

    print("\n=== spike 结论 ===")
    for name, ok in results.items():
        print(f"    {'[OK]' if ok else '[FAIL]'} {name}")
    all_ok = all(results.values())
    print("\n全部通过：B+ 路线可行。" if all_ok else "\n存在未通过项，见上面逐项说明。")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
