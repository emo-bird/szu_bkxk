/**
 * core/runner.js 的离线单测。
 *
 * 用替身 http（直接返回"已分类"的结果）记录"调了哪些接口、什么顺序、什么优先级"，
 * 配合虚拟时钟验证两种场景、满课策略、余量未知、业务拒绝顺延、登录失效、间隔钳位。
 *
 * 最重要的一条：**写开关关闭时绝不能真的提交**。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');
const { makeClock } = require('./fakeclock.js');

require('../src/core/ns.js');
require('../src/core/log.js');
require('../src/core/queue.js');
require('../src/core/schedule.js');
require('../src/core/store.js');
require('../src/core/session.js');
require('../src/core/api.js');
require('../src/core/http.js');
require('../src/core/task.js');
require('../src/core/runner.js');

const NS = globalThis.SZUBKXK;
const API = NS.api;
const T = NS.task;

/** 容量"有余量"的响应（55 - 52 = 3）。 */
const CAP_OK = { kind: 'ok', data: { mainClassCapacity: '55', mainElectiveNumber: '52' } };
/** 容量"已满"的响应。 */
const CAP_FULL = { kind: 'ok', data: { mainClassCapacity: '55', mainElectiveNumber: '55' } };
/** 余量取不到（字段缺失）。 */
const CAP_UNKNOWN = { kind: 'ok', data: {} };

function setup(options) {
  options = options || {};
  const clock = makeClock();
  const serverClock = new NS.schedule.Clock({ timers: clock.timers });
  const logs = [];
  const logger = new NS.log.Logger({ echo: false, sink: (r) => logs.push(r) });
  const store = new NS.store.Store({ backend: NS.store.memoryBackend() });
  let settings = Object.assign({}, NS.store.DEFAULT_SETTINGS, options.settings || {});

  const posts = [];
  const responder =
    options.responder ||
    function () {
      return CAP_OK;
    };

  const http = {
    post(endpoint, body, opts) {
      posts.push({ endpoint, body, options: opts });
      let r;
      try {
        r = responder(endpoint, body, opts);
      } catch (e) {
        r = e;
      }
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  };

  const session =
    options.session === undefined
      ? { ok: true, token: 'TK', studentCode: '2026000000', electiveBatchCode: 'B1', missing: [] }
      : options.session;

  const runner = new NS.runner.Runner({
    http,
    clock: serverClock,
    logger,
    store,
    timers: clock.timers,
    getSettings: () => settings,
    getSession: () => session,
  });

  return {
    clock,
    serverClock,
    logger,
    logs,
    store,
    runner,
    posts,
    setSettings: (patch) => {
      settings = Object.assign(settings, patch);
    },
    text: () => logs.map((l) => l.message + (l.detail ? '\n' + l.detail : '')).join('\n'),
    capPosts: () => posts.filter((p) => p.endpoint === API.EP.CAPACITY),
    volPosts: () => posts.filter((p) => p.endpoint === API.EP.VOLUNTEER),
  };
}

const baseTask = (patch) =>
  Object.assign(
    {
      id: 't1',
      name: '测试任务',
      kind: 'grab',
      targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }],
      intervalMs: 1000,
    },
    patch || {}
  );

section('core/runner.js 载入与启停');

test('load 后状态一律为已停止（重启不自动抢课）', () => {
  const t = setup();
  t.store.saveTasks([baseTask({ status: 'running', enabled: true })]);
  t.runner.load();
  eq(t.runner.tasks[0].status, 'stopped');
  eq(t.runner.tasks[0].enabled, false);
});

test('没有目标的任务不进入调度', () => {
  const t = setup();
  t.store.saveTasks([baseTask({ targets: [] })]);
  t.runner.load();
  t.runner.start();
  eq(t.posts.length, 0);
});

