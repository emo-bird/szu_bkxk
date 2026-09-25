/**
 * 测试专用：虚拟时钟（非 *.test.js，不会被 run.js 当作用例加载）。
 *
 * 让依赖定时器的模块（queue / schedule）能在毫秒内完成原本要等几秒的测试，
 * 并且完全确定性 —— 不依赖真实时间，不会偶发失败。
 */
'use strict';

/** 推进微任务队列，让 async 调度链跑完。 */
const drain = () => new Promise((r) => setImmediate(r));

/**
 * 虚拟时钟：timers.now() 返回虚拟时间，advance(ms) 按到期顺序依次触发定时器。
 * 每次触发后 drain 一次，保证被调度的 async 链推进完毕。
 * @returns {{now:Function, timerCount:Function, timers:object, advance:Function}}
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    timerCount: () => timers.size,
    timers: {
      now: () => now,
      setTimeout: (fn, delay) => {
        const id = nextId++;
        timers.set(id, { at: now + Math.max(0, delay || 0), fn });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
    },
    async advance(ms) {
      const target = now + ms;
      await drain();
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (pick === null || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id))) {
            pick = { id, t };
          }
        }
        if (!pick) break;
        timers.delete(pick.id);
        now = pick.t.at;
        pick.t.fn();
        await drain();
      }
      now = target;
      await drain();
    },
  };
}

module.exports = { makeClock, drain };
