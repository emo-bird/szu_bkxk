/**
 * 网络出口层：**所有对学校站点的 HTTP 请求都从这里发出**（且必须经由 core/queue 限流）。
 *
 * 【为什么单独一层】桌面版的经验是"唯一出口"最好管：限流、超时、响应分类、
 * 未识别落档、服务器时间校准全都收敛在一处，调用方只关心业务语义。
 *
 * 【红线】
 *   - 请求头含 token，**只传给 fetch，绝不进日志**（describe() 刻意不含请求头）；
 *   - 所有请求经 RequestQueue（默认 500ms/条，硬下限 200ms），禁止绕过；
 *   - 看不懂的响应必须走 formatUnknownDump() 全量留档。
 *
 * 【不做什么】本层**不判断写开关**——是否允许提交由调用方（runner）用 api.isWriteAllowed()
 * 决定；本层只提供 describe() 供"关闭时只打印报文"用。
 *
 * 依赖：NS.api / NS.queue / NS.log（均在函数体内延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var H = (NS.http = NS.http || {});

  H.DEFAULT_TIMEOUT_MS = 10000;
  H.TIMEOUT_FLOOR_MS = 3000;
  H.TIMEOUT_MAX_MS = 60000;

  /** 传输层失败（网络错误 / 超时）。业务层失败（code=2 等）不抛异常，走分类结果。 */
  function HttpError(message, kind) {
    this.message = message;
    this.name = 'HttpError';
    this.kind = kind || 'network';
    if (Error.captureStackTrace) Error.captureStackTrace(this, HttpError);
  }
  HttpError.prototype = Object.create(Error.prototype);
  HttpError.prototype.constructor = HttpError;
  H.HttpError = HttpError;

  /** 默认定时器适配。 */
  function defaultTimers() {
    return {
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
  }

  /**
   * 构造 HTTP 客户端。
   * @param {object} options
   * @param {object} options.queue RequestQueue 实例（必填）
   * @param {object} [options.logger] 日志器
   * @param {object} [options.clock] NS.schedule.Clock，用于服务器时间校准
   * @param {Function} [options.fetchImpl] fetch 实现（单测注入）
   * @param {object} [options.timers] 定时器适配；默认沿用 clock 的
   * @param {string} [options.base] 基地址，默认 api.BASE_URL + api.BASE_PATH
   * @param {number} [options.timeoutMs] 单请求超时，钳位 [3000, 60000]，默认 10000
   * @param {Function} [options.now] 挂时间戳用的墙钟，默认 Date.now（单测注入）
   */
  function HttpClient(options) {
    options = options || {};
    this.queue = options.queue || null;
    this.logger = options.logger || null;
    this.clock = options.clock || null;
    this.timers = options.timers || (this.clock && this.clock.timers) || defaultTimers();
    this.fetchImpl = options.fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    this.base = options.base || NS.api.BASE_URL + NS.api.BASE_PATH;
    this.timeoutMs = NS.util.clamp(options.timeoutMs, H.TIMEOUT_FLOOR_MS, H.TIMEOUT_MAX_MS, H.DEFAULT_TIMEOUT_MS);
    this.now = typeof options.now === 'function' ? options.now : Date.now;

    this.stats = { requests: 0, ok: 0, business: 0, unauthenticated: 0, unknown: 0, failed: 0 };
  }

  /**
   * 生成"将要发送什么"的可读文本（写开关关闭时打印用）。
   * ⚠️ **刻意不含请求头** —— 请求头里有 token，不能进日志。
   * @param {string} method HTTP 方法
   * @param {string} endpoint 端点（相对 base）
   * @param {(string|undefined)} body 请求体
   * @returns {string} 多行文本
   */
  H.describe = function (method, endpoint, body) {
    var lines = ['方法：' + String(method).toUpperCase(), '地址：' + NS.api.BASE_URL + NS.api.BASE_PATH + endpoint];
    if (body !== undefined && body !== null && body !== '') {
      lines.push('请求体：' + String(body));
      // 解码后的 JSON 更便于人工核对字段
      var m = /^(?:addParam|deleteParam)=(.+)$/.exec(String(body));
      if (m) {
        try {
          lines.push('解码后：' + decodeURIComponent(m[1]));
        } catch (e) {
          /* 解码失败就不显示，不影响主流程 */
        }
      }
    }
    lines.push('（写接口开关关闭：以上报文仅打印，未发送）');
    return lines.join('\n');
  };

  /**
   * 发起一次请求（经限流队列）。
   * @param {string} method HTTP 方法
   * @param {string} endpoint 端点（相对 base）
   * @param {object} [options]
   * @param {string} [options.body] 请求体
   * @param {string} [options.token] 会话 token
   * @param {string} [options.action] 动作描述（写日志用）
   * @param {string} [options.category] 未识别落档的日志分类
   * @param {number} [options.priority] 队列优先级
   * @returns {Promise<object>} api.classifyResponse() 的结果；传输失败则 reject HttpError
   */
  HttpClient.prototype.request = function (method, endpoint, options) {
    var self = this;
    options = options || {};
    if (!this.queue) return Promise.reject(new HttpError('未配置请求队列，拒绝直接发请求', 'config'));
    var priority = typeof options.priority === 'number' ? options.priority : NS.queue.PRIORITY.NORMAL;
    return this.queue.submit(function () {
      return self._perform(method, endpoint, options);
    }, priority);
  };

  /** POST 简写。 */
  HttpClient.prototype.post = function (endpoint, body, options) {
    var opts = options || {};
    opts.body = body;
    return this.request('POST', endpoint, opts);
  };

  /** GET 简写。 */
  HttpClient.prototype.get = function (endpoint, options) {
    return this.request('GET', endpoint, options || {});
  };

  /**
   * 真正执行一次 fetch（已被队列保护）。
   * @private
   */
  HttpClient.prototype._perform = function (method, endpoint, options) {
    var self = this;
    var api = NS.api;
    if (!this.fetchImpl) throw new HttpError('当前环境没有 fetch，无法发请求', 'config');

    var url = api.appendTimestamp(this.base + endpoint, this.now());
    var body = options.body;
    var headers = api.buildHeaders(options.token);
    var t0 = this.timers.now();
    this.stats.requests += 1;

    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = null;
    var timeoutPromise = new Promise(function (resolve, reject) {
      timer = self.timers.setTimeout(function () {
        if (controller) controller.abort();
        reject(new HttpError('请求超时（' + self.timeoutMs + 'ms）：' + endpoint, 'timeout'));
      }, self.timeoutMs);
    });

    var fetchOptions = {
      method: String(method).toUpperCase(),
      headers: headers,
      // 同源请求由浏览器自动附带 cookie（含 HttpOnly）；JS 不需要也不应该读 cookie
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (body !== undefined && body !== null) fetchOptions.body = body;
    if (controller) fetchOptions.signal = controller.signal;

    var doFetch = Promise.resolve()
      .then(function () {
        return self.fetchImpl(url, fetchOptions);
      })
      .then(
        function (res) {
          return Promise.resolve()
            .then(function () {
              return res.text();
            })
            .then(function (text) {
              return { status: res.status, text: text };
            });
        },
        function (err) {
          throw new HttpError('网络请求失败：' + ((err && err.message) || err), 'network');
        }
      );

    return Promise.race([doFetch, timeoutPromise])
      .then(function (raw) {
        self.timers.clearTimeout(timer);
        timer = null;
        var t1 = self.timers.now();
        var classified = api.classifyResponse(raw);
        self._account(classified);
        self._syncClock(classified, t0, t1);
        self._dumpUnknown(classified, url, body, options);
        return classified;
      })
      .catch(function (err) {
        if (timer !== null) {
          self.timers.clearTimeout(timer);
          timer = null;
        }
        if (!(err instanceof HttpError)) err = new HttpError('请求异常：' + ((err && err.message) || err), 'network');
        self.stats.failed += 1;
        if (self.logger) {
          self.logger.error(options.category || NS.log.CATEGORY.SYSTEM, '请求失败（' + (options.action || endpoint) + '）', err.message);
        }
        throw err;
      });
  };

  /** 累计分类计数。 */
  HttpClient.prototype._account = function (classified) {
    var K = NS.api.RESP_KIND;
    if (classified.kind === K.OK) this.stats.ok += 1;
    else if (classified.kind === K.BUSINESS) this.stats.business += 1;
    else if (classified.kind === K.UNAUTHENTICATED) this.stats.unauthenticated += 1;
    else this.stats.unknown += 1;
  };

  /** 用响应里的 timestamp 校准服务器时间。 */
  HttpClient.prototype._syncClock = function (classified, t0, t1) {
    if (!this.clock || !this.clock.observeResponse) return;
    try {
      this.clock.observeResponse(classified, t0, t1);
    } catch (e) {
      /* 校准失败不影响业务 */
    }
  };

  /** 未识别响应全量落档（"边用边补"的反馈回路，不要删）。 */
  HttpClient.prototype._dumpUnknown = function (classified, url, body, options) {
    if (classified.kind !== NS.api.RESP_KIND.UNKNOWN) return;
    if (!this.logger) return;
    this.logger.warn(
      options.category || NS.log.CATEGORY.SYSTEM,
      NS.api.formatUnknownDump({
        action: options.action || '(未标注)',
        url: url,
        body: body,
        text: classified.raw,
      })
    );
  };

  H.HttpClient = HttpClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
