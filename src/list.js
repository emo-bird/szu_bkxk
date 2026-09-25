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

  /**
   * 列表容器 id → 教学班类别代码。
   * 【来源】站点 grablessons.js 的 reloadCourseList() 映射（tcType -> 模块），
   * 再对应到各列表容器的 id。抢课报文的 teachingClassType 必须用**该教学班所属列表**
   * 的类别，不能用全局设置。
   */
  L.BODY_CATEGORY = {
    programBody: 'FANKC',
    unProgramBody: 'FAWKC',
    recommendBody: 'TJKC',
    publicBody: 'XGXK',
    retakeBody: 'CXKC',
    sportBody: 'TYKC',
    minorBody: 'FXKC',
    moocBody: 'MOOC',
    schoolBody: 'XGXK', // 全校课程无独立类别码，暂按校公选（未实测）
  };

  /** 由节点向上找出所属列表容器，返回类别代码。 */
  L.categoryOfNode = function (node) {
    var n = node;
    while (n) {
      var id = n.getAttribute && n.getAttribute('id');
      if (id && L.BODY_CATEGORY[id]) return L.BODY_CATEGORY[id];
      n = n.parentNode;
    }
    return '';
  };

  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      // 行距压缩（用户指定 0.9）
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      '.cv-list>.cv-body>.cv-row>div{word-break:break-all;overflow-wrap:anywhere;}',

      // ---- 公选/慕课：表头与行改用 flex，新增列吃掉剩余横向空间 ----
      // 站点是 float + 固定像素宽度，各列合计已占满大部分宽度；
      // 直接追加一个定宽 float 列会因放不下而换行。改 flex 后：
      //   站点各列 flex:0 1 auto → 保持原有像素宽度（外观不变）
      //   新增列   flex:1 1 auto → 吃掉剩余空间，永不换行
      '.szu-flex-head{display:flex;flex-wrap:nowrap;align-items:flex-start;}',
      '#publicBody>.cv-row,#moocBody>.cv-row{display:flex;flex-wrap:nowrap;align-items:flex-start;}',
      '.szu-flex-head>div,#publicBody>.cv-row>div,#moocBody>.cv-row>div{float:none;flex:0 1 auto;min-width:0;}',
      '.szu-flex-head>.szu-head-col,#publicBody>.cv-row>.szu-direct-col,#moocBody>.cv-row>.szu-direct-col{',
      'flex:1 1 auto;min-width:0;overflow:hidden;box-sizing:border-box;}',

      // ---- 「抢课模块」：纵向两行 ----
      '.szu-block{padding:2px 0;}',
      '.szu-id{display:block;width:100%;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;color:#047ADC;font-size:12px;line-height:1.4;}',
      '.szu-ops{display:block;margin-top:4px;white-space:nowrap;}',
      '.szu-ops .szu-btn{margin-right:4px;}',
      '.szu-btn{display:inline-block;border:1px solid #047ADC;background:#fff;color:#047ADC;',
      'font-size:12px;line-height:1.5;padding:0 6px;border-radius:8px;cursor:pointer;}',
      // 悬停用浅色，**刻意区别于选中态** —— 否则鼠标还停在按钮上时看不出状态已切换
      '.szu-btn:hover{background:#e8f2fd;}',
      '.szu-btn.szu-on{background:#047ADC;color:#fff;border-color:#047ADC;}',

      // ---- 新增列 ----
      '.szu-head-col{text-align:center;}',
      '.szu-direct-col{padding:4px 6px;text-align:left;}',
      // 新列字号略小，确保 21 位教学班ID 能在一行内放下
      '.szu-direct-col .szu-id{font-size:11px;}',
      '.szu-direct-col .szu-btn{font-size:11px;padding:0 5px;}',
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

  /**
   * 会话上下文 —— 取值方式与站点 buildAddVolunteerParam() 保持一致：
   *   studentCode / electiveBatchCode 来自 sessionStorage.studentInfo（含 electiveBatch）
   *   campus 来自 sessionStorage.currentCampus
   * 旧版只有 currentBatch，站点抢课实际用的是 studentInfo.electiveBatch。
   */
  L.sessionContext = function () {
    var out = { studentCode: '', batchCode: '', campus: '' };
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('studentInfo');
      if (raw) {
        var info = JSON.parse(raw);
        if (info) {
          if (info.code) out.studentCode = String(info.code);
          if (info.electiveBatch && info.electiveBatch.code) out.batchCode = String(info.electiveBatch.code);
        }
      }
    } catch (e) { /* 忽略 */ }
    try {
      var camp = root.sessionStorage && root.sessionStorage.getItem('currentCampus');
      if (camp) {
        var c = JSON.parse(camp);
        if (c && c.code) out.campus = String(c.code);
      }
    } catch (e) { /* 忽略 */ }
    // 兜底：currentBatch（capacity.do 那条路径用的是它）
    if (!out.batchCode) {
      try {
        var cb = root.sessionStorage && root.sessionStorage.getItem('currentBatch');
        if (cb) {
          var b = JSON.parse(cb);
          if (b && b.code) out.batchCode = String(b.code);
        }
      } catch (e) { /* 忽略 */ }
    }
    // 最后兜底：设置里手填的
    if (!out.batchCode) out.batchCode = NS.settings().batchCode || '';
    if (!out.campus) out.campus = '01';
    return out;
  };

  /** 当前登录学号（兼容旧调用）。 */
  L.studentCode = function () {
    return L.sessionContext().studentCode;
  };

  /** 当前批次码（兼容旧调用）。 */
  L.currentBatch = function () {
    var ctx = L.sessionContext();
    return ctx.batchCode ? { code: ctx.batchCode } : null;
  };

  /**
   * 「添加抢课」：**只入队，不立即执行**（用户指定）。
   * 报文始终打印（便于核对）；是否真发由写接口开关决定（红线①）。
   */
  L.addGrab = function (info) {
    var s = NS.settings();
    var ctx = L.sessionContext();
    var body = NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: info.teachingClassID,
      campus: ctx.campus,
      // 用该教学班所属列表的类别，而不是全局设置
      teachingClassType: info.category || '',
    });
    var url = NS.api.appendTimestamp(NS.api.url(NS.api.EP.VOLUNTEER));
    console.log('%c[抢课·报文预览]', 'color:#4a90d9;font-weight:bold', {
      url: url, body: body, 课程: info.courseName, 教学班ID: info.teachingClassID,
      类别: info.category || '(未知)',
    });

    if (!info.category) {
      NS.warn('该教学班的类别代码未识别，任务可能无法执行', { 教学班ID: info.teachingClassID });
    }

    var task = NS.tasks.add({
      teachingClassID: info.teachingClassID,
      courseName: info.courseName,
      teacherName: info.teacherName,
      category: info.category || '',
    });
    if (!task) {
      toast('该教学班已在任务列表中');
      return false;
    }
    if (!NS.isWriteAllowed(s)) {
      toast('已加入任务列表（写接口未开启，暂时不会发请求）');
      NS.warn('写接口未开启，任务已入队但不执行');
    } else {
      toast('已加入任务列表：' + (info.courseName || info.teachingClassID));
    }
    if (NS.ui) NS.ui.render();
    return true;
  };

  /**
   * 「添加监控」：只读操作，不需要写接口开关。
   * 可反悔：已在监控列表中时再点即移除（按钮颜色随之变回）。
   * @returns {boolean} true=已加入，false=已移除/失败
   */
  L.addMonitor = function (info) {
    if (NS.monitor.has(info.teachingClassID)) {
      NS.monitor.remove(info.teachingClassID);
      toast('已取消监控：' + (info.courseName || info.teachingClassID));
      if (NS.ui) NS.ui.render();
      return false;
    }
    var s = NS.settings();
    NS.monitor.add({
      teachingClassID: info.teachingClassID,
      courseName: info.courseName,
      teacherName: info.teacherName,
      teachingPlace: info.teachingPlace,
      category: info.category || '',
      mode: s.monitorMode,
    });
    toast('已加入监控：' + (info.courseName || info.teachingClassID));
    if (NS.ui) NS.ui.render();
    return true;
  };

  /** 让监控按钮的文字与配色反映当前状态。 */
  function syncMonBtn(btn, tcId) {
    var on = NS.monitor.has(tcId);
    btn.textContent = on ? '移除监控' : '添加监控';
    if (on) btn.classList.add('szu-on');
    else btn.classList.remove('szu-on');
  }
  L.syncMonBtn = syncMonBtn;

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
    // 按钮文字直接反映状态，避免「蓝了不知道再点会取消」的困惑
    syncMonBtn(monBtn, info.teachingClassID);
    monBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      L.addMonitor(info); // 已在列表中则移除
      syncMonBtn(monBtn, info.teachingClassID);
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
      category: L.categoryOfNode(card),
    });
    if (point.before && point.before.parentNode === point.parent) {
      point.parent.insertBefore(block, point.before);
    } else {
      point.parent.appendChild(block);
    }
    return true;
  };

  /* ---------------- 形态二：新增「抢课模块」列 ---------------- */

  /**
   * 表头新增一列。
   * class 用 cv-normal 抑制站点的排序箭头；加 szu-flex-head 让表头改用 flex，
   * 与行保持同列宽（站点表头是兄弟节点、无 id，故用标记类定位）。
   */
  L.ensureHeadColumn = function (bodyId) {
    var body = root.document.getElementById(bodyId);
    if (!body) return false;
    var list = body.closest ? body.closest('.cv-list') : null;
    if (!list) return false;
    var head = list.querySelector('.cv-head');
    if (!head) return false;
    // 表头可能被站点重建，故类名与列都要按需补齐（幂等）
    var cls = head.getAttribute('class') || '';
    if (cls.indexOf('szu-flex-head') === -1) {
      head.setAttribute('class', (cls + ' szu-flex-head').trim());
    }
    if (head.getAttribute(DONE_HEAD) === '1') return false;
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
      category: L.categoryOfNode(row),
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
