# -*- coding: utf-8 -*-
"""全局异步优先级限流请求队列。

本模块是**全部 http 请求的唯一出口**：项目内任何网络请求都必须通过
:meth:`RequestQueue.submit` 入队，由内部单调度协程按固定间隔逐条取出执行，
禁止绕过队列直接调用 aiohttp。

硬性限流约束（对应需求文档第三节标签页2第 4 条）：
    - 每 ``config.REQUEST_INTERVAL_MS``（201ms）从队列取出 1 条请求执行，
      等价「1 秒内最多 5 条请求」；
    - 队列最大待处理请求数量 ``config.MAX_QUEUE_SIZE``（10），
      已满时**拒绝加入**新请求并输出日志告警，不阻塞 UI；
    - 请求优先级：用户手动触发的 UI 操作（``config.PRIORITY_HIGH``）优先于
      自动抢课轮询产生的后台请求（``config.PRIORITY_NORMAL``）。

线程模型：
    - 本模块所有公开协程都必须在**同一个 asyncio 事件循环**（即队列所属循环）中调用；
    - Qt 主线程请使用 ``asyncio.run_coroutine_threadsafe`` 投递协程，不要直接调用。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any, Awaitable, Callable

import config
from logger_util import Logger


class QueueFullError(RuntimeError):
    """请求队列已满，本次请求被拒绝入队。

    调用方应捕获该异常并提示用户，不要重试压队列。
    """


class QueueNotStartedError(RuntimeError):
    """请求队列尚未启动就尝试投递请求。"""


class _QueueItem:
    """队列元素：一条待执行的请求任务。

    排序键为 ``(priority, sequence)``，数值小的先执行；``sequence`` 为单调递增序号，
    保证同优先级下先进先出。

    :ivar priority: 请求优先级，见 ``config.PRIORITY_*``。
    :ivar sequence: 入队序号。
    :ivar coro_factory: 无参协程工厂，真正发起 http 请求的可调用对象。
    :ivar name: 请求名称，仅用于日志展示。
    :ivar future: 用于把执行结果回传给 ``submit`` 调用方的 future。
    """

    __slots__ = ("priority", "sequence", "coro_factory", "name", "future")

    def __init__(
        self,
        priority: int,
        sequence: int,
        coro_factory: Callable[[], Awaitable[Any]],
        name: str,
        future: "asyncio.Future[Any]",
    ) -> None:
        self.priority = priority
        self.sequence = sequence
        self.coro_factory = coro_factory
        self.name = name
        self.future = future

    def __lt__(self, other: "_QueueItem") -> bool:
        """按优先级与入队序号比较，供 ``asyncio.PriorityQueue`` 排序。"""
        return (self.priority, self.sequence) < (other.priority, other.sequence)

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"<_QueueItem p={self.priority} seq={self.sequence} name={self.name!r}>"


class RequestQueue:
    """全局异步优先级限流请求队列。

    :ivar _queue: 底层优先级队列，延迟到 :meth:`start` 时创建。
    :ivar _worker: 调度协程对应的 task。
    :ivar _dispatched: 已成功调度执行的请求数量。
    :ivar _dropped: 因队列已满被丢弃的请求数量。
    """

    def __init__(
        self,
        logger: Logger | None = None,
        interval_ms: int = config.REQUEST_INTERVAL_MS,
        max_size: int = config.MAX_QUEUE_SIZE,
    ) -> None:
        """初始化请求队列（此时尚未开始调度）。

        :param logger: 日志器，``None`` 表示不记录日志。
        :param interval_ms: 两条请求之间的最小调度间隔（毫秒），默认 201ms。
        :param max_size: 队列最大待处理数量，默认 10。
        """
        self._logger = logger
        self._interval_ms: int = max(int(interval_ms), 1)
        self._max_size: int = max(int(max_size), 1)
        self._queue: asyncio.PriorityQueue[_QueueItem] | None = None
        self._worker: asyncio.Task[None] | None = None
        self._counter = itertools.count(1)
        self._dispatched: int = 0
        self._dropped: int = 0
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- 生命周期 -----------------------------------------------------------
    async def start(self) -> None:
        """启动调度协程；重复调用为空操作。

        :return: ``None``
        """
        if self._worker is not None and not self._worker.done():
            return
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.PriorityQueue(maxsize=self._max_size)
        self._worker = asyncio.create_task(self._run(), name="request-queue-worker")
        self._log_info(
            f"请求队列已启动：调度间隔 {self._interval_ms}ms，队列上限 {self._max_size}"
        )

    async def stop(self) -> None:
        """停止调度协程，并取消所有尚未执行的排队请求。

        :return: ``None``
        """
        worker, self._worker = self._worker, None
        if worker is not None and not worker.done():
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass
        self._cancel_pending()
        self._log_info("请求队列已停止")

    def _cancel_pending(self) -> None:
        """取消队列中所有尚未开始执行的请求，避免调用方永久等待。"""
        if self._queue is None:
            return
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not item.future.done():
                item.future.cancel()

    # -- 投递 ---------------------------------------------------------------
    async def submit(
        self,
        coro_factory: Callable[[], Awaitable[Any]],
        priority: int = config.PRIORITY_NORMAL,
        name: str = "",
    ) -> Any:
        """把一条请求送入队列，并等待其执行完成。

        队列已满时**立即**抛出 :class:`QueueFullError`（不阻塞、不重试）。

        :param coro_factory: 无参协程工厂，被调用时才真正发起 http 请求。
        :param priority: 优先级，``config.PRIORITY_HIGH`` 或 ``config.PRIORITY_NORMAL``。
        :param name: 请求名称，用于日志展示。
        :return: ``coro_factory`` 的执行结果。
        :raises QueueFullError: 队列已满，请求被丢弃。
        :raises QueueNotStartedError: 队列未启动。
        """
        if self._queue is None or self._worker is None or self._worker.done():
            raise QueueNotStartedError("请求队列未启动，已拒绝入队")
        loop = asyncio.get_running_loop()
        if self._loop is not None and loop is not self._loop:
            raise QueueNotStartedError("请求必须投递到队列所属的事件循环中")

        label = name or "未命名请求"
        if self._queue.full():
            self._dropped += 1
            self._log_warning(
                f"队列已满（上限 {self._max_size}），请求被拒绝入队：{label}"
            )
            raise QueueFullError(f"请求队列已满（上限 {self._max_size}），已丢弃：{label}")

        future: "asyncio.Future[Any]" = loop.create_future()
        item = _QueueItem(priority, next(self._counter), coro_factory, label, future)
        self._queue.put_nowait(item)
        if priority == config.PRIORITY_HIGH:
            self._log_info(f"高优先级请求入队：{label}（当前待处理 {self._queue.qsize()}）")
        return await future

    # -- 状态 ---------------------------------------------------------------
    @property
    def pending(self) -> int:
        """返回当前等待处理的请求数量。"""
        return 0 if self._queue is None else self._queue.qsize()

    @property
    def interval_ms(self) -> int:
        """返回两条请求之间的最小调度间隔（毫秒）。"""
        return self._interval_ms

    @property
    def max_size(self) -> int:
        """返回队列最大待处理数量。"""
        return self._max_size

    def stats(self) -> dict[str, int]:
        """返回队列运行统计信息。

        :return: 含 ``dispatched``（已调度）、``dropped``（已丢弃）、``pending``（待处理）的字典。
        """
        return {
            "dispatched": self._dispatched,
            "dropped": self._dropped,
            "pending": self.pending,
        }

    # -- 调度实现 -----------------------------------------------------------
    async def _run(self) -> None:
        """调度主循环：每 ``interval_ms`` 取出并执行 1 条请求。"""
        assert self._queue is not None
        while True:
            item = await self._queue.get()
            await self._execute(item)
            await asyncio.sleep(self._interval_ms / 1000.0)

    async def _execute(self, item: _QueueItem) -> None:
        """执行单条请求并把结果回填到其 future。

        本方法不会向外抛出异常，所有异常都通过 future 传给 ``submit`` 的调用方。

        :param item: 待执行的队列元素。
        :return: ``None``
        """
        try:
            result = await item.coro_factory()
        except asyncio.CancelledError:
            if not item.future.done():
                item.future.cancel()
            raise
        except Exception as exc:  # noqa: BLE001 - 统一转交给调用方处理
            if not item.future.done():
                item.future.set_exception(exc)
            self._log_warning(f"请求执行异常：{item.name} → {exc}")
        else:
            if not item.future.done():
                item.future.set_result(result)
        finally:
            self._dispatched += 1
            self._log_info(
                f"已调度请求：{item.name}（累计 {self._dispatched} 条，待处理 {self.pending}）"
            )

    # -- 日志便捷方法 -------------------------------------------------------
    def _log_info(self, message: str) -> None:
        """以「队列调度」分类记录普通日志。

        :param message: 日志正文。
        :return: ``None``
        """
        if self._logger is not None:
            self._logger.info(config.SOURCE_QUEUE, message, config.CATEGORY_QUEUE)

    def _log_warning(self, message: str) -> None:
        """以「队列调度」分类记录告警日志。

        :param message: 日志正文。
        :return: ``None``
        """
        if self._logger is not None:
            self._logger.warning(config.SOURCE_QUEUE, message, config.CATEGORY_QUEUE)
