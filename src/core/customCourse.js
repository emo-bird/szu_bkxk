/**
 * 自定义课程模型（M4，最低优先级需求）。
 *
 * 【用途】用户手工添加"课表上没有的课"（重修、外院课、实验等），
 *   用于 ① 在课表页显示 ② 参与冲突计算（与站点课程、彼此之间）。
 *
 * 【存储】只进 localStorage（NS.store.KEYS.CUSTOM_COURSES），不上传、不落盘到别处。
 *
 * 依赖：NS.time / NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var CC = (NS.customCourse = NS.customCourse || {});

  /** 可选颜色（用于课表上区分自定义课程）。 */
  CC.COLORS = ['#1a5fb4', '#c64600', '#1a7f37', '#8250df', '#b00020', '#9a6700'];

  /** 允许的颜色格式。 */
  var COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/;

  CC.COLUMNS = [
    { key: 'name', label: '课程名' },
    { key: 'teacher', label: '教师' },
    { key: 'timeText', label: '时间' },
    { key: 'placeText', label: '地点' },
  ];

  /** 取非空字符串或 null。 */
  function str(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 归一化一门自定义课程。
   * 支持两种输入：直接给 `sessions`，或给 `timeText` 由解析器转换。
   * @param {object} raw 原始数据
   * @returns {object} 规范化课程
   */
  CC.normalize = function (raw) {
    var o = raw && typeof raw === 'object' ? raw : {};

    var sessions = NS.time.normalizeSessions(o.sessions);
    if (sessions.length === 0 && typeof o.timeText === 'string' && o.timeText.trim() !== '') {
      sessions = NS.time.parseTeachingPlace(o.timeText).sessions;
    }

    var firstPlace = sessions.length > 0 && sessions[0].place ? sessions[0].place : null;

    return {
      id: str(o.id) || NS.util.uid(),
      name: str(o.name) || '',
      teacher: str(o.teacher),
      place: str(o.place) || firstPlace,
      color: typeof o.color === 'string' && COLOR_RE.test(o.color) ? o.color : CC.COLORS[0],
      sessions: sessions,
      note: str(o.note),
      createdAt: isFinite(Number(o.createdAt)) && Number(o.createdAt) > 0 ? Number(o.createdAt) : null,
      updatedAt: isFinite(Number(o.updatedAt)) && Number(o.updatedAt) > 0 ? Number(o.updatedAt) : null,
    };
  };

  /**
   * 新建一门自定义课程。
   * @param {object} [patch] 初始字段
   * @returns {object} 规范化课程
   */
  CC.create = function (patch) {
    var now = Date.now();
    return CC.normalize(Object.assign({}, patch || {}, { id: null, createdAt: now, updatedAt: now }));
  };

  /** 归一化列表。 */
  CC.normalizeList = function (list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(CC.normalize(list[i]));
    return out;
  };

  /**
   * 渲染某列的值（UI 表格用）。
   * @param {object} course 课程
   * @param {string} key 列 key
   * @returns {string}
   */
  CC.display = function (course, key) {
    var c = CC.normalize(course);
    switch (key) {
      case 'name':
        return c.name || '(未命名)';
      case 'teacher':
        return c.teacher || '—';
      case 'timeText':
        return NS.time.formatSessions(c.sessions) || '(未设置时间)';
      case 'placeText':
        return c.place || '—';
      case 'sessionCount':
        return String(c.sessions.length);
      default:
        return String(c[key] === undefined || c[key] === null ? '' : c[key]);
    }
  };

  /**
   * 找出自定义课程与"另一组课程时间"的冲突。
   * @param {object} course 自定义课程
   * @param {object[]} otherSessions 另一组 session（站点课程或其它自定义课程）
   * @returns {object[]} 冲突对
   */
  CC.conflictsWith = function (course, otherSessions) {
    return NS.time.findConflictPairs(CC.normalize(course).sessions, otherSessions);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
