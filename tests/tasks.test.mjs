/**
 * 抢课任务与重试策略测试。
 * 用例文案全部取自 HAR 真实响应（成功 / 已满 / mooc 配额限制等）。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const T = NS.tasks;

// ---------- 业务文案分类 ----------

test('分类：满员类 → 可重试', () => {
  eq(T.classifyMsg('已选人数超过课容量'), 'retryable', '含「容量」');
  eq(T.classifyMsg('教学班已满'), 'retryable', '含「已满」');
  eq(T.classifyMsg('人数已满'), 'retryable', '含「人数」');
});

test('分类：「已选人数超过课容量」必须算可重试，不能因「已选」误判为终结', () => {
  // 这是最容易写错的用例：该文案同时命中 可重试 与 终结 关键词
  eq(T.classifyMsg('已选人数超过课容量'), 'retryable');
});

test('分类：配额/冲突/学分类 → 终结性（真实响应文案）', () => {
  eq(T.classifyMsg('已选mooc课程，学生每学期只允许4门mooc课程'), 'terminal', 'mooc 配额');
  eq(T.classifyMsg('该课程与已选课程时间冲突'), 'terminal', '时间冲突');
  eq(T.classifyMsg('超出选课学分上限'), 'terminal', '学分');
  eq(T.classifyMsg('该教学班不允许选课'), 'terminal', '不允许');
});

test('分类：空/未知文案 → unknown', () => {
  eq(T.classifyMsg(''), 'unknown');
  eq(T.classifyMsg(null), 'unknown');
  eq(T.classifyMsg('系统繁忙，请稍后再试'), 'unknown');
});

// ---------- 策略 ----------

test('策略 smart：可重试与未识别都继续，终结性停止', () => {
  eq(T.shouldRetry('smart', 'retryable'), true);
  eq(T.shouldRetry('smart', 'unknown'), true);
  eq(T.shouldRetry('smart', 'terminal'), false);
});

test('策略 never：任何失败都停', () => {
  eq(T.shouldRetry('never', 'retryable'), false);
  eq(T.shouldRetry('never', 'unknown'), false);
  eq(T.shouldRetry('never', 'terminal'), false);
});

test('策略 always：任何失败都继续', () => {
  eq(T.shouldRetry('always', 'retryable'), true);
  eq(T.shouldRetry('always', 'terminal'), true);
  eq(T.shouldRetry('always', 'unknown'), true);
});

// ---------- 任务模型 ----------

test('add：加入任务并带上学号所属类别', () => {
  T.clear();
  const t = T.add({ teachingClassID: 'TC1', courseName: '高等数学', category: 'FANKC' });
  ok(t, '返回任务');
  eq(t.teachingClassID, 'TC1');
  eq(t.category, 'FANKC');
  eq(t.status, T.STATUS.PENDING);
  eq(t.enabled, true);
  eq(t.attempts, 0);
});

test('add：同一教学班不重复加入', () => {
  T.clear();
  const a = T.add({ teachingClassID: 'TC1' });
  const b = T.add({ teachingClassID: 'TC1' });
  eq(T.items.length, 1, '仍只有 1 条');
  ok(a === b, '返回既有任务');
});

test('add：缺教学班ID 返回 null', () => {
  T.clear();
  eq(T.add({}), null);
  eq(T.add(null), null);
});

test('active：只含启用且未终结的任务，按优先级排序', () => {
  T.clear();
  const a = T.add({ teachingClassID: 'A' });
  const b = T.add({ teachingClassID: 'B' });
  const c = T.add({ teachingClassID: 'C' });
  b.priority = -1;
  c.status = T.STATUS.SUCCESS;
  const act = T.active();
  eq(act.map((x) => x.teachingClassID), ['B', 'A'], 'B 优先，C 已成功被排除');
  void a;
});

test('toggle：禁用后不再活跃；重新启用时失败态回到等待', () => {
  T.clear();
  const t = T.add({ teachingClassID: 'A' });
  T.toggle(t.id);
  eq(t.enabled, false);
  eq(T.active().length, 0, '禁用后不活跃');
  t.status = T.STATUS.FAILED;
  T.toggle(t.id);
  eq(t.enabled, true);
  eq(t.status, T.STATUS.PENDING, '失败态复位');
});

test('reset：清空尝试次数，成功态保留', () => {
  T.clear();
  const a = T.add({ teachingClassID: 'A' });
  const b = T.add({ teachingClassID: 'B' });
  a.attempts = 5; a.status = T.STATUS.FAILED; a.lastMsg = 'x';
  b.attempts = 3; b.status = T.STATUS.SUCCESS;
  T.reset();
  eq(a.attempts, 0);
  eq(a.status, T.STATUS.PENDING);
  eq(a.lastMsg, '');
  eq(b.status, T.STATUS.SUCCESS, '成功的不重置');
});

test('setPriority：钳位到 [-1,1]', () => {
  T.clear();
  const t = T.add({ teachingClassID: 'A' });
  T.setPriority(t.id, -99);
  eq(t.priority, -1);
  T.setPriority(t.id, 99);
  eq(t.priority, 1);
});

test('setRetryMode：只接受已知模式', () => {
  T.clear();
  const t = T.add({ teachingClassID: 'A' });
  eq(T.setRetryMode(t.id, 'smart'), true);
  eq(T.setRetryMode(t.id, '乱写'), false, '未知模式被拒');
  eq(t.retryMode, 'smart');
});

// ---------- 执行前置条件 ----------

test('start：写接口未开启时拒绝执行（红线①）', async () => {
  T.clear();
  T.add({ teachingClassID: 'A', category: 'FANKC' });
  const r = await T.start();
  eq(r.ok, false);
  eq(r.reason, 'write-disabled');
  eq(T.running, false, '不得进入运行态');
});

test('start：没有任务时拒绝', async () => {
  T.clear();
  NS.saveSettings({ writeApiEnabled: true });
  const r = await T.start();
  eq(r.ok, false);
  eq(r.reason, 'no-task');
  NS.saveSettings({ writeApiEnabled: false });
});

test('attempt：缺类别时直接终止，不发请求', async () => {
  T.clear();
  // 先给出完整会话，确保走到「类别」这一关
  NS.__setSession({
    studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'B1' } }),
    currentCampus: JSON.stringify({ code: '01' }),
  });
  const t = T.add({ teachingClassID: 'A', category: '' });
  const r = await T.attempt(t);
  eq(r.done, true, '立即终结');
  eq(t.status, T.STATUS.FAILED);
  ok(t.lastMsg.indexOf('类别') !== -1, '提示类别问题');
});

test('attempt：缺批次码时直接终止，不发请求', async () => {
  T.clear();
  NS.__setSession({}); // 无任何会话数据
  const t = T.add({ teachingClassID: 'A', category: 'FANKC' });
  const r = await T.attempt(t);
  eq(r.done, true);
  eq(t.status, T.STATUS.FAILED);
  ok(t.lastMsg.indexOf('批次') !== -1 || t.lastMsg.indexOf('学号') !== -1, '提示会话缺失');
});

test('buildBody：报文用任务自己的类别', () => {
  T.clear();
  const t = T.add({ teachingClassID: 'TC1', category: 'XGXK' });
  const body = T.buildBody(t);
  const json = JSON.parse(decodeURIComponent(body.slice('addParam='.length)));
  eq(json.data.teachingClassType, 'XGXK');
  eq(json.data.teachingClassId, 'TC1');
  ok(json.data, '必须包一层 data');
});

await run();
