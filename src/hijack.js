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
