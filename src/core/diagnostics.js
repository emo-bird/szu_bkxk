/**
 * 诊断文本生成：把"采集到的课程 / 原始响应样本 / 冲突"整理成**可直接复制回传**的纯文本。
 *
 * 【为什么需要】沙箱里跑不了浏览器，很多事实（真实字段名、响应结构、DOM）只能由用户在真机取回。
 * 本模块把取回这件事做得尽量省事：点一下按钮就得到一段结构化文本。
 *
 * 【纯函数】不碰 DOM、不碰网络，可完全离线单测。
 *
 * 依赖：NS.model / NS.time / NS.conflict（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var D = (NS.diagnostics = NS.diagnostics || {});

  /** 默认最多列出多少条课程。 */
  D.DEFAULT_COURSE_LIMIT = 80;

  /** 两位补零。 */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 格式化时间戳为 `YYYY-MM-DD HH:MM:SS`；无值返回占位。 */
  D.formatTime = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '(无)';
    var d = new Date(ms);
    return (
      d.getFullYear() +
      '-' +
      pad2(d.getMonth() + 1) +
      '-' +
      pad2(d.getDate()) +
      ' ' +
      pad2(d.getHours()) +
      ':' +
      pad2(d.getMinutes()) +
      ':' +
      pad2(d.getSeconds())
    );
  };

  /** 一条记录的简短标记集合。 */
  D.flagsOf = function (record, conflictCount) {
    var flags = [];
    if (!record) return flags;
    if (record.isMooc) flags.push('MOOC');
    var seat = NS.model ? NS.model.hasFreeSeat(record) : null;
    if (seat === true) flags.push('有余量');
    else if (seat === false) flags.push('已满');
    else flags.push('余量未知');
    if (record.isChoose) flags.push('已选');
    if (record.isConflict) flags.push('站点冲突标记');
    if (conflictCount > 0) flags.push('与自定义课程冲突×' + conflictCount);
    return flags;
  };

  /**
   * 生成课程数据诊断文本。
   * @param {object} options
   * @param {object[]} [options.records] 课程记录
   * @param {object[]} [options.customCourses] 自定义课程
   * @param {number} [options.updatedAt] 缓存更新时间
   * @param {number} [options.limit] 最多列出条数
   * @param {number} [options.now] 生成时间（单测注入）
   * @returns {string} 多行文本
   */
  D.buildCourseDigest = function (options) {
    var o = options || {};
    var records = Array.isArray(o.records) ? o.records : [];
    var customs = o.customCourses || [];
    var limit = typeof o.limit === 'number' ? o.limit : D.DEFAULT_COURSE_LIMIT;

    var lines = [];
    lines.push('深大选课辅助 · 课程数据诊断');
    lines.push('生成时间：' + D.formatTime(typeof o.now === 'number' ? o.now : Date.now()));
    lines.push('课程记录：' + records.length + ' 条（缓存更新时间 ' + D.formatTime(o.updatedAt) + '）');
    lines.push('自定义课程：' + customs.length + ' 门');

    // 名额分布是最能看出"字段解析对不对"的信号：
    // 若"未知"占了绝大多数，说明站点字段名变了（或余量字段仍为 null），需要排查。
    if (NS.query) {
      try {
        var stats = NS.query.stats(records);
        lines.push(
          '名额分布：有余量 ' +
            stats.free +
            ' / 已满 ' +
            stats.full +
            ' / 未知 ' +
            stats.unknown +
            '；MOOC ' +
            stats.mooc +
            '；收藏 ' +
            stats.favorite +
            '；类别分布 ' +
            JSON.stringify(stats.byCategory)
        );
      } catch (e) {
        lines.push('名额统计失败：' + ((e && e.message) || e));
      }
    }

    var report = null;
    if (NS.conflict) {
      try {
        report = NS.conflict.analyze({ siteRecords: records, customCourses: customs });
        lines.push(NS.conflict.summarize(report));
      } catch (e) {
        lines.push('冲突分析失败：' + ((e && e.message) || e));
      }
    }

    // 课表布局摘要：能反映自定义课程的时间有没有解析成正确的星期/节次
    if (NS.timetable && customs.length > 0) {
      try {
        var layout = NS.timetable.buildLayout(NS.timetable.entriesFromCustomCourses(customs, report));
        lines.push(NS.timetable.summarize(layout));
      } catch (e) {
        lines.push('课表布局失败：' + ((e && e.message) || e));
      }
    }

    if (records.length === 0) {
      lines.push('（还没有采集到课程数据：请在选课页浏览/查询课程后再复制）');
      return lines.join('\n');
    }

    lines.push('---');
    var shown = Math.min(records.length, limit);
    for (var i = 0; i < shown; i++) {
      var r = records[i];
      var id = r.teachingClassId || '(无ID)';
      var conflicts = report && report.bySiteId && r.teachingClassId ? (report.bySiteId[r.teachingClassId] || []).length : 0;
      lines.push(
        '[' +
          (i + 1) +
          '] ' +
          (r.courseName || '(无课程名)') +
          ' | 教学班 ' +
          id +
          ' | 教师 ' +
          (r.teacherName || '—') +
          ' | 课程号 ' +
          (r.courseNumber || '—') +
          ' | 类别 ' +
          (r.teachingClassType || '—')
      );
      lines.push(
        '     时间 ' +
          (NS.time ? NS.time.formatSessions(r.sessions) || (r.teachingPlace || '—') : r.teachingPlace || '—') +
          ' | 容量 ' +
          (r.classCapacity === null || r.classCapacity === undefined ? '—' : r.classCapacity) +
          ' / 已选 ' +
          (r.selectedCount === null || r.selectedCount === undefined ? '—' : r.selectedCount)
      );
      lines.push('     标记 ' + D.flagsOf(r, conflicts).join('、'));
    }
    if (records.length > shown) {
      lines.push('… 另有 ' + (records.length - shown) + ' 条未列出');
    }
    return lines.join('\n');
  };

  /**
   * 生成原始响应样本文本（回传给我看真实字段名/结构用）。
   * @param {object[]} samples NS.capture 句柄的 samples()
   * @param {object} [options] {now, textLimit}
   * @returns {string} 多行文本
   */
  D.buildSampleDigest = function (samples, options) {
    var o = options || {};
    var list = Array.isArray(samples) ? samples : [];
    var textLimit = typeof o.textLimit === 'number' ? o.textLimit : 4000;
    var lines = [];
    lines.push('深大选课辅助 · 原始响应样本');
    lines.push('生成时间：' + D.formatTime(typeof o.now === 'number' ? o.now : Date.now()));
    lines.push('样本数：' + list.length);
    if (list.length === 0) {
      lines.push('（暂无样本：请在选课页查询课程后再复制）');
      return lines.join('\n');
    }
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      lines.push('---');
      lines.push('样本 ' + (i + 1) + '｜来源 ' + (s.source || '?') + '｜原始长度 ' + (s.length || 0));
      lines.push('地址：' + (s.url || '—'));
      var text = typeof s.text === 'string' ? s.text : '';
      if (text.length > textLimit) text = text.slice(0, textLimit) + '…（诊断输出再截断）';
      lines.push('响应原文：');
      lines.push(text);
    }
    return lines.join('\n');
  };

  /**
   * 生成"环境 + 课程 + 样本"的完整回传包（一个按钮复制全部）。
   * @param {object} options
   * @param {object} [options.envFacts] NS.ui.recon.collect() 的结果
   * @param {string} [options.envText] 已格式化的环境文本（优先）
   * @param {number} [options.version] 脚本版本
   * @returns {string}
   */
  D.buildFullReport = function (options) {
    var o = options || {};
    var lines = [];
    lines.push('================ 深大选课辅助 · 诊断回传包 ================');
    lines.push('脚本版本：' + (o.version || '(未知)'));
    lines.push('');
    lines.push('====== 零、页内自检 ======');
    lines.push(o.selfTestText || '(未运行)');
    lines.push('');
    lines.push('====== 一、环境侦察 ======');
    lines.push(o.envText || '(无)');
    lines.push('');
    lines.push('====== 二、课程数据 ======');
    lines.push(o.courseText || '(无)');
    lines.push('');
    lines.push('====== 三、原始响应样本 ======');
    lines.push(o.sampleText || '(无)');
    return lines.join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
