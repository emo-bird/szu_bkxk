/**
 * 入口装配：按页面分派。前台用户主动运行，不自动启动任务（红线⑤）。
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;

  function ready(fn) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  NS.main = function () {
    var path = root.location.pathname || '';
    var s = NS.settings();

    NS.info('SZUBKXK v2 已加载', {
      页面: path,
      写接口: NS.isWriteAllowed(s) ? '开启' : '关闭',
      请求间隔: NS.queue.intervalMs + 'ms',
      batchCode: s.batchCode || '(空，待自动获取)',
    });

    // 选课页：P0 课程列表优化
    // 拦截要尽早挂载（document-start），DOM 操作等 ready
    if (/default\/grablessons\.do/.test(path)) {
      NS.intercept.start();
      ready(function () {
        NS.list.start();
      });
      return;
    }

    // 课表页：M4 待实现（DOM 已取证于 docs/curriculum.do.html，留待下一轮）
    if (/default\/curriculum\.do/.test(path)) {
      NS.info('课表页：M4 尚未实现');
      return;
    }
  };

  NS.main();
})(typeof globalThis !== 'undefined' ? globalThis : this);
