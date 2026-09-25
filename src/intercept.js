/**
 * 网络拦截：捕获站点自己请求回来的教学班数据。
 *
 * 【为什么需要】方案内/方案外/推荐/辅修/重修/体育这些列表，**行是「课程」而非「教学班」**
 * （模板 tpl-program-list-row 等不含 tcId），教学班藏在响应 tcList 里，
 * 点「课程详情」才由站点自己去取。我们劫持那份响应，把每个教学班的
 * 「ID + 按钮」补渲染出来，用户无需额外操作。
 *
 * 【拦截点】站点所有请求都走 `BH_UTILS.doAjax`（内部用 $.ajax + $.Deferred），
 * 因此包一层 doAjax 即可覆盖全部，不需要逐个匹配 URL。
 * 这是**只读**劫持：不改请求、不注入请求头、不重放。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var I = (NS.intercept = NS.intercept || {});

  /** 关注的列表端点 → 我们感兴趣的响应。 */
  var LIST_RE = /elective\/(?:programCourse|unProgramCourse|publicCourse|recommendedCourse|minorCourse|retakeCourse|sportCourse|queryCourse|course)\.do/i;

  I.installed = false;
  I.seen = 0;

  /**
   * 处理一份列表响应：把教学班补渲染到对应课程行下方。
   * @param {object} json 响应 JSON
   */
  I.handleListResponse = function (json) {
    var classes = NS.courses.flatten(json);
    if (!classes.length) return 0;
    var rows = root.document.querySelectorAll('div.cv-row[coursenumber]');
    if (!rows.length) return 0;

    var byCourse = {};
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      if (!c || !c.courseNumber) continue;
      if (!byCourse[c.courseNumber]) byCourse[c.courseNumber] = [];
      byCourse[c.courseNumber].push(c);
    }

    var added = 0;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var cn = row.getAttribute('coursenumber');
      var list = byCourse[cn];
      if (!list) continue;
      if (row.getAttribute('data-szu-classes') === '1') continue;
      row.setAttribute('data-szu-classes', '1');

      // 该课程下每个教学班补一条横条
      var anchor = row;
      for (var k = 0; k < list.length; k++) {
        var info = {
          teachingClassID: list[k].teachingClassID,
          courseName: list[k].courseName || '',
          teacherName: list[k].teacherName || '',
          teachingPlace: list[k].teachingPlace || '',
          courseIndex: list[k].courseIndex || '',
        };
        if (!info.teachingClassID) continue;
        var bar = NS.list.buildBar(info);
        if (anchor.parentNode) {
          anchor.parentNode.insertBefore(bar, anchor.nextElementSibling || null);
          anchor = bar;
          added++;
        }
      }
    }
    if (added) NS.info('拦截补渲染 ' + added + ' 个教学班');
    return added;
  };

  /** 包一层 BH_UTILS.doAjax。 */
  I.install = function () {
    if (I.installed) return false;
    var bh = root.BH_UTILS;
    if (!bh || typeof bh.doAjax !== 'function') {
      NS.warn('未找到 BH_UTILS.doAjax，跳过拦截（课程级列表将只增强已展开行）');
      return false;
    }
    var orig = bh.doAjax;
    bh.doAjax = function (url, params, method, requestOption, headers) {
      var d = orig.apply(this, arguments);
      try {
        if (LIST_RE.test(String(url))) {
          d.done(function (resp) {
            try {
              var json = typeof resp === 'string' ? JSON.parse(resp) : resp;
              I.seen++;
              I.handleListResponse(json);
              NS.courses.learnBatchCode(json);
            } catch (e) {
              NS.warn('拦截解析失败', e && e.message);
            }
          });
        }
      } catch (e) {
        NS.warn('拦截挂载失败', e && e.message);
      }
      return d;
    };
    I.installed = true;
    NS.info('已挂载 doAjax 拦截');
    return true;
  };

  /**
   * 兜底：站点若在 doAjax 之外发请求，用 XHR 事件再抓一层。
   * 只读取响应，不修改任何请求。
   */
  I.installXhrHook = function () {
    if (!root.XMLHttpRequest || I._xhrHooked) return false;
    I._xhrHooked = true;
    var Orig = root.XMLHttpRequest;
    function Wrapped() {
      var xhr = new Orig();
      xhr.addEventListener('load', function () {
        try {
          var u = String(xhr.responseURL || '');
          if (!LIST_RE.test(u)) return;
          if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json') return;
          var json = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          I.seen++;
          I.handleListResponse(json);
          NS.courses.learnBatchCode(json);
        } catch (e) { /* 忽略非 JSON */ }
      });
      return xhr;
    }
    Wrapped.prototype = Orig.prototype;
    try {
      root.XMLHttpRequest = Wrapped;
    } catch (e) {
      return false;
    }
    return true;
  };

  I.start = function () {
    I.install();
    I.installXhrHook();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
