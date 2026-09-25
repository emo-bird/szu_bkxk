/**
 * 自定义课程（P2）：用于课表显示 + 计入冲突计算。
 *
 * 【为什么需要】站点课表只显示已选上的课，但用户可能想看到「正在抢的课」，
 * 或手工录入一门不来自站点的课，以判断时间是否冲突。
 *
 * 【冲突计算】复用 NS.time 的 teachingPlace 解析，与站点课程同一套判定。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var C = (NS.custom = NS.custom || {});

  var STORE_KEY = 'customCourses';

  /** 自定义课程列表。 */
  C.items = [];

  /**
   * 一条自定义课程：
   *   { id, name, teacher, place, color, enabled }
   * place 用与站点一致的写法，例如 `5-18周 星期二 3-4节 致理楼L1-707`
   * （支持逗号分隔多段）
   */
  C.add = function (info) {
    if (!info || !info.name) return null;
    var segs = NS.time.parse(info.place || '');
    var rec = {
      id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
      name: String(info.name),
      teacher: info.teacher ? String(info.teacher) : '',
      place: info.place ? String(info.place) : '',
      color: info.color || C.colorAt(C.items.length),
      enabled: info.enabled !== false,
      segs: segs,
    };
    C.items.push(rec);
    C.save();
    NS.info('新增自定义课程 ' + rec.name + '（解析出 ' + segs.length + ' 段）');
    return rec;
  };

  C.remove = function (id) {
    for (var i = 0; i < C.items.length; i++) {
      if (C.items[i].id === id) {
        C.items.splice(i, 1);
        C.save();
        return true;
      }
    }
    return false;
  };

  C.byId = function (id) {
    for (var i = 0; i < C.items.length; i++) if (C.items[i].id === id) return C.items[i];
    return null;
  };

  C.update = function (id, patch) {
    var rec = C.byId(id);
    if (!rec) return false;
    if (patch.name !== undefined) rec.name = String(patch.name);
    if (patch.teacher !== undefined) rec.teacher = String(patch.teacher);
    if (patch.place !== undefined) {
      rec.place = String(patch.place);
      rec.segs = NS.time.parse(rec.place);
    }
    if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
    C.save();
    return true;
  };

  C.clear = function () {
    C.items = [];
    C.save();
  };

  /** 配色循环（只用于区分显示，不参与任何逻辑）。 */
  C.COLORS = ['#e8f2fd', '#fdf0e8', '#e8fdf0', '#f2e8fd', '#fdfde8', '#fde8f0'];
  C.colorAt = function (i) {
    return C.COLORS[i % C.COLORS.length];
  };

  C.save = function () {
    // 只存原始字段，segs 由 place 重新解析（避免存派生数据）
    var slim = C.items.map(function (c) {
      return {
        id: c.id, name: c.name, teacher: c.teacher,
        place: c.place, color: c.color, enabled: c.enabled,
      };
    });
    NS.store.set(STORE_KEY, slim);
  };

  C.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!Array.isArray(data)) return 0;
    C.items = data.map(function (c) {
      return {
        id: c.id || ('c' + Date.now() + Math.floor(Math.random() * 1000)),
        name: c.name || '',
        teacher: c.teacher || '',
        place: c.place || '',
        color: c.color || C.COLORS[0],
        enabled: c.enabled !== false,
        segs: NS.time.parse(c.place || ''),
      };
    }).filter(function (c) { return !!c.name; });
    if (C.items.length) NS.info('已恢复 ' + C.items.length + ' 门自定义课程');
    return C.items.length;
  };

  /**
   * 自定义课程与给定课程是否冲突（计入冲突计算）。
   * @param {object[]} otherCourses 其它课程（含 teachingPlace 或 segs）
   * @returns {object[]} 冲突的课程
   */
  C.conflictsWith = function (otherCourses) {
    var out = [];
    for (var i = 0; i < C.items.length; i++) {
      var c = C.items[i];
      if (!c.enabled) continue;
      for (var j = 0; j < otherCourses.length; j++) {
        var o = otherCourses[j];
        if (NS.time.conflicts(c.place, o && o.teachingPlace)) {
          out.push({ custom: c, other: o });
        }
      }
    }
    return out;
  };

  /** 自定义课程两两之间是否冲突。 */
  C.selfConflicts = function () {
    var out = [];
    for (var i = 0; i < C.items.length; i++) {
      for (var j = i + 1; j < C.items.length; j++) {
        if (!C.items[i].enabled || !C.items[j].enabled) continue;
        if (NS.time.conflicts(C.items[i].place, C.items[j].place)) {
          out.push({ a: C.items[i], b: C.items[j] });
        }
      }
    }
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
