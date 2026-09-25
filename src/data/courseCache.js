/**
 * 课程数据缓存：被动采集到的课程记录在此累计、去重、持久化，并向 UI 广播变化。
 *
 * 【为什么需要】采集是"多次追加"的（翻页、切类别、重新查询），而 UI 关心的是
 * "当前有哪些课程"。这一层负责把碎片拼成一份一致的数据，并落 localStorage 供下次直接看。
 *
 * 【纪律】只存课程数据，**不含任何凭证**；读失败一律回退空列表，不抛异常。
 *
 * 依赖：NS.model / NS.store（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var CC = (NS.courseCache = NS.courseCache || {});

  /**
   * 创建课程缓存。
   * @param {object} [options]
   * @param {object} [options.store] NS.store.Store 实例
   * @param {object} [options.logger] 日志器
   * @returns {object} 缓存 API
   */
  CC.create = function (options) {
    options = options || {};
    var store = options.store || null;
    var logger = options.logger || null;

    var records = [];
    var updatedAt = null;
    var subscribers = [];

    /** 从存储载入（只在构造时做一次）。 */
    function load() {
      if (!store) return;
      var saved = store.get(NS.store.KEYS.COURSE_CACHE, null);
      if (!saved || typeof saved !== 'object' || !Array.isArray(saved.records)) return;
      records = saved.records;
      updatedAt = typeof saved.updatedAt === 'number' ? saved.updatedAt : null;
    }

    /** 落盘（失败只告警，不影响内存数据）。 */
    function persist() {
      if (!store) return;
      var ok = store.set(NS.store.KEYS.COURSE_CACHE, { updatedAt: updatedAt, records: records });
      if (!ok && logger) logger.warn(NS.log.CATEGORY.SYSTEM, '课程缓存写入失败（可能超出存储配额）');
    }

    /** 广播当前列表。 */
    function notify() {
      for (var i = 0; i < subscribers.length; i++) {
        try {
          subscribers[i](records.slice());
        } catch (e) {
          if (logger) logger.error(NS.log.CATEGORY.SYSTEM, '课程缓存订阅者异常', (e && e.message) || e);
        }
      }
    }

    load();

    return {
      /** 当前课程记录（副本）。 */
      list: function () {
        return records.slice();
      },

      /** 记录条数。 */
      size: function () {
        return records.length;
      },

      /** 最近一次更新时间（毫秒），无数据时为 null。 */
      updatedAt: function () {
        return updatedAt;
      },

      /**
       * 追加一批课程记录（按 teachingClassId 去重合并）。
       * @param {object[]} incoming 新记录
       * @returns {number} 合并后总条数
       */
      add: function (incoming) {
        var list = Array.isArray(incoming) ? incoming : [];
        if (list.length === 0) return records.length;
        records = NS.model.mergeRecords([records, list]);
        updatedAt = Date.now();
        persist();
        notify();
        return records.length;
      },

      /** 用一批记录整体替换（"刷新查询"语义）。 */
      replace: function (incoming) {
        records = NS.model.mergeRecords([Array.isArray(incoming) ? incoming : []]);
        updatedAt = Date.now();
        persist();
        notify();
        return records.length;
      },

      /** 清空。 */
      clear: function () {
        records = [];
        updatedAt = null;
        persist();
        notify();
      },

      /**
       * 订阅变化。
       * @param {Function} fn 回调 function(records)
       * @returns {Function} 退订函数
       */
      subscribe: function (fn) {
        if (typeof fn === 'function') subscribers.push(fn);
        return function () {
          var i = subscribers.indexOf(fn);
          if (i !== -1) subscribers.splice(i, 1);
        };
      },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
