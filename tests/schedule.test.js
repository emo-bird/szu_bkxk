/**
 * core/schedule.js 的离线单测。
 * 用虚拟时钟验证：偏移估算、只采纳最优样本、准时触发、漂移重排、取消。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');
const { makeClock } = require('./fakeclock.js');

require('../src/core/ns.js');
require('../src/core/api.js');
require('../src/core/schedule.js');

const NS = globalThis.SZUBKXK;
const Clock = NS.schedule.Clock;

section('core/schedule.js 偏移估算');

test('无 RTT 信息时 offset = serverTs - localNow', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  eq(clock.observe(100000, null, null), 100000);
  eq(clock.serverNow(), 100000);
  eq(clock.synced, true);
});

test('有 RTT 时用发出/收到的中点估算单程延迟', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  // 本地 1000 发出、1400 收到（RTT=400，中点 1200），服务器报 6200 → 偏移 5000
  eq(clock.observe(6200, 1000, 1400), 5000);
  eq(c.now(), 0);
  eq(clock.serverNow(), 5000, '本地时间 0 时服务器时间应为 5000');
});

test('只采纳延迟最小的样本（后续高延迟样本被丢弃）', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  // RTT=100，中点 50 → offset = 100000 - 50 = 99950
  eq(clock.observe(100000, 0, 100), 99950);
  eq(clock.observe(999999, 0, 5000), null, 'RTT 更大的样本应被丢弃');
  eq(clock.offsetMs, 99950);
  eq(clock.samples, 2);
  eq(clock.lastRttMs, 5000);
});

test('更优（延迟更小）的样本会覆盖旧偏移', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(100000, 0, 400); // 中点 200 → 99800
  eq(clock.observe(100100, 0, 100), 100050); // 中点 50 → 100050
  eq(clock.offsetMs, 100050);
});

test('非法 timestamp 不改变状态', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  eq(clock.observe('abc'), null);
  eq(clock.observe(0), null);
  eq(clock.observe(-5), null);
  eq(clock.synced, false);
  eq(clock.samples, 0);
});

test('数字字符串 timestamp 可用（接口返回的是字符串）', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  eq(clock.observe('1700000000000', null, null), 1700000000000);
});

section('core/schedule.js 与接口响应联动');

test('observeResponse 从已分类响应里取 timestamp', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  const classified = NS.api.classifyResponse({ status: 200, text: '{"code":"1","timestamp":"12345"}' });
  eq(clock.observeResponse(classified, 0, 100), 12295);
});

test('响应无 timestamp 时返回 null，不影响既有偏移', () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(5000, null, null);
  eq(clock.observeResponse({ timestamp: null }, 0, 10), null);
  eq(clock.offsetMs, 5000);
});

section('core/schedule.js 精准定时');

test('到点触发（按服务器时间）', async () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(10000, null, null); // 本地 0 时服务器已 10000
  const fired = [];
  clock.scheduleAt(13000, () => fired.push(clock.serverNow()));
  await c.advance(1000);
  eq(fired, [], '还没到点不应触发');
  await c.advance(3000);
  eq(fired.length, 1);
  ok(fired[0] >= 13000, '触发时服务器时间应 >= 目标，实际 ' + fired[0]);
});

test('目标时刻已过：立即触发', async () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(10000, null, null);
  const fired = [];
  clock.scheduleAt(5000, () => fired.push(1));
  await c.advance(0);
  eq(fired, [1]);
});

test('定时器提前醒来会重排，不会早触发', async () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(0, null, null);
  const fired = [];
  clock.scheduleAt(10000, () => fired.push(clock.serverNow()), { toleranceMs: 10 });
  // 一次只推进 4000ms，模拟"被提前唤醒"
  await c.advance(4000);
  eq(fired, [], '未到点不应触发');
  await c.advance(4000);
  eq(fired, [], '仍未到点不应触发');
  await c.advance(3000);
  eq(fired.length, 1);
  ok(fired[0] >= 10000, '实际 ' + fired[0]);
});

test('cancel 后不再触发', async () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  const fired = [];
  const handle = clock.scheduleAt(c.now() + 5000, () => fired.push(1));
  await c.advance(1000);
  handle.cancel();
  await c.advance(10000);
  eq(fired, []);
  eq(c.timerCount(), 0, '取消后不应残留定时器');
});

section('core/schedule.js 倒计时');

test('remainingMs 随服务器时间变化', async () => {
  const c = makeClock();
  const clock = new Clock({ timers: c.timers });
  clock.observe(10000, null, null);
  eq(clock.remainingMs(13000), 3000);
  await c.advance(1000);
  eq(clock.remainingMs(13000), 2000);
  eq(clock.remainingMs(9000), -2000, '已过时应为负数');
});
