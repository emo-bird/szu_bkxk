/**
 * 命名空间与全局元信息。
 *
 * 【模块约定】（所有 src 模块都遵守，构建时按路径字母序拼接，因此**模块间不得存在加载顺序依赖**）
 *   1. 每个模块是一个独立 IIFE，通过 `root.SZUBKXK = root.SZUBKXK || {}` 自行挂载到命名空间；
 *   2. 同一模块文件既可被浏览器直接执行，也可被 Node `require()` 用于离线单测；
 *   3. 不写顶层裸变量，避免与其他模块或站点脚本冲突。
 *
 * @param {object} root 全局对象（浏览器/Node 均为 globalThis）
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});

  /**
   * 脚本版本。构建时由 build/build.mjs 从 src/userscript-header.txt 的 @version 注入。
   * 源码里保留占位符，运行源码时读到的是占位符属正常现象。
   */
  NS.version = '__SZUBKXK_VERSION__';

  /** 全局元信息（供 UI 显示与调试）。 */
  NS.META = {
    name: '深大选课辅助',
    namespace: 'https://github.com/emo-bird/szu_bkxk',
    // 仅供技术学习研究；写接口默认关闭，详见 docs/方案-油猴脚本.md 第八节
    studyOnly: true,
  };

  /**
   * 极简工具集。放这里是为了避免每个模块重复造轮子。
   */
  NS.util = {
    /**
     * 数值钳位。
     * @param {number} value 待钳位值
     * @param {number} min 下限
     * @param {number} max 上限
     * @param {number} fallback 非法值（非有限数）时的回退值
     * @returns {number} 钳位后的数值
     */
    clamp: function (value, min, max, fallback) {
      var n = typeof value === 'number' ? value : Number(value);
      if (!isFinite(n)) return typeof fallback === 'number' ? fallback : min;
      if (n < min) return min;
      if (n > max) return max;
      return n;
    },

    /**
     * 安全 JSON 解析：任何异常都返回 fallback，绝不抛出。
     * @param {string} text 待解析文本
     * @param {*} fallback 解析失败时的返回值
     * @returns {*} 解析结果或 fallback
     */
    parseJson: function (text, fallback) {
      if (typeof text !== 'string' || text === '') return fallback;
      try {
        var v = JSON.parse(text);
        return v === null || v === undefined ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },

    /**
     * 多候选字段取值（对应桌面版 course_model._FIELD_CANDIDATES 的思路）。
     * 站点字段名不稳定，按候选顺序取第一个"非 null、非 undefined、非空字符串"的值。
     * @param {object} obj 数据对象
     * @param {string[]} candidates 候选字段名，按优先级排序
     * @param {*} fallback 全部落空时的返回值
     * @returns {*} 取到的值或 fallback
     */
    pick: function (obj, candidates, fallback) {
      if (!obj) return fallback;
      for (var i = 0; i < candidates.length; i++) {
        var v = obj[candidates[i]];
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return fallback;
    },

    /**
     * 生成短随机 id（任务、自定义课程等本地实体用）。
     * @returns {string} 形如 `t3f2a1b`
     */
    uid: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
