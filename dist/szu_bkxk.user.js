// ==UserScript==
// @name         深大选课助手 v2
// @namespace    https://github.com/emo-bird/szu_bkxk
// @version      2.1.0
// @description  深圳大学选课站点辅助工具：课程列表优化 / 抢课任务 / 容量监控 / 自定义课程与冲突计算。仅供技术学习研究，使用风险自负。
// @author       emo-bird
// @match        http://bkxk.szu.edu.cn/*
// @match        https://bkxk.szu.edu.cn/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/emo-bird/szu_bkxk/master-tampermonkey-v2/dist/szu_bkxk.user.js
// @downloadURL  https://raw.githubusercontent.com/emo-bird/szu_bkxk/master-tampermonkey-v2/dist/szu_bkxk.user.js
// @supportURL   https://github.com/emo-bird/szu_bkxk/issues
// ==/UserScript==

/* ==================== src/core.js ==================== */
/**
 * 命名空间 / 日志 / 存储 / 限流队列。
 *
 * 限流队列是**所有对学校站点请求的唯一出口**：站点对高频请求会直接终止会话
 * （v1 桌面版实测踢掉过登录态），因此任何请求都不得绕过。
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});

  /** 版本号：由构建脚本从 package.json 注入，勿手改。 */
  NS.VERSION = '2.1.0';

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
    // 响应接管（两个功能各自独立开关，关闭后完全不接管）
    hijackTimetable: true,
    hijackListConflict: true,
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

  /**
   * 通用的 JSON 持久化（localStorage）。
   * 只用来存**任务/监控配置**这类非敏感数据 ——
   * 红线③：**绝不**把 token / cookie / 学号写进来。
   */
  var STORE_PREFIX = 'szubkxk.v2.';

  NS.store = {
    get: function (key, dflt) {
      try {
        var raw = root.localStorage && root.localStorage.getItem(STORE_PREFIX + key);
        if (!raw) return dflt;
        var v = JSON.parse(raw);
        return v === undefined || v === null ? dflt : v;
      } catch (e) {
        NS.warn('读取存储失败 ' + key, e && e.message);
        return dflt;
      }
    },
    set: function (key, value) {
      try {
        root.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        NS.warn('写入存储失败 ' + key, e && e.message);
        return false;
      }
    },
    del: function (key) {
      try {
        root.localStorage.removeItem(STORE_PREFIX + key);
      } catch (e) { /* 忽略 */ }
    },
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

/* ==================== src/api.js ==================== */
/**
 * 报文构造 + 响应分类 + 未识别落档。
 * 字段顺序与取值均按 HAR 实测（docs/bkxk.szu.edu.cn-*.har），**不要随意调整顺序**。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var API = (NS.api = NS.api || {});

  var BASE = '/xsxkapp/sys/xsxkapp/';

  API.EP = {
    // 只读：课程查询（按类别分派）
    PROGRAM_COURSE: 'elective/programCourse.do',
    PUBLIC_COURSE: 'elective/publicCourse.do',
    RECOMMENDED_COURSE: 'elective/recommendedCourse.do',
    QUERY_COURSE: 'elective/queryCourse.do',
    // 只读：其它
    COURSE_RESULT: 'elective/courseResult.do',
    CAPACITY: 'elective/teachingclass/capacity.do',
    // 写：默认关闭
    VOLUNTEER: 'elective/volunteer.do',
  };

  /**
   * 类别代码 → 列表端点。
   * 【来源】站点 grablessons.js 的 reloadCourseList 映射 + grablessonsBS.js 的端点定义：
   *   FANKC 方案内 / FAWKC 方案外 / TJKC 推荐 / XGXK 校公选 /
   *   CXKC 重修 / TYKC 体育 / FXKC 辅修 / MOOC 慕课
   * 注：CXKC（重修）不在开发文档 §五 的列表里，是读站点源码补上的。
   * 未经真机验证的分支已在注释标出。
   */
  API.CATEGORY_EP = {
    FANKC: API.EP.PROGRAM_COURSE,
    FAWKC: API.EP.PROGRAM_COURSE, // 未实测
    TJKC: API.EP.RECOMMENDED_COURSE,
    XGXK: API.EP.PUBLIC_COURSE,
    CXKC: API.EP.PROGRAM_COURSE, // 未实测
    TYKC: API.EP.PROGRAM_COURSE, // 未实测
    FXKC: API.EP.PROGRAM_COURSE, // 未实测
    MOOC: API.EP.PUBLIC_COURSE,
  };

  /** 全部类别代码（顺序对应选课页的页签）。 */
  API.CATEGORIES = ['FANKC', 'FAWKC', 'TJKC', 'XGXK', 'CXKC', 'TYKC', 'FXKC', 'MOOC'];

  /** 类别代码 → 中文名（界面显示用）。 */
  API.CATEGORY_NAME = {
    FANKC: '方案内',
    FAWKC: '方案外',
    TJKC: '推荐',
    XGXK: '校公选',
    CXKC: '重修',
    TYKC: '体育',
    FXKC: '辅修',
    MOOC: '慕课',
  };

  API.RESP_KIND = { OK: 'ok', BUSINESS: 'business', UNAUTHENTICATED: 'unauthenticated', UNKNOWN: 'unknown' };
  API.RESP_CODE = { SUCCESS: '1', BUSINESS_ERROR: '2', UNAUTHENTICATED: '302' };

  /** 登录失效的文案特征（仅 code 无法判定时兜底）。 */
  var AUTH_MSG = /登录|认证/;

  API.url = function (ep) {
    return BASE + ep;
  };

  /** 给接口 URL 追加 `?timestamp=<13位毫秒>`（站点要求；已有 query 用 &）。 */
  API.appendTimestamp = function (url, nowMs) {
    var ts = typeof nowMs === 'number' ? nowMs : Date.now();
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'timestamp=' + ts;
  };

  /** 编码为 application/x-www-form-urlencoded。 */
  API.formBody = function (obj) {
    var parts = [];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] === undefined || obj[k] === null ? '' : String(obj[k])));
    }
    return parts.join('&');
  };

  /**
   * 构造抢课请求体。
   * 【实测形状】必须包一层 `{"data":{...}}`（HAR 抓包核对）：
   *   addParam={"data":{"operationType":"1","studentCode":…,"teachingClassType":"FANKC"}}
   * 内层字段顺序固定：operationType / studentCode / electiveBatchCode /
   * teachingClassId / isMajor / campus / teachingClassType。
   * @returns {string} `addParam=<urlencode(JSON)>`
   */
  API.buildVolunteerBody = function (p) {
    var payload = {
      data: {
        operationType: '1',
        studentCode: String(p.studentCode),
        electiveBatchCode: String(p.electiveBatchCode),
        teachingClassId: String(p.teachingClassId),
        isMajor: p.isMajor === undefined || p.isMajor === null ? '1' : String(p.isMajor),
        campus: p.campus === undefined || p.campus === null ? '01' : String(p.campus),
        teachingClassType: String(p.teachingClassType),
      },
    };
    return 'addParam=' + encodeURIComponent(JSON.stringify(payload));
  };

  /** 构造查容量请求体（只读，监控轮询首选——比拉整页列表轻得多）。 */
  API.buildCapacityBody = function (teachingClassId, batchCode) {
    return API.formBody({ teachingClassId: teachingClassId, batchCode: batchCode });
  };

  /**
   * 构造列表查询请求体。
   * HAR 实测形态：`querySetting=<urlencode(JSON)>`，内层 data + 分页。
   */
  API.buildQueryBody = function (p) {
    var setting = {
      data: {
        studentCode: String(p.studentCode),
        campus: p.campus === undefined || p.campus === null ? '01' : String(p.campus),
        electiveBatchCode: String(p.electiveBatchCode),
        isMajor: p.isMajor === undefined || p.isMajor === null ? '1' : String(p.isMajor),
        teachingClassType: String(p.teachingClassType),
        checkConflict: '2',
        checkCapacity: '2',
        queryContent: p.queryContent === undefined ? 'YCJX:2,MOOC:2,' : String(p.queryContent),
      },
      pageSize: String(p.pageSize === undefined ? 10 : p.pageSize),
      pageNumber: String(p.pageNumber === undefined ? 0 : p.pageNumber),
      order: p.order === undefined ? '' : String(p.order),
      orderBy: p.orderBy === undefined ? 'courseNumber' : String(p.orderBy),
    };
    return 'querySetting=' + encodeURIComponent(JSON.stringify(setting));
  };

  /**
   * 请求头。
   * ⚠️ 返回值**包含 token**，只允许传给发请求的一方；**严禁写入日志或持久化**。
   * cookie 不在此设置 —— 同源 fetch 由浏览器自动附带。
   */
  API.headers = function (token) {
    return { token: String(token), 'X-Requested-With': 'XMLHttpRequest' };
  };

  /**
   * 从页面取会话令牌（站点放在 sessionStorage.token）。
   * 站点所有接口都要求 cookie + 请求头 `token` 缺一不可，故这是发请求的必需品。
   */
  API.sessionToken = function () {
    try {
      return (root.sessionStorage && root.sessionStorage.getItem('token')) || '';
    } catch (e) {
      return '';
    }
  };

  /** HTTP 状态码是否表示登录态失效。 */
  API.isAuthStatus = function (status) {
    return status === 401 || status === 403;
  };

  /**
   * 分类一次响应。判定顺序**不要调整**（按实测行为定的）：
   *   1. HTTP 401/403 → 登录失效；
   *   2. 非 JSON → 未识别；
   *   3. code=1 成功 / code=2 业务拒绝 / code=302 登录失效；
   *   4. code 无法判定 → msg 含「登录」「认证」→ 登录失效；
   *   5. 其余 → 未识别（调用方必须全量落档）。
   * @param {object} input {status, text}
   * @returns {{kind:string, code:*, msg:string, data:*, json:*}}
   */
  API.classify = function (input) {
    var status = input && input.status;
    var text = input && input.text === undefined ? '' : String(input.text || '');
    var out = { kind: API.RESP_KIND.UNKNOWN, code: null, msg: '', data: null, json: null };

    if (API.isAuthStatus(status)) {
      out.kind = API.RESP_KIND.UNAUTHENTICATED;
      out.msg = 'HTTP ' + status;
      return out;
    }

    var json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      out.kind = API.RESP_KIND.UNKNOWN;
      out.msg = '响应不是 JSON';
      return out;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      out.kind = API.RESP_KIND.UNKNOWN;
      out.msg = 'JSON 顶层不是对象';
      return out;
    }
    out.json = json;
    out.code = json.code === undefined ? null : json.code;
    out.msg = json.msg === undefined || json.msg === null ? '' : String(json.msg);
    out.data = json.data === undefined ? null : json.data;

    var code = out.code === null ? '' : String(out.code);
    if (code === API.RESP_CODE.SUCCESS) out.kind = API.RESP_KIND.OK;
    else if (code === API.RESP_CODE.BUSINESS_ERROR) out.kind = API.RESP_KIND.BUSINESS;
    else if (code === API.RESP_CODE.UNAUTHENTICATED) out.kind = API.RESP_KIND.UNAUTHENTICATED;
    else if (AUTH_MSG.test(out.msg)) out.kind = API.RESP_KIND.UNAUTHENTICATED;
    else out.kind = API.RESP_KIND.UNKNOWN;

    return out;
  };

  /**
   * 从 capacity.do 的 data 算剩余名额。
   * 【重要】实测 classCapacity/numberOfFirstVolunteer/isFull **全是 null**，
   * 只有 mainClassCapacity / mainElectiveNumber 有效。
   * 字段缺失或非法时返回 **null**（不是 0）—— 0 会被误判成「满课」。
   */
  API.capacityRemain = function (data) {
    if (!data || typeof data !== 'object') return null;
    if (data.mainClassCapacity === undefined || data.mainClassCapacity === null) return null;
    if (data.mainElectiveNumber === undefined || data.mainElectiveNumber === null) return null;
    var cap = Number(data.mainClassCapacity);
    var used = Number(data.mainElectiveNumber);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /**
   * 发一次经过限流队列的请求。**唯一出口**，不要绕过。
   *
   * 【两处实测结论，别改错】
   * 1. token 必须带：站点要求 cookie + 请求头 `token` 缺一不可。
   *    未显式传 o.token 时自动取 sessionStorage.token（否则服务端会报
   *    `value sent to redis cannot be null` 这类错误）。
   * 2. **不自动追加 timestamp**：HAR 实测 volunteer.do / capacity.do /
   *    programCourse.do 等都没有 query，只有部分端点（courseResult.do、
   *    deleteVolunteer.do 等）才带。需要时用 o.timestamp = true 显式开启。
   * @param {object} o {url, method, body, token, priority, timestamp, action}
   * @returns {Promise<{status:number, text:string, cls:object}>}
   */
  API.send = function (o) {
    return NS.queue.submit(function () {
      var token = o.token || API.sessionToken();
      var headers = {};
      if (token) {
        var h = API.headers(token);
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = h[k];
      }
      if (o.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      var url = o.timestamp ? API.appendTimestamp(o.url) : o.url;
      NS.info('[请求] ' + (o.action || '') + ' ' + url + (o.body ? ' | ' + o.body : ''));
      return root.fetch(url, {
        method: o.method || 'POST',
        credentials: 'include',
        headers: headers,
        body: o.body,
        // 标记「本脚本发出」，响应接管据此跳过（接管只针对站点自己的请求）
        __szuSkip: true,
      }).then(function (res) {
        return res.text().then(function (text) {
          var cls = API.classify({ status: res.status, text: text });
          // 红线④：未识别必须全量落档
          if (cls.kind === API.RESP_KIND.UNKNOWN) {
            NS.dumpUnknown({
              action: o.action || '?',
              url: url,
              body: o.body || '',
              text: text,
              code: cls.code,
              msg: cls.msg,
            });
          }
          return { status: res.status, text: text, cls: cls };
        });
      });
    }, o.priority);
  };

  /** 从任意列表响应里挖出 electiveBatchCode（batchCode 的真实来源）。 */
  API.extractBatchCode = function (json) {
    var found = null;
    var seen = {};
    function walk(node, depth) {
      if (found || depth > 6 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && !found; i++) walk(node[i], depth + 1);
        return;
      }
      var bc = node.electiveBatchCode;
      if (typeof bc === 'string' && bc) {
        if (!seen[bc]) seen[bc] = 0;
        seen[bc] += 1;
        if (!found) found = bc;
      }
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], depth + 1);
      }
    }
    walk(json, 0);
    return { batchCode: found, counts: seen };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/time.js ==================== */
