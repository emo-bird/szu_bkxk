/**
 * 端到端离线集成测试：把真实模块**串起来**跑，而不是各自用替身。
 *
 * 【为什么需要】前面的单测里，runner 用的是替身 http、http 用的是替身 queue。
 * 各模块契约稍有不合，单测全绿而真机直接崩 —— 而沙箱里又跑不了浏览器。
 * 这份测试用**真实的 RequestQueue + HttpClient + Clock + Logger + capture + courseCache + Runner**，
 * 只把最外层的 `fetch` 换成假站点，等于把整条链路在 Node 里跑通。
 *
 * 【覆盖的真实风险】
 *   - http 用的 fetch 是**安装 capture 之前**拿到的（与 main.js 的装配顺序一致）——
 *     即"我们自己的请求不会被自己的旁听器捕获"；
 *   - 写开关关闭时，**整条链路上真的没有发出写请求**；
 *   - 服务器时间从真实响应里被校准；
 *   - 全程日志**不出现 token**。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');
const { makeClock } = require('./fakeclock.js');

require('../src/core/ns.js');
require('../src/core/api.js');
require('../src/core/log.js');
require('../src/core/queue.js');
require('../src/core/schedule.js');
require('../src/core/session.js');
require('../src/core/store.js');
require('../src/core/task.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');
require('../src/core/conflict.js');
require('../src/core/http.js');
require('../src/core/runner.js');
require('../src/data/model.js');
require('../src/data/capture.js');
require('../src/data/courseCache.js');
require('../src/data/query.js');

const NS = globalThis.SZUBKXK;

const WALL = 1700000000000;
const TOKEN = 'TK-SECRET-TOKEN';
const SERVER_TS = String(WALL);

/** 假站点：按 URL 返回预设 JSON。 */
function buildSite(respond) {
  const calls = [];
  const win = {
    fetch(url, init) {
      calls.push({ url: String(url), init: init || {} });
      const text = respond ? respond(String(url), init || {}) : '{"code":"1","timestamp":"' + SERVER_TS + '"}';
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(text),
        clone() {
          return this;
        },
      });
    },
  };
  return { win: win, calls: calls };
}

/** 装配一整套真实模块（只替换最外层 fetch）。 */
function buildWorld(options) {
  const o = options || {};
  const clock = makeClock();
  const serverClock = new NS.schedule.Clock({ timers: clock.timers });
  const logs = [];
  const logger = new NS.log.Logger({ echo: false, sink: (r) => logs.push(r) });
  const store = new NS.store.Store({ backend: NS.store.memoryBackend() });
  const settings = Object.assign({}, NS.store.DEFAULT_SETTINGS, o.settings || {});
  const site = buildSite(o.respond);

  // 顺序与 main.js 一致：先建 http（拿到原始 fetch），再装 capture
  const queue = new NS.queue.RequestQueue({ intervalMs: settings.requestIntervalMs, timers: clock.timers });
  const http = new NS.http.HttpClient({
    queue: queue,
    logger: logger,
    clock: serverClock,
    fetchImpl: site.win.fetch,
    timers: clock.timers,
    now: () => WALL,
  });
  const courseCache = NS.courseCache.create({ store: store, logger: logger });
  const captureHandle = NS.capture.install({
    win: site.win,
    onResponse: (payload) => {
      const records = NS.capture.recordsFromResponse(payload);
      if (records.length) courseCache.add(records);
    },
  });

  const runner = new NS.runner.Runner({
    http: http,
    clock: serverClock,
    logger: logger,
    store: store,
    timers: clock.timers,
    getSettings: () => settings,
    getSession: () =>
      o.session || {
        ok: true,
        token: TOKEN,
        studentCode: '2026000000',
        electiveBatchCode: 'B1',
        missing: [],
      },
  });

  return {
    clock: clock,
    serverClock: serverClock,
    logger: logger,
    logs: logs,
    store: store,
    site: site,
    queue: queue,
    http: http,
    courseCache: courseCache,
    captureHandle: captureHandle,
    runner: runner,
    setSettings: (patch) => Object.assign(settings, patch),
    text: () => logs.map((l) => l.message + '\n' + (l.detail || '')).join('\n'),
    callsTo: (frag) => site.calls.filter((c) => c.url.indexOf(frag) !== -1),
  };
}

const COURSE_LIST_RESPONSE = JSON.stringify({
  code: '1',
  timestamp: SERVER_TS,
  data: {
    dataList: [
      {
        courseName: '高等数学',
        courseNumber: 'C1',
        credit: '4',
        tcList: [
          {
            teachingClassID: 'TC1',
            teacherName: '张老师',
            classCapacity: '55',
            numberOfFirstVolunteer: '52',
            teachingPlace: '5-18周 星期二 3-4节 致理楼L1-707',
          },
        ],
      },
    ],
  },
});

