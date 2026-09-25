/**
 * 本地持久化：localStorage 封装 + 设置归一化。
 *
 * 【放什么】只放**非敏感**数据：设置、抢课任务、自定义课程、课程缓存、面板日志。
 * 【绝不放什么】凭证（token / cookie / 学号）—— 这些只在内存与站点自己的 sessionStorage 里，
 *   永远不写入 localStorage（README「五、红线」第 3 条）。
 *
 * 【安全设计（照搬桌面版 settings.json 的经验）】
 *   - 任何读取失败 / JSON 损坏 / 类型不对 → 一律回退默认值，**绝不"猜成开启"**；
 *   - `writeApiEnabled` 只接受**布尔 true**（字符串 "true"、"1" 都算关闭）；
 *   - 数值一律钳位到安全区间（requestIntervalMs 硬下限 200）；
 *   - 拼错的键会被收集到 unknownKeys，供 UI 告警，避免"改了没生效却查不出原因"。
 *
 * 【降级】localStorage 不可用（隐私模式 / Node 单测）时自动退化为内存后端，功能不崩。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var S = (NS.store = NS.store || {});

  /** 存储键前缀，避免与站点自身或其它脚本的键冲突。 */
  S.PREFIX = 'szubkxk.';
  /** 当前数据结构版本；结构变更时递增并在 migrate() 里补迁移。 */
  S.SCHEMA_VERSION = 1;

  /** 存储键名表。 */
  S.KEYS = {
    SCHEMA_VERSION: 'schemaVersion',
    SETTINGS: 'settings',
    TASKS: 'tasks',
    CUSTOM_COURSES: 'customCourses',
    COURSE_CACHE: 'cache.courses',
    LOGS: 'logs',
  };

  /** 设置默认值（与 UI 上的说明表保持一致）。 */
  S.DEFAULT_SETTINGS = {
    // 红线：写接口总开关，默认关闭；只接受布尔 true
    writeApiEnabled: false,
    // 全局请求间隔：硬下限 200ms（见 NS.queue.INTERVAL_FLOOR_MS），默认 500
    requestIntervalMs: 500,
    // 请求队列上限
    maxQueueSize: 10,
    // 任务默认轮询间隔，不得低于 requestIntervalMs
    pollIntervalMs: 1500,
    // 面板日志条数上限
    logLimit: 500,
    // 课程卡片改造开关
    cardInject: true,
    // 悬浮窗状态
    panelVisible: true,
    panelCollapsed: false,
    panelLeft: null,
    panelTop: null,
  };

  /** 受支持的设置键（拼错的键会被识别并告警）。 */
  S.SUPPORTED_SETTINGS = Object.keys(S.DEFAULT_SETTINGS);

  /** 内存后端：localStorage 不可用时的兜底。带 isMemory 标记，供 Store 判断是否真的持久化。 */
  function memoryBackend() {
    var map = {};
    return {
      isMemory: true,
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
      },
      setItem: function (k, v) {
        map[k] = String(v);
      },
      removeItem: function (k) {
        delete map[k];
      },
    };
  }

  /**
   * 探测可用的 localStorage；不可用（不存在 / 隐私模式抛错）时返回 null。
   * @param {object} root 全局对象
   * @returns {(object|null)}
   */
  function detectBackend(root) {
    try {
      var ls = root.localStorage;
      if (!ls) return null;
      var probe = S.PREFIX + '__probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {
      return null;
    }
  }

  /**
   * 归一化设置对象。
   * @param {*} raw 原始设置（可能来自 localStorage，也可能是用户手改的坏数据）
   * @returns {{settings:object, unknownKeys:string[]}}
   */
  S.normalizeSettings = function (raw) {
    var d = S.DEFAULT_SETTINGS;
    var out = {};
    var unknownKeys = [];
    for (var k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    }
    if (!raw || typeof raw !== 'object') return { settings: out, unknownKeys: unknownKeys };

    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(d, key)) unknownKeys.push(key);
    }

    // 布尔项：只认真正的布尔值
    var boolKeys = ['writeApiEnabled', 'cardInject', 'panelVisible', 'panelCollapsed'];
    for (var i = 0; i < boolKeys.length; i++) {
      var bk = boolKeys[i];
      if (typeof raw[bk] === 'boolean') out[bk] = raw[bk];
    }

    out.requestIntervalMs = NS.util.clamp(
      raw.requestIntervalMs,
      NS.queue.INTERVAL_FLOOR_MS,
      NS.queue.INTERVAL_MAX_MS,
      d.requestIntervalMs
    );
    out.maxQueueSize = NS.util.clamp(raw.maxQueueSize, 1, NS.queue.MAX_QUEUE_SIZE_LIMIT, d.maxQueueSize);
    // 轮询间隔不得低于全局请求间隔
    out.pollIntervalMs = NS.util.clamp(raw.pollIntervalMs, out.requestIntervalMs, NS.queue.INTERVAL_MAX_MS, d.pollIntervalMs);
    out.logLimit = NS.util.clamp(raw.logLimit, 50, 5000, d.logLimit);

    // 面板坐标允许为 null（表示"未设置，用默认位置"）
    var numOrNull = function (v) {
      return typeof v === 'number' && isFinite(v) ? v : null;
    };
    out.panelLeft = numOrNull(raw.panelLeft);
    out.panelTop = numOrNull(raw.panelTop);

    return { settings: out, unknownKeys: unknownKeys };
  };

  /**
   * 构造存储实例。
   * @param {object} [options]
   * @param {object} [options.backend] 自定义后端（单测注入 / 强制内存）
   * @param {object} [options.root] 全局对象
   */
  function Store(options) {
    options = options || {};
    var glob = options.root || root;
    var backend = options.backend || detectBackend(glob) || memoryBackend();
    this._backend = backend;
    // 只有真正落到浏览器的 localStorage 才算"持久"；内存后端是降级运行
    this.isPersistent = backend.isMemory !== true;
    /** 最近一次读设置时发现的拼错键（供 UI 告警）。 */
    this.unknownSettingKeys = [];
  }

  /**
   * 读一个键并反序列化。
   * @param {string} key 逻辑键名（见 S.KEYS）
   * @param {*} fallback 读取/解析失败时的返回值
   * @returns {*} 值或 fallback
   */
  Store.prototype.get = function (key, fallback) {
    var raw;
    try {
      raw = this._backend.getItem(S.PREFIX + key);
    } catch (e) {
      return fallback;
    }
    if (raw === null || raw === undefined) return fallback;
    var parsed = NS.util.parseJson(raw, undefined);
    return parsed === undefined ? fallback : parsed;
  };

  /**
   * 写一个键（序列化失败 / 配额满都不抛异常，仅返回是否成功）。
   * @param {string} key 逻辑键名
   * @param {*} value 任意可 JSON 序列化的值
   * @returns {boolean} 是否写入成功
   */
  Store.prototype.set = function (key, value) {
    try {
      this._backend.setItem(S.PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  };

  /** 删除一个键。 */
  Store.prototype.remove = function (key) {
    try {
      this._backend.removeItem(S.PREFIX + key);
      return true;
    } catch (e) {
      return false;
    }
  };

  /**
   * 读取并归一化设置。
   * @returns {object} 已钳位、已回退的完整设置对象
   */
  Store.prototype.getSettings = function () {
    var res = S.normalizeSettings(this.get(S.KEYS.SETTINGS, null));
    this.unknownSettingKeys = res.unknownKeys;
    return res.settings;
  };

  /**
   * 覆盖保存设置（同样会归一化，确保坏值写不进库）。
   * @param {object} settings 完整设置对象
   * @returns {object} 实际生效的设置
   */
  Store.prototype.saveSettings = function (settings) {
    var res = S.normalizeSettings(settings);
    this.set(S.KEYS.SETTINGS, res.settings);
    this.unknownSettingKeys = res.unknownKeys;
    return res.settings;
  };

  /**
   * 局部更新设置。
   * @param {object} patch 待合并的键值
   * @returns {object} 实际生效的设置
   */
  Store.prototype.patchSettings = function (patch) {
    var current = this.getSettings();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
    }
    return this.saveSettings(current);
  };

  /** 读任务列表；任何异常都返回空数组。 */
  Store.prototype.getTasks = function () {
    var v = this.get(S.KEYS.TASKS, []);
    return Array.isArray(v) ? v : [];
  };

  /** 保存任务列表。 */
  Store.prototype.saveTasks = function (list) {
    return this.set(S.KEYS.TASKS, Array.isArray(list) ? list : []);
  };

  /** 读自定义课程列表；任何异常都返回空数组。 */
  Store.prototype.getCustomCourses = function () {
    var v = this.get(S.KEYS.CUSTOM_COURSES, []);
    return Array.isArray(v) ? v : [];
  };

  /** 保存自定义课程列表。 */
  Store.prototype.saveCustomCourses = function (list) {
    return this.set(S.KEYS.CUSTOM_COURSES, Array.isArray(list) ? list : []);
  };

  /**
   * 结构版本迁移（当前 v1，尚无历史版本需要转换）。
   * @returns {{from:(number|null), to:number, migrated:boolean}}
   */
  Store.prototype.migrate = function () {
    var from = this.get(S.KEYS.SCHEMA_VERSION, null);
    if (typeof from !== 'number') {
      this.set(S.KEYS.SCHEMA_VERSION, S.SCHEMA_VERSION);
      return { from: null, to: S.SCHEMA_VERSION, migrated: true };
    }
    if (from === S.SCHEMA_VERSION) return { from: from, to: S.SCHEMA_VERSION, migrated: false };
    // 未来：在这里按版本号逐级迁移旧数据
    this.set(S.KEYS.SCHEMA_VERSION, S.SCHEMA_VERSION);
    return { from: from, to: S.SCHEMA_VERSION, migrated: true };
  };

  /** 清空本脚本写入的全部键（不动站点自己的数据）。 */
  Store.prototype.clearAll = function () {
    for (var k in S.KEYS) {
      if (Object.prototype.hasOwnProperty.call(S.KEYS, k)) this.remove(S.KEYS[k]);
    }
    this.unknownSettingKeys = [];
  };

  S.Store = Store;
  S.memoryBackend = memoryBackend;
})(typeof globalThis !== 'undefined' ? globalThis : this);
