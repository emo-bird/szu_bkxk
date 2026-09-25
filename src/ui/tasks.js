/**
 * 任务管理界面：新建任务、任务列表、单个任务的开始/停止/删除。
 *
 * 【P0 功能】这是悬浮窗里最要紧的一块（见 docs/方案-油猴脚本.md §6.2）。
 *
 * 【设计】纯 DOM 构建，文本一律 textContent；所有事件回调包 try/catch，
 *   异常绝不冒泡到站点页面（沿用桌面版"槽函数必须兜底"的教训）。
 *
 * 【本版取舍】新建任务用内联表单而不是弹窗对话框 —— 少一次 DOM 层级，
 *   真机上更容易验证；等 M2 收尾再考虑换成模态对话框。
 *
 * 依赖：NS.task / NS.log（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var TV = (UI.tasks = UI.tasks || {});

  /** 课程类别（逆向记录 §3.1 的 7 个类别）。 */
  TV.CATEGORIES = [
    { code: 'FANKC', label: '方案内' },
    { code: 'FAWKC', label: '方案外' },
    { code: 'TJKC', label: '本班' },
    { code: 'XGXK', label: '校公选' },
    { code: 'TYKC', label: '体育' },
    { code: 'FXKC', label: '辅修' },
    { code: 'MOOC', label: '慕课' },
  ];

  /**
   * 解析"一行一个教学班ID"的文本（去空行、去重、保持顺序）。
   * @param {string} text 多行文本
   * @returns {string[]} 教学班ID 数组
   */
  TV.parseTargetIds = function (text) {
    if (typeof text !== 'string') return [];
    var seen = {};
    var out = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var id = String(lines[i]).trim();
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  };

  /**
   * 把 `HH:MM[:SS]` 输入解析成**服务器时间基准**的毫秒时间戳。
   * 已过今天该时刻则视为明天（避免用户填了时间却发现"立刻开始"）。
   * @param {string} value 时间输入值
   * @param {object} [clock] NS.schedule.Clock（未提供则用本机时间）
   * @returns {(number|null)} 目标时刻；输入为空/非法时返回 null（= 立即开始）
   */
  TV.timeInputToServerMs = function (value, clock) {
    if (!value || typeof value !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
    if (!m) return null;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    var s = Number(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;

    var nowServer = clock && clock.serverNow ? clock.serverNow() : Date.now();
    var d = new Date(nowServer);
    d.setHours(h, mi, s, 0);
    var ms = d.getTime();
    if (ms <= nowServer) ms += 24 * 60 * 60 * 1000; // 已过 → 明天同一时刻
    return ms;
  };

  /** 建元素的小工具。 */
  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 造一个下拉框。 */
  function select(doc, options, value) {
    var s = doc.createElement('select');
    s.className = 'szubkxk-input';
    options.forEach(function (o) {
      var opt = doc.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }

  /**
   * 创建任务管理区块。
   * @param {object} options {doc, runner, logger, clock}
   * @returns {{element:Element, refresh:Function}}
   */
  TV.create = function (options) {
    options = options || {};
    var doc = options.doc;
    var runner = options.runner;
    var logger = options.logger;
    var clock = options.clock || null;

    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '抢课任务'));

    /* ---------------- 工具条 ---------------- */
    var bar = el(doc, 'div', 'szubkxk-row');
    var btnStartAll = el(doc, 'button', 'szubkxk-btn', '开始全部');
    btnStartAll.type = 'button';
    var btnStopAll = el(doc, 'button', 'szubkxk-btn', '停止全部');
    btnStopAll.type = 'button';
    var btnToggleForm = el(doc, 'button', 'szubkxk-btn', '＋ 新建任务');
    btnToggleForm.type = 'button';
    bar.appendChild(btnStartAll);
    bar.appendChild(btnStopAll);
    bar.appendChild(btnToggleForm);
    sec.appendChild(bar);

    /* ---------------- 新建表单 ---------------- */
    var form = el(doc, 'div', 'szubkxk-form szubkxk-hidden');

    var rowName = el(doc, 'div', 'szubkxk-row');
    rowName.appendChild(el(doc, 'span', 'szubkxk-muted', '备注'));
    var inputName = doc.createElement('input');
    inputName.type = 'text';
    inputName.className = 'szubkxk-input szubkxk-input-wide';
    inputName.placeholder = '例如：抢高数';
    rowName.appendChild(inputName);
    form.appendChild(rowName);

    var rowKind = el(doc, 'div', 'szubkxk-row');
    rowKind.appendChild(el(doc, 'span', 'szubkxk-muted', '类型'));
    var selKind = select(
      doc,
      [
        { value: 'grab', label: '单志愿抢课' },
        { value: 'monitor', label: '多志愿监控' },
      ],
      'monitor'
    );
    rowKind.appendChild(selKind);
    rowKind.appendChild(el(doc, 'span', 'szubkxk-muted', '类别'));
    var selCat = select(
      doc,
      TV.CATEGORIES.map(function (c) {
        return { value: c.code, label: c.label + '(' + c.code + ')' };
      }),
      'XGXK'
    );
    rowKind.appendChild(selCat);
    form.appendChild(rowKind);

    var rowTime = el(doc, 'div', 'szubkxk-row');
    rowTime.appendChild(el(doc, 'span', 'szubkxk-muted', '开始时间(可空=立即)'));
    var inputTime = doc.createElement('input');
    inputTime.type = 'time';
    inputTime.step = '1';
    inputTime.className = 'szubkxk-input';
    rowTime.appendChild(inputTime);
    rowTime.appendChild(el(doc, 'span', 'szubkxk-muted', '间隔ms'));
    var inputInterval = doc.createElement('input');
    inputInterval.type = 'number';
    inputInterval.className = 'szubkxk-input';
    inputInterval.value = '1500';
    inputInterval.min = '200';
    rowTime.appendChild(inputInterval);
    form.appendChild(rowTime);

    var rowStrategy = el(doc, 'div', 'szubkxk-row');
    rowStrategy.appendChild(el(doc, 'span', 'szubkxk-muted', '满课策略'));
    var selStrategy = select(
      doc,
      [
        { value: 'stop', label: '满课后停止' },
        { value: 'keep', label: '满课继续轮询' },
      ],
      'stop'
    );
    rowStrategy.appendChild(selStrategy);
    form.appendChild(rowStrategy);

    form.appendChild(el(doc, 'div', 'szubkxk-muted', '教学班ID（一行一个）'));
    var inputTargets = doc.createElement('textarea');
    inputTargets.className = 'szubkxk-textarea';
    inputTargets.rows = 3;
    inputTargets.placeholder = '一行填一个教学班ID';
    form.appendChild(inputTargets);

    var rowSubmit = el(doc, 'div', 'szubkxk-row');
    var btnSubmit = el(doc, 'button', 'szubkxk-btn', '添加');
    btnSubmit.type = 'button';
    rowSubmit.appendChild(btnSubmit);
    form.appendChild(rowSubmit);
    sec.appendChild(form);

    /* ---------------- 任务列表 ---------------- */
    var list = el(doc, 'div', 'szubkxk-tasks');
    sec.appendChild(list);

    /* ---------------- 行为 ---------------- */

    function safe(fn, label) {
      return function (ev) {
        try {
          fn(ev);
        } catch (e) {
          if (logger) logger.error(NS.log.CATEGORY.SYSTEM, '任务界面操作失败：' + label, (e && e.message) || e);
        }
      };
    }

    btnToggleForm.addEventListener(
      'click',
      safe(function () {
        form.classList.toggle('szubkxk-hidden');
      }, '切换新建表单')
    );

    btnSubmit.addEventListener(
      'click',
      safe(function () {
        if (!runner) return;
        var ids = TV.parseTargetIds(inputTargets.value);
        if (ids.length === 0) {
          if (logger) logger.warn(NS.log.CATEGORY.SYSTEM, '没有填写教学班ID，未创建任务');
          return;
        }
        var category = selCat.value;
        var task = runner.add({
          name: inputName.value,
          kind: selKind.value,
          startAt: TV.timeInputToServerMs(inputTime.value, clock),
          intervalMs: Number(inputInterval.value),
          fullStrategy: selStrategy.value,
          targets: ids.map(function (id) {
            return { teachingClassId: id, teachingClassType: category };
          }),
        });
        if (logger) {
          logger.info(
            NS.log.CATEGORY.SYSTEM,
            '已创建任务：' + (task.name || task.id) + '（' + task.targets.length + ' 个教学班，' + NS.task.KIND_LABEL[task.kind] + '）'
          );
        }
        inputName.value = '';
        inputTargets.value = '';
        inputTime.value = '';
        refresh();
      }, '添加任务')
    );

    btnStartAll.addEventListener(
      'click',
      safe(function () {
        if (!runner) return;
        runner.start();
        if (logger) logger.info(NS.log.CATEGORY.SYSTEM, '已开始全部任务（写开关：' + (runner.getSettings().writeApiEnabled ? '开' : '关') + '）');
        refresh();
      }, '开始全部')
    );

    btnStopAll.addEventListener(
      'click',
      safe(function () {
        if (!runner) return;
        runner.stop('用户手动停止');
        refresh();
      }, '停止全部')
    );

    /** 重绘任务列表。 */
    function refresh() {
      if (!list) return;
      while (list.firstChild) list.removeChild(list.firstChild);
      var tasks = (runner && runner.tasks) || [];
      if (tasks.length === 0) {
        list.appendChild(el(doc, 'div', 'szubkxk-muted', '暂无任务'));
        return;
      }
      tasks.forEach(function (task) {
        list.appendChild(renderRow(task));
      });
    }

    /** 渲染一行任务。 */
    function renderRow(task) {
      var row = el(doc, 'div', 'szubkxk-task');
      var running = task.status === NS.task.STATUS.RUNNING || task.status === NS.task.STATUS.WAITING;

      var line1 = el(doc, 'div', 'szubkxk-task-line');
      line1.appendChild(el(doc, 'span', 'szubkxk-task-name', NS.task.display(task, 'name')));
      line1.appendChild(el(doc, 'span', 'szubkxk-muted', ' ' + NS.task.KIND_LABEL[task.kind]));
      row.appendChild(line1);

      var line2 = el(doc, 'div', 'szubkxk-task-line szubkxk-muted');
      line2.textContent =
        '目标 ' +
        NS.task.display(task, 'targetsText') +
        ' · ' +
        NS.task.display(task, 'intervalText') +
        ' · ' +
        NS.task.display(task, 'startAtText');
      row.appendChild(line2);

      var line3 = el(doc, 'div', 'szubkxk-task-line');
      var statusSpan = el(doc, 'span', task.status === NS.task.STATUS.SUCCESS ? 'szubkxk-ok' : 'szubkxk-muted');
      statusSpan.textContent = NS.task.display(task, 'statusText');
      line3.appendChild(statusSpan);

      var btnToggle = el(doc, 'button', 'szubkxk-btn', running ? '停止' : '开始');
      btnToggle.type = 'button';
      btnToggle.addEventListener(
        'click',
        safe(function () {
          if (running) runner.stopTask(task.id);
          else runner.startTask(task.id);
          refresh();
        }, '启停任务')
      );
      line3.appendChild(btnToggle);

      var btnDel = el(doc, 'button', 'szubkxk-btn szubkxk-danger', '删除');
      btnDel.type = 'button';
      btnDel.addEventListener(
        'click',
        safe(function () {
          runner.remove(task.id);
          refresh();
        }, '删除任务')
      );
      line3.appendChild(btnDel);
      row.appendChild(line3);
      return row;
    }

    refresh();
    return { element: sec, refresh: refresh };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
