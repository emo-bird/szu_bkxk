# TODO

按优先级排列。每完成一项单独提交一次 git commit。

## ⚠️ 测试纪律（第一优先级）

- **任何真实请求都必须经过全局请求队列（500ms 间隔）**。
  站点对高频请求会直接终止登录会话——早期未节流的探测已经把 3 组凭证踢掉，
  并导致误判「凭证是旧的」。`tools/probe_api.py` 已强制走队列；
  临时脚本也必须自己保证 ≥500ms 间隔。

## P0-1｜路线已定：**B+ = WebView2 内嵌 + CDP 取数**（进行中）

**已决策**：走 B+。架构分层：

| 层 | 由谁负责 | 说明 |
| --- | --- | --- |
| 内嵌网页窗口 | pythonnet + 官方 WebView2 SDK（Core API，**不用 WinForms**） | `CreateAsync` → `CreateCoreWebView2ControllerAsync(parentHwnd)` |
| 数据面（凭证/取数/注入） | **CDP**（`cdp_bridge.py`，走 `--remote-debugging-port`） | 被动捕获，零额外请求 |
| 抢课提交 | **仍由 Python 的 aiohttp** 走全局限流队列 + `ENABLE_WRITE_API` 守卫 | 保持不变 |

> 把数据面放在 CDP 上是有意为之：pythonnet 只负责「创建并摆放窗口」，
> 万一 pythonnet 有问题，也只影响嵌入，不影响取数与抢课。

### 已完成的环境准备

- [x] 系统 Edge 153.0.4234.48 / WebView2 Runtime 153.0.4234.48（均已装）
- [x] `pythonnet 3.1.0` 安装成功（**必须 `PYTHONNET_RUNTIME=coreclr`**，默认 netfx 会失败）
- [x] 官方 WebView2 SDK `1.0.4191.47` 解压到 `vendor/webview2/`（已 gitignore）
- [x] 互操作层实测通过：程序集加载成功、`CoreWebView2EnvironmentOptions.AdditionalBrowserArguments`
      可设置、`CreateCoreWebView2ControllerAsync` 存在
- [x] `cdp_bridge.py` 正式模块，用假 CDP 服务**离线验证 8/8 通过**：
      `wait_for_cdp`、`pick_target`（优先选中 szu 页面而非 about:blank）、`evaluate`、
      `session_storage`、`poll_responses`（只收 `.do`）、响应体 JSON 解析、
      `get_cookies`、`cookie_header`（正确过滤外域 cookie）

### 已有 spike 结论（A 路线的数据面，B+ 复用同一套代码）

你跑的 `tools/spike_edge_login.py` 输出见
[`管理员 Windows PowerShell1.txt`](管理员%20Windows%20PowerShell1.txt)，结论：

| 能力 | 结果 |
| --- | --- |
| CDP 连接 | [OK] Edg/153.0.4234.48 |
| 执行 JS | [OK] |
| 被动捕获接口响应 | **[OK]** 捕到 20 个接口；`programCourse.do`/`publicCourse.do`/`queryCourse.do` 均拿到真实 JSON |
| 登录后读取 cookie | [FAIL] ← **是我脚本的顺序 bug**：在登录**之前**就读了 cookie |

**两个脚本缺陷（已在新模块中修掉）**：
1. cookie 读取时机在登录前 → `cdp_bridge` 的做法是登录后再读；
2. `pick_target` 选中了 `about:blank` → 新实现优先选中地址含 `szu.edu.cn` 的目标；
3. 抓到的响应体被我按 6000 字符截断后再解析，导致真实 JSON 被误报为「非 JSON」——
   新实现先解析完整内容、只在展示时截断。

### spike 全部通过 ✅（7/7，已跑通多轮）

[`管理员 Windows PowerShell6.txt`](管理员%20Windows%20PowerShell6.txt) 实测结果：

