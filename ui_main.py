# -*- coding: utf-8 -*-
"""PyQt6 界面主窗口：标签页布局、信号槽与跨线程异步调度。

界面结构（对应需求文档第三节）：
    - 标签页1「课程查询」：凭证输入区 + 课程表格 + 列显示开关 + 筛选 + 刷新查询；
    - 标签页2「抢课任务管理器」：任务增删改、轮询配置、任务状态（后续阶段实现）；
    - 标签页3「日志面板」：日志文本 + 分类过滤（后续阶段实现）。

线程模型：
    Qt 主线程只做界面渲染；所有网络请求通过 ``asyncio.run_coroutine_threadsafe``
    投递到独立的事件循环线程执行，结果再通过 :class:`UiBridge` 的 Qt 信号
    投递回主线程刷新界面——**绝不在 asyncio 线程里直接操作控件**。

职责边界：
    本模块不构造任何 http 报文、不直接调用 aiohttp，全部网络行为委托给
    :class:`api_client.ApiClient`。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import webbrowser
from typing import Any, Coroutine

from PyQt6.QtCore import Qt, pyqtSignal, QObject
from PyQt6.QtGui import QAction
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

import config
import course_model as cm
from api_client import ApiClient, ApiError, MissingCredentialsError
from auth_model import Credentials
from logger_util import LogRecord, Logger
from request_queue import QueueFullError


class UiBridge(QObject):
    """跨线程信号桥。

    后台 asyncio 线程调用 ``emit`` 是线程安全的，Qt 会自动把信号排队到主线程执行。
    """

    #: 一条日志记录（参数为 :class:`logger_util.LogRecord`）
    logRecord = pyqtSignal(object)
    #: 课程列表加载成功（参数为课程列表、说明文案）
    coursesLoaded = pyqtSignal(list, str)
    #: 课程加载失败（参数为错误说明）
    coursesFailed = pyqtSignal(str)


class CredentialPanel(QGroupBox):
    """身份凭证输入区。

    含 ``studentCode`` / ``electiveBatchCode`` / ``cookie``（多行粘贴）/ ``token``
    四个输入控件；输入内容实时写回共享的 :class:`auth_model.Credentials` 对象，
    供网络层读取。凭证**不会写入任何本地文件**。
    """

    def __init__(self, credentials: Credentials, logger: Logger, parent: QWidget | None = None) -> None:
        """构建凭证输入区。

        :param credentials: 与网络层共享的凭证对象，界面上修改会实时同步到它。
        :param logger: 日志器，用于输出凭证校验结果。
        :param parent: 父控件。
        """
        super().__init__("身份凭证（请从浏览器登录后复制粘贴，程序不会保存）", parent)
        self._credentials = credentials
        self._logger = logger

        self.student_code = QLineEdit()
        self.student_code.setPlaceholderText("studentCode（学号），例如 2026xxxxxx")
        self.elective_batch_code = QLineEdit()
        self.elective_batch_code.setPlaceholderText("electiveBatchCode（选课批次编码）")
        self.token = QLineEdit()
        self.token.setPlaceholderText("token（浏览器 sessionStorage.token）")
        self.cookie = QPlainTextEdit()
        self.cookie.setPlaceholderText("cookie（可整段多行粘贴，程序会自动拼接为 ; 分隔）")
        self.cookie.setFixedHeight(70)

        self.validate_button = QPushButton("校验凭证")
        self.clear_button = QPushButton("清空凭证")

        grid = QHBoxLayout()
        left = QVBoxLayout()
        left.addWidget(QLabel("studentCode"))
        left.addWidget(self.student_code)
        left.addWidget(QLabel("electiveBatchCode"))
        left.addWidget(self.elective_batch_code)
        right = QVBoxLayout()
        right.addWidget(QLabel("token"))
        right.addWidget(self.token)
        right.addWidget(QLabel("cookie"))
        right.addWidget(self.cookie)
        grid.addLayout(left, 1)
        grid.addLayout(right, 2)

        buttons = QHBoxLayout()
        buttons.addWidget(self.validate_button)
        buttons.addWidget(self.clear_button)
        buttons.addStretch(1)

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        top.addLayout(grid, 1)
        layout.addLayout(top)
        layout.addLayout(buttons)

        self._connect()

    def _connect(self) -> None:
        """连接各输入控件的变更信号，实现「界面改动实时写回凭证对象」。"""
        self.student_code.textChanged.connect(self.sync_to_model)
        self.elective_batch_code.textChanged.connect(self.sync_to_model)
        self.token.textChanged.connect(self.sync_to_model)
        self.cookie.textChanged.connect(self.sync_to_model)
        self.validate_button.clicked.connect(self.on_validate)
        self.clear_button.clicked.connect(self.on_clear)

    def sync_to_model(self) -> None:
        """把界面输入内容写回共享的凭证对象。

        :return: ``None``
        """
        self._credentials.student_code = self.student_code.text()
        self._credentials.elective_batch_code = self.elective_batch_code.text()
        self._credentials.token = self.token.text()
        self._credentials.cookie = self.cookie.toPlainText()

    def on_validate(self) -> None:
        """响应「校验凭证」按钮：输出脱敏后的校验结果。

        :return: ``None``
        """
        self.sync_to_model()
        ok, message = self._credentials.validate()
        if ok:
            self._logger.info(config.SOURCE_SYSTEM, f"凭证校验通过：{self._credentials.masked()}", config.CATEGORY_SYSTEM)
        else:
            self._logger.warning(config.SOURCE_SYSTEM, message, config.CATEGORY_SYSTEM)

    def on_clear(self) -> None:
        """响应「清空凭证」按钮：清空界面与内存中的凭证。

        :return: ``None``
        """
        self.student_code.clear()
        self.elective_batch_code.clear()
        self.token.clear()
        self.cookie.clear()
        self._credentials.clear()
        self._logger.info(config.SOURCE_SYSTEM, "凭证已清空。", config.CATEGORY_SYSTEM)


class CourseQueryPanel(QWidget):
    """标签页1：课程查询面板。

    负责课程表格展示、列显示开关、内存筛选，以及发出刷新/跳转请求；
    具体网络调用由 :class:`MainWindow` 完成。
    """

    #: 请求刷新课程列表（参数为待查询的课程类别代码列表）
    refreshRequested = pyqtSignal(list)
    #: 请求用系统默认浏览器打开选课网页
    openSiteRequested = pyqtSignal()

    def __init__(self, logger: Logger, parent: QWidget | None = None) -> None:
        """构建课程查询面板。

        :param logger: 日志器，用于输出界面操作相关日志。
        :param parent: 父控件。
        """
        super().__init__(parent)
        self._logger = logger
        self._all_courses: list[cm.Course] = []
        self._column_actions: list[QAction] = []

        self.refresh_button = QPushButton("刷新查询")
        self.favorite_button = QPushButton("收藏")
        self.favorite_button.setEnabled(False)
        self.favorite_button.setToolTip("收藏接口尚未逆向（等待浏览器抓包样本），暂不可用。")
        self.open_site_button = QPushButton("跳转选课网页")

        self.keyword_edit = QLineEdit()
        self.keyword_edit.setPlaceholderText("课程名 / 教师 / 课程号 模糊搜索")
        self.category_combo = QComboBox()
        self.category_combo.addItem("全部类别", "")
        for code, name in config.TEACHING_CLASS_TYPES.items():
            self.category_combo.addItem(f"{name}({code})", code)
        self.mooc_combo = QComboBox()
        self.mooc_combo.addItem("MOOC 全部", "")
        self.mooc_combo.addItem("仅 MOOC", "是")
        self.mooc_combo.addItem("非 MOOC", "否")
        self.available_check = QCheckBox("只看有余量")

        self.column_button = QToolButton()
        self.column_button.setText("显示列")
        self.column_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.column_button.setMenu(self._build_column_menu())

        self.status_label = QLabel("就绪")

        self.table = QTableWidget(0, len(cm.TABLE_COLUMNS))
        self.table.setHorizontalHeaderLabels([title for _, title in cm.TABLE_COLUMNS])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setStretchLastSection(True)

        self._build_layout()
        self._connect()

    def _build_layout(self) -> None:
        """组装面板布局。

        :return: ``None``
        """
        toolbar = QHBoxLayout()
        toolbar.addWidget(self.refresh_button)
        toolbar.addWidget(self.column_button)
        toolbar.addWidget(self.open_site_button)
        toolbar.addWidget(self.favorite_button)
        toolbar.addStretch(1)

        filters = QHBoxLayout()
        filters.addWidget(QLabel("筛选："))
        filters.addWidget(self.keyword_edit, 2)
        filters.addWidget(self.category_combo, 1)
        filters.addWidget(self.mooc_combo, 1)
        filters.addWidget(self.available_check)

        layout = QVBoxLayout(self)
        layout.addLayout(toolbar)
        layout.addLayout(filters)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.status_label)

    def _build_column_menu(self) -> QMenu:
        """创建「显示列」勾选菜单。

        :return: 含各列勾选项的菜单。
        """
        menu = QMenu(self)
        for index, (_, title) in enumerate(cm.TABLE_COLUMNS):
            action = QAction(title, self)
            action.setCheckable(True)
            action.setChecked(True)
            action.toggled.connect(lambda checked, col=index: self.table.setColumnHidden(col, not checked))
            menu.addAction(action)
            self._column_actions.append(action)
        return menu

    def _connect(self) -> None:
        """连接控件信号。"""
        self.refresh_button.clicked.connect(self._on_refresh_clicked)
        self.open_site_button.clicked.connect(self.openSiteRequested.emit)
        self.keyword_edit.textChanged.connect(self.apply_filter)
        self.category_combo.currentIndexChanged.connect(self.apply_filter)
        self.mooc_combo.currentIndexChanged.connect(self.apply_filter)
        self.available_check.toggled.connect(self.apply_filter)

    # -- 对外接口 -----------------------------------------------------------
    def set_courses(self, courses: list[cm.Course], note: str = "") -> None:
        """写入课程数据并刷新表格。

        :param courses: 课程列表。
        :param note: 展示在状态栏的说明文字（如缓存来源、加载时间）。
        :return: ``None``
        """
        self._all_courses = list(courses)
        self.apply_filter()
        if note:
            self.status_label.setText(note)

    def set_busy(self, busy: bool, note: str = "") -> None:
        """切换查询中的忙碌状态。

        :param busy: ``True`` 表示正在查询，会禁用刷新按钮。
        :param note: 状态栏文案。
        :return: ``None``
        """
        self.refresh_button.setEnabled(not busy)
        self.refresh_button.setText("查询中…" if busy else "刷新查询")
        if note:
            self.status_label.setText(note)

    def selected_courses(self) -> list[cm.Course]:
        """返回表格中当前选中的课程。

        :return: 选中行对应的课程列表。
        """
        rows = sorted({index.row() for index in self.table.selectedIndexes()})
        filtered = self._filtered_courses()
        return [filtered[row] for row in rows if 0 <= row < len(filtered)]

    def checked_categories(self) -> list[str]:
        """返回筛选下拉框中选定的课程类别。

        :return: 类别代码列表；选择「全部类别」时返回全部 7 个类别。
        """
        code = self.category_combo.currentData()
        if code:
            return [str(code)]
        return list(config.TEACHING_CLASS_TYPES.keys())

    def apply_filter(self) -> None:
        """按当前筛选条件重建表格内容。

        :return: ``None``
        """
        courses = self._filtered_courses()
        self.table.setRowCount(len(courses))
        for row, course in enumerate(courses):
            for column, text in enumerate(course.row_values()):
                item = QTableWidgetItem(text)
                item.setToolTip(text)
                self.table.setItem(row, column, item)
        self.table.resizeColumnsToContents()
        total = len(self._all_courses)
        if total:
            self.status_label.setText(f"共 {total} 条课程，当前显示 {len(courses)} 条")

    def _filtered_courses(self) -> list[cm.Course]:
        """按界面筛选控件过滤内存中的课程。

        :return: 过滤后的课程列表。
        """
        return cm.filter_courses(
            self._all_courses,
            keyword=self.keyword_edit.text(),
            category=str(self.category_combo.currentData() or ""),
            mooc=str(self.mooc_combo.currentData() or ""),
            only_available=self.available_check.isChecked(),
        )

    def _on_refresh_clicked(self) -> None:
        """响应「刷新查询」按钮，发出高优先级刷新请求。"""
        self.refreshRequested.emit(self.checked_categories())


class MainWindow(QMainWindow):
    """程序主窗口：组织三个标签页，并负责把界面动作投递到异步事件循环。

    :ivar _loop: 后台 asyncio 事件循环。
    :ivar _client: 网络客户端。
    """

    def __init__(
        self,
        client: ApiClient,
        logger: Logger,
        loop: asyncio.AbstractEventLoop | None,
        credentials: Credentials,
        bridge: UiBridge | None = None,
        parent: QWidget | None = None,
    ) -> None:
        """构建主窗口。

        :param client: 网络客户端实例。
        :param logger: 日志器实例。
        :param loop: 后台 asyncio 事件循环；``None`` 表示异步运行时尚未启动。
        :param credentials: 与凭证输入区共享的凭证对象。
        :param bridge: 跨线程信号桥，默认新建一个。
        :param parent: 父控件。
        """
        super().__init__(parent)
        self._client = client
        self._logger = logger
        self._loop = loop
        self._credentials = credentials
        self.bridge = bridge if bridge is not None else UiBridge()

        self.setWindowTitle(f"{config.APP_NAME} v{config.APP_VERSION}（求证草稿版）")
        self.resize(1280, 820)

        self.tabs = QTabWidget()
        self.credential_panel = CredentialPanel(credentials, logger)
        self.course_panel = CourseQueryPanel(logger)
        self.task_panel = self._build_placeholder_tab("抢课任务管理器（后续阶段实现）")
        self.log_panel = self._build_placeholder_tab("日志面板（后续阶段实现）")

        course_tab = QWidget()
        course_layout = QVBoxLayout(course_tab)
        course_layout.addWidget(self.credential_panel)
        course_layout.addWidget(self.course_panel, 1)

        self.tabs.addTab(course_tab, "课程查询")
        self.tabs.addTab(self.task_panel, "抢课任务管理器")
        self.tabs.addTab(self.log_panel, "日志面板")
        self.setCentralWidget(self.tabs)

        self._connect()
        self.load_cached_courses()

    @staticmethod
    def _build_placeholder_tab(text: str) -> QWidget:
        """创建一个占位标签页。

        :param text: 占位说明文字。
        :return: 占位 QWidget。
        """
        widget = QWidget()
        layout = QVBoxLayout(widget)
        label = QLabel(text)
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(label)
        return widget

    def _connect(self) -> None:
        """连接界面信号与后台任务。"""
        self.course_panel.refreshRequested.connect(self.on_refresh_courses)
        self.course_panel.openSiteRequested.connect(self.on_open_site)
        self.bridge.coursesLoaded.connect(self.course_panel.set_courses)
        self.bridge.coursesFailed.connect(self._on_courses_failed)

    # -- 异步调度 -----------------------------------------------------------
    def _run_async(self, coro: Coroutine[Any, Any, Any]) -> None:
        """把协程投递到后台事件循环执行。

        事件循环不可用时关闭协程并输出告警，避免出现「协程从未被 await」的隐患。

        :param coro: 待执行的协程对象。
        :return: ``None``
        """
        if self._loop is None or self._loop.is_closed():
            coro.close()
            self._logger.warning(config.SOURCE_SYSTEM, "异步运行时尚未启动，操作被忽略。", config.CATEGORY_SYSTEM)
            return
        asyncio.run_coroutine_threadsafe(coro, self._loop)

    # -- 课程查询 -----------------------------------------------------------
    def load_cached_courses(self) -> None:
        """启动时优先展示本地缓存课程列表（需求 §七.7）。

        :return: ``None``
        """
        courses = cm.load_courses(logger=self._logger)
        if courses:
            saved_at = cm.cache_saved_at()
            self.course_panel.set_courses(courses, f"已加载本地缓存 {len(courses)} 条（保存于 {saved_at}），点「刷新查询」获取最新数据")
        else:
            self.course_panel.set_courses([], "暂无本地缓存，请点击「刷新查询」拉取课程列表")

    def on_refresh_courses(self, categories: list[str]) -> None:
        """响应手动刷新：以最高优先级拉取指定类别的课程列表。

        手动操作优先级高于抢课轮询后台请求（需求 §三.1）。

        :param categories: 待查询的课程类别代码列表。
        :return: ``None``
        """
        if not categories:
            return
        self.course_panel.set_busy(True, "正在查询课程列表…")
        self._run_async(self._fetch_courses(categories))

    async def _fetch_courses(self, categories: list[str]) -> None:
        """依次拉取各课程类别的课程列表并汇总更新界面。

        每个类别最多翻 ``config.QUERY_MAX_PAGES`` 页；单类别失败不影响其他类别。

        :param categories: 课程类别代码列表。
        :return: ``None``
        """
        collected: list[cm.Course] = []
        succeeded: list[str] = []
        failures: list[str] = []

        for category in categories:
            label = config.TEACHING_CLASS_TYPES.get(category, category)
            got_any = False
            for page in range(1, config.QUERY_MAX_PAGES + 1):
                try:
                    response = await self._client.query_courses(
                        category,
                        page_number=page,
                        priority=config.PRIORITY_HIGH,
                    )
                except MissingCredentialsError as exc:
                    self.bridge.coursesFailed.emit(f"凭证缺失，已拒绝发起请求：{exc}")
                    return
                except (ApiError, QueueFullError) as exc:
                    failures.append(f"{label}：{exc}")
                    self._logger.warning(config.SOURCE_COURSE, f"{label} 第 {page} 页查询失败：{exc}", config.CATEGORY_QUERY)
                    break

                page_courses = cm.parse_courses(response, category)
                if not page_courses:
                    break
                collected.extend(page_courses)
                got_any = True
                if len(page_courses) < config.QUERY_PAGE_SIZE:
                    break
            if got_any:
                succeeded.append(label)

        if not collected:
            detail = "；".join(failures) if failures else "接口未返回任何课程数据"
            self.bridge.coursesFailed.emit(detail)
            return

        # 只有拉取成功才覆盖本地缓存（需求 §七.7）
        cm.save_courses(collected, logger=self._logger)
        note = f"已刷新 {len(collected)} 条课程（类别：{'、'.join(succeeded)}）"
        if failures:
            note += f"；部分类别失败：{'；'.join(failures)}"
        self.bridge.coursesLoaded.emit(collected, note)

    def _on_courses_failed(self, message: str) -> None:
        """课程加载失败时恢复界面状态。

        :param message: 失败说明。
        :return: ``None``
        """
        self.course_panel.set_busy(False, f"课程查询失败：{message}")
        self._logger.error(config.SOURCE_COURSE, f"课程查询失败：{message}", config.CATEGORY_QUERY)

    # -- 其它动作 -----------------------------------------------------------
    def on_open_site(self) -> None:
        """用系统默认浏览器打开选课网页。

        :return: ``None``
        """
        webbrowser.open(config.SITE_HOME_URL)
        self._logger.info(config.SOURCE_SYSTEM, f"已在默认浏览器打开：{config.SITE_HOME_URL}", config.CATEGORY_SYSTEM)

    def on_log_record(self, record: LogRecord) -> None:
        """接收后台线程投递的日志记录（当前阶段仅占位，日志面板在后续阶段实现）。

        :param record: 日志记录。
        :return: ``None``
        """
        _ = record
