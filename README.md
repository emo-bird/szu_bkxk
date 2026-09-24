# szu_bkxk v0.3.1

SZU选课脚本（UI）

深大选课网站（<http://bkxk.szu.edu.cn/>）异步抢课辅助工具 —— PyQt6 图形界面原型，
**开发求证草稿版，非成品交付**。代码用途仅限技术学习与研究。

---

## ⚠️ 风险与使用声明（重要）

> 警告：本程序仅用于技术学习研究。直接高频调用学校选课接口有触发风控、账号限制风险；
> 禁止用于大规模恶意抢课；一切使用行为与风险由使用者本人承担；
> **开发、求证、测试阶段禁止调用选课、退课接口**。

具体红线（贯穿编码、调试、求证全过程）：

1. 选课 / 退课写接口**只做请求报文构造**，由 `config.ENABLE_WRITE_API` 总开关控制，
   默认 `False`（只打印报文、写日志，**不发出任何真实 HTTP 请求**）。
2. 开发求证阶段不得主动发起真实写接口调用。
3. 测试用的学号 / cookie / token 等参数**只允许用于构造示例报文**，
   不得硬编码进业务代码，也不得用于发送真实请求。
4. 凭证（studentCode / electiveBatchCode / cookie / token）全部由用户从浏览器登录后
   复制粘贴输入，程序**不实现登录、不处理人机验证码**，也**不把凭证写入本地文件**。

---

## 一、当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | `config.py` 常量/路径/开发开关、`auth_model.py` 凭证模型 | ✅ 完成 |
| P2 | `logger_util.py` 日志（文件 + 面板双写、分类过滤） | ✅ 完成 |
| P3 | `request_queue.py` 全局异步优先级限流队列 | ✅ 完成 |
| P4 | `api_client.py` aiohttp 封装、报文构造、写接口禁用 | ✅ 完成 |
| P5 | `course_model.py` + 标签页1 课程查询面板 | ✅ 完成 |
| P6 | `task_model.py` + 标签页2 抢课任务管理器 | ✅ 完成 |
| P7 | 标签页3 日志面板、`main.py` 入口与风险弹窗 | ✅ 完成 |
| P8 | 课程收藏接口 | ⏸ **TODO**（接口已定位：`elective/favorite.do`，见 [`docs/接口逆向记录.md`](docs/接口逆向记录.md) 3.4） |
| **B+** | **内嵌选课网页（WebView2 + CDP）** | ✅ **已完成并合并到主分支**（v0.2.0） |

> **接口取证**：端点路径、token 传递位置、登录态失效时的服务器行为等，均已用**真实只读请求**
> 验证并记录在 [`docs/接口逆向记录.md`](docs/接口逆向记录.md)。
> 其中「跳转选课网页必须携带 token」已由站点 JS 原文证实。

> 接口字段与路径来自参考仓库 `szu/` 的逆向结论，**尚未经过浏览器抓包校验**；
> 代码中所有未校验点均标注 `TODO(抓包校验)`，课程字段解析采用多候选字段的容错映射
> （见 `course_model._FIELD_CANDIDATES`），拿到抓包样本后只需调整候选字段表。

## 二、环境要求

| 项目 | 要求 | 本项目已验证值 |
| --- | --- | --- |
| 操作系统 | Windows | Windows |
| Python | 3.10+（本机 3.14） | 3.14.7 |
| GUI | PyQt6 | 6.11.0 |
| 异步网络 | aiohttp（**需额外 pip 安装**） | 3.14.3 |
| 内嵌网页 | pythonnet + 官方 WebView2 SDK（**需额外安装**） | pythonnet 3.1.0 / SDK 1.0.4191.47 |
| 浏览器 | 系统自带 Edge / WebView2 Runtime | Edge 153 / WebView2 153 |
| 版本管理 | git | 2.54.0 |

`PyQt6` 之外**额外需要安装的依赖包**：