/**
 * 教学时间解析 + 冲突判定。
 *
 * teachingPlace 实测形态（两种分隔差异，都要兼容）：
 *   HAR-1: "5-18周 星期二 1-2节 汇文楼H3-104,5-18周 星期四 3-4节 汇文楼H3-104"
 *   HAR-2: "5-18周星期二3-4节致理楼L1-707,5-18周星期四1-2节致理楼L1-707"
 * MOOC 课程可能为 null。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var T = (NS.time = NS.time || {});

  /** 星期中文 → 数字（1=周一 ... 7=周日）。 */
  var WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

  /** 中文数字 → 阿拉伯数字（支持「十」「十二」这类）。 */
  function cn2num(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + (map[s[1]] || 0);
    if (s.length === 2 && s[1] === '十') return (map[s[0]] || 0) * 10;
    if (s.length === 3 && s[1] === '十') return (map[s[0]] || 0) * 10 + (map[s[2]] || 0);
    return map[s] || NaN;
  }

  /**
   * 解析单段："5-18周 星期二 3-4节 致理楼L1-707" → 结构化。
   * 容错：空格可有可无（站点两处响应空格不一致）。
   * @returns {object|null}
   */
  T.parseSegment = function (seg) {
    if (!seg || typeof seg !== 'string') return null;
    var s = seg.trim();
    if (!s) return null;

    // 周次：5-18周 / 1-16周(单) / 3周
    var weekRe = /(\d+)(?:\s*-\s*(\d+))?\s*周\s*(?:[（(]\s*(单|双)\s*[)）])?/;
    var wm = weekRe.exec(s);
    if (!wm) return null;
    var from = parseInt(wm[1], 10);
    var to = wm[2] === undefined ? from : parseInt(wm[2], 10);
    var parity = wm[3] || null;

    // 星期
    var dm = /星期\s*([一二三四五六日天])/.exec(s);
    var day = dm ? WEEKDAY[dm[1]] : null;

    // 节次：3-4节 / 3节
    var jm = /(\d+)(?:\s*-\s*(\d+))?\s*节/.exec(s);
    if (!jm) return null;
    var jFrom = parseInt(jm[1], 10);
    var jTo = jm[2] === undefined ? jFrom : parseInt(jm[2], 10);

    // 地点：节次之后剩下的部分
    var afterIdx = s.indexOf(jm[0]) + jm[0].length;
    var place = s.slice(afterIdx).trim();

    return {
      weekFrom: from,
      weekTo: to,
      parity: parity,
      day: day,
      sectionFrom: jFrom,
      sectionTo: jTo,
      place: place,
      raw: s,
    };
  };

  /**
   * 解析整串 teachingPlace（逗号/中文逗号分隔多段）。
   * @param {string|null} text
   * @returns {object[]} 段数组；无法解析的段被丢弃
   */
  T.parse = function (text) {
    if (!text || typeof text !== 'string') return [];
    var parts = text.split(/[,，]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = T.parseSegment(parts[i]);
      if (seg) out.push(seg);
    }
    return out;
  };

  /** 某周是否落在该段内（考虑单双周）。 */
  T.weekMatches = function (seg, week) {
    if (week < seg.weekFrom || week > seg.weekTo) return false;
    if (!seg.parity) return true;
    var isOdd = week % 2 === 1;
    return seg.parity === '单' ? isOdd : !isOdd;
  };

  /** 两段是否在节次上重叠。 */
  T.sectionsOverlap = function (a, b) {
    return a.sectionFrom <= b.sectionTo && b.sectionFrom <= a.sectionTo;
  };

  /**
   * 判断两段是否冲突：同一天 + 节次重叠 + 存在共同的周（且满足单双周）。
   * @returns {boolean}
   */
  T.segmentsConflict = function (a, b) {
    if (!a || !b) return false;
    if (a.day === null || b.day === null) return false;
    if (a.day !== b.day) return false;
    if (!T.sectionsOverlap(a, b)) return false;
    var lo = Math.max(a.weekFrom, b.weekFrom);
    var hi = Math.min(a.weekTo, b.weekTo);
    for (var w = lo; w <= hi; w++) {
      if (T.weekMatches(a, w) && T.weekMatches(b, w)) return true;
    }
    return false;
  };

  /**
   * 判断两条 teachingPlace 字符串是否冲突。
   * 任一侧不可解析（如 MOOC 的 null）时返回 false —— 不误报。
   */
  T.conflicts = function (placeA, placeB) {
    var a = typeof placeA === 'string' ? T.parse(placeA) : placeA || [];
    var b = typeof placeB === 'string' ? T.parse(placeB) : placeB || [];
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        if (T.segmentsConflict(a[i], b[j])) return true;
      }
    }
    return false;
  };

  /**
   * 在一组课程里找出与目标冲突的项。
   * @param {string} targetPlace 目标 teachingPlace
   * @param {object[]} courses 其它课程（需含 teachingPlace 字段）
   * @returns {object[]} 冲突的课程
   */
  T.findConflicts = function (targetPlace, courses) {
    var out = [];
    var list = courses || [];
    for (var i = 0; i < list.length; i++) {
      if (T.conflicts(targetPlace, list[i] && list[i].teachingPlace)) out.push(list[i]);
    }
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/courses.js ==================== */
/**
 * 被动取数 + 字段映射。
 *
 * 结构陷阱（HAR 实测）：
 *   - programCourse.do / recommendedCourse.do 等是**嵌套结构**：dataList[] → tcList[]
 *   - publicCourse.do（校公选/慕课）是**扁平结构**：没有 tcList，一行即一个教学班
 *   - 嵌套结构里教学班级的字段可能为 null，**不得覆盖**课程级字段
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var C = (NS.courses = NS.courses || {});

  /** 取第一个非 null/undefined/空串的值。 */
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  /** 归一化一个教学班（无论来自嵌套还是扁平结构）。 */
  function normClass(tc, course) {
    tc = tc || {};
    course = course || {};
    return {
      teachingClassID: pick(tc.teachingClassID, tc.teachingClassId, course.teachingClassID),
      courseNumber: pick(tc.courseNumber, course.courseNumber),
      courseName: pick(tc.courseName, course.courseName, tc.title, course.title),
      teacherName: pick(tc.teacherName, course.teacherName),
      teachingPlace: pick(tc.teachingPlace, course.teachingPlace),
      courseTotalNumber: pick(tc.courseTotalNumber, course.courseTotalNumber),
      classCapacity: pick(tc.classCapacity, course.classCapacity),
      numberOfFirstVolunteer: pick(tc.numberOfFirstVolunteer, course.numberOfFirstVolunteer),
      courseIndex: pick(tc.courseIndex, course.courseIndex),
      isMooc: pick(tc.isMooc, course.isMooc),
      isFull: pick(tc.isFull, course.isFull),
      isConflict: pick(tc.isConflict, course.isConflict),
      isFavorite: pick(tc.isFavorite, course.isFavorite),
      typeName: pick(tc.typeName, course.typeName),
      courseNatureName: pick(tc.courseNatureName, course.courseNatureName),
      departmentName: pick(tc.departmentName, course.departmentName),
      credit: pick(tc.credit, course.credit),
      campus: pick(tc.campus, course.campus),
    };
  }

  /** 单条 dataList 项 → 教学班数组。自动区分嵌套/扁平。 */
  C.classesOf = function (item) {
    if (!item || typeof item !== 'object') return [];
    var tcList = item.tcList;
    if (Array.isArray(tcList)) {
      var out = [];
      for (var i = 0; i < tcList.length; i++) out.push(normClass(tcList[i], item));
      return out;
    }
    // 扁平结构：item 自己就是一个教学班
    return [normClass(item, item)];
  };

  /**
   * 整个列表响应 → 扁平的教学班数组。
   * @param {object} json 接口原始 JSON
   * @returns {object[]}
   */
  C.flatten = function (json) {
    var data = json && json.data;
    if (!data || typeof data !== 'object') return [];
    var list = data.dataList;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var classes = C.classesOf(list[i]);
      for (var j = 0; j < classes.length; j++) out.push(classes[j]);
    }
    return out;
  };

  /** 剩余名额；字段缺失返回 null（**不是 0**）。 */
  C.remainOf = function (c) {
    if (!c) return null;
    var cap = Number(c.classCapacity);
    var used = Number(c.numberOfFirstVolunteer);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /** 拿当前批次码：优先用户覆盖值，否则从列表响应提取。 */
  C.resolveBatchCode = function () {
    var s = NS.settings();
    if (s.batchCode) return s.batchCode;
    return '';
  };

  /** 从列表响应提取并保存 batchCode（用户未手填时才写）。 */
  C.learnBatchCode = function (json) {
    var got = NS.api.extractBatchCode(json);
    if (!got.batchCode) return null;
    var s = NS.settings();
    if (!s.batchCode) {
      NS.saveSettings({ batchCode: got.batchCode });
      NS.info('自动获取 batchCode: ' + got.batchCode);
    }
    return got;
  };

  /**
   * 拉一个类别的课程列表。
   * @param {object} o {category, studentCode, batchCode, pageNumber, pageSize, token}
   */
  C.fetchCategory = function (o) {
    var ep = NS.api.CATEGORY_EP[o.category] || NS.api.EP.PROGRAM_COURSE;
    var body = NS.api.buildQueryBody({
      studentCode: o.studentCode,
      electiveBatchCode: o.batchCode,
      teachingClassType: o.category,
      pageNumber: o.pageNumber,
      pageSize: o.pageSize,
    });
    return NS.api
      .send({
        action: '列表查询 ' + o.category,
        url: NS.api.url(ep),
        method: 'POST',
        body: body,
        token: o.token,
      })
      .then(function (r) {
        if (r.cls.kind === NS.api.RESP_KIND.OK) C.learnBatchCode(r.cls.json);
        return { kind: r.cls.kind, msg: r.cls.msg, classes: C.flatten(r.cls.json), raw: r.cls.json };
      });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/custom.js ==================== */
/**
 * 自定义课程（P2）：用于课表显示 + 计入冲突计算。
 *
 * 【为什么需要】站点课表只显示已选上的课，但用户可能想看到「正在抢的课」，
 * 或手工录入一门不来自站点的课，以判断时间是否冲突。
 *
 * 【冲突计算】复用 NS.time 的 teachingPlace 解析，与站点课程同一套判定。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var C = (NS.custom = NS.custom || {});

  var STORE_KEY = 'customCourses';

  /** 自定义课程列表。 */
  C.items = [];

  /**
   * 一条自定义课程：
   *   { id, name, teacher, place, color, enabled }
   * place 用与站点一致的写法，例如 `5-18周 星期二 3-4节 致理楼L1-707`
   * （支持逗号分隔多段）
   */
  C.add = function (info) {
    if (!info || !info.name) return null;
    var segs = NS.time.parse(info.place || '');
    var rec = {
      id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
      name: String(info.name),
      teacher: info.teacher ? String(info.teacher) : '',
      place: info.place ? String(info.place) : '',
      color: info.color || C.colorAt(C.items.length),
      enabled: info.enabled !== false,
      segs: segs,
    };
    C.items.push(rec);
    C.save();
    NS.info('新增自定义课程 ' + rec.name + '（解析出 ' + segs.length + ' 段）');
    return rec;
  };

  C.remove = function (id) {
    for (var i = 0; i < C.items.length; i++) {
      if (C.items[i].id === id) {
        C.items.splice(i, 1);
        C.save();
        return true;
      }
    }
    return false;
  };

  C.byId = function (id) {
    for (var i = 0; i < C.items.length; i++) if (C.items[i].id === id) return C.items[i];
    return null;
  };

  C.update = function (id, patch) {
    var rec = C.byId(id);
    if (!rec) return false;
    if (patch.name !== undefined) rec.name = String(patch.name);
    if (patch.teacher !== undefined) rec.teacher = String(patch.teacher);
    if (patch.place !== undefined) {
      rec.place = String(patch.place);
      rec.segs = NS.time.parse(rec.place);
    }
    if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
    C.save();
    return true;
  };

  C.clear = function () {
    C.items = [];
    C.save();
  };

  /** 配色循环（只用于区分显示，不参与任何逻辑）。 */
  C.COLORS = ['#e8f2fd', '#fdf0e8', '#e8fdf0', '#f2e8fd', '#fdfde8', '#fde8f0'];
  C.colorAt = function (i) {
    return C.COLORS[i % C.COLORS.length];
  };

  C.save = function () {
    // 只存原始字段，segs 由 place 重新解析（避免存派生数据）
    var slim = C.items.map(function (c) {
      return {
        id: c.id, name: c.name, teacher: c.teacher,
        place: c.place, color: c.color, enabled: c.enabled,
      };
    });
    NS.store.set(STORE_KEY, slim);
  };

  C.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!Array.isArray(data)) return 0;
    C.items = data.map(function (c) {
      return {
        id: c.id || ('c' + Date.now() + Math.floor(Math.random() * 1000)),
        name: c.name || '',
        teacher: c.teacher || '',
        place: c.place || '',
        color: c.color || C.COLORS[0],
        enabled: c.enabled !== false,
        segs: NS.time.parse(c.place || ''),
      };
    }).filter(function (c) { return !!c.name; });
    if (C.items.length) NS.info('已恢复 ' + C.items.length + ' 门自定义课程');
    return C.items.length;
  };

  /**
   * 自定义课程与给定课程是否冲突（计入冲突计算）。
   * @param {object[]} otherCourses 其它课程（含 teachingPlace 或 segs）
   * @returns {object[]} 冲突的课程
   */
  C.conflictsWith = function (otherCourses) {
    var out = [];
    for (var i = 0; i < C.items.length; i++) {
      var c = C.items[i];
      if (!c.enabled) continue;
      for (var j = 0; j < otherCourses.length; j++) {
        var o = otherCourses[j];
        if (NS.time.conflicts(c.place, o && o.teachingPlace)) {
          out.push({ custom: c, other: o });
        }
      }
    }
    return out;
  };

  /** 自定义课程两两之间是否冲突。 */
  C.selfConflicts = function () {
    var out = [];
    for (var i = 0; i < C.items.length; i++) {
      for (var j = i + 1; j < C.items.length; j++) {
        if (!C.items[i].enabled || !C.items[j].enabled) continue;
        if (NS.time.conflicts(C.items[i].place, C.items[j].place)) {
          out.push({ a: C.items[i], b: C.items[j] });
        }
      }
    }
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/monitor.js ==================== */
/**
 * 容量监控：两种模式 + 轮询执行 + 命中自动抢。
 *
 * 【两种模式（用户指定，默认类别）】
 *   单独监控 SINGLE   —— 逐个教学班查 `teachingclass/capacity.do`，精确、报文极小
 *   类别监控 CATEGORY —— 拉该类别列表（programCourse.do 等），一次拿到一类里
 *                        所有教学班的余量；余量 = classCapacity - numberOfFirstVolunteer
 *
 * 【命中后】写接口开启则自动抢（MONITOR_HIT 最高优先级插队）；关闭则只提醒。
 *
 * 【安全】所有请求经 core 的限流队列；轮询只在用户显式点「开始监控」后启动
 * （红线⑤：不自动启动任务）。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var M = (NS.monitor = NS.monitor || {});

  M.MODE = { SINGLE: 'single', CATEGORY: 'category' };

  /** 已登记的教学班。 */
  M.items = [];
  M.polling = false;
  M.lastPollAt = null;
  M.pollCount = 0;
  M.hitCount = 0;
  M._timer = null;

  var STORE_KEY = 'monitor';

  /**
   * 落盘 / 加载。
   * 【刻意不存】轮询运行状态（刷新后不自动续跑，红线⑤）与任何凭证（红线③）。
   * 余量数据也一并存下，刷新后界面仍能看到上次结果。
   */
  M.save = function () {
    var slim = [];
    for (var i = 0; i < M.items.length; i++) {
      var m = M.items[i];
      slim.push({
        teachingClassID: m.teachingClassID,
        courseName: m.courseName, teacherName: m.teacherName,
        teachingPlace: m.teachingPlace, category: m.category,
        remain: m.remain, checkedAt: m.checkedAt, hits: m.hits,
        lastMsg: m.lastMsg,
      });
    }
    NS.store.set(STORE_KEY, { items: slim, hitCount: M.hitCount });
  };

  M.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!data || !Array.isArray(data.items)) return 0;
    M.items = data.items.map(function (m) {
      return {
        teachingClassID: String(m.teachingClassID || ''),
        courseName: m.courseName || '',
        teacherName: m.teacherName || '',
        teachingPlace: m.teachingPlace || '',
        category: m.category || '',
        remain: typeof m.remain === 'number' ? m.remain : null,
        checkedAt: m.checkedAt || null,
        hits: m.hits || 0,
        lastMsg: m.lastMsg || '',
      };
    }).filter(function (m) { return !!m.teachingClassID; });
    M.hitCount = data.hitCount || 0;
    // 刷新后一律不处于轮询态
    M.polling = false;
    if (M.items.length) NS.info('已恢复 ' + M.items.length + ' 个监控项');
    return M.items.length;
  };

  M.has = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) return true;
    }
    return false;
  };

  M.byId = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) return M.items[i];
    }
    return null;
  };

  M.add = function (info) {
    if (!info || !info.teachingClassID) return null;
    if (M.has(info.teachingClassID)) return null;
    var s = NS.settings();
    var rec = {
      teachingClassID: info.teachingClassID,
      courseName: info.courseName || '',
      teacherName: info.teacherName || '',
      teachingPlace: info.teachingPlace || '',
      category: info.category || '',
      remain: null,
      checkedAt: null,
      hits: 0,
      lastMsg: '',
    };
    void s;
    M.items.push(rec);
    M.save();
    NS.info('加入监控 ' + rec.teachingClassID, rec.courseName);
    return rec;
  };

  M.remove = function (tcId) {
    for (var i = 0; i < M.items.length; i++) {
      if (M.items[i].teachingClassID === tcId) {
        M.items.splice(i, 1);
        M.save();
        return true;
      }
    }
    return false;
  };

  M.clear = function () {
    M.items = [];
    M.hitCount = 0;
    M.save();
  };

  /** 当前模式。 */
  M.mode = function () {
    var s = NS.settings();
    return s.monitorMode === 'category' ? M.MODE.CATEGORY : M.MODE.SINGLE;
  };

  /** 一次「检查」：依模式选择端点。 */
  M.pollOnce = function () {
    M.lastPollAt = Date.now();
    M.pollCount += 1;
    if (!M.items.length) return Promise.resolve({ checked: 0, hits: [] });
    return (M.mode() === M.MODE.CATEGORY ? M._pollCategory() : M._pollSingle()).then(function (res) {
      return M._afterCheck(res);
    });
  };

  /* ---------------- 单独监控：逐课查 capacity.do ---------------- */

  M.checkOne = function (tcId) {
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode) {
      return Promise.resolve({ remain: null, kind: 'nobatch', msg: '批次码为空（请刷新选课页）' });
    }
    var body = NS.api.buildCapacityBody(tcId, ctx.batchCode);
    return NS.api
      .send({
        action: '查容量 ' + tcId,
        url: NS.api.url(NS.api.EP.CAPACITY),
        method: 'POST',
        body: body,
      })
      .then(function (r) {
        if (r.cls.kind !== NS.api.RESP_KIND.OK) {
          NS.warn('查容量失败 [' + r.cls.kind + '] ' + r.cls.msg + ' | ' + tcId);
          return { remain: null, kind: r.cls.kind, msg: r.cls.msg };
        }
        var remain = NS.api.capacityRemain(r.cls.data);
        M._apply(tcId, remain);
        return { remain: remain, kind: 'ok', msg: r.cls.msg };
      });
  };

  /** 逐个检查（串行，队列本身已限流）。 */
  M._pollSingle = function () {
    var ids = [];
    for (var i = 0; i < M.items.length; i++) ids.push(M.items[i].teachingClassID);
    var out = [];
    return ids
      .reduce(function (chain, id) {
        return chain.then(function () {
          return M.checkOne(id).then(function (r) {
            out.push({ teachingClassID: id, remain: r.remain, kind: r.kind });
          });
        });
      }, Promise.resolve())
      .then(function () { return { checked: out.length, hits: M._hits(out) }; });
  };

  /* ---------------- 类别监控：拉类别列表 ---------------- */

  /** 列表响应的余量算法：classCapacity - numberOfFirstVolunteer。 */
  M.remainOfClass = function (c) {
    if (!c) return null;
    if (c.classCapacity === undefined || c.classCapacity === null || c.classCapacity === '') return null;
    if (c.numberOfFirstVolunteer === undefined || c.numberOfFirstVolunteer === null || c.numberOfFirstVolunteer === '') return null;
    var cap = Number(c.classCapacity);
    var used = Number(c.numberOfFirstVolunteer);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /** 拉一个类别的全部页（最多 MAX_PAGES 页，防止无限翻页）。 */
  M.fetchCategory = function (category) {
    var MAX_PAGES = 4;
    var PAGE_SIZE = 50;
    var ctx = NS.list.sessionContext();
    var all = [];
    var page = 0;
    function step() {
      if (page >= MAX_PAGES) return Promise.resolve(all);
      return NS.courses
        .fetchCategory({
          category: category,
          studentCode: ctx.studentCode,
          batchCode: ctx.batchCode,
          token: NS.api.sessionToken(),
          pageNumber: page,
          pageSize: PAGE_SIZE,
        })
        .then(function (r) {
          if (r.kind !== NS.api.RESP_KIND.OK) {
            NS.warn('类别监控拉取失败 [' + r.kind + '] ' + r.msg + ' | ' + category);
            return all;
          }
          all = all.concat(r.classes || []);
          page += 1;
          if (!r.classes || r.classes.length < PAGE_SIZE) return all;
          return step();
        });
    }
    return step();
  };

  /** 按类别分组拉取，再把余量回填到对应的监控项。 */
  M._pollCategory = function () {
    var byCat = {};
    for (var i = 0; i < M.items.length; i++) {
      var cat = M.items[i].category;
      if (!cat) continue;
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(M.items[i]);
    }
    var cats = Object.keys(byCat);
    if (!cats.length) {
      NS.warn('类别监控：监控项都缺类别代码，无法按类别查询');
      return Promise.resolve({ checked: 0, hits: [] });
    }
    var out = [];
    return cats
      .reduce(function (chain, cat) {
        return chain.then(function () {
          return M.fetchCategory(cat).then(function (classes) {
            var index = {};
            for (var k = 0; k < classes.length; k++) {
              index[classes[k].teachingClassID] = classes[k];
            }
            for (var j = 0; j < byCat[cat].length; j++) {
              var item = byCat[cat][j];
              var cls = index[item.teachingClassID];
              var remain = cls ? M.remainOfClass(cls) : null;
              M._apply(item.teachingClassID, remain);
              out.push({
                teachingClassID: item.teachingClassID,
                remain: remain,
                kind: cls ? 'ok' : 'notfound',
              });
            }
          });
        });
      }, Promise.resolve())
      .then(function () { return { checked: out.length, hits: M._hits(out) }; });
  };

  /* ---------------- 公共 ---------------- */

  M._apply = function (tcId, remain) {
    var item = M.byId(tcId);
    if (!item) return;
    item.remain = remain;
    item.checkedAt = Date.now();
    if (remain !== null && remain > 0) item.hits += 1;
    M.save();
  };

  M._hits = function (rows) {
    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].remain !== null && rows[i].remain > 0) hits.push(rows[i]);
    }
    return hits;
  };

  /** 检查完的收尾：有命中则提醒，写接口开启时自动抢。 */
  M._afterCheck = function (res) {
    var hits = res.hits || [];
    if (hits.length) {
      M.hitCount += hits.length;
      M.save();
      var summary = hits.map(function (h) {
        var it = M.byId(h.teachingClassID);
        return (it && it.courseName ? it.courseName : h.teachingClassID) + ' 余量' + h.remain;
      }).join('；');
      NS.info('监控命中余量：' + summary);
      if (NS.ui) NS.ui.toast('发现余量：' + summary);

      if (!NS.isWriteAllowed(NS.settings())) {
        NS.warn('监控命中余量，但写接口未开启，只提醒不自动抢');
      } else {
        // 依次自动抢（队列会串行化，不会同时打服务器）
        hits.reduce(function (chain, h) {
          return chain.then(function () {
            var item = M.byId(h.teachingClassID);
            return item ? M.grabNow(item) : null;
          });
        }, Promise.resolve());
      }
    }
    if (NS.ui) NS.ui.render();
    return res;
  };

  /**
   * 监控命中后立即抢一次（走 MONITOR_HIT 最高优先级插队）。
   * 失败不在这里重试 —— 交给下一轮轮询再判断，避免死循环。
   */
  M.grabNow = function (item) {
    var s = NS.settings();
    if (!NS.isWriteAllowed(s)) return Promise.resolve({ ok: false, reason: 'write-disabled' });
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode || !ctx.studentCode) return Promise.resolve({ ok: false, reason: 'no-session' });
    if (!item.category) return Promise.resolve({ ok: false, reason: 'no-category' });

    var body = NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: item.teachingClassID,
      campus: ctx.campus,
      teachingClassType: item.category,
    });
    return NS.api
      .send({
        action: '监控自动抢 ' + item.teachingClassID,
        url: NS.api.url(NS.api.EP.VOLUNTEER),
        method: 'POST',
        body: body,
        priority: NS.Queue.PRIORITY.MONITOR_HIT,
      })
      .then(function (r) {
        if (r.cls.kind === NS.api.RESP_KIND.OK) {
          NS.info('监控自动抢成功：' + (item.courseName || item.teachingClassID));
          if (NS.ui) NS.ui.toast('监控抢到：' + (item.courseName || item.teachingClassID));
          M.remove(item.teachingClassID);
          return { ok: true };
        }
        item.lastMsg = r.cls.msg || r.cls.kind;
        NS.warn('监控自动抢未成功 [' + r.cls.kind + '] ' + item.lastMsg);
        return { ok: false, reason: r.cls.kind, msg: item.lastMsg };
      });
  };

  /* ---------------- 轮询 ---------------- */

  M.startPolling = function () {
    if (M.polling) return false;
    if (!M.items.length) return false;
    M.polling = true;
    NS.info('开始监控轮询（' + (M.mode() === M.MODE.CATEGORY ? '类别' : '单独') + '模式）');
    if (NS.ui) NS.ui.toast('已开始监控轮询');
    M._loop();
    return true;
  };

  M._loop = function () {
    if (!M.polling) return;
    M.pollOnce().then(function () {
      if (!M.polling) return;
      var iv = NS.util.clamp(NS.settings().pollIntervalMs, 1000, 60000, 5000);
      M._timer = setTimeout(M._loop, iv);
    });
  };

  M.stopPolling = function () {
    M.polling = false;
    if (M._timer) {
      clearTimeout(M._timer);
      M._timer = null;
    }
    NS.info('已停止监控轮询');
    return true;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/tasks.js ==================== */
/**
 * 抢课任务模型 + 执行引擎。
 *
 * 重试策略三选一（用户指定，默认 smart）：
 *   smart  —— 可重试的继续（满员/容量类），终结性的停并提示原因
 *   never  —— 任何失败都停
 *   always —— 任何失败都持续重试
 *
 * 执行方式：**轮转**（每轮每个活跃任务各尝试一次，然后等待 retryIntervalMs）。
 * 这样某门课满员狂重试时不会把其它任务饿死。
 * 所有请求经 core 的限流队列，用户任务用 HIGH，监控命中用 MONITOR_HIT。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var T = (NS.tasks = NS.tasks || {});

  T.MODE = { SMART: 'smart', NEVER: 'never', ALWAYS: 'always' };
  T.MODE_NAME = { smart: '智能', never: '失败即停', always: '持续重试' };

  T.STATUS = { PENDING: 'pending', RUNNING: 'running', SUCCESS: 'success', FAILED: 'failed' };

  /**
   * 业务返回文案分类。
   * 【顺序重要】先判可重试：`已选人数超过课容量` 同时含「已选」与「容量」，
   * 但它表达的是「满员」，必须算可重试；故 可重试 优先于 终结性。
   */
  var RETRYABLE_RE = /已满|满员|容量|人数/;
  var TERMINAL_RE = /已选|已添加|选中|重复|冲突|学分|门数|门课|限选|性别|年级|不允许|未开放|无权限|不在/;

  /** @returns {'retryable'|'terminal'|'unknown'} */
  T.classifyMsg = function (msg) {
    var m = msg === undefined || msg === null ? '' : String(msg);
    if (RETRYABLE_RE.test(m)) return 'retryable';
    if (TERMINAL_RE.test(m)) return 'terminal';
    return 'unknown';
  };

  /** 依策略判断是否应继续重试。 */
  T.shouldRetry = function (mode, kind) {
    if (mode === T.MODE.ALWAYS) return true;
    if (mode === T.MODE.NEVER) return false;
    // smart：只对可重试/未识别继续（未识别宁可继续，便于事后补分支）
    return kind === 'retryable' || kind === 'unknown';
  };

  T.items = [];
  T.seq = 0;
  T.running = false;
  T.stopped = false;

  var STORE_KEY = 'tasks';

  /**
   * 落盘 / 加载。
   * 只存配置与进度，**不存任何凭证**（红线③）。
   * 页面刷新时正在跑的请求会丢，故加载时把 running 态复位为 pending。
   */
  T.save = function () {
    var slim = [];
    for (var i = 0; i < T.items.length; i++) {
      var t = T.items[i];
      slim.push({
        id: t.id, seq: t.seq,
        teachingClassID: t.teachingClassID,
        courseName: t.courseName, teacherName: t.teacherName,
        category: t.category,
        priority: t.priority, enabled: t.enabled,
        status: t.status === T.STATUS.RUNNING ? T.STATUS.PENDING : t.status,
        retryMode: t.retryMode,
        attempts: t.attempts, lastMsg: t.lastMsg, lastKind: t.lastKind,
        addedAt: t.addedAt,
      });
    }
    NS.store.set(STORE_KEY, { seq: T.seq, items: slim });
  };

  T.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!data || !Array.isArray(data.items)) return 0;
    T.items = data.items.map(function (t) {
      return {
        id: t.id || ('t' + (++T.seq)),
        seq: t.seq || 0,
        teachingClassID: String(t.teachingClassID || ''),
        courseName: t.courseName || '',
        teacherName: t.teacherName || '',
        category: t.category || '',
        priority: typeof t.priority === 'number' ? t.priority : 0,
        enabled: t.enabled !== false,
        // 刷新前正在请求的，复位为等待
        status: t.status === T.STATUS.RUNNING ? T.STATUS.PENDING : (t.status || T.STATUS.PENDING),
        retryMode: T.MODE_NAME[t.retryMode] ? t.retryMode : T.MODE.SMART,
        attempts: t.attempts || 0,
        lastMsg: t.lastMsg || '',
        lastKind: t.lastKind || '',
        addedAt: t.addedAt || Date.now(),
      };
    }).filter(function (t) { return !!t.teachingClassID; });
    T.seq = Math.max(data.seq || 0, T.items.length);
    if (T.items.length) NS.info('已恢复 ' + T.items.length + ' 个抢课任务');
    return T.items.length;
  };

  T.retryIntervalMs = function () {
    var s = NS.settings();
    return NS.util.clamp(s.retryIntervalMs, 500, 60000, 1500);
  };

  T.active = function () {
    var out = [];
    for (var i = 0; i < T.items.length; i++) {
      var t = T.items[i];
      if (t.enabled && (t.status === T.STATUS.PENDING || t.status === T.STATUS.RUNNING)) out.push(t);
    }
    // 优先级小的先试；同级按加入顺序
    out.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.seq - b.seq;
    });
    return out;
  };

  T.findByTc = function (tcId) {
    for (var i = 0; i < T.items.length; i++) if (T.items[i].teachingClassID === tcId) return T.items[i];
    return null;
  };

  T.add = function (info) {
    if (!info || !info.teachingClassID) return null;
    var exist = T.findByTc(info.teachingClassID);
    if (exist) return exist;
    var s = NS.settings();
    var task = {
      id: 't' + (++T.seq),
      seq: T.seq,
      teachingClassID: info.teachingClassID,
      courseName: info.courseName || '',
      teacherName: info.teacherName || '',
      category: info.category || '',
      priority: 0,
      enabled: true,
      status: T.STATUS.PENDING,
      retryMode: s.retryMode || T.MODE.SMART,
      attempts: 0,
      lastMsg: '',
      lastKind: '',
      addedAt: Date.now(),
    };
    T.items.push(task);
    T.save();
    NS.info('加入抢课任务 ' + task.teachingClassID, task.courseName);
    return task;
  };

  T.remove = function (id) {
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].id === id) {
        T.items.splice(i, 1);
        T.save();
        return true;
      }
    }
    return false;
  };

  T.toggle = function (id) {
    var t = T.byId(id);
    if (!t) return false;
    t.enabled = !t.enabled;
    if (t.enabled && t.status === T.STATUS.FAILED) t.status = T.STATUS.PENDING;
    T.save();
    return t.enabled;
  };

  T.byId = function (id) {
    for (var i = 0; i < T.items.length; i++) if (T.items[i].id === id) return T.items[i];
    return null;
  };

  T.setPriority = function (id, p) {
    var t = T.byId(id);
    if (!t) return false;
    t.priority = NS.util.clamp(p, -1, 1, 0);
    T.save();
    return true;
  };

  T.setRetryMode = function (id, mode) {
    var t = T.byId(id);
    if (!t) return false;
    if (!T.MODE_NAME[mode]) return false;
    t.retryMode = mode;
    T.save();
    return true;
  };

  T.clear = function () {
    T.items = [];
    T.save();
  };

  T.reset = function () {
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].status !== T.STATUS.SUCCESS) T.items[i].status = T.STATUS.PENDING;
      T.items[i].attempts = 0;
      T.items[i].lastMsg = '';
    }
    T.save();
  };

  /** 构造该任务的抢课请求体。 */
  T.buildBody = function (task) {
    var ctx = NS.list.sessionContext();
    return NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: task.teachingClassID,
      campus: ctx.campus,
      teachingClassType: task.category,
    });
  };

  /**
   * 对单个任务尝试一次。
   * @returns {Promise<{done:boolean}>} done=true 表示该任务已终结（成功或按策略停止）
   */
  T.attempt = function (task) {
    // 前置校验：缺关键字段就不要发请求了
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode || !ctx.studentCode) {
      task.status = T.STATUS.FAILED;
      task.lastMsg = '缺少学号或选课批次码，请在设置中补全';
      NS.error('任务中止：缺少学号或 batchCode', task.teachingClassID);
      return Promise.resolve({ done: true });
    }
    if (!task.category) {
      task.status = T.STATUS.FAILED;
      task.lastMsg = '未能识别该教学班的类别代码，请重新在列表中点击「添加抢课」';
      NS.error('任务中止：类别未知', task.teachingClassID);
      return Promise.resolve({ done: true });
    }

    task.attempts += 1;
    task.status = T.STATUS.RUNNING;

    return NS.api
      .send({
        action: '抢课 ' + task.teachingClassID,
        url: NS.api.url(NS.api.EP.VOLUNTEER),
        method: 'POST',
        body: T.buildBody(task),
        priority: NS.Queue.PRIORITY.HIGH,
      })
      .then(function (r) {
        var kind = r.cls.kind;
        task.lastMsg = r.cls.msg || '';

        if (kind === NS.api.RESP_KIND.OK) {
          task.status = T.STATUS.SUCCESS;
          T.save();
          NS.info('抢课成功 ' + task.teachingClassID, task.courseName);
          return { done: true };
        }
        if (kind === NS.api.RESP_KIND.UNAUTHENTICATED) {
          task.status = T.STATUS.FAILED;
          task.lastMsg = '登录态失效，请刷新页面重新登录';
          T.stopped = true;
          T.save();
          NS.error('登录态失效，已停止全部任务');
          return { done: true };
        }

        var cls = kind === NS.api.RESP_KIND.BUSINESS ? T.classifyMsg(task.lastMsg) : 'unknown';
        task.lastKind = cls;
        if (T.shouldRetry(task.retryMode, cls)) {
          task.status = T.STATUS.PENDING;
          T.save();
          NS.warn('抢课未成功，将继续重试 [' + cls + '] ' + task.lastMsg);
          return { done: false };
        }
        task.status = T.STATUS.FAILED;
        T.save();
        NS.warn('任务停止：' + task.lastMsg);
        return { done: true };
      })
      .catch(function (e) {
        // 网络/队列异常：按策略处理
        task.lastMsg = '请求异常：' + (e && e.message ? e.message : e);
        task.lastKind = 'unknown';
        if (T.shouldRetry(task.retryMode, 'unknown')) {
          task.status = T.STATUS.PENDING;
        } else {
          task.status = T.STATUS.FAILED;
        }
        T.save();
        return { done: task.status === T.STATUS.FAILED };
      });
  };

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /** 一轮：每个活跃任务各尝试一次（串行，避免同时打服务器）。 */
  T.round = function () {
    var list = T.active();
    var i = 0;
    function next() {
      if (T.stopped || i >= list.length) return Promise.resolve();
      var task = list[i++];
      if (!task.enabled) return next();
      return T.attempt(task).then(function () { return next(); });
    }
    return Promise.resolve().then(next);
  };

  T._loop = function () {
    if (T.stopped || !T.running) { T.running = false; return Promise.resolve(); }
    if (!T.active().length) {
      T.running = false;
      NS.info('全部任务已结束');
      return Promise.resolve();
    }
    return T
      .round()
      .then(function () {
        if (T.stopped || !T.running) { T.running = false; return null; }
        if (!T.active().length) { T.running = false; NS.info('全部任务已结束'); return null; }
        return sleep(T.retryIntervalMs()).then(T._loop);
      });
  };

  /**
   * 开始执行。写接口未开启时直接拒绝（红线①）。
   * @returns {Promise<{ok:boolean, reason:string}>}
   */
  T.start = function () {
    if (!NS.isWriteAllowed(NS.settings())) {
      return Promise.resolve({ ok: false, reason: 'write-disabled' });
    }
    if (T.running) return Promise.resolve({ ok: false, reason: 'already-running' });
    if (!T.active().length) return Promise.resolve({ ok: false, reason: 'no-task' });
    T.running = true;
    T.stopped = false;
    NS.info('开始抢课，任务数 ' + T.active().length);
    T._loop();
    return Promise.resolve({ ok: true, reason: '' });
  };

  T.stop = function () {
    if (!T.running && !T.stopped) return false;
    T.stopped = true;
    T.running = false;
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].status === T.STATUS.RUNNING) T.items[i].status = T.STATUS.PENDING;
    }
    NS.info('已停止抢课');
    return true;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/list.js ==================== */
