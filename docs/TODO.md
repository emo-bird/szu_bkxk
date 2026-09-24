# TODO

按优先级排列。每完成一项单独提交一次 git commit。

## P0｜需要用户提供新鲜凭证后我才能继续

- [ ] **重新获取登录态**：需求文档中的测试预置参数已被服务器判定为失效
      （`student/check/login.do` 返回 `认证失败`，`grablessons.do` 返回 401）。
      请在浏览器重新登录选课系统后，重新复制四项凭证给我。
      取证过程与证据见 [`接口逆向记录.md`](接口逆向记录.md) 第二节。
- [ ] **校验课程表格字段映射**：拿到新鲜凭证后，用 `tools/probe_api.py` 拉一次
      `programCourse.do` 真实响应，据实际字段名修正 `course_model._FIELD_CANDIDATES`。
      当前「课程总号 / 课程性质 / 开课单位 / 学分 / 课程时间 / 是否MOOC」为低置信度推测。
- [ ] **校验选课批次与类别**：确认 `electiveBatchCode` 与当前开放的
      `teachingClassType`（哪些类别在本次批次中可选）。

## P1｜收藏功能（暂缓，等待抓包样本）

- [ ] **逆向收藏接口**：参考仓库 `szu/` 中缺失该接口；选课子应用的 JS 位于
      `grablessons.do` 之后（需登录）才能取到。需要：
      1. 一份登录状态下的浏览器抓包（HAR / 复制为 cURL / Network 截图），
         包含「收藏 / 取消收藏」的请求；
      2. 或提供登录态后的选课子页面 JS 地址，由我提取端点。
- [ ] 实现 `api_client.favorite(...)` / `unfavorite(...)`，走全局限流队列，
      优先级用 `config.PRIORITY_HIGH`（属于用户手动 UI 操作）。
- [ ] 解除标签页1「收藏」按钮的置灰状态（当前按钮已置灰并注明原因）。

## P2｜待确认的设计细节

- [ ] 课程查询是否需要翻页：当前按 `QUERY_MAX_PAGES = 5` 且「返回条数 <
      `QUERY_PAGE_SIZE` 即停止」处理，需用真实响应确认分页字段。
- [ ] `courseResult.do` / `volunteered.do` 的字段确认后，可考虑增加「已选课程」只读展示。
- [ ] 表格排序：当前未开启排序（避免字符串列按字典序排数字）。

## 已完成（归档）

- [x] 修复 shell 执行需提权问题（工作区 DACL 异常，见 README 第十一节）
- [x] 跳转选课网页携带 token 参数
- [x] 登录态失效的准确识别与提示（`NotAuthenticatedError`）
- [x] 接口请求统一附加 `?timestamp=`，请求头补 `X-Requested-With`
