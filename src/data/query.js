/**
 * 课程检索层：筛选、排序、关键词匹配、统计汇总。
 *
 * 【为什么先做这个】M3 的**视觉方案**还没定（由用户提供），但无论最终怎么呈现，
 * "按余量排序""只看有余量""按时间排""搜课程名"这些**操作**都是必需的。
 * 把操作做成纯函数，等方案来了只需接一层渲染，不用重写逻辑。
 *
 * 【设计要点】
 *   - 全部纯函数，不碰 DOM、不碰网络，可完全离线单测；
 *   - 排序**稳定的**：同值保持原有相对顺序；
 *   - **取不到的字段（null）恒排最后**，无论升降序 —— 否则"余量未知"会混进最前面误导用户；
 *   - 中文按 `localeCompare('zh-Hans-CN')` 排序，而不是按 Unicode 码位。
 *
 * 依赖：NS.model / NS.conflict（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var Q = (NS.query = NS.query || {});

  /** 关键词匹配会覆盖的字段。 */
  Q.KEYWORD_FIELDS = [
    'courseName',
    'teacherName',
    'courseNumber',
    'courseTotalNumber',
    'teachingClassId',
    'departmentName',
    'campusName',
  ];

  /** 支持的排序键。 */
  Q.SORT_KEYS = ['default', 'name', 'teacher', 'remain', 'capacity', 'time', 'department'];

  /**
   * 关键词是否命中该记录（大小写不敏感，覆盖多个字段）。
   * @param {object} record 课程记录
   * @param {string} keyword 关键词
   * @returns {boolean}
   */
  Q.matchKeyword = function (record, keyword) {
    var kw = keyword === undefined || keyword === null ? '' : String(keyword).trim().toLowerCase();
    if (kw === '') return true;
    if (!record) return false;
    for (var i = 0; i < Q.KEYWORD_FIELDS.length; i++) {
      var v = record[Q.KEYWORD_FIELDS[i]];
      if (v !== null && v !== undefined && String(v).toLowerCase().indexOf(kw) !== -1) return true;
    }
    return false;
  };

  /** 子串匹配（空条件视为通过）。 */
  function contains(value, needle) {
    if (needle === undefined || needle === null || needle === '') return true;
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;
  }

  /** 取出记录的 session（优先已解析的）。 */
  function sessionsOf(record) {
    if (NS.conflict) return NS.conflict.sessionsOf(record);
    return (record && Array.isArray(record.sessions) && record.sessions) || [];
  }

  /**
   * 按条件筛选。
   * @param {object[]} records 课程记录
   * @param {object} [criteria] 条件（未给的项视为不过滤）
   * @param {string} [criteria.keyword] 关键词
   * @param {string} [criteria.category] 类别代码（FANKC/XGXK…）
   * @param {string} [criteria.nature] 课程性质子串
   * @param {string} [criteria.department] 开课单位子串
   * @param {boolean} [criteria.onlyFree] 只看确定有余量的
   * @param {boolean} [criteria.excludeMooc] 排除慕课
   * @param {boolean} [criteria.onlyMooc] 只看慕课
   * @param {boolean} [criteria.onlyFavorite] 只看收藏
   * @param {boolean} [criteria.onlyConflict] 只看站点标记为冲突的
   * @param {number} [criteria.weekday] 只看某天（1=周一…7=周日）有课的
   * @param {string[]} [criteria.customConflictIds] 只看与这些自定义课程冲突的教学班
   * @returns {object[]} 筛选结果（新数组）
   */
  Q.filter = function (records, criteria) {
    var list = Array.isArray(records) ? records : [];
    var c = criteria || {};

    var conflictSet = null;
    if (c.customConflictIds) {
      conflictSet = {};
      var ids = Array.isArray(c.customConflictIds) ? c.customConflictIds : [];
      for (var i = 0; i < ids.length; i++) conflictSet[String(ids[i])] = true;
    }

    return list.filter(function (r) {
      if (!r) return false;
      if (!Q.matchKeyword(r, c.keyword)) return false;
      if (c.category && String(r.teachingClassType || '') !== String(c.category)) return false;
      if (!contains(r.courseNatureName, c.nature)) return false;
      if (!contains(r.departmentName, c.department)) return false;
      if (c.excludeMooc === true && r.isMooc === true) return false;
      if (c.onlyMooc === true && r.isMooc !== true) return false;
      if (c.onlyFavorite === true && r.isFavorite !== true) return false;
      if (c.onlyConflict === true && r.isConflict !== true) return false;
      if (c.onlyFree === true && NS.model.hasFreeSeat(r) !== true) return false;

      if (c.weekday) {
        var want = Number(c.weekday);
        var sessions = sessionsOf(r);
        var hit = false;
        for (var j = 0; j < sessions.length; j++) {
          if (sessions[j].weekday === want) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }

      if (conflictSet && !conflictSet[String(r.teachingClassId)]) return false;
      return true;
    });
  };

  /**
   * 时间排序键：最早一次课（周几 × 1000 + 起始节）。
   * @param {object} record 课程记录
   * @returns {(number|null)} 无时间信息时返回 null（排序时恒排最后）
   */
  Q.timeOrderOf = function (record) {
    var sessions = sessionsOf(record);
    if (!sessions.length) return null;
    var best = null;
    for (var i = 0; i < sessions.length; i++) {
      var v = sessions[i].weekday * 1000 + sessions[i].periodStart;
      if (best === null || v < best) best = v;
    }
    return best;
  };

  /** 取排序用的值。坏记录（null/非对象）一律当作"取不到"。 */
  function valueOf(record, key) {
    if (!record || typeof record !== 'object') return null;
    switch (key) {
      case 'name':
        return record.courseName === null || record.courseName === undefined ? null : String(record.courseName);
      case 'teacher':
        return record.teacherName === null || record.teacherName === undefined ? null : String(record.teacherName);
      case 'department':
        return record.departmentName === null || record.departmentName === undefined ? null : String(record.departmentName);
      case 'remain':
        return NS.model.remainCount(record);
      case 'capacity':
        return typeof record.classCapacity === 'number' ? record.classCapacity : null;
      case 'time':
        return Q.timeOrderOf(record);
      default:
        return null;
    }
  }

  /**
   * 排序（稳定；null 值恒排最后）。
   * @param {object[]} records 课程记录
   * @param {string} [key] 排序键，见 Q.SORT_KEYS
   * @param {boolean} [desc] 是否降序
   * @returns {object[]} 新数组
   */
  Q.sort = function (records, key, desc) {
    var list = (Array.isArray(records) ? records : []).slice();
    var k = Q.SORT_KEYS.indexOf(key) === -1 ? 'default' : key;
    if (k === 'default') return desc === true ? list.reverse() : list;

    var decorated = list.map(function (r, i) {
      return { r: r, i: i, v: valueOf(r, k) };
    });

    decorated.sort(function (a, b) {
      var av = a.v;
      var bv = b.v;
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return a.i - b.i;
      if (aNull) return 1; // 取不到的恒排最后，避免"未知余量"插到最前面
      if (bNull) return -1;

      var cmp;
      if (typeof av === 'string' || typeof bv === 'string') {
        cmp = String(av).localeCompare(String(bv), 'zh-Hans-CN');
      } else {
        cmp = av === bv ? 0 : av < bv ? -1 : 1;
      }
      if (cmp === 0) return a.i - b.i; // 稳定
      return desc === true ? -cmp : cmp;
    });

    return decorated.map(function (d) {
      return d.r;
    });
  };

  /**
   * 统计汇总（面板顶部摘要条用）。
   * @param {object[]} records 课程记录
   * @returns {{total:number, free:number, full:number, unknown:number,
   *            mooc:number, favorite:number, conflict:number, byCategory:object}}
   */
  Q.stats = function (records) {
    var list = Array.isArray(records) ? records : [];
    var out = {
      total: list.length,
      free: 0,
      full: 0,
      unknown: 0,
      mooc: 0,
      favorite: 0,
      conflict: 0,
      byCategory: {},
    };
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var seat = NS.model.hasFreeSeat(r);
      if (seat === true) out.free += 1;
      else if (seat === false) out.full += 1;
      else out.unknown += 1;
      if (r.isMooc) out.mooc += 1;
      if (r.isFavorite) out.favorite += 1;
      if (r.isConflict) out.conflict += 1;
      var cat = r.teachingClassType || '(未知)';
      out.byCategory[cat] = (out.byCategory[cat] || 0) + 1;
    }
    return out;
  };

  /**
   * 去重取值（用于生成筛选下拉项）。
   * @param {object[]} records 课程记录
   * @param {string} field 字段名
   * @returns {string[]} 去重后的非空取值（保持首次出现顺序）
   */
  Q.uniqueValues = function (records, field) {
    var list = Array.isArray(records) ? records : [];
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i] ? list[i][field] : null;
      if (v === null || v === undefined || v === '') continue;
      var s = String(v);
      if (seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
