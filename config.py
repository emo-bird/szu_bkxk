# -*- coding: utf-8 -*-
"""全局配置模块：集中定义常量、路径与开发开关。

本模块是依赖链最底层模块，不导入项目内其他任何模块，便于后续统一修改阈值。

功能：
    - 站点地址与各接口路径常量（接口路径来自参考仓库，**待抓包校验**）；
    - 全局请求队列限流常量（``REQUEST_INTERVAL_MS`` / ``MAX_QUEUE_SIZE``）；
    - 【重要】开发开关 ``ENABLE_WRITE_API``：控制是否允许真实发起选课/退课写请求；
    - 课程缓存、任务配置、日志文件的本地路径常量；
    - 日志来源模块名、日志分类常量。

--------------------------------------------------------------------------
⚠️ 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、
账号限制风险；禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# 程序目录：可写产物（日志 / 缓存 / 任务配置 / 浏览器 profile）都放这里。
# - 开发运行时 = 项目根目录；
# - PyInstaller 打包后 = exe 所在目录（**不能**用 __file__，否则：
#   onefile 会落到临时解包目录、退出即丢；onedir 会落到 _internal 里）。
APP_DIR: Path = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)

#: 项目根目录（等价于程序目录，保留此别名以兼容既有引用）
PROJECT_ROOT: Path = APP_DIR

# 资源目录：随程序分发、只读（WebView2 SDK 等由 --add-data 打进包里）。
# 打包后为 PyInstaller 解包目录（sys._MEIPASS），开发时同程序目录。
RESOURCE_DIR: Path = Path(getattr(sys, "_MEIPASS", str(APP_DIR)))

# ---------------------------------------------------------------------------
# 外部设置文件（**打包后无需重新打包即可调整开关**）
# ---------------------------------------------------------------------------
# 打包后本模块被编译进 exe，改源码必须重新打包；为了让**成品**也能调整开关，
# 这里支持一个可选的外部设置文件：程序目录（exe 同级）下的 settings.json。
#
#   {"enable_write_api": true}
#
# 也支持一次性环境变量（优先于文件）：SZUBKXK_ENABLE_WRITE_API=1
# 文件缺失 / 格式错误 / 值无法识别时**一律退回安全默认值 False**。
SETTINGS_FILE: Path = APP_DIR / "settings.json"


def _read_settings() -> dict:
    """读取程序目录下的 settings.json。

    :return: 设置字典；文件不存在或无法解析时返回空字典。
    """
    try:
        if not SETTINGS_FILE.exists():
            return {}
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _as_bool(value: object, default: bool = False) -> bool:
    """把设置值严格解析为布尔。

    刻意不用 ``bool(value)``：否则字符串 ``"false"`` 会被判为真，
    这是安全开关上最危险的一类错误。

    :param value: 原始值。
    :param default: 无法识别时的返回值。
    :return: 解析结果。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "y", "on"}:
            return True
        if text in {"0", "false", "no", "n", "off"}:
            return False
    return default


#: 外部设置内容（只读快照）
SETTINGS: dict = _read_settings()

#: 写接口开关的当前来源说明（用于启动弹窗与日志，便于确认是谁打开的）
WRITE_API_SOURCE: str = (
    "环境变量 SZUBKXK_ENABLE_WRITE_API"
    if os.environ.get("SZUBKXK_ENABLE_WRITE_API") is not None
    else (f"设置文件 {SETTINGS_FILE.name}" if "enable_write_api" in SETTINGS else "源码默认值（关闭）")
)

# ---------------------------------------------------------------------------
# 应用信息
# ---------------------------------------------------------------------------
APP_NAME: str = "深大选课辅助工具"
APP_VERSION: str = "0.2.0"

# 启动风险提示弹窗正文，main.py 直接复用，避免文案分散
RISK_WARNING_TEXT: str = (
    "警告：本程序仅用于技术学习研究。\n\n"
    "直接高频调用学校选课接口有触发风控、账号限制风险；\n"
    "禁止用于大规模恶意抢课；\n"
    "一切使用行为与风险由使用者本人承担；\n\n"
    "开发、求证、测试阶段禁止调用选课、退课接口。\n"
    "选课写接口当前已被总开关禁用（ENABLE_WRITE_API=False），"
    "仅输出请求报文模板，不会发出真实请求。"
)

# ---------------------------------------------------------------------------
# 站点与接口路径
# ---------------------------------------------------------------------------
BASE_URL: str = "http://bkxk.szu.edu.cn/"
SITE_HOME_URL: str = BASE_URL
CAMPUS: str = "01"

