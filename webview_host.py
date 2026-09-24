# -*- coding: utf-8 -*-
"""内嵌选课网页的窗口宿主（pythonnet + 官方 WebView2 SDK 的 Core API）。

职责（**只做窗口，不做数据**）：
    - 用 ``CoreWebView2Environment.CreateAsync`` 创建环境；
    - 用 ``CreateCoreWebView2ControllerAsync(parentHwnd)`` 把 WebView2 **内嵌**
      到指定的 Qt 控件里（``parentHwnd`` 取该控件的 ``winId()``）；
    - 通过 ``AdditionalBrowserArguments = --remote-debugging-port=N`` 打开 CDP 端口，
      之后所有数据面（读 cookie/token、注入 JS、被动取数、网页回传）都交给
      :mod:`webview_bridge`，**本模块不参与**。

为什么把数据面隔离到 CDP：pythonnet 只负责「创建并摆放窗口」，
万一 pythonnet 或 HWND 宿主出问题，也只是少一个标签页，不影响取数与抢课。

实现要点（都是踩过的坑）：
    - ``PYTHONNET_RUNTIME`` 必须为 ``coreclr``，且**必须在 import clr 之前**设置；
    - ``int`` 不能隐式转 ``System.IntPtr``，必须显式 ``System.IntPtr(hwnd)``；
    - WebView2 的异步创建依赖调用线程的消息泵，**不能阻塞等待 Task**，
      要用 Qt 定时器轮询 ``IsCompleted``；
    - WebView2 要求线程已初始化 COM（STA），Qt GUI 线程通常已初始化，
      这里再做一次幂等兜底；
    - 本模块的槽函数**绝不能抛出异常**（PyQt 对槽内未捕获异常会直接 abort）。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

# 必须在 import clr 之前设置：本机默认 netfx 路径会加载失败
os.environ.setdefault("PYTHONNET_RUNTIME", "coreclr")

from PyQt6.QtCore import QObject, QTimer, pyqtSignal  # noqa: E402
from PyQt6.QtWidgets import QWidget  # noqa: E402

import config  # noqa: E402


def sdk_dll_path() -> Path:
    """返回 WebView2 Core 程序集路径。

    :return: ``Microsoft.Web.WebView2.Core.dll`` 的完整路径。
    """
    return config.WEBVIEW_SDK_DIR / "lib" / "net462" / "Microsoft.Web.WebView2.Core.dll"


def webview2_available() -> tuple[bool, str]:
    """检测内嵌 WebView2 的运行条件是否具备。

    检查三件事：SDK 程序集存在、pythonnet 可用、程序集能加载。

    :return: ``(是否可用, 说明)``。
    """
    dll = sdk_dll_path()
    if not dll.exists():
        return False, (
            f"未找到 WebView2 SDK：{dll}\n"
            f"       请下载官方 NuGet 包（Microsoft.Web.WebView2）并解压到 {config.WEBVIEW_SDK_DIR}"
        )
    try:
        _load_types()
    except Exception as exc:  # noqa: BLE001 - 任何失败都只是「不可用」
        return False, f"加载 WebView2 程序集失败：{type(exc).__name__}: {exc}"
    return True, "就绪"


def _load_types():
    """加载并返回 WebView2 的 .NET 类型。

    :return: ``(CoreWebView2Environment, CoreWebView2EnvironmentOptions)``。
    """
    import clr  # pythonnet，仅在真正需要时导入

    clr.AddReference(str(sdk_dll_path()))
    for extra in ("System.Drawing.Primitives", "System.Drawing.Common"):
        try:
            clr.AddReference(extra)
        except Exception:  # noqa: BLE001 - 缺哪个都不致命
            continue
    from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
        CoreWebView2Environment,
        CoreWebView2EnvironmentOptions,
    )

    return CoreWebView2Environment, CoreWebView2EnvironmentOptions


def _make_rect(x: int, y: int, width: int, height: int):
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


def _to_intptr(value: int):
    """把 Python int 转成 .NET ``System.IntPtr``。

    pythonnet 不做隐式转换，直接传 int 会报
    ``'int' value cannot be converted to System.IntPtr``。

    :param value: 原生窗口句柄数值。
    :return: ``System.IntPtr`` 实例。
    """
    import System

    return System.IntPtr(value)


def ensure_com_initialized() -> None:
    """确保当前线程已初始化 COM（WebView2 要求 STA 套间）。

    Qt GUI 线程通常已初始化 COM，这里做一次幂等兜底，任何失败都忽略。

    :return: ``None``
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.ole32.CoInitializeEx(None, 2)
    except Exception:  # noqa: BLE001
        pass


