/**
 * P0：优化课程列表显示。
 *
 * 方案（用户指定）：课程卡片展示教学班ID + 减小行间距 + 两个按钮
 *   「添加抢课」「添加监控」；ID 与按钮构成「抢课模块」，纵向两行，
 *   位于**单个课程行内部**。
 *
 * 【关键事实】站点把教学班藏在全局变量里，而不是渲染成独立行：
 *   courseDataList[$row.attr("index")].tcList
 * 由 grablessons.js 的 openCourseTeacherList() 在点开时才渲染成
 * <section><div class="cv-course-card">…</div></section>。
 * 我们直接读 courseDataList，因此**不必**依赖展开，也不必劫持网络。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = NS.list || {});

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_ATTR = 'data-szu-p0';

  /** 各列表容器 id（站点实际使用的）。 */
  L.BODIES = [
    'publicBody', 'moocBody', 'programBody', 'unProgramBody', 'recommendBody',
    'minorBody', 'retakeBody', 'sportBody', 'schoolBody',
  ];

  /**
   * 注入样式。
   * 【关键】行距 0.9（用户指定）+ 换行约束，避免长课程名溢出。
   */
  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      '.cv-row>div{word-break:break-all;overflow-wrap:anywhere;min-width:0;}',
      '.cv-row{box-sizing:border-box;}',
      // 「抢课模块」：行内纵向两行块
      '.szu-block{display:block;width:100%;box-sizing:border-box;',
      'padding:3px 6px;margin:2px 0;background:#f6f9fd;border-left:3px solid #4a90d9;',
      'font-size:12px;line-height:1.35;border-radius:2px;}',
      '.szu-block .szu-id{display:block;color:#3d6ea5;font-family:Consolas,Menlo,monospace;',
      'white-space:normal;word-break:break-all;}',
      '.szu-block .szu-id .szu-label{color:#8aa4c0;font-family:inherit;}',
      '.szu-block .szu-ops{display:flex;flex-direction:row;gap:6px;margin-top:2px;}',
      '.szu-btn{border:1px solid #4a90d9;background:#fff;color:#4a90d9;',
      'font-size:12px;line-height:1.5;padding:1px 8px;border-radius:3px;cursor:pointer;',
      'white-space:nowrap;flex:0 0 auto;}',
      '.szu-btn:hover{background:#4a90d9;color:#fff;}',
      '.szu-btn.szu-on{background:#4a90d9;color:#fff;}',
      '.szu-full .szu-id{color:#c0392b;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(style);
  };

  /** 提示条。 */
  function toast(msg) {
    var el = root.document.getElementById('szu-bkxk-toast');
    if (!el) {
      el = root.document.createElement('div');
      el.id = 'szu-bkxk-toast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:999999;' +
        'background:rgba(0,0,0,.82);color:#fff;padding:8px 16px;border-radius:4px;' +
        'font-size:13px;line-height:1.4;max-width:70vw;';
      root.document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.display = 'none'; }, 3200);
  }
  L.toast = toast;

  /** 当前登录学号：站点放在 sessionStorage.studentInfo 里。 */
  L.studentCode = function () {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('studentInfo');
      if (raw) {
        var info = JSON.parse(raw);
        if (info && info.code) return String(info.code);
      }
    } catch (e) { /* 忽略 */ }
    return '';
  };

  /** 会话 token：站点放在 sessionStorage.token。 */
  L.token = function () {
    try {
      return (root.sessionStorage && root.sessionStorage.getItem('token')) || '';
    } catch (e) {
      return '';
    }
  };

  /** 当前批次：站点放在 sessionStorage.currentBatch（含 code / schoolTerm）。 */
  L.currentBatch = function () {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('currentBatch');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };

  /**
   * 取某一行对应的教学班数组。
   * 数据源：全局 courseDataList[row.index].tcList（站点自己用的那份）。
   * 若课程行本身即教学班（公选/慕课），返回单项。
   */
  L.classesForRow = function (row) {
    // 1) 课程行：按 index 去全局数据里取 tcList
    var idx = row.getAttribute && row.getAttribute('index');
    var list = root.courseDataList;
    if (idx !== null && idx !== undefined && Array.isArray(list)) {
      var item = list[Number(idx)];
      if (item && Array.isArray(item.tcList) && item.tcList.length) {
        return NS.courses.classesOf(item);
      }
    }
    // 2) 行本身带 tcId（公选 / 慕课）
    var choice = row.querySelector && (row.querySelector('a.cv-choice[tcId]') || row.querySelector('[tcId]'));
    if (choice) {
      var tcId = choice.getAttribute('tcId');
      if (tcId) {
        var titleEl = row.querySelector('.cv-title-col') || row.querySelector('.cv-course') || row.querySelector('.cv-school-title-col');
        var timeEl = row.querySelector('.cv-time-col span');
        var teacherEl = row.querySelector('.cv-teacher-col') || row.querySelector('.cv-school-teacher-col');
        return [{
          teachingClassID: tcId,
          courseIndex: choice.getAttribute('number') || '',
          isFull: choice.getAttribute('isFull') || '',
          courseName: NS.util.text(titleEl),
          teacherName: NS.util.text(teacherEl),
          teachingPlace: timeEl ? String(timeEl.getAttribute('title') || timeEl.textContent || '').trim() : '',
        }];
      }
    }
    return [];
  };

  /**
   * 「添加抢课」：写接口关闭时**只打印报文不发送**（红线①）。
   */
  L.addGrab = function (info) {
    var s = NS.settings();
    var batch = L.currentBatch();
    var batchCode = s.batchCode || (batch && batch.code) || '';
    var body = NS.api.buildVolunteerBody({
      studentCode: L.studentCode(),
      electiveBatchCode: batchCode,
      teachingClassId: info.teachingClassID,
      teachingClassType: s.monitorCategory,
    });
    var url = NS.api.appendTimestamp(NS.api.url(NS.api.EP.VOLUNTEER));

    console.log('%c[抢课·报文预览]', 'color:#4a90d9;font-weight:bold', {
      url: url,
      body: body,
      课程: info.courseName,
      教学班ID: info.teachingClassID,
    });

    if (!NS.isWriteAllowed(s)) {
      toast('写接口未开启，仅打印报文。开启后才会真正发送。');
      NS.warn('写接口未开启，「添加抢课」只构造并打印报文', { 教学班ID: info.teachingClassID });
      return false;
    }
    NS.info('已加入抢课队列（执行留待后续）', info.teachingClassID);
    toast('已加入抢课任务：' + (info.courseName || info.teachingClassID));
    return true;
  };

  /** 「添加监控」：只读操作，不需要写接口开关。 */
  L.addMonitor = function (info) {
    var s = NS.settings();
    NS.monitor.add({
      teachingClassID: info.teachingClassID,
      courseName: info.courseName,
      teacherName: info.teacherName,
      teachingPlace: info.teachingPlace,
      mode: s.monitorMode,
    });
    toast('已加入监控：' + (info.courseName || info.teachingClassID));
    return true;
  };

  /**
   * 构建「抢课模块」：纵向两行 —— 第一行 ID，第二行两个按钮。
   */
  L.buildBlock = function (info) {
    var block = root.document.createElement('div');
    block.className = 'szu-block' + (String(info.isFull) === '1' ? ' szu-full' : '');

    // 第一行：教学班ID
    var idLine = root.document.createElement('div');
    idLine.className = 'szu-id';
    var label = root.document.createElement('span');
    label.className = 'szu-label';
    label.textContent = '教学班ID：';
    idLine.appendChild(label);
    idLine.appendChild(root.document.createTextNode(info.teachingClassID));
    if (info.courseIndex) {
      var idxSpan = root.document.createElement('span');
      idxSpan.className = 'szu-label';
      idxSpan.textContent = '　课序号：' + info.courseIndex;
      idLine.appendChild(idxSpan);
    }

    // 第二行：两个按钮
    var ops = root.document.createElement('div');
    ops.className = 'szu-ops';

    var grabBtn = root.document.createElement('button');
    grabBtn.className = 'szu-btn';
    grabBtn.textContent = '添加抢课';
    grabBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      L.addGrab(info);
    });

    var monBtn = root.document.createElement('button');
    monBtn.className = 'szu-btn';
    monBtn.textContent = '添加监控';
    if (NS.monitor.has(info.teachingClassID)) monBtn.classList.add('szu-on');
    monBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (L.addMonitor(info)) monBtn.classList.add('szu-on');
    });

    ops.appendChild(grabBtn);
    ops.appendChild(monBtn);
    block.appendChild(idLine);
    block.appendChild(ops);
    return block;
  };

  /**
   * 增强单个课程行：在**行内部**追加「抢课模块」。
   * 一个课程行可能对应多个教学班，则依次附加多个模块。
   */
  L.enhanceRow = function (row) {
    if (row.getAttribute(DONE_ATTR) === '1') return false;
    var classes = L.classesForRow(row);
    if (!classes || !classes.length) return false;
    row.setAttribute(DONE_ATTR, '1');

    var host = row.querySelector('.cv-course') || row.querySelector('.cv-title-col') ||
               row.querySelector('.cv-school-title-col') || row;
    var added = 0;
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      if (!c || !c.teachingClassID) continue;
      var block = L.buildBlock({
        teachingClassID: c.teachingClassID,
        courseIndex: c.courseIndex || '',
        courseName: c.courseName || '',
        teacherName: c.teacherName || '',
        teachingPlace: c.teachingPlace || '',
        isFull: c.isFull || '',
      });
      // 追加到行内：优先挂在「课程名」格之后，否则挂到行尾
      if (host === row) row.appendChild(block);
      else host.parentNode ? host.parentNode.appendChild(block) : row.appendChild(block);
      added++;
    }
    return added > 0;
  };

  /** 扫描所有列表容器里的行。 */
  L.scan = function () {
    var n = 0;
    for (var b = 0; b < L.BODIES.length; b++) {
      var body = root.document.getElementById(L.BODIES[b]);
      if (!body) continue;
      var rows = body.querySelectorAll ? body.querySelectorAll('.cv-row') : [];
      // 复制成数组：注入子节点会影响实时 NodeList 的遍历
      var list = [];
      for (var i = 0; i < rows.length; i++) list.push(rows[i]);
      for (var j = 0; j < list.length; j++) {
        if (L.enhanceRow(list[j])) n++;
      }
    }
    // 兜底：整页扫描（部分容器 id 可能变动）
    if (n === 0) {
      var all = root.document.querySelectorAll ? root.document.querySelectorAll('.cv-row') : [];
      var arr = [];
      for (var k = 0; k < all.length; k++) arr.push(all[k]);
      for (var m = 0; m < arr.length; m++) {
        if (L.enhanceRow(arr[m])) n++;
      }
    }
    return n;
  };

  /** 观察 DOM 变化，处理站点异步重渲染。 */
  L.observe = function () {
    if (!root.MutationObserver) return;
    var pending = false;
    var mo = new root.MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        var n = L.scan();
        if (n) NS.info('P0 增强了 ' + n + ' 行');
      }, 150);
    });
    mo.observe(root.document.body, { childList: true, subtree: true });
  };

  /** 入口。 */
  L.start = function () {
    L.injectStyle();
    var n = L.scan();
    L.observe();
    NS.info('P0 课程列表优化已启动，首轮增强 ' + n + ' 行');
    return n;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