| 能力 | 结果 |
| --- | --- |
| WebView2 内嵌到 Qt 窗口 | [OK]（DPR=2.0 高 DPI 下 Bounds 同步正常） |
| CDP 端口可达 / 执行 JS | [OK] |
| 登录后读取 cookie | [OK] `_WEU/JSESSIONID/route/insert_cookie` 共 178 字符（含 HttpOnly） |
| 卡片显示教学班ID + 抢课按钮 | [OK] `cards:13, tags:13, buttons:13, cardHeight:252px` |
| 被动捕获接口响应 | [OK] 17 个接口 / 26 条，**零额外请求** |
| **网页按钮 → Python 弹窗** | [OK] 自动填充课程/教师/课程号/教学班ID，**类别精确**（方案内 / 本班） |

### 本轮修复的三个问题

1. **回传延迟**：原先回传读取排在「被动捕获 15 秒」之后，点击最多压 15 秒。
   改为**常驻消息泵**（100ms 轮询 + Qt 侧 80ms 消费）后，实测**端到端额外延迟 117ms**。
2. **卡片高度**：站点 `.cv-course-card` 是固定 `210px` 且无溢出处理，追加标签后内容溢出。
   注入 `height:252px !important` 覆盖（用固定值，避免「确认选择」模式切换时高度跳变）。
3. **课程号被污染**：`.cv-num` 内含 `<span class="cv-detail">课程详情</span>`，
   直接取 `textContent` 会得到 `5201890010 课程详情`。改为克隆节点后剔除 `.cv-detail` 再取文本。
   同类问题（`tcList` 里的 `null` 覆盖课程级有效值）在 `course_model` 解析器里也已修复。

### 新增能力：在真实浏览器打开（用本次会话）

界面新增按钮「在真实浏览器打开（用本次会话）」：

- 启动一个**独立 profile** 的 Edge（开 CDP 端口）；
- 用 `Network.setCookie` 把本会话的 cookie 写入该浏览器；
- 再以 `grablessons.do?token=<token>` 导航；
- 并校验页面是否真的渲染出课程卡片，把结论打印到控制台。

> 之所以不能直接丢给系统默认浏览器：站点要求 cookie 与 token 属于**同一会话**，
> 而我们的会话在 WebView2 的独立 profile 里，日常浏览器的 cookie 与之不匹配。
> 独立 profile 的 Edge 既拿到了会话，又不会污染日常浏览器数据。

### B+ 已集成进抢课程序 ✅（分支 `feature/webview2-embedded`）

- [x] 新增 `webview_host.py`：窗口宿主（pythonnet + Core API + Bounds/DPI 同步），
      **只管窗口不碰数据**，失败也不影响取数与抢课；
- [x] 新增 `webview_bridge.py`：CDP 常驻泵（捕获 + 回传）、页面注入、会话迁移；
- [x] 凭证改为从内嵌页**自动读取并回填**（cookie 含 HttpOnly；学号/批次从 sessionStorage 解析）；
- [x] 新增「选课网页」标签页（教学班ID 标签 + 抢课按钮 + 卡片高度覆盖）；
- [x] 被动捕获的课程自动进入「课程查询」表格；
- [x] **写接口按 `docs/har.json` 实测实现**：抢课 `volunteer.do`（`addParam`）、
      退课 `deleteVolunteer.do`（`deleteParam`）、查余量 `teachingclass/capacity.do`；
      响应按 `code` 分类（1 成功 / 2 业务拒绝 / 302 登录失效 / 其它**未识别**）；
- [x] **未识别返回全量落日志**（标记 `[未识别返回]`，含请求体+响应原文），便于后续开发补分支；
- [x] 网页「添加到抢课任务」→ 自动填充 `TaskDialog` → 入列并持久化；
- [ ] **需要你在真机验证**：`python main.py` → 登录 → 看卡片标签/按钮/表格/建任务/真实浏览器打开；
- [ ] 抢课轮询与提交仍走 `api_client` + 500ms 限流队列 + `ENABLE_WRITE_API` 守卫。

> 若嵌入路线将来出问题（pythonnet / HWND / DPI），可回退 **A 路线**（外部 Edge + CDP，零依赖）：
> `tools/spike_edge_login.py` 已改用同一套 `cdp_bridge`，可直接复测。

## P0-2｜已用有效凭证完成端到端验收 ✅

