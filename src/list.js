/**
 * P0：优化课程列表显示。
 *
 * 方案（用户指定）：
 *   1. **课程 → 教学班**类别（方案内/推荐/体育/…）：教学班卡片（.cv-course-card）
 *      渲染出来后，把「教学班ID + 两个按钮」注入到**卡片内部**。
 *   2. **直接即教学班**类别（公选/慕课）：表格在「操作」列右侧新增一列
 *      「抢课模块」，该列内显示教学班ID + 两个按钮。
 *
 * 【关键事实】站点把教学班数据放在全局 courseDataList[row.index].tcList；
 * 卡片由 openCourseTeacherList() 在点开时渲染进 .cv-row 内部的 <section>。
 * 我们读全局数据 + 用 MutationObserver 在卡片出现时注入。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = NS.list || {});

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_ROW = 'data-szu-row';
  var DONE_CARD = 'data-szu-card';

  /** 各列表容器 id（站点实际使用的）。 */
  L.BODIES = [
    'publicBody', 'moocBody', 'programBody', 'unProgramBody', 'recommendBody',
    'minorBody', 'retakeBody', 'sportBody', 'schoolBody',
  ];

  /** 直接即教学班的列表（表格形态，需要新增「抢课模块」列）。 */
  L.DIRECT_BODIES = ['publicBody', 'moocBody'];

  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      '.cv-row>div{word-break:break-all;overflow-wrap:anywhere;min-width:0;}',
      '.cv-row{box-sizing:border-box;}',
      // 行内/卡片内的「抢课模块」：纵向两行 —— ID 一行，按钮一行
      '.szu-block{display:block;box-sizing:border-box;padding:3px 5px;margin:2px 0;',
      'background:#f6f9fd;border-left:3px solid #4a90d9;border-radius:2px;',
      'font-size:12px;line-height:1.35;}',
      '.szu-block .szu-id{display:block;color:#3d6ea5;font-family:Consolas,Menlo,monospace;',
      'word-break:break-all;}',
      '.szu-block .szu-id .szu-label{color:#8aa4c0;font-family:inherit;}',
      '.szu-block .szu-ops{display:flex;flex-direction:row;gap:6px;margin-top:3px;}',
      '.szu-btn{border:1px solid #4a90d9;background:#fff;color:#4a90d9;',
      'font-size:12px;line-height:1.5;padding:1px 8px;border-radius:3px;cursor:pointer;',
      'white-space:nowrap;flex:0 0 auto;}',
      '.szu-btn:hover{background:#4a90d9;color:#fff;}',
      '.szu-btn.szu-on{background:#4a90d9;color:#fff;}',
      '.szu-block.szu-full .szu-id{color:#c0392b;}',
      // 新增的「抢课模块」列（表头 + 单元格）
      '.szu-head-col{display:inline-block;vertical-align:middle;}',
      '.cv-setting-col{white-space:normal;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(style);
  };

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

  L.currentBatch = function () {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('currentBatch');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };

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
      url: url, body: body, 课程: info.courseName, 教学班ID: info.teachingClassID,
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

  /** 构建「抢课模块」：第一行 ID，第二行两个按钮。 */
  L.buildBlock = function (info) {
    var block = root.document.createElement('div');
    block.className = 'szu-block' + (String(info.isFull) === '1' ? ' szu-full' : '');

    var idLine = root.document.createElement('div');
    idLine.className = 'szu-id';
    var label = root.document.createElement('span');
    label.className = 'szu-label';
    label.textContent = '教学班ID：';
    idLine.appendChild(label);
    idLine.appendChild(root.document.createTextNode(info.teachingClassID));

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

  /* ------------------------------------------------------------------
   * 一、课程 → 教学班：注入到教学班卡片内部
   * ------------------------------------------------------------------ */

  /** 从卡片 DOM 取教学班信息。 */
  function readCard(card) {
    var img = card.querySelector('img.collection-img[tcId]');
    var tcId = (img && img.getAttribute('tcId')) || card.getAttribute('tcId');
    if (!tcId) {
      // 兜底：从卡片 id（"<tcId>_courseDiv"）解析
      var cid = card.getAttribute('id') || '';
      if (/_courseDiv$/.test(cid)) tcId = cid.replace(/_courseDiv$/, '');
    }
    if (!tcId) return null;
    var titleEl = card.querySelector('.cv-info-title');
    var placeEl = card.querySelector('[title]');
    return {
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl) || (placeEl ? '' : ''),
      teacherName: NS.util.text(titleEl),
      teachingPlace: '',
      isFull: card.getAttribute('isFull') || '',
    };
  }

  /** 给单个教学班卡片注入「抢课模块」。 */
  L.enhanceCard = function (card) {
    if (card.getAttribute(DONE_CARD) === '1') return false;
    var info = readCard(card);
    if (!info) return false;
    card.setAttribute(DONE_CARD, '1');
    var block = L.buildBlock(info);
    // 注入到卡片内部末尾
    card.appendChild(block);
    return true;
  };

  /* ------------------------------------------------------------------
   * 二、直接即教学班（公选/慕课）：在第 12 列右侧新增「抢课模块」列
   * ------------------------------------------------------------------ */

  /** 表头新增「抢课模块」列（插在「操作」之后）。 */
  L.ensureHeadColumn = function (bodyId) {
    var body = root.document.getElementById(bodyId);
    if (!body) return false;
    var list = body.closest ? body.closest('.cv-list') : null;
    if (!list) return false;
    var head = list.querySelector('.cv-head');
    if (!head) return false;
    if (head.querySelector('.szu-head-col')) return true;
    var col = root.document.createElement('div');
    col.className = 'szu-head-col';
    col.textContent = '抢课模块';
    head.appendChild(col);
    return true;
  };

  /** 行内新增「抢课模块」单元格（插在「操作」之后）。 */
  L.enhanceDirectRow = function (row) {
    if (row.getAttribute(DONE_ROW) === '1') return false;
    var choice = row.querySelector('a.cv-choice[tcId]') || row.querySelector('[tcId]');
    if (!choice) return false;
    var tcId = choice.getAttribute('tcId');
    if (!tcId) return false;

    var setting = row.querySelector('.cv-setting-col');
    if (!setting) return false;
    row.setAttribute(DONE_ROW, '1');

    var titleEl = row.querySelector('.cv-title-col');
    var teacherEl = row.querySelector('.cv-teacher-col');
    var timeEl = row.querySelector('.cv-time-col span');

    var cell = root.document.createElement('div');
    cell.className = 'szu-direct-col';
    cell.appendChild(L.buildBlock({
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(teacherEl),
      teachingPlace: timeEl ? String(timeEl.getAttribute('title') || timeEl.textContent || '').trim() : '',
      isFull: choice.getAttribute('isFull') || '',
    }));
    // 插到「操作」列之后
    if (setting.parentNode) setting.parentNode.insertBefore(cell, setting.nextSibling);
    return true;
  };

  /* ------------------------------------------------------------------
   * 三、扫描与观察
   * ------------------------------------------------------------------ */

  L.scan = function () {
    var n = 0;

    // 1) 教学班卡片（课程 → 教学班），卡片可能在任何列表容器内
    var cards = root.document.querySelectorAll ? root.document.querySelectorAll('.cv-course-card') : [];
    var cardList = [];
    for (var c = 0; c < cards.length; c++) cardList.push(cards[c]);
    for (var d = 0; d < cardList.length; d++) {
      if (L.enhanceCard(cardList[d])) n++;
    }

    // 2) 直接即教学班的行
    for (var b = 0; b < L.DIRECT_BODIES.length; b++) {
      var body = root.document.getElementById(L.DIRECT_BODIES[b]);
      if (!body) continue;
      L.ensureHeadColumn(L.DIRECT_BODIES[b]);
      var rows = body.querySelectorAll ? body.querySelectorAll('.cv-row') : [];
      var list = [];
      for (var i = 0; i < rows.length; i++) list.push(rows[i]);
      for (var j = 0; j < list.length; j++) {
        if (L.enhanceDirectRow(list[j])) n++;
      }
    }

    return n;
  };

  L.observe = function () {
    if (!root.MutationObserver) return;
    var pending = false;
    var mo = new root.MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        var n = L.scan();
        if (n) NS.info('P0 增强了 ' + n + ' 处');
      }, 120);
    });
    mo.observe(root.document.body, { childList: true, subtree: true });
  };

  L.start = function () {
    L.injectStyle();
    var n = L.scan();
    L.observe();
    NS.info('P0 课程列表优化已启动，首轮增强 ' + n + ' 处');
    return n;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