test('stop 后不再有任何请求', async () => {
  const t = setup();
  t.store.saveTasks([baseTask({ intervalMs: 200 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(500);
  const n = t.posts.length;
  ok(n > 0, '停止前应有请求');
  t.runner.stop();
  await t.clock.advance(10000);
  eq(t.posts.length, n);
  eq(t.runner.tasks[0].status, 'stopped');
});

test('登录信息缺失时停止全部任务', async () => {
  const t = setup({ session: { ok: false, missing: ['token'], token: null } });
  t.store.saveTasks([baseTask()]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.posts.length, 0, '不应发任何请求');
  eq(t.runner.tasks[0].status, 'error');
  ok(t.text().indexOf('login') !== -1 || t.text().indexOf('登录') !== -1, t.text());
});

section('core/runner.js 未到点（startAt）');

test('未到 startAt 时只等待，不发任何请求', async () => {
  const t = setup();
  t.serverClock.observe(100000, null, null); // 服务器时间 100000
  t.store.saveTasks([baseTask({ startAt: 110000 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.posts.length, 0, '未到点不应发请求');
  eq(t.runner.tasks[0].status, 'waiting');
});

test('到达 startAt 后才开始探测与提交（写开关打开）', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_OK : { kind: 'ok', msg: '添加选课志愿成功' }),
  });
  t.serverClock.observe(100000, null, null);
  t.store.saveTasks([baseTask({ startAt: 101000, intervalMs: 1000 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(999);
  eq(t.posts.length, 0, '差 1ms 也不应动手');
  await t.clock.advance(200);
  eq(t.capPosts().length, 1);
  eq(t.volPosts().length, 1);
  eq(t.runner.tasks[0].status, 'success');
});

section('core/runner.js 写开关（红线）');

test('写开关关闭时：探测照常，但绝不提交，只打印报文', async () => {
  const t = setup({ settings: { writeApiEnabled: false } });
  t.store.saveTasks([baseTask({ intervalMs: 200 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  ok(t.capPosts().length > 0, '只读探测应照常进行');
  eq(t.volPosts().length, 0, '写接口绝不能被调用');
  const text = t.text();
  ok(text.indexOf('未发送') !== -1, '应提示未发送：' + text);
  ok(text.indexOf('addParam') !== -1, '应打印报文内容');
});

test('写开关关闭时任务不会被标记成功', async () => {
  const t = setup({ settings: { writeApiEnabled: false } });
  t.store.saveTasks([baseTask()]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(2000);
  ok(t.runner.tasks[0].status !== 'success', '不应标记成功');
});

test('写开关打开时提交使用高优先级', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_OK : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask()]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.volPosts()[0].options.priority, NS.queue.PRIORITY.HIGH);
});

section('core/runner.js 余量与满课策略');

test('余量取不到且未允许盲提 → 不提交', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_UNKNOWN : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask()]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.volPosts().length, 0, '取不到余量不应提交（桌面版曾因此对满课发起抢课）');
});

test('余量取不到但显式允许盲提 → 提交', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_UNKNOWN : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask({ allowUnknownCapacity: true })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.volPosts().length, 1);
});

test('grab + 满课后停止：满课即停止任务，不再轮询', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_FULL : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask({ intervalMs: 200, fullStrategy: 'stop' })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.runner.tasks[0].status, 'stopped');
  const n = t.capPosts().length;
  await t.clock.advance(5000);
  eq(t.capPosts().length, n, '停止后不应再轮询');
  eq(t.volPosts().length, 0);
});

test('grab + 满课继续轮询：持续探测但不提交', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_FULL : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask({ intervalMs: 200, fullStrategy: 'keep' })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  ok(t.capPosts().length > 1, '应持续轮询');
  eq(t.volPosts().length, 0);
});

test('monitor 满课不停止，放量后命中即提交', async () => {
  let full = true;
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => {
      if (ep !== API.EP.CAPACITY) return { kind: 'ok', msg: '添加选课志愿成功' };
      return full ? CAP_FULL : CAP_OK;
    },
  });
  t.store.saveTasks([baseTask({ kind: 'monitor', intervalMs: 200 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.runner.tasks[0].status, 'running', '满课不应停止 monitor 任务');
  full = false; // 模拟统一放量
  await t.clock.advance(1000);
  eq(t.volPosts().length, 1);
  eq(t.runner.tasks[0].status, 'success');
});

section('core/runner.js 提交结果处理');

test('业务拒绝（code=2）顺延到下一个目标', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep, body) => {
      if (ep === API.EP.CAPACITY) return CAP_OK;
      const decoded = decodeURIComponent(body || '');
      if (decoded.indexOf('TC-A') !== -1) return { kind: 'business', msg: '已选mooc课程，学生每学期只允许4门mooc课程' };
      return { kind: 'ok', msg: '添加选课志愿成功' };
    },
  });
  t.store.saveTasks([
    baseTask({
      targets: [
        { teachingClassId: 'TC-A', teachingClassType: 'FANKC' },
        { teachingClassId: 'TC-B', teachingClassType: 'FANKC' },
      ],
    }),
  ]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(2000);
  eq(t.volPosts().length, 2, '应对两个目标都尝试提交');
  ok(t.text().indexOf('已选mooc课程') !== -1, '业务拒绝原文应展示给用户');
  eq(t.runner.tasks[0].status, 'success');
});

