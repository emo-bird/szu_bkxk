# TODO

按优先级排列。每完成一项单独提交一次 git commit。

## ⚠️ 测试纪律（第一优先级）

- **任何真实请求都必须经过全局请求队列（500ms 间隔）**。
  站点对高频请求会直接终止登录会话——早期未节流的探测已经把 3 组凭证踢掉，
  并导致误判「凭证是旧的」。`tools/probe_api.py` 已强制走队列；
  临时脚本也必须自己保证 ≥500ms 间隔。

## P0-1｜重构路线可行性 spike（进行中，**需要你在普通终端跑一条命令**）

**背景**：已确认「Edge + CDP」路线**零新增依赖、零下载**——本机已装
Edge 153.0.4234.48 与 WebView2 Runtime 153.0.4234.48，且 aiohttp 自带 WebSocket，
足够实现 CDP 客户端。

**关键环境限制（已实测）**：本 AI 会话的沙箱**禁止命名管道**，
而 Chromium 多进程架构（Mojo）依赖命名管道 —— 实测 Edge 启动即崩：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:183] Check failed: 拒绝访问。(0x5)
```

因此**任何浏览器（Edge / QtWebEngine）都无法在 AI 沙箱内启动**。
这有两个后果：

1. spike 必须由你在普通 PowerShell 里运行（不影响我写代码与离线测试）；
2. 若选择「QtWebEngine 内嵌」方案，我将**无法在本会话内运行程序做任何验证**，
   每次改动都要你手工验证——这是选择路线时的重要成本。

**请在普通 PowerShell 中运行**（脚本不向学校发起任何业务请求，只旁听页面自身流量）：

```powershell
cd C:\Project\szu_bkxk
.\.venv\Scripts\python.exe tools\spike_edge_login.py
```

会弹出一个独立 profile 的 Edge 窗口（不影响你日常用的 Edge）：
请在窗口里完成统一身份认证登录，脚本会自动继续，并把 4 项能力的
`[OK]/[FAIL]` 结论打印出来。请把输出贴给我。

- [ ] 等你的 spike 输出后，再在「方案1 纯内嵌网页」/「混合（网页只做登录+取数）」之间定稿。
- [ ] spike 已离线验证：CDP 客户端（命令配对、`Runtime.evaluate`、
      `Network.responseReceived` + `getResponseBody`、`Storage.getCookies`）
      已用假 CDP 服务跑通 5/5 项。

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