1. `aiohttp`：`.\.venv\Scripts\python.exe -m pip install aiohttp`
2. `pythonnet`：`.\.venv\Scripts\python.exe -m pip install pythonnet`
3. 官方 WebView2 SDK（内嵌网页需要，约 9MB，解压到 `vendor/webview2/`）：

   ```powershell
   $v = (Invoke-RestMethod https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json).versions[-1]
   Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$v/microsoft.web.webview2.$v.nupkg" -OutFile vendor.zip
   Expand-Archive vendor.zip -DestinationPath vendor/webview2 -Force
   Copy-Item vendor/webview2/runtimes/win-x64/native/WebView2Loader.dll vendor/webview2/lib/net462/ -Force
   Remove-Item vendor.zip
   ```

> 三项缺任一项，程序会在「选课网页」标签页提示不可用并**自动降级为纯 aiohttp 模式**，
> 抢课功能不受影响。

## 三、安装

```powershell
# 若 .venv 缺失或依赖不全，执行：
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install PyQt6 aiohttp
```

> 注意：`.venv` 由 `c:\Project\深大本科选课` 迁移而来，目录改名后 `.venv\Scripts\*.exe`
> 内记录的旧路径可能失效，请统一用 `.\.venv\Scripts\python.exe -m pip ...` 调用 pip。

## 四、运行

```powershell
.\.venv\Scripts\python.exe main.py
```

启动流程：控制台与弹窗同时输出风险提示 → 用户**主动点击同意**（默认按钮为「退出」）
→ 进入主界面。启动横幅会打印 `ENABLE_WRITE_API` 当前取值。

## 五、界面功能

### 标签页1｜选课网页（内嵌，**默认打开**）

- 用 **WebView2 把官方选课页内嵌**进程序，用户在内嵌页完成统一身份认证登录；
- **凭证自动读取**：从内嵌页读 cookie（含 HttpOnly）与整个 `sessionStorage`
  （`studentInfo` / `currentBatch`），自动填充 `studentCode` / `electiveBatchCode` /
  `cookie` / `token`，**不必再手工复制粘贴**；
- **课程卡片显示教学班ID**，并提供「**+ 添加到抢课任务**」按钮：点击后**立即**弹出
  已自动填充的抢课任务窗口（课程名 / 教师 / 课程号 / 课程总号 / 教学班ID / 类别；
  类别取自被动捕获的 `querySetting`，精确不猜）；
- **卡片高度修正**：站点原样式固定 `210px` 且未处理溢出，已注入 `252px` 覆盖；
- **零额外请求取数**：被动旁听页面自身的 XHR 响应体（`Network.getResponseBody`），
  解析后直接喂给「课程查询」标签页的表格；
- 「**在真实浏览器打开（用本次会话）**」：把本次会话的 cookie + `sessionStorage`
  写入一个**独立 profile** 的 Edge 并打开选课页（**不污染**日常浏览器数据）；
- 「重新载入选课页」会自动拼接本次会话的 `token`（站点要求该参数，否则报「系统异常」）。

> 抢课提交**仍由 Python 发出**，走 500ms 全局限流队列与 `ENABLE_WRITE_API` 守卫；
> 内嵌网页只负责登录、浏览与取数。

### 标签页2｜抢课任务管理器

- 任务**新增 / 修改 / 删除**，可配置：课程名称、教师、课程号、课程总号、教学班ID、课程类别、
  轮询间隔、满课策略（`满课后停止` / `满课继续轮询`）。