const CAPACITY_RESPONSE = JSON.stringify({
  code: '1',
  timestamp: SERVER_TS,
  data: { mainClassCapacity: '55', mainElectiveNumber: '52' },
});

section('集成：被动取数 → 课程缓存 → 检索');

test('页面自己的课程查询被旁听到，并一路走到检索层', async () => {
  const w = buildWorld({
    respond: (url) => (url.indexOf('programCourse') !== -1 ? COURSE_LIST_RESPONSE : '{"code":"1"}'),
  });

  // 模拟"页面自己"发出的请求
  await w.site.win.fetch('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/elective/programCourse.do?timestamp=1');
  await w.clock.advance(0);

  eq(w.courseCache.size(), 1, '旁听到的课程应进入缓存');
  const rec = w.courseCache.list()[0];
  eq(rec.teachingClassId, 'TC1');
  eq(rec.teacherName, '张老师');
  eq(w.captureHandle.stats.captured, 1);

  // 归一化后的记录直接可用：余量、时间解析、筛选
  eq(NS.model.hasFreeSeat(rec), true);
  eq(rec.sessions.length, 1);
  eq(rec.sessions[0].weekday, 2);
  eq(NS.query.filter(w.courseCache.list(), { onlyFree: true }).length, 1);
  eq(NS.query.filter(w.courseCache.list(), { keyword: '张老师' }).length, 1);
  eq(NS.query.filter(w.courseCache.list(), { category: 'FANKC' }).length, 0, 'meta 未传类别时应为空');
});

test('我们自己的请求不会被自己的旁听器捕获（装配顺序保证）', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: false, requestIntervalMs: 200 },
    respond: (url) =>
      url.indexOf('teachingclass/capacity') !== -1 ? CAPACITY_RESPONSE : '{"code":"1","timestamp":"' + SERVER_TS + '"}',
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'grab', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1000);

  ok(w.callsTo('capacity').length > 0, 'runner 应发出查容量请求');
  eq(w.captureHandle.stats.captured, 0, '自己发的请求不应进入旁听器');
  eq(w.courseCache.size(), 0);
});

section('集成：服务器时间校准');

test('真实响应里的 timestamp 会校准服务器时钟', async () => {
  const w = buildWorld({ respond: () => CAPACITY_RESPONSE });
  eq(w.serverClock.synced, false);
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'monitor', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 500 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(600);
  eq(w.serverClock.synced, true, '请求过后应完成校准');
  ok(isFinite(w.serverClock.offsetMs), 'offset 应为有限数');
});

section('集成：写开关红色底线（真实链路）');

test('写开关关闭：查容量照常，写请求一次都没发出，日志标注未发送', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: false, requestIntervalMs: 200 },
    respond: (url) =>
      url.indexOf('teachingclass/capacity') !== -1
        ? CAPACITY_RESPONSE
        : '{"code":"1","msg":"添加选课志愿成功","timestamp":"' + SERVER_TS + '"}',
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'grab', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1000);

  ok(w.callsTo('capacity').length > 0, '只读探测应照常');
  eq(w.callsTo('volunteer').length, 0, '写接口绝不能发出');
  eq(w.runner.tasks[0].status === 'success', false, '不应标记成功');
  ok(w.text().indexOf('未发送') !== -1, '日志应明确标注未发送');
  // 真实构造过请求：token 通过请求头带出（且只出现在请求头里）
  eq(w.callsTo('capacity')[0].init.headers.token, TOKEN);
});

test('写开关打开：查容量 → 真实提交 → 成功并停止', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: true, requestIntervalMs: 200 },
    respond: (url) => {
      if (url.indexOf('teachingclass/capacity') !== -1) return CAPACITY_RESPONSE;
      if (url.indexOf('volunteer') !== -1)
        return JSON.stringify({ code: '1', msg: '添加选课志愿成功', timestamp: SERVER_TS });
      return '{"code":"1","timestamp":"' + SERVER_TS + '"}';
    },
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'grab', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1000);

  eq(w.callsTo('volunteer').length, 1, '应恰好提交一次');
  eq(w.runner.tasks[0].status, 'success');
  const body = w.callsTo('volunteer')[0].init.body;
  ok(decodeURIComponent(body).indexOf('TC-A') !== -1, '请求体应含教学班ID：' + body);
  ok(decodeURIComponent(body).indexOf('2026000000') !== -1, '请求体应含学号');
});

