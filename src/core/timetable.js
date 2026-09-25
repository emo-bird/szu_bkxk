/**
 * 课表布局引擎：把课程时间（session）算成"格子坐标 + 泳道"。
 *
 * 【为什么先做这个】M4 的课表注入卡在"课表页 DOM 未知"。但注入真正的难点不是 DOM，
 * 而是**排布**：同一格要放多门课（冲突）、跨节次的课要占多行、相邻课不能霸占多余列。
 * 这些是纯算法，与站点用 `<table>` 还是绝对定位渲染无关。
 *
 * 因此本模块只输出**与渲染方式无关的布局**：
 *   - `placements[]`：每门课在第几天、第几节到第几节、第几泳道（lane）、该组共几泳道（lanes）；
 *   - `slotMatrix`：天 × 节的二维槽位表，方便用表格渲染；
 *   - placements 也能直接驱动绝对定位渲染（left = lane/lanes，top = startPeriod）。
 *
 * 【泳道规则】重叠的课并排显示；**只有相互重叠的一组**才会分出多泳道，
 * 互不重叠的课共用第 0 泳道 —— 否则整天的课都会被挤成窄条。
 *
 * 【边界】超出网格范围的星期（例如只显示 5 天而课在周日）与越界节次一律裁剪或跳过，
 * 绝不抛出异常。
 *
 * 依赖：NS.time / NS.customCourse / NS.conflict（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var TT = (NS.timetable = NS.timetable || {});

  TT.DEFAULT_DAYS = 7;
  TT.DEFAULT_PERIODS = 14;
  TT.MAX_DAYS = 7;
  TT.MAX_PERIODS = 24;

  /** 两组块在节次上是否重叠。 */
  function overlaps(a, b) {
    return a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod;
  }

  /**
   * 给"同一天"的块分配泳道。
   * 贪心：按开始节次排序，放进第一条"上一门课已经结束"的泳道。
   * 然后用**连通重叠组**内的最大泳道号 +1 作为该组的列数。
   * @param {object[]} dayBlocks 同一天的块（会被就地修改 lane/lanes）
   */
  function assignLanes(dayBlocks) {
    dayBlocks.sort(function (a, b) {
      return a.startPeriod - b.startPeriod || a.endPeriod - b.endPeriod || a.order - b.order;
    });

    var laneEnds = []; // 每条泳道已占用的最大结束节次
    dayBlocks.forEach(function (b) {
      var lane = -1;
      for (var i = 0; i < laneEnds.length; i++) {
        if (laneEnds[i] < b.startPeriod) {
          lane = i; // 相邻但不重叠（上节课 4 节结束、本节课 5 节开始）可以共用泳道
          break;
        }
      }
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = b.endPeriod;
      b.lane = lane;
    });

    // 只有互相重叠的块才需要并排；用连通组的最大泳道号决定列数
    dayBlocks.forEach(function (b) {
      var maxLane = b.lane;
      for (var i = 0; i < dayBlocks.length; i++) {
        var other = dayBlocks[i];
        if (other === b) continue;
        if (overlaps(b, other) && other.lane > maxLane) maxLane = other.lane;
      }
      b.lanes = maxLane + 1;
    });
  }

  /**
   * 计算布局。
   * @param {object[]} entries 条目 [{id, kind, title, subtitle, color, sessions, place, conflicts}]
   * @param {object} [options] {days, periods}
   * @returns {{days:number, periods:number, placements:object[], skipped:number, maxLanes:number}}
   */
  TT.buildLayout = function (entries, options) {
    var o = options || {};
    var days = NS.util.clamp(o.days, 1, TT.MAX_DAYS, TT.DEFAULT_DAYS);
    var periods = NS.util.clamp(o.periods, 1, TT.MAX_PERIODS, TT.DEFAULT_PERIODS);
    var list = Array.isArray(entries) ? entries : [];

    var blocks = [];
    var skipped = 0;
    var order = 0;

    list.forEach(function (entry) {
      if (!entry) return;
      var sessions = NS.time.normalizeSessions(entry.sessions);
      sessions.forEach(function (s) {
        if (s.weekday < 1 || s.weekday > days) {
          skipped += 1; // 网格外的星期：跳过（例如只排 5 天而课在周日）
          return;
        }
        var start = Math.max(1, s.periodStart);
        var end = Math.min(periods, s.periodEnd);
        if (start > periods || end < start) {
          skipped += 1;
          return;
        }
        blocks.push({
          entry: entry,
          session: s,
          day: s.weekday,
          startPeriod: start,
          endPeriod: end,
          lane: 0,
          lanes: 1,
          order: order++,
        });
      });
    });

    // 按天分组分配泳道
    var byDay = {};
    blocks.forEach(function (b) {
      if (!byDay[b.day]) byDay[b.day] = [];
      byDay[b.day].push(b);
    });
    Object.keys(byDay).forEach(function (day) {
      assignLanes(byDay[day]);
    });

    var placements = blocks
      .map(function (b) {
        return {
          entryId: b.entry.id || null,
          kind: b.entry.kind || 'custom',
          title: b.entry.title || '(未命名)',
          subtitle: b.entry.subtitle || '',
          color: b.entry.color || null,
          place: b.session.place || b.entry.place || '',
          sessionText: NS.time.formatSession(b.session),
          day: b.day,
          startPeriod: b.startPeriod,
          endPeriod: b.endPeriod,
          lane: b.lane,
          lanes: b.lanes,
          conflicts: b.entry.conflicts || 0,
        };
      })
      .sort(function (a, b) {
        return a.day - b.day || a.lane - b.lane || a.startPeriod - b.startPeriod;
      });

    var maxLanes = 1;
    placements.forEach(function (p) {
      if (p.lanes > maxLanes) maxLanes = p.lanes;
    });

    return { days: days, periods: periods, placements: placements, skipped: skipped, maxLanes: maxLanes };
  };

  /**
   * 生成 天 × 节 的二维槽位表（用表格渲染时直接取用）。
   * 下标：`matrix[day][period]`，day 从 1 开始、period 从 1 开始；`matrix[0]` 未使用。
   * @param {object} layout TT.buildLayout() 的结果
   * @returns {object[][]} 二维数组，元素是 placements 的子集
   */
  TT.slotMatrix = function (layout) {
    var days = layout ? layout.days : 0;
    var periods = layout ? layout.periods : 0;
    var matrix = [];
    for (var d = 0; d <= days; d++) {
      matrix[d] = [];
      for (var p = 0; p <= periods; p++) matrix[d][p] = [];
    }
    if (!layout || !Array.isArray(layout.placements)) return matrix;
    layout.placements.forEach(function (pl) {
      for (var p = pl.startPeriod; p <= pl.endPeriod; p++) {
        if (matrix[pl.day] && matrix[pl.day][p]) matrix[pl.day][p].push(pl);
      }
    });
    return matrix;
  };

  /**
   * 自定义课程 → 布局条目。
   * @param {object[]} courses 自定义课程
   * @param {object} [report] NS.conflict.analyze() 的结果（用于冲突数）
   * @returns {object[]} entries
   */
  TT.entriesFromCustomCourses = function (courses, report) {
    var list = NS.customCourse.normalizeList(courses);
    return list.map(function (c) {
      var entry = report && report.byCustomId ? report.byCustomId[c.id] : null;
      var conflicts = entry ? entry.withSite.length + entry.withCustom.length : 0;
      return {
        id: c.id,
        kind: 'custom',
        title: c.name || '(未命名)',
        subtitle: c.teacher || '',
        color: c.color,
        place: c.place,
        sessions: c.sessions,
        conflicts: conflicts,
      };
    });
  };

  /**
   * 站点课程 → 布局条目。
   * @param {object[]} records 课程记录
   * @param {object} [report] NS.conflict.analyze() 的结果
   * @returns {object[]} entries
   */
  TT.entriesFromSiteRecords = function (records, report) {
    var list = Array.isArray(records) ? records : [];
    var out = [];
    list.forEach(function (r) {
      if (!r) return;
      var sessions = NS.conflict ? NS.conflict.sessionsOf(r) : r.sessions || [];
      if (!sessions.length) return; // 没时间的（MOOC 等）进不了课表
      var rev = report && report.bySiteId && r.teachingClassId ? report.bySiteId[r.teachingClassId] : null;
      out.push({
        id: 'site:' + (r.teachingClassId || r.courseNumber || ''),
        kind: 'site',
        title: r.courseName || '(无课程名)',
        subtitle: r.teacherName || '',
        color: null,
        place: r.timePlace || '',
        sessions: sessions,
        conflicts: rev ? rev.length : 0,
      });
    });
    return out;
  };

  /**
   * 汇总布局（日志/诊断用）。
   * @param {object} layout TT.buildLayout() 的结果
   * @returns {string}
   */
  TT.summarize = function (layout) {
    if (!layout) return '(无布局)';
    var custom = 0;
    var site = 0;
    layout.placements.forEach(function (p) {
      if (p.kind === 'site') site += 1;
      else custom += 1;
    });
    return (
      '课表布局：' +
      layout.days +
      ' 天 × ' +
      layout.periods +
      ' 节；自定义课块 ' +
      custom +
      ' 个、站点课块 ' +
      site +
      ' 个；最大并排 ' +
      layout.maxLanes +
      ' 列' +
      (layout.skipped ? '；超出网格被跳过 ' + layout.skipped + ' 个' : '')
    );
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
