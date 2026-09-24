# -*- coding: utf-8 -*-
"""程序入口：风险提示弹窗、模块初始化、Qt 与 asyncio 双事件循环。

启动流程：
    1. 创建 :class:`QApplication`，弹出强制风险提示弹窗，用户明确同意后才继续；
    2. 初始化日志器、身份凭证容器、全局请求队列、网络客户端；
    3. 在独立线程中启动 asyncio 事件循环，并完成队列与 aiohttp 会话的初始化；
    4. 构建主窗口并进入 Qt 事件循环；
    5. 退出时保存抢课任务配置、停止全部任务、关闭会话与日志文件。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import sys
import threading
from typing import Any, Coroutine

from PyQt6.QtWidgets import QApplication, QMessageBox

import config
from api_client import ApiClient
from auth_model import Credentials
from logger_util import Logger
from request_queue import RequestQueue
from ui_main import MainWindow


class AsyncRuntime:
    """后台 asyncio 事件循环运行时。

    负责在独立线程中运行事件循环，并提供把协程从 Qt 主线程投递进去、以及
    在退出时优雅关闭循环的能力。

    :ivar _loop: 后台事件循环。
    :ivar _thread: 运行事件循环的线程。
    """

    def __init__(self) -> None:
        """初始化运行时（此时尚未创建事件循环）。"""
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        """返回后台事件循环；未启动时为 ``None``。"""
        return self._loop

    def start(self, bootstrap: Coroutine[Any, Any, None], timeout: float = 15.0) -> None:
        """创建事件循环线程，并同步等待初始化协程执行完成。

        :param bootstrap: 启动协程，用于初始化请求队列与 http 会话。
        :param timeout: 等待初始化完成的最长秒数。
        :return: ``None``
        :raises RuntimeError: 初始化超时或失败。
        """
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="asyncio-runtime", daemon=True)
        self._thread.start()
        future = asyncio.run_coroutine_threadsafe(bootstrap, self._loop)
        try:
            future.result(timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - 初始化失败需要显式上报
            raise RuntimeError(f"异步运行时初始化失败：{exc}") from exc

    def _run_loop(self) -> None:
        """线程入口：把事件循环设为当前循环并持续运行。"""
        assert self._loop is not None
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run_and_wait(self, coro: Coroutine[Any, Any, Any], timeout: float = 10.0) -> Any:
        """在主线程中同步等待一个协程在后台循环中执行完成。

        :param coro: 待执行的协程。
        :param timeout: 最长等待秒数。
        :return: 协程返回值；循环不可用时返回 ``None``。
        """
        if self._loop is None or self._loop.is_closed():
            coro.close()
            return None
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def stop(self) -> None:
        """停止事件循环线程并释放事件循环。

        :return: ``None``
        """
        loop, thread = self._loop, self._thread
        if loop is None:
            return
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=5)
        if not loop.is_closed():
            loop.close()
        self._loop = None
        self._thread = None


def show_risk_dialog() -> bool:
    """弹出强制风险提示弹窗。

    默认按钮为「退出」，用户必须主动点击同意按钮才能继续。

    :return: 用户同意返回 ``True``。
    """
    box = QMessageBox()
    box.setIcon(QMessageBox.Icon.Warning)
    box.setWindowTitle("风险提示（务必阅读）")
    text = config.RISK_WARNING_TEXT
    if config.ENABLE_WRITE_API:
        text += (
            "\n\n【当前状态：写接口总开关已开启】\n"
            f"开启来源：{config.WRITE_API_SOURCE}。\n"
            "确认后抢课任务会真实提交选课请求，可能触发学校风控，请自行承担后果。"
        )
    box.setText(text)
    box.setStandardButtons(QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel)
    box.button(QMessageBox.StandardButton.Ok).setText("我已阅读并同意（仅用于学习研究）")
    box.button(QMessageBox.StandardButton.Cancel).setText("退出")
    box.setDefaultButton(QMessageBox.StandardButton.Cancel)
    return box.exec() == QMessageBox.StandardButton.Ok


def build_components(logger: Logger) -> tuple[Credentials, RequestQueue, ApiClient]:
    """构建各业务模块实例。

    :param logger: 日志器。
    :return: ``(凭证容器, 请求队列, 网络客户端)`` 三元组。
    """
    credentials = Credentials()
    queue = RequestQueue(logger=logger)
    client = ApiClient(lambda: credentials, queue, logger)
    return credentials, queue, client


def main() -> int:
    """程序主入口。

    :return: 进程退出码，``0`` 表示正常退出。
    """
    print(config.RISK_WARNING_TEXT)
    app = QApplication(sys.argv)
    app.setApplicationName(config.APP_NAME)

    if not show_risk_dialog():
        print("用户未同意风险提示，程序退出。")
        return 1

    logger = Logger()
    logger.info(
        config.SOURCE_SYSTEM,
        f"{config.APP_NAME} v{config.APP_VERSION} 启动；"
        f"写接口开关 ENABLE_WRITE_API={config.ENABLE_WRITE_API}（False 表示仅构造报文、不发送真实写请求）。",
        config.CATEGORY_SYSTEM,
    )

    if config.ENABLE_WRITE_API:
        logger.warning(
            config.SOURCE_SYSTEM,
            f"写接口总开关已由「{config.WRITE_API_SOURCE}」打开：抢课任务会真实提交选课请求，"
            f"可能触发学校风控，风险自负。关闭方式：删除/改写 {config.SETTINGS_FILE.name} 或移除该环境变量。",
            config.CATEGORY_SYSTEM,
        )

    credentials, queue, client = build_components(logger)

    async def bootstrap() -> None:
        """初始化请求队列与 http 会话。"""
        await queue.start()
        await client.start()

    runtime = AsyncRuntime()
    window: MainWindow | None = None
    exit_code = 0
    try:
        runtime.start(bootstrap())
        window = MainWindow(client, logger, runtime.loop, credentials)
        # 把后台线程产生的日志转发到界面日志面板（Qt 信号自动排队到主线程）
        logger.set_ui_sink(window.bridge.logRecord.emit)
        window.show()
        # 启动内嵌选课网页（环境不支持时自动降级为纯 aiohttp 模式，不影响抢课功能）
        window.start_webview()
        exit_code = app.exec()
    except Exception as exc:  # noqa: BLE001 - 启动失败需要提示并落盘日志
        logger.error(config.SOURCE_SYSTEM, f"程序启动失败：{exc}", config.CATEGORY_SYSTEM)
        print(f"程序启动失败：{exc}")
        exit_code = 2
    finally:
        try:
            if window is not None:
                runtime.run_and_wait(window.task_runner.stop_all(), timeout=10)
            runtime.run_and_wait(client.close(), timeout=10)
            runtime.run_and_wait(queue.stop(), timeout=10)
        except Exception as exc:  # noqa: BLE001 - 退出清理异常不影响退出码
            print(f"退出清理出现异常：{exc}", file=sys.stderr)
        runtime.stop()
        logger.close()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
