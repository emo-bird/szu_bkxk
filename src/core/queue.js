/**
 * 全局优先级限流请求队列 —— **所有对学校站点的请求的唯一出口**。
 *
 * 【为什么存在】站点对高频请求会直接终止登录会话（桌面版早期未节流的探测踢掉过多组凭证）。
 * 因此任何请求（含"只读探测"）都必须经过这里，禁止绕过。
 *
 * 【调度语义】
 *   - 同一时刻只有 1 条请求在飞（串行）；
 *   - 相邻两条请求的**开始时刻**至少间隔 `intervalMs`；
 *   - 队列为空时提交的请求**立即**执行（间隔只约束"连续两条"）；
 *   - 出队顺序：priority 数值小的先出；同 priority 按提交先后 FIFO。
 *
 * 【安全下限】`intervalMs` 被强制钳位到 [200, 60000]，默认 500。
 * 200ms 是硬下限，任何设置都不得更低（README「五、红线」）。
 *
 * 依赖：仅 NS.util（延迟取值，不做顶层捕获）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var Q = (NS.queue = NS.queue || {});

  /** 请求间隔硬下限（毫秒）；这是全项目最重要的安全数值之一。 */
  Q.INTERVAL_FLOOR_MS = 200;
  /** 请求间隔上限（毫秒），防止误配置成"几乎不发请求"。 */
  Q.INTERVAL_MAX_MS = 60000;
  /** 请求间隔默认值（实测验证过的安全水位：1 秒 2 条）。 */
  Q.INTERVAL_DEFAULT_MS = 500;

  /** 队列长度默认上限；超出直接丢弃并计数（沿用桌面版语义）。 */
  Q.MAX_QUEUE_SIZE_DEFAULT = 10;
  Q.MAX_QUEUE_SIZE_LIMIT = 100;

  /**
   * 优先级常量（数值越小越先执行）。
   * 与桌面版一致：监控命中余量插队到最前，其次是用户手动操作，最后是常规轮询。
   */
  Q.PRIORITY = {
    MONITOR_HIT: -10,
    HIGH: 0,
    NORMAL: 10,
  };

  /** 队列已满、请求被丢弃时抛出。 */
  function QueueFullError(message) {
    var err = Error.call(this, message);
    this.message = message || '请求队列已满';
    this.name = 'QueueFullError';
    if (Error.captureStackTrace) Error.captureStackTrace(this, QueueFullError);
    else this.stack = err.stack;
  }
  QueueFullError.prototype = Object.create(Error.prototype);
  QueueFullError.prototype.constructor = QueueFullError;
  Q.QueueFullError = QueueFullError;

  /**
   * 构造限流队列。
   * @param {object} [options]
   * @param {number} [options.intervalMs] 相邻请求的最小开始间隔，钳位到 [200, 60000]
   * @param {number} [options.maxQueueSize] 待执行队列上限，钳位到 [1, 100]
   * @param {object} [options.timers] 定时器适配（{setTimeout, clearTimeout, now}），单测注入用
   */
  function RequestQueue(options) {
    options = options || {};
    this.intervalMs = NS.util.clamp(
      options.intervalMs,
      Q.INTERVAL_FLOOR_MS,
      Q.INTERVAL_MAX_MS,
      Q.INTERVAL_DEFAULT_MS
    );
    this.maxQueueSize = NS.util.clamp(options.maxQueueSize, 1, Q.MAX_QUEUE_SIZE_LIMIT, Q.MAX_QUEUE_SIZE_DEFAULT);
    this.timers = options.timers || {
      now: function () {
        return Date.now();
      },
      setTimeout: function (fn, delay) {
        return root.setTimeout(fn, delay);
      },
      clearTimeout: function (id) {
        return root.clearTimeout(id);
      },
    };

    this.stats = { submitted: 0, executed: 0, failed: 0, dropped: 0 };

    this._items = []; // { task, priority, seq, resolve, reject }
    this._seq = 0;
    this._timer = null; // 待触发的调度定时器 id
    this._inflight = false; // 是否有请求正在执行
    this._paused = false;
    this._nextAt = 0; // 下一条请求允许开始的时间戳（timers.now() 基准）
    this._idleWaiters = [];
  }

  /**
   * 提交一个请求任务。
   * @param {Function} task 返回值为结果（可为 Promise）；应内部完成一次 HTTP 调用
   * @param {number} [priority] 优先级，默认 PRIORITY.NORMAL
   * @returns {Promise<*>} 任务结果；被丢弃则 reject QueueFullError
   */
  RequestQueue.prototype.submit = function (task, priority) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task 必须是函数'));
    }
    if (this._items.length >= this.maxQueueSize) {
      this.stats.dropped += 1;
      return Promise.reject(new QueueFullError('请求队列已满（上限 ' + this.maxQueueSize + '），本条已丢弃'));
    }

    var item = {
      task: task,
      priority: typeof priority === 'number' && isFinite(priority) ? priority : Q.PRIORITY.NORMAL,
      seq: this._seq++,
      resolve: null,
      reject: null,
    };
    var self = this;
    var promise = new Promise(function (resolve, reject) {
      item.resolve = resolve;
      item.reject = reject;
    });
    this._items.push(item);
    this.stats.submitted += 1;
    self._schedule();
    return promise;
  };

  /** 待执行条数（不含正在执行的那一条）。 */
  RequestQueue.prototype.pendingCount = function () {
    return this._items.length;
  };

  /** 暂停派发（正在执行的请求不受影响）。 */
  RequestQueue.prototype.pause = function () {
    this._paused = true;
    if (this._timer !== null) {
      this.timers.clearTimeout(this._timer);
      this._timer = null;
    }
  };

  /** 恢复派发。 */
  RequestQueue.prototype.resume = function () {
    if (!this._paused) return;
    this._paused = false;
    this._schedule();
  };

  /**
   * 清空待执行队列（正在执行的不受影响），被清掉的请求一律 reject。
   * @param {Error|string} [reason] 失败原因
   */
  RequestQueue.prototype.clear = function (reason) {
    var items = this._items.splice(0, this._items.length);
    var err = reason instanceof Error ? reason : new Error(reason || '队列已清空');
    for (var i = 0; i < items.length; i++) items[i].reject(err);
    this._maybeIdle();
  };

  /**
   * 返回一个 Promise，在队列排空且无请求在执行时 resolve。
   * 仅用于测试与收尾等待，不参与业务调度。
   * @returns {Promise<void>}
   */
  RequestQueue.prototype.whenIdle = function () {
    var self = this;
    if (this._items.length === 0 && !this._inflight) return Promise.resolve();
    return new Promise(function (resolve) {
      self._idleWaiters.push(resolve);
    });
  };

  /** 计算并登记下一次调度（若已有定时器/正在执行/已暂停则什么都不做）。 */
  RequestQueue.prototype._schedule = function () {
    var self = this;
    if (this._timer !== null || this._inflight || this._paused) return;
    if (this._items.length === 0) return;
    var delay = Math.max(0, this._nextAt - this.timers.now());
    this._timer = this.timers.setTimeout(function () {
      self._timer = null;
      self._runOne();
    }, delay);
  };

  /** 取出最高优先级的一条并执行。 */
  RequestQueue.prototype._runOne = function () {
    var self = this;
    if (this._paused || this._inflight) return;
    if (this._items.length === 0) return;

    var idx = 0;
    for (var i = 1; i < this._items.length; i++) {
      var a = this._items[i];
      var b = this._items[idx];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) idx = i;
    }
    var item = this._items.splice(idx, 1)[0];

    this._inflight = true;
    this._nextAt = this.timers.now() + this.intervalMs; // 以"开始时刻"计时，保证间隔
    this.stats.executed += 1;

    return Promise.resolve()
      .then(function () {
        return item.task();
      })
      .then(
        function (result) {
          item.resolve(result);
        },
        function (err) {
          self.stats.failed += 1;
          item.reject(err);
        }
      )
      .then(function () {
        self._inflight = false;
        self._schedule();
        self._maybeIdle();
      });
  };

  /** 若已彻底空闲，唤醒所有 whenIdle 等待者。 */
  RequestQueue.prototype._maybeIdle = function () {
    if (this._items.length !== 0 || this._inflight) return;
    var waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (var i = 0; i < waiters.length; i++) waiters[i]();
  };

  Q.RequestQueue = RequestQueue;
})(typeof globalThis !== 'undefined' ? globalThis : this);
