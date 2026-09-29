/**
 * 时间参数的唯一下限/上限来源。
 *
 * 为什么单独成文件：改一个下限要同步改的地方散在 api/tasks/monitor/ui 四处，
 * 漏改任一处就会出现「输入被 UI 拦下」或「保存后被 clamp 静默夹回」的错配。
 * 这里集中定义，其它模块一律引用，禁止再写裸数字。
 *
 * 红线②：intervalMs 下限 200 是硬约束，**不得调低**。
 */
(function (root) {
  'use strict';
  var NS = root.SZUBKXK || (root.SZUBKXK = {});

  NS.LIMITS = {
    /** 请求间隔：全局串行队列，相邻两条请求开始时刻的最小间隔（红线②）。 */
    intervalMs: { min: 200, max: 60000, def: 500 },
    /** 抢课重试：一轮跑完等多久再开下一轮。 */
    retryIntervalMs: { min: 200, max: 60000, def: 1500 },
    /** 监控轮询间隔。 */
    pollIntervalMs: { min: 200, max: 60000, def: 1500 },
  };

  /** 统一钳位入口：非数字退回默认值，再夹到 [min, max]。 */
  NS.LIMITS.clamp = function (key, value) {
    var L = NS.LIMITS[key];
    var n = Number(value);
    if (!isFinite(n)) n = L.def;
    return Math.min(L.max, Math.max(L.min, n));
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
