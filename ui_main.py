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
from typing import Any, Callable, Coroutine

from PyQt6.QtCore import Qt, pyqtSignal, QObject
from PyQt6.QtGui import QAction, QBrush, QColor
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

import config
import course_model as cm
import task_model as tm
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
    #: 抢课任务状态更新（参数为 :class:`task_model.GrabTask`）
    taskUpdated = pyqtSignal(object)


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


class TaskDialog(QDialog):
    """抢课任务的新增 / 修改对话框。

    支持从当前课程列表一键带出课程信息，也可完全手工填写。
    """

    def __init__(
        self,
        task: tm.GrabTask | None,
        courses: list[cm.Course],
        logger: Logger,
        parent: QWidget | None = None,
    ) -> None:
        """构建对话框。

        :param task: 待修改的任务；``None`` 表示新增任务。
        :param courses: 供下拉选择的课程列表（可能为空）。
        :param logger: 日志器，用于输出轮询间隔钳位告警。
        :param parent: 父控件。
        """
        super().__init__(parent)
        self.setWindowTitle("修改抢课任务" if task is not None else "新增抢课任务")
        self.setMinimumWidth(560)
        self._logger = logger
        self._editing = task
        self._courses = list(courses)

        self.course_picker = QComboBox()
        self.course_picker.addItem("（可选）从课程列表选择…", -1)
        for index, course in enumerate(self._courses):
            label = (
                f"{course.course_name}｜{course.teacher_name}｜"
                f"{course.teaching_class_id}｜{course.capacity_text()}"
            )
            self.course_picker.addItem(label, index)

        self.course_name = QLineEdit()
        self.teacher_name = QLineEdit()
        self.course_number = QLineEdit()
        self.course_total_number = QLineEdit()
        self.teaching_class_id = QLineEdit()
        self.teaching_class_id.setPlaceholderText("例如 202620271130068000203（抢课提交的目标）")

        self.type_combo = QComboBox()
        for code, name in config.TEACHING_CLASS_TYPES.items():
            self.type_combo.addItem(f"{name}({code})", code)

        self.interval_spin = QSpinBox()
        self.interval_spin.setRange(1, 600_000)
        self.interval_spin.setSuffix(" ms")
        self.interval_spin.setValue(config.DEFAULT_POLL_INTERVAL_MS)

        self.stop_when_full = QCheckBox(tm.FULL_STOP_TEXT)
        self.stop_when_full.setChecked(True)

        form = QFormLayout()
        form.addRow("从课程列表选择", self.course_picker)
        form.addRow("课程名称", self.course_name)
        form.addRow("教师", self.teacher_name)
        form.addRow("课程号", self.course_number)
        form.addRow("课程总号", self.course_total_number)
        form.addRow("教学班ID", self.teaching_class_id)
        form.addRow("课程类别", self.type_combo)
        form.addRow(f"轮询间隔（下限 {config.MIN_POLL_INTERVAL_MS}ms）", self.interval_spin)
        form.addRow("满课后策略", self.stop_when_full)
        hint = QLabel(
            f"轮询间隔小于 {config.MIN_POLL_INTERVAL_MS}ms 会被自动钳位；"
            f"勾选「{tm.FULL_STOP_TEXT}」表示课程已满即停止本任务，"
            f"取消勾选则为「{tm.FULL_CONTINUE_TEXT}」，等待放量。"
        )
        hint.setWordWrap(True)
        form.addRow(hint)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(buttons)

        self.course_picker.currentIndexChanged.connect(self._on_pick_course)
        if task is not None:
            self._load(task)

    def _on_pick_course(self, index: int) -> None:
        """从课程列表选择后自动填充各输入框。

        :param index: 下拉框当前索引。
        :return: ``None``
        """
        data = self.course_picker.itemData(index)
        if data is None or not isinstance(data, int) or data < 0 or data >= len(self._courses):
            return
        course = self._courses[data]
        self.course_name.setText(course.course_name)
        self.teacher_name.setText(course.teacher_name)
        self.course_number.setText(course.course_number)
        self.course_total_number.setText(course.course_total_number)
        self.teaching_class_id.setText(course.teaching_class_id)
        self._select_type(course.teaching_class_type or course.course_category)

    def _select_type(self, value: str) -> None:
        """按类别代码或中文名选中类别下拉项。

        :param value: 类别代码（如 ``FANKC``）或中文名。
        :return: ``None``
        """
        if not value:
            return
        index = self.type_combo.findData(value)
        if index < 0:
            for row in range(self.type_combo.count()):
                if value in self.type_combo.itemText(row):
                    index = row
                    break
        if index >= 0:
            self.type_combo.setCurrentIndex(index)

    def _load(self, task: tm.GrabTask) -> None:
        """把待修改任务的字段填充到界面。

        :param task: 待修改的任务。
        :return: ``None``
        """
        self.course_name.setText(task.course_name)
        self.teacher_name.setText(task.teacher_name)
        self.course_number.setText(task.course_number)
        self.course_total_number.setText(task.course_total_number)
        self.teaching_class_id.setText(task.teaching_class_id)
        self._select_type(task.teaching_class_type)
        self.interval_spin.setValue(max(task.poll_interval_ms, 1))
        self.stop_when_full.setChecked(task.stop_when_full)

    def accept(self) -> None:
        """校验必填项后再关闭对话框。

        :return: ``None``
        """
        if not self.teaching_class_id.text().strip():
            QMessageBox.warning(
                self,
                "参数不完整",
                "必须填写「教学班ID」，抢课提交以此为目标定位。\n"
                "可以先在「课程查询」标签页刷新课程列表，再从下拉框选择。",
            )
            return
        super().accept()

    def result_task(self) -> tm.GrabTask:
        """生成对话框填写结果对应的任务对象。

        :return: 新增或修改后的 :class:`task_model.GrabTask`。
        """
        task = self._editing if self._editing is not None else tm.GrabTask()
        task.course_name = self.course_name.text().strip()
        task.teacher_name = self.teacher_name.text().strip()
        task.course_number = self.course_number.text().strip()
        task.course_total_number = self.course_total_number.text().strip()
        task.teaching_class_id = self.teaching_class_id.text().strip()
        task.teaching_class_type = str(self.type_combo.currentData() or "FANKC")
        task.poll_interval_ms = self.interval_spin.value()
        task.stop_when_full = self.stop_when_full.isChecked()
        task.clamp_interval(self._logger)
        if self._editing is None:
            task.status = tm.TaskStatus.STOPPED
            task.last_message = "任务已创建，尚未启动"
        return task


