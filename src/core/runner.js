/**
 * 抢课任务执行器：把任务模型接到限流队列 / HTTP 出口 / 服务器时钟上。
 *
 * 【两种场景】
 *   - `grab`   ：到 `startAt`（服务器时间）才提交；可选"满课后停止"
 *   - `monitor`：持续轮询余量，命中即提交；不因满课停止
 *
 * 【安全判定（照搬桌面版踩过的坑）】
 *   - 余量必须由 `capacity.do` 的 `mainClassCapacity - mainElectiveNumber` 得出；
 *     **取不到余量时默认不提交**（桌面版曾因字段解析为空而对已满课程发起抢课），
 *     确需"盲提"必须显式打开任务的 allowUnknownCapacity；
 *   - 写开关关闭时**只打印报文，绝不发送**；
 *   - 业务拒绝（code=2）顺延下一个目标；登录失效（code=302）停止全部任务。
 *
 * 【调度】不直接读系统时钟：未到点用 NS.schedule.Clock 精准定时（保证不早于目标时刻），
 *   到点后按 max(任务间隔, 全局请求间隔) 轮询。
 *
 * 依赖：NS.task / NS.api / NS.http / NS.log / NS.queue（均延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var RU = (NS.runner = NS.runner || {});

  /**
   * 构造任务执行器。
   * @param {object} options
   * @param {object} options.http HttpClient（可被替身替换用于离线单测）
   * @param {object} options.clock NS.schedule.Clock（服务器时间）
   * @param {object} options.logger 日志器
   * @param {object} options.store 存储
   * @param {Function} options.getSettings 返回当前设置
   * @param {Function} [options.getSession] 返回当前会话（默认读页面 sessionStorage）
   * @param {object} [options.timers] 定时器适配，默认沿用 clock.timers
   * @param {Function} [options.onChange] 任务变化回调（UI 刷新用）
   */
  function Runner(options) {
    options = options || {};
    this.http = options.http;
    this.clock = options.clock;
    this.logger = options.logger;
    this.store = options.store;
    this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : function () { return {}; };
    this.getSession =
      typeof options.getSession === 'function'
        ? options.getSession
        : function () {
            return NS.session.read(root);
          };
    this.timers = options.timers || (this.clock && this.clock.timers) || {
      now: function () { return Date.now(); },
      setTimeout: function (fn, d) { return root.setTimeout(fn, d); },
      clearTimeout: function (id) { return root.clearTimeout(id); },
    };
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;

    this.tasks = [];
    this.running = false;
    this._handles = {}; // taskId -> {cancel}
  }

  /** 通知 UI 任务有变化。 */
  Runner.prototype._emitChange = function () {
    if (!this.onChange) return;
    try {
      this.onChange(this.tasks);
    } catch (e) {
      /* UI 出错不影响调度 */
    }
  };

  /** 从存储载入任务（状态一律重置为已停止）。 */
  Runner.prototype.load = function () {
    this.tasks = NS.task.restoreOnLoad(this.store ? this.store.getTasks() : []);
    this._emitChange();
    return this.tasks;
  };

  /** 持久化任务（只存数据，不存运行时定时器）。 */
  Runner.prototype.save = function () {
    if (this.store) this.store.saveTasks(this.tasks);
    this._emitChange();
    return this.tasks;
  };

  /** 取任务。 */
  Runner.prototype.get = function (id) {
    for (var i = 0; i < this.tasks.length; i++) if (this.tasks[i].id === id) return this.tasks[i];
    return null;
  };

  /** 新增任务。 */
  Runner.prototype.add = function (patch) {
    var task = NS.task.create(patch);
    this.tasks.push(task);
    this.save();
    return task;
  };

  /** 修改任务（会重新规范化）。 */
  Runner.prototype.update = function (id, patch) {
    var task = this.get(id);
    if (!task) return null;
    var merged = NS.task.normalize(Object.assign({}, task, patch || {}, { id: task.id }));
    for (var k in merged) {
      if (Object.prototype.hasOwnProperty.call(merged, k)) task[k] = merged[k];
    }
    this.save();
    return task;
  };

  /** 删除任务（先停止）。 */
  Runner.prototype.remove = function (id) {
    this._cancel(id);
    var idx = -1;
    for (var i = 0; i < this.tasks.length; i++) if (this.tasks[i].id === id) idx = i;
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  };

  /** 有效轮询间隔：任务间隔与全局请求间隔取大（避免被钳位却没提示）。 */
  Runner.prototype._effectiveInterval = function (task) {
    var settings = this.getSettings() || {};
    var floor = typeof settings.requestIntervalMs === 'number' ? settings.requestIntervalMs : NS.queue.INTERVAL_DEFAULT_MS;
    return Math.max(task.intervalMs, floor);
  };

  /** 取消某任务的待执行定时器。 */
  Runner.prototype._cancel = function (id) {
    var h = this._handles[id];
    if (h) {
      try {
        h.cancel();
      } catch (e) {
        /* 已触发 */
      }
      delete this._handles[id];
    }
  };

  /** 取消全部定时器。 */
  Runner.prototype._cancelAll = function () {
    for (var id in this._handles) {
      if (Object.prototype.hasOwnProperty.call(this._handles, id)) this._cancel(id);
    }
  };

  /** 开始运行所有已启用的任务。 */
  Runner.prototype.start = function () {
    this.running = true;
    for (var i = 0; i < this.tasks.length; i++) {
      var t = this.tasks[i];
      if (t.targets.length === 0) continue;
      if (t.status === NS.task.STATUS.SUCCESS) continue;
      // 载入时状态被强制为 stopped，而 _schedule() 会跳过 stopped 的任务，
      // 所以必须先把状态拨到"运行/等待"，否则一个任务都不会被调度。
      t.status =
        t.startAt && t.startAt > this.clock.serverNow() ? NS.task.STATUS.WAITING : NS.task.STATUS.RUNNING;
      this._schedule(t, 0);
    }
    this._emitChange();
    return this.tasks.length;
  };

  /** 停止全部任务（只把"在跑的"改回已停止，保留"抢课成功"与"异常失败"的结论）。 */
  Runner.prototype.stop = function (reason) {
    this.running = false;
    this._cancelAll();
    for (var i = 0; i < this.tasks.length; i++) {
      var t = this.tasks[i];
      if (t.status === NS.task.STATUS.WAITING || t.status === NS.task.STATUS.RUNNING) {
        t.status = NS.task.STATUS.STOPPED;
      }
    }
    if (reason && this.logger) this.logger.warn(NS.log.CATEGORY.SYSTEM, '已停止全部任务：' + reason);
    this._emitChange();
  };

  /** 单独启动一个任务。 */
  Runner.prototype.startTask = function (id) {
    var task = this.get(id);
    if (!task) return false;
    if (task.targets.length === 0) {
      if (this.logger) this.logger.warn(NS.log.CATEGORY.FAIL, '任务没有目标教学班，无法开始：' + task.name);
      return false;
    }
    this.running = true;
    task.status = NS.task.STATUS.WAITING;
    this._schedule(task, 0);
    this._emitChange();
    return true;
  };

  /** 单独停止一个任务。 */
  Runner.prototype.stopTask = function (id) {
    var task = this.get(id);
    if (!task) return false;
    this._cancel(id);
    if (task.status !== NS.task.STATUS.SUCCESS) task.status = NS.task.STATUS.STOPPED;
    this._emitChange();
    return true;
  };

  /**
   * 排下一次执行。
   * 若设置了未来的 startAt，用精准定时（保证不早于目标时刻）；
   * 否则按轮询间隔。
   * @param {object} task 任务
   * @param {number} [delayMs] 指定首次延迟
   */
  Runner.prototype._schedule = function (task, delayMs) {
    var self = this;
    if (!this.running) return;
    if (task.status === NS.task.STATUS.STOPPED || task.status === NS.task.STATUS.SUCCESS) return;
    this._cancel(task.id);

    var waitTarget = task.startAt;
    var notYet = waitTarget && this.clock.serverNow() < waitTarget;
    if (notYet && this.clock.scheduleAt) {
      task.status = NS.task.STATUS.WAITING;
      this._handles[task.id] = this.clock.scheduleAt(waitTarget, function () {
        delete self._handles[task.id];
        self._tick(task);
      });
      this._emitChange();
      return;
    }

    var delay = typeof delayMs === 'number' ? delayMs : this._effectiveInterval(task);
    var timerId = this.timers.setTimeout(function () {
      delete self._handles[task.id];
      self._tick(task);
    }, delay);
    this._handles[task.id] = {
      cancel: function () {
        self.timers.clearTimeout(timerId);
      },
    };
  };

  /** 一次调度到点：跑一轮，然后排下一轮。 */
  Runner.prototype._tick = function (task) {
    var self = this;
    if (!this.running) return;
    Promise.resolve()
      .then(function () {
        return self._runOnce(task);
      })
      .catch(function (e) {
        if (self.logger) self.logger.error(NS.log.CATEGORY.FAIL, '任务执行异常：' + task.name, (e && e.message) || e);
        task.status = NS.task.STATUS.ERROR;
        self._emitChange();
      })
      .then(function () {
        if (!self.running) return;
        if (task.status === NS.task.STATUS.STOPPED || task.status === NS.task.STATUS.SUCCESS) return;
        self._schedule(task);
      });
  };

  /**
   * 跑一轮：先看是否到点，再逐个目标探测余量 / 提交。
   * @param {object} task 任务
   */
  Runner.prototype._runOnce = function (task) {
    var self = this;
    var API = NS.api;
    var session = this.getSession();
    if (!session.ok) {
      if (this.logger) this.logger.error(NS.log.CATEGORY.FAIL, '登录信息不完整，已停止：' + session.missing.join('、'));
      task.status = NS.task.STATUS.ERROR;
      this.stop('登录态失效或凭据缺失');
      return Promise.resolve();
    }

    if (task.startAt && this.clock.serverNow() < task.startAt) {
      task.status = NS.task.STATUS.WAITING;
      this._emitChange();
      return Promise.resolve();
    }

    task.status = NS.task.STATUS.RUNNING;
    this._emitChange();

    // 顺序遍历目标：第一个成功就结束；业务拒绝则顺延下一个
    var chain = Promise.resolve(false);
    task.targets.forEach(function (target) {
      chain = chain.then(function (done) {
        if (done) return true;
        return self._tryTarget(task, target, session).then(function (success) {
          return done || success;
        });
      });
    });
    return chain;
  };

  /**
   * 探测并尝试提交一个目标。
   * @returns {Promise<boolean>} 是否抢课成功
   */
  Runner.prototype._tryTarget = function (task, target, session) {
    var self = this;
    var API = NS.api;
    if (!target.teachingClassType) {
      if (this.logger) {
        this.logger.warn(NS.log.CATEGORY.FAIL, '目标缺少课程类别，跳过：' + target.teachingClassId);
      }
      return Promise.resolve(false);
    }

    return this.http
      .post(API.EP.CAPACITY, API.buildCapacityBody(target.teachingClassId, session.electiveBatchCode), {
        token: session.token,
        action: '查容量',
        category: NS.log.CATEGORY.QUERY,
        priority: NS.queue.PRIORITY.NORMAL,
      })
      .then(function (res) {
        if (res.kind === API.RESP_KIND.UNAUTHENTICATED) {
          self.logger && self.logger.error(NS.log.CATEGORY.FAIL, '查容量时登录态失效，停止全部任务');
          task.status = NS.task.STATUS.ERROR;
          self.stop('登录态失效');
          return false;
        }
        if (res.kind !== API.RESP_KIND.OK) return false;

        var remain = API.capacityRemain(res.data);
        if (remain === null && !task.allowUnknownCapacity) {
          if (self.logger) {
            self.logger.warn(
              NS.log.CATEGORY.QUERY,
              '取不到余量且未允许盲提，本轮跳过：' + target.teachingClassId
            );
          }
          return false;
        }
        if (remain !== null && remain <= 0) {
          if (self.logger) self.logger.info(NS.log.CATEGORY.QUERY, '满课：' + target.teachingClassId + '（余量 0）');
          if (task.kind === NS.task.KIND.GRAB && task.fullStrategy === NS.task.FULL_STRATEGY.STOP) {
            task.status = NS.task.STATUS.STOPPED;
            if (self.logger) self.logger.warn(NS.log.CATEGORY.FAIL, '满课且策略为"满课后停止"，任务停止：' + task.name);
            self._emitChange();
          }
          return false;
        }

        if (self.logger) {
          self.logger.info(NS.log.CATEGORY.QUERY, '有余量：' + target.teachingClassId + '（剩余 ' + remain + '）');
        }
        return self._submit(task, target, session, remain);
      })
      .catch(function (err) {
        if (self.logger) {
          self.logger.error(NS.log.CATEGORY.FAIL, '查容量失败：' + target.teachingClassId, (err && err.message) || err);
        }
        return false;
      });
  };

  /**
   * 提交选课（写操作）。写开关关闭时只打印报文。
   * @returns {Promise<boolean>} 是否成功
   */
  Runner.prototype._submit = function (task, target, session, remain) {
    var self = this;
    var API = NS.api;
    var settings = this.getSettings() || {};
    var body = API.buildFormBody({
      addParam: JSON.stringify(
        API.buildEnrollParam({
          studentCode: session.studentCode,
          electiveBatchCode: session.electiveBatchCode,
          teachingClassId: target.teachingClassId,
          teachingClassType: target.teachingClassType,
        })
      ),
    });

    if (!API.isWriteAllowed(settings)) {
      if (this.logger) {
        this.logger.warn(
          NS.log.CATEGORY.FAIL,
          '写接口开关关闭：' + target.teachingClassId + '（余量 ' + remain + '）—— 以下报文仅打印，未发送',
          NS.http.describe('POST', API.EP.VOLUNTEER, body)
        );
      }
      return Promise.resolve(false);
    }

    return this.http
      .post(API.EP.VOLUNTEER, body, {
        token: session.token,
        action: '选课提交',
        category: NS.log.CATEGORY.FAIL,
        priority: NS.queue.PRIORITY.HIGH,
      })
      .then(function (res) {
        if (res.kind === API.RESP_KIND.OK) {
          task.status = NS.task.STATUS.SUCCESS;
          if (self.logger) {
            self.logger.info(NS.log.CATEGORY.SUCCESS, '抢课成功：' + target.teachingClassId + '（' + (res.msg || '') + '）');
          }
          self._emitChange();
          return true;
        }
        if (res.kind === API.RESP_KIND.BUSINESS) {
          if (self.logger) {
            self.logger.warn(NS.log.CATEGORY.FAIL, '业务拒绝：' + target.teachingClassId + ' —— ' + (res.msg || ''));
          }
          return false;
        }
        if (res.kind === API.RESP_KIND.UNAUTHENTICATED) {
          task.status = NS.task.STATUS.ERROR;
          self.stop('登录态失效');
          return false;
        }
        return false;
      })
      .catch(function (err) {
        if (self.logger) {
          self.logger.error(NS.log.CATEGORY.FAIL, '提交失败：' + target.teachingClassId, (err && err.message) || err);
        }
        return false;
      });
  };

  RU.Runner = Runner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
