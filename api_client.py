# -*- coding: utf-8 -*-
"""aiohttp 网络封装层：全项目**唯一**的 http 出口。

职责：
    - 封装 aiohttp 会话，所有请求统一由本模块发出；
    - 所有请求**强制**通过 :class:`request_queue.RequestQueue` 入队限流，
      本模块不存在任何绕过队列直接调用 aiohttp 的代码路径；
    - 构造各接口的请求报文（query / header / body），接口路径与字段以
      「参考仓库 + 抓包校验」为准，未校验处均标注 ``TODO(抓包校验)``；
    - 发起请求前做凭证空值校验，缺失任意关键凭证直接告警并拒绝入队；
    - **写接口（选课/退课）由 ``config.ENABLE_WRITE_API`` 总开关控制**：
      关闭时只打印并记录请求报文模板，不发送任何真实请求（见 :meth:`ApiClient.enroll`）。

关于 token 的处理（对应需求文档第二节第 3 条）：
    网页并非所有请求都携带 token。本模块按接口分别决定 token 与 studentCode 放在
    header / query / body 的哪一处，**不做统一追加**；未校验的接口均已标注 TODO。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import quote

import aiohttp

import config
from auth_model import Credentials
from logger_util import Logger
from request_queue import RequestQueue


class ApiError(RuntimeError):
    """接口调用失败（网络异常、非 200 响应、响应体不是合法 JSON 等）。"""


class NotAuthenticatedError(ApiError):
    """登录态失效：服务器把请求重定向到首页、返回 401，或直接返回 HTML 页面。

    站点实测行为：cookie/token 失效时，普通请求返回 ``302 → *default/index.do``；
    带 ``X-Requested-With`` 的 AJAX 请求返回 ``401`` 并伴随 HTML 错误页。
    捕获本异常时应提示用户重新从浏览器复制 cookie 与 token。
    """


class MissingCredentialsError(RuntimeError):
    """关键身份凭证缺失，请求被拒绝入队。"""


@dataclass
class EnrollOutcome:
    """一次选课提交尝试的结果。

    :ivar sent: 是否**真实**发出了 http 请求；``False`` 表示处于报文模拟模式。
    :ivar success: 接口是否返回选课成功。
    :ivar message: 结果说明文案，可直接写日志或展示在任务列表。
    :ivar payload: 本次构造的请求报文字段（已脱敏，不含 cookie/token 明文）。
    :ivar response_text: 接口原始响应文本，模拟模式下为空字符串。
    """

    sent: bool
    success: bool
    message: str
    payload: dict[str, Any] = field(default_factory=dict)
    response_text: str = ""


def current_millis() -> str:
    """返回当前 13 位毫秒时间戳字符串。

    :return: 例如 ``"1730000000000"``。
    """
    return str(int(time.time() * 1000))


def build_elective_page_url(credentials: Credentials) -> str:
    """构造「跳转选课网页」的完整 URL（携带 token 查询参数）。

    站点 JS 实测（``index.min.js``）::

        t = BaseUrl + "/sys/xsxkapp/*default/grablessons.do?token=" + sessionStorage.token
        window.location.href = t

    即选课子页面**必须通过 URL 携带 token** 才能正常进入；新开的浏览器标签页没有
    ``sessionStorage``，只能靠 URL 传参还原登录上下文。

    :param credentials: 已规整的身份凭证；``token`` 为空时返回不带 token 的地址。
    :return: 可直接交给系统默认浏览器打开的完整 URL。
    """
    url = config.BASE_URL + config.EP_GRABLESSONS_PAGE
    token = credentials.token.strip()
    if not token:
        return url
    return f"{url}?token={quote(token)}"


def query_endpoint(teaching_class_type: str) -> str:
    """返回某课程类别对应的查询接口路径。

    :param teaching_class_type: 课程类别代码。
    :return: 相对接口路径；未登记的类别回退到 ``programCourse.do``。
    """
    return config.COURSE_QUERY_PLAN.get(teaching_class_type, (config.EP_PROGRAM_COURSE, ""))[0]


def build_query_setting(
    credentials: Credentials,
    teaching_class_type: str,
    page_number: int = config.QUERY_FIRST_PAGE,
) -> str:
    """构造课程查询接口的 ``querySetting`` 表单字段值。

    字段结构依据 ``docs/har.json`` 中已登录会话的真实请求逆向得出，
    与参考仓库写法有 **两处关键差异**：

    * ``pageNumber`` 服务器是 **0 基**（``0`` 才是第 1 页）；
    * ``queryContent`` 随课程类别不同而不同（见 ``config.COURSE_QUERY_PLAN``）。

    :param credentials: 已规整的身份凭证。
    :param teaching_class_type: 课程类别代码，见 ``config.TEACHING_CLASS_TYPES``。
    :param page_number: 页码，**从 0 开始**。
    :return: 紧凑 JSON 字符串。
    """
    _, query_content = config.COURSE_QUERY_PLAN.get(
        teaching_class_type, (config.EP_PROGRAM_COURSE, "YCJX:2,MOOC:2,")
    )
    payload = {
        "data": {
            "studentCode": credentials.student_code,
            "campus": config.CAMPUS,
            "electiveBatchCode": credentials.elective_batch_code,
            "isMajor": "1",
            "teachingClassType": teaching_class_type,
            "checkConflict": "2",
            "checkCapacity": "2",
            "queryContent": query_content,
        },
        "pageSize": str(config.QUERY_PAGE_SIZE),
        "pageNumber": str(page_number),
        "order": "",
        "orderBy": "courseNumber",
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def build_enroll_param(
    credentials: Credentials,
    teaching_class_id: str,
    teaching_class_type: str,
    operation_type: str = "1",
) -> str:
    """构造选课写接口的 ``addParam`` 表单字段值。

    .. warning::
       本函数**只构造报文**，不发送请求。字段取自参考仓库
       ``szu/choose_course.py``，**未经抓包校验**；即便字段有误，
       在 ``config.ENABLE_WRITE_API = False`` 时也不会产生真实请求。

    :param credentials: 已规整的身份凭证。
    :param teaching_class_id: 教学班 ID（``teachingClassID``）。
    :param teaching_class_type: 课程类别代码。
    :param operation_type: 操作类型，``"1"`` 表示选课。
    :return: 紧凑 JSON 字符串。
    """
    payload = {
        "data": {
            "operationType": operation_type,
            "studentCode": credentials.student_code,
            "electiveBatchCode": credentials.elective_batch_code,
            "teachingClassId": teaching_class_id,
            "isMajor": "1",
            "campus": config.CAMPUS,
            "teachingClassType": teaching_class_type,
            "chooseVolunteer": "1",
        }
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def format_enroll_report(
    url: str,
    form_data: dict[str, str],
    headers: dict[str, str],
) -> str:
    """把待发写请求渲染为可读的报文样例文本。

    凭证敏感字段（Cookie / token）只展示脱敏前缀，避免日志泄露完整凭证。

    :param url: 完整请求地址。
    :param form_data: 表单字段字典。
    :param headers: 请求头字典。
    :return: 多行文本，用于打印到控制台与写入日志。
    """
    safe_headers = dict(headers)
    for key in ("Cookie", "cookie", "token"):
        if key in safe_headers and safe_headers[key]:
            value = safe_headers[key]
            safe_headers[key] = f"{value[:8]}***（已脱敏，长度 {len(value)}）"
    lines = [
        "==================== 待发请求报文模板（未发送） ====================",
        f"POST {url}",
        "---- headers ----",
        json.dumps(safe_headers, ensure_ascii=False, indent=2),
        "---- form body ----",
        json.dumps(form_data, ensure_ascii=False, indent=2),
        "====================================================================",
    ]
    return "\n".join(lines)


class ApiClient:
    """异步网络客户端：持有 aiohttp 会话，全部请求经全局队列限流。

    :ivar _session: 懒加载的 aiohttp 会话。
    :ivar _session_lock: 保证会话只被初始化一次。
    """

    def __init__(
        self,
        credentials_provider: Callable[[], Credentials],
        queue: RequestQueue,
        logger: Logger,
    ) -> None:
        """初始化客户端。

        :param credentials_provider: 返回当前凭证的取值函数（UI 侧实时读取输入框）。
        :param queue: 全局限流请求队列。
        :param logger: 日志器。
        """
        self._credentials_provider = credentials_provider
        self._queue = queue
        self._logger = logger
        self._session: aiohttp.ClientSession | None = None
        self._session_lock = asyncio.Lock()

    # -- 生命周期 -----------------------------------------------------------
    async def start(self) -> None:
        """创建 aiohttp 会话。

        :return: ``None``
        """
        await self._ensure_session()

    async def close(self) -> None:
        """关闭 aiohttp 会话，程序退出时调用。

        :return: ``None``
        """
        session, self._session = self._session, None
        if session is not None and not session.closed:
            await session.close()

    async def _ensure_session(self) -> aiohttp.ClientSession:
        """懒加载并返回 aiohttp 会话。

        :return: 可用的 :class:`aiohttp.ClientSession`。
        """
        async with self._session_lock:
            if self._session is None or self._session.closed:
                timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT_SECONDS)
                self._session = aiohttp.ClientSession(timeout=timeout)
            return self._session

    # -- 凭证与请求头 -------------------------------------------------------
    def _current_credentials(self, action: str) -> Credentials:
        """读取并校验当前凭证。

        :param action: 动作描述，用于告警文案。
        :return: 规整后的 :class:`Credentials`。
        :raises MissingCredentialsError: 任意一项关键凭证缺失。
        """
        credentials = self._credentials_provider().normalized()
        ok, message = credentials.validate()
        if not ok:
            self._logger.warning(
                config.SOURCE_SYSTEM,
                f"{action} 被拒绝：{message}",
                config.CATEGORY_FAILURE,
            )
            raise MissingCredentialsError(message)
        return credentials

    def _build_headers(self, credentials: Credentials, use_token: bool) -> dict[str, str]:
        """按接口需要拼装请求头。

        Cookie 恒定携带；token 是否放入请求头由 ``use_token`` 决定
        （需求文档明确「不是所有请求都要带 token」）。
        抓包实测：接口调用还需携带 ``Referer``（选课子页面）与 ``Origin``。

        :param credentials: 已规整的凭证。
        :param use_token: 是否把 ``sessionStorage.token`` 放入 ``token`` 请求头。
        :return: 请求头字典。
        """
        headers = dict(config.DEFAULT_HEADERS)
        headers["Cookie"] = credentials.cookie
        if use_token:
            headers["token"] = credentials.token
            # 抓包实测：浏览器从选课子页面发起请求，带 Referer 与 Origin
            headers["Referer"] = (
                f"{config.BASE_URL}{config.EP_GRABLESSONS_PAGE}?token={credentials.token}"
            )
            headers["Origin"] = config.BASE_URL.rstrip("/")
        return headers

    # -- 课程查询 -----------------------------------------------------------
    async def query_courses(
        self,
        teaching_class_type: str,
        page_number: int = config.QUERY_FIRST_PAGE,
        priority: int = config.PRIORITY_HIGH,
    ) -> dict[str, Any]:
        """调用课程查询接口，返回接口原始 JSON。

        接口路径与 ``queryContent`` 按 ``config.COURSE_QUERY_PLAN`` 中
        **抓包实测**的映射选取（不同类别走不同接口）。

        :param teaching_class_type: 课程类别代码。
        :param page_number: 页码，**从 0 开始**（服务器为 0 基）。
        :param priority: 请求优先级，手动刷新应使用 ``config.PRIORITY_HIGH``。
        :return: 接口返回的 JSON 字典。
        :raises MissingCredentialsError: 关键凭证缺失。
        :raises NotAuthenticatedError: 登录态失效。
        :raises ApiError: 网络异常或服务器业务错误。
        """
        action = f"课程查询（{config.TEACHING_CLASS_TYPES.get(teaching_class_type, teaching_class_type)} 第 {page_number + 1} 页）"
        credentials = self._current_credentials(action)
        path = query_endpoint(teaching_class_type)
        form_data = {"querySetting": build_query_setting(credentials, teaching_class_type, page_number)}
        headers = self._build_headers(credentials, use_token=True)
        self._logger.info(
            config.SOURCE_COURSE,
            f"发起课程查询：类别={config.TEACHING_CLASS_TYPES.get(teaching_class_type, teaching_class_type)}，页码={page_number}，优先级={'手动' if priority == config.PRIORITY_HIGH else '后台'}",
            config.CATEGORY_QUERY,
        )
        text = await self._queue.submit(
            lambda: self._post_form(
                path,
                form_data,
                headers,
                params={"timestamp": current_millis()},
                source=config.SOURCE_COURSE,
            ),
            priority,
            name=f"课程查询-{teaching_class_type}-p{page_number}",
        )
        return self._parse_json(text, action)

    async def query_selected_courses(
        self,
        priority: int = config.PRIORITY_HIGH,
    ) -> dict[str, Any]:
        """调用「已选课程结果」查询接口。

        抓包实测：``studentCode`` 放在**表单 body** 中（不是 URL query），
        ``timestamp`` 放在 URL query 中。

        :param priority: 请求优先级。
        :return: 接口返回的 JSON 字典。
        :raises MissingCredentialsError: 关键凭证缺失。
        :raises NotAuthenticatedError: 登录态失效。
        :raises ApiError: 网络异常或服务器业务错误。
        """
        action = "已选课程结果查询"
        credentials = self._current_credentials(action)
        headers = self._build_headers(credentials, use_token=True)
        text = await self._queue.submit(
            lambda: self._post_form(
                config.EP_COURSE_RESULT,
                {"studentCode": credentials.student_code},
                headers,
                params={"timestamp": current_millis()},
                source=config.SOURCE_COURSE,
            ),
            priority,
            name="已选课程结果查询",
        )
        return self._parse_json(text, action)

    # -- 写接口（默认禁用） -------------------------------------------------
    async def enroll(
        self,
        teaching_class_id: str,
        teaching_class_type: str,
        priority: int = config.PRIORITY_NORMAL,
        source: str = config.SOURCE_TASK,
        action_label: str = "选课",
    ) -> EnrollOutcome:
        """提交选课写请求。

        .. danger::
           **开发求证阶段禁止真实调用本接口。** 当 ``config.ENABLE_WRITE_API`` 为
           ``False``（默认）时，本方法只构造并打印/记录请求报文模板，
           **不会发起任何 http 请求**。只有在用户手动把该开关改为 ``True`` 之后，
           才会真正入队发送；启用真实提交的一切后果由使用者自行承担。

        :param teaching_class_id: 教学班 ID。
        :param teaching_class_type: 课程类别代码。
        :param priority: 请求优先级。
        :param source: 日志来源模块，默认「抢课任务」。
        :param action_label: 动作名称，用于日志文案（如「选课」「退课」）。
        :return: :class:`EnrollOutcome` 结果对象。
        :raises MissingCredentialsError: 关键凭证缺失。
        """
        action = f"{action_label}提交"
        credentials = self._current_credentials(action)
        form_data = {"addParam": build_enroll_param(credentials, teaching_class_id, teaching_class_type)}
        headers = self._build_headers(credentials, use_token=True)
        url = config.BASE_URL + config.EP_VOLUNTEER
        report = format_enroll_report(url, form_data, headers)
        payload_preview = {
            "teachingClassId": teaching_class_id,
            "teachingClassType": teaching_class_type,
            "studentCode": credentials.student_code,
            "electiveBatchCode": credentials.elective_batch_code,
        }

        if not config.ENABLE_WRITE_API:
            # ---- 模拟模式：只打印报文，绝不发送请求 ----
            self._logger.warning(
                source,
                f"写接口总开关已关闭（ENABLE_WRITE_API=False），{action} 仅构造报文、不发送真实请求。",
                config.CATEGORY_FAILURE,
            )
            self._logger.info(source, report, config.CATEGORY_FAILURE)
            print(report)
            return EnrollOutcome(
                sent=False,
                success=False,
                message=f"写接口已禁用（ENABLE_WRITE_API=False），{action}报文已打印，未发送请求",
                payload=payload_preview,
            )

        # ---- 以下代码仅在用户手动开启 ENABLE_WRITE_API 后才会执行，风险自负 ----
        self._logger.warning(
            source,
            f"ENABLE_WRITE_API=True，即将真实发起{action}写请求，请自行承担风控与账号风险。",
            config.CATEGORY_FAILURE,
        )
        text = await self._queue.submit(
            lambda: self._post_form(
                config.EP_VOLUNTEER,
                form_data,
                headers,
                source=source,
            ),
            priority,
            name=f"{action}-{teaching_class_id}",
        )
        success = "添加选课志愿成功" in text
        outcome = EnrollOutcome(
            sent=True,
            success=success,
            message=f"{action}{'成功' if success else '失败'}：{text[:200]}",
            payload=payload_preview,
            response_text=text,
        )
        if success:
            self._logger.info(source, f"{action}成功：教学班 {teaching_class_id}", config.CATEGORY_SUCCESS)
        else:
            self._logger.warning(source, outcome.message, config.CATEGORY_FAILURE)
        return outcome

    # -- 底层 http（仅可由队列调用） ----------------------------------------
    async def _post_form(
        self,
        path: str,
        form_data: dict[str, str],
        headers: dict[str, str],
        params: dict[str, str] | None = None,
        source: str = config.SOURCE_SYSTEM,
    ) -> str:
        """发送 ``application/x-www-form-urlencoded`` POST 请求。

        .. note::
           本方法只允许被 :meth:`_queue.submit` 内部调用，是限流队列的实际执行体，
           **禁止**在业务代码中直接 ``await``。

        .. note::
           日志会完整输出**请求网址与表单内容**，便于排查问题；
           **请求头不写入日志**（其中含有 Cookie 与 token 明文）。

        :param path: 相对接口路径。
        :param form_data: 表单字段；为空字典时不发送 body。
        :param headers: 请求头。
        :param params: 附加到 URL 的查询参数。
        :param source: 日志来源模块，用于把该请求的日志归类到发起方。
        :return: 响应文本。
        :raises NotAuthenticatedError: 服务器判定未登录（3xx 重定向 / 401 / HTML 页面）。
        :raises ApiError: 请求失败或响应状态码异常。
        """
        session = await self._ensure_session()
        url = config.BASE_URL + path
        self._log_request(source, url, params, form_data)
        try:
            async with session.post(
                url,
                data=form_data or None,
                headers=headers,
                params=params,
                allow_redirects=False,
            ) as response:
                status = response.status
                location = response.headers.get("Location", "")
                text = await response.text()
                if status in (301, 302, 303, 307, 308):
                    raise NotAuthenticatedError(
                        f"服务器将请求重定向到 {location or '首页'}，判定为登录态失效；"
                        f"请在浏览器重新登录后复制最新 cookie 与 token。"
                    )
                if status == 401:
                    raise NotAuthenticatedError(
                        "接口返回 401（未认证），判定为登录态失效；"
                        "请在浏览器重新登录后复制最新 cookie 与 token。"
                    )
                if status != 200:
                    raise ApiError(f"接口返回状态码 {status}：{text[:200]}")
                return text
        except aiohttp.ClientError as exc:
            raise ApiError(f"网络请求异常：{exc}") from exc
        except asyncio.TimeoutError as exc:
            raise ApiError(f"请求超时（>{config.REQUEST_TIMEOUT_SECONDS}s）：{url}") from exc

    def _log_request(
        self,
        source: str,
        url: str,
        params: Mapping[str, str] | None,
        form_data: Mapping[str, str],
    ) -> None:
        """把本次请求的网址与表单内容写入日志（不含请求头）。

        :param source: 日志来源模块。
        :param url: 不含查询参数的接口地址。
        :param params: URL 查询参数。
        :param form_data: 表单字段。
        :return: ``None``
        """
        query = "&".join(f"{key}={value}" for key, value in (params or {}).items())
        full_url = f"{url}?{query}" if query else url
        body = json.dumps(form_data, ensure_ascii=False) if form_data else "（无表单内容）"
        self._logger.info(
            source,
            f"发起请求 POST {full_url}  表单={body}",
            config.CATEGORY_QUERY,
        )

    def _parse_json(self, text: str, action: str) -> dict[str, Any]:
        """把响应文本解析为 JSON 字典，并识别服务器业务错误。

        本方法处理三类失败：

        1. 返回 HTML 页面 → 登录态失效；
        2. ``code``/``msg`` 表明未登录（如 ``{"code":"302","msg":"未查询到登录信息"}``）
           → 登录态失效；
        3. 其它带 ``msg`` 但无 ``dataList`` 的响应 → 服务器业务错误，原样上报
           ``code``/``msg``，便于用户定位（例如批次未开放、参数不合法）。

        :param text: 接口响应文本。
        :param action: 动作描述，用于错误文案。
        :return: 解析后的字典。
        :raises NotAuthenticatedError: 响应表明未登录。
        :raises ApiError: 服务器业务错误或响应不是合法 JSON 对象。
        """
        stripped = text.lstrip()
        if stripped.startswith("<") or "<!DOCTYPE" in text[:200]:
            raise NotAuthenticatedError(
                f"{action} 返回的是网页而不是接口数据，判定为登录态失效"
                f"（cookie / token 已过期或复制不完整），请在浏览器重新登录后重新复制凭证。"
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ApiError(f"{action} 返回内容不是合法 JSON：{text[:200]}") from exc
        if not isinstance(data, dict):
            raise ApiError(f"{action} 返回内容结构异常（期望 JSON 对象）：{text[:200]}")

        code = str(data.get("code", "")).strip()
        message = str(data.get("msg") or data.get("message") or "").strip()
        if message and "dataList" not in data:
            if code == "302" or "登录" in message or "认证" in message:
                raise NotAuthenticatedError(
                    f"{action} 登录态已失效：服务器返回 code={code}，msg={message}；"
                    f"请在浏览器重新登录后重新复制 cookie 与 token。"
                )
            raise ApiError(f"{action} 服务器返回业务错误：code={code}，msg={message}")
        if code == "302" or (message and "登录" in message):
            raise NotAuthenticatedError(
                f"{action} 登录态已失效：服务器返回 code={code}，msg={message}；"
                f"请在浏览器重新登录后重新复制 cookie 与 token。"
            )
        return data
