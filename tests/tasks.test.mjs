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

// ---------- 上次异常残留的清洗（用户要求：勾选的任务都必须在下一轮真正尝试） ----------

function mkTask(over) {
  return Object.assign({
    id: 'x1', seq: 1, teachingClassID: '20262', courseName: 'C程序设计',
    category: 'FANKC', priority: 0, enabled: true, status: T.STATUS.PENDING,
    retryMode: T.MODE.SMART, attempts: 3, lastMsg: '上次失败', lastKind: 'terminal',
    addedAt: Date.now(),
  }, over || {});
}

test('clearStale：重置已勾选的 failed 任务，attempts/lastMsg 一并清空', () => {
  T.items = [mkTask({ id: 'a', status: T.STATUS.FAILED })];
  eq(T.clearStale(), 1, '应清洗 1 个');
  eq(T.items[0].status, T.STATUS.PENDING);
  eq(T.items[0].attempts, 0);
  eq(T.items[0].lastMsg, '');
  eq(T.items[0].lastKind, '');
});

test('clearStale：success 保持不动（不对已抢上的课重复提交）', () => {
  T.items = [mkTask({ id: 'a', status: T.STATUS.SUCCESS, attempts: 1 })];
  eq(T.clearStale(), 0);
  eq(T.items[0].status, T.STATUS.SUCCESS);
  eq(T.items[0].attempts, 1, 'success 的 attempts 不该被清零');
});

test('clearStale：未勾选（enabled=false）的 failed 不清洗', () => {
  T.items = [mkTask({ id: 'a', enabled: false, status: T.STATUS.FAILED })];
  eq(T.clearStale(), 0);
  eq(T.items[0].status, T.STATUS.FAILED);
});

test('clearStale：混合状态只动 failed 的部分', () => {
  T.items = [
    mkTask({ id: 'a', status: T.STATUS.FAILED }),
    mkTask({ id: 'b', status: T.STATUS.SUCCESS }),
    mkTask({ id: 'c', status: T.STATUS.PENDING }),
    mkTask({ id: 'd', enabled: false, status: T.STATUS.FAILED }),
  ];
  eq(T.clearStale(), 1, '只有 a 该被清洗');
  eq(T.items.map((t) => t.status),
    [T.STATUS.PENDING, T.STATUS.SUCCESS, T.STATUS.PENDING, T.STATUS.FAILED]);
});

test('回归：上次异常导致 failed 的任务，再点开始必须重新变活跃', async () => {
  // 用户报的问题：任务在已勾选状态下跑失败，再点「开始抢课」被 active() 过滤掉。
  T.stop();
  NS.saveSettings({ writeApiEnabled: true });
  const sent = [];
  NS.__setFetch((url, opts) => {
    sent.push({ url, opts });
    return Promise.resolve(NS.__resp(JSON.stringify({ code: 2, msg: '教学班已满' })));
  });
  NS.__setSession({ token: 'T', currentCampus: JSON.stringify({ code: '01' }),
    studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'B' } }) });

  T.items = [mkTask({ id: 'a', status: T.STATUS.FAILED })];
  eq(T.active().length, 0, '清洗前：failed 任务不活跃，永远抢不了');

  const r = await T.start();
  eq(r.ok, true, 'start 应成功');
  // 等一轮真正跑完（start 里的 _loop 是异步的）
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((res) => setTimeout(res, 10));

  ok(sent.length >= 1, '该 failed 任务必须被真正尝试过（发出请求），实际请求数 ' + sent.length);
  eq(T.items[0].attempts >= 1, true, 'attempts 应被计数');
  T.stop();
  eq(T.running, false, '收尾：不得残留运行态');
});

test('start：清洗发生在 no-task 判断之前（全是 failed 时不应报 no-task）', async () => {
  T.stop();
  NS.saveSettings({ writeApiEnabled: true });
  T.items = [mkTask({ id: 'a', status: T.STATUS.FAILED })];
  const r = await T.start();
  ok(r.ok, '全是 failed 的任务也应能开始，实际: ' + JSON.stringify(r));
  T.stop();
});

test('start：全部 success 时才算 no-task（无可尝试任务）', async () => {
  T.stop();
  NS.saveSettings({ writeApiEnabled: true });
  T.items = [mkTask({ id: 'a', status: T.STATUS.SUCCESS })];
  const r = await T.start();
  eq(r.ok, false);
  eq(r.reason, 'no-task');
});