/**
 * P0：优化课程列表显示。
 *
 * 站点有两种列表形态，分别处理：
 *   (1) 课程 → 教学班：教学班卡片 .cv-course-card 内，在
 *       .cv-caption-red（选课说明）与随后的 .cv-caption-text 之间插入模块。
 *   (2) 直接即教学班（公选/慕课）：在「操作」列右侧新增「抢课模块」列。
 *
 * 模块内容：第一行教学班ID（不换行、占满一行），第二行两个按钮。
 * 样式刻意从简，融入站点原有界面。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = (NS.list || {}));

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_CARD = 'data-szu-card';
  var DONE_ROW = 'data-szu-row';
  var DONE_HEAD = 'data-szu-head';

  /** 直接即教学班的列表容器 id。 */
  L.DIRECT_BODIES = ['publicBody', 'moocBody'];

  /**
   * 列表容器 id → 教学班类别代码。
   * 【来源】站点 grablessons.js 的 reloadCourseList() 映射（tcType -> 模块），
   * 再对应到各列表容器的 id。抢课报文的 teachingClassType 必须用**该教学班所属列表**
   * 的类别，不能用全局设置。
   */
  L.BODY_CATEGORY = {
    programBody: 'FANKC',
    unProgramBody: 'FAWKC',
    recommendBody: 'TJKC',
    publicBody: 'XGXK',
    retakeBody: 'CXKC',
    sportBody: 'TYKC',
    minorBody: 'FXKC',
    moocBody: 'MOOC',
    schoolBody: 'XGXK', // 全校课程无独立类别码，暂按校公选（未实测）
  };

  /** 由节点向上找出所属列表容器，返回类别代码。 */
  L.categoryOfNode = function (node) {
    var n = node;
    while (n) {
      var id = n.getAttribute && n.getAttribute('id');
      if (id && L.BODY_CATEGORY[id]) return L.BODY_CATEGORY[id];
      n = n.parentNode;
    }
    return '';
  };

  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      // 行距压缩（用户指定 0.9）
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      '.cv-list>.cv-body>.cv-row>div{word-break:break-all;overflow-wrap:anywhere;}',

      // ---- 公选/慕课：表头与行改用 flex，新增列吃掉剩余横向空间 ----
      // 站点是 float + 固定像素宽度，各列合计已占满大部分宽度；
      // 直接追加一个定宽 float 列会因放不下而换行。改 flex 后：
      //   站点各列 flex:0 1 auto → 保持原有像素宽度（外观不变）
      //   新增列   flex:1 1 auto → 吃掉剩余空间，永不换行
      '.szu-flex-head{display:flex;flex-wrap:nowrap;align-items:flex-start;}',
      '#publicBody>.cv-row,#moocBody>.cv-row{display:flex;flex-wrap:nowrap;align-items:flex-start;}',
      '.szu-flex-head>div,#publicBody>.cv-row>div,#moocBody>.cv-row>div{float:none;flex:0 1 auto;min-width:0;}',
      '.szu-flex-head>.szu-head-col,#publicBody>.cv-row>.szu-direct-col,#moocBody>.cv-row>.szu-direct-col{',
      'flex:1 1 auto;min-width:0;overflow:hidden;box-sizing:border-box;}',

      // ---- 「抢课模块」：纵向两行 ----
      '.szu-block{padding:2px 0;}',
      '.szu-id{display:block;width:100%;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;color:#047ADC;font-size:12px;line-height:1.4;}',
      '.szu-ops{display:block;margin-top:4px;white-space:nowrap;}',
      '.szu-ops .szu-btn{margin-right:4px;}',
      '.szu-btn{display:inline-block;border:1px solid #047ADC;background:#fff;color:#047ADC;',
      'font-size:12px;line-height:1.5;padding:0 6px;border-radius:8px;cursor:pointer;}',
      // 悬停用浅色，**刻意区别于选中态** —— 否则鼠标还停在按钮上时看不出状态已切换
      '.szu-btn:hover{background:#e8f2fd;}',
      '.szu-btn.szu-on{background:#047ADC;color:#fff;border-color:#047ADC;}',

      // ---- 新增列 ----
      '.szu-head-col{text-align:center;}',
      '.szu-direct-col{padding:4px 6px;text-align:left;}',
      // 新列字号略小，确保 21 位教学班ID 能在一行内放下
      '.szu-direct-col .szu-id{font-size:11px;}',
      '.szu-direct-col .szu-btn{font-size:11px;padding:0 5px;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(style);
  };

  function toast(msg) {
    var el = root.document.getElementById('szu-bkxk-toast');
    if (!el) {
      el = root.document.createElement('div');
      el.id = 'szu-bkxk-toast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:999999;' +
        'background:rgba(0,0,0,.82);color:#fff;padding:8px 16px;border-radius:4px;' +
        'font-size:13px;line-height:1.4;max-width:70vw;';
      root.document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.display = 'none'; }, 3200);
  }
  L.toast = toast;

  /**
   * 会话上下文 —— 取值方式与站点 buildAddVolunteerParam() 保持一致：
   *   studentCode / electiveBatchCode 来自 sessionStorage.studentInfo（含 electiveBatch）
   *   campus 来自 sessionStorage.currentCampus
   * 旧版只有 currentBatch，站点抢课实际用的是 studentInfo.electiveBatch。
   */
  L.sessionContext = function () {
    var out = { studentCode: '', batchCode: '', campus: '' };
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('studentInfo');
      if (raw) {
        var info = JSON.parse(raw);
        if (info) {
          if (info.code) out.studentCode = String(info.code);
          if (info.electiveBatch && info.electiveBatch.code) out.batchCode = String(info.electiveBatch.code);
        }
      }
    } catch (e) { /* 忽略 */ }
    try {
      var camp = root.sessionStorage && root.sessionStorage.getItem('currentCampus');
      if (camp) {
        var c = JSON.parse(camp);
        if (c && c.code) out.campus = String(c.code);
      }
    } catch (e) { /* 忽略 */ }
    // 兜底：currentBatch（capacity.do 那条路径用的是它）
    if (!out.batchCode) {
      try {
        var cb = root.sessionStorage && root.sessionStorage.getItem('currentBatch');
        if (cb) {
          var b = JSON.parse(cb);
          if (b && b.code) out.batchCode = String(b.code);
        }
      } catch (e) { /* 忽略 */ }
    }
    // 最后兜底：设置里手填的
    if (!out.batchCode) out.batchCode = NS.settings().batchCode || '';
    if (!out.campus) out.campus = '01';
    return out;
  };

  /** 当前登录学号（兼容旧调用）。 */
  L.studentCode = function () {
    return L.sessionContext().studentCode;
  };

  /** 当前批次码（兼容旧调用）。 */
  L.currentBatch = function () {
    var ctx = L.sessionContext();
    return ctx.batchCode ? { code: ctx.batchCode } : null;
  };

  /**
   * 「添加抢课」：**只入队，不立即执行**（用户指定）。
   * 报文始终打印（便于核对）；是否真发由写接口开关决定（红线①）。
   */
  L.addGrab = function (info) {
    var s = NS.settings();
    var ctx = L.sessionContext();
    var body = NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: info.teachingClassID,
      campus: ctx.campus,
      // 用该教学班所属列表的类别，而不是全局设置
      teachingClassType: info.category || '',
    });
    var url = NS.api.appendTimestamp(NS.api.url(NS.api.EP.VOLUNTEER));
    console.log('%c[抢课·报文预览]', 'color:#4a90d9;font-weight:bold', {
      url: url, body: body, 课程: info.courseName, 教学班ID: info.teachingClassID,
      类别: info.category || '(未知)',
    });

    if (!info.category) {
      NS.warn('该教学班的类别代码未识别，任务可能无法执行', { 教学班ID: info.teachingClassID });
    }

    var task = NS.tasks.add({
      teachingClassID: info.teachingClassID,
      courseName: info.courseName,
      teacherName: info.teacherName,
      category: info.category || '',
    });
    if (!task) {
      toast('该教学班已在任务列表中');
      return false;
    }
    if (!NS.isWriteAllowed(s)) {
      toast('已加入任务列表（写接口未开启，暂时不会发请求）');
      NS.warn('写接口未开启，任务已入队但不执行');
    } else {
      toast('已加入任务列表：' + (info.courseName || info.teachingClassID));
    }
    if (NS.ui) NS.ui.render();
    return true;
  };

  /**
   * 「添加监控」：只读操作，不需要写接口开关。
   * 可反悔：已在监控列表中时再点即移除（按钮颜色随之变回）。
   * @returns {boolean} true=已加入，false=已移除/失败
   */
  L.addMonitor = function (info) {
    if (NS.monitor.has(info.teachingClassID)) {
      NS.monitor.remove(info.teachingClassID);
      toast('已取消监控：' + (info.courseName || info.teachingClassID));
      if (NS.ui) NS.ui.render();
      return false;
    }
    var s = NS.settings();
    NS.monitor.add({
      teachingClassID: info.teachingClassID,
      courseName: info.courseName,
      teacherName: info.teacherName,
      teachingPlace: info.teachingPlace,
      category: info.category || '',
      mode: s.monitorMode,
    });
    toast('已加入监控：' + (info.courseName || info.teachingClassID));
    if (NS.ui) NS.ui.render();
    return true;
  };

  /** 让监控按钮的文字与配色反映当前状态。 */
  function syncMonBtn(btn, tcId) {
    var on = NS.monitor.has(tcId);
    btn.textContent = on ? '移除监控' : '添加监控';
    if (on) btn.classList.add('szu-on');
    else btn.classList.remove('szu-on');
  }
  L.syncMonBtn = syncMonBtn;

  /**
   * 「抢课模块」：纵向两行。
   * 第一行：教学班ID（不换行、占满一行）
   * 第二行：两个按钮
   */
  L.buildBlock = function (info) {
    var block = root.document.createElement('div');
    block.className = 'szu-block';

    var idLine = root.document.createElement('div');
    idLine.className = 'szu-id';
    idLine.setAttribute('title', info.teachingClassID);
    idLine.textContent = info.teachingClassID;

    var ops = root.document.createElement('div');
    ops.className = 'szu-ops';

    var grabBtn = root.document.createElement('button');
    grabBtn.className = 'szu-btn';
    grabBtn.textContent = '添加抢课';
    grabBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      L.addGrab(info);
    });

    var monBtn = root.document.createElement('button');
    monBtn.className = 'szu-btn';
    // 按钮文字直接反映状态，避免「蓝了不知道再点会取消」的困惑
    syncMonBtn(monBtn, info.teachingClassID);
    monBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      L.addMonitor(info); // 已在列表中则移除
      syncMonBtn(monBtn, info.teachingClassID);
    });

    ops.appendChild(grabBtn);
    ops.appendChild(monBtn);
    block.appendChild(idLine);
    block.appendChild(ops);
    return block;
  };

  /* ---------------- 形态一：注入到教学班卡片内部 ---------------- */

  function tcIdOfCard(card) {
    var img = card.querySelector('img.collection-img');
    var id = img && img.getAttribute('tcId');
    if (id) return id;
    id = card.getAttribute('tcId');
    if (id) return id;
    var cid = card.getAttribute('id') || '';
    if (/_courseDiv$/.test(cid)) return cid.replace(/_courseDiv$/, '');
    return '';
  }

  /**
   * 在卡片内定位插入点：.cv-caption-red 之后、紧随的 .cv-caption-text 之前。
   * 找不到 cv-caption-red 时，退化为「选课说明」那个 div（同样用 cv-caption-text 定位）。
   */
  function insertPointInCard(card) {
    var info = card.querySelector('.cv-info');
    if (!info) return null;
    var kids = [];
    for (var i = 0; i < info.childNodes.length; i++) {
      if (info.childNodes[i].nodeType === 1) kids.push(info.childNodes[i]);
    }
    // 找 cv-caption-red（选课说明有内容时）
    for (var j = 0; j < kids.length; j++) {
      var cls = kids[j].getAttribute('class') || '';
      if (cls.indexOf('cv-caption-red') !== -1) {
        return { parent: info, before: kids[j + 1] || null };
      }
    }
    // 退化：找含「选课说明」文字的 div
    for (var k = 0; k < kids.length; k++) {
      var t = NS.util.text(kids[k]);
      if (t.indexOf('选课说明') === 0) {
        return { parent: info, before: kids[k + 1] || null };
      }
    }
    return { parent: info, before: null };
  }

  L.enhanceCard = function (card) {
    if (card.getAttribute(DONE_CARD) === '1') return false;
    var tcId = tcIdOfCard(card);
    if (!tcId) return false;
    var point = insertPointInCard(card);
    if (!point) return false;
    card.setAttribute(DONE_CARD, '1');

    var titleEl = card.querySelector('.cv-info-title');
    var block = L.buildBlock({
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(titleEl),
      category: L.categoryOfNode(card),
    });
    if (point.before && point.before.parentNode === point.parent) {
      point.parent.insertBefore(block, point.before);
    } else {
      point.parent.appendChild(block);
    }
    return true;
  };

  /* ---------------- 形态二：新增「抢课模块」列 ---------------- */

  /**
   * 表头新增一列。
   * class 用 cv-normal 抑制站点的排序箭头；加 szu-flex-head 让表头改用 flex，
   * 与行保持同列宽（站点表头是兄弟节点、无 id，故用标记类定位）。
   */
  L.ensureHeadColumn = function (bodyId) {
    var body = root.document.getElementById(bodyId);
    if (!body) return false;
    var list = body.closest ? body.closest('.cv-list') : null;
    if (!list) return false;
    var head = list.querySelector('.cv-head');
    if (!head) return false;
    // 表头可能被站点重建，故类名与列都要按需补齐（幂等）
    var cls = head.getAttribute('class') || '';
    if (cls.indexOf('szu-flex-head') === -1) {
      head.setAttribute('class', (cls + ' szu-flex-head').trim());
    }
    if (head.getAttribute(DONE_HEAD) === '1') return false;
    head.setAttribute(DONE_HEAD, '1');
    var col = root.document.createElement('div');
    col.className = 'cv-normal szu-head-col';
    col.textContent = '抢课模块';
    head.appendChild(col);
    return true;
  };

  /** 行内新增单元格：插在「操作」列之后。 */
  L.enhanceDirectRow = function (row) {
    if (row.getAttribute(DONE_ROW) === '1') return false;
    var choice = row.querySelector('a.cv-choice');
    if (!choice && row.querySelector) choice = row.querySelector('[tcId]');
    if (!choice) return false;
    var tcId = choice.getAttribute('tcId');
    if (!tcId) return false;
    var setting = row.querySelector('.cv-setting-col');
    if (!setting) return false;
    row.setAttribute(DONE_ROW, '1');

    var titleEl = row.querySelector('.cv-title-col');
    var teacherEl = row.querySelector('.cv-teacher-col');
    var cell = root.document.createElement('div');
    cell.className = 'szu-direct-col';
    cell.appendChild(L.buildBlock({
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(teacherEl),
      category: L.categoryOfNode(row),
    }));
    if (setting.parentNode) setting.parentNode.insertBefore(cell, setting.nextSibling);
    return true;
  };

  /* ---------------- 扫描 ---------------- */

  L.scan = function () {
    var n = 0;

    var cards = root.document.querySelectorAll ? root.document.querySelectorAll('.cv-course-card') : [];
    var cardList = [];
    for (var c = 0; c < cards.length; c++) cardList.push(cards[c]);
    for (var d = 0; d < cardList.length; d++) {
      if (L.enhanceCard(cardList[d])) n++;
    }

    for (var b = 0; b < L.DIRECT_BODIES.length; b++) {
      var body = root.document.getElementById(L.DIRECT_BODIES[b]);
      if (!body) continue;
      L.ensureHeadColumn(L.DIRECT_BODIES[b]);
      var rows = body.querySelectorAll ? body.querySelectorAll('.cv-row') : [];
      var list = [];
      for (var i = 0; i < rows.length; i++) list.push(rows[i]);
      for (var j = 0; j < list.length; j++) {
        if (L.enhanceDirectRow(list[j])) n++;
      }
    }
    return n;
  };

  L.observe = function () {
    if (!root.MutationObserver) return;
    var pending = false;
    var mo = new root.MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        var n = L.scan();
        if (n) NS.info('P0 增强了 ' + n + ' 处');
      }, 120);
    });
    mo.observe(root.document.body, { childList: true, subtree: true });
  };

  L.start = function () {
    L.injectStyle();
    var n = L.scan();
    L.observe();
    NS.info('P0 课程列表优化已启动，首轮增强 ' + n + ' 处');
    return n;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/timetable.js ==================== */
/**
 * M4：课表页（*default/curriculum.do）注入。
 *
 * DOM 契约（取自 docs/curriculum.do.html）：
 *   #myCourseTable
 *     .cv-my-course
 *       .cv-col.cv-left                      ← 左侧「节次」列
 *         .cv-day  > div[start][end]         ← 上午/下午/晚上 分段
 *         .cv-lesson > div[style=height]     ← 14 个节次刻度
 *       .cv-col.cv-right                     ← 每天一列（周一…周七）
 *         .cv-head                           ← 「周一」
 *         .cv-lesson[start][end][style=top]  ← 一节课的容器
 *           .cv-course-card-single > div > div{课程名, 时间, 地点, 教师}
 *
 * 【注入方式】把自定义课程按「星期 + 起止节次」算出 top/height，
 * 追加成 .cv-lesson，内部放与站点同构的 .cv-course-card-single，
 * 并加一个自定义标记类以示区分。
 *
 * 【几何】左侧 .cv-lesson 里每个节次刻度是固定 54px（实测 14 节 × 54 = 756），
 * 但站点实际用 784px 容器。为稳妥，运行时从真实刻度测量单节高度，
 * 测不到才退回 54px。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var TT = (NS.timetable = NS.timetable || {});

  var STYLE_ID = 'szu-tt-style';
  var DONE_ATTR = 'data-szu-tt';
  var DEFAULT_SLOT_H = 54;
  var DEFAULT_TOP = 28; // .cv-head 高度（实测 top:28px 对应第 1 节）

  TT.injectStyle = function () {
    if (root.document.getElementById(STYLE_ID)) return;
    var s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.szu-tt-card{opacity:.92;}',
      '.szu-tt-card .szu-tt-tag{display:inline-block;font-size:11px;line-height:1.3;',
      'padding:0 3px;border-radius:2px;background:#047ADC;color:#fff;margin-left:3px;}',
      '.szu-tt-card.szu-tt-conflict{outline:2px solid #c0392b;outline-offset:-2px;}',
      '.szu-tt-card .szu-tt-conflict-tip{color:#c0392b;font-size:11px;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(s);
  };

  /** 找到课表容器；找不到返回 null（非课表页或结构变了）。 */
  TT.findTable = function () {
    var doc = root.document;
    var table = doc.getElementById('myCourseTable');
    if (table) return table;
    return doc.querySelector ? doc.querySelector('.cv-my-course') : null;
  };

  /**
   * 测量单节高度与起始偏移。
   * 从左侧 .cv-lesson 的真实刻度读，读不到再用默认值。
   */
  TT.measure = function (table) {
    var lesson = table.querySelector ? table.querySelector('.cv-left .cv-lesson') : null;
    var slotH = DEFAULT_SLOT_H;
    var top0 = DEFAULT_TOP;
    if (lesson && lesson.childNodes) {
      var first = null;
      for (var i = 0; i < lesson.childNodes.length; i++) {
        var n = lesson.childNodes[i];
        if (n.nodeType === 1) { first = n; break; }
      }
      if (first) {
        var h = parseInt(first.style && first.style.height, 10);
        if (isFinite(h) && h > 0) slotH = h;
      }
    }
    // 站点的第一节课 top=28（即表头高度），实测如此
    return { slotH: slotH, top0: top0 };
  };

  /** 找某一天的列容器。day: 1=周一 … 7=周日。 */
  TT.findDayColumn = function (table, day) {
    var cols = table.querySelectorAll ? table.querySelectorAll('.cv-col.cv-right') : [];
    // 站点顺序即 周一…周七；用 .cv-head 文本兜底核对
    var names = ['周一', '周二', '周三', '周四', '周五', '周六', '周七'];
    var want = names[day - 1];
    for (var i = 0; i < cols.length; i++) {
      var head = cols[i].querySelector ? cols[i].querySelector('.cv-head') : null;
      if (head && NS.util.text(head).indexOf(want) !== -1) return cols[i];
    }
    return cols[day - 1] || null;
  };

  /** 生成一个自定义课程卡片（结构对齐站点）。 */
  TT.buildCard = function (seg, course, conflict) {
    var card = root.document.createElement('div');
    card.className = 'cv-course-card-single szu-tt-card' + (conflict ? ' szu-tt-conflict' : '');
    var inner = root.document.createElement('div');
    var l1 = root.document.createElement('div');
    l1.appendChild(root.document.createTextNode(course.name));
    var tag = root.document.createElement('span');
    tag.className = 'szu-tt-tag';
    tag.textContent = '自定义';
    l1.appendChild(tag);
    inner.appendChild(l1);

    var l2 = root.document.createElement('div');
    l2.textContent = seg.weekFrom + '-' + seg.weekTo + '周' + seg.sectionFrom + '-' + seg.sectionTo + '节';
    inner.appendChild(l2);

    if (seg.place) {
      var l3 = root.document.createElement('div');
      l3.textContent = seg.place;
      inner.appendChild(l3);
    }
    if (course.teacher) {
      var l4 = root.document.createElement('div');
      l4.textContent = course.teacher;
      inner.appendChild(l4);
    }
    if (conflict) {
      var tip = root.document.createElement('div');
      tip.className = 'szu-tt-conflict-tip';
      tip.textContent = '与已选课程冲突';
      inner.appendChild(tip);
    }
    if (course.color) card.style.background = course.color;
    card.appendChild(inner);
    return card;
  };

  /**
   * 把一门自定义课程的某一段注入到课表。
   * @returns {boolean} 是否注入成功
   */
  TT.injectSegment = function (table, course, seg, conflict) {
    if (!seg || seg.day === null) return false;
    var col = TT.findDayColumn(table, seg.day);
    if (!col) return false;

    var geo = TT.measure(table);
    var top = geo.top0 + (seg.sectionFrom - 1) * geo.slotH;
    var height = (seg.sectionTo - seg.sectionFrom + 1) * geo.slotH + 1;

    var wrap = root.document.createElement('div');
    wrap.className = 'cv-lesson cv-top-line szu-tt-lesson';
    wrap.setAttribute('start', String(seg.sectionFrom));
    wrap.setAttribute('end', String(seg.sectionTo));
    wrap.style.height = height + 'px';
    wrap.style.top = top + 'px';
    wrap.setAttribute(DONE_ATTR, '1');

    var holder = root.document.createElement('div');
    holder.appendChild(TT.buildCard(seg, course, conflict));
    wrap.appendChild(holder);
    col.appendChild(wrap);
    return true;
  };

  /** 已选课程的时间（用于冲突提示，从现有课表卡片读）。 */
  TT.readExisting = function (table) {
    var out = [];
    var cards = table.querySelectorAll ? table.querySelectorAll('.cv-course-card-single') : [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if ((card.getAttribute('class') || '').indexOf('szu-tt-card') !== -1) continue;
      var divs = card.querySelectorAll ? card.querySelectorAll('div div') : [];
      var name = '';
      var time = '';
      for (var j = 0; j < divs.length; j++) {
        var t = NS.util.text(divs[j]);
        if (!name && t) name = t;
        if (!time && /\d+-\d+周/.test(t)) time = t;
      }
      if (time) out.push({ courseName: name, teachingPlace: time });
    }
    return out;
  };

  /** 清掉上一次注入的自定义块（避免重复刷新时堆叠）。 */
  TT.clearInjected = function (table) {
    var olds = table.querySelectorAll ? table.querySelectorAll('.szu-tt-lesson') : [];
    for (var i = olds.length - 1; i >= 0; i--) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
    return olds.length;
  };

  /** 渲染全部自定义课程。 */
  TT.render = function () {
    var table = TT.findTable();
    if (!table) return 0;
    TT.clearInjected(table);

    var existing = TT.readExisting(table);
    var n = 0;
    for (var i = 0; i < NS.custom.items.length; i++) {
      var c = NS.custom.items[i];
      if (!c.enabled) continue;
      // 与站点已选课程比对，冲突则高亮
      var conflict = false;
      for (var k = 0; k < existing.length; k++) {
        if (NS.time.conflicts(c.place, existing[k].teachingPlace)) { conflict = true; break; }
      }
      for (var j = 0; j < c.segs.length; j++) {
        if (TT.injectSegment(table, c, c.segs[j], conflict)) n++;
      }
    }
    NS.info('课表注入自定义课程段 ' + n + ' 个（已选课程 ' + existing.length + ' 门）');
    return n;
  };

  /** 入口：等课表渲染出来再注入（站点是异步渲染）。 */
  TT.start = function () {
    TT.injectStyle();
    var tries = 0;
    function attempt() {
      var table = TT.findTable();
      if (!table) {
        if (++tries < 20) setTimeout(attempt, 500);
        else NS.warn('未找到课表容器 #myCourseTable，放弃注入');
        return;
      }
      TT.render();
      // 站点重渲染时跟着重注入
      if (root.MutationObserver) {
        var pending = false;
        var mo = new root.MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () {
            pending = false;
            if (!TT.findTable()) return;
            if (!root.document.querySelector('.szu-tt-lesson') && NS.custom.items.length) TT.render();
          }, 300);
        });
        mo.observe(table, { childList: true, subtree: true });
      }
    }
    attempt();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/hijack.js ==================== */
