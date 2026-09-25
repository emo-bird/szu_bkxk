/**
 * P0：优化课程列表显示。
 *
 * 站点有两种列表形态，分别处理：
 *   (1) 课程 → 教学班：教学班卡片 .cv-course-card 内，在
 *       .cv-caption-red（选课说明）与随后的 .cv-caption-text 之间插入模块。
 *   (2) 直接即教学班（公选/慕课）：在「操作」列右侧新增「抢课模块」列。
 *
 * 模块内容：第一行教学班ID（不换行、占满一行），第二行两个按钮。
 * 样式刻意从简，融入站点原有界面。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = (NS.list || {}));

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_CARD = 'data-szu-card';
  var DONE_ROW = 'data-szu-row';
  var DONE_HEAD = 'data-szu-head';

  /** 直接即教学班的列表容器 id。 */
  L.DIRECT_BODIES = ['publicBody', 'moocBody'];

  /** 新列宽度（px）。公选课各列是固定像素 + float 布局，用固定值最可控。 */
  var COL_W = 210;

  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      // 行距压缩（用户指定 0.9）
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      '.cv-list>.cv-body>.cv-row>div{word-break:break-all;overflow-wrap:anywhere;}',

      // ---- 「抢课模块」容器：纵向两行，样式从简 ----
      '.szu-block{padding:2px 0;}',
      '.szu-id{display:block;width:100%;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;color:#047ADC;font-size:12px;line-height:1.4;}',
      '.szu-ops{display:block;margin-top:4px;white-space:nowrap;}',
      '.szu-ops .szu-btn{margin-right:4px;}',

      // 按钮沿用站点 cv-btn / cv-tag 观感
      '.szu-btn{display:inline-block;border:1px solid #047ADC;background:#fff;color:#047ADC;',
      'font-size:12px;line-height:1.5;padding:0 6px;border-radius:8px;cursor:pointer;}',
      '.szu-btn:hover{background:#047ADC;color:#fff;}',
      '.szu-btn.szu-on{background:#047ADC;color:#fff;}',

      // ---- 新增的「抢课模块」列（表头 + 单元格同宽，float 对齐）----
      '.szu-head-col{width:' + COL_W + 'px !important;float:left;}',
      '.szu-direct-col{width:' + COL_W + 'px !important;float:left;padding:4px 6px;',
      'box-sizing:border-box;text-align:left;}',
      '.szu-direct-col .szu-id{font-size:12px;}',
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

  /**
   * 「抢课模块」：纵向两行。
   * 第一行：教学班ID（不换行、占满一行）
   * 第二行：两个按钮
   */
  L.buildBlock = function (info) {
    var block = root.document.createElement('div');
    block.className = 'szu-block';

    var idLine = root.document.createElement('div');
    idLine.className = 'szu-id';
    idLine.setAttribute('title', info.teachingClassID);
    idLine.textContent = info.teachingClassID;

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

  /* ---------------- 形态一：注入到教学班卡片内部 ---------------- */

  function tcIdOfCard(card) {
    var img = card.querySelector('img.collection-img');
    var id = img && img.getAttribute('tcId');
    if (id) return id;
    id = card.getAttribute('tcId');
    if (id) return id;
    var cid = card.getAttribute('id') || '';
    if (/_courseDiv$/.test(cid)) return cid.replace(/_courseDiv$/, '');
    return '';
  }

  /**
   * 在卡片内定位插入点：.cv-caption-red 之后、紧随的 .cv-caption-text 之前。
   * 找不到 cv-caption-red 时，退化为「选课说明」那个 div（同样用 cv-caption-text 定位）。
   */
  function insertPointInCard(card) {
    var info = card.querySelector('.cv-info');
    if (!info) return null;
    var kids = [];
    for (var i = 0; i < info.childNodes.length; i++) {
      if (info.childNodes[i].nodeType === 1) kids.push(info.childNodes[i]);
    }
    // 找 cv-caption-red（选课说明有内容时）
    for (var j = 0; j < kids.length; j++) {
      var cls = kids[j].getAttribute('class') || '';
      if (cls.indexOf('cv-caption-red') !== -1) {
        return { parent: info, before: kids[j + 1] || null };
      }
    }
    // 退化：找含「选课说明」文字的 div
    for (var k = 0; k < kids.length; k++) {
      var t = NS.util.text(kids[k]);
      if (t.indexOf('选课说明') === 0) {
        return { parent: info, before: kids[k + 1] || null };
      }
    }
    return { parent: info, before: null };
  }

  L.enhanceCard = function (card) {
    if (card.getAttribute(DONE_CARD) === '1') return false;
    var tcId = tcIdOfCard(card);
    if (!tcId) return false;
    var point = insertPointInCard(card);
    if (!point) return false;
    card.setAttribute(DONE_CARD, '1');

    var titleEl = card.querySelector('.cv-info-title');
    var block = L.buildBlock({
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(titleEl),
    });
    if (point.before && point.before.parentNode === point.parent) {
      point.parent.insertBefore(block, point.before);
    } else {
      point.parent.appendChild(block);
    }
    return true;
  };

  /* ---------------- 形态二：新增「抢课模块」列 ---------------- */

  /** 表头新增一列；class 用 cv-normal 以抑制站点的排序箭头。 */
  L.ensureHeadColumn = function (bodyId) {
    var body = root.document.getElementById(bodyId);
    if (!body) return false;
    var list = body.closest ? body.closest('.cv-list') : null;
    if (!list) return false;
    var head = list.querySelector('.cv-head');
    if (!head || head.getAttribute(DONE_HEAD) === '1') return false;
    head.setAttribute(DONE_HEAD, '1');
    var col = root.document.createElement('div');
    col.className = 'cv-normal szu-head-col';
    col.textContent = '抢课模块';
    head.appendChild(col);
    return true;
  };

  /** 行内新增单元格：插在「操作」列之后。 */
  L.enhanceDirectRow = function (row) {
    if (row.getAttribute(DONE_ROW) === '1') return false;
    var choice = row.querySelector('a.cv-choice');
    if (!choice && row.querySelector) choice = row.querySelector('[tcId]');
    if (!choice) return false;
    var tcId = choice.getAttribute('tcId');
    if (!tcId) return false;
    var setting = row.querySelector('.cv-setting-col');
    if (!setting) return false;
    row.setAttribute(DONE_ROW, '1');

    var titleEl = row.querySelector('.cv-title-col');
    var teacherEl = row.querySelector('.cv-teacher-col');
    var cell = root.document.createElement('div');
    cell.className = 'szu-direct-col';
    cell.appendChild(L.buildBlock({
      teachingClassID: tcId,
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(teacherEl),
    }));
    if (setting.parentNode) setting.parentNode.insertBefore(cell, setting.nextSibling);
    return true;
  };

  /* ---------------- 扫描 ---------------- */

  L.scan = function () {
    var n = 0;

    var cards = root.document.querySelectorAll ? root.document.querySelectorAll('.cv-course-card') : [];
    var cardList = [];
    for (var c = 0; c < cards.length; c++) cardList.push(cards[c]);
    for (var d = 0; d < cardList.length; d++) {
      if (L.enhanceCard(cardList[d])) n++;
    }

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
