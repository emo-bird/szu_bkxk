/**
 * 会话读取：从站点自己的 sessionStorage 里取登录态（现取现用，**绝不落盘**）。
 *
 * 【为什么不需要读 cookie】同源请求由浏览器自动附带 cookie（含 HttpOnly），
 *   JS 读不到也不需要读。实测鉴权要 cookie + token 同时具备（逆向记录 §二），
 *   所以这里只负责把 token / 学号 / 批次号取出来。
 *
 * 【证据】站点 JS 原文使用 `sessionStorage.token`、
 *   `JSON.parse(sessionStorage.getItem('studentInfo'))`、
 *   `JSON.parse(sessionStorage.getItem('currentBatch'))`（逆向记录 §3.4）。
 *
 * 【登录态判断】本地凭据齐全**不等于**登录有效——实测同一组凭证下
 *   `check/login.do` 会报"认证失败"而业务接口正常。真实登录态一律以**业务接口返回**为准。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var SESS = (NS.session = NS.session || {});

  /** sessionStorage 里站点使用的键名。 */
  SESS.KEYS = {
    TOKEN: 'token',
    STUDENT_INFO: 'studentInfo',
    CURRENT_BATCH: 'currentBatch',
  };

  /**
   * studentInfo 里学号的候选字段名。
   * 【待 M0 真机确认】目前按文档记载与常见命名给候选，取第一个有效值。
   */
  SESS.STUDENT_CODE_CANDIDATES = ['studentCode', 'studentcode', 'xh', 'studentNo'];

  /** currentBatch 里批次号/学期的候选字段名。 */
  SESS.BATCH_CODE_CANDIDATES = ['code', 'electiveBatchCode', 'batchCode'];
  SESS.SCHOOL_TERM_CANDIDATES = ['schoolTerm', 'schoolterm', 'term'];

  /**
   * 安全取到 sessionStorage（不可用时返回 null，绝不抛）。
   * @param {object} win 目标 window
   * @returns {(object|null)}
   */
  function safeStorage(win) {
    try {
      return win && win.sessionStorage ? win.sessionStorage : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 读取当前会话凭据。
   * @param {object} [win] 目标 window，默认全局对象
   * @returns {{token:(string|null), studentCode:(string|null), electiveBatchCode:(string|null),
   *            schoolTerm:(string|null), ok:boolean, missing:string[], available:boolean}}
   */
  SESS.read = function (win) {
    var w = win || root;
    var storage = safeStorage(w);
    var out = {
      token: null,
      studentCode: null,
      electiveBatchCode: null,
      schoolTerm: null,
      ok: false,
      missing: [],
      available: !!storage,
    };
    if (!storage) {
      out.missing = ['token', 'studentInfo', 'currentBatch'];
      return out;
    }

    var token = null;
    var studentRaw = null;
    var batchRaw = null;
    try {
      token = storage.getItem(SESS.KEYS.TOKEN);
      studentRaw = storage.getItem(SESS.KEYS.STUDENT_INFO);
      batchRaw = storage.getItem(SESS.KEYS.CURRENT_BATCH);
    } catch (e) {
      // 读取抛错（极少见）→ 当作未登录
      out.missing = ['token', 'studentInfo', 'currentBatch'];
      return out;
    }

    var studentInfo = NS.util.parseJson(studentRaw, {}) || {};
    var currentBatch = NS.util.parseJson(batchRaw, {}) || {};

    out.token = token ? String(token) : null;
    var sc = NS.util.pick(studentInfo, SESS.STUDENT_CODE_CANDIDATES, null);
    out.studentCode = sc === null ? null : String(sc);
    var bc = NS.util.pick(currentBatch, SESS.BATCH_CODE_CANDIDATES, null);
    out.electiveBatchCode = bc === null ? null : String(bc);
    var st = NS.util.pick(currentBatch, SESS.SCHOOL_TERM_CANDIDATES, null);
    out.schoolTerm = st === null ? null : String(st);

    if (!out.token) out.missing.push('token');
    if (!out.studentCode) out.missing.push('studentCode');
    if (!out.electiveBatchCode) out.missing.push('electiveBatchCode');
    out.ok = out.missing.length === 0;
    return out;
  };

  /**
   * 脱敏显示用（**只用于 UI 上确认"读到了哪一份会话"**）。
   * 规则与桌面版一致：保留前 8 个字符 + 长度。
   * ⚠️ 日志里仍然不允许出现完整 token / cookie。
   * @param {*} secret 敏感串
   * @returns {string}
   */
  SESS.mask = function (secret) {
    if (secret === undefined || secret === null || secret === '') return '(空)';
    var s = String(secret);
    if (s.length <= 8) return s.charAt(0) + '***(长度 ' + s.length + ')';
    return s.slice(0, 8) + '…(长度 ' + s.length + ')';
  };

  /**
   * 给用户的会话摘要（可直接放日志/面板）。
   * @param {object} session SESS.read() 的结果
   * @returns {string}
   */
  SESS.describe = function (session) {
    if (!session || !session.available) return '会话不可用（读不到 sessionStorage）';
    if (!session.ok) return '登录信息不完整，缺少：' + session.missing.join('、');
    return (
      '会话已就绪：学号 ' + SESS.mask(session.studentCode) + '，批次 ' + SESS.mask(session.electiveBatchCode)
    );
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
