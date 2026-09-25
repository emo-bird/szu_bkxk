/**
 * 自定义课程界面：添加 / 列表 / 删除 / 冲突提示。
 *
 * 【用户怎么填】直接照抄站点的时间写法（如 `1-16周 星期二 3-4节 致理楼L1-707`），
 *   由 core/time 解析成 session；解析不出来就明确拒绝并给出示例，不猜。
 *
 * 【冲突】先做**自定义课程之间**的冲突提示（不依赖站点数据）；
 *   与站点课程的冲突要等 M3 拿到课程数据后再接（接口已备好：core/time.findConflictPairs）。
 *
 * 依赖：NS.customCourse / NS.time / NS.log（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var CV = (UI.customCourses = UI.customCourses || {});

  /** 时间输入框的示例文案（也用于报错提示，保持一致）。 */
  CV.TIME_EXAMPLE = '1-16周 星期二 3-4节 致理楼L1-707';

  /**
   * 由表单值构造自定义课程（**纯函数，可离线单测**）。
   * @param {object} values {name, teacher, timeText, place, color}
   * @returns {{ok:boolean, course:(object|null), error:(string|null)}}
   */
  CV.buildCourse = function (values) {
    var v = values || {};
    var name = typeof v.name === 'string' ? v.name.trim() : '';
    var timeText = typeof v.timeText === 'string' ? v.timeText.trim() : '';
    if (!name) return { ok: false, course: null, error: '请填写课程名' };
    if (!timeText) return { ok: false, course: null, error: '请填写上课时间，例如：' + CV.TIME_EXAMPLE };

    var parsed = NS.time.parseTeachingPlace(timeText);
    if (!parsed.ok) {
      return { ok: false, course: null, error: '时间格式无法识别，例如：' + CV.TIME_EXAMPLE };
    }
    var course = NS.customCourse.create({
      name: name,
      teacher: v.teacher,
      timeText: timeText,
      place: v.place,
      color: v.color,
    });
    return { ok: true, course: course, error: null };
  };

  /**
   * 统计每门自定义课程的冲突数（**纯函数，可离线单测**）。
   * @param {object[]} courses 课程列表
   * @returns {object} { 课程id: 冲突门数 }
   */
  CV.conflictCounts = function (courses) {
    var list = NS.customCourse.normalizeList(courses);
    var counts = {};
    for (var i = 0; i < list.length; i++) counts[list[i].id] = 0;
    for (var a = 0; a < list.length; a++) {
      for (var b = a + 1; b < list.length; b++) {
        if (NS.time.findConflictPairs(list[a].sessions, list[b].sessions).length > 0) {
          counts[list[a].id] += 1;
          counts[list[b].id] += 1;
        }
      }
    }
    return counts;
  };

  /** 建元素的小工具。 */
  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 造一个输入框。 */
  function input(doc, cls, placeholder, type) {
    var n = doc.createElement('input');
    n.type = type || 'text';
    n.className = 'szubkxk-input' + (cls ? ' ' + cls : '');
    if (placeholder) n.placeholder = placeholder;
    return n;
  }

  /**
   * 创建自定义课程区块。
   * @param {object} options {doc, store, logger}
   * @returns {{element:Element, refresh:Function, list:Function}}
   */
  CV.create = function (options) {
    options = options || {};
    var doc = options.doc;
    var store = options.store;
    var logger = options.logger;

    var courses = store ? NS.customCourse.normalizeList(store.getCustomCourses()) : [];

    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '自定义课程'));

    var bar = el(doc, 'div', 'szubkxk-row');
    var btnToggle = el(doc, 'button', 'szubkxk-btn', '＋ 添加课程');
    btnToggle.type = 'button';
    bar.appendChild(btnToggle);
    sec.appendChild(bar);

    var form = el(doc, 'div', 'szubkxk-form szubkxk-hidden');

    var row1 = el(doc, 'div', 'szubkxk-row');
    var inName = input(doc, 'szubkxk-input-wide', '课程名');
    var inTeacher = input(doc, null, '教师');
    row1.appendChild(inName);
    row1.appendChild(inTeacher);
    form.appendChild(row1);

    form.appendChild(el(doc, 'div', 'szubkxk-muted', '时间（照抄站点写法）'));
    var inTime = input(doc, 'szubkxk-input-full', CV.TIME_EXAMPLE);
    form.appendChild(inTime);

    var row3 = el(doc, 'div', 'szubkxk-row');
    var inPlace = input(doc, null, '地点(可空)');
    var inColor = input(doc, null, null, 'color');
    inColor.value = NS.customCourse.COLORS[0];
    row3.appendChild(inPlace);
    row3.appendChild(inColor);
    var btnAdd = el(doc, 'button', 'szubkxk-btn', '保存');
    btnAdd.type = 'button';
    row3.appendChild(btnAdd);
    form.appendChild(row3);
    sec.appendChild(form);

    var errorLine = el(doc, 'div', 'szubkxk-warn');
    sec.appendChild(errorLine);

    var list = el(doc, 'div', 'szubkxk-tasks');
    sec.appendChild(list);

    function safe(fn, label) {
      return function (ev) {
        try {
          fn(ev);
        } catch (e) {
          if (logger) logger.error(NS.log.CATEGORY.SYSTEM, '自定义课程界面出错：' + label, (e && e.message) || e);
        }
      };
    }

    function persist() {
      if (store) store.saveCustomCourses(courses);
    }

    btnToggle.addEventListener(
      'click',
      safe(function () {
        form.classList.toggle('szubkxk-hidden');
      }, '切换表单')
    );

    btnAdd.addEventListener(
      'click',
      safe(function () {
        var built = CV.buildCourse({
          name: inName.value,
          teacher: inTeacher.value,
          timeText: inTime.value,
          place: inPlace.value,
          color: inColor.value,
        });
        if (!built.ok) {
          errorLine.textContent = built.error;
          if (logger) logger.warn(NS.log.CATEGORY.SYSTEM, built.error);
          return;
        }
        errorLine.textContent = '';
        courses.push(built.course);
        persist();
        if (logger) {
          logger.info(
            NS.log.CATEGORY.SYSTEM,
            '已添加自定义课程：' + built.course.name + '（' + NS.time.formatSessions(built.course.sessions) + '）'
          );
        }
        inName.value = '';
        inTeacher.value = '';
        inTime.value = '';
        inPlace.value = '';
        refresh();
      }, '保存课程')
    );

    function refresh() {
      while (list.firstChild) list.removeChild(list.firstChild);
      if (courses.length === 0) {
        list.appendChild(el(doc, 'div', 'szubkxk-muted', '暂无自定义课程'));
        return;
      }
      var counts = CV.conflictCounts(courses);
      courses.forEach(function (course) {
        var row = el(doc, 'div', 'szubkxk-task');
        var line1 = el(doc, 'div', 'szubkxk-task-line');
        var dot = el(doc, 'span', null, '●');
        dot.style.color = course.color;
        line1.appendChild(dot);
        line1.appendChild(el(doc, 'span', 'szubkxk-task-name', course.name));
        if (course.teacher) line1.appendChild(el(doc, 'span', 'szubkxk-muted', course.teacher));
        row.appendChild(line1);

        var line2 = el(doc, 'div', 'szubkxk-task-line szubkxk-muted');
        line2.textContent =
          NS.time.formatSessions(course.sessions) + (course.place ? ' · ' + course.place : '');
        row.appendChild(line2);

        var line3 = el(doc, 'div', 'szubkxk-task-line');
        if (counts[course.id] > 0) {
          line3.appendChild(el(doc, 'span', 'szubkxk-warn', '与 ' + counts[course.id] + ' 门自定义课程冲突'));
        }
        var btnDel = el(doc, 'button', 'szubkxk-btn szubkxk-danger', '删除');
        btnDel.type = 'button';
        btnDel.addEventListener(
          'click',
          safe(function () {
            for (var i = 0; i < courses.length; i++) {
              if (courses[i].id === course.id) {
                courses.splice(i, 1);
                break;
              }
            }
            persist();
            refresh();
          }, '删除课程')
        );
        line3.appendChild(btnDel);
        row.appendChild(line3);
        list.appendChild(row);
      });
    }

    refresh();
    return {
      element: sec,
      refresh: refresh,
      list: function () {
        return courses.slice();
      },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