- 支持从课程列表下拉一键带出课程信息。
- 轮询间隔**下限为全局请求间隔**（代码硬下限 200ms，默认 500ms），小于该值自动钳位并输出告警日志。
- 任务状态：等待中 / 运行中 / 抢课成功 / 已停止 / 异常失败。
- 多任务异步独立运行，网络请求统一经全局限流队列。
- 任务配置持久化到 `tasks_config.json`；**重启后状态一律为「已停止」，不会自动运行**。
- 内嵌网页卡片上的「+ 添加到抢课任务」会直接入列并持久化。
- **两种任务类型各有独立列表与按钮**（任务管理器里上下两张表，字段各不相同）：

  | | 单志愿抢课 | 多志愿监控 |
  | --- | --- | --- |
  | 适用场景 | 只想要**这一个**志愿，不知道容量何时释放 | 有**多个**候选志愿，不知道**哪个**先释放容量 |
  | 新建按钮 | 「新建单志愿抢课任务」 | 「新建多志愿监控任务」 |
  | 主要字段 | 课程名称 / 教师 / 课程号 / 课程总号 / 教学班ID / 类别 / 轮询间隔 / 满课策略 | 备注名称 / **监控教学班清单** / 轮询间隔 |
  | 列表主要列 | 课程号、教学班ID、类别、满课策略… | 监控教学班ID、命中教学班… |
  | 停止条件 | 可选「满课后停止」 | **不因满课停止**（等放量），命中提交成功即结束 |

  - 监控清单**只填教学班ID**（一行一个，可从课程列表连续选择自动追加、自动去重）——
    教学班ID 全局唯一，**类别由程序自动识别**：先查本地课程缓存，查不到再逐类别试探一次并记住结果；
  - 每轮**只刷新这些教学班所属的类别**（同类别的多个目标只拉取一次），逐个检查容量；
  - 命中的**第一个**用 `config.PRIORITY_MONITOR_HIT = -10` 提交，**高于**手动操作的
    `PRIORITY_HIGH = 0`，会插到队列最前面；同轮其余命中按普通优先级；被业务拒绝则顺延下一个；
  - 监控目标上限 `config.MONITOR_MAX_CLASSES`（20 个）；
  - 「从课程列表选择」下拉已标注字段名（教师 / 课程号 / 教学班ID / 容量），避免两串数字连读；
  - 写接口仍受 `ENABLE_WRITE_API` 总开关约束：关闭时只打印报文，不会真实提交。

### 标签页3｜日志面板

- 日志格式 `[时间戳] [来源模块] 日志内容`，告警/错误额外带 `[告警]`/`[错误]` 前缀。
- 分类过滤复选框：抢课成功 / 抢课失败 / 查询信息 / 系统信息 / 队列调度
  —— 过滤**只影响面板展示**，日志文件始终记录全部分类。
- 日志同时写入 `logs/app_YYYYMMDD.log`（按天切分）。

### 标签页4｜课程查询（默认隐藏）

> 「**课程查询**」标签页移到**最后**并**默认隐藏**（`config.SHOW_COURSE_QUERY_TAB = False`）：
> 凭证已由内嵌网页自动填充、课程也由它被动带来，控件与逻辑完整保留；
> **若内嵌网页不可用会自动重新显示**，保证仍能手工填凭证与刷新查询。

- **身份凭证区**：`studentCode` / `electiveBatchCode` / `cookie`（支持多行粘贴，自动拼接为 `; `）/
  `token`；提供「校验凭证」「清空凭证」。输入实时写入内存凭证对象，**不落盘**。
  内嵌网页登录后这里会被**自动填充**。
- **课程表格**：课程号、课程总号、课程名称、课程类别、课程性质、开课单位、学分、课程时间、
  是否 MOOC、已选人数 / 总人数；「显示列」按钮可自由勾选列显隐。
- **筛选**：课程名 / 教师 / 课程号模糊搜索、类别、是否 MOOC、只看有余量（纯内存过滤）。
- **刷新查询**：**最高优先级**请求，逐个类别拉取（单类别最多 `config.QUERY_MAX_PAGES` 页）；
  拉取成功后覆盖本地缓存。