- [x] **刷新查询已跑通**（凭证：`34647bf5-…` 那一轮）。完整刷新 7 个类别的实测结果：

      | 类别 | 解析行数 | 说明 |
      | --- | --- | --- |
      | 方案内 FANKC | 121 | |
      | 方案外 FAWKC | 52 | |
      | 本班 TJKC | 34 | |
      | 校公选 XGXK | 26 | 扁平结构，一行即一个教学班 |
      | 体育 TYKC | 99 | |
      | 辅修 FXKC | 0 | 服务器返回「该学生没有辅修课程」，属正常 |
      | 慕课 MOOC | 50 | |

      合计 **382 行（课程 × 教学班）**，其中仍有余量 57 条；
      共 **18 条请求**，全部经 500ms 限流队列，`dropped=0`。
- [x] **课程表格字段映射**已按真实响应校正。
- [x] 修复扁平结构缺陷：校公选/慕课的教学班 ID 与容量此前解析为空，
      会导致 `has_free_seat()` 恒为真（可能对已满课程发起抢课）。
- [x] 类别无可选课程时，把服务器的业务说明（如「该学生没有辅修课程」）
      显示到状态栏，不再只显示模糊的「未返回任何课程数据」。
- [ ] **重新复制凭证**以便你自己在 UI 上实测（我用于验收的那组已在测试后失效）。
      复制要点：Network → Preserve log → 刷新选课页 → 点最新一条发往
      `bkxk.szu.edu.cn` 的请求 → 整段复制 Request Headers 的 `cookie`；
      token 取 `sessionStorage.token`。

## P1｜收藏功能（接口已定位，待实现）

- [x] **逆向收藏接口** —— 已完成，端点与参数见
      [`接口逆向记录.md`](接口逆向记录.md) 3.4 节：
      `POST /xsxkapp/sys/xsxkapp/elective/favorite.do`，
      参数 `tcId / batchCode / operateType / schoolTerm / courseNumber`。
- [ ] 在 `api_client` 增加收藏方法，走全局队列 + `PRIORITY_HIGH`；
      `schoolTerm` 可通过 `batch.do` 获取。
- [ ] **注意**：`favorite.do` 是会改变服务器状态的写操作，
      接入时必须与选课写接口一样受 `ENABLE_WRITE_API` 约束、默认不执行。
- [ ] 解除标签页1「收藏」按钮的置灰状态（当前已置灰并注明原因）。

## P2｜已归档的取证结论（无需再做）

- [x] **课程表格字段映射** —— 已用真实响应确认并落地
      `course_model._FIELD_CANDIDATES`：`courseTotalNumber`（课程总号）、
      `courseNatureName`（课程性质）、`departmentName`（开课单位）、`credit`（学分）、
      `teachingPlace`（课程时间）、`isMooc`（是否 MOOC）。
- [x] **分类别接口映射** —— 校公选课/慕课走 `publicCourse.do`（不是 programCourse.do），
      体育课 `queryContent` 不含 MOOC，慕课用 `MOOC:1`。
- [x] **分页语义** —— `pageNumber` 是 **0 基**，`pageSize=10`；
      原实现 `pageNumber=1 + pageSize=100` 导致偏移超界、返回空列表，
      这正是「接口未返回任何课程数据」的根因。
- [x] 已选课程结果接口：`studentCode` 放在表单 body。

## P3｜待确认的设计细节

- [ ] 表格排序：当前未开启排序（避免字符串列按字典序排数字）。
- [ ] 可选增强：`elective/teachingclass/capacity.do` 可单独查容量，
      抢课轮询未来可改用它以减少数据量（当前用整类查询，每轮 1 条请求）。
- [ ] `QXKC → queryCourse.do` 的中文名与开放情况（不在需求 7 个类别内）。

## 已完成（归档）

- [x] 请求调度间隔调整为 500ms（用户手动修改，已提交）
- [x] 修复 shell 执行需提权问题（工作区 DACL 异常，见 README 第十一节）
- [x] 跳转选课网页携带 token 参数
- [x] 登录态失效的准确识别与提示（`NotAuthenticatedError`）
- [x] 日志输出请求网址与表单内容（请求头含凭证，不写日志）
- [x] 服务器业务错误（`code` / `msg`）原样上报到日志与界面
- [x] 探测工具改为强制走 500ms 限流队列