class WebContainer(QWidget):
    """承载内嵌 WebView2 的容器控件。

    WebView2 是**原生子窗口（HWND）**，不参与 Qt 的布局绘制，
    因此它的大小必须由我们手动同步，这就是本控件存在的原因。
    """

    def __init__(self, on_resize) -> None:
        """初始化容器。

        :param on_resize: 尺寸变化回调（无参）。
        """
        super().__init__()
        self._on_resize = on_resize

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 约定的驼峰命名
        """尺寸变化时触发外部同步。

        :param event: Qt 尺寸事件。
        """
        super().resizeEvent(event)
        try:
            self._on_resize()
        except Exception:  # noqa: BLE001 - 槽函数不能抛
            pass


class WebViewHost(QObject):
    """把 WebView2 内嵌进 Qt 控件的宿主。

    :ivar ready: WebView2 就绪（可以开始导航）时发出。
    :ivar failed: 创建失败时发出，携带错误说明。
    """

    ready = pyqtSignal()
    failed = pyqtSignal(str)

    def __init__(self, container: QWidget, parent: QObject | None = None) -> None:
        """初始化宿主（此时尚未创建 WebView2）。

        :param container: 承载 WebView2 的控件（其 ``winId()`` 作为父窗口）。
        :param parent: Qt 父对象。
        """
        super().__init__(parent)
        self._container = container
        self._controller = None
        self._env_task = None
        self._ctl_task = None
        self._timer = QTimer(self)
        self._timer.setInterval(60)
        self._timer.timeout.connect(self._poll_tasks)

    # -- 生命周期 -----------------------------------------------------------
    def start(self) -> None:
        """开始创建 WebView2（异步，完成后发出 :attr:`ready`）。

        :return: ``None``
        """
        try:
            environment_cls, options_cls = _load_types()
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"加载 WebView2 程序集失败：{type(exc).__name__}: {exc}")
            return
        try:
            config.WEBVIEW_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
            ensure_com_initialized()
            options = options_cls()
            options.AdditionalBrowserArguments = f"--remote-debugging-port={config.WEBVIEW_DEBUG_PORT}"
            # 容器必须先成为原生窗口，winId() 才有真实句柄
            hwnd = int(self._container.winId())
            self._env_task = environment_cls.CreateAsync(
                None, str(config.WEBVIEW_PROFILE_DIR), options
            )
            self._hwnd = hwnd
            self._timer.start()
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"创建 WebView2 环境失败：{type(exc).__name__}: {exc}")

    def close(self) -> None:
        """关闭 WebView2 控制器，释放浏览器进程。

        :return: ``None``
        """
        self._timer.stop()
        controller, self._controller = self._controller, None
        if controller is not None:
            try:
                controller.Close()
            except Exception:  # noqa: BLE001
                pass

    # -- 对外操作 -----------------------------------------------------------
    def navigate(self, url: str) -> None:
        """导航到指定地址。

        :param url: 目标地址。
        :return: ``None``
        """
        if self._controller is None:
            return
        try:
            self._controller.CoreWebView2.Navigate(url)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"导航失败：{type(exc).__name__}: {exc}")

    def sync_bounds(self) -> None:
        """把 WebView2 的绘制区域同步到容器尺寸（按物理像素 + DPI 缩放）。

        :return: ``None``
        """
        controller = self._controller
        if controller is None:
            return
        try:
            ratio = float(self._container.devicePixelRatioF()) or 1.0
            width = int(self._container.width() * ratio)
            height = int(self._container.height() * ratio)
            controller.Bounds = _make_rect(0, 0, width, height)
            controller.RasterizationScale = ratio
        except Exception:  # noqa: BLE001 - 尺寸同步失败不该中断程序
            pass

    # -- 内部：轮询 .NET Task ----------------------------------------------
    def _poll_tasks(self) -> None:
        """轮询 .NET Task 的完成状态并推进创建流程。

        刻意不阻塞等待：WebView2 的异步创建依赖调用线程的消息泵，
        阻塞会死锁；因此靠 Qt 事件循环持续泵消息 + 定时器轮询。
        本函数是 Qt 槽函数，**必须吞掉所有异常**。
        """
        try:
            if self._env_task is not None and self._env_task.IsCompleted:
                task, self._env_task = self._env_task, None
                environment = task.Result
                self._ctl_task = environment.CreateCoreWebView2ControllerAsync(
                    _to_intptr(getattr(self, "_hwnd", 0))
                )
                return
            if self._ctl_task is not None and self._ctl_task.IsCompleted:
                task, self._ctl_task = self._ctl_task, None
                controller = task.Result
                self._controller = controller
                try:
                    controller.IsVisible = True
                except Exception:  # noqa: BLE001
                    pass
                self.sync_bounds()
                self._timer.stop()
                self.ready.emit()
        except Exception as exc:  # noqa: BLE001 - 槽函数绝不能抛
            self._timer.stop()
            self.failed.emit(f"{type(exc).__name__}: {exc}")
            traceback.print_exc()
