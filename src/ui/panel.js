/**
 * 悬浮窗宿主：拖动、折叠、隐藏/唤出、设置、日志、会话状态。
 *
 * 【形态取舍】普通顶层 div + `szubkxk-` 前缀类名 + 局部样式重置，
 * **不用 shadow DOM** —— 因为站点自带库（jQWidgets 等）的主题 CSS 不会进入 shadow root，
 * 与"复用站点自带库"的目标冲突。详见 docs/方案-油猴脚本.md §6.1。
 *
 * 【纪律】
 *   - 所有文本一律 textContent 写入（日志里会出现服务器返回原文，不能 innerHTML）；
 *   - 事件回调里的异常不得冒泡到站点页面（沿用桌面版"槽函数必须兜底"的教训）；
 *   - 日志过滤**只影响显示**，Logger 内部始终保留全部分类。
 *
 * 依赖：NS.util / NS.log / NS.session / NS.ui.styles（均在函数体内延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var P = (UI.panel = UI.panel || {});

  /** 面板与视口边缘的最小间距（px）。 */
  P.MARGIN = 8;

  /** 面板根节点 id。 */
  P.ROOT_ID = 'szubkxk-root';

  /**
   * 把面板位置钳位到视口内（**纯函数，可离线单测**）。
   * @param {number} left 期望左边距
   * @param {number} top 期望上边距
   * @param {number} width 面板宽度
   * @param {number} height 面板高度
   * @param {object} viewport {width, height}
   * @returns {{left:number, top:number}} 钳位后的位置
   */
  function clampPosition(left, top, width, height, viewport) {
    var vw = viewport && viewport.width ? viewport.width : 0;
    var vh = viewport && viewport.height ? viewport.height : 0;
    var maxLeft = Math.max(P.MARGIN, vw - width - P.MARGIN);
    var maxTop = Math.max(P.MARGIN, vh - height - P.MARGIN);
    return {
      left: NS.util.clamp(left, P.MARGIN, maxLeft, P.MARGIN),
      top: NS.util.clamp(top, P.MARGIN, maxTop, P.MARGIN),
    };
  }
  P.clampPosition = clampPosition;

  /** 建元素的小工具（文本一律走 textContent）。 */
  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * 构造面板。
   * @param {object} options {doc, win, store, logger, settings, onSettings}
   */
  function Panel(options) {
    options = options || {};
    this.doc = options.doc;
    this.win = options.win || (this.doc && this.doc.defaultView) || root;
    this.store = options.store;
    this.logger = options.logger;
    this.settings = options.settings || (this.store && this.store.getSettings()) || {};
    this.onSettings = typeof options.onSettings === 'function' ? options.onSettings : null;

    this.root = null;
    this.launcher = null;
    this.logBox = null;
    this.sessionText = null;
    this.filters = {}; // category -> boolean（默认全开）
    this._logListener = null;
  }

  /** 保存设置（归一化 + 通知外部）。 */
  Panel.prototype._save = function (patch) {
    this.settings = this.store.patchSettings(patch);
    if (this.onSettings) {
      try {
        this.onSettings(this.settings);
      } catch (e) {
        if (this.logger) this.logger.error(NS.log.CATEGORY.SYSTEM, '设置回调异常', e && e.message);
      }
    }
    return this.settings;
  };

  /** 把面板挂到页面上（幂等：重复调用会先移除旧的）。 */
  Panel.prototype.mount = function () {
    var self = this;
    var doc = this.doc;
    if (!doc || !doc.body) return null;

    NS.ui.styles.inject(doc);

    var old = doc.getElementById(P.ROOT_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var rootEl = el(doc, 'div', 'szubkxk-root');
    rootEl.id = P.ROOT_ID;
    rootEl.setAttribute('data-collapsed', this.settings.panelCollapsed ? 'true' : 'false');

    var header = el(doc, 'div', 'szubkxk-header');
    header.appendChild(el(doc, 'span', 'szubkxk-title', '深大选课辅助'));
    header.appendChild(el(doc, 'span', 'szubkxk-version', 'v' + NS.version));
    header.appendChild(el(doc, 'span', 'szubkxk-spacer'));

    var btnCollapse = el(doc, 'button', 'szubkxk-hbtn', '–');
    btnCollapse.type = 'button';
    btnCollapse.title = '折叠 / 展开';
    var btnClose = el(doc, 'button', 'szubkxk-hbtn', '×');
    btnClose.type = 'button';
    btnClose.title = '隐藏（右下角可重新打开）';
    header.appendChild(btnCollapse);
    header.appendChild(btnClose);
    rootEl.appendChild(header);

    var body = el(doc, 'div', 'szubkxk-body');
    body.appendChild(this._buildSessionSection());
    var settingsSection = this._buildSettingsSection();
    body.appendChild(settingsSection);
    body.appendChild(this._buildLogSection());
    rootEl.appendChild(body);
    this.body = body;
    this._settingsSection = settingsSection;

    doc.body.appendChild(rootEl);
    this.root = rootEl;

    var launcher = el(doc, 'button', 'szubkxk-launcher szubkxk-hidden', '选课辅助');
    launcher.type = 'button';
    launcher.addEventListener('click', function () {
      self.setVisible(true);
    });
    doc.body.appendChild(launcher);
    this.launcher = launcher;

    btnCollapse.addEventListener('click', function () {
      self.toggleCollapsed();
    });
    btnClose.addEventListener('click', function () {
      self.setVisible(false);
    });
    this._wireDrag(header);

    this.setVisible(this.settings.panelVisible !== false);
    this.setPositionFromSettings();
    this.refreshSession();
    this.subscribeLogs();
    return rootEl;
  };

  /* ------------------------------ 显示与位置 ------------------------------ */

  /**
   * 往面板里插入一个自定义区块（任务管理等），默认插在"会话"与"设置"之间。
   * 必须在 mount() 之后调用。
   * @param {Element} element 区块 DOM（通常是 class=szubkxk-sec）
   * @returns {boolean} 是否插入成功
   */
  Panel.prototype.addSection = function (element) {
    if (!this.body || !element) return false;
    this.body.insertBefore(element, this._settingsSection || null);
    return true;
  };

  /**
   * 显示 / 隐藏面板（隐藏时露出右下角唤出按钮）。
   * @param {boolean} visible 是否显示
   */
  Panel.prototype.setVisible = function (visible) {
    var next = visible === true;
    this.settings = this._save({ panelVisible: next });
    if (this.root) this.root.classList.toggle('szubkxk-hidden', !next);
    if (this.launcher) this.launcher.classList.toggle('szubkxk-hidden', next);
    return next;
  };

  /** 折叠 / 展开（状态持久化）。 */
  Panel.prototype.toggleCollapsed = function () {
    var next = !(this.settings.panelCollapsed === true);
    this.settings = this._save({ panelCollapsed: next });
    if (this.root) this.root.setAttribute('data-collapsed', next ? 'true' : 'false');
    return next;
  };

  /** 按已保存（或默认右下角）的位置摆放。 */
  Panel.prototype.setPositionFromSettings = function () {
    if (!this.root) return;
    var w = this.win || {};
    var rect = this.root.getBoundingClientRect();
    var left = this.settings.panelLeft;
    var top = this.settings.panelTop;
    if (typeof left !== 'number' || typeof top !== 'number') {
      left = (w.innerWidth || 0) - (rect.width || 380) - 16;
      top = (w.innerHeight || 0) - (rect.height || 240) - 16;
    }
    return this._place(left, top);
  };

  /** 按视口钳位后落位。 */
  Panel.prototype._place = function (left, top) {
    if (!this.root) return null;
    var w = this.win || {};
    var pos = clampPosition(left, top, this.root.offsetWidth || 380, this.root.offsetHeight || 240, {
      width: w.innerWidth || 0,
      height: w.innerHeight || 0,
    });
    this.root.style.left = pos.left + 'px';
    this.root.style.top = pos.top + 'px';
    this.root.style.right = 'auto';
    this.root.style.bottom = 'auto';
    return pos;
  };

  /** 绑定拖动（在 document 上跟踪，松手时持久化）。 */
  Panel.prototype._wireDrag = function (handle) {
    var self = this;
    var doc = this.doc;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      try {
        var rect = self.root.getBoundingClientRect();
        var startX = ev.clientX;
        var startY = ev.clientY;
        var startLeft = rect.left;
        var startTop = rect.top;
        var onMove = function (e) {
          self._place(startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
        };
        var onUp = function () {
          doc.removeEventListener('mousemove', onMove);
          doc.removeEventListener('mouseup', onUp);
          var r = self.root.getBoundingClientRect();
          self.settings = self._save({ panelLeft: Math.round(r.left), panelTop: Math.round(r.top) });
        };
        doc.addEventListener('mousemove', onMove);
        doc.addEventListener('mouseup', onUp);
        ev.preventDefault();
      } catch (e) {
        /* 拖动失败不影响其它功能 */
      }
    });
  };

  /* -------------------------------- 会话 -------------------------------- */

  Panel.prototype._buildSessionSection = function () {
    var doc = this.doc;
    var self = this;
    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '会话'));
    var row = el(doc, 'div', 'szubkxk-row');
    var btn = el(doc, 'button', 'szubkxk-btn', '重新读取');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      self.refreshSession();
    });
    this.sessionText = el(doc, 'span', 'szubkxk-muted', '(未读取)');
    row.appendChild(btn);
    row.appendChild(this.sessionText);
    sec.appendChild(row);
    return sec;
  };

  /** 从站点 sessionStorage 重新读取会话并刷新显示。 */
  Panel.prototype.refreshSession = function () {
    if (!this.sessionText) return null;
    var s = NS.session.read(this.win);
    this.session = s;
    this.sessionText.textContent = NS.session.describe(s);
    this.sessionText.className = s.ok ? 'szubkxk-ok' : 'szubkxk-warn';
    return s;
  };

  /* -------------------------------- 设置 -------------------------------- */

  Panel.prototype._buildSettingsSection = function () {
    var doc = this.doc;
    var self = this;
    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '设置'));

    var rowW = el(doc, 'div', 'szubkxk-row');
    var cb = doc.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.settings.writeApiEnabled === true;
    var lab = el(doc, 'label', 'szubkxk-warn');
    lab.appendChild(cb);
    lab.appendChild(doc.createTextNode(' 允许真实提交选课（写接口）'));
    cb.addEventListener('change', function () {
      try {
        if (cb.checked) {
          var go = self.win.confirm(
            '开启后，抢课任务会向学校服务器【真实提交】选课请求。\n\n' +
              '默认关闭是本项目的安全底线；请确认你了解风控与账号风险。\n\n确定要开启吗？'
          );
          if (!go) {
            cb.checked = false;
            return;
          }
        }
        self._save({ writeApiEnabled: cb.checked === true });
        self.logger.warn(
          NS.log.CATEGORY.SYSTEM,
          '写接口开关已' + (self.settings.writeApiEnabled ? '★开启★（会真实提交）' : '关闭（只打印报文）')
        );
      } catch (e) {
        cb.checked = false;
      }
    });
    rowW.appendChild(lab);
    sec.appendChild(rowW);

    sec.appendChild(this._numberRow('请求间隔(ms，≥200)', 'requestIntervalMs', 200, 60000));
    sec.appendChild(this._numberRow('轮询间隔(ms)', 'pollIntervalMs', 200, 60000));

    var unknown = (this.store && this.store.unknownSettingKeys) || [];
    if (unknown.length) {
      sec.appendChild(el(doc, 'div', 'szubkxk-warn', '设置里有无法识别的键：' + unknown.join('、')));
    }
    return sec;
  };

  /** 造一行"标签 + 数字输入"，保存后回填钳位后的真实值。 */
  Panel.prototype._numberRow = function (labelText, key, min, max) {
    var doc = this.doc;
    var self = this;
    var row = el(doc, 'div', 'szubkxk-row');
    row.appendChild(el(doc, 'span', 'szubkxk-muted', labelText));
    var input = doc.createElement('input');
    input.type = 'number';
    input.className = 'szubkxk-input';
    input.min = String(min);
    input.max = String(max);
    input.value = String(this.settings[key]);
    input.addEventListener('change', function () {
      try {
        var patch = {};
        patch[key] = Number(input.value);
        self._save(patch);
        input.value = String(self.settings[key]); // 回填钳位后的真实值
        self.logger.info(NS.log.CATEGORY.SYSTEM, labelText + ' 已设为 ' + self.settings[key]);
      } catch (e) {
        input.value = String(self.settings[key]);
      }
    });
    row.appendChild(input);
    return row;
  };

  /* -------------------------------- 日志 -------------------------------- */

  Panel.prototype._buildLogSection = function () {
    var doc = this.doc;
    var self = this;
    var sec = el(doc, 'div', 'szubkxk-sec');

    var head = el(doc, 'div', 'szubkxk-row');
    head.appendChild(el(doc, 'div', 'szubkxk-sec-title', '日志'));
    head.appendChild(el(doc, 'span', 'szubkxk-spacer'));
    var btnClear = el(doc, 'button', 'szubkxk-btn', '清空');
    btnClear.type = 'button';
    btnClear.addEventListener('click', function () {
      self.logger.clear();
      self.renderLogs();
    });
    head.appendChild(btnClear);
    sec.appendChild(head);

    var filters = el(doc, 'div', 'szubkxk-filters');
    NS.log.CATEGORY_ORDER.forEach(function (cat) {
      if (!NS.log.CATEGORY_LABEL[cat]) return;
      self.filters[cat] = true;
      var lab = el(doc, 'label');
      var box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', function () {
        self.filters[cat] = box.checked; // 只影响显示
        self.renderLogs();
      });
      lab.appendChild(box);
      lab.appendChild(doc.createTextNode(NS.log.CATEGORY_LABEL[cat]));
      filters.appendChild(lab);
    });
    sec.appendChild(filters);

    this.logBox = el(doc, 'div', 'szubkxk-logs');
    sec.appendChild(this.logBox);
    return sec;
  };

  /** 订阅日志并按现有历史渲染一次。 */
  Panel.prototype.subscribeLogs = function () {
    var self = this;
    if (this._logListener) this.logger.unsubscribe(this._logListener);
    this._logListener = function (record) {
      self.appendLog(record);
    };
    this.logger.subscribe(this._logListener);
    this.renderLogs();
    return this._logListener;
  };

  /** 造一条日志 DOM（文本一律 textContent）。 */
  Panel.prototype._logNode = function (record) {
    var node = el(this.doc, 'div', 'szubkxk-log', NS.log.format(record));
    node.setAttribute('data-level', record.level);
    node.setAttribute('data-category', record.category);
    if (record.message.indexOf(NS.log.UNKNOWN_MARKER) !== -1) node.classList.add('szubkxk-log-unknown');
    return node;
  };

  /** 追加一条（受过滤与条数上限约束）。 */
  Panel.prototype.appendLog = function (record) {
    if (!this.logBox) return;
    if (this.filters[record.category] === false) return;
    this.logBox.appendChild(this._logNode(record));
    var limit = this.settings.logLimit || 500;
    while (this.logBox.childNodes.length > limit) {
      this.logBox.removeChild(this.logBox.firstChild);
    }
    this.logBox.scrollTop = this.logBox.scrollHeight;
  };

  /** 全量重绘（切换过滤时用）。 */
  Panel.prototype.renderLogs = function () {
    if (!this.logBox) return;
    while (this.logBox.firstChild) this.logBox.removeChild(this.logBox.firstChild);
    var records = this.logger.records();
    for (var i = 0; i < records.length; i++) {
      if (this.filters[records[i].category] === false) continue;
      this.logBox.appendChild(this._logNode(records[i]));
    }
    this.logBox.scrollTop = this.logBox.scrollHeight;
  };

  /** 移除面板（不清理设置）。 */
  Panel.prototype.destroy = function () {
    if (this._logListener && this.logger) this.logger.unsubscribe(this._logListener);
    this._logListener = null;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this.launcher && this.launcher.parentNode) this.launcher.parentNode.removeChild(this.launcher);
    this.root = null;
    this.launcher = null;
    this.logBox = null;
  };

  P.create = function (options) {
    return new Panel(options);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
