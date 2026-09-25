/**
 * core/queue.js 的离线单测。
 *
 * 用**虚拟时钟**驱动，不真实等待，所以整份测试毫秒级完成。
 * 覆盖：出队顺序（优先级/FIFO）、限流间隔、间隔钳位、队列满丢弃、
 *       异常隔离、暂停/恢复、清空、whenIdle。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/queue.js');

const NS = globalThis.SZUBKXK;
const { RequestQueue, QueueFullError, PRIORITY } = NS.queue;

const { makeClock } = require('./fakeclock.js');

/** 把 promise 转成 {ok, value|error}，避免未处理的 rejection。 */
function settle(p) {
  return p.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

section('core/queue.js 出队顺序');

test('首条请求立即执行（间隔只约束连续两条）', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 500, timers: clock.timers });
  const starts = [];
  const p = q.submit(() => {
    starts.push(clock.now());
    return 'a';
  });
  await clock.advance(0);
  eq(starts, [0]);
  eq((await settle(p)).value, 'a');
});

test('连续请求的开始时刻按 intervalMs 间隔', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 500, timers: clock.timers });
  const starts = [];
  const ps = [1, 2, 3].map(() =>
    q.submit(() => {
      starts.push(clock.now());
    })
  );
  await clock.advance(5000);
  eq(starts, [0, 500, 1000]);
  await Promise.all(ps);
});

test('优先级数值小的先执行（即使提交得更晚）', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 200, timers: clock.timers });
  const order = [];
  q.submit(() => order.push('normal'), PRIORITY.NORMAL);
  q.submit(() => order.push('high'), PRIORITY.HIGH);
  q.submit(() => order.push('hit'), PRIORITY.MONITOR_HIT);
  await clock.advance(2000);
  eq(order, ['hit', 'high', 'normal']);
});

test('同优先级按提交先后 FIFO', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 200, timers: clock.timers });
  const order = [];
  ['a', 'b', 'c'].forEach((k) => q.submit(() => order.push(k), PRIORITY.NORMAL));
  await clock.advance(2000);
  eq(order, ['a', 'b', 'c']);
});

section('core/queue.js 参数钳位');

test('间隔低于硬下限一律抬到 200ms', () => {
  eq(new RequestQueue({ intervalMs: 50 }).intervalMs, 200);
  eq(new RequestQueue({ intervalMs: 199 }).intervalMs, 200);
  eq(new RequestQueue({ intervalMs: 0 }).intervalMs, 200);
  eq(new RequestQueue({ intervalMs: -100 }).intervalMs, 200);
});

test('间隔超上限抬到上限，非法值回退默认 500', () => {
  eq(new RequestQueue({ intervalMs: 1e9 }).intervalMs, 60000);
  eq(new RequestQueue({}).intervalMs, 500);
  eq(new RequestQueue({ intervalMs: 'abc' }).intervalMs, 500);
  eq(new RequestQueue({ intervalMs: 800 }).intervalMs, 800);
});

test('队列长度钳位到 [1,100]，默认 10', () => {
  eq(new RequestQueue({ maxQueueSize: 0 }).maxQueueSize, 1);
  eq(new RequestQueue({ maxQueueSize: 9999 }).maxQueueSize, 100);
  eq(new RequestQueue({}).maxQueueSize, 10);
});

section('core/queue.js 丢弃与异常');

test('submit 非函数时 reject TypeError', async () => {
  const q = new RequestQueue({});
  const r = await settle(q.submit(123));
  ok(!r.ok, '应当 reject');
  ok(r.error instanceof TypeError, '应为 TypeError');
});

test('队列满时丢弃并计数，reject QueueFullError', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ maxQueueSize: 2, intervalMs: 500, timers: clock.timers });
  q.submit(() => 1);
  q.submit(() => 2);
  const r = await settle(q.submit(() => 3));
  ok(!r.ok, '第三条应被丢弃');
  ok(r.error instanceof QueueFullError, '应为 QueueFullError');
  eq(q.stats.dropped, 1);
  eq(q.pendingCount(), 2);
});

test('丢弃不影响已有请求继续执行', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ maxQueueSize: 2, intervalMs: 200, timers: clock.timers });
  const done = [];
  q.submit(() => done.push(1));
  q.submit(() => done.push(2));
  await settle(q.submit(() => done.push(3)));
  await clock.advance(2000);
  eq(done, [1, 2]);
  eq(q.stats.executed, 2);
  eq(q.stats.dropped, 1);
});

test('任务异常被隔离：本条 reject，后续继续执行', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 200, timers: clock.timers });
  const p1 = settle(
    q.submit(() => {
      throw new Error('boom');
    })
  );
  const p2 = settle(q.submit(() => 'fine'));
  await clock.advance(2000);
  const r1 = await p1;
  const r2 = await p2;
  ok(!r1.ok, '第一条应 reject');
  eq(r1.error.message, 'boom');
  eq(r2.value, 'fine');
  eq(q.stats.failed, 1);
  eq(q.stats.executed, 2);
});

section('core/queue.js 暂停 / 清空 / whenIdle');

test('pause 停止派发，resume 恢复', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 200, timers: clock.timers });
  const starts = [];
  q.submit(() => {
    starts.push(clock.now());
  });
  q.pause();
  await clock.advance(2000);
  eq(starts, [], '暂停期间不应有请求执行');
  q.resume();
  await clock.advance(2000);
  eq(starts, [2000]);
});

test('clear 使待执行请求 reject，已执行的不受影响', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 500, timers: clock.timers });
  const p1 = settle(q.submit(() => 'first'));
  const p2 = settle(q.submit(() => 'second'));
  await clock.advance(0);
  eq((await p1).value, 'first');
  q.clear('测试清空');
  const r2 = await p2;
  ok(!r2.ok, '第二条应被清掉');
  eq(r2.error.message, '测试清空');
  eq(q.pendingCount(), 0);
});

test('whenIdle 在全部执行完后 resolve', async () => {
  const clock = makeClock();
  const q = new RequestQueue({ intervalMs: 200, timers: clock.timers });
  const done = [];
  q.submit(() => done.push(1));
  q.submit(() => done.push(2));
  const idle = q.whenIdle();
  await clock.advance(2000);
  await idle;
  eq(done, [1, 2]);
});

test('whenIdle 对空队列立即 resolve', async () => {
  const q = new RequestQueue({});
  await q.whenIdle();
  ok(true);
});