class TaskPanel(QWidget):
    """标签页2：抢课任务管理器。

    负责任务的展示与增删改，并把「启动 / 停止」动作交由 :class:`MainWindow`
    投递到异步事件循环执行；本面板不直接调用网络层。
    """

    #: 请求启动任务（参数为 :class:`task_model.GrabTask`）
    startTaskRequested = pyqtSignal(object)
    #: 请求停止任务（参数为 :class:`task_model.GrabTask`）
    stopTaskRequested = pyqtSignal(object)
    #: 任务列表发生变化，需要持久化（参数为任务列表）
    tasksChanged = pyqtSignal(list)

    def __init__(
        self,
        logger: Logger,
        course_provider: Callable[[], list[cm.Course]] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        """构建任务管理面板。

        :param logger: 日志器。
        :param course_provider: 返回当前课程列表的函数，用于在新增任务时提供下拉候选。
        :param parent: 父控件。
        """
        super().__init__(parent)
        self._logger = logger
        self._course_provider = course_provider
        self._tasks: list[tm.GrabTask] = []

        self.add_button = QPushButton("新增任务")
        self.edit_button = QPushButton("修改任务")
        self.delete_button = QPushButton("删除任务")
        self.start_button = QPushButton("启动任务")
        self.stop_button = QPushButton("停止任务")
        self.stop_all_button = QPushButton("全部停止")

        self.status_label = QLabel("暂无任务")

        self.table = QTableWidget(0, len(tm.TASK_COLUMNS))
        self.table.setHorizontalHeaderLabels([title for _, title in tm.TASK_COLUMNS])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.doubleClicked.connect(lambda _index: self.on_edit())

        toolbar = QHBoxLayout()
        for button in (
            self.add_button,
            self.edit_button,
            self.delete_button,
            self.start_button,
            self.stop_button,
            self.stop_all_button,
        ):
            toolbar.addWidget(button)
        toolbar.addStretch(1)

        layout = QVBoxLayout(self)
        layout.addLayout(toolbar)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.status_label)

        self.add_button.clicked.connect(self.on_add)
        self.edit_button.clicked.connect(self.on_edit)
        self.delete_button.clicked.connect(self.on_delete)
        self.start_button.clicked.connect(self.on_start)
        self.stop_button.clicked.connect(self.on_stop)
        self.stop_all_button.clicked.connect(self.on_stop_all)

    # -- 数据 ---------------------------------------------------------------
    def tasks(self) -> list[tm.GrabTask]:
        """返回当前全部任务对象（**返回内部列表本身**，供主窗口持久化）。

        :return: 任务列表。
        """
        return self._tasks

    def set_tasks(self, tasks: list[tm.GrabTask]) -> None:
        """整体替换任务列表并重建表格。

        :param tasks: 任务列表。
        :return: ``None``
        """
        self._tasks = list(tasks)
        self._rebuild()

    def update_task(self, task: tm.GrabTask) -> None:
        """刷新某个任务在表格中的展示（按任务 ID 定位行）。

        :param task: 状态已变化的任务对象。
        :return: ``None``
        """
        for row, current in enumerate(self._tasks):
            if current.task_id == task.task_id:
                self._fill_row(row, current)
                self._update_summary()
                return

    def current_task(self) -> tm.GrabTask | None:
        """返回当前选中的任务。

        :return: 选中的任务对象；未选中时返回 ``None``。
        """
        row = self.table.currentRow()
        if 0 <= row < len(self._tasks):
            return self._tasks[row]
        return None

    # -- 表格 ---------------------------------------------------------------
    def _rebuild(self) -> None:
        """重建整个任务表格。

        :return: ``None``
        """
        self.table.setRowCount(len(self._tasks))
        for row, task in enumerate(self._tasks):
            self._fill_row(row, task)
        self.table.resizeColumnsToContents()
        self._update_summary()

    def _fill_row(self, row: int, task: tm.GrabTask) -> None:
        """填充表格中的一行任务数据。

        :param row: 行号。
        :param task: 任务对象。
        :return: ``None``
        """
        for column, text in enumerate(task.row_values()):
            item = QTableWidgetItem(text)
            item.setToolTip(text)
            if tm.TASK_COLUMNS[column][0] == "status_text":
                item.setForeground(QBrush(self._status_color(task.status)))
            self.table.setItem(row, column, item)

    @staticmethod
    def _status_color(status: tm.TaskStatus) -> QColor:
        """返回任务状态对应的显示颜色。

        :param status: 任务状态。
        :return: 状态文字颜色。
        """
        if status is tm.TaskStatus.SUCCESS:
            return QColor("#1a7f37")
        if status is tm.TaskStatus.RUNNING:
            return QColor("#0b5cad")
        if status is tm.TaskStatus.FAILED:
            return QColor("#b42318")
        return QColor("#57606a")

    def _update_summary(self) -> None:
        """刷新底部状态说明。

        :return: ``None``
        """
        if not self._tasks:
            self.status_label.setText("暂无任务。手动启动的任务不会在程序重启后自动运行。")
            return
        running = sum(1 for task in self._tasks if task.status is tm.TaskStatus.RUNNING)
        self.status_label.setText(
            f"共 {len(self._tasks)} 个任务，运行中 {running} 个；"
            f"网络请求统一经全局限流队列（间隔 {config.REQUEST_INTERVAL_MS}ms，上限 {config.MAX_QUEUE_SIZE} 条）。"
        )

    # -- 动作 ---------------------------------------------------------------
    def on_add(self) -> None:
        """新增任务。

        :return: ``None``
        """
        dialog = TaskDialog(None, self._course_candidates(), self._logger, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        task = dialog.result_task()
        self._tasks.append(task)
        self._rebuild()
        self.tasksChanged.emit(self._tasks)
        self._logger.info(config.SOURCE_TASK, f"已新增抢课任务：{task.display_name}", config.CATEGORY_SYSTEM)

    def on_edit(self) -> None:
        """修改选中的任务。

        :return: ``None``
        """
        task = self.current_task()
        if task is None:
            QMessageBox.information(self, "提示", "请先选中要修改的任务。")
            return
        dialog = TaskDialog(task, self._course_candidates(), self._logger, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        dialog.result_task()
        self._rebuild()
        self.tasksChanged.emit(self._tasks)
        self._logger.info(config.SOURCE_TASK, f"已修改抢课任务：{task.display_name}", config.CATEGORY_SYSTEM)

    def on_delete(self) -> None:
        """删除选中的任务（运行中的任务会先被请求停止）。

        :return: ``None``
        """
        task = self.current_task()
        if task is None:
            QMessageBox.information(self, "提示", "请先选中要删除的任务。")
            return
        answer = QMessageBox.question(self, "确认删除", f"确定删除任务「{task.display_name}」吗？")
        if answer != QMessageBox.StandardButton.Yes:
            return
        if task.status is tm.TaskStatus.RUNNING:
            self.stopTaskRequested.emit(task)
        self._tasks.remove(task)
        self._rebuild()
        self.tasksChanged.emit(self._tasks)
        self._logger.info(config.SOURCE_TASK, f"已删除抢课任务：{task.display_name}", config.CATEGORY_SYSTEM)

    def on_start(self) -> None:
        """启动选中的任务。

        :return: ``None``
        """
        task = self.current_task()
        if task is None:
            QMessageBox.information(self, "提示", "请先选中要启动的任务。")
            return
        if not task.teaching_class_id.strip():
            QMessageBox.warning(self, "参数不完整", "该任务没有教学班 ID，无法启动。")
            return
        self.startTaskRequested.emit(task)

    def on_stop(self) -> None:
        """停止选中的任务。

        :return: ``None``
        """
        task = self.current_task()
        if task is None:
            QMessageBox.information(self, "提示", "请先选中要停止的任务。")
            return
        self.stopTaskRequested.emit(task)

    def on_stop_all(self) -> None:
        """停止全部任务。

        :return: ``None``
        """
        for task in list(self._tasks):
            if task.status is tm.TaskStatus.RUNNING:
                self.stopTaskRequested.emit(task)

    def _course_candidates(self) -> list[cm.Course]:
        """获取课程下拉候选。

        :return: 当前课程列表；未提供 provider 时返回空列表。
        """
        if self._course_provider is None:
            return []
        try:
            return self._course_provider()
        except Exception as exc:  # noqa: BLE001 - 候选列表失败不影响新增任务
            self._logger.warning(config.SOURCE_TASK, f"读取课程候选失败：{exc}", config.CATEGORY_SYSTEM)
            return []


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
        self._runner = tm.GrabTaskRunner(client, logger, on_update=self._on_task_update)

        self.setWindowTitle(f"{config.APP_NAME} v{config.APP_VERSION}（求证草稿版）")
        self.resize(1280, 820)

        self.tabs = QTabWidget()
        self.credential_panel = CredentialPanel(credentials, logger)
        self.course_panel = CourseQueryPanel(logger)
        self.task_panel = TaskPanel(logger, course_provider=self._course_candidates)
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
        self.load_persisted_tasks()

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
        self.bridge.taskUpdated.connect(self.task_panel.update_task)
        self.task_panel.startTaskRequested.connect(self.on_start_task)
        self.task_panel.stopTaskRequested.connect(self.on_stop_task)
        self.task_panel.tasksChanged.connect(self.persist_tasks)

    def _course_candidates(self) -> list[cm.Course]:
        """返回课程查询面板中当前全部课程，供任务对话框下拉选择。

        :return: 课程列表。
        """
        return list(self.course_panel._all_courses)

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

    # -- 抢课任务 -----------------------------------------------------------
    def load_persisted_tasks(self) -> None:
        """启动时恢复本地保存的抢课任务配置。

        恢复后的任务状态统一为「已停止」，不会自动运行（需求 §七.6）。

        :return: ``None``
        """
        self.task_panel.set_tasks(tm.load_tasks(logger=self._logger))

    def persist_tasks(self, tasks: list[tm.GrabTask]) -> None:
        """把任务配置写入本地 JSON 文件。

        :param tasks: 任务列表。
        :return: ``None``
        """
        tm.save_tasks(tasks, logger=self._logger)

    def on_start_task(self, task: tm.GrabTask) -> None:
        """把「启动任务」动作投递到异步事件循环。

        :param task: 目标任务。
        :return: ``None``
        """
        self._run_async(self._runner.start_task(task))

    def on_stop_task(self, task: tm.GrabTask) -> None:
        """把「停止任务」动作投递到异步事件循环。

        :param task: 目标任务。
        :return: ``None``
        """
        self._run_async(self._runner.stop_task(task))

    def _on_task_update(self, task: tm.GrabTask) -> None:
        """任务状态变化回调（**运行在 asyncio 线程**）。

        通过 Qt 信号转发到主线程刷新界面，并即时持久化最新状态。

        :param task: 发生变化的任务。
        :return: ``None``
        """
        self.bridge.taskUpdated.emit(task)

    def closeEvent(self, event: Any) -> None:  # noqa: N802 - Qt 约定的驼峰命名
        """窗口关闭时保存任务配置并停止全部后台任务。

        :param event: Qt 关闭事件。
        :return: ``None``
        """
        self.persist_tasks(self.task_panel.tasks())
        if self._loop is not None and not self._loop.is_closed():
            try:
                future = asyncio.run_coroutine_threadsafe(self._runner.stop_all(), self._loop)
                future.result(timeout=3)
            except Exception as exc:  # noqa: BLE001 - 退出流程不得因清理失败而卡死
                self._logger.warning(config.SOURCE_SYSTEM, f"停止后台任务时出现异常：{exc}", config.CATEGORY_SYSTEM)
        self._logger.info(config.SOURCE_SYSTEM, "程序正在退出，任务配置已保存。", config.CATEGORY_SYSTEM)
        event.accept()

    def on_log_record(self, record: LogRecord) -> None:
        """接收后台线程投递的日志记录（当前阶段仅占位，日志面板在后续阶段实现）。

        :param record: 日志记录。
        :return: ``None``
        """
        _ = record
