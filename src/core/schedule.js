/**
 * 服务器时间对齐与精准定时。
 *
 * 【为什么需要】抢课的两个场景（"开始抢课"、"满课统一释放"）都要求**在某个时刻准时动手**，
 *   而用户的本机时钟可能偏几秒到几分钟。站点的每个业务响应都带 `timestamp`（13 位毫秒），
 *   用它算出"服务器时间 - 本机时间"的偏移，之后所有"几点几分"一律以服务器时间为准。
 *
 * 【精度做法】用请求发出与收到的时间取中点估算单程延迟（RTT/2 是最小误差估计），
 *   并且**只采纳延迟最小的样本**（NTP 的经典做法：最"干净"的那次测量最可信）。
 *
 * 【注意】本模块不联网、不读时钟以外的东西，可完全离线单测。
 *
 * 依赖：仅 NS.util（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var SC = (NS.schedule = NS.schedule || {});

  /** 到时判定的容差：进入这个窗口就算"到点了"，避免定时器精度导致反复重排。 */
  SC.DEFAULT_TOLERANCE_MS = 20;

  /**
   * 构造时钟同步器。
   * @param {object} [options]
   * @param {object} [options.timers] 定时器适配（{setTimeout, clearTimeout, now}），单测注入
   */
  function Clock(options) {
    options = options || {};
    this.timers = options.timers || {
      now: function () {
        return Date.now();
      },
      setTimeout: function (fn, delay) {
        return root.setTimeout(fn, delay);
      },
      clearTimeout: function (id) {
        return root.clearTimeout(id);
      },
    };
    this.offsetMs = 0; // serverNow - localNow
    this.synced = false;
    this.samples = 0;
    this.bestRttMs = Infinity;
    this.lastRttMs = null;
  }

  /**
   * 用一次观测校准偏移。
   * @param {number|string} serverTimestampMs 响应里的 timestamp（13 位毫秒）
   * @param {number} [sentAtMs] 请求发出时的本地时间（timers.now() 基准）
   * @param {number} [receivedAtMs] 收到响应时的本地时间
   * @returns {(number|null)} 采纳后的 offsetMs；样本非法/被丢弃时返回 null
   */
  Clock.prototype.observe = function (serverTimestampMs, sentAtMs, receivedAtMs) {
    var ts = Number(serverTimestampMs);
    if (!isFinite(ts) || ts <= 0) return null;

    var now = this.timers.now();
    var hasRtt = isFinite(sentAtMs) && isFinite(receivedAtMs) && receivedAtMs >= sentAtMs;
    var rtt = hasRtt ? receivedAtMs - sentAtMs : 0;
    var localRef = hasRtt ? (sentAtMs + receivedAtMs) / 2 : now;
    var offset = ts - localRef;

    this.lastRttMs = rtt;
    this.samples += 1;
    // 只采纳延迟最小的样本；无延迟信息（rtt=0）时视为理想样本
    if (!this.synced || rtt <= this.bestRttMs) {
      this.offsetMs = offset;
      this.bestRttMs = rtt;
      this.synced = true;
      return offset;
    }
    return null;
  };

  /**
   * 从一次已分类的响应里取 timestamp 并校准。
   * @param {object} classified NS.api.classifyResponse() 的结果
   * @param {number} [sentAtMs] 请求发出时间
   * @param {number} [receivedAtMs] 响应到达时间
   * @returns {(number|null)} 采纳后的 offsetMs
   */
  Clock.prototype.observeResponse = function (classified, sentAtMs, receivedAtMs) {
    if (!classified || classified.timestamp === null || classified.timestamp === undefined) return null;
    return this.observe(classified.timestamp, sentAtMs, receivedAtMs);
  };

  /**
   * 当前服务器时间。
   * @returns {number} 毫秒时间戳
   */
  Clock.prototype.serverNow = function () {
    return this.timers.now() + this.offsetMs;
  };

  /**
   * 距离某个服务器时刻还有多久。
   * @param {number} targetServerMs 目标服务器时刻
   * @returns {number} 毫秒；已过则为负数
   */
  Clock.prototype.remainingMs = function (targetServerMs) {
    return targetServerMs - this.serverNow();
  };

  /**
   * 在服务器时间到达 targetServerMs 时触发 callback（带漂移校正）。
   *
   * 单次 setTimeout 会因浏览器节流/系统休眠而偏早或偏晚，所以会重新计算剩余时间并重排。
   * **保证不早于目标时刻**：远未到点时按 (剩余 - 容差) 粗排以减少重排次数，
   * 进入容差窗口后按精确剩余时间细排，因而回调只会发生在 targetServerMs 之后。
   *
   * @param {number} targetServerMs 目标服务器时刻
   * @param {Function} callback 到点回调
   * @param {object} [options] {toleranceMs}
   * @returns {{cancel:Function}} 可取消句柄
   */
  Clock.prototype.scheduleAt = function (targetServerMs, callback, options) {
    var self = this;
    var tolerance = options && typeof options.toleranceMs === 'number' ? options.toleranceMs : SC.DEFAULT_TOLERANCE_MS;
    var state = { cancelled: false, timer: null };

    function tick() {
      if (state.cancelled) return;
      var remain = targetServerMs - self.serverNow();
      if (remain <= 0) {
        callback();
        return;
      }
      // 粗排阶段：提前 (remain - tolerance) 醒来，再重新校准漂移
      var delay = remain > tolerance ? remain - tolerance : remain;
      state.timer = self.timers.setTimeout(tick, delay);
    }

    tick();
    return {
      cancel: function () {
        state.cancelled = true;
        if (state.timer !== null) {
          self.timers.clearTimeout(state.timer);
          state.timer = null;
        }
      },
    };
  };

  SC.Clock = Clock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
