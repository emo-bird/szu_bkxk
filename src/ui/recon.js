/**
 * M0 真机侦察：把"页面事实"一次性收集成可复制回传的文本。
 *
 * 【为什么需要】课表页 DOM、站点库加载情况、CSP 响应头、sessionStorage 键名
 * 这些东西**只能在真实浏览器里看到**，而沙箱里跑不了浏览器。
 * 所以脚本自己把能看到的都收集起来写进日志，用户复制回传即可。
 *
 * 【能看什么 / 看不到什么】
 *   - 能看到：window 上的库、DOM 结构、sessionStorage 键、URL、页面标题；
 *   - **看不到**：响应头（含 CSP）—— 浏览器不给 JS 读响应头，需要用 DevTools 的 Network 面板看。
 *
 * 依赖：NS.log（延迟取值，仅用于分类常量）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var R = (UI.recon = UI.recon || {});

  /**
   * 站点库探测表：`键 -> function(win) 返回版本或 true`。
   * 全部按**特性探测**，不假定一定存在（站点改版时会同时改这些库）。
   */
  var LIB_PROBES = {
    jQuery: function (w) {
      return w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery ? String(w.jQuery.fn.jquery) : false;
    },
    jQWidgets: function (w) {
      return !!w.jqx;
    },
    Sortable: function (w) {
      return !!w.Sortable;
    },
    Chart: function (w) {
      return !!w.Chart;
    },
    FlipClock: function (w) {
      return !!w.FlipClock;
    },
    SockJS: function (w) {
      return !!w.SockJS;
    },
    Stomp: function (w) {
      return !!(w.Stomp || w.StompJs);
    },
    niceScroll: function (w) {
      return !!(w.jQuery && w.jQuery.fn && w.jQuery.fn.niceScroll);
    },
    base64: function (w) {
      return !!(w.jQuery && w.jQuery.base64);
    },
  };

  /** 探测所有站点库。 */
  R.detectLibs = function (win) {
    var out = {};
    for (var k in LIB_PROBES) {
      if (!Object.prototype.hasOwnProperty.call(LIB_PROBES, k)) continue;
      try {
        out[k] = LIB_PROBES[k](win);
      } catch (e) {
        out[k] = false;
      }
    }
    return out;
  };

  /** 由 URL 判断当前是哪个页面。 */
  R.detectPage = function (url) {
    var u = String(url || '');
    if (/grablessons\.do/i.test(u)) return 'grablessons(选课页)';
    if (/curriculum\.do/i.test(u)) return 'curriculum(课表页)';
    if (/courseResult\.do/i.test(u)) return 'courseResult(已选结果)';
    if (/index\.do/i.test(u)) return 'index(首页)';
    if (/xsxkapp/i.test(u)) return 'xsxkapp其它页';
    return '非选课站点页';
  };

  /** 安全统计一个选择器的命中数。 */
  function count(doc, selector) {
    try {
      if (!doc || typeof doc.querySelectorAll !== 'function') return -1;
      return doc.querySelectorAll(selector).length;
    } catch (e) {
      return -1;
    }
  }

  /**
   * 收集页面事实。
   * @param {object} [win] 目标 window，默认全局对象
   * @returns {object} 事实对象（可直接 JSON 序列化）
   */
  R.collect = function (win) {
    var w = win || root;
    var doc = w.document || null;
    var url = (w.location && w.location.href) || '(未知)';
    var facts = {
      url: url,
      page: R.detectPage(url),
      title: (doc && doc.title) || '(无标题)',
      readyState: (doc && doc.readyState) || '(未知)',
      libs: R.detectLibs(w),
      dom: {
        // 卡片改造相关（逆向记录 §3.5 / §3.6）
        courseCard: count(doc, '.cv-course-card'),
        cvRow: count(doc, '.cv-row'),
        cvInfo: count(doc, '.cv-info'),
        // 课表页待侦察：先记录几个可能的容器，回传后再定选择器
        timetableTable: count(doc, 'table'),
        timetableGrid: count(doc, '.jqx-grid'),
        iframe: count(doc, 'iframe'),
      },
      storage: {
        localStorage: (function () {
          try {
            return !!w.localStorage;
          } catch (e) {
            return false;
          }
        })(),
      },
      session: null,
      note: '响应头（含 CSP）JS 读不到，请用 DevTools → Network → 该文档请求 → Response Headers 查看',
    };

    if (NS.session && NS.session.read) {
      var s = NS.session.read(w);
      facts.session = {
        available: s.available,
        ok: s.ok,
        missing: s.missing,
        tokenPresent: !!s.token,
        tokenMasked: NS.session.mask(s.token),
        studentCodeMasked: NS.session.mask(s.studentCode),
        electiveBatchCodeMasked: NS.session.mask(s.electiveBatchCode),
        schoolTerm: s.schoolTerm,
      };
    }
    return facts;
  };

  /**
   * 把事实对象格式化为可读多行文本（用于日志面板 / 复制回传）。
   * @param {object} facts R.collect() 的结果
   * @returns {string}
   */
  R.format = function (facts) {
    if (!facts) return '(无侦察数据)';
    var lines = [];
    lines.push('页面：' + facts.page + '  ' + facts.title);
    lines.push('地址：' + facts.url);
    lines.push('readyState=' + facts.readyState + '  localStorage=' + facts.storage.localStorage);

    var libParts = [];
    for (var k in facts.libs) {
      if (!Object.prototype.hasOwnProperty.call(facts.libs, k)) continue;
      var v = facts.libs[k];
      libParts.push(k + '=' + (v === false ? '缺失' : v === true ? '有' : v));
    }
    lines.push('站点库：' + libParts.join(', '));

    lines.push(
      'DOM：.cv-course-card=' +
        facts.dom.courseCard +
        ' .cv-row=' +
        facts.dom.cvRow +
        ' .cv-info=' +
        facts.dom.cvInfo +
        ' table=' +
        facts.dom.timetableTable +
        ' .jqx-grid=' +
        facts.dom.timetableGrid +
        ' iframe=' +
        facts.dom.iframe
    );

    if (facts.session) {
      lines.push(
        '会话：available=' +
          facts.session.available +
          ' ok=' +
          facts.session.ok +
          ' token=' +
          facts.session.tokenMasked +
          ' 学号=' +
          facts.session.studentCodeMasked +
          ' 批次=' +
          facts.session.electiveBatchCodeMasked +
          ' 学期=' +
          (facts.session.schoolTerm || '(无)') +
          (facts.session.missing.length ? ' 缺少=' + facts.session.missing.join('/') : '')
      );
    }
    lines.push('提示：' + facts.note);
    return lines.join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
