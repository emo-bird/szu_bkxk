/**
 * 被动取数 + 字段映射。
 *
 * 结构陷阱（HAR 实测）：
 *   - programCourse.do / recommendedCourse.do 等是**嵌套结构**：dataList[] → tcList[]
 *   - publicCourse.do（校公选/慕课）是**扁平结构**：没有 tcList，一行即一个教学班
 *   - 嵌套结构里教学班级的字段可能为 null，**不得覆盖**课程级字段
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var C = (NS.courses = NS.courses || {});

  /** 取第一个非 null/undefined/空串的值。 */
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  /** 归一化一个教学班（无论来自嵌套还是扁平结构）。 */
  function normClass(tc, course) {
    tc = tc || {};
    course = course || {};
    return {
      teachingClassID: pick(tc.teachingClassID, tc.teachingClassId, course.teachingClassID),
      courseNumber: pick(tc.courseNumber, course.courseNumber),
      courseName: pick(tc.courseName, course.courseName, tc.title, course.title),
      teacherName: pick(tc.teacherName, course.teacherName),
      teachingPlace: pick(tc.teachingPlace, course.teachingPlace),
      courseTotalNumber: pick(tc.courseTotalNumber, course.courseTotalNumber),
      classCapacity: pick(tc.classCapacity, course.classCapacity),
      numberOfFirstVolunteer: pick(tc.numberOfFirstVolunteer, course.numberOfFirstVolunteer),
      courseIndex: pick(tc.courseIndex, course.courseIndex),
      isMooc: pick(tc.isMooc, course.isMooc),
      isFull: pick(tc.isFull, course.isFull),
      isConflict: pick(tc.isConflict, course.isConflict),
      isFavorite: pick(tc.isFavorite, course.isFavorite),
      typeName: pick(tc.typeName, course.typeName),
      courseNatureName: pick(tc.courseNatureName, course.courseNatureName),
      departmentName: pick(tc.departmentName, course.departmentName),
      credit: pick(tc.credit, course.credit),
      campus: pick(tc.campus, course.campus),
    };
  }

  /** 单条 dataList 项 → 教学班数组。自动区分嵌套/扁平。 */
  C.classesOf = function (item) {
    if (!item || typeof item !== 'object') return [];
    var tcList = item.tcList;
    if (Array.isArray(tcList)) {
      var out = [];
      for (var i = 0; i < tcList.length; i++) out.push(normClass(tcList[i], item));
      return out;
    }
    // 扁平结构：item 自己就是一个教学班
    return [normClass(item, item)];
  };

  /**
   * 整个列表响应 → 扁平的教学班数组。
   * @param {object} json 接口原始 JSON
   * @returns {object[]}
   */
  C.flatten = function (json) {
    var data = json && json.data;
    if (!data || typeof data !== 'object') return [];
    var list = data.dataList;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var classes = C.classesOf(list[i]);
      for (var j = 0; j < classes.length; j++) out.push(classes[j]);
    }
    return out;
  };

  /** 剩余名额；字段缺失返回 null（**不是 0**）。 */
  C.remainOf = function (c) {
    if (!c) return null;
    var cap = Number(c.classCapacity);
    var used = Number(c.numberOfFirstVolunteer);
    if (!isFinite(cap) || !isFinite(used)) return null;
    return cap - used;
  };

  /** 拿当前批次码：优先用户覆盖值，否则从列表响应提取。 */
  C.resolveBatchCode = function () {
    var s = NS.settings();
    if (s.batchCode) return s.batchCode;
    return '';
  };

  /** 从列表响应提取并保存 batchCode（用户未手填时才写）。 */
  C.learnBatchCode = function (json) {
    var got = NS.api.extractBatchCode(json);
    if (!got.batchCode) return null;
    var s = NS.settings();
    if (!s.batchCode) {
      NS.saveSettings({ batchCode: got.batchCode });
      NS.info('自动获取 batchCode: ' + got.batchCode);
    }
    return got;
  };

  /**
   * 拉一个类别的课程列表。
   * @param {object} o {category, studentCode, batchCode, pageNumber, pageSize, token}
   */
  C.fetchCategory = function (o) {
    var ep = NS.api.CATEGORY_EP[o.category] || NS.api.EP.PROGRAM_COURSE;
    var body = NS.api.buildQueryBody({
      studentCode: o.studentCode,
      electiveBatchCode: o.batchCode,
      teachingClassType: o.category,
      pageNumber: o.pageNumber,
      pageSize: o.pageSize,
    });
    return NS.api
      .send({
        action: '列表查询 ' + o.category,
        url: NS.api.url(ep),
        method: 'POST',
        body: body,
        token: o.token,
      })
      .then(function (r) {
        if (r.cls.kind === NS.api.RESP_KIND.OK) C.learnBatchCode(r.cls.json);
        return { kind: r.cls.kind, msg: r.cls.msg, classes: C.flatten(r.cls.json), raw: r.cls.json };
      });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
