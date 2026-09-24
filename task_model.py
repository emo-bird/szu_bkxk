# -*- coding: utf-8 -*-
"""抢课任务数据模型与任务执行器。

职责：
    - :class:`GrabTask`：单个抢课任务的配置与运行状态；
    - :class:`TaskStatus`：任务状态枚举（等待中 / 运行中 / 抢课成功 / 已停止 / 异常失败）；
    - 任务配置的本地 JSON 持久化（程序关闭写入、启动读取，**恢复后一律置为「已停止」**）；
    - :class:`GrabTaskRunner`：在 asyncio 事件循环中为每个任务维护独立轮询协程，
      多任务互不阻塞，网络请求统一经全局限流队列。

轮询间隔约束（需求 §三.2.2 / §七.5）：
    单任务轮询间隔下限为 ``config.MIN_POLL_INTERVAL_MS``（500ms），
    用户配置小于该值时自动钳位并输出日志告警。

写接口策略：
    当 ``config.ENABLE_WRITE_API`` 为 ``False``（求证阶段的默认值）时，
    任务检测到有余量后进入「模拟提交」，此时不存在成功可能；
    为避免无意义地持续请求接口，任务会**自动停止**并在最近消息中说明原因。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import config
import course_model as cm
from api_client import ApiClient, ApiError, MissingCredentialsError, NotAuthenticatedError
from logger_util import Logger
from request_queue import QueueFullError


class TaskStatus(str, Enum):
    """抢课任务状态。"""

    WAITING = "WAITING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    STOPPED = "STOPPED"
    FAILED = "FAILED"


#: 任务状态到界面中文文案的映射
STATUS_TEXT: dict[TaskStatus, str] = {
    TaskStatus.WAITING: "等待中",
    TaskStatus.RUNNING: "运行中",
    TaskStatus.SUCCESS: "抢课成功",
    TaskStatus.STOPPED: "已停止",
    TaskStatus.FAILED: "异常失败",
}

#: 表格列定义：``(取值方式, 表头)``；取值方式为 :class:`GrabTask` 的属性名或方法名。
TASK_COLUMNS: tuple[tuple[str, str], ...] = (
    ("short_id", "任务ID"),
    ("course_name", "课程名称"),
    ("teacher_name", "教师"),
    ("course_number", "课程号"),
    ("course_total_number", "课程总号"),
    ("teaching_class_id", "教学班ID"),
    ("type_text", "类别"),
    ("interval_text", "轮询间隔"),
    ("full_policy_text", "满课策略"),
    ("status_text", "状态"),
    ("attempts", "尝试次数"),
    ("last_message", "最近消息"),
)

#: 任务状态展示文本常量（供日志与界面复用）
FULL_STOP_TEXT: str = "满课后停止"
FULL_CONTINUE_TEXT: str = "满课继续轮询"


def new_task_id() -> str:
    """生成一个新的任务 ID。

    :return: 16 位十六进制字符串。
    """
    return uuid.uuid4().hex[:16]


def clamp_poll_interval(interval_ms: int, logger: Logger | None = None, context: str = "") -> int:
    """把轮询间隔钳位到合法下限以上。

    :param interval_ms: 用户配置的轮询间隔（毫秒）。
    :param logger: 日志器；发生钳位时输出告警。
    :param context: 附加在告警文案中的上下文（如课程名）。
    :return: 钳位后的轮询间隔。
    """
    if interval_ms < config.MIN_POLL_INTERVAL_MS:
        if logger is not None:
            suffix = f"（{context}）" if context else ""
            logger.warning(
                config.SOURCE_TASK,
                f"轮询间隔 {interval_ms}ms 低于下限 {config.MIN_POLL_INTERVAL_MS}ms{suffix}，已自动钳位为 {config.MIN_POLL_INTERVAL_MS}ms。",
                config.CATEGORY_SYSTEM,
            )
        return config.MIN_POLL_INTERVAL_MS
    return interval_ms


@dataclass
class GrabTask:
    """单个抢课任务的配置与运行状态。

    :ivar task_id: 任务唯一标识。
    :ivar teaching_class_id: 目标教学班 ID（接口提交时的 ``teachingClassId``）。
    :ivar teaching_class_type: 课程类别代码。
    :ivar poll_interval_ms: 轮询间隔（毫秒），不得小于 ``config.MIN_POLL_INTERVAL_MS``。
    :ivar stop_when_full: ``True`` 表示检测到课程已满即停止本任务；
        ``False`` 表示满课继续轮询，等待放量。
    :ivar status: 当前任务状态。
    :ivar attempts: 已轮询次数。
    :ivar last_message: 最近一次轮询结果说明。
    """

    task_id: str = field(default_factory=new_task_id)
    course_name: str = ""
    teacher_name: str = ""
    course_number: str = ""
    course_total_number: str = ""
    teaching_class_id: str = ""
    teaching_class_type: str = "FANKC"
    poll_interval_ms: int = config.DEFAULT_POLL_INTERVAL_MS
    stop_when_full: bool = True
    status: TaskStatus = TaskStatus.STOPPED
    attempts: int = 0
    last_message: str = ""

    # -- 展示辅助 -----------------------------------------------------------
    @property
    def short_id(self) -> str:
        """返回截断后的任务 ID，用于表格展示。"""
        return self.task_id[:8]

    @property
    def type_text(self) -> str:
        """返回课程类别中文名。"""
        return config.TEACHING_CLASS_TYPES.get(self.teaching_class_type, self.teaching_class_type)

    @property
    def interval_text(self) -> str:
        """返回轮询间隔展示文本。"""
        return f"{self.poll_interval_ms} ms"

    @property
    def full_policy_text(self) -> str:
        """返回满课策略展示文本。"""
        return FULL_STOP_TEXT if self.stop_when_full else FULL_CONTINUE_TEXT

    @property
    def status_text(self) -> str:
        """返回任务状态中文文案。"""
        return STATUS_TEXT.get(self.status, str(self.status))

    @property
    def display_name(self) -> str:
        """返回任务的可读名称（优先课程名，其次教学班 ID）。"""
        return self.course_name or self.teaching_class_id or self.task_id

    def row_values(self) -> list[str]:
        """按 :data:`TASK_COLUMNS` 顺序生成界面行数据。

        :return: 与表头一一对应的字符串列表。
        """
        return [str(getattr(self, name, "")) for name, _ in TASK_COLUMNS]

    def clamp_interval(self, logger: Logger | None = None) -> bool:
        """把本任务的轮询间隔钳位到合法下限。

        :param logger: 日志器，发生钳位时输出告警。
        :return: 发生了钳位返回 ``True``。
        """
        clamped = clamp_poll_interval(self.poll_interval_ms, logger, self.display_name)
        changed = clamped != self.poll_interval_ms
        self.poll_interval_ms = clamped
        return changed

    def is_runnable(self) -> bool:
        """判断任务是否具备启动条件。

        :return: 已配置教学班 ID 且未处于运行中时返回 ``True``。
        """
        return bool(self.teaching_class_id.strip()) and self.status is not TaskStatus.RUNNING

    # -- 序列化 -------------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        """序列化为可写入 JSON 的字典。

        :return: 字段字典（不含任何凭证信息）。
        """
        return {
            "taskId": self.task_id,
            "courseName": self.course_name,
            "teacherName": self.teacher_name,
            "courseNumber": self.course_number,
            "courseTotalNumber": self.course_total_number,
            "teachingClassId": self.teaching_class_id,
            "teachingClassType": self.teaching_class_type,
            "pollIntervalMs": self.poll_interval_ms,
            "stopWhenFull": self.stop_when_full,
            "status": self.status.value,
            "attempts": self.attempts,
            "lastMessage": self.last_message,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "GrabTask":
        """从 JSON 字典反序列化任务。

        无论文件中记录的状态是什么，恢复后的任务状态一律为「已停止」
        （需求 §七.6：启动恢复的任务不会自动运行）。

        :param data: :meth:`to_dict` 产生的字典。
        :return: :class:`GrabTask` 实例。
        """
        task = cls(
            task_id=str(data.get("taskId") or new_task_id()),
            course_name=str(data.get("courseName", "")),
            teacher_name=str(data.get("teacherName", "")),
            course_number=str(data.get("courseNumber", "")),
            course_total_number=str(data.get("courseTotalNumber", "")),
            teaching_class_id=str(data.get("teachingClassId", "")),
            teaching_class_type=str(data.get("teachingClassType", "FANKC")),
            poll_interval_ms=int(data.get("pollIntervalMs", config.DEFAULT_POLL_INTERVAL_MS) or 0),
            stop_when_full=bool(data.get("stopWhenFull", True)),
            attempts=int(data.get("attempts", 0) or 0),
            last_message=str(data.get("lastMessage", "")),
        )
        task.status = TaskStatus.STOPPED
        return task


def load_tasks(path: Path | None = None, logger: Logger | None = None) -> list[GrabTask]:
    """从本地 JSON 文件读取抢课任务配置。

    文件缺失或损坏时返回空列表，不抛异常；读取到的任务状态统一置为「已停止」，
    轮询间隔会被钳位到合法下限。

    :param path: 任务配置文件路径，默认 ``config.TASK_CONFIG_FILE``。
    :param logger: 日志器。
    :return: 任务列表。
    """
    target = Path(path) if path is not None else config.TASK_CONFIG_FILE
    try:
        with open(target, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        if logger is not None:
            logger.info(config.SOURCE_TASK, f"未找到任务配置文件（{target.name}），当前没有已保存的任务。", config.CATEGORY_SYSTEM)
        return []
    except (OSError, json.JSONDecodeError) as exc:
        if logger is not None:
            logger.warning(config.SOURCE_TASK, f"读取任务配置失败（{target.name}）：{exc}", config.CATEGORY_SYSTEM)
        return []

    raw_tasks = data.get("tasks") if isinstance(data, Mapping) else data
    if not isinstance(raw_tasks, list):
        if logger is not None:
            logger.warning(config.SOURCE_TASK, f"任务配置结构异常（{target.name}），已忽略。", config.CATEGORY_SYSTEM)
        return []

    tasks: list[GrabTask] = []
    for item in raw_tasks:
        if not isinstance(item, Mapping):
            continue
        task = GrabTask.from_dict(item)
        task.clamp_interval(logger)
        tasks.append(task)
    if logger is not None:
        logger.info(
            config.SOURCE_TASK,
            f"已恢复 {len(tasks)} 个抢课任务，状态统一置为「已停止」，需手动启动。",
            config.CATEGORY_SYSTEM,
        )
    return tasks


def save_tasks(
    tasks: Sequence[GrabTask],
    path: Path | None = None,
    logger: Logger | None = None,
) -> bool:
    """把抢课任务配置写入本地 JSON 文件。

    :param tasks: 任务列表。
    :param path: 任务配置文件路径，默认 ``config.TASK_CONFIG_FILE``。
    :param logger: 日志器。
    :return: 写入成功返回 ``True``。
    """
    target = Path(path) if path is not None else config.TASK_CONFIG_FILE
    payload = {
        "formatVersion": config.TASK_CONFIG_FORMAT_VERSION,
        "savedAt": datetime.now().strftime(config.LOG_TIME_FORMAT),
        "tasks": [task.to_dict() for task in tasks],
    }
    try:
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        if logger is not None:
            logger.error(config.SOURCE_TASK, f"写入任务配置失败（{target.name}）：{exc}", config.CATEGORY_SYSTEM)
        return False
    if logger is not None:
        logger.info(config.SOURCE_TASK, f"任务配置已保存：{len(tasks)} 个任务 → {target.name}", config.CATEGORY_SYSTEM)
    return True


class GrabTaskRunner:
    """抢课任务执行器：在 asyncio 事件循环内驱动各任务的轮询协程。

    .. note::
       本类的全部方法**必须**在队列所属的 asyncio 事件循环线程中调用；
       Qt 主线程请使用 ``asyncio.run_coroutine_threadsafe`` 投递。

    :ivar _running: 任务 ID 到正在运行的 asyncio 任务的映射。
    """

    def __init__(
        self,
        client: ApiClient,
        logger: Logger,
        on_update: Callable[[GrabTask], None] | None = None,
    ) -> None:
        """初始化执行器。

        :param client: 网络客户端。
        :param logger: 日志器。
        :param on_update: 任务状态变化回调；**会在事件循环线程中被调用**，
            调用方需自行保证跨线程安全（界面侧通过 Qt 信号转发）。
        """
        self._client = client
        self._logger = logger
        self._on_update = on_update
        self._running: dict[str, asyncio.Task[None]] = {}

    # -- 状态查询 -----------------------------------------------------------
    def is_running(self, task_id: str) -> bool:
        """判断某任务当前是否正在轮询。

        :param task_id: 任务 ID。
        :return: 正在运行返回 ``True``。
        """
        handle = self._running.get(task_id)
        return handle is not None and not handle.done()

    @property
    def running_count(self) -> int:
        """返回当前正在运行的任务数量。"""
        return sum(1 for handle in self._running.values() if not handle.done())

    # -- 启动 / 停止 --------------------------------------------------------
    async def start_task(self, task: GrabTask) -> None:
        """启动单个抢课任务。

        已在运行、或未配置教学班 ID 的任务会被拒绝并输出告警。

        :param task: 目标任务对象，其 ``status`` 会被就地更新。
        :return: ``None``
        """
        if self.is_running(task.task_id):
            self._logger.warning(config.SOURCE_TASK, f"任务已在运行中：{task.display_name}", config.CATEGORY_SYSTEM)
            return
        if not task.teaching_class_id.strip():
            task.status = TaskStatus.FAILED
            task.last_message = "未配置教学班 ID，无法启动"
            self._logger.warning(config.SOURCE_TASK, f"任务缺少教学班 ID，已拒绝启动：{task.display_name}", config.CATEGORY_SYSTEM)
            self._notify(task)
            return

        task.clamp_interval(self._logger)
        task.status = TaskStatus.RUNNING
        task.attempts = 0
        task.last_message = "任务已启动"
        self._notify(task)
        self._running[task.task_id] = asyncio.create_task(
            self._run_task(task), name=f"grab-task-{task.task_id}"
        )
        self._logger.info(
            config.SOURCE_TASK,
            f"启动抢课任务：{task.display_name}（间隔 {task.poll_interval_ms}ms，{task.full_policy_text}）",
            config.CATEGORY_SYSTEM,
        )

    async def stop_task(self, task: GrabTask) -> None:
        """停止单个抢课任务。

        :param task: 目标任务对象。
        :return: ``None``
        """
        handle = self._running.pop(task.task_id, None)
        if handle is not None and not handle.done():
            handle.cancel()
            try:
                await handle
            except asyncio.CancelledError:
                pass
        task.status = TaskStatus.STOPPED
        task.last_message = "任务已停止"
        self._notify(task)
        self._logger.info(config.SOURCE_TASK, f"已停止抢课任务：{task.display_name}", config.CATEGORY_SYSTEM)

    async def stop_all(self) -> None:
        """停止全部正在运行的任务，程序退出时调用。

        :return: ``None``
        """
        if not self._running:
            return
        for handle in list(self._running.values()):
            if not handle.done():
                handle.cancel()
        for handle in list(self._running.values()):
            try:
                await handle
            except asyncio.CancelledError:
                pass
        self._running.clear()
        self._logger.info(config.SOURCE_TASK, "已停止全部抢课任务。", config.CATEGORY_SYSTEM)

    # -- 轮询实现 -----------------------------------------------------------
    async def _run_task(self, task: GrabTask) -> None:
        """单个任务的轮询主循环。

        :param task: 目标任务对象。
        :return: ``None``
        """
        interval = max(task.poll_interval_ms, config.MIN_POLL_INTERVAL_MS) / 1000.0
        try:
            while True:
                should_continue = await self._poll_once(task)
                if not should_continue:
                    return
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            task.status = TaskStatus.STOPPED
            task.last_message = "任务已停止"
            self._notify(task)
            raise
        except Exception as exc:  # noqa: BLE001 - 任务级异常统一转为失败状态
            task.status = TaskStatus.FAILED
            task.last_message = f"异常失败：{exc}"
            self._logger.error(config.SOURCE_TASK, f"任务 {task.display_name} 异常失败：{exc}", config.CATEGORY_FAILURE)
            self._notify(task)
        finally:
            self._running.pop(task.task_id, None)

    async def _poll_once(self, task: GrabTask) -> bool:
        """执行一次轮询：查询目标教学班容量，按需模拟/发起提交。

        :param task: 目标任务对象。
        :return: 需要继续轮询返回 ``True``；任务应当结束返回 ``False``。
        """
        task.attempts += 1
        try:
            response = await self._client.query_courses(
                task.teaching_class_type,
                page_number=1,
                priority=config.PRIORITY_NORMAL,
            )
        except MissingCredentialsError as exc:
            task.status = TaskStatus.STOPPED
            task.last_message = f"凭证缺失，任务已停止：{exc}"
            self._notify(task)
            return False
        except NotAuthenticatedError as exc:
            task.status = TaskStatus.STOPPED
            task.last_message = f"登录态已失效，任务已停止：{exc}"
            self._logger.warning(
                config.SOURCE_TASK,
                f"任务 {task.display_name} {task.last_message}",
                config.CATEGORY_FAILURE,
            )
            self._notify(task)
            return False
        except (ApiError, QueueFullError) as exc:
            task.last_message = f"第 {task.attempts} 次查询失败：{exc}"
            self._logger.warning(config.SOURCE_TASK, f"任务 {task.display_name} {task.last_message}", config.CATEGORY_FAILURE)
            self._notify(task)
            return True

        info = cm.extract_capacity(response, task.teaching_class_id)
        if info is None:
            task.last_message = "查询结果中未找到目标教学班（请检查教学班 ID 与类别）"
            self._notify(task)
            return True

        task.last_message = info.describe()
        self._notify(task)
        self._logger.info(
            config.SOURCE_TASK,
            f"任务 {task.display_name} 第 {task.attempts} 次检测：{info.describe()}",
            config.CATEGORY_QUERY,
        )

        if not info.has_free_seat():
            if task.stop_when_full:
                task.status = TaskStatus.STOPPED
                task.last_message = f"课程已满（{info.describe()}），按「{FULL_STOP_TEXT}」策略停止任务"
                self._notify(task)
                self._logger.info(config.SOURCE_TASK, task.last_message, config.CATEGORY_SYSTEM)
                return False
            return True

        # 检测到余量，进入选课提交环节（写接口默认被总开关禁用）
        outcome = await self._client.enroll(
            task.teaching_class_id,
            task.teaching_class_type,
            priority=config.PRIORITY_NORMAL,
            source=config.SOURCE_TASK,
        )
        task.last_message = outcome.message
        self._notify(task)

        if outcome.success:
            task.status = TaskStatus.SUCCESS
            self._notify(task)
            return False
        if not outcome.sent:
            task.status = TaskStatus.STOPPED
            task.last_message = "写接口已禁用（ENABLE_WRITE_API=False），无法提交选课，任务已自动停止；仅保留报文模板供核对"
            self._notify(task)
            self._logger.warning(config.SOURCE_TASK, task.last_message, config.CATEGORY_SYSTEM)
            return False
        return True

    def _notify(self, task: GrabTask) -> None:
        """回调通知调用方任务状态已变化。

        :param task: 发生变化的任务对象。
        :return: ``None``
        """
        if self._on_update is None:
            return
        try:
            self._on_update(task)
        except Exception as exc:  # noqa: BLE001 - 回调异常不得影响任务运行
            self._logger.warning(config.SOURCE_TASK, f"任务状态回调异常：{exc}", config.CATEGORY_SYSTEM)


__all__ = [
    "FULL_CONTINUE_TEXT",
    "FULL_STOP_TEXT",
    "STATUS_TEXT",
    "TASK_COLUMNS",
    "GrabTask",
    "GrabTaskRunner",
    "TaskStatus",
    "clamp_poll_interval",
    "load_tasks",
    "new_task_id",
    "save_tasks",
]
