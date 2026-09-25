# szu_bkxk · 油猴脚本版（Tampermonkey）

深大选课站点（<http://bkxk.szu.edu.cn/>）**浏览器内**辅助工具：
课程列表增强、抢课任务悬浮窗、自定义课程与课表显示。

> ⚠️ **仅供技术学习与研究。** 写接口默认关闭；禁止大规模恶意抢课；一切使用风险由使用者自负。
>
> 本分支（`master-tampermonkey`）是**从零重写**的油猴脚本版本，与桌面版（PyQt6 + WebView2/CDP）
> **不共享代码**，只复用其已经取证的接口结论。完整方案见 [`docs/方案-油猴脚本.md`](docs/方案-油猴脚本.md)。

---

## 一、当前状态

**阶段：M1 骨架开发中**（尚未具备可用功能）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 真机侦察（DOM / 站点库 / CSP / 课表页） | ⏸ 待用户在浏览器中执行 |
| M1 | 脚手架、核心模块、悬浮窗 | 🚧 进行中 |
| M2 | P0 抢课任务管理 | ⏸ 未开始 |
| M3 | P1 课程列表增强（方案待定） | ⏸ 未开始 |
| M4 | P2 自定义课程 + 冲突计算 + 课表注入 | ⏸ 未开始 |
| M5 | 打磨与发布 | ⏸ 未开始 |

## 二、开发与构建（零 npm 依赖）

环境要求：**Node.js 18+**（仅用于构建与离线单测，脚本本身不需要 Node）。

```powershell
# 运行全部离线单测（输出只看 [OK] / [FAIL]）
node tests/run.js

# 构建单文件油猴脚本 -> dist/szu_bkxk.user.js
node build/build.mjs
```

- **单一事实源**：`@version` 只在 `src/userscript-header.txt` 维护，构建时注入代码中的
  `__SZUBKXK_VERSION__` 占位符。
- **模块顺序**：`src/**/*.js` 按路径字母序拼接；所有模块自行挂载 `globalThis.SZUBKXK`，
  因此**模块间不得存在加载顺序依赖**。
- `dist/` 是构建产物，**不入库**。需要入库时用 `git add -f dist/szu_bkxk.user.js`。

## 三、目录结构

```
src/
  userscript-header.txt   元数据头（@version 唯一来源）
  core/                   纯原生 JS 核心，不依赖站点库
  data/                   被动取数与数据模型
  ui/                     界面（复用站点自带库）
build/build.mjs           拼接构建
tests/                    离线单测（harness + *.test.js）
docs/方案-油猴脚本.md      设计与里程碑
```

## 四、安装（浏览器侧，待 M1 完成后可用）

1. 安装 **Tampermonkey（篡改猴）** 扩展（测试版 v5.5.6237+ 已验证）。
2. 构建出 `dist/szu_bkxk.user.js`。
3. 把该文件拖入浏览器窗口，或打开它让 Tampermonkey 弹出安装页。

## 五、红线（写进代码，不可放松）

1. **写接口默认关闭**（`writeApiEnabled = false`），关闭时只构造并打印报文；
2. **限流不可绕过**：所有请求经 `core/queue`，默认 500ms/条，**硬下限 200ms**；
3. **凭证不落盘**：`token`/cookie 只在内存，日志**不写请求头**；
4. **未识别返回全量落档**（`[未识别返回]`），作为"边用边补"的反馈回路；
5. **前台用户主动运行**，不后台静默、不自动启动任务。
