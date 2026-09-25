/**
 * 被动取数：hook 页面自身的 `fetch` 与 `XMLHttpRequest`，旁听站点已经发出的课程查询响应。
 *
 * 【设计意图（沿用桌面版）】**零额外请求**：不去主动拉课程列表，而是听页面自己发的请求，
 * 解析后喂给 M3 的课程列表视图。这样既省请求（限流压力最小），也不会触发风控。
 *
 * 【铁律】
 *   1. **绝不改变页面行为**：包装函数必须原样返回原始 promise / 调用原始方法；
 *   2. **绝不抛异常到页面**：所有 hook 体都包 try/catch，出问题只累计到 stats；
 *   3. **幂等**：重复 install 直接返回已有句柄，不会重复包装（避免拦截链越套越深）。
 *
 * 【能听到什么 / 听不到什么】
 *   - 听得到：页面发出的 XHR/fetch 响应**体**（含课程 JSON）；
 *   - 听不到：响应头（CSP 等）—— 浏览器不给 JS。
 *
 * 依赖：NS.model（延迟取值，只有 recordsFromResponse 用）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var C = (NS.capture = NS.capture || {});

  /** 挂在 window 上的安装标记（幂等用）。 */
  C.INSTALL_FLAG = '__SZUBKXK_CAPTURE__';

  /**
   * 【前提】油猴脚本场景下每个页面只有一个 window、一份 `fetch` 与一份 `XMLHttpRequest`，
   * 所以幂等标记挂在 window 上就够了。
   * 注意：若把同一个 XHR 类共享给多个 window 分别 install，prototype 会被包装多轮，
   * 单测里必须给每个假 window 各自独立的 XHR 类（见 tests/data.test.js）。
   */

  /** 关心的端点：课程查询、已选结果、查容量。 */
  C.INTERESTING_RE = /\/xsxkapp\/.*(?:programCourse|publicCourse|recommendedCourse|queryCourse|courseResult|volunteered|teachingclass\/capacity)\.do/i;

  /**
   * 保留最近若干条**原始响应文本**，供诊断面板"复制回传"。
   * 这是在没有真实抓包的情况下确认站点字段形态的唯一途径。
   */
  C.MAX_SAMPLES = 5;
  C.SAMPLE_TEXT_LIMIT = 20000;

  /**
   * 这个 URL 是否值得旁听。
   * @param {string} url 请求地址
   * @returns {boolean}
   */
  C.isInterestingUrl = function (url) {
    return typeof url === 'string' && C.INTERESTING_RE.test(url);
  };

  /** 截断过长文本，保留头尾（头尾都要，头部有字段名、尾部能看出结构是否完整）。 */
  C.truncateSample = function (text, limit) {
    var s = typeof text === 'string' ? text : '';
    var max = typeof limit === 'number' && limit > 0 ? limit : C.SAMPLE_TEXT_LIMIT;
    if (s.length <= max) return s;
    var head = Math.floor(max * 0.7);
    var tail = max - head;
    return s.slice(0, head) + '\n…（已截断 ' + (s.length - max) + ' 字符）…\n' + s.slice(s.length - tail);
  };

  /**
   * 从一次捕获到的响应里解析出统一教学班级记录。
   * @param {object} payload {url, source, text, json}
   * @param {object} [meta] {teachingClassType, batchCode, source}
   * @returns {object[]} 记录数组（解析不出来就是空数组）
   */
  C.recordsFromResponse = function (payload, meta) {
    if (!payload || !payload.json || typeof payload.json !== 'object') return [];
    var body = payload.json;
    var data = body.data !== undefined && body.data !== null ? body.data : body;
    if (!NS.model) return [];
    return NS.model.flattenResponse(data, meta);
  };

  /**
   * 安装 hook。
   * @param {object} options
   * @param {object} [options.win] 目标 window，默认全局对象
   * @param {Function} [options.onResponse] 回调 function({url, source, text, json})
   * @param {Function} [options.matches] 自定义 URL 判定，默认 C.isInterestingUrl
   * @returns {object} 句柄 {installedAt, stats, uninstall}
   */
  C.install = function (options) {
    options = options || {};
    var win = options.win || root;
    if (win[C.INSTALL_FLAG]) return win[C.INSTALL_FLAG]; // 幂等

    var onResponse = typeof options.onResponse === 'function' ? options.onResponse : null;
    var matches = typeof options.matches === 'function' ? options.matches : C.isInterestingUrl;
    var maxSamples = typeof options.maxSamples === 'number' ? options.maxSamples : C.MAX_SAMPLES;
    var sampleLimit = typeof options.sampleLimit === 'number' ? options.sampleLimit : C.SAMPLE_TEXT_LIMIT;
    var originals = {};
    var stats = { captured: 0, parseFailed: 0, errors: 0 };
    var samples = [];

    /** 统一处理一条捕获到的响应。 */
    function handle(url, source, text) {
      stats.captured += 1;
      try {
        if (maxSamples > 0) {
          if (samples.length >= maxSamples) samples.shift();
          samples.push({
            url: url,
            source: source,
            at: Date.now(),
            length: text ? text.length : 0,
            text: C.truncateSample(text, sampleLimit),
          });
        }
      } catch (e) {
        stats.errors += 1;
      }
      if (!onResponse) return;
      var json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        if (text) stats.parseFailed += 1;
      }
      try {
        onResponse({ url: url, source: source, text: text, json: json });
      } catch (e) {
        stats.errors += 1; // 订阅者出错绝不能影响页面
      }
    }

    /* ---------------- fetch ---------------- */
    if (typeof win.fetch === 'function') {
      originals.fetch = win.fetch;
      win.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var promise = originals.fetch.apply(this, arguments);
        try {
          if (matches(url)) {
            promise.then(
              function (res) {
                try {
                  var clone = res && typeof res.clone === 'function' ? res.clone() : res;
                  if (!clone || typeof clone.text !== 'function') return;
                  clone.text().then(function (text) {
                    handle(url, 'fetch', text);
                  }, function () {});
                } catch (e) {
                  stats.errors += 1;
                }
              },
              function () {}
            );
          }
        } catch (e) {
          stats.errors += 1;
        }
        return promise; // 原样返回，页面行为不变
      };
    }

    /* ---------------- XMLHttpRequest ---------------- */
    var XHR = win.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      originals.open = XHR.prototype.open;
      originals.send = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__szubkxk_url = url;
        } catch (e) {
          /* 有些实现可能是只读对象，忽略 */
        }
        return originals.open.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        var self = this;
        try {
          var url = self.__szubkxk_url || '';
          if (matches(url) && typeof self.addEventListener === 'function') {
            self.addEventListener('load', function () {
              var text = '';
              try {
                text = self.responseText || '';
              } catch (e) {
                text = '';
              }
              handle(url, 'xhr', text);
            });
          }
        } catch (e) {
          stats.errors += 1;
        }
        return originals.send.apply(this, arguments);
      };
    }

    var handleObj = {
      installedAt: Date.now(),
      stats: stats,
      /** 最近捕获到的原始响应样本（副本）。 */
      samples: function () {
        return samples.slice();
      },
      /** 清空样本。 */
      clearSamples: function () {
        samples = [];
      },
      /** 卸载 hook 并还原页面原始方法。 */
      uninstall: function () {
        try {
          if (originals.fetch && win.fetch) win.fetch = originals.fetch;
          if (XHR && XHR.prototype) {
            if (originals.open) XHR.prototype.open = originals.open;
            if (originals.send) XHR.prototype.send = originals.send;
          }
        } catch (e) {
          stats.errors += 1;
        }
        try {
          delete win[C.INSTALL_FLAG];
        } catch (e) {
          win[C.INSTALL_FLAG] = null;
        }
      },
    };

    win[C.INSTALL_FLAG] = handleObj;
    return handleObj;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