test('业务拒绝（code=2）：不标记成功，且不停止轮询', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: true, requestIntervalMs: 200 },
    respond: (url) => {
      if (url.indexOf('teachingclass/capacity') !== -1) return CAPACITY_RESPONSE;
      if (url.indexOf('volunteer') !== -1)
        return JSON.stringify({ code: '2', msg: '已选mooc课程，学生每学期只允许4门mooc课程', timestamp: SERVER_TS });
      return '{"code":"1","timestamp":"' + SERVER_TS + '"}';
    },
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'monitor', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'MOOC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1000);

  ok(w.callsTo('volunteer').length >= 1, '应尝试提交');
  ok(w.runner.tasks[0].status !== 'success', '业务拒绝不能算成功');
  ok(w.text().indexOf('已选mooc课程') !== -1, '业务原文应展示给用户');
});

test('登录失效（code=302）：停止全部任务', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: true, requestIntervalMs: 200 },
    respond: (url) => {
      if (url.indexOf('teachingclass/capacity') !== -1)
        return JSON.stringify({ code: '302', msg: '未查询到登录信息', timestamp: SERVER_TS });
      return '{"code":"1","timestamp":"' + SERVER_TS + '"}';
    },
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'monitor', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1000);
  const before = w.site.calls.length;
  await w.clock.advance(5000);
  eq(w.site.calls.length, before, '登录失效后不应继续发请求');
  eq(w.runner.running, false);
});

test('未知响应（code=9）：写入 [未识别返回] 全量留档', async () => {
  const w = buildWorld({
    settings: { requestIntervalMs: 200 },
    respond: (url) =>
      url.indexOf('teachingclass/capacity') !== -1
        ? JSON.stringify({ code: '9', msg: '风控', timestamp: SERVER_TS })
        : '{"code":"1","timestamp":"' + SERVER_TS + '"}',
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'monitor', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(600);

  const text = w.text();
  ok(text.indexOf(NS.log.UNKNOWN_MARKER) !== -1, '应有未识别标记');
  ok(text.indexOf('"code":"9"') !== -1, '应含响应原文');
  ok(text.indexOf('teachingclass/capacity') !== -1, '应含请求地址');
});

section('集成：凭证永不进日志（跨整条链路）');

test('跑完整链路后，日志与持久化数据里都不出现 token', async () => {
  const w = buildWorld({
    settings: { writeApiEnabled: true, requestIntervalMs: 200 },
    respond: (url) => {
      if (url.indexOf('teachingclass/capacity') !== -1) return CAPACITY_RESPONSE;
      if (url.indexOf('volunteer') !== -1) return JSON.stringify({ code: '9', msg: '怪响应', timestamp: SERVER_TS });
      return '{"code":"1","timestamp":"' + SERVER_TS + '"}';
    },
  });
  w.store.saveTasks([
    { id: 't1', name: '测试', kind: 'grab', targets: [{ teachingClassId: 'TC-A', teachingClassType: 'FANKC' }], intervalMs: 200 },
  ]);
  w.runner.load();
  w.runner.start();
  await w.clock.advance(1500);

  const allLogs = w.text();
  ok(allLogs.length > 0, '应有日志');
  eq(allLogs.indexOf(TOKEN), -1, '日志里出现了 token');

  // 落盘的数据同样不能有 token
  const persisted = JSON.stringify({
    tasks: w.store.getTasks(),
    courses: w.store.get(NS.store.KEYS.COURSE_CACHE, null),
  });
  eq(persisted.indexOf(TOKEN), -1, '持久化数据里出现了 token');
});

section('集成：任务持久化往返');

test('任务存盘再载入后状态为已停止，且字段不丢', async () => {
  const w = buildWorld({ respond: () => CAPACITY_RESPONSE });
  const task = w.runner.add({
    name: '往返测试',
    kind: 'monitor',
    intervalMs: 2500,
    targets: [
      { teachingClassId: 'TC-A', teachingClassType: 'FANKC', courseName: '甲' },
      { teachingClassId: 'TC-B', teachingClassType: 'FANKC' },
    ],
  });
  eq(w.store.getTasks().length, 1);

  // 换个实例重新载入（模拟刷新页面）
  const reloaded = NS.task.restoreOnLoad(w.store.getTasks());
  eq(reloaded[0].id, task.id);
  eq(reloaded[0].name, '往返测试');
  eq(reloaded[0].intervalMs, 2500);
  eq(reloaded[0].targets.map((t) => t.teachingClassId), ['TC-A', 'TC-B']);
  eq(reloaded[0].targets[0].courseName, '甲');
  eq(reloaded[0].status, 'stopped', '重载后必须已停止');
});
