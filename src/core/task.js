/**
 * 抢课任务模型：规范化、持久化形状、状态机、表格列定义。
 *
 * 【两种任务类型】（与桌面版一致，见 docs/方案-油猴脚本.md §6.2）
 *   - `grab`    ：只想要某一个志愿 —— 到点提交；可选"满课后停止"
 *   - `monitor` ：多个候补志愿，等统一放量 —— 轮询余量，命中第一个就提交，不因满课停止
 *
 * 【两条硬约定】
 *   1. **重启后一律"已停止"**：从存储读回来的任务绝不自动运行（restoreOnLoad 强制重置）；
 *   2. 任务里的数值一律钳位，坏数据不抛异常（沿用 store 的安全设计）。
 *
 * 本模块是**纯数据层**，不碰网络、不碰 DOM，可完全离线单测。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var T = (NS.task = NS.task || {});

  /** 任务类型。 */
  T.KIND = { GRAB: 'grab', MONITOR: 'monitor' };
  T.KIND_LABEL = { grab: '单志愿抢课', monitor: '多志愿监控' };

  /** 任务状态。 */
  T.STATUS = {
    STOPPED: 'stopped',
    WAITING: 'waiting',
    RUNNING: 'running',
    SUCCESS: 'success',
    ERROR: 'error',
  };
  T.STATUS_LABEL = {
    stopped: '已停止',
    waiting: '等待中',
    running: '运行中',
    success: '抢课成功',
    error: '异常失败',
  };

  /** 满课策略（仅 grab 用）。 */
  T.FULL_STRATEGY = { STOP: 'stop', KEEP: 'keep' };
  T.FULL_STRATEGY_LABEL = { stop: '满课后停止', keep: '满课继续轮询' };

  /** 任务轮询间隔下限（与全局请求间隔硬下限一致；实际运行时再与 settings 取大）。 */
  T.MIN_INTERVAL_MS = 200;
  T.MAX_INTERVAL_MS = 60000;
  T.DEFAULT_INTERVAL_MS = 1500;

  /** 单个任务的监控目标上限（与桌面版 MONITOR_MAX_CLASSES 一致）。 */
  T.MAX_TARGETS = 20;

  /** 表格列定义（UI 复用；key 交给 display() 渲染）。 */
  T.COLUMNS = {
    grab: [
      { key: 'name', label: '备注' },
      { key: 'startAtText', label: '开始时间' },
      { key: 'targetsText', label: '目标教学班' },
      { key: 'intervalText', label: '轮询间隔' },
      { key: 'fullStrategyText', label: '满课策略' },
      { key: 'statusText', label: '状态' },
    ],
    monitor: [
      { key: 'name', label: '备注' },
      { key: 'startAtText', label: '开始时间' },
      { key: 'targetsText', label: '监控教学班' },
      { key: 'intervalText', label: '轮询间隔' },
      { key: 'statusText', label: '状态' },
    ],
  };

  /** 取某类型的列定义。 */
  T.columns = function (kind) {
    return T.COLUMNS[kind === T.KIND.MONITOR ? T.KIND.MONITOR : T.KIND.GRAB];
  };

  /** 两位补零。 */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 把毫秒时间戳格式化为 `HH:MM:SS`（未设置则显示占位）。
   * @param {number|null} ms 毫秒时间戳
   * @returns {string}
   */
  T.formatStartAt = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '立即开始';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };

  /** 把字符串安全地转成"非空字符串或 null"。 */
  function str(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 规范化一个目标教学班。
   * 允许直接传教学班ID 字符串（监控清单就是"一行一个教学班ID"）。
   * @param {*} raw 原始目标
   * @returns {(object|null)} 规范化目标；没有 teachingClassId 时返回 null（应被丢弃）
   */
  T.normalizeTarget = function (raw) {
    var o = typeof raw === 'string' || typeof raw === 'number' ? { teachingClassId: raw } : raw;
    if (!o || typeof o !== 'object') return null;
    var tcId = str(o.teachingClassId);
    if (!tcId) return null;
    return {
      teachingClassId: tcId,
      courseNumber: str(o.courseNumber),
      courseName: str(o.courseName),
      teacher: str(o.teacher),
      teachingClassType: str(o.teachingClassType),
    };
  };

  /**
   * 规范化任务。
   * @param {object} raw 原始任务（可能来自存储、UI 或用户手改）
   * @returns {object} 规范化任务
   */
  T.normalize = function (raw) {
    var o = raw && typeof raw === 'object' ? raw : {};
    var kind = o.kind === T.KIND.MONITOR ? T.KIND.MONITOR : T.KIND.GRAB;

    var startAt = Number(o.startAt);
    if (!isFinite(startAt) || startAt <= 0) startAt = null;

    var targets = [];
    var seen = {};
    var inputTargets = Array.isArray(o.targets) ? o.targets : [];
    for (var i = 0; i < inputTargets.length && targets.length < T.MAX_TARGETS; i++) {
      var t = T.normalizeTarget(inputTargets[i]);
      if (!t) continue;
      if (seen[t.teachingClassId]) continue; // 教学班ID 全局唯一 → 去重
      seen[t.teachingClassId] = true;
      targets.push(t);
    }

    var status = o.status;
    if (!T.STATUS_LABEL[status]) status = T.STATUS.STOPPED;

    return {
      id: str(o.id) || NS.util.uid(),
      name: str(o.name) || '',
      kind: kind,
      startAt: startAt,
      intervalMs: NS.util.clamp(o.intervalMs, T.MIN_INTERVAL_MS, T.MAX_INTERVAL_MS, T.DEFAULT_INTERVAL_MS),
      fullStrategy: o.fullStrategy === T.FULL_STRATEGY.KEEP ? T.FULL_STRATEGY.KEEP : T.FULL_STRATEGY.STOP,
      // 余量取不到时是否仍然提交。默认 false —— 桌面版曾因字段解析为空而"对已满课程发起抢课"
      allowUnknownCapacity: o.allowUnknownCapacity === true,
      enabled: o.enabled === true,
      status: status,
      targets: targets,
      createdAt: isFinite(Number(o.createdAt)) && Number(o.createdAt) > 0 ? Number(o.createdAt) : null,
      updatedAt: isFinite(Number(o.updatedAt)) && Number(o.updatedAt) > 0 ? Number(o.updatedAt) : null,
    };
  };

  /**
   * 创建一个新任务（补上 id 与时间戳）。
   * @param {object} [patch] 初始字段
   * @returns {object} 规范化后的任务
   */
  T.create = function (patch) {
    var now = Date.now();
    var task = T.normalize(Object.assign({}, patch || {}, { id: null, createdAt: now, updatedAt: now }));
    return task;
  };

  /**
   * 规范化任务列表。
   * @param {*} list 原始列表
   * @returns {object[]} 规范化任务数组
   */
  T.normalizeList = function (list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(T.normalize(list[i]));
    return out;
  };

  /**
   * 从存储载入任务：**强制把所有状态重置为"已停止"**。
   * 这条规则来自桌面版：重启后绝不自动开始抢课。
   * @param {*} list 存储里的原始列表
   * @returns {object[]} 规范化且状态全部为 stopped 的任务
   */
  T.restoreOnLoad = function (list) {
    return T.normalizeList(list).map(function (t) {
      t.status = T.STATUS.STOPPED;
      t.enabled = false;
      return t;
    });
  };

  /**
   * 渲染某个列的值（UI 表格用）。
   * @param {object} task 任务
   * @param {string} key 列 key
   * @returns {string}
   */
  T.display = function (task, key) {
    var t = T.normalize(task);
    switch (key) {
      case 'name':
        return t.name || ('(未命名 ' + t.id + ')');
      case 'kindText':
        return T.KIND_LABEL[t.kind];
      case 'startAtText':
        return T.formatStartAt(t.startAt);
      case 'intervalText':
        return t.intervalMs + 'ms';
      case 'targetsText':
        return t.targets.length === 0 ? '(未设置)' : t.targets.map(function (x) { return x.teachingClassId; }).join(', ');
      case 'targetCount':
        return String(t.targets.length);
      case 'fullStrategyText':
        return t.kind === T.KIND.GRAB ? T.FULL_STRATEGY_LABEL[t.fullStrategy] : '不适用（不因满课停止）';
      case 'statusText':
        return T.STATUS_LABEL[t.status] || t.status;
      default:
        return String(t[key] === undefined || t[key] === null ? '' : t[key]);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