/**
 * 接管站点自己发出的接口响应（不接管脚本请求）。
 *
 * 【为什么能区分】
 *   站点所有请求走 BH_UTILS.doAjax → jQuery $.ajax → **XMLHttpRequest**；
 *   本脚本走 **fetch**。所以挂 XHR 天然只接管站点请求。
 *   fetch 也挂了（防御性），但用 init.__szuSkip 显式标记脚本请求跳过。
 *
 * 【两类接管，各有独立开关】
 *   hijackTimetable    teachingTime.do  → 把自定义课程追加进课表结果
 *   hijackListConflict 各列表端点       → 重算 isConflict / conflictDesc，
 *                                          只把**自定义课程**计入（站点不知道它们）
 *
 * 关闭后完全不接管 —— 避免自定义课程把课全标成冲突导致选不了课。
 *
 * 【安全】只读改写响应，不改请求、不加请求头、不重放；凭证不落任何地方。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var H = (NS.hijack = NS.hijack || {});

  /** 列表端点（学位列表类）。 */
  var LIST_RE = /elective\/(?:programCourse|unProgramCourse|publicCourse|recommendedCourse|queryCourse|course|minorCourse|retakeCourse|sportCourse)\.do/i;
  var TIMETABLE_RE = /elective\/teachingTime\.do/i;

  var CN_DAY = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  /** 判断某个 URL 属于哪类接管对象；不需接管返回 null。 */
  H.kindOf = function (url) {
    var u = String(url || '');
    if (TIMETABLE_RE.test(u)) return 'timetable';
    if (LIST_RE.test(u)) return 'list';
    return null;
  };

  /** 两类接管是否启用（读设置，默认开）。 */
  H.enabled = function (kind) {
    var s = NS.settings();
    if (kind === 'timetable') return s.hijackTimetable !== false;
    if (kind === 'list') return s.hijackListConflict !== false;
    return false;
  };

  /* ---------------- 纯函数：便于单测 ---------------- */

  /**
   * 生成周次位图（站点用 "000011111111111111" 这种形式，下标 0 = 第 1 周）。
   * @param {number} from 起始周
   * @param {number} to   结束周
   * @param {string|null} parity '单' | '双' | null
   * @param {number} len  位图长度（周数）
   */
  H.buildWeekBitmap = function (from, to, parity, len) {
    var n = len > 0 ? len : 18;
    var out = '';
    for (var w = 1; w <= n; w++) {
      var ok = w >= from && w <= to;
      if (ok && parity) {
        var odd = w % 2 === 1;
        ok = parity === '单' ? odd : !odd;
      }
      out += ok ? '1' : '0';
    }
    return out;
  };

  /** 站点风格的周次文字，如 `5-18周` / `7-11周(单)` / `3周`。 */
  H.weekText = function (seg) {
    var base = seg.weekFrom === seg.weekTo ? (seg.weekFrom + '周') : (seg.weekFrom + '-' + seg.weekTo + '周');
    return seg.parity ? (base + '(' + seg.parity + ')') : base;
  };

  /** 自定义课程里与某个 teachingPlace 冲突的项。 */
  H.customConflicts = function (place, items) {
    var out = [];
    if (!place) return out;
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.enabled === false) continue;
      if (NS.time.conflicts(place, c.place)) out.push(c);
    }
    return out;
  };

  /** 由自定义课程生成的冲突说明（前缀标明来源，便于卡片上分辨）。 */
  H.conflictDescFor = function (customCourses) {
    return customCourses.map(function (c) {
      return '自定义课程：' + c.name + '(' + c.place + ')';
    }).join('；');
  };

  /**
   * 把自定义课程的时段追加进 teachingTime.do 的返回。
   * @returns {{json:object, added:number}}
   */
  H.augmentTimetable = function (json, items) {
    if (!json || !Array.isArray(json.dataList)) return { json: json, added: 0 };
    var list = items || [];

    // 位图长度取站点已有条目的最大值，保证与站点一致
    var len = 18;
    for (var i = 0; i < json.dataList.length; i++) {
      var w = String(json.dataList[i].week || '').length;
      if (w > len) len = w;
    }

    var added = 0;
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if (!c || c.enabled === false) continue;
      for (var k = 0; k < c.segs.length; k++) {
        var seg = c.segs[k];
        if (seg.day === null) continue;
        json.dataList.push({
          dayOfWeekName: CN_DAY[seg.day] || '',
          teachingClassID: 'szu-custom-' + c.id + '-' + k,
          courseNumber: '',
          studentCode: '',
          courseName: c.name,
          courseIndex: '',
          teacherName: c.teacher || '',
          teachingPlace: seg.place || '',
          sportCode: null,
          timeType: '1',
          sportName: null,
          studyMode: '01',
          weekName: H.weekText(seg),
          beginSection: String(seg.sectionFrom),
          endSection: String(seg.sectionTo),
          week: H.buildWeekBitmap(seg.weekFrom, seg.weekTo, seg.parity, len),
          dayOfWeek: String(seg.day),
          wid: null,
          szuCustom: true,
        });
        added++;
      }
    }
    if (added) json.totalCount = (Number(json.totalCount) || 0) + added;
    return { json: json, added: added };
  };

  /**
   * 重算列表返回里的冲突标记。
   * 只**增加**冲突，绝不把站点已算出的冲突清掉。
   * @returns {{json:object, marked:number}}
   */
  H.augmentList = function (json, items) {
    if (!json || !Array.isArray(json.dataList)) return { json: json, marked: 0 };
    var marked = 0;
    for (var i = 0; i < json.dataList.length; i++) {
      var item = json.dataList[i];
      if (!item || typeof item !== 'object') continue;
      // 嵌套结构（tcList）与扁平结构（公选/慕课，一行即一个教学班）都要覆盖
      var targets = Array.isArray(item.tcList) ? item.tcList : [item];
      for (var j = 0; j < targets.length; j++) {
        var tc = targets[j];
        if (!tc || typeof tc !== 'object') continue;
        var cs = H.customConflicts(tc.teachingPlace, items);
        if (!cs.length) continue;
        tc.isConflict = '1';
        var mine = H.conflictDescFor(cs);
        tc.conflictDesc = tc.conflictDesc ? (tc.conflictDesc + '；' + mine) : mine;
        tc.szuCustomConflict = true; // 供本脚本界面分辨来源
        marked++;
      }
    }
    return { json: json, marked: marked };
  };

  /** 按类别变换一份响应文本；无需变化时返回 null。 */
  H.transform = function (kind, text) {
    if (!kind || !H.enabled(kind)) return null;
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!json || typeof json !== 'object') return null;
    if (String(json.code) !== '1') return null;

    var res = kind === 'timetable'
      ? H.augmentTimetable(json, NS.custom.items)
      : H.augmentList(json, NS.custom.items);
    var changed = kind === 'timetable' ? res.added : res.marked;
    if (!changed) return null;
    NS.info('[接管] ' + kind + ' 改写了 ' + changed + ' 处');
    return JSON.stringify(res.json);
  };

  /* ---------------- 安装钩子 ---------------- */

  /**
   * 改写 xhr 实例上的 responseText / response。
   * 我们的 readystatechange 监听在 jQuery 注册之前挂上，故在它读取之前完成改写。
   */
  function rewriteXhr(xhr) {
    var url = String(xhr.responseURL || '');
    var kind = H.kindOf(url);
    if (!kind) return;
    if (!H.enabled(kind)) return;
    if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json') return;
    var text;
    try {
      text = xhr.responseText;
    } catch (e) {
      return;
    }
    if (!text) return;

    var newText = H.transform(kind, text);
    if (!newText) return;
    try {
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get: function () { return newText; },
      });
      if (xhr.responseType === 'json') {
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () { return JSON.parse(newText); },
        });
      }
    } catch (e) {
      NS.warn('接管响应失败（无法改写 responseText）', e && e.message);
    }
  }

  /** 挂 XMLHttpRequest（站点请求的主通道）。 */
  H.installXhr = function () {
    if (H._xhrInstalled) return false;
    var Orig = root.XMLHttpRequest;
    if (!Orig) return false;
    function Wrapped() {
      var xhr = new Orig();
      try {
        xhr.addEventListener('readystatechange', function () {
          if (xhr.readyState === 4) rewriteXhr(xhr);
        });
      } catch (e) { /* 忽略 */ }
      return xhr;
    }
    Wrapped.prototype = Orig.prototype;
    try {
      root.XMLHttpRequest = Wrapped;
    } catch (e) {
      return false;
    }
    H._xhrInstalled = true;
    return true;
  };

  /** 防御性挂 fetch；脚本自己的请求带 init.__szuSkip，直接放行。 */
  H.installFetch = function () {
    if (H._fetchInstalled) return false;
    var orig = root.fetch;
    if (!orig || !root.Response) return false;
    root.fetch = function (input, init) {
      var p = orig.apply(this, arguments);
      try {
        if (init && init.__szuSkip) return p; // 脚本请求：不接管
        var url = typeof input === 'string' ? input : ((input && input.url) || '');
        var kind = H.kindOf(url);
        if (!kind) return p;
        return p.then(function (res) {
          return res.text().then(function (text) {
            var newText = H.transform(kind, text);
            var body = newText === null ? text : newText;
            return new root.Response(body, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          });
        });
      } catch (e) {
        return p;
      }
    };
    H._fetchInstalled = true;
    return true;
  };

  H.install = function () {
    var a = H.installXhr();
    var b = H.installFetch();
    if (a || b) NS.info('响应接管已安装（XHR=' + a + ' fetch=' + b + '）');
    return a || b;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/ui.js ==================== */
/**
 * 悬浮窗：任务 / 监控 / 设置 / 日志。
 *
 * 形态（用户指定）：可拖拽浮动面板，默认右下角，可折叠。
 * 位置与折叠状态记在设置里。
 *
 * 红线①：写接口默认关闭；开启需二次确认，开启后界面常驻红色警示。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var U = (NS.ui = NS.ui || {});

  var PANEL_ID = 'szu-panel';
  var STYLE_ID = 'szu-panel-style';
  var TAB = { TASK: 'task', MONITOR: 'monitor', CUSTOM: 'custom', SETTING: 'setting', LOG: 'log' };
  var currentTab = TAB.TASK;

  function el(tag, cls, text) {
    var e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function button(text, cls, onClick) {
    var b = el('button', 'szu-p-but ' + (cls || ''), text);
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(ev);
    });
    return b;
  }

  U.injectStyle = function () {
    if (root.document.getElementById(STYLE_ID)) return;
    var s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#szu-panel{position:fixed;z-index:2147483000;width:420px;background:#fff;',
      'border:1px solid #c9dbef;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.25);',
      'font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#333;}',
      '#szu-panel *{box-sizing:border-box;}',
      '#szu-panel .szu-p-head{display:flex;align-items:center;gap:6px;padding:6px 8px;',
      'background:#047ADC;color:#fff;border-radius:5px 5px 0 0;cursor:move;user-select:none;}',
      '#szu-panel .szu-p-head .szu-p-title{flex:1 1 auto;font-weight:bold;white-space:nowrap;}',
      '#szu-panel .szu-p-head button{background:transparent;border:1px solid rgba(255,255,255,.6);',
      'color:#fff;border-radius:3px;cursor:pointer;font-size:12px;padding:0 6px;line-height:18px;}',
      '#szu-panel .szu-p-tabs{display:flex;border-bottom:1px solid #e2ecf7;background:#f7fbff;}',
      '#szu-panel .szu-p-tab{flex:1 1 auto;text-align:center;padding:5px 0;cursor:pointer;',
      'font-size:12px;color:#5b7ea6;border-right:1px solid #e2ecf7;}',
      '#szu-panel .szu-p-tab:last-child{border-right:none;}',
      '#szu-panel .szu-p-tab.on{background:#fff;color:#047ADC;font-weight:bold;',
      'box-shadow:inset 0 -2px 0 #047ADC;}',
      '#szu-panel .szu-p-body{padding:8px;max-height:56vh;overflow:auto;}',
      '#szu-panel .szu-p-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;}',
      '.szu-p-but{border:1px solid #047ADC;background:#fff;color:#047ADC;border-radius:3px;',
      'cursor:pointer;font-size:12px;padding:2px 8px;line-height:18px;}',
      '.szu-p-but:hover{background:#047ADC;color:#fff;}',
      '.szu-p-but.danger{border-color:#c0392b;color:#c0392b;}',
      '.szu-p-but.danger:hover{background:#c0392b;color:#fff;}',
      '.szu-p-but:disabled{opacity:.45;cursor:not-allowed;}',
      '#szu-panel .szu-p-task{border:1px solid #e2ecf7;border-radius:4px;padding:5px 6px;margin-bottom:5px;}',
      '#szu-panel .szu-p-task.szu-st-success{border-color:#27ae60;background:#f2fbf5;}',
      '#szu-panel .szu-p-task.szu-st-failed{border-color:#c0392b;background:#fdf3f2;}',
      '#szu-panel .szu-p-task.szu-st-running{border-color:#f39c12;background:#fffaf0;}',
      '#szu-panel .szu-p-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '#szu-panel .szu-p-id{font-family:Consolas,Menlo,monospace;color:#3d6ea5;}',
      '#szu-panel .szu-p-name{font-weight:bold;}',
      '#szu-panel .szu-p-msg{color:#888;word-break:break-all;}',
      '#szu-panel .szu-p-msg.err{color:#c0392b;}',
      '#szu-panel .szu-p-msg.ok{color:#27ae60;}',
      '#szu-panel select,#szu-panel input[type=text],#szu-panel input[type=number]{',
      'font-size:12px;padding:1px 3px;border:1px solid #c9dbef;border-radius:3px;}',
      '#szu-panel label{display:flex;align-items:center;gap:4px;margin:4px 0;}',
      '#szu-panel .szu-p-warn{background:#fdf3f2;border:1px solid #f0c4bf;color:#c0392b;',
      'padding:4px 6px;border-radius:3px;margin-bottom:6px;}',
      '#szu-panel .szu-p-ok{background:#f2fbf5;border:1px solid #bfe6cd;color:#1e7a45;',
      'padding:4px 6px;border-radius:3px;margin-bottom:6px;}',
      '#szu-panel .szu-p-log{font-family:Consolas,Menlo,monospace;font-size:11px;',
      'white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow:auto;background:#fafcff;',
      'border:1px solid #e2ecf7;border-radius:3px;padding:4px;}',
      '#szu-panel .szu-p-empty{color:#999;text-align:center;padding:14px 0;}',
      '#szu-panel .szu-p-sec{font-weight:bold;color:#047ADC;margin:8px 0 4px;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(s);
  };

  /* ---------------- 面板骨架 ---------------- */

  var panel = null;
  var bodyEl = null;

  function position(panelEl) {
    var s = NS.settings();
    var pos = s.panelPos;
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      panelEl.style.left = pos.left + 'px';
      panelEl.style.top = pos.top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    } else {
      panelEl.style.right = '16px';
      panelEl.style.bottom = '16px';
    }
  }

  function makeDraggable(handle, panelEl) {
    var dragging = false;
    var ox = 0;
    var oy = 0;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      dragging = true;
      var r = panelEl.getBoundingClientRect();
      ox = ev.clientX - r.left;
      oy = ev.clientY - r.top;
      // 固定为 left/top 定位，之后按位移更新
      panelEl.style.left = r.left + 'px';
      panelEl.style.top = r.top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      ev.preventDefault();
    });
    root.document.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      var w = panelEl.offsetWidth || 420;
      var h = panelEl.offsetHeight || 300;
      var left = Math.max(0, Math.min(ev.clientX - ox, (root.innerWidth || 1200) - w));
      var top = Math.max(0, Math.min(ev.clientY - oy, (root.innerHeight || 800) - 24));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
    });
    root.document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      NS.saveSettings({
        panelPos: { left: parseInt(panelEl.style.left, 10) || 0, top: parseInt(panelEl.style.top, 10) || 0 },
      });
    });
  }

  U.build = function () {
    if (root.document.getElementById(PANEL_ID)) return root.document.getElementById(PANEL_ID);
    U.injectStyle();

    var p = el('div');
    p.id = PANEL_ID;

    var head = el('div', 'szu-p-head');
    var title = el('span', 'szu-p-title', '深大选课助手 v' + (NS.VERSION || ''));
    var btnCollapse = el('button', undefined, '—');
    var btnClose = el('button', undefined, '×');
    head.appendChild(title);
    head.appendChild(btnCollapse);
    head.appendChild(btnClose);

    var tabs = el('div', 'szu-p-tabs');
    var tabDefs = [
      [TAB.TASK, '任务'],
      [TAB.MONITOR, '监控'],
      [TAB.CUSTOM, '自定义'],
      [TAB.SETTING, '设置'],
      [TAB.LOG, '日志'],
    ];
    tabDefs.forEach(function (d) {
      var t = el('div', 'szu-p-tab', d[1]);
      t.setAttribute('data-tab', d[0]);
      t.addEventListener('click', function () {
        currentTab = d[0];
        U.render();
      });
      tabs.appendChild(t);
    });

    var body = el('div', 'szu-p-body');

    p.appendChild(head);
    p.appendChild(tabs);
    p.appendChild(body);

    btnCollapse.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var s = NS.settings();
      var next = !s.panelCollapsed;
      NS.saveSettings({ panelCollapsed: next });
      body.style.display = next ? 'none' : 'block';
      tabs.style.display = next ? 'none' : 'flex';
    });
    btnClose.addEventListener('click', function (ev) {
      ev.stopPropagation();
      p.style.display = 'none';
    });

    (root.document.body || root.document.documentElement).appendChild(p);
    position(p);
    makeDraggable(head, p);

    panel = p;
    bodyEl = body;
    return p;
  };

  /* ---------------- 渲染 ---------------- */

  function statusText(t) {
    if (t.status === NS.tasks.STATUS.SUCCESS) return '成功';
    if (t.status === NS.tasks.STATUS.FAILED) return '已停止';
    if (t.status === NS.tasks.STATUS.RUNNING) return '请求中';
    return t.enabled ? '等待' : '已禁用';
  }

  function renderTasks() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();

    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('开始抢课', '', function () {
      NS.tasks.start().then(function (r) {
        if (!r.ok) {
          var map = {
            'write-disabled': '写接口未开启：请到「设置」页开启后再开始。',
            'already-running': '已在运行中。',
            'no-task': '没有可执行的任务。',
          };
          NS.tasks.start && NS.ui.toast(map[r.reason] || '无法开始');
          U.render();
          return;
        }
        U.render();
      });
    }));
    bar.appendChild(button('停止', 'danger', function () {
      NS.tasks.stop();
      U.render();
    }));
    bar.appendChild(button('重置', '', function () {
      NS.tasks.reset();
      U.render();
    }));
    bar.appendChild(button('清空', 'danger', function () {
      if (root.confirm && !root.confirm('确定清空全部抢课任务？')) return;
      NS.tasks.stop();
      NS.tasks.clear();
      U.render();
    }));
    // 全局默认重试策略
    var modeSel = el('select');
    Object.keys(NS.tasks.MODE_NAME).forEach(function (m) {
      var o = el('option', undefined, '重试：' + NS.tasks.MODE_NAME[m]);
      o.value = m;
      if ((s.retryMode || 'smart') === m) o.setAttribute('selected', 'selected');
      modeSel.appendChild(o);
    });
    modeSel.value = s.retryMode || 'smart';
    modeSel.addEventListener('change', function () {
      NS.saveSettings({ retryMode: modeSel.value });
      for (var i = 0; i < NS.tasks.items.length; i++) NS.tasks.items[i].retryMode = modeSel.value;
    });
    bar.appendChild(modeSel);
    frag.appendChild(bar);

    if (NS.isWriteAllowed(s)) {
      frag.appendChild(el('div', 'szu-p-warn', '⚠ 写接口已开启：点「开始抢课」会真实提交选课请求。'));
    } else {
      frag.appendChild(el('div', 'szu-p-ok', '写接口关闭中：抢课只会打印报文，不会真正发送。'));
    }

    if (!NS.tasks.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无任务。到课程列表点「添加抢课」加入。'));
    }

    NS.tasks.items.forEach(function (t) {
      var cls = 'szu-p-task szu-st-' + (t.status === NS.tasks.STATUS.PENDING ? 'pending' : t.status);
      if (t.status === NS.tasks.STATUS.PENDING && !t.enabled) cls = 'szu-p-task';
      var box = el('div', cls);

      var l1 = el('div', 'szu-p-row');
      var cb = root.document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.enabled;
      cb.addEventListener('change', function () {
        NS.tasks.toggle(t.id);
        U.render();
      });
      l1.appendChild(cb);
      l1.appendChild(el('span', 'szu-p-name', t.courseName || '(未命名课程)'));
      l1.appendChild(el('span', 'szu-p-id', t.teachingClassID));
      l1.appendChild(el('span', undefined, NS.api.CATEGORY_NAME[t.category] || t.category || '类别未知'));
      l1.appendChild(el('span', undefined, statusText(t) + ' · ' + t.attempts + ' 次'));
      box.appendChild(l1);

      var l2 = el('div', 'szu-p-row');
      var pri = el('select');
      [['-1', '高'], ['0', '中'], ['1', '低']].forEach(function (p) {
        var o = el('option', undefined, '优先级' + p[1]);
        o.value = p[0];
        pri.appendChild(o);
      });
      pri.value = String(t.priority);
      pri.addEventListener('change', function () {
        NS.tasks.setPriority(t.id, Number(pri.value));
      });
      l2.appendChild(pri);

      var rm = el('select');
      Object.keys(NS.tasks.MODE_NAME).forEach(function (m) {
        var o = el('option', undefined, NS.tasks.MODE_NAME[m]);
        o.value = m;
        rm.appendChild(o);
      });
      rm.value = t.retryMode;
      rm.addEventListener('change', function () {
        NS.tasks.setRetryMode(t.id, rm.value);
      });
      l2.appendChild(rm);
      l2.appendChild(button('删除', 'danger', function () {
        NS.tasks.remove(t.id);
        U.render();
      }));
      box.appendChild(l2);

      if (t.lastMsg) {
        var mcls = 'szu-p-msg' + (t.status === NS.tasks.STATUS.SUCCESS ? ' ok' : (t.status === NS.tasks.STATUS.FAILED ? ' err' : ''));
        box.appendChild(el('div', mcls, t.lastMsg));
      }
      frag.appendChild(box);
    });

    return frag;
  }

  function renderMonitor() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();
    var isCat = (s.monitorMode !== 'single');

    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('开始监控', '', function () {
      if (!NS.monitor.items.length) { U.toast('监控列表为空，请先在课程列表点「添加监控」'); return; }
      NS.monitor.startPolling();
      U.render();
    }));
    bar.appendChild(button('停止监控', 'danger', function () {
      NS.monitor.stopPolling();
      U.render();
    }));
    bar.appendChild(button('检查一次', '', function () {
      if (!NS.monitor.items.length) { U.toast('监控列表为空'); return; }
      U.toast('检查中…');
      NS.monitor.pollOnce().then(function (r) {
        U.toast('检查完成，命中 ' + (r.hits ? r.hits.length : 0) + ' 个有余量');
        U.render();
      });
    }));
    bar.appendChild(button('清空', 'danger', function () {
      NS.monitor.stopPolling();
      NS.monitor.items = [];
      U.render();
    }));
    frag.appendChild(bar);

    // 监控模式
    var modeRow = el('div', 'szu-p-bar');
    modeRow.appendChild(el('span', undefined, '模式：'));
    var ms = el('select');
    [['category', '类别监控（拉类别列表，一次拿一类）'], ['single', '单独监控（逐课查容量，精确）']].forEach(function (m) {
      var o = el('option', undefined, m[1]); o.value = m[0]; ms.appendChild(o);
    });
    ms.value = s.monitorMode || 'category';
    ms.addEventListener('change', function () {
      NS.saveSettings({ monitorMode: ms.value });
      NS.monitor.stopPolling();
      U.toast('已切换为' + (ms.value === 'category' ? '类别监控' : '单独监控') + '，轮询已停止');
      U.render();
    });
    modeRow.appendChild(ms);
    frag.appendChild(modeRow);

    var iv = NS.util.clamp(s.pollIntervalMs, 1000, 60000, 5000);
    var state = NS.monitor.polling
      ? ('运行中（' + (isCat ? '类别' : '单独') + '模式，每 ' + iv + 'ms 一轮，已完成 ' + NS.monitor.pollCount + ' 轮，命中 ' + NS.monitor.hitCount + ' 次）')
      : '未运行';
    frag.appendChild(el('div', 'szu-p-ok', '轮询状态：' + state));
    if (NS.monitor.lastPollAt) {
      frag.appendChild(el('div', 'szu-p-msg', '上次检查：' + new Date(NS.monitor.lastPollAt).toLocaleTimeString()));
    }
    frag.appendChild(el('div', 'szu-p-msg', isCat
      ? '类别监控端点：programCourse.do / publicCourse.do 等；余量 = 课容量 − 已选人数'
      : '单独监控端点：teachingclass/capacity.do；余量 = mainClassCapacity − mainElectiveNumber'));

    if (!NS.isWriteAllowed(s)) {
      frag.appendChild(el('div', 'szu-p-warn', '写接口关闭中：命中余量只会提醒，不会自动抢。'));
    } else {
      frag.appendChild(el('div', 'szu-p-warn', '⚠ 写接口已开启：命中余量会自动提交抢课请求。'));
    }

    if (!NS.monitor.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无监控项。到课程列表点「添加监控」加入。'));
    }
    NS.monitor.items.forEach(function (m) {
      var box = el('div', 'szu-p-task');
      var l1 = el('div', 'szu-p-row');
      l1.appendChild(el('span', 'szu-p-name', m.courseName || '(未命名)'));
      l1.appendChild(el('span', 'szu-p-id', m.teachingClassID));
      l1.appendChild(el('span', undefined, NS.api.CATEGORY_NAME[m.category] || m.category || '类别未知'));
      box.appendChild(l1);
      var l2 = el('div', 'szu-p-row');
      l2.appendChild(button('立即抢一次', '', function () {
        NS.monitor.grabNow(m).then(function (r) {
          U.toast(r.ok ? '已抢成功' : ('未成功：' + (r.msg || r.reason)));
          U.render();
        });
      }));
      l2.appendChild(button('移除', 'danger', function () {
        NS.monitor.remove(m.teachingClassID);
        U.render();
      }));
      box.appendChild(l2);
      var remain = m.remain;
      var txt = remain === null || remain === undefined
        ? (m.checkedAt ? '余量：未能取到（字段缺失或未匹配到该教学班）' : '尚未检查')
        : ('余量 ' + remain + (remain > 0 ? '（有空位）' : '（已满）'));
      box.appendChild(el('div', 'szu-p-msg' + (remain > 0 ? ' ok' : ''), txt));
      if (m.lastMsg) box.appendChild(el('div', 'szu-p-msg err', m.lastMsg));
      frag.appendChild(box);
    });
    return frag;
  }

  function renderCustom() {
    var frag = root.document.createDocumentFragment();

    frag.appendChild(el('div', 'szu-p-sec', '新增自定义课程'));
    frag.appendChild(el('div', 'szu-p-msg',
      '时间写法示例：5-18周 星期二 3-4节 致理楼L1-707（逗号可分隔多段；' +
      '单周写 (单)、双周写 (双)）'));

    var nameIn = root.document.createElement('input');
    nameIn.type = 'text';
    nameIn.placeholder = '课程名';
    nameIn.style.width = '100%';
    var teacherIn = root.document.createElement('input');
    teacherIn.type = 'text';
    teacherIn.placeholder = '教师（可空）';
    teacherIn.style.width = '100%';
    var placeIn = root.document.createElement('input');
    placeIn.type = 'text';
    placeIn.placeholder = '时间地点';
    placeIn.style.width = '100%';

    [nameIn, teacherIn, placeIn].forEach(function (i) {
      var row = el('div', 'szu-p-row');
      row.style.margin = '3px 0';
      row.appendChild(i);
      frag.appendChild(row);
    });

    var addBar = el('div', 'szu-p-bar');
    addBar.appendChild(button('添加', '', function () {
      var name = String(nameIn.value || '').trim();
      var place = String(placeIn.value || '').trim();
      if (!name) { U.toast('请填课程名'); return; }
      if (!place) { U.toast('请填时间地点'); return; }
      if (!NS.time.parse(place).length) {
        U.toast('时间格式无法解析，请按示例填写（如 5-18周 星期二 3-4节 地点）');
        return;
      }
      NS.custom.add({ name: name, teacher: String(teacherIn.value || '').trim(), place: place });
      nameIn.value = '';
      teacherIn.value = '';
      placeIn.value = '';
      U.toast('已添加');
      U.render();
      if (NS.timetable) NS.timetable.render();
    }));
    frag.appendChild(addBar);

    var sc = NS.custom.selfConflicts();
    if (sc.length) {
      frag.appendChild(el('div', 'szu-p-warn',
        '注意：自定义课程之间有 ' + sc.length + ' 处时间冲突'));
    }

    frag.appendChild(el('div', 'szu-p-sec', '已添加（' + NS.custom.items.length + ' 门）'));
    if (!NS.custom.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无自定义课程。到课表页也会显示这些课。'));
    }
    NS.custom.items.forEach(function (c) {
      var box = el('div', 'szu-p-task');
      var l1 = el('div', 'szu-p-row');
      var cb = root.document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.enabled;
      cb.addEventListener('change', function () {
        NS.custom.update(c.id, { enabled: cb.checked });
        U.render();
        if (NS.timetable) NS.timetable.render();
      });
      l1.appendChild(cb);
      l1.appendChild(el('span', 'szu-p-name', c.name));
      if (c.segs.length) {
        l1.appendChild(el('span', undefined, '解析出 ' + c.segs.length + ' 段'));
      } else {
        l1.appendChild(el('span', 'szu-p-msg err', '时间未解析'));
      }
      box.appendChild(l1);
      box.appendChild(el('div', 'szu-p-msg', (c.teacher ? c.teacher + '　' : '') + c.place));
      var l2 = el('div', 'szu-p-row');
      l2.appendChild(button('删除', 'danger', function () {
        NS.custom.remove(c.id);
        U.render();
        if (NS.timetable) NS.timetable.render();
      }));
      box.appendChild(l2);
      frag.appendChild(box);
    });

    var bar2 = el('div', 'szu-p-bar');
    bar2.appendChild(button('清空全部', 'danger', function () {
      if (root.confirm && !root.confirm('确定清空全部自定义课程？')) return;
      NS.custom.clear();
      U.render();
      if (NS.timetable) NS.timetable.render();
    }));
    bar2.appendChild(button('刷新课表注入', '', function () {
      if (!NS.timetable) return;
      var n = NS.timetable.render();
      U.toast(n ? ('已注入 ' + n + ' 段') : '未找到课表容器（请到课表页使用）');
    }));
    frag.appendChild(bar2);

    return frag;
  }

  function renderSetting() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();
    var ctx = NS.list.sessionContext();

    frag.appendChild(el('div', 'szu-p-sec', '写接口（红线①：默认关闭，不得改默认值）'));
    var wrap = el('div');
    var cb = root.document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = NS.isWriteAllowed(s);
    cb.addEventListener('change', function () {
      if (cb.checked) {
        var ok = !root.confirm || root.confirm(
          '开启写接口后，点「开始抢课」会真实提交选课请求，风险由你自负。\n\n确认开启？'
        );
        if (!ok) { cb.checked = false; return; }
        NS.saveSettings({ writeApiEnabled: true });
        NS.warn('写接口已开启');
      } else {
        NS.saveSettings({ writeApiEnabled: false });
        NS.info('写接口已关闭');
      }
      U.render();
    });
    var lab = el('label');
    lab.appendChild(cb);
    lab.appendChild(el('span', undefined, '启用写接口（真实发请求）'));
    wrap.appendChild(lab);
    frag.appendChild(wrap);

    frag.appendChild(el('div', 'szu-p-sec', '会话信息（来自页面 sessionStorage）'));
    var kv = el('div');
    kv.appendChild(el('div', undefined, '学号：' + (ctx.studentCode || '(未取到)')));
    kv.appendChild(el('div', undefined, '批次码：' + (ctx.batchCode || '(未取到)')));
    kv.appendChild(el('div', undefined, '校区：' + ctx.campus));
    frag.appendChild(kv);
    var rb = el('div', 'szu-p-bar');
    rb.appendChild(button('重新获取', '', function () {
      var c2 = NS.list.sessionContext();
      if (c2.batchCode) {
        NS.saveSettings({ batchCode: c2.batchCode });
        U.toast('已取到批次码：' + c2.batchCode);
      } else {
        U.toast('页面 sessionStorage 里没有批次码，请刷新选课页');
      }
      U.render();
    }));
    rb.appendChild(button('清空保存的批次码', '', function () {
      NS.saveSettings({ batchCode: '' });
      U.toast('已清空');
      U.render();
    }));
    frag.appendChild(rb);

    frag.appendChild(el('div', 'szu-p-sec', '响应接管（只接管站点自己的请求，脚本请求不接管）'));
    frag.appendChild(boolRow('课表注入：把自定义课程写进课表返回', 'hijackTimetable',
      '开启后，课表页会显示你添加的自定义课程（站点原生渲染）。'));
    frag.appendChild(boolRow('列表冲突重算：把自定义课程计入冲突', 'hijackListConflict',
      '开启后，课程列表里与自定义课程撞时间的教学班会显示冲突。若导致无法选课，可关闭此项。'));

    frag.appendChild(el('div', 'szu-p-sec', '时间参数'));
    frag.appendChild(numberRow('请求间隔(ms，硬下限 200)', 'intervalMs', 200, 60000, function (v) {
      NS.saveSettings({ intervalMs: v });
      NS.queue.intervalMs = Math.min(60000, Math.max(200, v));
    }));
    frag.appendChild(numberRow('抢课重试间隔(ms)', 'retryIntervalMs', 500, 60000, function (v) {
      NS.saveSettings({ retryIntervalMs: v });
    }));
    frag.appendChild(numberRow('监控轮询间隔(ms)', 'pollIntervalMs', 1000, 60000, function (v) {
      NS.saveSettings({ pollIntervalMs: v });
    }));

    frag.appendChild(el('div', 'szu-p-sec', '监控模式'));
    var ms = el('select');
    [['category', '类别监控（默认）'], ['single', '单独监控']].forEach(function (m) {
      var o = el('option', undefined, m[1]); o.value = m[0]; ms.appendChild(o);
    });
    ms.value = s.monitorMode || 'category';
    ms.addEventListener('change', function () { NS.saveSettings({ monitorMode: ms.value }); });
    frag.appendChild(ms);

    return frag;
  }

  /** 一个布尔设置项（带说明）。 */
  function boolRow(labelText, key, hint) {
    var wrap = el('div');
    var lab = el('label');
    var cb = root.document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = NS.settings()[key] !== false;
    cb.addEventListener('change', function () {
      var patch = {};
      patch[key] = cb.checked;
      NS.saveSettings(patch);
      NS.info('接管开关 ' + key + ' = ' + cb.checked);
      U.toast((cb.checked ? '已开启：' : '已关闭：') + labelText);
      if (hint) U.render();
    });
    lab.appendChild(cb);
    lab.appendChild(el('span', undefined, labelText));
    wrap.appendChild(lab);
    if (hint) wrap.appendChild(el('div', 'szu-p-msg', hint));
    return wrap;
  }

  function numberRow(labelText, key, min, max, onChange) {
    var s = NS.settings();
    var row = el('label');
    row.appendChild(el('span', undefined, labelText + '：'));
    var inp = root.document.createElement('input');
    inp.type = 'number';
    inp.value = String(s[key]);
    inp.style.width = '80px';
    inp.addEventListener('change', function () {
      var v = NS.util.clamp(inp.value, min, max, Number(s[key]) || min);
      inp.value = String(v);
      onChange(v);
      U.toast('已保存');
    });
    row.appendChild(inp);
    return row;
  }

  function renderLog() {
    var frag = root.document.createDocumentFragment();
    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('刷新', '', function () { U.render(); }));
    bar.appendChild(button('清空', 'danger', function () { NS.LOG.buf.length = 0; U.render(); }));
    bar.appendChild(button('复制到控制台', '', function () {
      console.log('%c[SZUBKXK 日志]\n' + NS.LOG.buf.join('\n'), 'color:#047ADC');
      U.toast('已输出到控制台');
    }));
    frag.appendChild(bar);
    var pre = el('div', 'szu-p-log', NS.LOG.buf.length ? NS.LOG.buf.join('\n') : '(暂无日志)');
    frag.appendChild(pre);
    return frag;
  }

  U.render = function () {
    if (!panel) return;
    var tabs = panel.querySelectorAll('.szu-p-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === currentTab;
      tabs[i].className = 'szu-p-tab' + (on ? ' on' : '');
    }
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    bodyEl.appendChild(
      currentTab === TAB.TASK ? renderTasks()
        : currentTab === TAB.MONITOR ? renderMonitor()
          : currentTab === TAB.CUSTOM ? renderCustom()
            : currentTab === TAB.SETTING ? renderSetting()
              : renderLog()
    );
  };

  U.toast = function (msg) {
    if (NS.list && NS.list.toast) NS.list.toast(msg);
  };

  U.start = function () {
    var p = U.build();
    var s = NS.settings();
    if (s.panelCollapsed) {
      var b = p.querySelector('.szu-p-body');
      var t = p.querySelector('.szu-p-tabs');
      if (b) b.style.display = 'none';
      if (t) t.style.display = 'none';
    }
    U.render();
    // 任务运行中时定期刷新界面（显示尝试次数与状态）
    setInterval(function () {
      if (NS.tasks.running) U.render();
    }, 1000);
    NS.info('悬浮窗已就绪');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==================== src/main.js ==================== */
/**
 * 入口装配：按页面分派。前台用户主动运行，不自动启动任务（红线⑤）。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;

  function ready(fn) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  NS.main = function () {
    var path = root.location.pathname || '';
    var s = NS.settings();

    // 接管必须尽早安装：站点可能在 DOMContentLoaded 前就发请求
    NS.hijack.install();

    NS.info('SZUBKXK v' + NS.VERSION + ' 已加载', {
      页面: path,
      写接口: NS.isWriteAllowed(s) ? '开启' : '关闭',
      请求间隔: NS.queue.intervalMs + 'ms',
      batchCode: s.batchCode || '(空，待自动获取)',
    });

    // 选课页：P0 课程列表优化 + P1 悬浮窗
    if (/default\/grablessons\.do/.test(path)) {
      // 恢复上次的任务与监控（不自动启动执行，红线⑤）
      NS.tasks.load();
      NS.monitor.load();
      NS.custom.load();
      ready(function () {
        NS.list.start();
        NS.ui.start();
      });
      return;
    }

    // 课表页：M4 注入自定义课程 + 悬浮窗
    if (/default\/curriculum\.do/.test(path)) {
      NS.custom.load();
      ready(function () {
        NS.timetable.start();
        NS.ui.start();
      });
      return;
    }

    // 其他页面也恢复数据，便于悬浮窗查看
    NS.tasks.load();
    NS.monitor.load();
    NS.custom.load();
  };

  NS.main();
})(typeof globalThis !== 'undefined' ? globalThis : this);
