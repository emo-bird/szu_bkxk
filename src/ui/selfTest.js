/**
 * 自检面板：一键在页内跑完 core/selftest 的用例，并展示/回传结果。
 *
 * 用途：确认**装进浏览器的这一份脚本**是完好的（Node 单测只能验证源码，不是同一个产物）。
 *
 * 依赖：NS.selftest（延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var SV = (UI.selfTest = UI.selfTest || {});

  /** 建元素的小工具。 */
  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * 创建自检区块。
   * @param {object} options {doc, logger}
   * @returns {{element:Element, run:Function, lastResult:Function}}
   */
  SV.create = function (options) {
    options = options || {};
    var doc = options.doc;
    var logger = options.logger;

    var sec = el(doc, 'div', 'szubkxk-sec');
    sec.appendChild(el(doc, 'div', 'szubkxk-sec-title', '自检'));

    var row = el(doc, 'div', 'szubkxk-row');
    var btn = el(doc, 'button', 'szubkxk-btn', '运行自检');
    btn.type = 'button';
    row.appendChild(btn);
    sec.appendChild(row);

    var resultLine = el(doc, 'div', 'szubkxk-muted', '(未运行)');
    sec.appendChild(resultLine);

    var detail = el(doc, 'div', 'szubkxk-logs szubkxk-hidden');
    sec.appendChild(detail);

    var lastResult = null;

    function safe(fn, label) {
      return function () {
        try {
          fn();
        } catch (e) {
          if (logger) logger.error(NS.log.CATEGORY.SYSTEM, '自检面板出错：' + label, (e && e.message) || e);
        }
      };
    }

    function run() {
      var result = NS.selftest.run();
      lastResult = result;

      resultLine.textContent = '共 ' + result.total + ' 项，通过 ' + result.passed + ' 项，失败 ' + result.failed + ' 项';
      resultLine.className = result.failed === 0 ? 'szubkxk-ok' : 'szubkxk-warn';

      while (detail.firstChild) detail.removeChild(detail.firstChild);
      if (result.failed === 0) {
        detail.classList.add('szubkxk-hidden');
      } else {
        detail.classList.remove('szubkxk-hidden');
        for (var i = 0; i < result.failures.length; i++) {
          detail.appendChild(el(doc, 'div', 'szubkxk-log', '[FAIL] ' + result.failures[i].name + ' -> ' + result.failures[i].error));
        }
      }

      if (logger) {
        if (result.failed === 0) {
          logger.info(NS.log.CATEGORY.SYSTEM, '页内自检通过：' + result.passed + '/' + result.total);
        } else {
          logger.warn(NS.log.CATEGORY.SYSTEM, '页内自检失败：' + NS.selftest.format(result));
        }
      }
      return result;
    }

    btn.addEventListener('click', safe(run, '运行自检'));

    return {
      element: sec,
      run: run,
      lastResult: function () {
        return lastResult;
      },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
