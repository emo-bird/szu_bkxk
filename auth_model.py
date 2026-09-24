# -*- coding: utf-8 -*-
"""身份凭证数据模型。

需求要点（对应需求文档第二节）：
    - ``studentCode`` / ``electiveBatchCode`` / ``cookie`` / ``token`` 四项凭证
      全部由用户从浏览器登录页面复制粘贴输入，程序**不实现登录、不处理人机验证码**；
    - 凭证**只保存在内存中**，不写入任何本地文件，避免泄露；
    - 发起网络请求前必须做空值校验，缺失任意一项直接输出日志告警并拒绝发起请求；
    - 原 ``token`` 保存在前端 ``sessionStorage.token``，本模块提供模拟该存储环境的方法，
      供网络层还原网页的鉴权行为。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

from dataclasses import dataclass

#: 四项必备凭证字段名（顺序即 UI 展示顺序）
REQUIRED_FIELDS: tuple[str, ...] = (
    "student_code",
    "elective_batch_code",
    "cookie",
    "token",
)

#: 字段名到用户可见名称的映射，用于生成告警文案
FIELD_LABELS: dict[str, str] = {
    "student_code": "studentCode(学号)",
    "elective_batch_code": "electiveBatchCode(选课批次编码)",
    "cookie": "cookie",
    "token": "token",
}

#: 日志脱敏时保留的明文字符数
MASK_VISIBLE_CHARS: int = 6


def _normalize_cookie(raw: str) -> str:
    """把用户粘贴的 Cookie 规整为单行标准形式。

    支持从浏览器直接多行粘贴（每行一个 ``key=value;``），会去掉行尾分号并统一用
    ``"; "`` 连接。

    :param raw: 用户输入的原始 Cookie 文本，可以包含换行与多余空白。
    :return: 规整后的单行 Cookie 字符串；输入为空时返回空字符串。
    """
    if not raw:
        return ""
    parts = [chunk.strip().rstrip(";").strip() for chunk in raw.replace("\r", "").replace("\n", ";").split(";")]
    return "; ".join(part for part in parts if part)


def _mask(value: str) -> str:
    """对敏感凭证做脱敏，仅保留前 ``MASK_VISIBLE_CHARS`` 个字符。

    :param value: 原始凭证字符串。
    :return: 脱敏后的字符串，用于写日志。
    """
    if not value:
        return "(空)"
    if len(value) <= MASK_VISIBLE_CHARS:
        return "*" * len(value)
    return f"{value[:MASK_VISIBLE_CHARS]}*** (len={len(value)})"


@dataclass
class Credentials:
    """用户身份凭证集合。

    所有字段均为字符串，空字符串表示未填写。

    :ivar student_code: 学号，对应接口参数 ``studentCode``。
    :ivar elective_batch_code: 选课批次编码，对应 ``electiveBatchCode``。
    :ivar cookie: 浏览器完整 Cookie 字符串。
    :ivar token: 原本存放于前端 ``sessionStorage.token`` 的会话令牌。
    """

    student_code: str = ""
    elective_batch_code: str = ""
    cookie: str = ""
    token: str = ""

    def normalized(self) -> "Credentials":
        """返回去除首尾空白后的新凭证对象，不修改当前对象。

        Cookie 会经过 :func:`_normalize_cookie` 处理，其余字段仅做 ``strip()``。

        :return: 新的 :class:`Credentials` 实例。
        """
        return Credentials(
            student_code=self.student_code.strip(),
            elective_batch_code=self.elective_batch_code.strip(),
            cookie=_normalize_cookie(self.cookie),
            token=self.token.strip(),
        )

    def missing_fields(self) -> list[str]:
        """列出当前缺失（为空或仅含空白）的凭证字段名。

        :return: 缺失字段名列表，全部填写时返回空列表。
        """
        current = self.normalized()
        return [name for name in REQUIRED_FIELDS if not getattr(current, name)]

    def is_complete(self) -> bool:
        """判断四项凭证是否全部填写。

        :return: 全部填写返回 ``True``，否则 ``False``。
        """
        return not self.missing_fields()

    def validate(self) -> tuple[bool, str]:
        """校验凭证完整性，并生成可直接写入日志的说明文案。

        :return: ``(是否通过, 说明文案)``；通过时文案为空字符串。
        """
        missing = self.missing_fields()
        if not missing:
            return True, ""
        labels = "、".join(FIELD_LABELS.get(name, name) for name in missing)
        return False, f"身份凭证缺失：{labels}；请先在「课程查询」标签页粘贴完整凭证。"

    def session_storage(self) -> dict[str, str]:
        """模拟前端 ``sessionStorage`` 环境。

        网页 JS 通过 ``sessionStorage.token`` 读取令牌，本方法用于还原该存储环境，
        网络层据此决定 token 放到请求头还是参数。

        :return: 形如 ``{"token": "..."}`` 的字典。
        """
        return {"token": self.token.strip()}

    def masked(self) -> dict[str, str]:
        """生成脱敏后的凭证摘要，供日志输出使用。

        :return: 字段名到脱敏字符串的字典，绝不含完整明文凭证。
        """
        current = self.normalized()
        return {
            "studentCode": _mask(current.student_code),
            "electiveBatchCode": _mask(current.elective_batch_code),
            "cookie": _mask(current.cookie),
            "token": _mask(current.token),
        }

    def clear(self) -> None:
        """清空全部凭证字段（原地修改）。

        :return: ``None``
        """
        self.student_code = ""
        self.elective_batch_code = ""
        self.cookie = ""
        self.token = ""