- **跳转选课网页**：调用系统默认浏览器打开 `http://bkxk.szu.edu.cn/`。
- **收藏**：按钮暂置灰，等待 P8 接入。
- 启动时优先展示本地缓存课程列表（缓存记录保存时间）。

## 六、模块职责

```
szu_bkxk/
├─ config.py          全部常量、路径、开发开关（ENABLE_WRITE_API）
├─ auth_model.py      身份凭证模型（空值校验、脱敏、sessionStorage 模拟）
├─ logger_util.py     日志工具（文件落盘 + UI 推送 + 分类过滤）
├─ request_queue.py   全局异步优先级限流请求队列（唯一 http 调度出口）
├─ api_client.py      aiohttp 封装层、各接口报文构造、写接口总开关
├─ course_model.py    课程模型、容错字段映射、筛选、本地缓存读写
├─ task_model.py      抢课任务模型、持久化、轮询执行器
├─ ui_main.py         PyQt6 主窗口、四个标签页、信号槽与跨线程调度
├─ main.py            入口：风险弹窗、模块初始化、Qt + asyncio 双事件循环
├─ webview_host.py    内嵌 WebView2 窗口宿主（pythonnet + Core API，只管窗口不碰数据）
├─ webview_bridge.py  内嵌网页数据面（CDP 泵、页面注入、课程回流、会话迁移）
├─ cdp_bridge.py      CDP 客户端（零依赖，复用 aiohttp 的 WebSocket）
├─ tools/             只读接口探测工具与可行性 spike（probe_api.py / spike_*.py）
├─ docs/              需求文档、开发准备、接口逆向记录、TODO
└─ szu/               参考仓库（只读参考，已在 .gitignore 排除）
```

依赖方向：`main → ui_main → {task_model → api_client → request_queue → aiohttp,
course_model}`，`ui_main` 不构造任何 http 报文。

## 七、限流与线程模型

- 常量集中在 `config.py`：`REQUEST_INTERVAL_MS = 500`、`MAX_QUEUE_SIZE = 10`。
- **单调度协程**每 500ms 取出 1 条请求执行（≈ 1 秒最多 2 条）；队列满则**直接丢弃**并告警，
  不阻塞界面。
- 优先级：`PRIORITY_HIGH`（用户手动 UI 操作）> `PRIORITY_NORMAL`（抢课轮询后台请求）。
- Qt 主线程只做渲染；网络逻辑运行在独立 asyncio 线程，通过 `UiBridge` 的 Qt 信号回传结果。

## 八、接口清单

完整报文模板、字段映射推测与校验状态见 [`docs/开发准备.md`](docs/开发准备.md) 第四节；
真实探测所得的服务器行为证据见 [`docs/接口逆向记录.md`](docs/接口逆向记录.md)。
**收藏接口在参考仓库中缺失，尚未逆向（已列入 TODO）。**

已实测确认的关键结论：

1. 端点基路径 `xsxkapp/sys/xsxkapp/` **正确**（`elective/batch.do`、`publicinfo/sysparam.do`
   返回 200 JSON）；
2. 接口调用的 token 走 **HTTP 请求头 `token`**，且每个接口 URL 需附加 `?timestamp=<毫秒>`；
3. **页面跳转**的 token 走 **URL query**：`*default/grablessons.do?token=<token>`；
4. 登录态失效时服务器 **302 → 首页**（普通请求）或 **401 + HTML**（AJAX 请求），
   程序已据此准确报错，不再误报为 JSON 解析错误。

## 九、本地文件

| 文件 | 用途 | 是否入库 |
| --- | --- | --- |
| `courses_cache.json` | 课程列表缓存（仅拉取成功才覆盖） | 否（已 gitignore） |
| `tasks_config.json` | 抢课任务配置 | 否（已 gitignore） |
| `logs/app_YYYYMMDD.log` | 运行日志 | 否（已 gitignore） |

凭证**不写入任何本地文件**。

## 十、开发约定

