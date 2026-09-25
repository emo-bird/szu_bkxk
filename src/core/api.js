/**
 * 站点接口层：报文构造（纯函数）、响应分类、未识别落档、写开关守卫。
 *
 * 【证据来源】docs/接口逆向记录.md 第二 / 三 / 八章（真实抓包逐字段核对）。
 *   本模块只做**纯函数**（不碰网络），便于离线单测；实际发送一律经 core/queue。
 *
 * 【红线】
 *   1. 写接口（volunteer / deleteVolunteer / favorite）必须由 isWriteAllowed() 守卫，
 *      默认关闭；关闭时调用方**只打印报文，不发请求**；
 *   2. `buildHeaders()` 的返回值**含 token**，严禁写入日志或持久化（只用于发请求）；
 *   3. 既非成功、也非业务拒绝、也非登录失效的响应，必须走 formatUnknownDump() 全量落档。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var API = (NS.api = NS.api || {});

  /** 站点根地址（站点为 http，非 https）。 */
  API.BASE_URL = 'http://bkxk.szu.edu.cn';
  /** 应用基路径（已实测确认正确）。 */
  API.BASE_PATH = '/xsxkapp/sys/xsxkapp/';

  /** 已确认端点（相对 BASE_PATH）。 */
  API.EP = {
    // 只读：课程查询（按类别分派，见逆向记录 3.1）
    PROGRAM_COURSE: 'elective/programCourse.do',
    PUBLIC_COURSE: 'elective/publicCourse.do',
    RECOMMENDED_COURSE: 'elective/recommendedCourse.do',
    QUERY_COURSE: 'elective/queryCourse.do',
    // 只读：其它
    BATCH: 'elective/batch.do',
    COURSE_RESULT: 'elective/courseResult.do',
    VOLUNTEERED: 'elective/volunteered.do',
    CAPACITY: 'elective/teachingclass/capacity.do',
    STUDENT_STATUS: 'elective/studentstatus.do',
    // 写：默认关闭
    VOLUNTEER: 'elective/volunteer.do',
    DELETE_VOLUNTEER: 'elective/deleteVolunteer.do',
    FAVORITE: 'elective/favorite.do',
  };

  /** 响应分类结果（与桌面版一致）。 */
  API.RESP_KIND = {
    OK: 'ok',
    BUSINESS: 'business',
    UNAUTHENTICATED: 'unauthenticated',
    UNKNOWN: 'unknown',
  };

  /** 服务端业务码。 */
  API.RESP_CODE = {
    SUCCESS: '1',
    BUSINESS_ERROR: '2',
    UNAUTHENTICATED: '302',
  };

  /** 登录/认证失效的文案特征（仅在 code 无法判定时兜底）。 */
  var AUTH_MSG_PATTERN = /登录|认证/;

  /**
   * 计算字符串的 UTF-8 字节数（未识别落档里要报"响应长度 N 字节"）。
   * @param {string} str 输入
   * @returns {number} 字节数
   */
  API.byteLength = function (str) {
    var s = str === undefined || str === null ? '' : String(str);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
    return s.length;
  };

  /**
   * 分类一次响应。
   *
   * 判定顺序（**不要调整**，这是按实测行为定的）：
   *   1. HTTP 401/403、3xx → 登录态失效；
   *   2. 非 JSON → 未识别；
   *   3. code=1 成功 / code=2 业务拒绝 / code=302 登录失效；
   *   4. code 无法判定但 msg 含「登录」「认证」→ 登录态失效；
   *   5. 其余 → 未识别（调用方必须全量落档）。
   *
   * @param {object} input {status, text}
   * @returns {{kind:string, code:(string|null), msg:string, data:*, timestamp:(string|null),
   *            httpStatus:number, raw:string}}
   */
  API.classifyResponse = function (input) {
    var status = input && typeof input.status === 'number' ? input.status : 200;
    var text = input && typeof input.text === 'string' ? input.text : '';
    var out = {
      kind: API.RESP_KIND.UNKNOWN,
      code: null,
      msg: '',
      data: null,
      timestamp: null,
      httpStatus: status,
      raw: text,
    };

    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      out.kind = API.RESP_KIND.UNAUTHENTICATED;
      out.msg = '登录态失效（HTTP ' + status + '）';
      return out;
    }

    var json = NS.util.parseJson(text, null);
    if (!json || typeof json !== 'object') {
      out.msg = '响应不是 JSON';
      return out;
    }

    out.code = json.code === undefined || json.code === null ? null : String(json.code);
    out.msg = typeof json.msg === 'string' ? json.msg : '';
    out.data = json.data === undefined ? null : json.data;
    out.timestamp = json.timestamp === undefined || json.timestamp === null ? null : String(json.timestamp);

    if (out.code === API.RESP_CODE.SUCCESS) {
      out.kind = API.RESP_KIND.OK;
    } else if (out.code === API.RESP_CODE.BUSINESS_ERROR) {
      out.kind = API.RESP_KIND.BUSINESS;
    } else if (out.code === API.RESP_CODE.UNAUTHENTICATED) {
      out.kind = API.RESP_KIND.UNAUTHENTICATED;
    } else if (AUTH_MSG_PATTERN.test(out.msg)) {
      // 实测反例：code 是业务自定义串（如 #E2140600091）而 msg 为「认证失败」
      out.kind = API.RESP_KIND.UNAUTHENTICATED;
    } else {
      out.kind = API.RESP_KIND.UNKNOWN;
    }
    return out;
  };

  /**
   * 构造抢课（提交志愿）报文体。字段顺序与实测一致，**不要重排**。
   * @param {object} p {studentCode, electiveBatchCode, teachingClassId, teachingClassType, isMajor?, campus?}
   * @returns {{data:object}} 待 JSON.stringify 后作为 addParam 表单值
   */
  API.buildEnrollParam = function (p) {
    return {
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
  };

  /**
   * 构造退课（删除选课志愿）报文体。
   * 与抢课的关键差异：operationType=2，**不带** campus / teachingClassType。
   * @param {object} p {studentCode, electiveBatchCode, teachingClassId, isMajor?}
   * @returns {{data:object}}
   */
  API.buildDeleteParam = function (p) {
    return {
      data: {
        operationType: '2',
        studentCode: String(p.studentCode),
        electiveBatchCode: String(p.electiveBatchCode),
        teachingClassId: String(p.teachingClassId),
        isMajor: p.isMajor === undefined || p.isMajor === null ? '1' : String(p.isMajor),
      },
    };
  };

  /**
   * 构造查容量请求体（只读，抢课轮询首选——比拉整页课程列表轻得多）。
   * @param {string} teachingClassId 教学班 ID
   * @param {string} batchCode 批次号
   * @returns {string} application/x-www-form-urlencoded 请求体
   */
  API.buildCapacityBody = function (teachingClassId, batchCode) {
    return 'teachingClassId=' + encodeURIComponent(teachingClassId) + '&batchCode=' + encodeURIComponent(batchCode);
  };

  /**
   * 从 capacity.do 的 data 里算剩余名额。
   * 【重要】实测 classCapacity/numberOfFirstVolunteer/isFull 可能全为 null，
   * 必须用 mainClassCapacity - mainElectiveNumber。
   * @param {object} data capacity.do 的 data
   * @returns {(number|null)} 剩余名额；字段缺失/非法时返回 null（调用方不得当作"有余量"）
   */
  API.capacityRemain = function (data) {
    if (!data || typeof data !== 'object') return null;
    var cap = Number(data.mainClassCapacity);
    var used = Number(data.mainElectiveNumber);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /**
   * 把对象编码为 application/x-www-form-urlencoded 请求体。
   * @param {object} obj 键值对（值会被 String() 后 encodeURIComponent）
   * @returns {string}
   */
  API.buildFormBody = function (obj) {
    var parts = [];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] === undefined ? '' : String(obj[k])));
    }
    return parts.join('&');
  };

  /**
   * 给接口 URL 追加 `?timestamp=<13位毫秒>`（站点要求；已有 query 时用 &）。
   * @param {string} url 原始 URL
   * @param {number} [nowMs] 时间戳，默认 Date.now()（单测注入用）
   * @returns {string}
   */
  API.appendTimestamp = function (url, nowMs) {
    var ts = typeof nowMs === 'number' ? nowMs : Date.now();
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'timestamp=' + ts;
  };

  /**
   * 构造请求头。
   * ⚠️ 返回值**包含 token**，只允许传给发请求的一方；**严禁写入日志或持久化**。
   * cookie 不在此处设置 —— 同源 fetch 由浏览器自动附带。
   * @param {string} token 会话 token
   * @returns {object} headers
   */
  API.buildHeaders = function (token) {
    return {
      token: String(token),
      'X-Requested-With': 'XMLHttpRequest',
    };
  };

  /**
   * 写接口总开关守卫。
   * 【刻意严格】只接受**布尔 true**：字符串 "true"、数字 1 一律视为关闭。
   * 这是桌面版踩过的坑（`bool("false")` 为真），安全开关上最危险的一类错误。
   * @param {object} settings 设置对象
   * @returns {boolean} 是否允许发出真实写请求
   */
  API.isWriteAllowed = function (settings) {
    return !!(settings && settings.writeApiEnabled === true);
  };

  /**
   * 生成 `[未识别返回]` 全量留档文本（替代"直接丢弃看不懂的响应"）。
   * 这是本项目"边用边补"的主要反馈回路，**不要删掉**。
   * @param {object} input {action, url, body, text}
   * @returns {string} 多行文本
   */
  API.formatUnknownDump = function (input) {
    var action = (input && input.action) || '(未标注)';
    var url = (input && input.url) || '(未记录)';
    var body = input && input.body !== undefined && input.body !== null ? String(input.body) : '(无)';
    var text = input && typeof input.text === 'string' ? input.text : '';
    return [
      '[未识别返回] 该情况尚未处理，已全量留档供后续开发',
      '动作：' + action,
      '地址：' + url,
      '请求体：' + body,
      '响应长度：' + API.byteLength(text) + ' 字节',
      '响应原文：' + (text === '' ? '(空)' : text),
    ].join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
