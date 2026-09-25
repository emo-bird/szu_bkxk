/**
 * 命名空间 / 日志 / 存储 / 限流队列。
 *
 * 限流队列是**所有对学校站点请求的唯一出口**：站点对高频请求会直接终止会话
 * （v1 桌面版实测踢掉过登录态），因此任何请求都不得绕过。
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});

  NS.LOG = {
    MAX: 300,
    buf: [],
    on: true,
  };

  /**
   * 记一条日志。**严禁**把请求头/token 传进来 —— 红线③：日志不写请求头。
   */
  NS.log = function (level, msg, extra) {
    var line = '[' + new Date().toTimeString().slice(0, 8) + '][' + level + '] ' + msg;
    if (NS.LOG.buf.length >= NS.LOG.MAX) NS.LOG.buf.shift();
    NS.LOG.buf.push(line);
    if (!NS.LOG.on) return line;
    if (level === 'error') console.error('[SZUBKXK]', msg, extra === undefined ? '' : extra);
    else console.log('[SZUBKXK]', msg, extra === undefined ? '' : extra);
    return line;
  };
  NS.info = function (m, e) { return NS.log('info', m, e); };
  NS.warn = function (m, e) { return NS.log('warn', m, e); };
  NS.error = function (m, e) { return NS.log('error', m, e); };

  /** 未识别响应全量落档（红线④）。看不懂就留下，便于事后补分支。 */
  NS.dumpUnknown = function (input) {
    var text = input && input.text === undefined ? '' : String(input.text || '');
    var block =
      '\n──────── [未识别返回] ────────\n' +
      'action: ' + (input && input.action) + '\n' +
      'url: ' + (input && input.url) + '\n' +
      'body: ' + (input && input.body) + '\n' +
      'code: ' + (input && input.code) + ' | msg: ' + (input && input.msg) + '\n' +
      '长度: ' + text.length + ' 字符\n' +
      '原文:\n' + text + '\n' +
      '──────────────────────────────\n';
    // 把 code/msg 提到日志行里，便于一眼看出服务端在抱怨什么
    NS.error('未识别返回（已全量落档） code=' + (input && input.code) +
      (input && input.msg ? ' msg=' + input.msg : ''));
    console.log('%c' + block, 'color:#c00');
    return block;
  };

  var SETTINGS_KEY = 'szubkxk.settings.v2';

  /** 默认设置。`writeApiEnabled` 默认 false 是红线①，**不得修改**。 */
  NS.DEFAULT_SETTINGS = {
    writeApiEnabled: false,
    intervalMs: 500,
    batchCode: '',
    monitorMode: 'category',
    monitorCategory: 'FANKC',
    // P1
    retryMode: 'smart',
    retryIntervalMs: 1500,
    pollIntervalMs: 5000,
    panelPos: null,
    panelCollapsed: false,
  };

  NS.settings = function () {
    var s = {};
    for (var k in NS.DEFAULT_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(NS.DEFAULT_SETTINGS, k)) s[k] = NS.DEFAULT_SETTINGS[k];
    }
    try {
      var raw = root.localStorage && root.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in saved) {
          if (Object.prototype.hasOwnProperty.call(saved, j) && j in NS.DEFAULT_SETTINGS) s[j] = saved[j];
        }
      }
    } catch (e) {
      NS.warn('读取设置失败，用默认值', e && e.message);
    }
    return s;
  };

  NS.saveSettings = function (patch) {
    var s = NS.settings();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k) && k in NS.DEFAULT_SETTINGS) s[k] = patch[k];
    }
    try {
      root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) {
      NS.warn('保存设置失败', e && e.message);
    }
    return s;
  };

  /**
   * 写接口开关守卫。
   * 【刻意严格】只认**布尔 true**：字符串 "true"/数字 1 一律视为关闭
   * （v1 桌面版踩过 `bool("false")` 为真的坑，安全开关上最危险的一类错误）。
   */
  NS.isWriteAllowed = function (s) {
    return !!(s && s.writeApiEnabled === true);
  };

  /** 请求间隔硬下限（毫秒）。红线②：任何设置都不得更低。 */
  var FLOOR = 200;
  var CEIL = 60000;
  var DEFAULT_INTERVAL = 500;

  /**
   * 串行限流队列。
   * 语义：同一时刻只有 1 条在飞；相邻两条的**开始时刻**至少间隔 intervalMs；
   * 队列为空时提交立即执行；出队按 priority 升序、同级 FIFO。
   */
  function Queue(opts) {
    opts = opts || {};
    var iv = Number(opts.intervalMs);
    if (!isFinite(iv)) iv = DEFAULT_INTERVAL;
    this.intervalMs = Math.min(CEIL, Math.max(FLOOR, iv));
    this.maxQueueSize = 10;
    this.timers = opts.timers || root;
    this._items = [];
    this._seq = 0;
    this._timer = null;
    this._inflight = false;
    this._nextAt = 0;
  }

  Queue.FLOOR_MS = FLOOR;
  Queue.PRIORITY = { MONITOR_HIT: -10, HIGH: 0, NORMAL: 10 };
  NS.Queue = Queue;

  Queue.prototype.submit = function (task, priority) {
    var self = this;
    if (typeof task !== 'function') return Promise.reject(new TypeError('task 必须是函数'));
    if (this._items.length >= this.maxQueueSize) {
      return Promise.reject(new Error('请求队列已满（上限 ' + this.maxQueueSize + '），本条已丢弃'));
    }
    var item = {
      task: task,
      priority: typeof priority === 'number' && isFinite(priority) ? priority : Queue.PRIORITY.NORMAL,
      seq: this._seq++,
      resolve: null,
      reject: null,
    };
    var p = new Promise(function (res, rej) { item.resolve = res; item.reject = rej; });
    this._items.push(item);
    this._schedule();
    return p;
  };

  Queue.prototype.pending = function () { return this._items.length; };

  Queue.prototype._schedule = function () {
    var self = this;
    if (this._timer !== null || this._inflight) return;
    if (this._items.length === 0) return;
    var delay = Math.max(0, this._nextAt - Date.now());
    this._timer = this.timers.setTimeout(function () {
      self._timer = null;
      self._runOne();
    }, delay);
  };

  Queue.prototype._runOne = function () {
    var self = this;
    if (this._inflight || this._items.length === 0) return;
    var idx = 0;
    for (var i = 1; i < this._items.length; i++) {
      var a = this._items[i], b = this._items[idx];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) idx = i;
    }
    var item = this._items.splice(idx, 1)[0];
    this._inflight = true;
    this._nextAt = Date.now() + this.intervalMs;
    Promise.resolve()
      .then(function () { return item.task(); })
      .then(
        function (r) { item.resolve(r); },
        function (e) { item.reject(e); }
      )
      .then(function () {
        self._inflight = false;
        self._schedule();
      });
  };

  /** 全局唯一队列实例。 */
  NS.queue = new Queue({ intervalMs: NS.settings().intervalMs });

  NS.util = {
    clamp: function (v, lo, hi, dflt) {
      var n = Number(v);
      if (!isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    },
    text: function (el) {
      return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