1. 所有 aiohttp 请求**必须**经过全局请求队列，禁止绕过限流直接发请求。
2. 每个模块、类、公开函数均需文档字符串，说明入参、返回值与功能。
3. 数据持久化统一 JSON，读写均捕获异常并写日志，不因 IO 错误崩溃。
4. 每完成一块独立功能单独提交一次 git commit，提交信息说明本次变更内容。

## 十一、环境问题修复记录：shell 执行无需再提权

**现象**：本会话中任何 shell / 代码执行请求都直接失败，报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\Project\szu_bkxk)`，
且不论工作目录设为何处都相同。

**根因**：工作区目录的 DACL 中存在一条异常访问控制项
（`NT AUTHORITY\Authenticated Users  Allow  -536805376`，权限位无法解析），
导致沙箱为工作区「授予写权限」的调用被系统拒绝（Win32 5 = 拒绝访问）。
与虚拟环境无关 —— `.venv` 本身是正常的（aiohttp 安装与全部自动化测试都跑通）。

**修复**（已执行，无需再次操作）：

```powershell
# 1) 备份原 DACL（便于回滚）
icacls C:\Project\szu_bkxk /save "$env:TEMP\szu_bkxk_dacl_backup.txt"
# 2) 为当前用户显式授予完全控制（含继承）
icacls C:\Project\szu_bkxk /grant "<用户名>:(OI)(CI)F"
```

如需回滚：

```powershell
icacls C:\Project /restore "$env:TEMP\szu_bkxk_dacl_backup.txt"
```

**结论**：`.venv` **无需重建**；shell 与代码执行已恢复正常。

## 十二、版本记录

| 版本 | 要点 |
| --- | --- |
| **0.3.1** | · 任务管理器改为**两种类型各一张独立列表**（按钮与字段都分开）：单志愿抢课列表、多志愿监控列表<br>· 监控清单**只需填教学班ID**，类别由程序自动识别（课程缓存 → 逐类别试探并记住），不再需要手填类别代码<br>· 监控模式从课程列表选择时**追加**教学班ID（自动去重）<br>· 「从课程列表选择」下拉标注字段名与分隔符；类别识别不出来时继续监控（刷新课程列表后自愈）而非直接停止 |
| **0.3.0** | · 新增**多志愿监控任务**：多个候选教学班轮流检查容量（只刷新所属类别），命中的第一个用最高优先级插队提交，成功即结束、不因满课停止<br>· 写接口按 `docs/har.json` **实测**实现：抢课 `volunteer.do`、退课 `deleteVolunteer.do`、查容量 `teachingclass/capacity.do`；响应按 `code` 分类（1 成功 / 2 业务拒绝 / 302 登录失效 / **其它→未识别**）<br>· **未识别返回全量落日志**（标记 `[未识别返回]`，含请求体+响应原文），便于后续开发补分支<br>· 修复日志分类筛选无效（改为面板全量缓存+即时重绘，文件仍记录全部分类）<br>· 限流硬下限降至 200ms（默认仍 500ms）<br>· 新增 `settings.json` / `settings_default.json` 共 13 项运行期设置 |
| **0.2.0** | 合并「内嵌选课网页（WebView2 + CDP）」：<br>· 内嵌官方选课页，登录后**凭证自动读取**（cookie 含 HttpOnly + 整个 `sessionStorage`），不再手工粘贴<br>· 课程卡片显示**教学班ID**、卡片高度修正、一键「**+ 添加到抢课任务**」（自动填充任务窗口）<br>· **被动捕获**页面自身 XHR（零额外请求）→ 课程表格<br>· 「**在真实浏览器打开（用本次会话）**」：cookie + `sessionStorage` 迁移到独立 profile 的 Edge<br>· 标签页顺序：选课网页置首并默认打开；课程查询移到最后并默认隐藏（降级时自动恢复）<br>· 抢课提交仍由 Python 发出（500ms 限流队列 + `ENABLE_WRITE_API` 守卫） |
| 0.1.0 | 纯 aiohttp/PyQt6 版本：凭证手工粘贴、课程查询表格、抢课任务管理器、日志面板；<br>接口映射与分页语义按真实抓包校正（`pageNumber` 为 0 基等） |

### 分支说明

- `master`：主线，v0.2.0 起包含内嵌选课网页功能。
- `feature/webview2-embedded`：该功能的开发分支（自「开始尝试内嵌网页」起的全部提交），已通过 `--no-ff` 合并回 `master`，保留合并记录便于整块回退。
- 最初的「外部 Edge + CDP」可行性 spike 也随该分支进入主线，作为**回退方案**保留：
  `tools/spike_edge_login.py` 与内嵌方案共用同一套 `cdp_bridge`。

## 十三、打包（可选）

双击 **`build.bat`** 即可打包（脚本只打包，不会运行程序、不会访问学校站点）：

```bat
:: 等价的手工命令（在项目根目录执行）
.venv\Scripts\python.exe -m PyInstaller ^
  --noconfirm --clean --windowed --name szu_bkxk ^
  --distpath build --workpath build\_work ^
  --add-data "vendor\webview2;vendor\webview2" ^
  --collect-all pythonnet --collect-all clr_loader ^
  --hidden-import clr ^
  main.py
