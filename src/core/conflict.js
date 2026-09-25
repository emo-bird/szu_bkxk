/**
 * 冲突分析：把**站点课程**、**自定义课程**放在同一套 session 结构下两两比对。
 *
 * 【为什么要单独一层】M4 的需求是"自定义课程要计入冲突计算"，而站点的课程时间来自
 * 被动采集（可能晚到、可能多次追加）。把"采集"与"判定"解耦，UI 每次刷新重新分析即可。
 *
 * 【两种关系】
 *   - 自定义 × 站点：用户最关心（"我加的这门课跟已选/备选的课撞不撞"）
 *   - 自定义 × 自定义：用户手工添加的课彼此撞车
 *   另附 `bySiteId` 反向索引，供 M3 在课程卡片上标"与自定义课程冲突"。
 *
 * 依赖：NS.time / NS.customCourse（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var CF = (NS.conflict = NS.conflict || {});

  /**
   * 取出一条记录的 session 列表：优先用已解析的，否则现场解析 teachingPlace。
   * @param {object} record 统一课程记录
   * @returns {object[]} session 数组
   */
  CF.sessionsOf = function (record) {
    if (!record) return [];
    if (Array.isArray(record.sessions) && record.sessions.length > 0) {
      return NS.time.normalizeSessions(record.sessions);
    }
    return NS.time.parseTeachingPlace(record.teachingPlace).sessions;
  };

  /**
   * 分析冲突。
   * @param {object} options
   * @param {object[]} [options.siteRecords] 站点课程记录（来自被动采集）
   * @param {object[]} [options.customCourses] 自定义课程
   * @returns {{
   *   byCustomId: object, bySiteId: object,
   *   totals: {customWithSite:number, customWithCustom:number}
   * }}
   */
  CF.analyze = function (options) {
    var opts = options || {};
    var siteRecords = Array.isArray(opts.siteRecords) ? opts.siteRecords : [];
    var customs = NS.customCourse.normalizeList(opts.customCourses);

    var byCustomId = {};
    var bySiteId = {};
    var totals = { customWithSite: 0, customWithCustom: 0 };

    customs.forEach(function (c) {
      byCustomId[c.id] = { withSite: [], withCustom: [], total: 0 };
    });

    // ---- 自定义 × 站点 ----
    siteRecords.forEach(function (record) {
      var siteSessions = CF.sessionsOf(record);
      if (siteSessions.length === 0) return;
      customs.forEach(function (c) {
        var pairs = NS.time.findConflictPairs(c.sessions, siteSessions);
        if (pairs.length === 0) return;
        byCustomId[c.id].withSite.push({
          teachingClassId: record.teachingClassId || null,
          courseName: record.courseName || null,
          teacherName: record.teacherName || null,
          timeText: NS.time.formatSessions(siteSessions),
        });
        totals.customWithSite += 1;
        if (record.teachingClassId) {
          if (!bySiteId[record.teachingClassId]) bySiteId[record.teachingClassId] = [];
          bySiteId[record.teachingClassId].push({
            customId: c.id,
            customName: c.name || '(未命名)',
          });
        }
      });
    });

    // ---- 自定义 × 自定义 ----
    for (var i = 0; i < customs.length; i++) {
      for (var j = i + 1; j < customs.length; j++) {
        var pairs2 = NS.time.findConflictPairs(customs[i].sessions, customs[j].sessions);
        if (pairs2.length === 0) continue;
        byCustomId[customs[i].id].withCustom.push({
          id: customs[j].id,
          name: customs[j].name || '(未命名)',
          timeText: NS.time.formatSessions(customs[j].sessions),
        });
        byCustomId[customs[j].id].withCustom.push({
          id: customs[i].id,
          name: customs[i].name || '(未命名)',
          timeText: NS.time.formatSessions(customs[i].sessions),
        });
        totals.customWithCustom += 1;
      }
    }

    Object.keys(byCustomId).forEach(function (id) {
      var entry = byCustomId[id];
      entry.total = entry.withSite.length + entry.withCustom.length;
    });

    return { byCustomId: byCustomId, bySiteId: bySiteId, totals: totals };
  };

  /**
   * 站点课程之间的冲突（M3 用来在列表上标"与其它课程时间冲突"）。
   * @param {object[]} records 站点课程记录
   * @param {object} [options] {limit} 最多返回多少对，默认 200（避免大列表卡顿）
   * @returns {{a:object, b:object}[]} 冲突对
   */
  CF.findSiteConflicts = function (records, options) {
    var list = Array.isArray(records) ? records : [];
    var limit = options && typeof options.limit === 'number' ? options.limit : 200;
    var withSessions = [];
    for (var i = 0; i < list.length; i++) {
      var sessions = CF.sessionsOf(list[i]);
      if (sessions.length > 0) withSessions.push({ record: list[i], sessions: sessions });
    }
    var out = [];
    for (var a = 0; a < withSessions.length && out.length < limit; a++) {
      for (var b = a + 1; b < withSessions.length && out.length < limit; b++) {
        if (NS.time.findConflictPairs(withSessions[a].sessions, withSessions[b].sessions).length > 0) {
          out.push({ a: withSessions[a].record, b: withSessions[b].record });
        }
      }
    }
    return out;
  };

  /**
   * 给某条站点记录找出与它冲突的自定义课程（M3 卡片标记用）。
   * @param {object} record 站点记录
   * @param {object} report CF.analyze() 的报告
   * @returns {object[]} [{customId, customName}]
   */
  CF.conflictsOfSiteRecord = function (record, report) {
    if (!record || !record.teachingClassId || !report || !report.bySiteId) return [];
    return report.bySiteId[record.teachingClassId] || [];
  };

  /**
   * 生成一行可读汇总（日志/面板用）。
   * @param {object} report CF.analyze() 的报告
   * @returns {string}
   */
  CF.summarize = function (report) {
    if (!report || !report.totals) return '无冲突数据';
    var t = report.totals;
    var customCount = Object.keys(report.byCustomId || {}).length;
    return (
      '冲突分析：自定义课程 ' +
      customCount +
      ' 门；与站点课程冲突 ' +
      t.customWithSite +
      ' 处，自定义课程之间 ' +
      t.customWithCustom +
      ' 处'
    );
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
