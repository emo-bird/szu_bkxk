/**
 * 日志：内存环形缓冲 + 控制台回显 + 订阅推送（供悬浮窗面板实时显示）。
 *
 * 【纪律】
 *   1. **绝不写请求头**（含 token / cookie）——凭证不落盘、不进日志；
 *   2. 订阅者（UI）抛异常**不得**影响记录本身（沿用桌面版"槽函数必须兜底"的教训）；
 *   3. `[未识别返回]` 的全量留档走同一条日志链路，面板要能高亮它。
 *
 * 【为什么是环形缓冲】前台运行、按时间窗使用，日志量有限；超出上限丢弃最旧的，
 * 避免长时间运行把内存吃光。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var LOG = (NS.log = NS.log || {});

  /** 日志级别。 */
  LOG.LEVEL = { INFO: 'info', WARN: 'warn', ERROR: 'error' };

  /** 日志分类（与桌面版一致，另加"侦察"用于 M0）。 */
  LOG.CATEGORY = {
    SUCCESS: 'success',
    FAIL: 'fail',
    QUERY: 'query',
    SYSTEM: 'system',
    QUEUE: 'queue',
    RECON: 'recon',
  };

  /** 分类的中文标签（面板过滤复选框用）。 */
  LOG.CATEGORY_LABEL = {
    success: '抢课成功',
    fail: '抢课失败',
    query: '查询信息',
    system: '系统信息',
    queue: '队列调度',
    recon: '侦察',
  };

  /** 面板上要区分的分类顺序。 */
  LOG.CATEGORY_ORDER = ['success', 'fail', 'query', 'queue', 'recon', 'system'];

  /** 未识别返回的标记（面板高亮用，勿改）。 */
  LOG.UNKNOWN_MARKER = '[未识别返回]';

  /**
   * 把任意值转成可读字符串（对象则 JSON，循环引用也不抛）。
   * @param {*} value 待转换值
   * @returns {string}
   */
  function stringify(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  /**
   * 两位补零。
   * @param {number} n 数字
   * @returns {string}
   */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 格式化为 `[HH:MM:SS] [分类] 级别前缀 内容`。
   * @param {object} record 日志记录
   * @returns {string}
   */
  LOG.format = function (record) {
    var d = new Date(record.ts);
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var prefix = record.level === LOG.LEVEL.ERROR ? '[错误] ' : record.level === LOG.LEVEL.WARN ? '[告警] ' : '';
    var label = LOG.CATEGORY_LABEL[record.category] || record.category;
    return '[' + time + '] [' + label + '] ' + prefix + record.message + (record.detail ? '\n' + record.detail : '');
  };

  /**
   * 构造日志器。
   * @param {object} [options]
   * @param {number} [options.limit] 环形缓冲上限（钳位 [50, 5000]，默认 500）
   * @param {Function} [options.sink] 记录推送回调 function(record)
   * @param {boolean} [options.echo] 是否回显到控制台，默认 true
   * @param {boolean} [options.timeProvider] 时间函数，默认 Date.now（单测注入）
   */
  function Logger(options) {
    options = options || {};
    this.limit = NS.util.clamp(options.limit, 50, 5000, 500);
    this.echo = options.echo !== false;
    this.now = typeof options.timeProvider === 'function' ? options.timeProvider : Date.now;
    this._records = [];
    this._seq = 0;
    /** 订阅者列表（面板等 UI 挂在这里）。 */
    this._subscribers = [];
    if (typeof options.sink === 'function') this._subscribers.push(options.sink);
  }

  /**
   * 订阅日志推送（同一 sink 只允许注册一次）。
   * @param {Function} fn 回调 function(record)
   */
  Logger.prototype.subscribe = function (fn) {
    if (typeof fn === 'function' && this._subscribers.indexOf(fn) === -1) this._subscribers.push(fn);
  };

  /**
   * 退订日志推送。
   * @param {Function} fn 之前注册的回调
   */
  Logger.prototype.unsubscribe = function (fn) {
    var i = this._subscribers.indexOf(fn);
    if (i !== -1) this._subscribers.splice(i, 1);
  };

  /**
   * 追加一条记录。
   * @param {string} level 级别（LOG.LEVEL）
   * @param {string} category 分类（LOG.CATEGORY）
   * @param {string} message 内容
   * @param {*} [detail] 附加详情（对象会被 JSON 序列化）
   * @returns {object} 生成的记录
   */
  Logger.prototype._push = function (level, category, message, detail) {
    var record = {
      id: ++this._seq,
      ts: this.now(),
      level: level,
      category: category,
      message: String(message),
    };
    if (detail !== undefined && detail !== null && detail !== '') {
      record.detail = stringify(detail);
    }

    this._records.push(record);
    if (this._records.length > this.limit) {
      this._records.splice(0, this._records.length - this.limit);
    }

    if (this.echo) {
      var line = LOG.format(record);
      if (level === LOG.LEVEL.ERROR) console.error(line);
      else if (level === LOG.LEVEL.WARN) console.warn(line);
      else console.log(line);
    }

    for (var i = 0; i < this._subscribers.length; i++) {
      try {
        this._subscribers[i](record);
      } catch (e) {
        // UI 侧出错不能影响日志本身
        if (this.echo) console.error('[日志订阅者异常]', e && e.message);
      }
    }
    return record;
  };

  /** 记录一条普通信息。 */
  Logger.prototype.info = function (category, message, detail) {
    return this._push(LOG.LEVEL.INFO, category, message, detail);
  };

  /** 记录一条告警。 */
  Logger.prototype.warn = function (category, message, detail) {
    return this._push(LOG.LEVEL.WARN, category, message, detail);
  };

  /** 记录一条错误。 */
  Logger.prototype.error = function (category, message, detail) {
    return this._push(LOG.LEVEL.ERROR, category, message, detail);
  };

  /**
   * 取记录快照。
   * @param {string} [category] 只取该分类；不传则全部
   * @returns {object[]} 记录数组（副本）
   */
  Logger.prototype.records = function (category) {
    if (!category) return this._records.slice();
    var out = [];
    for (var i = 0; i < this._records.length; i++) {
      if (this._records[i].category === category) out.push(this._records[i]);
    }
    return out;
  };

  /** 清空内存日志。 */
  Logger.prototype.clear = function () {
    this._records = [];
  };

  /**
   * 生成可直接贴进日志面板/控制台的纯文本（用于"复制侦察报告"等）。
   * @param {string} [category] 可选分类过滤
   * @returns {string}
   */
  Logger.prototype.dump = function (category) {
    return this.records(category)
      .map(function (r) {
        return LOG.format(r);
      })
      .join('\n');
  };

  LOG.Logger = Logger;
})(typeof globalThis !== 'undefined' ? globalThis : this);