```

产物为 **`build\szu_bkxk\szu_bkxk.exe`**；**整个 `build\szu_bkxk` 目录都要保留**，不能只拷贝 exe。

> `build/` 与 `dist/` 都在 `.gitignore` 里 —— 二进制产物**不进版本库**，发布时请把 `build\szu_bkxk` 目录单独打包（zip）分发。

| 参数 | 作用 |
| --- | --- |
| `--add-data "vendor\webview2;vendor\webview2"` | 把 WebView2 SDK 打进包（缺了会自动降级为纯 aiohttp 模式） |
| `--collect-all pythonnet` / `clr_loader` | pythonnet 的托管 DLL 与运行时加载器必须整体收集，否则内嵌网页起不来 |
| `--hidden-import clr` | `import clr` 是运行时动态导入，静态分析看不到 |
| `--windowed` | 不带控制台窗口；排错时改成 `--console` 可看到启动期报错 |
| `--distpath build` `--workpath build\_work` | 产物放到 `build\`（中间文件放 `build\_work\`，避免混在一起） |

> 打包后 **可写产物**（`logs/`、`courses_cache.json`、`tasks_config.json`、浏览器 profile）
> 都写在 **exe 所在目录**；只读资源（WebView2 SDK）在包内。这一点由 `config.APP_DIR`
> 与 `config.RESOURCE_DIR` 区分处理，开发运行时两者都等于项目根目录。

### 发布到 GitHub（可选）

打包完成后，一条命令即可创建/更新 GitHub 发行并上传成品 zip：

```powershell
# 1) 让脚本能访问 GitHub API（Windows 上 git 已存好凭据时可直接取出）
$env:GH_TOKEN = ((('protocol=https`nhost=github.com`n`n' | git credential fill) |
    Select-String '^password=') -replace '^password=','').Trim()

