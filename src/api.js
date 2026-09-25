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

  /** 类别代码 → 列表端点。MONOC 之外的都走 programCourse.do。 */
  API.CATEGORY_EP = {
    FANKC: API.EP.PROGRAM_COURSE,
    FAWKC: API.EP.PROGRAM_COURSE,
    TJKC: API.EP.PROGRAM_COURSE,
    XGXK: API.EP.PROGRAM_COURSE,
    TYKC: API.EP.PROGRAM_COURSE,
    FXKC: API.EP.PROGRAM_COURSE,
    MOOC: API.EP.PUBLIC_COURSE,
  };

  API.CATEGORIES = ['FANKC', 'FAWKC', 'TJKC', 'XGXK', 'TYKC', 'FXKC', 'MOOC'];

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
   * 字段顺序固定：operationType / studentCode / electiveBatchCode /
   * teachingClassId / isMajor / campus / teachingClassType。
   * @returns {string} `addParam=<urlencode(JSON)>`
   */
  API.buildVolunteerBody = function (p) {
    var payload = {
      operationType: '1',
      studentCode: String(p.studentCode),
      electiveBatchCode: String(p.electiveBatchCode),
      teachingClassId: String(p.teachingClassId),
      isMajor: p.isMajor === undefined || p.isMajor === null ? '1' : String(p.isMajor),
      campus: p.campus === undefined || p.campus === null ? '01' : String(p.campus),
      teachingClassType: String(p.teachingClassType),
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
   * @param {object} o {url, method, body, token, priority}
   * @returns {Promise<{status:number, text:string, cls:object}>}
   */
  API.send = function (o) {
    return NS.queue.submit(function () {
      var headers = {};
      if (o.token) {
        var h = API.headers(o.token);
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = h[k];
      }
      if (o.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      var url = API.appendTimestamp(o.url);
      return root.fetch(url, {
        method: o.method || 'POST',
        credentials: 'include',
        headers: headers,
        body: o.body,
      }).then(function (res) {
        return res.text().then(function (text) {
          var cls = API.classify({ status: res.status, text: text });
          // 红线④：未识别必须全量落档
          if (cls.kind === API.RESP_KIND.UNKNOWN) {
            NS.dumpUnknown({ action: o.action || '?', url: url, body: o.body || '', text: text });
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
