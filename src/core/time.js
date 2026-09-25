/**
 * 教学时间解析与冲突计算（M4 的基础，纯函数、可完全离线单测）。
 *
 * 【要解析什么】站点字段 `teachingPlace`，形如：
 *   `5-18周 星期二 3-4节 致理楼L1-707`
 * 实际会遇到的变体（每一条都有单测）：
 *   - 单/双周：`1-16周单周 星期三 5-6节`
 *   - 连堂 / 多节次：`3-4节`、`3节`、`1-2,5-6节`（后者拆成两段）
 *   - 一门课**多段**时间（同一字符串里出现多次"x周"）
 *   - 全角数字 / 全角标点 / 中文顿号
 *   - `teachingPlace` 为 `null`（MOOC / 网络课程，属正常）
 *   - 缺周次（只有"星期二 3-4节"）→ 用 1..18 兜底并置 assumedWeeks=true
 *
 * 【冲突怎么算】把站点课程与自定义课程**归一到同一 session 结构**后两两判定：
 *   星期相同 && 周次区间有交集 && 节次区间有交集 && 单双周不互斥。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var TI = (NS.time = NS.time || {});

  /** 星期几：1=周一 … 7=周日。 */
  TI.WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  TI.WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /** 单双周。 */
  TI.PARITY = { ALL: 'all', ODD: 'odd', EVEN: 'even' };

  /** 缺周次时的兜底周末（多数课程的学期跨度）。 */
  TI.DEFAULT_WEEK_END = 18;

  /** 全角 → 半角（数字、逗号、空格、破折号、括号、分号）。 */
  function toHalfWidth(input) {
    return String(input)
      .replace(/[\uFF10-\uFF19]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      })
      .replace(/\uFF0C/g, ',')
      .replace(/\u3001/g, ',')
      .replace(/\uFF1B/g, ';')
      .replace(/\u3000/g, ' ')
      .replace(/\uFF0D/g, '-')
      .replace(/\uFF08/g, '(')
      .replace(/\uFF09/g, ')');
  }

  /**
   * 解析节次串，如 `1-2,5-6` → [{start:1,end:2},{start:5,end:6}]。
   * @param {string} text 节次串（不含"节"字）
   * @returns {{start:number,end:number}[]} 节次区间数组
   */
  TI.parsePeriods = function (text) {
    var out = [];
    if (!text) return out;
    var parts = String(text).split(/[,，]/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var m = /^(\d+)\s*(?:[-~至]\s*(\d+))?$/.exec(p);
      if (!m) continue;
      var a = Number(m[1]);
      var b = m[2] ? Number(m[2]) : a;
      if (!isFinite(a) || !isFinite(b)) continue;
      if (a > b) {
        var t = a;
        a = b;
        b = t;
      }
      out.push({ start: a, end: b });
    }
    return out;
  };

  /**
   * 解析一段连续课程时间（可能含多段），得到若干 session。
   * @param {*} text 原始时间串
   * @returns {{ok:boolean, sessions:object[], place:string, assumedWeeks:boolean, raw:string}}
   */
  TI.parseTeachingPlace = function (text) {
    var raw = text === undefined || text === null ? '' : String(text);
    var out = { ok: false, sessions: [], place: '', assumedWeeks: false, raw: raw };
    if (!raw.trim()) return out;

    var s = toHalfWidth(raw);

    // 以"x-y周"为界切分多段课程时间
    var weekRe = /(\d+)\s*(?:[-~至]\s*(\d+))?\s*周/g;
    var heads = [];
    var m;
    while ((m = weekRe.exec(s)) !== null) {
      heads.push({
        index: m.index,
        a: Number(m[1]),
        b: m[2] ? Number(m[2]) : Number(m[1]),
      });
    }

    var chunks;
    if (heads.length === 0) {
      // 没有周次信息：整串当作一段，周次用兜底范围
      chunks = [{ text: s, weekStart: 1, weekEnd: TI.DEFAULT_WEEK_END }];
      out.assumedWeeks = true;
    } else {
      chunks = [];
      for (var i = 0; i < heads.length; i++) {
        var end = i + 1 < heads.length ? heads[i + 1].index : s.length;
        chunks.push({ text: s.slice(heads[i].index, end), weekStart: heads[i].a, weekEnd: heads[i].b });
      }
    }

    var places = [];
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      var piece = chunk.text;

      var parity = TI.PARITY.ALL;
      if (/单/.test(piece)) parity = TI.PARITY.ODD;
      else if (/双/.test(piece)) parity = TI.PARITY.EVEN;

      var wdMatch = /(?:星期|周)\s*([一二三四五六日天])/.exec(piece);
      if (!wdMatch) continue; // 没有星期几就无法参与冲突计算
      var weekday = TI.WEEKDAY_MAP[wdMatch[1]];

      var periodMatch = /([\d,\s\-~至]+)节/.exec(piece);
      if (!periodMatch) continue;
      var groups = TI.parsePeriods(periodMatch[1]);
      if (groups.length === 0) continue;

      var place = piece
        .replace(/^\s*\d+\s*(?:[-~至]\s*\d+)?\s*周\s*/, '')
        .replace(/[单双]\s*周\s*/g, ' ') // "单周/双周" 整体去掉，别把"周"字漏进地点
        .replace(/\(\s*[单双]\s*\)/g, ' ')
        .replace(/(?:星期|周)\s*[一二三四五六日天]/g, ' ')
        .replace(/[\d,\s\-~至]+节/g, ' ')
        .replace(/[;；,，、]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (place) places.push(place);

      for (var g = 0; g < groups.length; g++) {
        out.sessions.push({
          weekStart: chunk.weekStart,
          weekEnd: chunk.weekEnd,
          weekParity: parity,
          weekday: weekday,
          periodStart: groups[g].start,
          periodEnd: groups[g].end,
          place: place,
        });
      }
    }

    out.place = places.join('; ');
    out.ok = out.sessions.length > 0;
    return out;
  };

  /**
   * 归一化一个 session（存储 / 冲突计算都走这里，保证结构一致）。
   * @param {object} raw 原始 session
   * @returns {(object|null)} 归一化 session；星期或节次非法时返回 null
   */
  TI.normalizeSession = function (raw) {
    if (!raw || typeof raw !== 'object') return null;
    var weekday = Number(raw.weekday);
    if (!(weekday >= 1 && weekday <= 7)) return null;
    var periodStart = Number(raw.periodStart);
    if (!isFinite(periodStart) || periodStart < 1) return null;
    var periodEnd = Number(raw.periodEnd);
    if (!isFinite(periodEnd) || periodEnd < periodStart) periodEnd = periodStart;

    var weekStart = Number(raw.weekStart);
    if (!isFinite(weekStart) || weekStart < 1) weekStart = 1;
    var weekEnd = Number(raw.weekEnd);
    if (!isFinite(weekEnd) || weekEnd < weekStart) weekEnd = TI.DEFAULT_WEEK_END;

    var parity =
      raw.weekParity === TI.PARITY.ODD || raw.weekParity === TI.PARITY.EVEN ? raw.weekParity : TI.PARITY.ALL;

    return {
      weekStart: Math.floor(weekStart),
      weekEnd: Math.floor(weekEnd),
      weekParity: parity,
      weekday: Math.floor(weekday),
      periodStart: Math.floor(periodStart),
      periodEnd: Math.floor(periodEnd),
      place: raw.place ? String(raw.place) : '',
    };
  };

  /** 归一化 session 数组（丢弃非法项）。 */
  TI.normalizeSessions = function (list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = TI.normalizeSession(list[i]);
      if (s) out.push(s);
    }
    return out;
  };

  /** 两个单双周是否能同时成立；odd × even 互斥返回 null。 */
  TI.combinedParity = function (p1, p2) {
    var ALL = TI.PARITY.ALL;
    if (p1 === p2) return p1;
    if (p1 === ALL) return p2;
    if (p2 === ALL) return p1;
    return null; // odd vs even
  };

  /** 周次区间交集；无交集返回 null。 */
  TI.weekIntersection = function (a, b) {
    var lo = Math.max(a.weekStart, b.weekStart);
    var hi = Math.min(a.weekEnd, b.weekEnd);
    return lo <= hi ? { lo: lo, hi: hi } : null;
  };

  /**
   * 区间 [lo,hi] 内是否存在符合单双周的周次。
   * @param {number} lo 起始周
   * @param {number} hi 结束周
   * @param {string} parity 单双周（all/odd/even）
   * @returns {boolean}
   */
  TI.weekRangeHasParity = function (lo, hi, parity) {
    if (lo > hi) return false;
    if (parity === TI.PARITY.ALL) return true;
    var wantOdd = parity === TI.PARITY.ODD;
    var firstOdd = lo % 2 === 1 ? lo : lo + 1;
    var firstEven = lo % 2 === 0 ? lo : lo + 1;
    return (wantOdd ? firstOdd : firstEven) <= hi;
  };

  /**
   * 两个 session 是否冲突。
   * @param {object} a session
   * @param {object} b session
   * @returns {boolean}
   */
  TI.sessionsOverlap = function (a, b) {
    var x = TI.normalizeSession(a);
    var y = TI.normalizeSession(b);
    if (!x || !y) return false;
    if (x.weekday !== y.weekday) return false;
    // 节次区间相交
    if (x.periodStart > y.periodEnd || y.periodStart > x.periodEnd) return false;
    var inter = TI.weekIntersection(x, y);
    if (!inter) return false;
    var parity = TI.combinedParity(x.weekParity, y.weekParity);
    if (!parity) return false;
    return TI.weekRangeHasParity(inter.lo, inter.hi, parity);
  };

  /**
   * 找出两组 session 之间所有冲突对。
   * @param {object[]} listA 第一组
   * @param {object[]} listB 第二组（传同一组即为"自冲突检测"）
   * @returns {{a:object, b:object, indexA:number, indexB:number}[]}
   */
  TI.findConflictPairs = function (listA, listB) {
    var A = TI.normalizeSessions(listA);
    var B = TI.normalizeSessions(listB);
    // 用**入参**判断是不是自比较：归一化会生成新数组，比较 A===B 永远为 false
    var selfCompare = listA === listB;
    var out = [];
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < B.length; j++) {
        // 自比较时跳过自身与重复对
        if (selfCompare && i >= j) continue;
        if (TI.sessionsOverlap(A[i], B[j])) out.push({ a: A[i], b: B[j], indexA: i, indexB: j });
      }
    }
    return out;
  };

  /** 任取一个 session 与一组 session 是否冲突。 */
  TI.conflictsWithAny = function (session, list) {
    return TI.findConflictPairs([session], list).length > 0;
  };

  /**
   * 把一个 session 渲染成可读文本，如 `5-18周 周二 3-4节`。
   * @param {object} raw session
   * @returns {string}
   */
  TI.formatSession = function (raw) {
    var s = TI.normalizeSession(raw);
    if (!s) return '(无法解析)';
    var week = s.weekStart === s.weekEnd ? s.weekStart + '周' : s.weekStart + '-' + s.weekEnd + '周';
    var parity = s.weekParity === TI.PARITY.ODD ? '单' : s.weekParity === TI.PARITY.EVEN ? '双' : '';
    var period =
      s.periodStart === s.periodEnd ? s.periodStart + '节' : s.periodStart + '-' + s.periodEnd + '节';
    return week + parity + ' ' + (TI.WEEKDAY_LABEL[s.weekday] || '') + ' ' + period;
  };

  /** 渲染一组 session。 */
  TI.formatSessions = function (list) {
    var arr = TI.normalizeSessions(list);
    if (arr.length === 0) return '';
    var parts = [];
    for (var i = 0; i < arr.length; i++) parts.push(TI.formatSession(arr[i]));
    return parts.join('; ');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