# 2) 发布（版本号取自 config.APP_VERSION，tag 为 v<版本>）
.\.venv\Scripts\python.exe tools\publish_release.py
```

脚本会自动：读版本号 → 推送 tag → 创建/更新发行（说明取自 `build\release_notes.md`）→
上传 `build\szu_bkxk-v<版本>-win64.zip`。**同名发行已存在则更新说明、附件已存在则跳过上传**，
可反复安全执行。凭据只从环境变量读取，不会打印或写盘。

> 手工等价操作：`git tag -a v0.3.1 -m "..."` → `git push origin v0.3.1` →
> 在 GitHub 上点「Create release」并上传 zip。

## 十四、运行期设置（打包后无需重新打包）

`config.py` 打包后会被**编译进 exe**，所以改 exe 旁边的 `.py` 文件无效。程序启动时会读取
**与 exe 同级目录**下的 `settings.json`：

| 运行方式 | 设置文件位置 |
| --- | --- |
| 打包成品 | `build\szu_bkxk\settings.json`（由 `build.bat` 从模板自动复制） |
| 开发运行 | 项目根目录 `settings.json` |

- `settings_default.json`：**模板**（入库；其值与代码内置默认值一致，改代码默认值时要同步）；
- `settings.json`：**活动设置**（已 gitignore，属个人本地配置；打包时自动从模板复制一份）。

### 支持的设置项

| 键 | 默认 | 取值范围（超出自动钳位） | 说明 |
| --- | --- | --- | --- |
| `enable_write_api` | `false` | 布尔 | 写接口总开关；开启后抢课会**真实提交**选课请求 |
| `request_interval_ms` | `500` | **≥ 200，不可再低** | 全局请求间隔（默认 500ms＝1 秒 2 条；200ms 有风控风险） |
| `max_queue_size` | `10` | 1–100 | 请求队列上限，超出直接丢弃 |
| `request_timeout_seconds` | `10.0` | 3–60 | 单条 http 请求超时 |
| `query_page_size` | `10` | 1–100 | 查询分页大小 |
| `query_max_pages` | `5` | 1–50 | 单个课程类别最多翻页数 |
| `default_poll_interval_ms` | `1500` | ≥ `request_interval_ms` | 新建抢课任务的默认轮询间隔 |
| `enable_embedded_webview` | `true` | 布尔 | 内嵌选课网页总开关；关掉即退化为纯 aiohttp 模式 |
| `show_course_query_tab` | `false` | 布尔 | 是否显示「课程查询」标签页 |
| `webview_debug_port` | `9340` | 1024–65535 | 内嵌浏览器 CDP 调试端口 |
| `real_browser_debug_port` | `9350` | 1024–65535 | 「在真实浏览器打开」所用的端口 |
| `webview_reload_cooldown_ms` | `1500` | 0–60000 | 「重新载入」按钮的冷却时间 |
| `webview_card_height_px` | `252` | 0–1000 | 课程卡片高度（站点原样式固定高度会溢出） |

**优先级**：环境变量 `SZUBKXK_ENABLE_WRITE_API` > `settings.json` > 代码内置默认值。

### 安全设计

- 文件缺失 / 键缺失 / JSON 损坏 / 值无法识别 → **一律回退代码默认值**，绝不"猜成开启"；
- 刻意不用 `bool(value)`：字符串 `"false"` 会被判为**真** —— 安全开关上最危险的一类错误；
- `bool` 不会被当成整数（`true` 不会变成 `1`）；
- **限流间隔有硬下限 200ms**：默认 500ms 是实测验证过的安全水位，可调低到 200ms 但无法更低（200ms＝5 请求/秒，有被风控/踢出会话的风险）；
- 拼错的键会在启动时被识别并告警，避免"改了没生效"却查不出原因。

启动日志会写清三件事：已生效的设置项与生效值、无法识别的键、写接口开关的开启来源。

### 示例（打包成品）

```powershell
# 开启写接口 + 请求间隔放宽到 800ms + 显示课程查询页
@'
{
  "enable_write_api": true,
  "request_interval_ms": 800,
  "show_course_query_tab": true
}
'@ | Set-Content -Encoding utf8 build\szu_bkxk\settings.json
```

> **恢复出厂**：删除 `build\szu_bkxk\settings.json`，或用 `settings_default.json` 覆盖它。
> 改完需**重启程序**生效。

## 十五、致谢

本项目离不开以下用户、仓库与工具的帮助：

- **用户**：[xtexx](https://github.com/xtexx)
- **参考仓库**：[guiyi886/szu_grab_course](https://github.com/guiyi886/szu_grab_course)
- **AI 工具**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
