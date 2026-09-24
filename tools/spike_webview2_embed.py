# -*- coding: utf-8 -*-
"""B+ 路线 spike：WebView2 内嵌 + CDP，并验证「网页按钮 → Python 抢课任务弹窗」。

架构（B+）：
    - **pythonnet + 官方 WebView2 SDK（Core API）** 把 WebView2 嵌进 Qt 控件：
      ``CoreWebView2Environment.CreateAsync`` → ``CreateCoreWebView2ControllerAsync(parentHwnd)``，
      **不依赖 WinForms**；
    - 通过 ``AdditionalBrowserArguments = --remote-debugging-port=N`` 打开 CDP 端口，
      **数据面全部走 CDP**（复用 ``cdp_bridge``）：读 cookie/token、注入 JS、
      被动捕获页面自身 XHR 响应体；
    - 网页 → Python 的单向通道用 CDP 的 ``Runtime.addBinding``（页面里以
      ``window.__szuAddTask(str)`` 调用），无需 pygame/Qt 主线程互操作；
    - 抢课提交仍由 Python 的 aiohttp 走全局限流队列（本 spike 不涉及）。

验证清单：
    [1] WebView2 能否内嵌进 Qt 窗口          [5] 卡片显示教学班ID + 注入按钮
    [2] CDP 端口是否可达                     [6] 被动捕获接口响应（零额外请求）
    [3] 执行 JS / 读 sessionStorage.token    [7] 点击网页按钮 → Python 弹出抢课任务窗口并自动填充
    [4] 登录后读取 cookie（含 HttpOnly）

用法（**在普通 PowerShell 里运行**）::

    cd C:\\Project\\szu_bkxk
    .\\.venv\\Scripts\\python.exe tools\\spike_webview2_embed.py

窗口内完成统一身份认证登录后，点击任意课程卡片上的「+ 添加到抢课任务」按钮。
本脚本不向学校站点主动发起任何业务请求。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import queue
import sys
import threading
import time
import traceback

# pythonnet 在本机必须走 .NET Core 运行时（默认 netfx 会加载失败），
# 且必须在 import clr 之前设置。
os.environ.setdefault("PYTHONNET_RUNTIME", "coreclr")

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from PyQt6.QtCore import QTimer  # noqa: E402
from PyQt6.QtWidgets import (  # noqa: E402
    QApplication,
    QDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import cdp_bridge  # noqa: E402
import config  # noqa: E402
import task_model as tm  # noqa: E402
from logger_util import Logger  # noqa: E402

CORE_DLL = PROJECT_ROOT / "vendor" / "webview2" / "lib" / "net462" / "Microsoft.Web.WebView2.Core.dll"
DEBUG_PORT = 9340
PROFILE_DIR = PROJECT_ROOT / ".webview2_profile"
GRAB_URL = config.BASE_URL + config.EP_GRABLESSONS_PAGE
CHECK_TIMEOUT = 900.0
CLICK_WAIT = 300.0
BINDING_NAME = "__szuAddTask"

#: 被动的教学班档案：teachingClassID → 课程详情（含精确的 teachingClassType）
KNOWN_CLASSES: dict[str, dict] = {}
#: 抢课任务对话框用的日志器（在 main 中初始化）
LOGGER: Logger | None = None

#: 站点原样式 `.cv-course-card` 是**固定 210px 高且未处理溢出**，
#: 追加「教学班ID」标签后会撑出卡片，因此必须覆盖高度。
INJECT_CSS = (
    ".cv-course-card{height:252px !important;}"
    ".cv-tcid{color:#d00;font-weight:700;font-size:12px;line-height:16px;margin:2px 0;}"
    ".szu-add-task{display:block;width:100%;margin:5px 0 0;padding:3px 0;font-size:12px;"
    "color:#fff;background:#2048B1;border:0;border-radius:4px;cursor:pointer;}"
    ".szu-add-task:hover{background:#047ADC;}"
)

#: 注入脚本：显示教学班ID + 添加「+ 添加到抢课任务」按钮 + 覆盖卡片高度。
#:
#: ⚠️ 两个关键陷阱：
#: 1. 本脚本会经 ``Page.addScriptToEvaluateOnNewDocument`` 在新文档**骨架建立之前**执行，
#:    此时 ``document.documentElement`` 仍为 ``null``，直接 ``observe(...)`` 会抛异常，
#:    导致其后的 ``setInterval`` 与首次 ``decorate()`` 全部不执行。
#: 2. 卡片根元素 ``.cv-course-card`` **没有** tcId 属性，tcId 挂在子元素上；
#:    根元素 id 形如 ``<教学班ID>_courseDiv``。故取值需三级回退。
INJECT_PAGE_SCRIPT = r"""
(function () {
  var CSS = "__CSS__";
  var BINDING = "__BINDING__";

  function ensureStyle() {
    if (!document.documentElement) { return false; }
    if (document.getElementById('szu-inject-style')) { return true; }
    var style = document.createElement('style');
    style.id = 'szu-inject-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    return true;
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
    return {
      courseName: text('.cv-course'),
      courseNumber: text('.cv-num'),
      courseTotalNumber: text('.cv-courseTotalNumber'),
      categoryText: text('.cv-type'),
      natureText: text('.cv-nature'),
      department: text('.cv-department-col'),
      credit: text('.cv-credit-col'),
      teacher: (function () {
        var el = card.querySelector('.cv-info-title');
        return el ? (el.getAttribute('title') || el.textContent || '').trim() : '';
      })(),
      teachingPlaceTitle: (function () {
        var el = card.querySelector('.cv-info > div[title]');
        return el ? (el.getAttribute('title') || '').trim() : '';
      })(),
      capacityText: (function () {
        var el = card.querySelector('.cv-caption-text');
        return el ? (el.textContent || '').trim() : '';
      })()
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
    window.__szuTcidHook = true;
    try {
      new MutationObserver(function () {
        clearTimeout(window.__szuTcidTimer);
        window.__szuTcidTimer = setTimeout(decorate, 150);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 观察器失败不影响下面的轮询兜底 */ }
    setInterval(decorate, 1200);
    decorate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  }
  setTimeout(boot, 30);
  boot();
})();
""".replace("__CSS__", INJECT_CSS).replace("__BINDING__", BINDING_NAME)

#: 注入结果自检脚本：tags/buttons 为 0 时把首张卡片结构带回来，便于定位
INJECT_PROBE_SCRIPT = r"""
(function () {
  var cards = document.querySelectorAll('.cv-course-card');
  var tags = document.querySelectorAll('.cv-tcid');
  var buttons = document.querySelectorAll('.szu-add-task');
  var diag = {
    hookInstalled: !!window.__szuTcidHook,
    booted: !!window.__szuTcidBooted,
    styleInjected: !!document.getElementById('szu-inject-style'),
    bindingAvailable: typeof window['__BINDING__'] === 'function',
    cardHeight: cards.length ? getComputedStyle(cards[0]).height : '',
    url: location.href
  };
  if (cards.length) {
    var card = cards[0];
    diag.cardId = card.getAttribute('id');
    var child = card.querySelector('[tcId]');
    diag.childTcId = child ? child.getAttribute('tcId') : null;
  }
  return JSON.stringify({
    cards: cards.length,
    tags: tags.length,
    buttons: buttons.length,
    sample: tags.length ? tags[0].textContent : '',
    diag: diag
  });
})()
""".replace("__BINDING__", BINDING_NAME)


class WebContainer(QWidget):
    """承载内嵌 WebView2 的容器。

    WebView2 是原生子窗口（HWND），不参与 Qt 布局绘制，
    因此**必须在每次尺寸变化时手动同步它的 Bounds** —— 这就是本容器存在的原因。
    """

    def __init__(self, on_resize) -> None:
        """初始化容器。

        :param on_resize: 尺寸变化回调（无参）。
        """
        super().__init__()
        self._on_resize = on_resize

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 约定的驼峰命名
        """窗口尺寸变化时回调外部同步逻辑。

        :param event: Qt 尺寸事件。
        """
        super().resizeEvent(event)
        self._on_resize()


def load_webview2_types():
    """加载 WebView2 的 .NET 类型。

    :return: ``(CoreWebView2Environment, CoreWebView2EnvironmentOptions)``。
    :raises SystemExit: 程序集缺失或加载失败。
    """
    if not CORE_DLL.exists():
        print(f"[FAIL] 未找到 WebView2 SDK：{CORE_DLL}")
        print("       请下载官方 NuGet 包并解压到 vendor/webview2/")
        raise SystemExit(2)
    try:
        import clr

        clr.AddReference(str(CORE_DLL))
        for extra in ("System.Drawing.Primitives", "System.Drawing.Common"):
            try:
                clr.AddReference(extra)
            except Exception:  # noqa: BLE001 - 缺哪个都不致命
                continue
        from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
            CoreWebView2Environment,
            CoreWebView2EnvironmentOptions,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 加载 WebView2 程序集失败：{type(exc).__name__}: {exc}")
        raise SystemExit(2) from exc
    return CoreWebView2Environment, CoreWebView2EnvironmentOptions


def make_rect(x: int, y: int, width: int, height: int):
    """构造 ``System.Drawing.Rectangle``。

    :param x: 左坐标。
    :param y: 上坐标。
    :param width: 宽。
    :param height: 高。
    :return: Rectangle 实例；不可用时退回元组。
    """
    try:
        import System.Drawing  # noqa: F401

        return System.Drawing.Rectangle(x, y, width, height)
    except Exception:  # noqa: BLE001
        return (x, y, width, height)


def to_intptr(value: int):
    """把 Python int 转成 .NET ``System.IntPtr``。

    pythonnet **不做** int → IntPtr 的隐式转换，直接传 int 会报
    ``'int' value cannot be converted to System.IntPtr``，因此必须显式构造。

    :param value: 原生窗口句柄数值。
    :return: ``System.IntPtr`` 实例。
    """
    import System

    return System.IntPtr(value)


def ensure_com_initialized() -> None:
    """确保当前线程已初始化 COM（WebView2 要求 STA 套间）。

    Qt 通常已在 GUI 线程初始化过 COM，这里做一次幂等兜底，
    避免换调用场景时出现 ``CO_E_NOTINITIALIZED``。任何失败都忽略。
    """
    try:
        import ctypes

        ctypes.windll.ole32.CoInitializeEx(None, 2)
    except Exception:  # noqa: BLE001
        pass


def learn_classes(item: cdp_bridge.CapturedResponse) -> int:
    """从被动捕获的响应里登记教学班档案。

    :param item: 一条捕获到的响应。
    :return: 本次新登记的条数。
    """
    data = item.json_or_none()
    if not data:
        return 0
    class_type = item.teaching_class_type()
    added = 0
    for course in data.get("dataList") or []:
        if not isinstance(course, dict):
            continue
        merged = dict(course)
        merged.setdefault("teachingClassType", class_type)
        if class_type:
            merged["teachingClassType"] = class_type
        candidates = [merged]
        for tc in course.get("tcList") or []:
            if isinstance(tc, dict):
                row = dict(course)
                row.update({k: v for k, v in tc.items() if v is not None})
                row["teachingClassType"] = class_type
                candidates.append(row)
        for row in candidates:
            tc_id = str(row.get("teachingClassID") or "").strip()
            if tc_id and tc_id not in KNOWN_CLASSES:
                KNOWN_CLASSES[tc_id] = row
                added += 1
    return added


def build_task_from_payload(payload_json: str) -> tm.GrabTask:
    """把网页按钮回传的数据解析成抢课任务对象。

    优先使用网页 DOM 上取到的字段；缺失的字段用**被动捕获到的接口数据**补全，
    其中 ``teachingClassType`` 直接来自捕获到的 ``querySetting``，因此类别是精确的。

    :param payload_json: 网页按钮回传的 JSON 字符串。
    :return: 已自动填充的 :class:`task_model.GrabTask`。
    """
    payload = json.loads(payload_json)
    tc_id = str(payload.get("teachingClassID", "")).strip()
    full = KNOWN_CLASSES.get(tc_id, {})

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


def open_task_dialog(payload_json: str) -> None:
    """把网页回传的数据变成「抢课任务」对话框并自动填充。

    :param payload_json: 网页按钮回传的 JSON 字符串。
    """
    from ui_main import TaskDialog

    task = build_task_from_payload(payload_json)
    print(f"\n[回传] 教学班ID = {task.teaching_class_id}")
    print(f"       课程 = {task.course_name}｜教师 = {task.teacher_name}｜课程号 = {task.course_number}"
          f"｜课程总号 = {task.course_total_number}")
    print(f"       类别 = {task.type_text}（来自被动捕获的 querySetting）")

    dialog = TaskDialog(task, [], LOGGER, None)
    accepted = dialog.exec() == QDialog.DialogCode.Accepted
    if accepted:
        created = dialog.result_task()
        print(f"[OK] 已创建抢课任务：{created.display_name}｜{created.type_text}｜"
              f"间隔 {created.poll_interval_ms}ms｜{created.full_policy_text}")
        print(f"     教学班ID = {created.teaching_class_id}（可在对话框里修改后再确认）")
    else:
        print("[取消] 已在对话框中取消，未创建任务")


def open_in_real_browser(state: dict) -> None:
    """把本次会话的 token + cookie 带到独立的真实 Edge 窗口里打开选课页。

    **为什么不能直接丢给系统默认浏览器**：站点接口鉴权要求 cookie 与 token
    属于**同一个会话**，而我们的会话在 WebView2 的独立 profile 里，日常浏览器的
    cookie 与之不匹配。因此这里的做法是：启动一个专用 profile 的 Edge
    （开 CDP 端口）→ 用 CDP ``Network.setCookie`` 把本会话的 cookie 写进去 →
    再用带 token 的地址导航。这样得到的是一个**功能完整的真实 Edge 窗口**，
    但它使用独立 profile，不会污染你日常浏览器的数据。

    :param state: 共享状态字典（``token`` / ``cookies``）。
    """
    token = str(state.get("token") or "")
    cookies = list(state.get("cookies") or [])
    if not token:
        print("[提示] 尚未取得会话（请先在内嵌网页里完成登录）")
        return
    print(f"\n[浏览器] 准备用本次会话打开真实浏览器窗口：cookie {len(cookies)} 条，token {token[:8]}…")
    threading.Thread(target=_open_in_real_browser_async, args=(state,), daemon=True).start()


def _open_in_real_browser_async(state: dict) -> None:
    """后台线程入口：跑异步的「打开真实浏览器」流程。

    :param state: 共享状态字典。
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_open_in_real_browser(state))
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 打开真实浏览器失败：{type(exc).__name__}: {exc}")
        traceback.print_exc()
    finally:
        loop.close()


async def _open_in_real_browser(state: dict) -> None:
    """异步实现：启动 Edge → 写入 cookie → 带 token 导航 → 校验登录态。

    :param state: 共享状态字典。
    """
    port = DEBUG_PORT + 10
    profile_dir = PROJECT_ROOT / ".edge_real_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    cdp_bridge.launch_edge(port, profile_dir, url="about:blank")
    try:
        version = await cdp_bridge.wait_for_cdp(port, timeout=40)
        print(f"    已启动：{version.get('Browser')}（独立 profile {profile_dir.name}）")
    except Exception as exc:  # noqa: BLE001
        print(f"    启动 Edge 失败：{exc}")
        return

    target = await cdp_bridge.pick_target(port, prefer_host="szu.edu.cn")
    async with cdp_bridge.CdpClient(target["webSocketDebuggerUrl"]) as cdp:
        await cdp.enable()
        written = await cdp.set_cookies(list(state.get("cookies") or []), config.BASE_URL)
        print(f"    已写入 {written} 条 cookie")
        await cdp.navigate(f"{GRAB_URL}?token={state.get('token')}")
        for _ in range(20):
            await asyncio.sleep(0.5)
            cards = await cdp.evaluate("document.querySelectorAll('.cv-course-card').length")
            if int(cards or 0) > 0:
                break
        title = await cdp.evaluate("document.title")
        href = await cdp.evaluate("location.href")
        print(f"    页面标题 = {title!r}")
        print(f"    页面地址 = {str(href)[:90]}")
        print(f"    课程卡片数 = {cards}")
        if int(cards or 0) > 0:
            print("[OK] 本次会话的 token + cookie 在真实浏览器里**可直接使用**（已登录状态）")
        else:
            print("[警告] 页面未渲染出课程卡片，可能未登录成功（可看窗口确认）")


def run_cdp_checks(results: dict[str, bool], state: dict) -> None:
    """后台线程入口：跑完 CDP 数据面检查。

    :param results: 结果字典，就地更新。
    :param state: 共享状态字典，用于通知 Qt 侧退出与投递网页回传。
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_cdp_checks(results, state))
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] CDP 检查异常：{type(exc).__name__}: {exc}")
        traceback.print_exc()
    finally:
        loop.close()
        state["done"] = True


async def _pump(cdp: cdp_bridge.CdpClient, state: dict, stats: dict, results: dict) -> None:
    """常驻消息泵：持续消费 CDP 事件与网页回传，保证点击后**立即**响应。

    之前把回传读取放在「被动捕获 15 秒」之后，导致窗口期内的点击最多要压 15 秒
    才被处理。现在改为独立协程常驻运行：

    * 每轮抓取响应体 → 登记教学班档案（供任务自动填充）；
    * 每轮取走 ``Runtime.bindingCalled`` → 立刻投递给 Qt 主线程弹窗；
    * 顺带定期刷新会话凭证缓存，供「在浏览器打开」按钮取用。

    :param cdp: CDP 会话。
    :param state: 共享状态字典（``inbox`` 队列 / 凭证缓存）。
    :param stats: 统计字典，就地更新。
    :param results: 结果字典，就地更新。
    """
    tick = 0
    while True:
        for item in await cdp.poll_responses():
            stats["total"] = stats.get("total", 0) + 1
            counts = stats.setdefault("counts", {})
            counts[item.endpoint] = counts.get(item.endpoint, 0) + 1
            if item.endpoint not in stats.setdefault("samples", {}):
                data = item.json_or_none()
                if data:
                    desc = f"code={data.get('code')!r} msg={data.get('msg')!r}"
                    data_list = data.get("dataList")
                    if isinstance(data_list, list):
                        desc += f" dataList={len(data_list)}条"
                    if item.teaching_class_type():
                        desc += f" teachingClassType={item.teaching_class_type()}"
                    stats["samples"][item.endpoint] = desc
            learn_classes(item)

        for payload in cdp.take_bindings(BINDING_NAME):
            state["clicked"] = True
            state["inbox"].put(payload)
            results["网页按钮回传Python并弹窗"] = True

        tick += 1
        if tick % 20 == 0:
            # 定期刷新凭证缓存（点击「在浏览器打开」时要用最新会话）
            try:
                state["token"] = await cdp.session_storage("token")
                state["cookies"] = await cdp.get_cookies([config.BASE_URL])
            except Exception:  # noqa: BLE001
                pass
        await asyncio.sleep(0.1)


async def _cdp_checks(results: dict[str, bool], state: dict) -> None:
    """通过 CDP 完成凭证读取、DOM 注入、被动捕获与网页按钮回传。

    :param results: 结果字典，就地更新。
    :param state: 共享状态字典（含 ``inbox`` 队列）。
    """
    print("\n=== [2] 连接 CDP ===")
    try:
        version = await cdp_bridge.wait_for_cdp(DEBUG_PORT, timeout=30)
        print(f"    [OK] {version.get('Browser')} (CDP {version.get('Protocol-Version')})")
        results["CDP 端口可达"] = True
    except Exception as exc:  # noqa: BLE001
        print(f"    [FAIL] {exc}")
        return

    target = await cdp_bridge.pick_target(DEBUG_PORT)
    print(f"    目标页面 = {str(target.get('url'))[:80]}")
    async with cdp_bridge.CdpClient(target["webSocketDebuggerUrl"]) as cdp:
        await cdp.enable()
        await cdp.add_binding(BINDING_NAME)

        print("\n=== [3] 执行 JS ===")
        for _ in range(20):
            href = str(await cdp.evaluate("location.href") or "")
            if "szu.edu.cn" in href:
                break
            await asyncio.sleep(0.5)
        print(f"    标题={await cdp.evaluate('document.title')!r}")
        print(f"    地址={str(await cdp.evaluate('location.href'))[:80]}")
        results["执行 JS"] = True

        print("\n=== [4] 等待登录，然后读取凭证 ===")
        token = ""
        deadline = time.monotonic() + CHECK_TIMEOUT
        while not token and time.monotonic() < deadline:
            token = await cdp.session_storage("token")
            if token:
                break
            print("    …请在窗口中完成统一身份认证登录", end="\r")
            await asyncio.sleep(2)
        print()
        print(f"    sessionStorage.token = {token[:10] + '…' if token else '(未取到)'}")
        cookie_header = await cdp.cookie_header(config.BASE_URL)
        names = [p.split("=")[0] for p in cookie_header.split("; ") if "=" in p]
        print(f"    Cookie 头长度 = {len(cookie_header)}，名称 = {names}")
        results["登录后读取 cookie"] = bool(cookie_header) and "JSESSIONID" in cookie_header
        state["token"] = token
        state["cookies"] = await cdp.get_cookies([config.BASE_URL])

        print("\n=== [5] 注入教学班ID、抢课按钮与卡片高度修正 ===")
        await cdp.inject_on_new_document(INJECT_PAGE_SCRIPT)
        if token:
            await cdp.navigate(f"{GRAB_URL}?token={token}")
        probe: dict = {}
        for _ in range(15):
            await asyncio.sleep(1)
            # 除了注册到新文档，还对**当前**文档立即执行一次（脚本幂等），双保险
            await cdp.evaluate(INJECT_PAGE_SCRIPT)
            probe = json.loads(str(await cdp.evaluate(INJECT_PROBE_SCRIPT)))
            if int(probe.get("tags", 0)) > 0 and int(probe.get("buttons", 0)) > 0:
                break
        print(f"    注入结果 = {json.dumps(probe, ensure_ascii=False)}")
        results["卡片显示教学班ID与抢课按钮"] = (
            int(probe.get("tags", 0)) > 0 and int(probe.get("buttons", 0)) > 0
        )
        if probe.get("sample"):
            print(f"    卡片上显示 = {probe['sample']}")
        diag = probe.get("diag") or {}
        print(f"    卡片高度 = {diag.get('cardHeight')}（原样式固定 210px，已覆盖为 252px）")
        print(f"    样式已注入 = {diag.get('styleInjected')}｜按钮绑定可用 = {diag.get('bindingAvailable')}")

        # 启动常驻消息泵：此后点按钮**立即**响应，不再等后续步骤
        stats: dict = {}
        pump = asyncio.create_task(_pump(cdp, state, stats, results))

        print("\n=== [6] 被动捕获接口响应（零额外请求）===")
        await asyncio.sleep(12)
        counts = stats.get("counts", {})
        samples = stats.get("samples", {})
        print(f"    捕获接口数 = {len(counts)}，总条数 = {stats.get('total', 0)}，"
              f"已知教学班 {len(KNOWN_CLASSES)} 个")
        for endpoint, count in sorted(counts.items()):
            print(f"      {endpoint} ×{count}" + (f"  {samples[endpoint]}" if endpoint in samples else ""))
        results["被动捕获接口响应"] = bool(KNOWN_CLASSES)

        print("\n=== [7] 点击网页上的「+ 添加到抢课任务」 ===")
        print("    请在网页里点击任意课程卡片上的蓝色按钮，Python 会**立即**弹出抢课任务窗口")
        end = time.monotonic() + CLICK_WAIT
        while time.monotonic() < end and not state.get("dialog_done"):
            await asyncio.sleep(0.2)
        if not state.get("clicked"):
            print("    [FAIL] 未收到网页按钮回传（超时）")
        pump.cancel()
        try:
            await pump
        except asyncio.CancelledError:
            pass


def main() -> int:
    """执行 spike。

    :return: 进程退出码。
    """
    global LOGGER
    CoreWebView2Environment, CoreWebView2EnvironmentOptions = load_webview2_types()
    LOGGER = Logger(log_dir=PROJECT_ROOT / "logs")

    results: dict[str, bool] = {
        "WebView2 内嵌到 Qt 窗口": False,
        "CDP 端口可达": False,
        "执行 JS": False,
        "登录后读取 cookie": False,
        "卡片显示教学班ID与抢课按钮": False,
        "被动捕获接口响应": False,
        "网页按钮回传Python并弹窗": False,
    }
    state: dict = {
        "env_task": None,
        "ctl_task": None,
        "controller": None,
        "done": False,
        "dialog_done": False,
        "inbox": queue.Queue(),
    }

    def current_ratio() -> float:
        """返回当前窗口的 DPI 缩放比。

        :return: 缩放比（至少 1.0）。
        """
        try:
            return float(window.devicePixelRatioF()) or 1.0
        except Exception:  # noqa: BLE001
            return 1.0

    def apply_bounds() -> None:
        """把 WebView2 绘制区域同步到容器尺寸（物理像素 + 缩放比）。"""
        controller = state.get("controller")
        if controller is None:
            return
        ratio = current_ratio()
        try:
            controller.Bounds = make_rect(0, 0, int(container.width() * ratio), int(container.height() * ratio))
            controller.RasterizationScale = ratio
        except Exception as exc:  # noqa: BLE001
            print(f"    [警告] 同步 Bounds 失败：{type(exc).__name__}: {exc}")

    app = QApplication(sys.argv)
    window = QMainWindow()
    window.setWindowTitle("B+ spike：WebView2 内嵌 + CDP + 网页按钮回传")
    window.resize(1180, 860)
    central = QWidget()
    layout = QVBoxLayout(central)
    layout.setContentsMargins(6, 6, 6, 6)

    toolbar = QHBoxLayout()
    hint = QLabel("正在创建内嵌 WebView2 …（若长时间无变化，请看控制台输出）")
    browser_button = QPushButton("在真实浏览器打开（用本次会话）")
    browser_button.setToolTip(
        "启动一个独立 profile 的 Edge，把本次会话的 token + cookie 写进去并打开选课页。\n"
        "不会影响你日常浏览器的数据。"
    )
    toolbar.addWidget(browser_button)
    toolbar.addWidget(hint, 1)
    layout.addLayout(toolbar)

    container = WebContainer(apply_bounds)
    container.setStyleSheet("background:#eee;")
    layout.addWidget(container, 1)
    window.setCentralWidget(central)
    window.show()
    app.processEvents()

    hwnd = int(container.winId())
    print("=== [1] 创建内嵌 WebView2 ===")
    print(f"    父窗口 HWND = {hwnd}，容器逻辑尺寸 = {container.width()}x{container.height()}，DPR = {current_ratio()}")

    options = CoreWebView2EnvironmentOptions()
    options.AdditionalBrowserArguments = f"--remote-debugging-port={DEBUG_PORT}"
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    ensure_com_initialized()
    state["env_task"] = CoreWebView2Environment.CreateAsync(None, str(PROFILE_DIR), options)

    def poll_task() -> None:
        """轮询 .NET Task 完成情况。

        刻意不阻塞等待：WebView2 的异步创建依赖调用线程的消息泵，阻塞会死锁；
        因此靠 Qt 事件循环持续泵消息并用定时器轮询完成状态。
        本函数是 Qt 槽函数，**必须吞掉所有异常**（PyQt 对槽内未捕获异常会 abort）。
        """
        try:
            env_task = state.get("env_task")
            ctl_task = state.get("ctl_task")
            if env_task is not None and env_task.IsCompleted:
                state["env_task"] = None
                try:
                    environment = env_task.Result
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"CreateAsync 失败：{exc}") from exc
                print("    CreateAsync 完成，正在创建 Controller …")
                state["ctl_task"] = environment.CreateCoreWebView2ControllerAsync(to_intptr(hwnd))
            elif ctl_task is not None and ctl_task.IsCompleted:
                state["ctl_task"] = None
                try:
                    controller = ctl_task.Result
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"CreateControllerAsync 失败：{exc}") from exc
                state["controller"] = controller
                try:
                    controller.IsVisible = True
                except Exception:  # noqa: BLE001
                    pass
                apply_bounds()
                results["WebView2 内嵌到 Qt 窗口"] = True
                hint.setText("内嵌 WebView2 已就绪：请登录，然后点击卡片上的「+ 添加到抢课任务」")
                print("    [OK] Controller 创建成功，Bounds 已同步")
                controller.CoreWebView2.Navigate(GRAB_URL)
                threading.Thread(target=run_cdp_checks, args=(results, state), daemon=True).start()
                task_timer.stop()
        except Exception as exc:  # noqa: BLE001 - 槽函数绝不能抛出
            task_timer.stop()
            state["error"] = f"{type(exc).__name__}: {exc}"
            print(f"[FAIL] 创建内嵌 WebView2 失败：{state['error']}")
            traceback.print_exc()

    task_timer = QTimer()
    task_timer.setInterval(60)
    task_timer.timeout.connect(poll_task)
    task_timer.start()

    def drain_inbox() -> None:
        """在 Qt 主线程消费网页回传，弹出抢课任务对话框。"""
        try:
            payload = state["inbox"].get_nowait()
        except queue.Empty:
            return
        try:
            open_task_dialog(payload)
        except Exception as exc:  # noqa: BLE001 - 槽函数绝不能抛出
            print(f"[FAIL] 打开抢课任务窗口失败：{type(exc).__name__}: {exc}")
            traceback.print_exc()
        finally:
            state["dialog_done"] = True

    inbox_timer = QTimer()
    inbox_timer.setInterval(80)
    inbox_timer.timeout.connect(drain_inbox)
    inbox_timer.start()

    browser_button.clicked.connect(lambda: open_in_real_browser(state))

    def watch() -> None:
        """收尾：后台任务结束或出错时退出，并防止整体卡死。"""
        if state.get("error"):
            print(f"[FAIL] {state['error']}")
            app.quit()
        elif state.get("done"):
            app.quit()
        elif time.monotonic() - state.setdefault("start", time.monotonic()) > CHECK_TIMEOUT + CLICK_WAIT + 120:
            print("[FAIL] 总时长超时，强制退出")
            app.quit()

    guard = QTimer()
    guard.setInterval(300)
    guard.timeout.connect(watch)
    guard.start()

    app.exec()

    controller = state.get("controller")
    if controller is not None:
        try:
            controller.Close()
        except Exception:  # noqa: BLE001
            pass

    print("\n=== spike 结论 ===")
    for name, ok in results.items():
        print(f"    {'[OK]' if ok else '[FAIL]'} {name}")
    all_ok = all(results.values())
    print("\n全部通过：B+ 路线可行。" if all_ok else "\n存在未通过项，见上面逐项说明。")
    print(f"已知教学班档案 = {len(KNOWN_CLASSES)} 个")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