# 课程查询（方案内/方案外/体育/辅修）
EP_PROGRAM_COURSE: str = "xsxkapp/sys/xsxkapp/elective/programCourse.do"
# 课程查询（本班课程 TJKC）
EP_RECOMMENDED_COURSE: str = "xsxkapp/sys/xsxkapp/elective/recommendedCourse.do"
# 课程查询（校公选课 XGXK / 慕课 MOOC）—— 注意与 programCourse.do 不同
EP_PUBLIC_COURSE: str = "xsxkapp/sys/xsxkapp/elective/publicCourse.do"
# 已选课程结果查询
EP_COURSE_RESULT: str = "xsxkapp/sys/xsxkapp/elective/courseResult.do"
# 选课提交（写接口，默认禁用）
EP_VOLUNTEER: str = "xsxkapp/sys/xsxkapp/elective/volunteer.do"
# 课程收藏（写操作，见 docs/TODO.md，暂未接入）
EP_FAVORITE: str = "xsxkapp/sys/xsxkapp/elective/favorite.do"
# 选课批次查询（公开接口，返回 schoolTerm 等）
EP_BATCH: str = "xsxkapp/sys/xsxkapp/elective/batch.do"
# 选课入口页（备查，本工具不实现登录）
EP_INDEX: str = "xsxkapp/sys/xsxkapp/*default/index.do"
# 选课子页面：站点 JS 实测「必须带 token 参数」才能进入
# 见 index.min.js: window.location.href = BaseUrl + "/sys/xsxkapp/*default/grablessons.do?token=" + sessionStorage.token
EP_GRABLESSONS_PAGE: str = "xsxkapp/sys/xsxkapp/*default/grablessons.do"

# teachingClassType 取值与中文名
TEACHING_CLASS_TYPES: dict[str, str] = {
    "FANKC": "方案内课程",
    "FAWKC": "方案外课程",
    "TJKC": "本班课程",
    "XGXK": "校公选课",
    "TYKC": "体育课程",
    "FXKC": "辅修课程",
    "MOOC": "慕课",
}

# 【抓包实测】课程类别 → (查询接口, queryContent) 映射。
# 依据 docs/har.json 中已登录会话的真实请求逐条核对得出：
# 校公选课/慕课走 publicCourse.do 而非 programCourse.do；
# 体育课程不查 MOOC；慕课的 MOOC 参数为 1 而非 2。
COURSE_QUERY_PLAN: dict[str, tuple[str, str]] = {
    "FANKC": (EP_PROGRAM_COURSE, "YCJX:2,MOOC:2,"),
    "FAWKC": (EP_PROGRAM_COURSE, "YCJX:2,MOOC:2,"),
    "TYKC": (EP_PROGRAM_COURSE, "YCJX:2,"),
    "FXKC": (EP_PROGRAM_COURSE, "YCJX:2,MOOC:2,"),
    "TJKC": (EP_RECOMMENDED_COURSE, "YCJX:2,MOOC:2,"),
    "XGXK": (EP_PUBLIC_COURSE, "YCJX:2,MOOC:2,"),
    "MOOC": (EP_PUBLIC_COURSE, "YCJX:2,MOOC:1,"),
}

# 【抓包实测】服务器 pageNumber 为 **0 基**：pageNumber=0 才是第 1 页。
QUERY_FIRST_PAGE: int = 0
# 查询分页大小（与浏览器一致）
QUERY_PAGE_SIZE: int = 10
# 单个课程类别最多翻页数量，防止异常响应导致请求失控（待抓包校验后调整）
QUERY_MAX_PAGES: int = 5

# ---------------------------------------------------------------------------
# 全局限流常量【硬性约束，勿随意调小】
# ---------------------------------------------------------------------------
# 单条请求最小调度间隔（毫秒）：1 秒内最多 2 条请求
REQUEST_INTERVAL_MS: int = 500
# 请求队列最大待处理请求数量上限，超出直接丢弃
MAX_QUEUE_SIZE: int = 10
# 单条 http 请求超时时间（秒）
REQUEST_TIMEOUT_SECONDS: float = 10.0

# 请求优先级：数值越小越先被调度
PRIORITY_HIGH: int = 0   # 用户手动触发的 UI 操作（手动刷新课容量、手动收藏等）
PRIORITY_NORMAL: int = 10  # 自动抢课轮询产生的后台请求

# ---------------------------------------------------------------------------
# 抢课任务轮询
# ---------------------------------------------------------------------------
# 单任务轮询间隔下限（毫秒）：小于该值会被自动钳位，等同于全局限流间隔
MIN_POLL_INTERVAL_MS: int = REQUEST_INTERVAL_MS
# 新建任务的默认轮询间隔（毫秒）
DEFAULT_POLL_INTERVAL_MS: int = 1500

# ---------------------------------------------------------------------------
# 【重要】开发开关
# ---------------------------------------------------------------------------
# 【重要】开发求证阶段必须保持False；改为True才会真实发起选课/退课写接口请求
# 优先级：环境变量 > settings.json > 源码默认值（False）
ENABLE_WRITE_API: bool = _as_bool(
    os.environ.get("SZUBKXK_ENABLE_WRITE_API"),
    _as_bool(SETTINGS.get("enable_write_api"), False),
)

