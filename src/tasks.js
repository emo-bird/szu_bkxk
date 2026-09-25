/**
 * 抢课任务模型 + 执行引擎。
 *
 * 重试策略三选一（用户指定，默认 smart）：
 *   smart  —— 可重试的继续（满员/容量类），终结性的停并提示原因
 *   never  —— 任何失败都停
 *   always —— 任何失败都持续重试
 *
 * 执行方式：**轮转**（每轮每个活跃任务各尝试一次，然后等待 retryIntervalMs）。
 * 这样某门课满员狂重试时不会把其它任务饿死。
 * 所有请求经 core 的限流队列，用户任务用 HIGH，监控命中用 MONITOR_HIT。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  var T = (NS.tasks = NS.tasks || {});

  T.MODE = { SMART: 'smart', NEVER: 'never', ALWAYS: 'always' };
  T.MODE_NAME = { smart: '智能', never: '失败即停', always: '持续重试' };

  T.STATUS = { PENDING: 'pending', RUNNING: 'running', SUCCESS: 'success', FAILED: 'failed' };

  /**
   * 业务返回文案分类。
   * 【顺序重要】先判可重试：`已选人数超过课容量` 同时含「已选」与「容量」，
   * 但它表达的是「满员」，必须算可重试；故 可重试 优先于 终结性。
   */
  var RETRYABLE_RE = /已满|满员|容量|人数/;
  var TERMINAL_RE = /已选|已添加|选中|重复|冲突|学分|门数|门课|限选|性别|年级|不允许|未开放|无权限|不在/;

  /** @returns {'retryable'|'terminal'|'unknown'} */
  T.classifyMsg = function (msg) {
    var m = msg === undefined || msg === null ? '' : String(msg);
    if (RETRYABLE_RE.test(m)) return 'retryable';
    if (TERMINAL_RE.test(m)) return 'terminal';
    return 'unknown';
  };

  /** 依策略判断是否应继续重试。 */
  T.shouldRetry = function (mode, kind) {
    if (mode === T.MODE.ALWAYS) return true;
    if (mode === T.MODE.NEVER) return false;
    // smart：只对可重试/未识别继续（未识别宁可继续，便于事后补分支）
    return kind === 'retryable' || kind === 'unknown';
  };

  T.items = [];
  T.seq = 0;
  T.running = false;
  T.stopped = false;

  var STORE_KEY = 'tasks';

  /**
   * 落盘 / 加载。
   * 只存配置与进度，**不存任何凭证**（红线③）。
   * 页面刷新时正在跑的请求会丢，故加载时把 running 态复位为 pending。
   */
  T.save = function () {
    var slim = [];
    for (var i = 0; i < T.items.length; i++) {
      var t = T.items[i];
      slim.push({
        id: t.id, seq: t.seq,
        teachingClassID: t.teachingClassID,
        courseName: t.courseName, teacherName: t.teacherName,
        category: t.category,
        priority: t.priority, enabled: t.enabled,
        status: t.status === T.STATUS.RUNNING ? T.STATUS.PENDING : t.status,
        retryMode: t.retryMode,
        attempts: t.attempts, lastMsg: t.lastMsg, lastKind: t.lastKind,
        addedAt: t.addedAt,
      });
    }
    NS.store.set(STORE_KEY, { seq: T.seq, items: slim });
  };

  T.load = function () {
    var data = NS.store.get(STORE_KEY, null);
    if (!data || !Array.isArray(data.items)) return 0;
    T.items = data.items.map(function (t) {
      return {
        id: t.id || ('t' + (++T.seq)),
        seq: t.seq || 0,
        teachingClassID: String(t.teachingClassID || ''),
        courseName: t.courseName || '',
        teacherName: t.teacherName || '',
        category: t.category || '',
        priority: typeof t.priority === 'number' ? t.priority : 0,
        enabled: t.enabled !== false,
        // 刷新前正在请求的，复位为等待
        status: t.status === T.STATUS.RUNNING ? T.STATUS.PENDING : (t.status || T.STATUS.PENDING),
        retryMode: T.MODE_NAME[t.retryMode] ? t.retryMode : T.MODE.SMART,
        attempts: t.attempts || 0,
        lastMsg: t.lastMsg || '',
        lastKind: t.lastKind || '',
        addedAt: t.addedAt || Date.now(),
      };
    }).filter(function (t) { return !!t.teachingClassID; });
    T.seq = Math.max(data.seq || 0, T.items.length);
    if (T.items.length) NS.info('已恢复 ' + T.items.length + ' 个抢课任务');
    return T.items.length;
  };

  T.retryIntervalMs = function () {
    var s = NS.settings();
    return NS.util.clamp(s.retryIntervalMs, 500, 60000, 1500);
  };

  T.active = function () {
    var out = [];
    for (var i = 0; i < T.items.length; i++) {
      var t = T.items[i];
      if (t.enabled && (t.status === T.STATUS.PENDING || t.status === T.STATUS.RUNNING)) out.push(t);
    }
    // 优先级小的先试；同级按加入顺序
    out.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.seq - b.seq;
    });
    return out;
  };

  T.findByTc = function (tcId) {
    for (var i = 0; i < T.items.length; i++) if (T.items[i].teachingClassID === tcId) return T.items[i];
    return null;
  };

  T.add = function (info) {
    if (!info || !info.teachingClassID) return null;
    var exist = T.findByTc(info.teachingClassID);
    if (exist) return exist;
    var s = NS.settings();
    var task = {
      id: 't' + (++T.seq),
      seq: T.seq,
      teachingClassID: info.teachingClassID,
      courseName: info.courseName || '',
      teacherName: info.teacherName || '',
      category: info.category || '',
      priority: 0,
      enabled: true,
      status: T.STATUS.PENDING,
      retryMode: s.retryMode || T.MODE.SMART,
      attempts: 0,
      lastMsg: '',
      lastKind: '',
      addedAt: Date.now(),
    };
    T.items.push(task);
    T.save();
    NS.info('加入抢课任务 ' + task.teachingClassID, task.courseName);
    return task;
  };

  T.remove = function (id) {
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].id === id) {
        T.items.splice(i, 1);
        T.save();
        return true;
      }
    }
    return false;
  };

  T.toggle = function (id) {
    var t = T.byId(id);
    if (!t) return false;
    t.enabled = !t.enabled;
    if (t.enabled && t.status === T.STATUS.FAILED) t.status = T.STATUS.PENDING;
    T.save();
    return t.enabled;
  };

  T.byId = function (id) {
    for (var i = 0; i < T.items.length; i++) if (T.items[i].id === id) return T.items[i];
    return null;
  };

  T.setPriority = function (id, p) {
    var t = T.byId(id);
    if (!t) return false;
    t.priority = NS.util.clamp(p, -1, 1, 0);
    T.save();
    return true;
  };

  T.setRetryMode = function (id, mode) {
    var t = T.byId(id);
    if (!t) return false;
    if (!T.MODE_NAME[mode]) return false;
    t.retryMode = mode;
    T.save();
    return true;
  };

  T.clear = function () {
    T.items = [];
    T.save();
  };

  T.reset = function () {
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].status !== T.STATUS.SUCCESS) T.items[i].status = T.STATUS.PENDING;
      T.items[i].attempts = 0;
      T.items[i].lastMsg = '';
    }
    T.save();
  };

  /** 构造该任务的抢课请求体。 */
  T.buildBody = function (task) {
    var ctx = NS.list.sessionContext();
    return NS.api.buildVolunteerBody({
      studentCode: ctx.studentCode,
      electiveBatchCode: ctx.batchCode,
      teachingClassId: task.teachingClassID,
      campus: ctx.campus,
      teachingClassType: task.category,
    });
  };

  /**
   * 对单个任务尝试一次。
   * @returns {Promise<{done:boolean}>} done=true 表示该任务已终结（成功或按策略停止）
   */
  T.attempt = function (task) {
    // 前置校验：缺关键字段就不要发请求了
    var ctx = NS.list.sessionContext();
    if (!ctx.batchCode || !ctx.studentCode) {
      task.status = T.STATUS.FAILED;
      task.lastMsg = '缺少学号或选课批次码，请在设置中补全';
      NS.error('任务中止：缺少学号或 batchCode', task.teachingClassID);
      return Promise.resolve({ done: true });
    }
    if (!task.category) {
      task.status = T.STATUS.FAILED;
      task.lastMsg = '未能识别该教学班的类别代码，请重新在列表中点击「添加抢课」';
      NS.error('任务中止：类别未知', task.teachingClassID);
      return Promise.resolve({ done: true });
    }

    task.attempts += 1;
    task.status = T.STATUS.RUNNING;

    return NS.api
      .send({
        action: '抢课 ' + task.teachingClassID,
        url: NS.api.url(NS.api.EP.VOLUNTEER),
        method: 'POST',
        body: T.buildBody(task),
        priority: NS.Queue.PRIORITY.HIGH,
      })
      .then(function (r) {
        var kind = r.cls.kind;
        task.lastMsg = r.cls.msg || '';

        if (kind === NS.api.RESP_KIND.OK) {
          task.status = T.STATUS.SUCCESS;
          T.save();
          NS.info('抢课成功 ' + task.teachingClassID, task.courseName);
          return { done: true };
        }
        if (kind === NS.api.RESP_KIND.UNAUTHENTICATED) {
          task.status = T.STATUS.FAILED;
          task.lastMsg = '登录态失效，请刷新页面重新登录';
          T.stopped = true;
          T.save();
          NS.error('登录态失效，已停止全部任务');
          return { done: true };
        }

        var cls = kind === NS.api.RESP_KIND.BUSINESS ? T.classifyMsg(task.lastMsg) : 'unknown';
        task.lastKind = cls;
        if (T.shouldRetry(task.retryMode, cls)) {
          task.status = T.STATUS.PENDING;
          T.save();
          NS.warn('抢课未成功，将继续重试 [' + cls + '] ' + task.lastMsg);
          return { done: false };
        }
        task.status = T.STATUS.FAILED;
        T.save();
        NS.warn('任务停止：' + task.lastMsg);
        return { done: true };
      })
      .catch(function (e) {
        // 网络/队列异常：按策略处理
        task.lastMsg = '请求异常：' + (e && e.message ? e.message : e);
        task.lastKind = 'unknown';
        if (T.shouldRetry(task.retryMode, 'unknown')) {
          task.status = T.STATUS.PENDING;
        } else {
          task.status = T.STATUS.FAILED;
        }
        T.save();
        return { done: task.status === T.STATUS.FAILED };
      });
  };

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /** 一轮：每个活跃任务各尝试一次（串行，避免同时打服务器）。 */
  T.round = function () {
    var list = T.active();
    var i = 0;
    function next() {
      if (T.stopped || i >= list.length) return Promise.resolve();
      var task = list[i++];
      if (!task.enabled) return next();
      return T.attempt(task).then(function () { return next(); });
    }
    return Promise.resolve().then(next);
  };

  T._loop = function () {
    if (T.stopped || !T.running) { T.running = false; return Promise.resolve(); }
    if (!T.active().length) {
      T.running = false;
      NS.info('全部任务已结束');
      return Promise.resolve();
    }
    return T
      .round()
      .then(function () {
        if (T.stopped || !T.running) { T.running = false; return null; }
        if (!T.active().length) { T.running = false; NS.info('全部任务已结束'); return null; }
        return sleep(T.retryIntervalMs()).then(T._loop);
      });
  };

  /**
   * 开始执行。写接口未开启时直接拒绝（红线①）。
   * @returns {Promise<{ok:boolean, reason:string}>}
   */
  T.start = function () {
    if (!NS.isWriteAllowed(NS.settings())) {
      return Promise.resolve({ ok: false, reason: 'write-disabled' });
    }
    if (T.running) return Promise.resolve({ ok: false, reason: 'already-running' });
    if (!T.active().length) return Promise.resolve({ ok: false, reason: 'no-task' });
    T.running = true;
    T.stopped = false;
    NS.info('开始抢课，任务数 ' + T.active().length);
    T._loop();
    return Promise.resolve({ ok: true, reason: '' });
  };

  T.stop = function () {
    if (!T.running && !T.stopped) return false;
    T.stopped = true;
    T.running = false;
    for (var i = 0; i < T.items.length; i++) {
      if (T.items[i].status === T.STATUS.RUNNING) T.items[i].status = T.STATUS.PENDING;
    }
    NS.info('已停止抢课');
    return true;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
