/**
 * 课程数据模型：把站点返回的原始结构归一化成**统一的教学班级记录**。
 *
 * 【证据】docs/接口逆向记录.md §3.3（真实字段名）。
 *
 * 【必须处理的三种形态】
 *   1. `programCourse.do` / `recommendedCourse.do`：课程级对象里嵌套 `tcList[]`（教学班级级）；
 *   2. `publicCourse.do`（校公选 / 慕课）：**扁平结构，没有 tcList** —— 一行即一个教学班级。
 *      桌面版曾因只读嵌套的 tc 而为空，导致 teachingClassID/容量全空、
 *      `has_free_seat()` 恒为真、**对已满课程发起抢课**（逆向记录 §五）。所以这里统一走合并后取值；
 *   3. tcList 里的字段可能是 `null`，**不能让它覆盖课程级字段**（桌面版坑 #9）。
 *
 * 【字段容错】站点加字段/改字段名时只改 `FIELD_CANDIDATES` 即可（桌面版同款做法）。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var M = (NS.model = NS.model || {});

  /**
   * 逻辑字段 → 站点字段名候选（按优先级）。
   * 站点改版时只需扩这张表。
   */
  M.FIELD_CANDIDATES = {
    teachingClassId: ['teachingClassID', 'teachingClassId', 'tcId', 'tcid'],
    courseNumber: ['courseNumber'],
    courseTotalNumber: ['courseTotalNumber'],
    courseName: ['courseName'],
    courseNatureName: ['courseNatureName'],
    courseTypeName: ['courseTypeName', 'typeName'],
    departmentName: ['departmentName'],
    credit: ['credit'],
    teachingPlace: ['teachingPlace'],
    teacherName: ['teacherName'],
    // "1" 表示 MOOC
    isMooc: ['isMooc'],
    classCapacity: ['classCapacity', 'mainClassCapacity'],
    selectedCount: ['numberOfFirstVolunteer', 'numberOfSelected', 'mainElectiveNumber'],
    isFull: ['isFull'],
    isConflict: ['isConflict'],
    isChoose: ['isChoose'],
    isFavorite: ['isFavorite'],
    sportName: ['sportName'],
    campusName: ['campusName'],
  };

  /** 站点把布尔量编码成字符串 "1"/"0"/true/false。 */
  M.isTruthy = function (value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    var s = String(value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y';
  };

  /** 转成有限数值；否则返回 null（**不能返回 0**，否则"取不到"会被当成"没有余量/有余量"）。 */
  function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  /**
   * 合并课程级与教学班级级字段：教学班级级覆盖课程级，但**跳过 null/undefined/空串**。
   * 这是桌面版坑 #9 的修复（`tcList` 的 null 会把课程级字段覆盖成空）。
   * @param {object} courseLevel 课程级对象
   * @param {object} tcLevel 教学班级级对象（可为 null）
   * @returns {object} 合并后的扁平对象
   */
  M.mergeLevels = function (courseLevel, tcLevel) {
    var out = {};
    var k;
    if (courseLevel && typeof courseLevel === 'object') {
      for (k in courseLevel) {
        if (Object.prototype.hasOwnProperty.call(courseLevel, k)) out[k] = courseLevel[k];
      }
    }
    if (tcLevel && typeof tcLevel === 'object') {
      for (k in tcLevel) {
        if (!Object.prototype.hasOwnProperty.call(tcLevel, k)) continue;
        var v = tcLevel[k];
        if (v === null || v === undefined || v === '') continue; // 空值不覆盖
        out[k] = v;
      }
    }
    return out;
  };

  /**
   * 把一条合并后的记录归一化成统一教学班级记录。
   * @param {object} merged M.mergeLevels() 的结果
   * @param {object} [meta] 附加信息 {teachingClassType, batchCode, source}
   * @returns {object} 统一记录
   */
  M.toRecord = function (merged, meta) {
    var m = merged || {};
    var metaObj = meta || {};
    var record = {
      teachingClassId: NS.util.pick(m, M.FIELD_CANDIDATES.teachingClassId, null),
      courseNumber: NS.util.pick(m, M.FIELD_CANDIDATES.courseNumber, null),
      courseTotalNumber: NS.util.pick(m, M.FIELD_CANDIDATES.courseTotalNumber, null),
      courseName: NS.util.pick(m, M.FIELD_CANDIDATES.courseName, null),
      courseNatureName: NS.util.pick(m, M.FIELD_CANDIDATES.courseNatureName, null),
      courseTypeName: NS.util.pick(m, M.FIELD_CANDIDATES.courseTypeName, null),
      departmentName: NS.util.pick(m, M.FIELD_CANDIDATES.departmentName, null),
      credit: NS.util.pick(m, M.FIELD_CANDIDATES.credit, null),
      teachingPlace: NS.util.pick(m, M.FIELD_CANDIDATES.teachingPlace, null),
      teacherName: NS.util.pick(m, M.FIELD_CANDIDATES.teacherName, null),
      isMooc: M.isTruthy(NS.util.pick(m, M.FIELD_CANDIDATES.isMooc, null)),
      classCapacity: toNumberOrNull(NS.util.pick(m, M.FIELD_CANDIDATES.classCapacity, null)),
      selectedCount: toNumberOrNull(NS.util.pick(m, M.FIELD_CANDIDATES.selectedCount, null)),
      isFull: M.isTruthy(NS.util.pick(m, M.FIELD_CANDIDATES.isFull, null)),
      isConflict: M.isTruthy(NS.util.pick(m, M.FIELD_CANDIDATES.isConflict, null)),
      isChoose: M.isTruthy(NS.util.pick(m, M.FIELD_CANDIDATES.isChoose, null)),
      isFavorite: M.isTruthy(NS.util.pick(m, M.FIELD_CANDIDATES.isFavorite, null)),
      sportName: NS.util.pick(m, M.FIELD_CANDIDATES.sportName, null),
      campusName: NS.util.pick(m, M.FIELD_CANDIDATES.campusName, null),
      // 类别代码（FANKC/XGXK/...）：提交报文要用，来自页面的 querySetting
      teachingClassType: metaObj.teachingClassType || null,
      batchCode: metaObj.batchCode || null,
      source: metaObj.source || null,
    };
    record.teachingClassId = record.teachingClassId === null ? null : String(record.teachingClassId);

    // 解析课程时间（失败不抛，留空串）
    var parsed = NS.time ? NS.time.parseTeachingPlace(record.teachingPlace) : { sessions: [], place: '' };
    record.sessions = parsed.sessions || [];
    record.timePlace = parsed.place || '';
    return record;
  };

  /** 从响应里取出课程级数组（字段名可能是 dataList / data_list / rows ...）。 */
  M.extractRows = function (data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data !== 'object') return [];
    var keys = ['dataList', 'data_list', 'rows', 'list', 'records', 'courseList'];
    for (var i = 0; i < keys.length; i++) {
      var v = data[keys[i]];
      if (Array.isArray(v)) return v;
    }
    return [];
  };

  /** 从课程级对象里取出教学班级数组（可能不存在 = 扁平结构）。 */
  M.extractTcList = function (row) {
    if (!row || typeof row !== 'object') return null;
    var keys = ['tcList', 'tc_list', 'teachingClassList', 'tcInfoList'];
    for (var i = 0; i < keys.length; i++) {
      var v = row[keys[i]];
      if (Array.isArray(v)) return v;
    }
    return null;
  };

  /**
   * 把一个课程查询响应体（已 JSON.parse）摊平成教学班级记录数组。
   * @param {object} data 响应体的 data 部分
   * @param {object} [meta] {teachingClassType, batchCode, source}
   * @returns {object[]} 统一记录数组（丢弃没有 teachingClassId 的项）
   */
  M.flattenResponse = function (data, meta) {
    var rows = M.extractRows(data);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tcList = M.extractTcList(row);
      if (tcList && tcList.length > 0) {
        for (var j = 0; j < tcList.length; j++) {
          var rec = M.toRecord(M.mergeLevels(row, tcList[j]), meta);
          if (rec.teachingClassId) out.push(rec);
        }
      } else {
        // 扁平结构（校公选 / 慕课）：一行即一个教学班级
        var flat = M.toRecord(M.mergeLevels(row, null), meta);
        if (flat.teachingClassId) out.push(flat);
      }
    }
    return out;
  };

  /**
   * 计算剩余名额。
   * 【注意】capacity.do 的字段可能全为 null；取不到时返回 null，
   * 调用方**不得**把 null 当成"有余量"。
   * @param {object} record 统一记录
   * @returns {(number|null)} 剩余名额
   */
  M.remainCount = function (record) {
    if (!record) return null;
    var cap = toNumberOrNull(record.classCapacity);
    var used = toNumberOrNull(record.selectedCount);
    if (cap === null || used === null) return null;
    return cap - used;
  };

  /**
   * 是否确定"有余量"。
   * @param {object} record 统一记录
   * @returns {(boolean|null)} true=有余量，false=满，null=无法判断
   */
  M.hasFreeSeat = function (record) {
    var remain = M.remainCount(record);
    if (remain !== null) return remain > 0;
    // isFull 可能来自未归一化的原始对象（字符串 "1"），统一按站点编码解析
    if (record && M.isTruthy(record.isFull)) return false;
    return null; // 无从判断，交给调用方决定（默认不提交）
  };

  /**
   * 把记录转成任务目标（用于"一键加入抢课任务"）。
   * @param {object} record 统一记录
   * @returns {(object|null)} 任务目标；缺 teachingClassId 或类别时返回 null
   */
  M.toTaskTarget = function (record) {
    if (!record || !record.teachingClassId || !record.teachingClassType) return null;
    return {
      teachingClassId: record.teachingClassId,
      courseNumber: record.courseNumber,
      courseName: record.courseName,
      teacher: record.teacherName,
      teachingClassType: record.teachingClassType,
    };
  };

  /**
   * 合并多批记录（按 teachingClassId 去重，后者不覆盖已有的非空字段）。
   * @param {object[][]} batches 多批记录
   * @returns {object[]} 合并结果
   */
  M.mergeRecords = function (batches) {
    var byId = {};
    var order = [];
    for (var b = 0; b < batches.length; b++) {
      var list = batches[b] || [];
      for (var i = 0; i < list.length; i++) {
        var rec = list[i];
        if (!rec || !rec.teachingClassId) continue;
        var id = rec.teachingClassId;
        if (!byId[id]) {
          byId[id] = Object.assign({}, rec);
          order.push(id);
        } else {
          var target = byId[id];
          for (var k in rec) {
            if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
            if (rec[k] !== null && rec[k] !== undefined && rec[k] !== '') target[k] = rec[k];
          }
        }
      }
    }
    var out = [];
    for (var j = 0; j < order.length; j++) out.push(byId[order[j]]);
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
