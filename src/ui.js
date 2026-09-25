/**
 * 悬浮窗：任务 / 监控 / 设置 / 日志。
 *
 * 形态（用户指定）：可拖拽浮动面板，默认右下角，可折叠。
 * 位置与折叠状态记在设置里。
 *
 * 红线①：写接口默认关闭；开启需二次确认，开启后界面常驻红色警示。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var U = (NS.ui = NS.ui || {});

  var PANEL_ID = 'szu-panel';
  var STYLE_ID = 'szu-panel-style';
  var TAB = { TASK: 'task', MONITOR: 'monitor', CUSTOM: 'custom', SETTING: 'setting', LOG: 'log' };
  var currentTab = TAB.TASK;

  function el(tag, cls, text) {
    var e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function button(text, cls, onClick) {
    var b = el('button', 'szu-p-but ' + (cls || ''), text);
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(ev);
    });
    return b;
  }

  U.injectStyle = function () {
    if (root.document.getElementById(STYLE_ID)) return;
    var s = root.document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#szu-panel{position:fixed;z-index:2147483000;width:420px;background:#fff;',
      'border:1px solid #c9dbef;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.25);',
      'font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#333;}',
      '#szu-panel *{box-sizing:border-box;}',
      '#szu-panel .szu-p-head{display:flex;align-items:center;gap:6px;padding:6px 8px;',
      'background:#047ADC;color:#fff;border-radius:5px 5px 0 0;cursor:move;user-select:none;}',
      '#szu-panel .szu-p-head .szu-p-title{flex:1 1 auto;font-weight:bold;white-space:nowrap;}',
      '#szu-panel .szu-p-head button{background:transparent;border:1px solid rgba(255,255,255,.6);',
      'color:#fff;border-radius:3px;cursor:pointer;font-size:12px;padding:0 6px;line-height:18px;}',
      '#szu-panel .szu-p-tabs{display:flex;border-bottom:1px solid #e2ecf7;background:#f7fbff;}',
      '#szu-panel .szu-p-tab{flex:1 1 auto;text-align:center;padding:5px 0;cursor:pointer;',
      'font-size:12px;color:#5b7ea6;border-right:1px solid #e2ecf7;}',
      '#szu-panel .szu-p-tab:last-child{border-right:none;}',
      '#szu-panel .szu-p-tab.on{background:#fff;color:#047ADC;font-weight:bold;',
      'box-shadow:inset 0 -2px 0 #047ADC;}',
      '#szu-panel .szu-p-body{padding:8px;max-height:56vh;overflow:auto;}',
      '#szu-panel .szu-p-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;}',
      '.szu-p-but{border:1px solid #047ADC;background:#fff;color:#047ADC;border-radius:3px;',
      'cursor:pointer;font-size:12px;padding:2px 8px;line-height:18px;}',
      '.szu-p-but:hover{background:#047ADC;color:#fff;}',
      '.szu-p-but.danger{border-color:#c0392b;color:#c0392b;}',
      '.szu-p-but.danger:hover{background:#c0392b;color:#fff;}',
      '.szu-p-but:disabled{opacity:.45;cursor:not-allowed;}',
      '#szu-panel .szu-p-task{border:1px solid #e2ecf7;border-radius:4px;padding:5px 6px;margin-bottom:5px;}',
      '#szu-panel .szu-p-task.szu-st-success{border-color:#27ae60;background:#f2fbf5;}',
      '#szu-panel .szu-p-task.szu-st-failed{border-color:#c0392b;background:#fdf3f2;}',
      '#szu-panel .szu-p-task.szu-st-running{border-color:#f39c12;background:#fffaf0;}',
      '#szu-panel .szu-p-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '#szu-panel .szu-p-id{font-family:Consolas,Menlo,monospace;color:#3d6ea5;}',
      '#szu-panel .szu-p-name{font-weight:bold;}',
      '#szu-panel .szu-p-msg{color:#888;word-break:break-all;}',
      '#szu-panel .szu-p-msg.err{color:#c0392b;}',
      '#szu-panel .szu-p-msg.ok{color:#27ae60;}',
      '#szu-panel select,#szu-panel input[type=text],#szu-panel input[type=number]{',
      'font-size:12px;padding:1px 3px;border:1px solid #c9dbef;border-radius:3px;}',
      '#szu-panel label{display:flex;align-items:center;gap:4px;margin:4px 0;}',
      '#szu-panel .szu-p-warn{background:#fdf3f2;border:1px solid #f0c4bf;color:#c0392b;',
      'padding:4px 6px;border-radius:3px;margin-bottom:6px;}',
      '#szu-panel .szu-p-ok{background:#f2fbf5;border:1px solid #bfe6cd;color:#1e7a45;',
      'padding:4px 6px;border-radius:3px;margin-bottom:6px;}',
      '#szu-panel .szu-p-log{font-family:Consolas,Menlo,monospace;font-size:11px;',
      'white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow:auto;background:#fafcff;',
      'border:1px solid #e2ecf7;border-radius:3px;padding:4px;}',
      '#szu-panel .szu-p-empty{color:#999;text-align:center;padding:14px 0;}',
      '#szu-panel .szu-p-sec{font-weight:bold;color:#047ADC;margin:8px 0 4px;}',
    ].join('');
    (root.document.head || root.document.documentElement).appendChild(s);
  };

  /* ---------------- 面板骨架 ---------------- */

  var panel = null;
  var bodyEl = null;

  function position(panelEl) {
    var s = NS.settings();
    var pos = s.panelPos;
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      panelEl.style.left = pos.left + 'px';
      panelEl.style.top = pos.top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    } else {
      panelEl.style.right = '16px';
      panelEl.style.bottom = '16px';
    }
  }

  function makeDraggable(handle, panelEl) {
    var dragging = false;
    var ox = 0;
    var oy = 0;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      dragging = true;
      var r = panelEl.getBoundingClientRect();
      ox = ev.clientX - r.left;
      oy = ev.clientY - r.top;
      // 固定为 left/top 定位，之后按位移更新
      panelEl.style.left = r.left + 'px';
      panelEl.style.top = r.top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      ev.preventDefault();
    });
    root.document.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      var w = panelEl.offsetWidth || 420;
      var h = panelEl.offsetHeight || 300;
      var left = Math.max(0, Math.min(ev.clientX - ox, (root.innerWidth || 1200) - w));
      var top = Math.max(0, Math.min(ev.clientY - oy, (root.innerHeight || 800) - 24));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
    });
    root.document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      NS.saveSettings({
        panelPos: { left: parseInt(panelEl.style.left, 10) || 0, top: parseInt(panelEl.style.top, 10) || 0 },
      });
    });
  }

  U.build = function () {
    if (root.document.getElementById(PANEL_ID)) return root.document.getElementById(PANEL_ID);
    U.injectStyle();

    var p = el('div');
    p.id = PANEL_ID;

    var head = el('div', 'szu-p-head');
    var title = el('span', 'szu-p-title', '深大选课助手');
    var btnCollapse = el('button', undefined, '—');
    var btnClose = el('button', undefined, '×');
    head.appendChild(title);
    head.appendChild(btnCollapse);
    head.appendChild(btnClose);

    var tabs = el('div', 'szu-p-tabs');
    var tabDefs = [
      [TAB.TASK, '任务'],
      [TAB.MONITOR, '监控'],
      [TAB.CUSTOM, '自定义'],
      [TAB.SETTING, '设置'],
      [TAB.LOG, '日志'],
    ];
    tabDefs.forEach(function (d) {
      var t = el('div', 'szu-p-tab', d[1]);
      t.setAttribute('data-tab', d[0]);
      t.addEventListener('click', function () {
        currentTab = d[0];
        U.render();
      });
      tabs.appendChild(t);
    });

    var body = el('div', 'szu-p-body');

    p.appendChild(head);
    p.appendChild(tabs);
    p.appendChild(body);

    btnCollapse.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var s = NS.settings();
      var next = !s.panelCollapsed;
      NS.saveSettings({ panelCollapsed: next });
      body.style.display = next ? 'none' : 'block';
      tabs.style.display = next ? 'none' : 'flex';
    });
    btnClose.addEventListener('click', function (ev) {
      ev.stopPropagation();
      p.style.display = 'none';
    });

    (root.document.body || root.document.documentElement).appendChild(p);
    position(p);
    makeDraggable(head, p);

    panel = p;
    bodyEl = body;
    return p;
  };

  /* ---------------- 渲染 ---------------- */

  function statusText(t) {
    if (t.status === NS.tasks.STATUS.SUCCESS) return '成功';
    if (t.status === NS.tasks.STATUS.FAILED) return '已停止';
    if (t.status === NS.tasks.STATUS.RUNNING) return '请求中';
    return t.enabled ? '等待' : '已禁用';
  }

  function renderTasks() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();

    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('开始抢课', '', function () {
      NS.tasks.start().then(function (r) {
        if (!r.ok) {
          var map = {
            'write-disabled': '写接口未开启：请到「设置」页开启后再开始。',
            'already-running': '已在运行中。',
            'no-task': '没有可执行的任务。',
          };
          NS.tasks.start && NS.ui.toast(map[r.reason] || '无法开始');
          U.render();
          return;
        }
        U.render();
      });
    }));
    bar.appendChild(button('停止', 'danger', function () {
      NS.tasks.stop();
      U.render();
    }));
    bar.appendChild(button('重置', '', function () {
      NS.tasks.reset();
      U.render();
    }));
    bar.appendChild(button('清空', 'danger', function () {
      if (root.confirm && !root.confirm('确定清空全部抢课任务？')) return;
      NS.tasks.stop();
      NS.tasks.clear();
      U.render();
    }));
    // 全局默认重试策略
    var modeSel = el('select');
    Object.keys(NS.tasks.MODE_NAME).forEach(function (m) {
      var o = el('option', undefined, '重试：' + NS.tasks.MODE_NAME[m]);
      o.value = m;
      if ((s.retryMode || 'smart') === m) o.setAttribute('selected', 'selected');
      modeSel.appendChild(o);
    });
    modeSel.value = s.retryMode || 'smart';
    modeSel.addEventListener('change', function () {
      NS.saveSettings({ retryMode: modeSel.value });
      for (var i = 0; i < NS.tasks.items.length; i++) NS.tasks.items[i].retryMode = modeSel.value;
    });
    bar.appendChild(modeSel);
    frag.appendChild(bar);

    if (NS.isWriteAllowed(s)) {
      frag.appendChild(el('div', 'szu-p-warn', '⚠ 写接口已开启：点「开始抢课」会真实提交选课请求。'));
    } else {
      frag.appendChild(el('div', 'szu-p-ok', '写接口关闭中：抢课只会打印报文，不会真正发送。'));
    }

    if (!NS.tasks.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无任务。到课程列表点「添加抢课」加入。'));
    }

    NS.tasks.items.forEach(function (t) {
      var cls = 'szu-p-task szu-st-' + (t.status === NS.tasks.STATUS.PENDING ? 'pending' : t.status);
      if (t.status === NS.tasks.STATUS.PENDING && !t.enabled) cls = 'szu-p-task';
      var box = el('div', cls);

      var l1 = el('div', 'szu-p-row');
      var cb = root.document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.enabled;
      cb.addEventListener('change', function () {
        NS.tasks.toggle(t.id);
        U.render();
      });
      l1.appendChild(cb);
      l1.appendChild(el('span', 'szu-p-name', t.courseName || '(未命名课程)'));
      l1.appendChild(el('span', 'szu-p-id', t.teachingClassID));
      l1.appendChild(el('span', undefined, NS.api.CATEGORY_NAME[t.category] || t.category || '类别未知'));
      l1.appendChild(el('span', undefined, statusText(t) + ' · ' + t.attempts + ' 次'));
      box.appendChild(l1);

      var l2 = el('div', 'szu-p-row');
      var pri = el('select');
      [['-1', '高'], ['0', '中'], ['1', '低']].forEach(function (p) {
        var o = el('option', undefined, '优先级' + p[1]);
        o.value = p[0];
        pri.appendChild(o);
      });
      pri.value = String(t.priority);
      pri.addEventListener('change', function () {
        NS.tasks.setPriority(t.id, Number(pri.value));
      });
      l2.appendChild(pri);

      var rm = el('select');
      Object.keys(NS.tasks.MODE_NAME).forEach(function (m) {
        var o = el('option', undefined, NS.tasks.MODE_NAME[m]);
        o.value = m;
        rm.appendChild(o);
      });
      rm.value = t.retryMode;
      rm.addEventListener('change', function () {
        NS.tasks.setRetryMode(t.id, rm.value);
      });
      l2.appendChild(rm);
      l2.appendChild(button('删除', 'danger', function () {
        NS.tasks.remove(t.id);
        U.render();
      }));
      box.appendChild(l2);

      if (t.lastMsg) {
        var mcls = 'szu-p-msg' + (t.status === NS.tasks.STATUS.SUCCESS ? ' ok' : (t.status === NS.tasks.STATUS.FAILED ? ' err' : ''));
        box.appendChild(el('div', mcls, t.lastMsg));
      }
      frag.appendChild(box);
    });

    return frag;
  }

  function renderMonitor() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();
    var isCat = (s.monitorMode !== 'single');

    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('开始监控', '', function () {
      if (!NS.monitor.items.length) { U.toast('监控列表为空，请先在课程列表点「添加监控」'); return; }
      NS.monitor.startPolling();
      U.render();
    }));
    bar.appendChild(button('停止监控', 'danger', function () {
      NS.monitor.stopPolling();
      U.render();
    }));
    bar.appendChild(button('检查一次', '', function () {
      if (!NS.monitor.items.length) { U.toast('监控列表为空'); return; }
      U.toast('检查中…');
      NS.monitor.pollOnce().then(function (r) {
        U.toast('检查完成，命中 ' + (r.hits ? r.hits.length : 0) + ' 个有余量');
        U.render();
      });
    }));
    bar.appendChild(button('清空', 'danger', function () {
      NS.monitor.stopPolling();
      NS.monitor.items = [];
      U.render();
    }));
    frag.appendChild(bar);

    // 监控模式
    var modeRow = el('div', 'szu-p-bar');
    modeRow.appendChild(el('span', undefined, '模式：'));
    var ms = el('select');
    [['category', '类别监控（拉类别列表，一次拿一类）'], ['single', '单独监控（逐课查容量，精确）']].forEach(function (m) {
      var o = el('option', undefined, m[1]); o.value = m[0]; ms.appendChild(o);
    });
    ms.value = s.monitorMode || 'category';
    ms.addEventListener('change', function () {
      NS.saveSettings({ monitorMode: ms.value });
      NS.monitor.stopPolling();
      U.toast('已切换为' + (ms.value === 'category' ? '类别监控' : '单独监控') + '，轮询已停止');
      U.render();
    });
    modeRow.appendChild(ms);
    frag.appendChild(modeRow);

    var iv = NS.util.clamp(s.pollIntervalMs, 1000, 60000, 5000);
    var state = NS.monitor.polling
      ? ('运行中（' + (isCat ? '类别' : '单独') + '模式，每 ' + iv + 'ms 一轮，已完成 ' + NS.monitor.pollCount + ' 轮，命中 ' + NS.monitor.hitCount + ' 次）')
      : '未运行';
    frag.appendChild(el('div', 'szu-p-ok', '轮询状态：' + state));
    if (NS.monitor.lastPollAt) {
      frag.appendChild(el('div', 'szu-p-msg', '上次检查：' + new Date(NS.monitor.lastPollAt).toLocaleTimeString()));
    }
    frag.appendChild(el('div', 'szu-p-msg', isCat
      ? '类别监控端点：programCourse.do / publicCourse.do 等；余量 = 课容量 − 已选人数'
      : '单独监控端点：teachingclass/capacity.do；余量 = mainClassCapacity − mainElectiveNumber'));

    if (!NS.isWriteAllowed(s)) {
      frag.appendChild(el('div', 'szu-p-warn', '写接口关闭中：命中余量只会提醒，不会自动抢。'));
    } else {
      frag.appendChild(el('div', 'szu-p-warn', '⚠ 写接口已开启：命中余量会自动提交抢课请求。'));
    }

    if (!NS.monitor.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无监控项。到课程列表点「添加监控」加入。'));
    }
    NS.monitor.items.forEach(function (m) {
      var box = el('div', 'szu-p-task');
      var l1 = el('div', 'szu-p-row');
      l1.appendChild(el('span', 'szu-p-name', m.courseName || '(未命名)'));
      l1.appendChild(el('span', 'szu-p-id', m.teachingClassID));
      l1.appendChild(el('span', undefined, NS.api.CATEGORY_NAME[m.category] || m.category || '类别未知'));
      box.appendChild(l1);
      var l2 = el('div', 'szu-p-row');
      l2.appendChild(button('立即抢一次', '', function () {
        NS.monitor.grabNow(m).then(function (r) {
          U.toast(r.ok ? '已抢成功' : ('未成功：' + (r.msg || r.reason)));
          U.render();
        });
      }));
      l2.appendChild(button('移除', 'danger', function () {
        NS.monitor.remove(m.teachingClassID);
        U.render();
      }));
      box.appendChild(l2);
      var remain = m.remain;
      var txt = remain === null || remain === undefined
        ? (m.checkedAt ? '余量：未能取到（字段缺失或未匹配到该教学班）' : '尚未检查')
        : ('余量 ' + remain + (remain > 0 ? '（有空位）' : '（已满）'));
      box.appendChild(el('div', 'szu-p-msg' + (remain > 0 ? ' ok' : ''), txt));
      if (m.lastMsg) box.appendChild(el('div', 'szu-p-msg err', m.lastMsg));
      frag.appendChild(box);
    });
    return frag;
  }

  function renderCustom() {
    var frag = root.document.createDocumentFragment();

    frag.appendChild(el('div', 'szu-p-sec', '新增自定义课程'));
    frag.appendChild(el('div', 'szu-p-msg',
      '时间写法示例：5-18周 星期二 3-4节 致理楼L1-707（逗号可分隔多段；' +
      '单周写 (单)、双周写 (双)）'));

    var nameIn = root.document.createElement('input');
    nameIn.type = 'text';
    nameIn.placeholder = '课程名';
    nameIn.style.width = '100%';
    var teacherIn = root.document.createElement('input');
    teacherIn.type = 'text';
    teacherIn.placeholder = '教师（可空）';
    teacherIn.style.width = '100%';
    var placeIn = root.document.createElement('input');
    placeIn.type = 'text';
    placeIn.placeholder = '时间地点';
    placeIn.style.width = '100%';

    [nameIn, teacherIn, placeIn].forEach(function (i) {
      var row = el('div', 'szu-p-row');
      row.style.margin = '3px 0';
      row.appendChild(i);
      frag.appendChild(row);
    });

    var addBar = el('div', 'szu-p-bar');
    addBar.appendChild(button('添加', '', function () {
      var name = String(nameIn.value || '').trim();
      var place = String(placeIn.value || '').trim();
      if (!name) { U.toast('请填课程名'); return; }
      if (!place) { U.toast('请填时间地点'); return; }
      if (!NS.time.parse(place).length) {
        U.toast('时间格式无法解析，请按示例填写（如 5-18周 星期二 3-4节 地点）');
        return;
      }
      NS.custom.add({ name: name, teacher: String(teacherIn.value || '').trim(), place: place });
      nameIn.value = '';
      teacherIn.value = '';
      placeIn.value = '';
      U.toast('已添加');
      U.render();
      if (NS.timetable) NS.timetable.render();
    }));
    frag.appendChild(addBar);

    var sc = NS.custom.selfConflicts();
    if (sc.length) {
      frag.appendChild(el('div', 'szu-p-warn',
        '注意：自定义课程之间有 ' + sc.length + ' 处时间冲突'));
    }

    frag.appendChild(el('div', 'szu-p-sec', '已添加（' + NS.custom.items.length + ' 门）'));
    if (!NS.custom.items.length) {
      frag.appendChild(el('div', 'szu-p-empty', '暂无自定义课程。到课表页也会显示这些课。'));
    }
    NS.custom.items.forEach(function (c) {
      var box = el('div', 'szu-p-task');
      var l1 = el('div', 'szu-p-row');
      var cb = root.document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.enabled;
      cb.addEventListener('change', function () {
        NS.custom.update(c.id, { enabled: cb.checked });
        U.render();
        if (NS.timetable) NS.timetable.render();
      });
      l1.appendChild(cb);
      l1.appendChild(el('span', 'szu-p-name', c.name));
      if (c.segs.length) {
        l1.appendChild(el('span', undefined, '解析出 ' + c.segs.length + ' 段'));
      } else {
        l1.appendChild(el('span', 'szu-p-msg err', '时间未解析'));
      }
      box.appendChild(l1);
      box.appendChild(el('div', 'szu-p-msg', (c.teacher ? c.teacher + '　' : '') + c.place));
      var l2 = el('div', 'szu-p-row');
      l2.appendChild(button('删除', 'danger', function () {
        NS.custom.remove(c.id);
        U.render();
        if (NS.timetable) NS.timetable.render();
      }));
      box.appendChild(l2);
      frag.appendChild(box);
    });

    var bar2 = el('div', 'szu-p-bar');
    bar2.appendChild(button('清空全部', 'danger', function () {
      if (root.confirm && !root.confirm('确定清空全部自定义课程？')) return;
      NS.custom.clear();
      U.render();
      if (NS.timetable) NS.timetable.render();
    }));
    bar2.appendChild(button('刷新课表注入', '', function () {
      if (!NS.timetable) return;
      var n = NS.timetable.render();
      U.toast(n ? ('已注入 ' + n + ' 段') : '未找到课表容器（请到课表页使用）');
    }));
    frag.appendChild(bar2);

    return frag;
  }

  function renderSetting() {
    var frag = root.document.createDocumentFragment();
    var s = NS.settings();
    var ctx = NS.list.sessionContext();

    frag.appendChild(el('div', 'szu-p-sec', '写接口（红线①：默认关闭，不得改默认值）'));
    var wrap = el('div');
    var cb = root.document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = NS.isWriteAllowed(s);
    cb.addEventListener('change', function () {
      if (cb.checked) {
        var ok = !root.confirm || root.confirm(
          '开启写接口后，点「开始抢课」会真实提交选课请求，风险由你自负。\n\n确认开启？'
        );
        if (!ok) { cb.checked = false; return; }
        NS.saveSettings({ writeApiEnabled: true });
        NS.warn('写接口已开启');
      } else {
        NS.saveSettings({ writeApiEnabled: false });
        NS.info('写接口已关闭');
      }
      U.render();
    });
    var lab = el('label');
    lab.appendChild(cb);
    lab.appendChild(el('span', undefined, '启用写接口（真实发请求）'));
    wrap.appendChild(lab);
    frag.appendChild(wrap);

    frag.appendChild(el('div', 'szu-p-sec', '会话信息（来自页面 sessionStorage）'));
    var kv = el('div');
    kv.appendChild(el('div', undefined, '学号：' + (ctx.studentCode || '(未取到)')));
    kv.appendChild(el('div', undefined, '批次码：' + (ctx.batchCode || '(未取到)')));
    kv.appendChild(el('div', undefined, '校区：' + ctx.campus));
    frag.appendChild(kv);
    var rb = el('div', 'szu-p-bar');
    rb.appendChild(button('重新获取', '', function () {
      var c2 = NS.list.sessionContext();
      if (c2.batchCode) {
        NS.saveSettings({ batchCode: c2.batchCode });
        U.toast('已取到批次码：' + c2.batchCode);
      } else {
        U.toast('页面 sessionStorage 里没有批次码，请刷新选课页');
      }
      U.render();
    }));
    rb.appendChild(button('清空保存的批次码', '', function () {
      NS.saveSettings({ batchCode: '' });
      U.toast('已清空');
      U.render();
    }));
    frag.appendChild(rb);

    frag.appendChild(el('div', 'szu-p-sec', '时间参数'));
    frag.appendChild(numberRow('请求间隔(ms，硬下限 200)', 'intervalMs', 200, 60000, function (v) {
      NS.saveSettings({ intervalMs: v });
      NS.queue.intervalMs = Math.min(60000, Math.max(200, v));
    }));
    frag.appendChild(numberRow('抢课重试间隔(ms)', 'retryIntervalMs', 500, 60000, function (v) {
      NS.saveSettings({ retryIntervalMs: v });
    }));
    frag.appendChild(numberRow('监控轮询间隔(ms)', 'pollIntervalMs', 1000, 60000, function (v) {
      NS.saveSettings({ pollIntervalMs: v });
    }));

    frag.appendChild(el('div', 'szu-p-sec', '监控模式'));
    var ms = el('select');
    [['category', '类别监控（默认）'], ['single', '单独监控']].forEach(function (m) {
      var o = el('option', undefined, m[1]); o.value = m[0]; ms.appendChild(o);
    });
    ms.value = s.monitorMode || 'category';
    ms.addEventListener('change', function () { NS.saveSettings({ monitorMode: ms.value }); });
    frag.appendChild(ms);

    return frag;
  }

  function numberRow(labelText, key, min, max, onChange) {
    var s = NS.settings();
    var row = el('label');
    row.appendChild(el('span', undefined, labelText + '：'));
    var inp = root.document.createElement('input');
    inp.type = 'number';
    inp.value = String(s[key]);
    inp.style.width = '80px';
    inp.addEventListener('change', function () {
      var v = NS.util.clamp(inp.value, min, max, Number(s[key]) || min);
      inp.value = String(v);
      onChange(v);
      U.toast('已保存');
    });
    row.appendChild(inp);
    return row;
  }

  function renderLog() {
    var frag = root.document.createDocumentFragment();
    var bar = el('div', 'szu-p-bar');
    bar.appendChild(button('刷新', '', function () { U.render(); }));
    bar.appendChild(button('清空', 'danger', function () { NS.LOG.buf.length = 0; U.render(); }));
    bar.appendChild(button('复制到控制台', '', function () {
      console.log('%c[SZUBKXK 日志]\n' + NS.LOG.buf.join('\n'), 'color:#047ADC');
      U.toast('已输出到控制台');
    }));
    frag.appendChild(bar);
    var pre = el('div', 'szu-p-log', NS.LOG.buf.length ? NS.LOG.buf.join('\n') : '(暂无日志)');
    frag.appendChild(pre);
    return frag;
  }

  U.render = function () {
    if (!panel) return;
    var tabs = panel.querySelectorAll('.szu-p-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === currentTab;
      tabs[i].className = 'szu-p-tab' + (on ? ' on' : '');
    }
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    bodyEl.appendChild(
      currentTab === TAB.TASK ? renderTasks()
        : currentTab === TAB.MONITOR ? renderMonitor()
          : currentTab === TAB.CUSTOM ? renderCustom()
            : currentTab === TAB.SETTING ? renderSetting()
              : renderLog()
    );
  };

  U.toast = function (msg) {
    if (NS.list && NS.list.toast) NS.list.toast(msg);
  };

  U.start = function () {
    var p = U.build();
    var s = NS.settings();
    if (s.panelCollapsed) {
      var b = p.querySelector('.szu-p-body');
      var t = p.querySelector('.szu-p-tabs');
      if (b) b.style.display = 'none';
      if (t) t.style.display = 'none';
    }
    U.render();
    // 任务运行中时定期刷新界面（显示尝试次数与状态）
    setInterval(function () {
      if (NS.tasks.running) U.render();
    }, 1000);
    NS.info('悬浮窗已就绪');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