test('提交时登录失效 → 停止全部任务', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) =>
      ep === API.EP.CAPACITY ? CAP_OK : { kind: 'unauthenticated', code: '302', msg: '未查询到登录信息' },
  });
  t.store.saveTasks([baseTask({ intervalMs: 200 })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  const n = t.posts.length;
  await t.clock.advance(5000);
  eq(t.posts.length, n, '登录失效后不应继续发请求');
  eq(t.runner.running, false);
});

test('目标缺少课程类别时跳过，不提交', async () => {
  const t = setup({
    settings: { writeApiEnabled: true },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_OK : { kind: 'ok', msg: 'ok' }),
  });
  t.store.saveTasks([baseTask({ targets: [{ teachingClassId: 'TC-A' }] })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(1000);
  eq(t.posts.length, 0, '缺少类别连探测都不该发');
  ok(t.text().indexOf('类别') !== -1, t.text());
});

section('core/runner.js 间隔');

test('轮询间隔取 max(任务间隔, 全局请求间隔)', async () => {
  const t = setup({
    settings: { requestIntervalMs: 1000 },
    responder: (ep) => (ep === API.EP.CAPACITY ? CAP_FULL : { kind: 'ok' }),
  });
  t.store.saveTasks([baseTask({ intervalMs: 200, fullStrategy: 'keep' })]);
  t.runner.load();
  t.runner.start();
  await t.clock.advance(999);
  eq(t.capPosts().length, 1, '第二次轮询必须等满全局间隔');
  await t.clock.advance(1);
  eq(t.capPosts().length, 2);
});

section('core/runner.js 增删改');

test('add / update / remove 会持久化', () => {
  const t = setup();
  t.runner.load();
  const task = t.runner.add({ name: '新任务', targets: ['TC-X'] });
  eq(t.store.getTasks().length, 1);
  t.runner.update(task.id, { name: '改名了', intervalMs: 10 });
  const saved = t.store.getTasks()[0];
  eq(saved.name, '改名了');
  eq(saved.intervalMs, 200, '更新时也要钳位');
  ok(t.runner.remove(task.id));
  eq(t.store.getTasks().length, 0);
});

test('remove 不存在的任务返回 false', () => {
  const t = setup();
  t.runner.load();
  eq(t.runner.remove('nope'), false);
});

test('onChange 在状态变化时被调用', async () => {
  const clock = makeClock();
  const serverClock = new NS.schedule.Clock({ timers: clock.timers });
  const store = new NS.store.Store({ backend: NS.store.memoryBackend() });
  let changes = 0;
  const runner = new NS.runner.Runner({
    http: { post: () => Promise.resolve(CAP_OK) },
    clock: serverClock,
    logger: new NS.log.Logger({ echo: false }),
    store,
    timers: clock.timers,
    getSettings: () => ({ requestIntervalMs: 500 }),
    getSession: () => ({ ok: true, token: 'T', studentCode: 'S', electiveBatchCode: 'B' }),
    onChange: () => {
      changes += 1;
    },
  });
  store.saveTasks([baseTask()]);
  runner.load();
  runner.start();
  await clock.advance(500);
  ok(changes > 0, 'onChange 应被调用');
});
