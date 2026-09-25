/**
 * P0：优化课程列表显示。
 *
 * 方案（用户指定）：课程卡片展示教学班ID + 减小行间距 + 两个按钮
 *   「添加抢课」「添加监控」。
 *
 * DOM 契约（取自 docs/grablessons.do.html 的模板）：
 *   - tpl-public-list-row / tpl-mooc-list-row：**行即教学班**，直接带 tcId/number/isFull
 *   - tpl-program/unprogram/recommend/minor/retake/sport-list-row：**行是课程**，
 *     教学班藏在响应 tcList 里，点「课程详情」才展开（见 intercept.js）
 *
 * 站点会异步重渲染列表，故用 MutationObserver 处理新增行。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = NS.list || {});

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_ATTR = 'data-szu-p0';

  /**
   * 注入样式。
   * 【关键】行距 0.9（用户指定）+ 强制换行约束，避免长课程名溢出卡片。
   */
  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      // 行距压缩
      '.cv-row,.cv-row>div{line-height:.9 !important;}',
      // 长内容不溢出：允许在任意字符处换行，并约束在容器内
      '.cv-row>div{word-break:break-all;overflow-wrap:anywhere;min-width:0;}',
      '.cv-row{box-sizing:border-box;}',
      // 我们注入的一整行：横向排布，单独占一行
      '.szu-bar{display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:6px;',
      'width:100%;box-sizing:border-box;padding:2px 8px;line-height:1.2;',
      'background:#f6f9fd;border-top:1px dashed #d6e4f5;font-size:12px;}',
      '.szu-tcid{color:#5b7ea6;font-family:Consolas,Menlo,monospace;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%;}',
      '.szu-ops{display:flex;flex-direction:row;gap:6px;flex:0 0 auto;}',
      '.szu-btn{border:1px solid #4a90d9;background:#fff;color:#4a90d9;',
      'font-size:12px;line-height:1.5;padding:1px 8px;border-radius:3px;cursor:pointer;',
      'white-space:nowrap;flex:0 0 auto;}',
      '.szu-btn:hover{background:#4a90d9;color:#fff;}',
      '.szu-btn.szu-on{background:#4a90d9;color:#fff;}',
      '.szu-list-row{display:block !important;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(style);
  };

  /**
   * 从一行 DOM 取教学班信息。
   * 优先用 tcId 属性；没有 tcId 的行（课程级）返回 null，由 intercept 模块处理。
   */
  L.readRow = function (row) {
    var choice = row.querySelector('a.cv-choice[tcId]') || row.querySelector('[tcId]');
    if (!choice) return null;
    var tcId = choice.getAttribute('tcId');
    if (!tcId) return null;
    var titleEl = row.querySelector('.cv-title-col') || row.querySelector('.cv-course') || row.querySelector('.cv-school-title-col');
    var timeEl = row.querySelector('.cv-time-col span');
    var teacherEl = row.querySelector('.cv-teacher-col') || row.querySelector('.cv-school-teacher-col');
    return {
      teachingClassID: tcId,
      courseIndex: choice.getAttribute('number') || '',
      isFull: choice.getAttribute('isFull') || '',
      isConflict: choice.getAttribute('isConflict') || '',
      courseName: NS.util.text(titleEl),
      teacherName: NS.util.text(teacherEl),
      teachingPlace: timeEl ? String(timeEl.getAttribute('title') || timeEl.textContent || '').trim() : '',
      row: row,
    };
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

  /** 当前登录学号：站点把它放在 sessionStorage.studentInfo 里。 */
  L.studentCode = function () {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('studentInfo');
      if (raw) {
        var info = JSON.parse(raw);
        if (info && info.code) return String(info.code);
      }
    } catch (e) { /* 忽略 */ }
    var m = /"code"\s*:\s*"(\d{6,})"/.exec(root.document.documentElement.innerHTML);
    return m ? m[1] : '';
  };

  /** 会话 token：站点放在 sessionStorage.token。 */
  L.token = function () {
    try {
      return (root.sessionStorage && root.sessionStorage.getItem('token')) || '';
    } catch (e) {
      return '';
    }
  };

  /** 当前批次码：站点放在 sessionStorage.currentBatch。 */
  L.currentBatch = function () {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem('currentBatch');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
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
    NS.info('已加入抢课队列（本轮未实现执行）', info.teachingClassID);
    toast('已加入抢课任务：' + (info.courseName || info.teachingClassID));
    return true;
  };

  /**
   * 「添加监控」：只读操作，不需要写接口开关，直接生效。
   */
  L.addMonitor = function (info) {
    var s = NS.settings();
    var batch = L.currentBatch();
    if (!s.batchCode && !(batch && batch.code) && !NS.monitor.has(info.teachingClassID)) {
      // 允许添加，只是首次查询时会提示缺 batchCode
      NS.warn('batchCode 暂缺，监控将在拿到批次码后开始查询');
    }
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

  /** 构建「ID + 两个按钮」横向条。 */
  L.buildBar = function (info) {
    var bar = root.document.createElement('div');
    bar.className = 'szu-bar';

    var idEl = root.document.createElement('span');
    idEl.className = 'szu-tcid';
    idEl.title = info.teachingClassID;
    idEl.textContent = info.teachingClassID;

    var ops = root.document.createElement('span');
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
    bar.appendChild(idEl);
    bar.appendChild(ops);
    return bar;
  };

  /**
   * 给一行注入「ID + 按钮」横向条。
   * 【关键】条占**课程下方一整行**，不再塞进「操作」列。
   * 用 nextElementSibling 而非 nextSibling：真实 DOM 里行之间夹着空白文本节点，
   * 用 nextSibling 会把条插到文本节点前面，位置不可控。
   */
  L.enhanceRow = function (row) {
    if (row.getAttribute(DONE_ATTR) === '1') return false;
    var info = L.readRow(row);
    if (!info) return false;
    row.setAttribute(DONE_ATTR, '1');
    var bar = L.buildBar(info);
    if (row.parentNode) row.parentNode.insertBefore(bar, row.nextElementSibling || null);
    return true;
  };

  /** 扫描并增强所有带 tcId 的行（复制 DOM 列表再遍历，避免插入子节点影响遍历）。 */
  L.scan = function () {
    var rows = root.document.querySelectorAll('div.cv-row');
    var list = [];
    for (var i = 0; i < rows.length; i++) list.push(rows[i]);
    var n = 0;
    for (var j = 0; j < list.length; j++) {
      if (L.enhanceRow(list[j])) n++;
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
      }, 120);
    });
    mo.observe(root.document.body, { childList: true, subtree: true });
  };

  /** 入口。 */
  L.start = function () {
    L.injectStyle();
    var n = L.scan();
    L.observe();
    NS.info('P0 课程列表优化已启动，首屏增强 ' + n + ' 行');
    return n;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
