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
   不得硬编码进业务请求，也不得用于发送真实请求。
4. 凭证（studentCode / electiveBatchCode / cookie / token）全部由用户从浏览器登录后
   复制粘贴输入，程序**不实现登录、不处理人机验证码**，也**不把凭证写入本地文件**。

---

## 一、当前状态

开发准备阶段（详见 [`docs/开发准备.md`](docs/开发准备.md)）。业务模块代码尚未落地。

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

使用仓库内已有的虚拟环境 `.venv`（已安装 PyQt6 与 aiohttp）：

```powershell
# 若 .venv 缺失或依赖不全，执行：
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install PyQt6 aiohttp
```

> 注意：`.venv` 由 `c:\Project\深大本科选课` 迁移而来，目录改名后 `.venv\Scripts\*.exe`
> 内记录的旧路径可能失效，请统一用 `.\.venv\Scripts\python.exe -m pip ...` 调用 pip。

## 四、运行（规划中）

```powershell
.\.venv\Scripts\python.exe main.py
```

启动后会弹出风险提示弹窗，确认后方可进入主界面。

## 五、目录结构（规划）

```
szu_bkxk/
├─ docs/                 需求文档、开发准备与逆向分析记录
├─ szu/                  参考仓库（只读参考，已在 .gitignore 中排除）
├─ config.py             全部常量、路径、开发开关
├─ auth_model.py         身份凭证数据类
├─ request_queue.py      全局异步优先级限流请求队列
├─ api_client.py         aiohttp 网络封装层（所有请求强制走队列）
├─ task_model.py         抢课任务模型 + 持久化
├─ course_model.py       课程模型 + 课程列表缓存持久化
├─ logger_util.py        日志工具（UI 面板 + 本地文件 + 过滤）
├─ ui_main.py            PyQt6 主窗口与各标签页
├─ main.py               程序入口（风险弹窗 + 事件循环）
└─ README.md
```

## 六、开发红线（写代码前必读）

1. 所有 aiohttp 请求**必须**经过全局请求队列，禁止绕过限流直接发请求。
2. 单任务轮询间隔下限 **201ms**，小于该值自动钳位并记录日志。
3. 队列 1 秒内最多 5 条请求，队列上限 10，满则丢弃并告警。
4. 每完成一块独立功能单独提交一次 git commit，提交信息说明本次变更内容。
