# -*- coding: utf-8 -*-
"""课程数据模型：接口响应解析、内存筛选与本地缓存持久化。

职责：
    - 把课程查询接口返回的原始 JSON 解析为 :class:`Course` 列表；
    - 提供界面筛选（课程名模糊搜索、类别、是否 MOOC、只看有余量）所需的过滤函数；
    - 课程列表的本地 JSON 缓存读写（**只有接口拉取成功才允许覆盖缓存**）。

关于字段映射（重要）：
    需求文档要求所有字段「结合抓包校验」。当前尚未拿到抓包样本，
    因此本模块**不做单字段硬编码**，而是为每个展示列维护一组候选字段名
    （见 ``_FIELD_CANDIDATES``），按顺序取第一个非空值，取不到则留空。
    拿到抓包样本后，只需调整候选字段表即可，无需改动界面代码。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import config
from logger_util import Logger

#: 表格列定义：``(字段名, 表头文字)``，顺序即界面展示顺序。
TABLE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("course_number", "课程号"),
    ("course_total_number", "课程总号"),
    ("course_name", "课程名称"),
    ("course_category", "课程类别"),
    ("course_nature", "课程性质"),
    ("department", "开课单位"),
    ("credit", "学分"),
    ("course_time", "课程时间"),
    ("is_mooc", "是否MOOC"),
    ("capacity_text", "已选人数 / 总人数"),
)

#: 展示列到接口候选字段名的映射，按优先级从高到低排列。
#: 依据 ``docs/har.json`` 抓包会话的真实响应实测确定（见 docs/接口逆向记录.md）：
#: - programCourse.do / recommendedCourse.do：课程级字段 + 嵌套 ``tcList`` 教学班级；
#: - publicCourse.do（校公选课/慕课）：无 ``tcList``，一行即一个教学班级（扁平结构）。
_FIELD_CANDIDATES: dict[str, tuple[str, ...]] = {
    "course_number": ("courseNumber",),
    "course_total_number": ("courseTotalNumber",),
    "course_category": ("courseTypeName", "typeName", "courseType", "type"),
    "course_nature": ("courseNatureName", "courseNature"),
    "department": ("departmentName", "departmentCode"),
    "credit": ("credit",),
    "course_time": ("teachingPlace", "teachingTimeList"),
    "is_mooc": ("isMooc",),
}

_TEACHER_CANDIDATES: tuple[str, ...] = ("teacherName",)
_CAPACITY_CANDIDATES: tuple[str, ...] = ("classCapacity", "mainClassCapacity")
_SELECTED_CANDIDATES: tuple[str, ...] = (
    "numberOfFirstVolunteer",
    "numberOfSelected",
    "selected",
)
_FULL_CANDIDATES: tuple[str, ...] = ("isFull",)
_CONFLICT_CANDIDATES: tuple[str, ...] = ("isConflict",)
_CHOSEN_CANDIDATES: tuple[str, ...] = ("isChoose",)
_CLASS_ID_CANDIDATES: tuple[str, ...] = ("teachingClassID", "tcId", "teachingClassId", "classId", "id")



def _pick(source: Mapping[str, Any], keys: Sequence[str], default: str = "") -> str:
    """从字典中按候选键顺序取出第一个非空值并转为字符串。

    :param source: 原始字典（接口返回的课程或教学班对象）。
    :param keys: 候选字段名，按优先级排列。
    :param default: 全部取不到时返回的默认值。
    :return: 字符串形式的值；值为 ``None`` 或不存在时继续尝试后续候选键。
    """
    for key in keys:
        if key in source:
            value = source[key]
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
    return default


def _to_int(value: Any, default: int = 0) -> int:
    """把接口返回值宽松地转换为整数。

    :param value: 原始值，可能是 ``int``、``"12"``、``None`` 等。
    :param default: 转换失败时的默认值。
    :return: 转换后的整数。
    """
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _to_flag(value: Any) -> bool:
    """把接口中 ``"1"/"0"/true/false`` 之类的标记转换为布尔值。

    :param value: 原始标记值。
    :return: ``"1"``、``"true"``、``True`` 等视为 ``True``。
    """
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _flag_text(value: Any) -> str:
    """把标记值转换为界面展示用的「是 / 否 / 未知」。

    :param value: 原始标记值。
    :return: ``"是"``、``"否"``，无法判断时返回空字符串。
    """
    text = str(value).strip() if value is not None else ""
    if text == "":
        return ""
    return "是" if _to_flag(text) else "否"


@dataclass
class Course:
    """一条课程（教学班）记录，对应课程表格中的一行。

    :ivar teaching_class_id: 教学班 ID，抢课与收藏的目标标识。
    :ivar teaching_class_type: 课程类别代码，见 ``config.TEACHING_CLASS_TYPES``。
    :ivar course_name: 课程名称。
    :ivar teacher_name: 授课教师。
    :ivar selected_count: 当前已选人数。
    :ivar class_capacity: 课容量（总人数）。
    :ivar is_full: 是否已满。
    :ivar is_conflict: 是否与已选课程时间冲突。
    :ivar is_chosen: 是否已被本人选中。
    """

    teaching_class_id: str = ""
    teaching_class_type: str = ""
    course_number: str = ""
    course_total_number: str = ""
    course_name: str = ""
    course_category: str = ""
    course_nature: str = ""
    department: str = ""
    credit: str = ""
    course_time: str = ""
    is_mooc: str = ""
    teacher_name: str = ""
    selected_count: int = 0
    class_capacity: int = 0
    is_full: bool = False
    is_conflict: bool = False
    is_chosen: bool = False

    def capacity_text(self) -> str:
        """返回「已选人数 / 总人数」展示文本。

        :return: 例如 ``"45 / 50"``；容量未知时返回 ``"45 / -"``。
        """
        capacity = "-" if self.class_capacity <= 0 else str(self.class_capacity)
        return f"{self.selected_count} / {capacity}"

    def has_free_seat(self) -> bool:
        """判断该教学班当前是否还有余量。

        :return: 未满且（容量未知或已选人数小于容量）时返回 ``True``。
        """
        if self.is_full:
            return False
        if self.class_capacity <= 0:
            return True
        return self.selected_count < self.class_capacity

    def to_dict(self) -> dict[str, Any]:
        """序列化为可写入缓存的字典（不含原始报文，避免缓存膨胀）。

        :return: 字段字典。
        """
        return {
            "teachingClassId": self.teaching_class_id,
            "teachingClassType": self.teaching_class_type,
            "courseNumber": self.course_number,
            "courseTotalNumber": self.course_total_number,
            "courseName": self.course_name,
            "courseCategory": self.course_category,
            "courseNature": self.course_nature,
            "department": self.department,
            "credit": self.credit,
            "courseTime": self.course_time,
            "isMooc": self.is_mooc,
            "teacherName": self.teacher_name,
            "selectedCount": self.selected_count,
            "classCapacity": self.class_capacity,
            "isFull": self.is_full,
            "isConflict": self.is_conflict,
            "isChosen": self.is_chosen,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Course":
        """从缓存字典反序列化为课程对象。

        :param data: :meth:`to_dict` 产生的字典。
        :return: :class:`Course` 实例。
        """
        return cls(
            teaching_class_id=str(data.get("teachingClassId", "")),
            teaching_class_type=str(data.get("teachingClassType", "")),
            course_number=str(data.get("courseNumber", "")),
            course_total_number=str(data.get("courseTotalNumber", "")),
            course_name=str(data.get("courseName", "")),
            course_category=str(data.get("courseCategory", "")),
            course_nature=str(data.get("courseNature", "")),
            department=str(data.get("department", "")),
            credit=str(data.get("credit", "")),
            course_time=str(data.get("courseTime", "")),
            is_mooc=str(data.get("isMooc", "")),
            teacher_name=str(data.get("teacherName", "")),
            selected_count=_to_int(data.get("selectedCount", 0)),
            class_capacity=_to_int(data.get("classCapacity", 0)),
            is_full=bool(data.get("isFull", False)),
            is_conflict=bool(data.get("isConflict", False)),
            is_chosen=bool(data.get("isChosen", False)),
        )

    def row_values(self) -> list[str]:
        """按 :data:`TABLE_COLUMNS` 顺序生成界面行数据。

        :return: 与表头一一对应的字符串列表。
        """
        values: list[str] = []
        for name, _ in TABLE_COLUMNS:
            if name == "capacity_text":
                values.append(self.capacity_text())
            else:
                values.append(str(getattr(self, name, "")))
        return values


@dataclass
class CapacityInfo:
    """某个教学班的最新容量信息，供抢课任务轮询判断是否放量。

    :ivar teaching_class_id: 教学班 ID。
    :ivar course_name: 课程名称。
    :ivar teacher_name: 授课教师。
    :ivar selected_count: 已选人数。
    :ivar class_capacity: 课容量。
    :ivar is_full: 是否已满。
    :ivar is_conflict: 是否冲突。
    :ivar is_chosen: 是否已选。
    """

    teaching_class_id: str
    course_name: str = ""
    teacher_name: str = ""
    selected_count: int = 0
    class_capacity: int = 0
    is_full: bool = False
    is_conflict: bool = False
    is_chosen: bool = False

    def has_free_seat(self) -> bool:
        """判断该教学班当前是否还有余量。

        :return: 未满且未超出容量时返回 ``True``。
        """
        if self.is_full:
            return False
        if self.class_capacity <= 0:
            return True
        return self.selected_count < self.class_capacity

    def describe(self) -> str:
        """生成用于日志展示的一行描述。

        :return: 例如 ``"线性代数 / 宋宇锋 已选 45/- 未满"``。
        """
        capacity = "-" if self.class_capacity <= 0 else str(self.class_capacity)
        state = "已满" if self.is_full else "未满"
        return f"{self.course_name} / {self.teacher_name} {self.selected_count}/{capacity} {state}"


def iter_teaching_classes(api_response: Mapping[str, Any]) -> Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """遍历接口响应中的「课程 × 教学班」组合。

    :param api_response: 课程查询接口返回的 JSON 对象。
    :return: ``(课程级字典, 教学班级字典)`` 生成器；课程没有 ``tcList`` 时
             教学班级字典为空字典，保证课程仍能被展示。
    """
    data_list = api_response.get("dataList") or []
    if not isinstance(data_list, list):
        return
    for course in data_list:
        if not isinstance(course, Mapping):
            continue
        tc_list = course.get("tcList") or []
        if not isinstance(tc_list, list) or not tc_list:
            yield course, {}
            continue
        for tc_info in tc_list:
            if isinstance(tc_info, Mapping):
                yield course, tc_info


def parse_courses(
    api_response: Mapping[str, Any],
    teaching_class_type: str = "",
) -> list[Course]:
    """把课程查询接口响应解析为课程列表。

    :param api_response: 接口返回的 JSON 对象。
    :param teaching_class_type: 该次请求使用的课程类别代码，用于回填。
    :return: :class:`Course` 列表；响应结构异常时返回空列表。
    """
    courses: list[Course] = []
    for course, tc_info in iter_teaching_classes(api_response):
        merged: dict[str, Any] = dict(course)
        merged.update(tc_info)

        teaching_class_id = _pick(tc_info, _CLASS_ID_CANDIDATES)
        capacity = _to_int(_pick(tc_info, _CAPACITY_CANDIDATES, "0"))
        selected = _to_int(_pick(tc_info, _SELECTED_CANDIDATES, "0"))
        full_raw = _pick(tc_info, _FULL_CANDIDATES, "")
        is_full = _to_flag(full_raw) if full_raw != "" else (capacity > 0 and selected >= capacity)

        courses.append(
            Course(
                teaching_class_id=teaching_class_id,
                teaching_class_type=_pick(merged, ("teachingClassType", "courseType")) or teaching_class_type,
                course_number=_pick(merged, _FIELD_CANDIDATES["course_number"]),
                course_total_number=_pick(merged, _FIELD_CANDIDATES["course_total_number"]),
                course_name=_pick(merged, ("courseName", "name")),
                course_category=_pick(merged, _FIELD_CANDIDATES["course_category"])
                or config.TEACHING_CLASS_TYPES.get(teaching_class_type, ""),
                course_nature=_pick(merged, _FIELD_CANDIDATES["course_nature"]),
                department=_pick(merged, _FIELD_CANDIDATES["department"]),
                credit=_pick(merged, _FIELD_CANDIDATES["credit"]),
                course_time=_pick(merged, _FIELD_CANDIDATES["course_time"]),
                is_mooc=_flag_text(_pick(merged, _FIELD_CANDIDATES["is_mooc"], "")),
                teacher_name=_pick(merged, _TEACHER_CANDIDATES),
                selected_count=selected,
                class_capacity=capacity,
                is_full=is_full,
                is_conflict=_to_flag(_pick(merged, _CONFLICT_CANDIDATES, "0")),
                is_chosen=_to_flag(_pick(merged, _CHOSEN_CANDIDATES, "0")),
            )
        )
    return courses


def extract_capacity(
    api_response: Mapping[str, Any],
    teaching_class_id: str,
) -> CapacityInfo | None:
    """从课程查询响应中提取指定教学班的容量信息。

    用于抢课任务轮询：查询目标课程所在类别后，取出对应教学班的实时容量。

    :param api_response: 接口返回的 JSON 对象。
    :param teaching_class_id: 目标教学班 ID。
    :return: 匹配到的 :class:`CapacityInfo`；未匹配到时返回 ``None``。
    """
    target = str(teaching_class_id).strip()
    for course, tc_info in iter_teaching_classes(api_response):
        current_id = _pick(tc_info, _CLASS_ID_CANDIDATES)
        if current_id != target:
            continue
        capacity = _to_int(_pick(tc_info, _CAPACITY_CANDIDATES, "0"))
        selected = _to_int(_pick(tc_info, _SELECTED_CANDIDATES, "0"))
        full_raw = _pick(tc_info, _FULL_CANDIDATES, "")
        return CapacityInfo(
            teaching_class_id=current_id,
            course_name=_pick(course, ("courseName", "name")),
            teacher_name=_pick(tc_info, _TEACHER_CANDIDATES),
            selected_count=selected,
            class_capacity=capacity,
            is_full=_to_flag(full_raw) if full_raw != "" else (capacity > 0 and selected >= capacity),
            is_conflict=_to_flag(_pick(tc_info, _CONFLICT_CANDIDATES, "0")),
            is_chosen=_to_flag(_pick(tc_info, _CHOSEN_CANDIDATES, "0")),
        )
    return None


def filter_courses(
    courses: Iterable[Course],
    keyword: str = "",
    category: str = "",
    mooc: str = "",
    only_available: bool = False,
) -> list[Course]:
    """按界面条件过滤课程列表（内存过滤，不产生网络请求）。

    :param courses: 待过滤的课程列表。
    :param keyword: 课程名/教师名/课程号模糊搜索关键字，空串表示不限制。
    :param category: 课程类别代码或中文名，空串表示不限制。
    :param mooc: ``"是"``/``"否"``，空串表示不限制。
    :param only_available: 为 ``True`` 时只保留仍有余量的课程。
    :return: 过滤后的课程列表。
    """
    text = keyword.strip().lower()
    result: list[Course] = []
    for course in courses:
        if text:
            haystack = f"{course.course_name}{course.teacher_name}{course.course_number}{course.course_total_number}".lower()
            if text not in haystack:
                continue
        if category and category not in (course.course_category, course.teaching_class_type):
            continue
        if mooc and course.is_mooc != mooc:
            continue
        if only_available and not course.has_free_seat():
            continue
        result.append(course)
    return result


def load_courses(
    path: Path | None = None,
    logger: Logger | None = None,
) -> list[Course]:
    """从本地 JSON 缓存读取课程列表。

    文件不存在、内容损坏或 IO 异常时返回空列表，**不允许抛异常导致程序崩溃**。

    :param path: 缓存文件路径，默认 ``config.COURSE_CACHE_FILE``。
    :param logger: 日志器，用于记录读写成功/失败。
    :return: 课程列表。
    """
    target = Path(path) if path is not None else config.COURSE_CACHE_FILE
    try:
        with open(target, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        if logger is not None:
            logger.info(config.SOURCE_COURSE, f"未找到本地课程缓存（{target.name}），将等待手动刷新。", config.CATEGORY_QUERY)
        return []
    except (OSError, json.JSONDecodeError) as exc:
        if logger is not None:
            logger.warning(config.SOURCE_COURSE, f"读取课程缓存失败（{target.name}）：{exc}", config.CATEGORY_QUERY)
        return []

    raw_courses = data.get("courses") if isinstance(data, Mapping) else data
    if not isinstance(raw_courses, list):
        if logger is not None:
            logger.warning(config.SOURCE_COURSE, f"课程缓存结构异常（{target.name}），已忽略。", config.CATEGORY_QUERY)
        return []

    courses = [Course.from_dict(item) for item in raw_courses if isinstance(item, Mapping)]
    if logger is not None:
        saved_at = data.get("savedAt", "未知时间") if isinstance(data, Mapping) else "未知时间"
        logger.info(
            config.SOURCE_COURSE,
            f"已加载本地课程缓存 {len(courses)} 条（保存于 {saved_at}）。",
            config.CATEGORY_QUERY,
        )
    return courses


def save_courses(
    courses: Sequence[Course],
    path: Path | None = None,
    logger: Logger | None = None,
) -> bool:
    """把课程列表写入本地 JSON 缓存。

    仅应在接口拉取成功后调用（需求要求「只有接口拉取成功才覆盖本地缓存」）。

    :param courses: 待缓存的课程列表。
    :param path: 缓存文件路径，默认 ``config.COURSE_CACHE_FILE``。
    :param logger: 日志器，用于记录写入成功/失败。
    :return: 写入成功返回 ``True``。
    """
    target = Path(path) if path is not None else config.COURSE_CACHE_FILE
    payload = {
        "formatVersion": config.COURSE_CACHE_FORMAT_VERSION,
        "savedAt": datetime.now().strftime(config.LOG_TIME_FORMAT),
        "courses": [course.to_dict() for course in courses],
    }
    try:
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        if logger is not None:
            logger.error(config.SOURCE_COURSE, f"写入课程缓存失败（{target.name}）：{exc}", config.CATEGORY_QUERY)
        return False
    if logger is not None:
        logger.info(config.SOURCE_COURSE, f"课程缓存已更新：{len(courses)} 条 → {target.name}", config.CATEGORY_QUERY)
    return True


def cache_saved_at(path: Path | None = None) -> str:
    """读取缓存文件中记录的保存时间。

    :param path: 缓存文件路径，默认 ``config.COURSE_CACHE_FILE``。
    :return: 保存时间字符串；文件缺失或损坏时返回空字符串。
    """
    target = Path(path) if path is not None else config.COURSE_CACHE_FILE
    try:
        with open(target, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return ""
    if isinstance(data, Mapping):
        return str(data.get("savedAt", ""))
    return ""


__all__ = [
    "TABLE_COLUMNS",
    "CapacityInfo",
    "Course",
    "cache_saved_at",
    "extract_capacity",
    "filter_courses",
    "iter_teaching_classes",
    "load_courses",
    "parse_courses",
    "save_courses",
]
