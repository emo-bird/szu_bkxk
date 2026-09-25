/**
 * core/http.js 的离线单测。
 *
 * 关键点：用假 fetch + 虚拟时钟，验证报文/头部/凭证策略、响应分类、未识别落档、
 * 服务器时间校准、超时与网络错误，以及**凭证绝不进日志**这条红线。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');
const { makeClock } = require('./fakeclock.js');

require('../src/core/ns.js');
require('../src/core/api.js');
require('../src/core/log.js');
require('../src/core/queue.js');
require('../src/core/schedule.js');
require('../src/core/http.js');

const NS = globalThis.SZUBKXK;
const API = NS.api;

const WALL = 1700000000000;

/** 装配一套带假 fetch 的 http 客户端。 */
function setup(options) {
  options = options || {};
  const clock = makeClock();
  // 注意：这里要的是 NS.schedule.Clock（提供 observeResponse/synced），不是虚拟时钟本身
  const serverClock = new NS.schedule.Clock({ timers: clock.timers });
  const queue = new NS.queue.RequestQueue({
    intervalMs: 200,
    maxQueueSize: options.maxQueueSize || 10,
    timers: clock.timers,
  });
  const logs = [];
  const logger = new NS.log.Logger({ echo: false, sink: (r) => logs.push(r) });
  const calls = [];
  const responses = options.responses || [];
  let i = 0;

  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (typeof r === 'function') return r(url, init);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ status: r.status, text: () => Promise.resolve(r.text) });
  };

  const http = new NS.http.HttpClient({
    queue,
    logger,
    clock: serverClock,
    fetchImpl,
    timers: clock.timers,
    now: () => WALL,
  });

  return { clock, serverClock, queue, logger, logs, calls, http };
}

/** 把 promise 转成 {ok, value|error}，避免未处理 rejection。 */
const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

/** 推进虚拟时间让队列把请求跑完，并返回结果。默认推进 5 秒（足够越过 200ms 的队列间隔）。 */
async function run(clock, p, ms) {
  await clock.advance(typeof ms === 'number' ? ms : 5000);
  return p;
}

const okResp = (text) => ({ status: 200, text });

section('core/http.js 报文与请求头');

test('POST：带 token 头、X-Requested-With、同源凭证、URL 带 timestamp', async () => {
  const t = setup({ responses: [okResp('{"code":"1","msg":"成功"}')] });
  await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'addParam=%7B%7D', { token: 'TK', action: '选课提交' }));
  eq(t.calls.length, 1);
  const call = t.calls[0];
  ok(call.url.indexOf(API.EP.VOLUNTEER) !== -1, 'URL 缺端点：' + call.url);
  ok(call.url.indexOf('?timestamp=' + WALL) !== -1, 'URL 缺 timestamp：' + call.url);
  eq(call.init.method, 'POST');
  eq(call.init.headers.token, 'TK');
  eq(call.init.headers['X-Requested-With'], 'XMLHttpRequest');
  eq(call.init.body, 'addParam=%7B%7D');
  eq(call.init.credentials, 'same-origin');
});

test('GET 不带 body', async () => {
  const t = setup({ responses: [okResp('{"code":"1"}')] });
  await run(t.clock, t.http.get(API.EP.BATCH, { token: 'TK' }));
  eq(t.calls[0].init.method, 'GET');
  eq('body' in t.calls[0].init, false);
});

section('core/http.js 响应分类与落档');

test('code=1 → ok，并累计统计', async () => {
  const t = setup({ responses: [okResp('{"code":"1","msg":"添加选课志愿成功","timestamp":"1700000000000"}')] });
  const r = await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'x', { token: 'TK' }));
  eq(r.kind, 'ok');
  eq(t.http.stats.requests, 1);
  eq(t.http.stats.ok, 1);
});

test('code=2 → business（业务拒绝，不抛异常）', async () => {
  const t = setup({ responses: [okResp('{"code":"2","msg":"已选mooc课程，学生每学期只允许4门mooc课程"}')] });
  const r = await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'x', { token: 'TK' }));
  eq(r.kind, 'business');
  eq(r.msg, '已选mooc课程，学生每学期只允许4门mooc课程');
  eq(t.http.stats.business, 1);
});

test('code=302 → unauthenticated', async () => {
  const t = setup({ responses: [okResp('{"code":"302","msg":"未查询到登录信息"}')] });
  const r = await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'x', { token: 'TK' }));
  eq(r.kind, 'unauthenticated');
  eq(t.http.stats.unauthenticated, 1);
});

