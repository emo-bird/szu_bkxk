/**
 * 课程数据（诊断）面板：让"被动采集到了什么"变得可见、可复制回传。
 *
 * ⚠️ **这不是 M3 的最终课程列表方案**（视觉方案由用户另行提供）。
 *    它只用于：确认采集链路是否通了、字段是否解析对了、以及把真实数据回传。
 *
 * 依赖：NS.diagnostics / NS.model（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var CD = (UI.courseData = UI.courseData || {});

  /** 面板里最多列出多少条课程。 */
  CD.DISPLAY_LIMIT = 30;

  /** 建元素的小工具。 */
  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * 复制文本到剪贴板，带降级（**可离线单测：传入假的 win/doc**）。
   * @param {object} win window
   * @param {Document} doc document
   * @param {string} text 待复制文本
   * @returns {boolean} 是否成功
   */
  CD.copyText = function (win, doc, text) {
    if (typeof text !== 'string' || text === '') return false;
    try {
      var nav = win && win.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        nav.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* 继续走降级方案 */
    }
    try {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      var ok = doc.execCommand ? doc.execCommand('copy') : false;
      doc.body.removeChild(ta);
      return !!ok;
    } catch (e2) {
      return false;
    }
  };

  /**
   * 创建诊断面板区块。
   * @param {object} options
   * @param {Document} options.doc
   * @param {object} [options.win]
   * @param {object} [options.courseCache] data/courseCache 实例
   * @param {object} [options.logger]
   * @param {object} [options.captureHandle] NS.capture 句柄（取原始样本）
   * @param {Function} [options.getCustomCourses] 返回自定义课程列表
   * @param {Function} [options.getEnvText] 返回环境侦察文本
   * @returns {{element:Element, refresh:Function}}
   */
  CD.create = function (options) {
    options = options || {};
    var doc = options.doc;
    var win = options.win || (doc && doc.defaultView) || root;
    var courseCache = options.courseCache || null;
    var logger = options.logger || null;
    var captureHandle = options.captureHandle || null;
    var getCustomCourses = typeof options.getCustomCourses === 'function' ? options.getCustomCourses : function () { return []; };
    var getEnvText = typeof options.getEnvText === 'function' ? options.getEnvText : function () { return ''; };
    var getSelfTestText =
      typeof options.getSelfTestText === 'function' ? options.getSelfTestText : function () { return ''; };

    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '课程数据（诊断）'));
    sec.appendChild(el(doc, 'div', 'szubkxk-muted', '被动采集结果，用于核对与回传；不是最终课程列表方案'));

    var statLine = el(doc, 'div', 'szubkxk-row szubkxk-muted', '(未采集)');
    sec.appendChild(statLine);

    var bar = el(doc, 'div', 'szubkxk-row');
    var btnRefresh = el(doc, 'button', 'szubkxk-btn', '刷新');
    var btnCopyCourses = el(doc, 'button', 'szubkxk-btn', '复制课程数据');
    var btnCopySamples = el(doc, 'button', 'szubkxk-btn', '复制响应样本');
    var btnCopyAll = el(doc, 'button', 'szubkxk-btn', '复制回传包');
    var btnClear = el(doc, 'button', 'szubkxk-btn szubkxk-danger', '清空');
    [btnRefresh, btnCopyCourses, btnCopySamples, btnCopyAll, btnClear].forEach(function (b) {
      b.type = 'button';
      bar.appendChild(b);
    });
    sec.appendChild(bar);

    var list = el(doc, 'div', 'szubkxk-tasks');
    sec.appendChild(list);

    function safe(fn, label) {
      return function () {
        try {
          fn();
        } catch (e) {
          if (logger) logger.error(NS.log.CATEGORY.SYSTEM, '课程数据面板出错：' + label, (e && e.message) || e);
        }
      };
    }

    function records() {
      return courseCache ? courseCache.list() : [];
    }

    function samples() {
      return captureHandle && typeof captureHandle.samples === 'function' ? captureHandle.samples() : [];
    }

    function courseText() {
      return NS.diagnostics.buildCourseDigest({
        records: records(),
        customCourses: getCustomCourses(),
        updatedAt: courseCache ? courseCache.updatedAt() : null,
      });
    }

    function sampleText() {
      return NS.diagnostics.buildSampleDigest(samples());
    }

    /** 统一的"复制并反馈"流程。 */
    function doCopy(text, label) {
      if (!text) {
        if (logger) logger.warn(NS.log.CATEGORY.SYSTEM, label + '：没有可复制的内容');
        return;
      }
      var ok = CD.copyText(win, doc, text);
      if (logger) {
        if (ok) {
          logger.info(NS.log.CATEGORY.SYSTEM, label + '已复制到剪贴板（' + text.length + ' 字符）');
        } else {
          logger.warn(
            NS.log.CATEGORY.SYSTEM,
            label + '复制失败（浏览器可能未授权剪贴板）—— 以下内容请手动复制',
            text
          );
        }
      }
    }

    btnRefresh.addEventListener(
      'click',
      safe(function () {
        refresh();
      }, '刷新')
    );
    btnCopyCourses.addEventListener(
      'click',
      safe(function () {
        doCopy(courseText(), '课程数据');
      }, '复制课程数据')
    );
    btnCopySamples.addEventListener(
      'click',
      safe(function () {
        doCopy(sampleText(), '响应样本');
      }, '复制响应样本')
    );
    btnCopyAll.addEventListener(
      'click',
      safe(function () {
        doCopy(
          NS.diagnostics.buildFullReport({
            version: NS.version,
            selfTestText: getSelfTestText(),
            envText: getEnvText(),
            courseText: courseText(),
            sampleText: sampleText(),
          }),
          '回传包'
        );
      }, '复制回传包')
    );
    btnClear.addEventListener(
      'click',
      safe(function () {
        if (courseCache) courseCache.clear();
        if (captureHandle && captureHandle.clearSamples) captureHandle.clearSamples();
        refresh();
        if (logger) logger.info(NS.log.CATEGORY.SYSTEM, '已清空课程数据与响应样本');
      }, '清空')
    );

    function refresh() {
      var recs = records();
      var s = samples();
      statLine.textContent =
        '已采集 ' +
        recs.length +
        ' 条课程；响应样本 ' +
        s.length +
        ' 份；缓存更新时间 ' +
        NS.diagnostics.formatTime(courseCache ? courseCache.updatedAt() : null);

      while (list.firstChild) list.removeChild(list.firstChild);
      if (recs.length === 0) {
        list.appendChild(el(doc, 'div', 'szubkxk-muted', '（在选课页浏览/查询课程后，这里会出现数据）'));
        return;
      }
      var shown = Math.min(recs.length, CD.DISPLAY_LIMIT);
      for (var i = 0; i < shown; i++) {
        var r = recs[i];
        var row = el(doc, 'div', 'szubkxk-task');
        var line1 = el(doc, 'div', 'szubkxk-task-line');
        line1.appendChild(el(doc, 'span', 'szubkxk-task-name', r.courseName || '(无课程名)'));
        line1.appendChild(el(doc, 'span', 'szubkxk-muted', '教学班 ' + (r.teachingClassId || '—')));
        if (r.teacherName) line1.appendChild(el(doc, 'span', 'szubkxk-muted', r.teacherName));
        row.appendChild(line1);

        var seat = NS.model ? NS.model.hasFreeSeat(r) : null;
        var flags = [];
        if (seat === true) flags.push('有余量');
        else if (seat === false) flags.push('已满');
        else flags.push('余量未知');
        if (r.isMooc) flags.push('MOOC');
        var line2 = el(doc, 'div', 'szubkxk-task-line szubkxk-muted');
        line2.textContent =
          (NS.time ? NS.time.formatSessions(r.sessions) || r.teachingPlace || '—' : '—') + ' · ' + flags.join('、');
        row.appendChild(line2);
        list.appendChild(row);
      }
      if (recs.length > shown) {
        list.appendChild(el(doc, 'div', 'szubkxk-muted', '… 另有 ' + (recs.length - shown) + ' 条未显示'));
      }
    }

    refresh();
    return { element: sec, refresh: refresh, courseText: courseText, sampleText: sampleText };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
