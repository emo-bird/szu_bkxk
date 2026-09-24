# -*- coding: utf-8 -*-
"""日志工具模块：UI 面板 + 本地文件双写，支持按类型过滤。

需求要点（对应需求文档第三节标签页3）：
    - 每条日志格式为 ``[时间戳] [来源模块] 日志内容``；
    - 日志同时持久化写入本地日志文件（按天切分，位于 ``config.LOG_DIR``）；
    - 界面提供日志过滤器，勾选控制界面展示哪些类型的日志
      （抢课成功 / 抢课失败 / 查询信息 / 系统信息 / 队列调度）；
    - 过滤器**只影响界面展示**，日志文件始终记录全部分类，便于事后排查。

设计说明：
    - :class:`Logger` 线程安全，可在 Qt 主线程与 asyncio 事件循环线程中同时调用；
    - UI 回调以**信号**方式在 UI 侧接收，由使用者保证跨线程安全；
    - 文件 IO 异常不允许导致程序崩溃，仅降级为 stderr 提示。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import sys
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

import config


@dataclass(frozen=True)
class LogRecord:
    """单条日志记录。

    :ivar timestamp: 记录产生时间。
    :ivar source: 来源模块，取值见 ``config.SOURCE_*``。
    :ivar category: 日志分类，取值见 ``config.CATEGORY_*``，用于界面过滤。
    :ivar level: 日志等级，取值见 ``config.LEVEL_*``。
    :ivar message: 日志正文。
    """

    timestamp: datetime
    source: str
    category: str
    level: str
    message: str

    def formatted(self) -> str:
        """按需求约定格式渲染为一行文本。

        格式为 ``[时间戳] [来源模块] 日志内容``；当等级为告警/错误时，
        在正文前补充 ``[告警]``/``[错误]`` 前缀，不改变既有格式结构。

        :return: 可直接写入日志文件或显示到日志面板的单行字符串。
        """
        prefix = ""
        if self.level == config.LEVEL_WARNING:
            prefix = "[告警] "
        elif self.level == config.LEVEL_ERROR:
            prefix = "[错误] "
        stamp = self.timestamp.strftime(config.LOG_TIME_FORMAT)
        return f"[{stamp}] [{self.source}] {prefix}{self.message}"


class LogFilter:
    """日志界面过滤器。

    维护「允许展示的分类集合」与「允许展示的来源模块集合」，用于决定某条日志
    是否推送到 UI 日志面板。

    :ivar _categories: 当前允许展示的分类集合。
    :ivar _sources: 当前允许展示的来源模块集合。
    """

    def __init__(
        self,
        categories: Iterable[str] | None = None,
        sources: Iterable[str] | None = None,
    ) -> None:
        """初始化过滤器。

        :param categories: 初始允许展示的分类集合，``None`` 表示全部允许。
        :param sources: 初始允许展示的来源模块集合，``None`` 表示全部允许。
        """
        self._categories: set[str] = set(categories) if categories is not None else set(config.LOG_CATEGORIES)
        self._sources: set[str] = set(sources) if sources is not None else set(config.LOG_SOURCES)

    def accept(self, record: LogRecord) -> bool:
        """判断某条日志是否允许在界面展示。

        :param record: 待判断的日志记录。
        :return: 允许展示返回 ``True``。
        """
        return record.category in self._categories and record.source in self._sources

    def set_category_enabled(self, category: str, enabled: bool) -> None:
        """勾选/取消勾选某个日志分类。

        :param category: 日志分类名。
        :param enabled: ``True`` 展示，``False`` 隐藏。
        :return: ``None``
        """
        if enabled:
            self._categories.add(category)
        else:
            self._categories.discard(category)

    def set_source_enabled(self, source: str, enabled: bool) -> None:
        """勾选/取消勾选某个来源模块。

        :param source: 来源模块名。
        :param enabled: ``True`` 展示，``False`` 隐藏。
        :return: ``None``
        """
        if enabled:
            self._sources.add(source)
        else:
            self._sources.discard(source)

    def is_category_enabled(self, category: str) -> bool:
        """查询某个分类当前是否允许展示。

        :param category: 日志分类名。
        :return: 允许展示返回 ``True``。
        """
        return category in self._categories

    @property
    def categories(self) -> set[str]:
        """返回当前允许展示的分类集合副本。"""
        return set(self._categories)


class Logger:
    """日志分发器：本地文件全量落盘 + 按过滤规则推送到 UI 面板。

    :ivar _log_file: 当前打开的日志文件句柄，未打开时为 ``None``。
    :ivar _log_date: 当前日志文件对应的日期字符串，用于按天切分。
    """

    def __init__(
        self,
        log_dir: Path | None = None,
        ui_sink: Callable[[LogRecord], None] | None = None,
    ) -> None:
        """初始化日志器。

        :param log_dir: 日志目录，默认取 ``config.LOG_DIR``。
        :param ui_sink: UI 回调，接收通过过滤的日志记录；``None`` 表示暂不推送。
        """
        self._log_dir: Path = Path(log_dir) if log_dir is not None else config.LOG_DIR
        self._ui_sink = ui_sink
        self._filter = LogFilter()
        self._lock = threading.Lock()
        self._log_file = None
        self._log_date: str = ""
        self._file_enabled: bool = True

    # -- 配置 ---------------------------------------------------------------
    @property
    def filter(self) -> LogFilter:
        """返回界面过滤器对象，供 UI 勾选框读写。"""
        return self._filter

    def set_ui_sink(self, ui_sink: Callable[[LogRecord], None] | None) -> None:
        """设置或更换 UI 日志回调。

        :param ui_sink: 接收日志记录的回调函数；``None`` 表示停止推送。
        :return: ``None``
        """
        self._ui_sink = ui_sink

    @property
    def log_file_path(self) -> Path:
        """返回当前日志文件的完整路径（按当天日期命名）。"""
        stamp = datetime.now().strftime(config.LOG_FILE_DATE_FORMAT)
        return self._log_dir / f"{config.LOG_FILE_PREFIX}_{stamp}{config.LOG_FILE_SUFFIX}"

    # -- 记录 ---------------------------------------------------------------
    def log(
        self,
        source: str,
        message: str,
        category: str = config.CATEGORY_SYSTEM,
        level: str = config.LEVEL_INFO,
    ) -> LogRecord:
        """记录一条日志：先落盘，再推送到 UI（过滤由日志面板负责展示与否）。

        :param source: 来源模块，建议使用 ``config.SOURCE_*`` 常量。
        :param message: 日志正文。
        :param category: 日志分类，用于界面过滤，默认「系统信息」。
        :param level: 日志等级，取值 ``config.LEVEL_*``。
        :return: 生成的 :class:`LogRecord` 对象。
        """
        record = LogRecord(
            timestamp=datetime.now(),
            source=source,
            category=category,
            level=level,
            message=message,
        )
        with self._lock:
            self._write_to_file(record)
            sink = self._ui_sink
        # 分类过滤**只作用于界面展示**：这里一律推送给界面，由日志面板按
        # ``self._filter`` 决定是否显示。若在推送前就挡掉，面板拿不到被过滤的条目，
        # 勾选/取消勾选时就无法重绘历史内容（这正是原先「筛选勾了没反应」的原因）。
        # 日志文件始终记录全部分类。
        if sink is not None:
            try:
                sink(record)
            except Exception as exc:  # noqa: BLE001 - UI 回调异常不能影响业务
                print(f"[logger] UI 日志回调异常：{exc}", file=sys.stderr)
        return record

    def info(
        self,
        source: str,
        message: str,
        category: str = config.CATEGORY_SYSTEM,
    ) -> LogRecord:
        """记录一条普通信息日志。

        :param source: 来源模块。
        :param message: 日志正文。
        :param category: 日志分类。
        :return: 生成的 :class:`LogRecord` 对象。
        """
        return self.log(source, message, category, config.LEVEL_INFO)

    def warning(
        self,
        source: str,
        message: str,
        category: str = config.CATEGORY_SYSTEM,
    ) -> LogRecord:
        """记录一条告警日志。

        :param source: 来源模块。
        :param message: 日志正文。
        :param category: 日志分类。
        :return: 生成的 :class:`LogRecord` 对象。
        """
        return self.log(source, message, category, config.LEVEL_WARNING)

    def error(
        self,
        source: str,
        message: str,
        category: str = config.CATEGORY_SYSTEM,
    ) -> LogRecord:
        """记录一条错误日志。

        :param source: 来源模块。
        :param message: 日志正文。
        :param category: 日志分类。
        :return: 生成的 :class:`LogRecord` 对象。
        """
        return self.log(source, message, category, config.LEVEL_ERROR)

    def close(self) -> None:
        """关闭日志文件句柄，程序退出时调用。

        :return: ``None``
        """
        with self._lock:
            self._close_file()

    # -- 内部实现 -----------------------------------------------------------
    def _close_file(self) -> None:
        """关闭底层文件句柄（调用方需自行保证加锁）。"""
        if self._log_file is not None:
            try:
                self._log_file.close()
            except OSError as exc:
                print(f"[logger] 关闭日志文件失败：{exc}", file=sys.stderr)
            finally:
                self._log_file = None

    def _ensure_file(self) -> bool:
        """确保当前日期的日志文件处于打开状态。

        跨天时自动切换到新文件；目录不存在会自动创建。

        :return: 文件可用返回 ``True``；不可用时返回 ``False`` 并降级为 stderr 输出。
        """
        if not self._file_enabled:
            return False
        today = datetime.now().strftime(config.LOG_FILE_DATE_FORMAT)
        if self._log_file is not None and self._log_date == today:
            return True
        self._close_file()
        try:
            self._log_dir.mkdir(parents=True, exist_ok=True)
            self._log_file = open(self.log_file_path, "a", encoding="utf-8")  # noqa: SIM115 - 长期持有句柄
            self._log_date = today
            return True
        except OSError as exc:
            self._file_enabled = False
            print(f"[logger] 日志文件不可写，已降级为仅控制台输出：{exc}", file=sys.stderr)
            return False

    def _write_to_file(self, record: LogRecord) -> None:
        """把日志写入本地文件（调用方需自行保证加锁）。

        :param record: 待写入的日志记录。
        :return: ``None``
        """
        if not self._ensure_file():
            print(record.formatted(), file=sys.stderr)
            return
        try:
            self._log_file.write(record.formatted() + "\n")
            self._log_file.flush()
        except OSError as exc:
            self._file_enabled = False
            self._close_file()
            print(f"[logger] 写日志文件失败：{exc}", file=sys.stderr)
            print(record.formatted(), file=sys.stderr)
