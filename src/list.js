/**
 * P0：优化课程列表显示。
 *
 * 方案（用户指定）：课程卡片展示教学班ID + 减小行间距 + 两个按钮
 *   「添加抢课」「添加监控」。
 *
 * DOM 契约（取自 docs/grablessons.do.html 的 tpl-public-list-row / tpl-mooc-list-row）：
 *   <div class="cv-row">
 *     ...
 *     <div class="cv-setting-col...">
 *       <button class="cv-btn cv-tag">@volunteerText</button>
 *       <a class="cv-choice ..." tcId="@tcId" number="@number"
 *          isFull="@isFull" isConflict="@isConflict" ...>@selectCaption</a>
 *     </div>
 *   </div>
 *
 * 关键：tcId / number / isFull / isConflict **已经是 DOM 属性**，直接取用，无需额外请求。
 * 站点会异步重渲染列表，故用 MutationObserver 处理新增行。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var L = (NS.list = NS.list || {});

  var CSS_ID = 'szu-bkxk-p0-style';
  var DONE_ATTR = 'data-szu-p0';

  /** 注入样式：行距压缩（用户指定 line-height: 0.9）+ 按钮样式。 */
  L.injectStyle = function () {
    if (root.document.getElementById(CSS_ID)) return;
    var style = root.document.createElement('style');
    style.id = CSS_ID;
    style.textContent = [
      '.cv-row{line-height:0.9 !important;}',
      '.cv-row>div{line-height:0.9 !important;}',
      '.szu-tcid{font-size:12px;color:#888;line-height:0.9;margin-top:2px;word-break:break-all;}',
      '.szu-ops{display:flex;gap:4px;margin-top:3px;line-height:0.9;}',
      '.szu-btn{border:1px solid #4a90d9;background:#fff;color:#4a90d9;',
      'font-size:12px;line-height:1.4;padding:1px 6px;border-radius:3px;cursor:pointer;}',
      '.szu-btn:hover{background:#4a90d9;color:#fff;}',
      '.szu-btn.szu-on{background:#4a90d9;color:#fff;}',
      '.szu-btn[disabled]{opacity:.5;cursor:not-allowed;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(style);
  };

  /** 从一行 DOM 取课程信息。 */
  L.readRow = function (row) {
    var choice = row.querySelector('a.cv-choice[tcId]') || row.querySelector('[tcId]');
    if (!choice) return null;
    var tcId = choice.getAttribute('tcId');
    if (!tcId) return null;
    var titleEl = row.querySelector('.cv-title-col') || row.querySelector('.cv-course');
    var timeEl = row.querySelector('.cv-time-col span');
    var teacherEl = row.querySelector('.cv-teacher-col');
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

  /** 提示条（不依赖悬浮窗，P0 保持轻量）。 */
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

  /** 当前登录学号（从页面上下文尽力取，取不到让用户后续在设置里填）。 */
  L.studentCode = function () {
    var m = /studentCode["'\s:=]+(\d{6,})/.exec(root.document.documentElement.innerHTML);
    return m ? m[1] : '';
  };

  /**
   * 「添加抢课」：写接口关闭时**只打印报文不发送**（红线①）。
   */
  L.addGrab = function (info) {
    var s = NS.settings();
    var body = NS.api.buildVolunteerBody({
      studentCode: L.studentCode(),
      electiveBatchCode: s.batchCode,
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
      NS.warn('写接口未开启，「添加抢课」只构造并打印报文', {
        教学班ID: info.teachingClassID,
        课程: info.courseName,
      });
      return false;
    }
    NS.info('已加入抢课队列（本轮未实现执行）', info.teachingClassID);
    toast('已加入抢课任务：' + (info.courseName || info.teachingClassID));
    return true;
  };

  /**
   * 「添加监控」：只读操作，不需要写接口开关，直接生效。
   * 本轮只做入队 + 界面标记，实际轮询在执行阶段（P1）。
   */
  L.addMonitor = function (info) {
    var s = NS.settings();
    if (!s.batchCode) {
      toast('缺少 batchCode：请先到选课页加载列表，或在设置中手填。');
      NS.warn('添加监控失败：batchCode 为空');
      return false;
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

  /** 给一行注入教学班ID + 两个按钮。 */
  L.enhanceRow = function (row) {
    if (row.getAttribute(DONE_ATTR) === '1') return false;
    var info = L.readRow(row);
    if (!info) return false;
    row.setAttribute(DONE_ATTR, '1');

    var host = row.querySelector('.cv-setting-col') || row.querySelector('div:last-child') || row;
    if (!host) return false;

    var idEl = root.document.createElement('div');
    idEl.className = 'szu-tcid';
    idEl.textContent = info.teachingClassID;

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
    host.appendChild(idEl);
    host.appendChild(ops);
    return true;
  };

  /** 扫描全页并增强所有课程行。 */
  L.scan = function () {
    var rows = root.document.querySelectorAll('div.cv-row');
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      if (L.enhanceRow(rows[i])) n++;
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
