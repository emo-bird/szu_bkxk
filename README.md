# szu_bkxk

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
| P8 | 课程收藏接口 | ⏸ **TODO：待抓包样本**（见 [`docs/TODO.md`](docs/TODO.md)） |

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
| 版本管理 | git | 2.54.0 |

`PyQt6` 之外**额外需要 pip 安装的依赖包**：`aiohttp`。

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

### 标签页1｜课程查询

- **身份凭证区**：`studentCode` / `electiveBatchCode` / `cookie`（支持多行粘贴，自动拼接为 `; `）/
  `token`；提供「校验凭证」「清空凭证」。输入实时写入内存凭证对象，**不落盘**。
- **课程表格**：课程号、课程总号、课程名称、课程类别、课程性质、开课单位、学分、课程时间、
  是否 MOOC、已选人数 / 总人数；「显示列」按钮可自由勾选列显隐。
- **筛选**：课程名 / 教师 / 课程号模糊搜索、类别、是否 MOOC、只看有余量（纯内存过滤）。
- **刷新查询**：**最高优先级**请求，逐个类别拉取（单类别最多 `config.QUERY_MAX_PAGES` 页）；
  拉取成功后覆盖本地缓存。
- **跳转选课网页**：调用系统默认浏览器打开 `http://bkxk.szu.edu.cn/`。
- **收藏**：按钮暂置灰，等待 P8 抓包后接入。
- 启动时优先展示本地缓存课程列表（缓存记录保存时间）。

### 标签页2｜抢课任务管理器

- 任务**新增 / 修改 / 删除**，可配置：课程名称、教师、课程号、课程总号、教学班ID、课程类别、
  轮询间隔、满课策略（`满课后停止` / `满课继续轮询`）。
- 支持从课程列表下拉一键带出课程信息。
- 轮询间隔**下限强制 201ms**，小于该值自动钳位并输出告警日志。
- 任务状态：等待中 / 运行中 / 抢课成功 / 已停止 / 异常失败。
- 多任务异步独立运行，网络请求统一经全局限流队列。
- 任务配置持久化到 `tasks_config.json`；**重启后状态一律为「已停止」，不会自动运行**。

### 标签页3｜日志面板

- 日志格式 `[时间戳] [来源模块] 日志内容`，告警/错误额外带 `[告警]`/`[错误]` 前缀。
- 分类过滤复选框：抢课成功 / 抢课失败 / 查询信息 / 系统信息 / 队列调度
  —— 过滤**只影响面板展示**，日志文件始终记录全部分类。
- 日志同时写入 `logs/app_YYYYMMDD.log`（按天切分）。

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
├─ ui_main.py         PyQt6 主窗口、三个标签页、信号槽与跨线程调度
├─ main.py            入口：风险弹窗、模块初始化、Qt + asyncio 双事件循环
├─ tools/             只读接口探测工具（probe_api.py，凭证走环境变量、不落盘）
├─ docs/              需求文档、开发准备、接口逆向记录、TODO
└─ szu/               参考仓库（只读参考，已在 .gitignore 排除）
```

依赖方向：`main → ui_main → {task_model → api_client → request_queue → aiohttp,
course_model}`，`ui_main` 不构造任何 http 报文。

## 七、限流与线程模型

- 常量集中在 `config.py`：`REQUEST_INTERVAL_MS = 201`、`MAX_QUEUE_SIZE = 10`。
- **单调度协程**每 201ms 取出 1 条请求执行（≈ 1 秒最多 5 条）；队列满则**直接丢弃**并告警，
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
