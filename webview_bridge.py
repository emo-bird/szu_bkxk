# -*- coding: utf-8 -*-
"""内嵌选课网页的数据面：CDP 泵、页面注入、课程回流与会话迁移。

本模块负责「窗口之外的一切」，全部通过 CDP 完成，运行在 asyncio 线程上：

    1. **会话读取**：读 cookie（含 HttpOnly）与整个 ``sessionStorage``，
       自动填充 :class:`auth_model.Credentials`，用户不必再手工粘贴；
    2. **页面注入**：课程卡片上显示教学班ID、追加「+ 添加到抢课任务」按钮、
       覆盖卡片高度（站点原样式固定 210px，追加内容会溢出）；
    3. **课程回流**：被动捕获页面自身 XHR 的响应体（**零额外请求**），
       解析成 :class:`course_model.Course` 交给课程表格；
    4. **网页回传**：卡片按钮点击 → CDP ``Runtime.addBinding`` → 回调 `on_add_task`；
    5. **会话迁移**：把 cookie + sessionStorage 写入独立 profile 的真实 Edge，
       实现「在真实浏览器打开（用本次会话）」。

设计要点：
    - 回传与捕获由**常驻消息泵**处理（100ms 轮询），点击后立即响应；
    - 抢课提交**不经过本模块**：仍由 :mod:`api_client` 走 500ms 限流队列，
      并受 ``config.ENABLE_WRITE_API`` 守卫。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable

import cdp_bridge
import config
import course_model as cm
import task_model as tm
from cdp_bridge import CdpClient, CapturedResponse
from logger_util import Logger

#: 卡片高度、教学班ID 标签与抢课按钮的样式覆盖
INJECT_CSS = (
    f".cv-course-card{{height:{config.WEBVIEW_CARD_HEIGHT_PX}px !important;}}"
    ".cv-tcid{color:#d00;font-weight:700;font-size:12px;line-height:16px;margin:2px 0;}"
    ".szu-add-task{display:block;width:100%;margin:5px 0 0;padding:3px 0;font-size:12px;"
    "color:#fff;background:#2048B1;border:0;border-radius:4px;cursor:pointer;}"
    ".szu-add-task:hover{background:#047ADC;}"
)

#: 注入脚本。
#:
#: ⚠️ 两个关键陷阱（都实测踩过）：
#: 1. 本脚本会经 ``Page.addScriptToEvaluateOnNewDocument`` 在新文档**骨架建立之前**执行，
#:    此时 ``document.documentElement`` 仍为 ``null``，直接 ``observe(...)`` 会抛异常，
#:    导致其后的 ``setInterval`` 与首次 ``decorate()`` 全部不执行。
#: 2. 卡片根元素 ``.cv-course-card`` **没有** tcId 属性（真实属性名是全小写 ``tcid``），
#:    tcId 挂在子元素上；根元素 id 形如 ``<教学班ID>_courseDiv``，故取值需三级回退。
INJECT_PAGE_SCRIPT = r"""
(function () {
  var CSS = "__CSS__";
  var BINDING = "__BINDING__";

  function ensureStyle() {
    if (!document.documentElement) { return; }
    if (document.getElementById('szu-inject-style')) { return; }
    var style = document.createElement('style');
    style.id = 'szu-inject-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function pickTcId(card) {
    var direct = card.getAttribute('tcId');
    if (direct) { return direct; }
    var child = card.querySelector('[tcId]');
    if (child) {
      var value = child.getAttribute('tcId');
      if (value) { return value; }
    }
    var id = card.getAttribute('id') || '';
    if (id.length > 10 && id.slice(-10) === '_courseDiv') { return id.slice(0, -10); }
    return '';
  }

  function ownText(el) {
    if (!el) { return ''; }
    var clone = el.cloneNode(true);
    var extra = clone.querySelector('.cv-detail');
    if (extra && extra.parentNode) { extra.parentNode.removeChild(extra); }
    return (clone.textContent || '').trim();
  }

  function rowInfo(card) {
    var row = card.closest ? card.closest('.cv-row') : null;
    function text(selector) {
      return ownText(row ? row.querySelector(selector) : null);
    }
    var title = card.querySelector('.cv-info-title');
    return {
      courseName: text('.cv-course'),
      courseNumber: text('.cv-num'),
      courseTotalNumber: text('.cv-courseTotalNumber'),
      categoryText: text('.cv-type'),
      natureText: text('.cv-nature'),
      department: text('.cv-department-col'),
      credit: text('.cv-credit-col'),
      teacher: title ? (title.getAttribute('title') || title.textContent || '').trim() : '',
      capacityText: ownText(card.querySelector('.cv-caption-text'))
    };
  }

  function sendAddTask(card, tid) {
    var payload = rowInfo(card);
    payload.teachingClassID = tid;
    if (typeof window[BINDING] === 'function') {
      window[BINDING](JSON.stringify(payload));
    }
  }

  function decorate() {
    if (!document.documentElement) { return; }
    ensureStyle();
    var cards = document.querySelectorAll('.cv-course-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var tid = pickTcId(card);
      if (!tid) { continue; }
      var info = card.querySelector('.cv-info');
      if (!info) { continue; }
      var label = card.querySelector('.cv-tcid');
      if (!label) {
        label = document.createElement('div');
        label.className = 'cv-tcid';
        label.textContent = '教学班ID: ' + tid;
        info.insertBefore(label, info.firstChild);
      }
      if (!card.querySelector('.szu-add-task')) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'szu-add-task';
        btn.textContent = '+ 添加到抢课任务';
        btn.addEventListener('click', (function (target, id) {
          return function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            sendAddTask(target, id);
          };
        })(card, tid));
        if (label.nextSibling) { info.insertBefore(btn, label.nextSibling); }
        else { info.appendChild(btn); }
      }
    }
  }

  function boot() {
    if (window.__szuTcidBooted) { return; }
    if (!document.documentElement) { setTimeout(boot, 30); return; }
    window.__szuTcidBooted = true;
    try {
      new MutationObserver(function () {
        clearTimeout(window.__szuTcidTimer);
        window.__szuTcidTimer = setTimeout(decorate, 150);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 观察器失败不影响轮询兜底 */ }
    setInterval(decorate, 1200);
    decorate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  }
  setTimeout(boot, 30);
  boot();
})();
""".replace("__CSS__", INJECT_CSS).replace("__BINDING__", config.WEBVIEW_BINDING_NAME)

#: 注入结果自检（供 UI 状态提示与排障）
INJECT_PROBE_SCRIPT = r"""
(function () {
  var cards = document.querySelectorAll('.cv-course-card');
  return JSON.stringify({
    cards: cards.length,
    tags: document.querySelectorAll('.cv-tcid').length,
    buttons: document.querySelectorAll('.szu-add-task').length,
    styleInjected: !!document.getElementById('szu-inject-style'),
    bindingAvailable: typeof window['__BINDING__'] === 'function',
    url: location.href
  });
})()
""".replace("__BINDING__", config.WEBVIEW_BINDING_NAME)


def build_task_from_payload(payload: dict, known: dict[str, dict]) -> tm.GrabTask:
    """把网页回传的数据解析成抢课任务对象。

    网页 DOM 上取到的字段优先；缺失的用**被动捕获到的接口数据**补全，
    其中 ``teachingClassType`` 直接来自捕获到的 ``querySetting``，因此类别精确。

    :param payload: 网页按钮回传的字典。
    :param known: ``teachingClassID`` → 课程详情 的档案表。
    :return: 已自动填充的 :class:`task_model.GrabTask`。
    """
    tc_id = str(payload.get("teachingClassID", "")).strip()
    full = known.get(tc_id, {})

    def pick(*keys: str) -> str:
        for key in keys:
            value = payload.get(key) or full.get(key)
            if value:
                return str(value).strip()
        return ""

    return tm.GrabTask(
        teaching_class_id=tc_id,
        course_name=pick("courseName"),
        teacher_name=pick("teacher", "teacherName"),
        course_number=pick("courseNumber"),
        course_total_number=pick("courseTotalNumber"),
        teaching_class_type=str(full.get("teachingClassType") or "FANKC"),
        poll_interval_ms=config.DEFAULT_POLL_INTERVAL_MS,
        stop_when_full=True,
        last_message="来自内嵌网页的「添加到抢课任务」",
    )


class WebViewBridge:
    """内嵌网页的数据面桥接。

    :ivar known: ``teachingClassID`` → 课程详情（含精确 ``teachingClassType``）。
    :ivar courses: ``teachingClassID`` → :class:`course_model.Course`。
    """

    def __init__(
        self,
        logger: Logger,
        on_session: Callable[[str, list[dict], dict[str, str]], None] | None = None,
        on_courses: Callable[[list[cm.Course]], None] | None = None,
        on_add_task: Callable[[dict], None] | None = None,
        on_status: Callable[[str], None] | None = None,
    ) -> None:
        """初始化桥接。

        :param logger: 日志器。
        :param on_session: 会话快照回调 ``(token, cookies, session_storage)``；
            **会在 asyncio 线程被调用**，界面侧需自行经 Qt 信号转发。
        :param on_courses: 课程列表变化回调（同样是跨线程调用）。
        :param on_add_task: 网页「添加到抢课任务」回调。
        :param on_status: 状态文案回调（用于界面提示）。
        """
        self._logger = logger
        self._on_session = on_session
        self._on_courses = on_courses
        self._on_add_task = on_add_task
        self._on_status = on_status
        self.known: dict[str, dict] = {}
        self.courses: dict[str, cm.Course] = {}
        self.token = ""
        self.cookies: list[dict] = []
        self.session_storage: dict[str, str] = {}
        self._courses_dirty = False
        self._last_courses_emit = 0.0

    # -- 日志/状态 ---------------------------------------------------------
    def _status(self, message: str, category: str = config.CATEGORY_SYSTEM) -> None:
        """记录一条来源为「系统」的日志并回调界面状态。

        :param message: 文案。
        :param category: 日志分类。
        :return: ``None``
        """
        self._logger.info(config.SOURCE_SYSTEM, message, category)
        if self._on_status is not None:
            try:
                self._on_status(message)
            except Exception:  # noqa: BLE001
                pass

    # -- 主循环 -------------------------------------------------------------
    async def run(self) -> None:
        """常驻运行：连接 CDP → 注入脚本 → 循环处理捕获与回传。

        连接失败会重试（内嵌浏览器可能还在启动）；运行中断开会自动重连。

        :return: ``None``
        """
        if not config.ENABLE_EMBEDDED_WEBVIEW:
            return
        while True:
            try:
                await self._session_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 断线后重连
                self._status(f"内嵌网页数据面断开，3 秒后重连：{type(exc).__name__}: {exc}")
                await asyncio.sleep(3)

    async def _session_once(self) -> None:
        """建立一次 CDP 会话并跑消息泵直到断开。

        :return: ``None``
        """
        try:
            version = await cdp_bridge.wait_for_cdp(config.WEBVIEW_DEBUG_PORT, timeout=30)
        except Exception as exc:  # noqa: BLE001
            self._status(f"等待内嵌网页调试端口失败：{exc}")
            await asyncio.sleep(3)
            return
        self._status(f"内嵌网页已连接：{version.get('Browser')}")

        target = await cdp_bridge.pick_target(config.WEBVIEW_DEBUG_PORT)
        async with CdpClient(target["webSocketDebuggerUrl"]) as cdp:
            await cdp.enable()
            await cdp.add_binding(config.WEBVIEW_BINDING_NAME)
            await cdp.inject_on_new_document(INJECT_PAGE_SCRIPT)
            await cdp.evaluate(INJECT_PAGE_SCRIPT)
            self._status("已注入：教学班ID 显示、抢课按钮、卡片高度修正")

            tick = 0
            while True:
                await self._pump_once(cdp)
                tick += 1
                if tick % 10 == 0:
                    await self._refresh_session(cdp)
                await asyncio.sleep(0.1)

    async def _pump_once(self, cdp: CdpClient) -> None:
        """执行一轮泵：捕获接口响应 + 处理网页回传 + 注入维护。

        :param cdp: CDP 会话。
        :return: ``None``
        """
        for item in await cdp.poll_responses():
            self._learn(item)
        for payload in cdp.take_bindings(config.WEBVIEW_BINDING_NAME):
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if self._on_add_task is not None:
                self._on_add_task(data)
        now = time.monotonic()
        if self._courses_dirty and now - self._last_courses_emit > 1.5:
            self._courses_dirty = False
            self._last_courses_emit = now
            if self._on_courses is not None:
                self._on_courses(list(self.courses.values()))

    async def _refresh_session(self, cdp: CdpClient) -> None:
        """刷新会话快照（token / cookie / sessionStorage）并回调。

        :param cdp: CDP 会话。
        :return: ``None``
        """
        try:
            self.token = await cdp.session_storage("token")
            self.cookies = await cdp.get_cookies([config.BASE_URL])
            self.session_storage = await cdp.dump_session_storage()
        except Exception:  # noqa: BLE001 - 页面可能正在导航
            return
        if self._on_session is not None and self.token:
            self._on_session(self.token, self.cookies, self.session_storage)

    # -- 课程学习 -----------------------------------------------------------
    def _learn(self, item: CapturedResponse) -> None:
        """从一条被动捕获的响应里学习教学班与课程。

        :param item: 捕获到的响应。
        :return: ``None``
        """
        data = item.json_or_none()
        if not data:
            return
        class_type = item.teaching_class_type()
        try:
            parsed = cm.parse_courses(data, class_type)
        except Exception as exc:  # noqa: BLE001 - 解析失败不影响泵
            self._logger.warning(config.SOURCE_COURSE, f"解析捕获数据失败：{exc}", config.CATEGORY_QUERY)
            return
        for course in parsed:
            tc_id = course.teaching_class_id
            if not tc_id:
                continue
            self.courses[tc_id] = course
            self._courses_dirty = True
        # 同时登记原始档案，供任务自动填充取用精确字段
        for course_row in data.get("dataList") or []:
            if not isinstance(course_row, dict):
                continue
            base = dict(course_row)
            base["teachingClassType"] = class_type
            rows = [base]
            for tc in course_row.get("tcList") or []:
                if isinstance(tc, dict):
                    merged = dict(course_row)
                    merged.update({k: v for k, v in tc.items() if v is not None})
                    merged["teachingClassType"] = class_type
                    rows.append(merged)
            for row in rows:
                tc_id = str(row.get("teachingClassID") or "").strip()
                if tc_id and tc_id not in self.known:
                    self.known[tc_id] = row
        if parsed:
            self._logger.info(
                config.SOURCE_COURSE,
                f"从内嵌网页被动获得 {len(parsed)} 条课程（{item.endpoint}"
                f"{'，类别 ' + class_type if class_type else ''}），累计 {len(self.courses)} 条",
                config.CATEGORY_QUERY,
            )

    # -- 会话迁移：在真实浏览器打开 -----------------------------------------
    async def open_in_real_browser(self) -> None:
        """把本次会话迁移到独立 profile 的真实 Edge 窗口并打开选课页。

        .. note::
           只带 token（URL 传参）是不够的：选课页会
           ``JSON.parse(sessionStorage.getItem('studentInfo'))``，
           缺项会抛异常，表现为**页面能打开但不显示课程**。
           因此这里复制整个 ``sessionStorage``。

        :return: ``None``
        """
        if not self.token:
            self._status("尚未取得会话（请先在内嵌网页里完成登录）")
            return
        port = config.REAL_BROWSER_DEBUG_PORT
        profile = config.REAL_BROWSER_PROFILE_DIR
        profile.mkdir(parents=True, exist_ok=True)
        self._status(f"正在用本次会话打开真实浏览器（cookie {len(self.cookies)} 条，"
                     f"sessionStorage {len(self.session_storage)} 项）")
        # 复用已在运行的实例：Chromium 对同一 user-data-dir 是单例，重复启动会失败
        if await cdp_bridge.is_cdp_alive(port):
            self._status("复用已在运行的真实浏览器实例")
        else:
            cdp_bridge.launch_edge(port, profile, url="about:blank")
        try:
            version = await cdp_bridge.wait_for_cdp(port, timeout=40)
        except Exception as exc:  # noqa: BLE001
            self._status(f"启动真实浏览器失败：{exc}")
            return
        self._status(f"真实浏览器已就绪：{version.get('Browser')}（profile {profile.name}）")

        target = await cdp_bridge.pick_target(port, prefer_host="szu.edu.cn")
        async with CdpClient(target["webSocketDebuggerUrl"]) as cdp:
            await cdp.enable()
            written = await cdp.set_cookies(self.cookies, config.BASE_URL)
            await cdp.navigate(config.BASE_URL + config.EP_INDEX)
            await asyncio.sleep(2.5)
            restored = await cdp.restore_session_storage(self.session_storage)
            self._status(f"已写入 {written} 条 cookie、{restored} 项 sessionStorage")
            await cdp.navigate(f"{config.WEBVIEW_PAGE_URL}?token={self.token}")
            cards = 0
            for _ in range(24):
                await asyncio.sleep(0.5)
                try:
                    cards = int(await cdp.evaluate(
                        "document.querySelectorAll('.cv-course-card').length") or 0)
                except Exception:  # noqa: BLE001 - 导航瞬间连接可能抖动
                    continue
                if cards > 0:
                    break
        if cards > 0:
            self._status(f"已在真实浏览器打开并保持登录（课程卡片 {cards} 个）")
        else:
            self._status("真实浏览器已打开，但未检测到课程卡片，请查看该窗口的 F12 控制台")

    # -- 页面工具 -----------------------------------------------------------
    async def probe_page(self) -> dict[str, Any]:
        """读取当前内嵌页的注入状态（供界面显示与排障）。

        :return: 自检结果字典；失败时返回空字典。
        """
        try:
            async with CdpClient((await cdp_bridge.pick_target(config.WEBVIEW_DEBUG_PORT))["webSocketDebuggerUrl"]) as cdp:
                await cdp.enable()
                raw = await cdp.evaluate(INJECT_PROBE_SCRIPT)
                return json.loads(str(raw or "{}"))
        except Exception:  # noqa: BLE001
            return {}
