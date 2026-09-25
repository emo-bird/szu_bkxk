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
