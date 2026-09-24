# TODO

按优先级排列。每完成一项单独提交一次 git commit。

## ⚠️ 测试纪律（第一优先级）

- **任何真实请求都必须经过全局请求队列（500ms 间隔）**。
  站点对高频请求会直接终止登录会话——早期未节流的探测已经把 3 组凭证踢掉，
  并导致误判「凭证是旧的」。`tools/probe_api.py` 已强制走队列；
  临时脚本也必须自己保证 ≥500ms 间隔。

## P0｜需要用户提供新鲜凭证后我才能继续

- [ ] **重新复制凭证**（当前这组已被高频请求踢掉，返回
      `{"code":"302","msg":"未查询到登录信息"}`）。
      要点：Network → Preserve log → 刷新选课页 → 点最新一条发往 `bkxk.szu.edu.cn`
      的请求 → 整段复制 Request Headers 的 `cookie`；
      token 取 `sessionStorage.token`。
      **拿不到新凭证也没关系**——字段映射与接口映射已用抓包 + 真实响应确认完毕（见下）。
- [ ] 端到端复验：拿到凭证后用 UI 点「刷新查询」，确认表格出现真实课程。
- [ ] `MOOC` 类别复验：偶发 `{"code":"0","msg":"操作异常，请重新登录试试"}`，
      待有效会话下确认 `publicCourse.do` + `YCJX:2,MOOC:1,` 是否稳定。

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