test('未知 code → 写 [未识别返回] 全量留档', async () => {
  const t = setup({ responses: [okResp('{"code":"9","msg":"风控"}')] });
  const r = await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'addParam=x', { token: 'TK', action: '选课提交' }));
  eq(r.kind, 'unknown');
  const dump = t.logs.map((l) => l.message).join('\n');
  ok(dump.indexOf(LOG_MARKER()) === 0 || dump.indexOf(LOG_MARKER()) !== -1, '缺未识别标记：' + dump);
  ok(dump.indexOf('{"code":"9","msg":"风控"}') !== -1, '缺响应原文');
  ok(dump.indexOf('addParam=x') !== -1, '缺请求体');
  ok(dump.indexOf('选课提交') !== -1, '缺动作');
});

function LOG_MARKER() {
  return NS.log.UNKNOWN_MARKER;
}

test('红线：凭证绝不进入日志', async () => {
  const t = setup({ responses: [okResp('{"code":"9","msg":"怪响应"}')] });
  await run(t.clock, t.http.post(API.EP.VOLUNTEER, 'addParam=x', { token: 'TK-SECRET-123', action: 'a' }));
  const all = t.logs
    .map((l) => l.message + '\n' + (l.detail || ''))
    .join('\n');
  ok(all.indexOf('TK-SECRET-123') === -1, '日志里出现了 token：' + all);
});

test('describe() 只给网址与表单内容，明确标注未发送，且不含 token', () => {
  const text = NS.http.describe('POST', API.EP.VOLUNTEER, 'addParam=' + encodeURIComponent('{"data":{}}'));
  ok(text.indexOf('方法：POST') === 0, '缺方法行：' + text);
  ok(text.indexOf(API.EP.VOLUNTEER) !== -1, '缺地址');
  ok(text.indexOf('未发送') !== -1, '应标注未发送');
  ok(text.indexOf('{"data":{}}') !== -1, '应给出解码后的 JSON');
  ok(text.toLowerCase().indexOf('token') === -1, 'describe 不应提到 token');
});

section('core/http.js 服务器时间校准');

test('用响应 timestamp + 请求往返时间校准服务器时钟', async () => {
  const t = setup({ responses: [okResp('{"code":"1","timestamp":"1700000005000"}')] });
  eq(t.serverClock.synced, false);
  await run(t.clock, t.http.get(API.EP.BATCH, { token: 'TK' }));
  eq(t.serverClock.synced, true);
  ok(t.serverClock.offsetMs > 0, 'offset 应被设置，实际 ' + t.serverClock.offsetMs);
});

section('core/http.js 失败路径');

test('网络错误 → reject HttpError(kind=network)', async () => {
  const t = setup({ responses: [new Error('连接被重置')] });
  const r = await run(t.clock, settle(t.http.get(API.EP.BATCH, { token: 'TK' })));
  ok(!r.ok, '应 reject');
  eq(r.error.name, 'HttpError');
  eq(r.error.kind, 'network');
  eq(t.http.stats.failed, 1);
});

test('超时 → reject HttpError(kind=timeout)', async () => {
  const t = setup({ responses: [() => new Promise(() => {})] });
  // 超时是 10000ms，必须推进超过它；否则请求永不 settle（曾经的坑）
  const r = await run(t.clock, settle(t.http.get(API.EP.BATCH, { token: 'TK' })), 15000);
  ok(!r.ok, '应 reject');
  eq(r.error.kind, 'timeout');
  ok(r.error.message.indexOf('超时') !== -1, r.error.message);
});

test('未配置队列时拒绝直接发请求', async () => {
  const http = new NS.http.HttpClient({ queue: null });
  const r = await settle(http.get(API.EP.BATCH, {}));
  ok(!r.ok);
  eq(r.error.kind, 'config');
});

test('队列满 → reject QueueFullError', async () => {
  const t = setup({ maxQueueSize: 1, responses: [okResp('{"code":"1"}')] });
  t.http.get(API.EP.BATCH, { token: 'TK' });
  const r = await settle(t.http.get(API.EP.BATCH, { token: 'TK' }));
  ok(!r.ok);
  eq(r.error.name, 'QueueFullError');
});

test('请求按给定优先级入队', async () => {
  const t = setup({ responses: [okResp('{"code":"1"}'), okResp('{"code":"1"}')] });
  const seen = [];
  t.queue.submit = function (task, priority) {
    seen.push(priority);
    return Promise.resolve(task());
  };
  await t.http.get(API.EP.BATCH, { token: 'TK', priority: NS.queue.PRIORITY.MONITOR_HIT });
  await t.http.get(API.EP.BATCH, { token: 'TK' });
  eq(seen, [NS.queue.PRIORITY.MONITOR_HIT, NS.queue.PRIORITY.NORMAL]);
});