// ---------- 显示实时性与登录态失效（真机 HAR: docs/bkxk.szu.edu.cn-3.har） ----------

test('分类：真实响应的「该课程已经存在选课结果中」必须判终结，不能无限重试', () => {
  // HAR 里连发三次都是这条，它是终结性的；原正则漏判导致被当成 unknown 无限重试
  eq(T.classifyMsg('该课程已经存在选课结果中'), 'terminal');
});

test('notify：任何一次落盘都要立即重绘悬浮窗（停止那一刻的最终状态不能丢）', () => {
  // 原实现只靠 ui.js 的 1s 轮询且条件是 running，一旦停机就再也不会渲染，
  // 用户看到的是停止前那一帧，必须刷新页面才看得到结果
  const real = NS.ui;
  let n = 0;
  NS.ui = { render() { n += 1; } };
  try {
    T.items = [mkTask({ id: 'a' })];
    T.save();
    ok(n >= 1, 'save() 后必须通知界面重绘，实际 ' + n);
  } finally { NS.ui = real; }
});

test('notify：界面尚未就绪（NS.ui 缺失）时不得抛错', () => {
  const real = NS.ui;
  NS.ui = undefined;
  try {
    T.save();
  } finally { NS.ui = real; }
});

test('load：丢弃上一会话残留的「登录态失效」，不把它当成本轮结果', () => {
  // 用户实测：刷新重新登录后，第一眼看到的仍是上一轮的红色「登录态失效」
  NS.store.set('tasks', {
    seq: 1,
    items: [{
      id: 'a', teachingClassID: 'TC1', status: T.STATUS.FAILED, enabled: true,
      lastMsg: T.AUTH_MSG, lastKind: T.KIND_AUTH, attempts: 3, retryMode: 'smart',
    }],
  });
  T.items = [];
  T.load();
  eq(T.items.length, 1);
  eq(T.items[0].lastMsg, '', '刷新后不得再显示上一轮的登录态失效');
  eq(T.items[0].lastKind, '');
  eq(T.items[0].status, T.STATUS.PENDING, '回到等待，重新登录后可直接再抢');
});

test('load：其它失败文案与状态原样保留，只清登录态失效', () => {
  NS.store.set('tasks', {
    seq: 1,
    items: [{
      id: 'a', teachingClassID: 'TC1', status: T.STATUS.FAILED, enabled: true,
      lastMsg: '超出选课学分上限', lastKind: 'terminal', attempts: 1, retryMode: 'smart',
    }],
  });
  T.items = [];
  T.load();
  eq(T.items[0].lastMsg, '超出选课学分上限');
  eq(T.items[0].status, T.STATUS.FAILED);
});

test('302：登录态失效要置红、停机，并触发「刷新网页重新登录」弹窗', async () => {
  T.stop();
  NS.saveSettings({ writeApiEnabled: true });
  const real = NS.ui;
  let popped = 0;
  NS.ui = { render() {}, authExpired() { popped += 1; } };
  NS.__setFetch(() => Promise.resolve(NS.__resp(JSON.stringify({
    code: '302', msg: '请求数据与登录者身份不一致，非法请求。',
  }))));
  NS.__setSession({
    token: 'T', currentCampus: JSON.stringify({ code: '01' }),
    studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'B' } }),
  });
  try {
    T.items = [mkTask({ id: 'a' })];
    await T.attempt(T.items[0]);
    eq(T.items[0].status, T.STATUS.FAILED, '必须转入停止态（红）');
    eq(T.items[0].lastMsg, T.AUTH_MSG);
    eq(T.items[0].lastKind, T.KIND_AUTH);
    eq(T.stopped, true, '登录态失效必须停止全部任务');
    // 只断言「弹了」而不是「弹了一次」：前面的用例可能还有请求排在串行队列里，
    // 它们在本用例换掉 fetch 假实现之后才返回，也会走到同一个分支。
    // 真正的去重保证在 ui.js 的 authShown 里（同一次页面加载只弹一次），见 log.test.mjs 的静态断言。
    ok(popped >= 1, '必须弹出登录态失效提示，实际 ' + popped);
  } finally {
    NS.ui = real;
    T.stop();
    T.stopped = false;
  }
});

await run();