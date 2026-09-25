/**
 * M4：课表页（*default/curriculum.do）注入。
 *
 * DOM 契约（取自 docs/curriculum.do.html）：
 *   #myCourseTable
 *     .cv-my-course
 *       .cv-col.cv-left                      ← 左侧「节次」列
 *         .cv-day  > div[start][end]         ← 上午/下午/晚上 分段
 *         .cv-lesson > div[style=height]     ← 14 个节次刻度
 *       .cv-col.cv-right                     ← 每天一列（周一…周七）
 *         .cv-head                           ← 「周一」
 *         .cv-lesson[start][end][style=top]  ← 一节课的容器
 *           .cv-course-card-single > div > div{课程名, 时间, 地点, 教师}
 *
 * 【注入方式】把自定义课程按「星期 + 起止节次」算出 top/height，
 * 追加成 .cv-lesson，内部放与站点同构的 .cv-course-card-single，
 * 并加一个自定义标记类以示区分。
 *
 * 【几何】左侧 .cv-lesson 里每个节次刻度是固定 54px（实测 14 节 × 54 = 756），
 * 但站点实际用 784px 容器。为稳妥，运行时从真实刻度测量单节高度，
 * 测不到才退回 54px。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var TT = (NS.timetable = NS.timetable || {});

  var STYLE_ID = 'szu-tt-style';
  var DONE_ATTR = 'data-szu-tt';
  var DEFAULT_SLOT_H = 54;
  var DEFAULT_TOP = 28; // .cv-head 高度（实测 top:28px 对应第 1 节）

  TT.injectStyle = function () {
    if (root.document.getElementById(STYLE_ID)) return;
    var s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.szu-tt-card{opacity:.92;}',
      '.szu-tt-card .szu-tt-tag{display:inline-block;font-size:11px;line-height:1.3;',
      'padding:0 3px;border-radius:2px;background:#047ADC;color:#fff;margin-left:3px;}',
      '.szu-tt-card.szu-tt-conflict{outline:2px solid #c0392b;outline-offset:-2px;}',
      '.szu-tt-card .szu-tt-conflict-tip{color:#c0392b;font-size:11px;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(s);
  };

  /** 找到课表容器；找不到返回 null（非课表页或结构变了）。 */
  TT.findTable = function () {
    var doc = root.document;
    var table = doc.getElementById('myCourseTable');
    if (table) return table;
    return doc.querySelector ? doc.querySelector('.cv-my-course') : null;
  };

  /**
   * 测量单节高度与起始偏移。
   * 从左侧 .cv-lesson 的真实刻度读，读不到再用默认值。
   */
  TT.measure = function (table) {
    var lesson = table.querySelector ? table.querySelector('.cv-left .cv-lesson') : null;
    var slotH = DEFAULT_SLOT_H;
    var top0 = DEFAULT_TOP;
    if (lesson && lesson.childNodes) {
      var first = null;
      for (var i = 0; i < lesson.childNodes.length; i++) {
        var n = lesson.childNodes[i];
        if (n.nodeType === 1) { first = n; break; }
      }
      if (first) {
        var h = parseInt(first.style && first.style.height, 10);
        if (isFinite(h) && h > 0) slotH = h;
      }
    }
    // 站点的第一节课 top=28（即表头高度），实测如此
    return { slotH: slotH, top0: top0 };
  };

  /** 找某一天的列容器。day: 1=周一 … 7=周日。 */
  TT.findDayColumn = function (table, day) {
    var cols = table.querySelectorAll ? table.querySelectorAll('.cv-col.cv-right') : [];
    // 站点顺序即 周一…周七；用 .cv-head 文本兜底核对
    var names = ['周一', '周二', '周三', '周四', '周五', '周六', '周七'];
    var want = names[day - 1];
    for (var i = 0; i < cols.length; i++) {
      var head = cols[i].querySelector ? cols[i].querySelector('.cv-head') : null;
      if (head && NS.util.text(head).indexOf(want) !== -1) return cols[i];
    }
    return cols[day - 1] || null;
  };

  /** 生成一个自定义课程卡片（结构对齐站点）。 */
  TT.buildCard = function (seg, course, conflict) {
    var card = root.document.createElement('div');
    card.className = 'cv-course-card-single szu-tt-card' + (conflict ? ' szu-tt-conflict' : '');
    var inner = root.document.createElement('div');
    var l1 = root.document.createElement('div');
    l1.appendChild(root.document.createTextNode(course.name));
    var tag = root.document.createElement('span');
    tag.className = 'szu-tt-tag';
    tag.textContent = '自定义';
    l1.appendChild(tag);
    inner.appendChild(l1);

    var l2 = root.document.createElement('div');
    l2.textContent = seg.weekFrom + '-' + seg.weekTo + '周' + seg.sectionFrom + '-' + seg.sectionTo + '节';
    inner.appendChild(l2);

    if (seg.place) {
      var l3 = root.document.createElement('div');
      l3.textContent = seg.place;
      inner.appendChild(l3);
    }
    if (course.teacher) {
      var l4 = root.document.createElement('div');
      l4.textContent = course.teacher;
      inner.appendChild(l4);
    }
    if (conflict) {
      var tip = root.document.createElement('div');
      tip.className = 'szu-tt-conflict-tip';
      tip.textContent = '与已选课程冲突';
      inner.appendChild(tip);
    }
    if (course.color) card.style.background = course.color;
    card.appendChild(inner);
    return card;
  };

  /**
   * 把一门自定义课程的某一段注入到课表。
   * @returns {boolean} 是否注入成功
   */
  TT.injectSegment = function (table, course, seg, conflict) {
    if (!seg || seg.day === null) return false;
    var col = TT.findDayColumn(table, seg.day);
    if (!col) return false;

    var geo = TT.measure(table);
    var top = geo.top0 + (seg.sectionFrom - 1) * geo.slotH;
    var height = (seg.sectionTo - seg.sectionFrom + 1) * geo.slotH + 1;

    var wrap = root.document.createElement('div');
    wrap.className = 'cv-lesson cv-top-line szu-tt-lesson';
    wrap.setAttribute('start', String(seg.sectionFrom));
    wrap.setAttribute('end', String(seg.sectionTo));
    wrap.style.height = height + 'px';
    wrap.style.top = top + 'px';
    wrap.setAttribute(DONE_ATTR, '1');

    var holder = root.document.createElement('div');
    holder.appendChild(TT.buildCard(seg, course, conflict));
    wrap.appendChild(holder);
    col.appendChild(wrap);
    return true;
  };

  /** 已选课程的时间（用于冲突提示，从现有课表卡片读）。 */
  TT.readExisting = function (table) {
    var out = [];
    var cards = table.querySelectorAll ? table.querySelectorAll('.cv-course-card-single') : [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if ((card.getAttribute('class') || '').indexOf('szu-tt-card') !== -1) continue;
      var divs = card.querySelectorAll ? card.querySelectorAll('div div') : [];
      var name = '';
      var time = '';
      for (var j = 0; j < divs.length; j++) {
        var t = NS.util.text(divs[j]);
        if (!name && t) name = t;
        if (!time && /\d+-\d+周/.test(t)) time = t;
      }
      if (time) out.push({ courseName: name, teachingPlace: time });
    }
    return out;
  };

  /** 清掉上一次注入的自定义块（避免重复刷新时堆叠）。 */
  TT.clearInjected = function (table) {
    var olds = table.querySelectorAll ? table.querySelectorAll('.szu-tt-lesson') : [];
    for (var i = olds.length - 1; i >= 0; i--) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
    return olds.length;
  };

  /** 渲染全部自定义课程。 */
  TT.render = function () {
    var table = TT.findTable();
    if (!table) return 0;
    TT.clearInjected(table);

    var existing = TT.readExisting(table);
    var n = 0;
    for (var i = 0; i < NS.custom.items.length; i++) {
      var c = NS.custom.items[i];
      if (!c.enabled) continue;
      // 与站点已选课程比对，冲突则高亮
      var conflict = false;
      for (var k = 0; k < existing.length; k++) {
        if (NS.time.conflicts(c.place, existing[k].teachingPlace)) { conflict = true; break; }
      }
      for (var j = 0; j < c.segs.length; j++) {
        if (TT.injectSegment(table, c, c.segs[j], conflict)) n++;
      }
    }
    NS.info('课表注入自定义课程段 ' + n + ' 个（已选课程 ' + existing.length + ' 门）');
    return n;
  };

  /** 入口：等课表渲染出来再注入（站点是异步渲染）。 */
  TT.start = function () {
    TT.injectStyle();
    var tries = 0;
    function attempt() {
      var table = TT.findTable();
      if (!table) {
        if (++tries < 20) setTimeout(attempt, 500);
        else NS.warn('未找到课表容器 #myCourseTable，放弃注入');
        return;
      }
      TT.render();
      // 站点重渲染时跟着重注入
      if (root.MutationObserver) {
        var pending = false;
        var mo = new root.MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () {
            pending = false;
            if (!TT.findTable()) return;
            if (!root.document.querySelector('.szu-tt-lesson') && NS.custom.items.length) TT.render();
          }, 300);
        });
        mo.observe(table, { childList: true, subtree: true });
      }
    }
    attempt();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