# ---------------------------------------------------------------------------
# 内嵌选课网页（WebView2 + CDP）
# ---------------------------------------------------------------------------
# 总开关：关闭或环境不支持时，程序退化为纯 aiohttp 模式（不影响抢课功能）
ENABLE_EMBEDDED_WEBVIEW: bool = True
# 是否显示「课程查询」标签页。默认隐藏：凭证已由内嵌网页自动填充、课程也由它被动带来；
# 若内嵌网页不可用，程序会**自动重新显示**该标签页，保证仍能手工填凭证与刷新查询。
SHOW_COURSE_QUERY_TAB: bool = False
# 内嵌 WebView2 的 CDP 调试端口（数据面全部走 CDP）
WEBVIEW_DEBUG_PORT: int = 9340
# WebView2 用户数据目录（保存登录态；已 gitignore，绝不入库）
WEBVIEW_PROFILE_DIR: Path = PROJECT_ROOT / ".webview2_profile"
# 官方 WebView2 SDK 解压位置（Core.dll / WinForms.dll / WebView2Loader.dll）
# 注意用 RESOURCE_DIR：SDK 是打包进来的只读资源，不属于可写程序目录
WEBVIEW_SDK_DIR: Path = RESOURCE_DIR / "vendor" / "webview2"
# 网页 → Python 回传绑定的函数名
WEBVIEW_BINDING_NAME: str = "__szuAddTask"
# 站点卡片原样式是固定 210px 高且无溢出处理，追加「教学班ID」后会撑破卡片
WEBVIEW_CARD_HEIGHT_PX: int = 252
# 选课子页面（内嵌页与「真实浏览器」都打开它）
WEBVIEW_PAGE_URL: str = BASE_URL + EP_GRABLESSONS_PAGE
# 「在真实浏览器打开」用的独立 Edge 端口与 profile（同样不入库）
# 「重新载入选课页」按钮的冷却时间（毫秒）。
# 页面导航不受 API 限流队列约束，加冷却避免误连点导致密集页面加载。
WEBVIEW_RELOAD_COOLDOWN_MS: int = 1500
REAL_BROWSER_DEBUG_PORT: int = 9350
REAL_BROWSER_PROFILE_DIR: Path = PROJECT_ROOT / ".edge_real_profile"

# ---------------------------------------------------------------------------
# 本地文件路径
# ---------------------------------------------------------------------------
# 课程列表缓存（仅接口拉取成功才覆盖）
COURSE_CACHE_FILE: Path = PROJECT_ROOT / "courses_cache.json"
# 抢课任务配置
TASK_CONFIG_FILE: Path = PROJECT_ROOT / "tasks_config.json"
# 日志目录
LOG_DIR: Path = PROJECT_ROOT / "logs"
LOG_FILE_PREFIX: str = "app"
LOG_FILE_SUFFIX: str = ".log"

# 课程缓存 / 任务配置的 JSON 结构版本号，便于后续兼容旧文件
COURSE_CACHE_FORMAT_VERSION: int = 1
TASK_CONFIG_FORMAT_VERSION: int = 1

# 日志时间格式
LOG_TIME_FORMAT: str = "%Y-%m-%d %H:%M:%S"
LOG_FILE_DATE_FORMAT: str = "%Y%m%d"
# UI 日志面板最多保留的日志行数，防止长时间运行内存膨胀
UI_LOG_MAX_LINES: int = 5000

# ---------------------------------------------------------------------------
# 日志来源模块与分类
# ---------------------------------------------------------------------------
SOURCE_COURSE: str = "课程查询"
SOURCE_TASK: str = "抢课任务"
SOURCE_FAVORITE: str = "收藏"
SOURCE_SYSTEM: str = "系统"
SOURCE_QUEUE: str = "请求队列"

LOG_SOURCES: tuple[str, ...] = (
    SOURCE_COURSE,
    SOURCE_TASK,
    SOURCE_FAVORITE,
    SOURCE_SYSTEM,
    SOURCE_QUEUE,
)

CATEGORY_SUCCESS: str = "抢课成功"
CATEGORY_FAILURE: str = "抢课失败"
CATEGORY_QUERY: str = "查询信息"
CATEGORY_SYSTEM: str = "系统信息"
CATEGORY_QUEUE: str = "队列调度"

LOG_CATEGORIES: tuple[str, ...] = (
    CATEGORY_SUCCESS,
    CATEGORY_FAILURE,
    CATEGORY_QUERY,
    CATEGORY_SYSTEM,
    CATEGORY_QUEUE,
)

# 日志等级（仅用于文件与 UI 前缀展示）
LEVEL_INFO: str = "INFO"
LEVEL_WARNING: str = "WARN"
LEVEL_ERROR: str = "ERROR"

# ---------------------------------------------------------------------------
# HTTP 请求头（不含凭证；凭证由 api_client 按接口需要动态拼装）
# 参考 szu/setting.py，**待抓包修正**
# ---------------------------------------------------------------------------
USER_AGENT: str = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Host": "bkxk.szu.edu.cn",
    "Pragma": "no-cache",
    # 站点 jQuery 默认携带；带上后未登录会返回 401 而不是静默跳转到首页，
    # 便于程序准确判定「登录态失效」
    "X-Requested-With": "XMLHttpRequest",
}
