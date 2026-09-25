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

    // 接管必须尽早安装：站点可能在 DOMContentLoaded 前就发请求
    NS.hijack.install();

    NS.info('SZUBKXK v2 已加载', {
      页面: path,
      写接口: NS.isWriteAllowed(s) ? '开启' : '关闭',
      请求间隔: NS.queue.intervalMs + 'ms',
      batchCode: s.batchCode || '(空，待自动获取)',
    });

    // 选课页：P0 课程列表优化 + P1 悬浮窗
    if (/default\/grablessons\.do/.test(path)) {
      // 恢复上次的任务与监控（不自动启动执行，红线⑤）
      NS.tasks.load();
      NS.monitor.load();
      NS.custom.load();
      ready(function () {
        NS.list.start();
        NS.ui.start();
      });
      return;
    }

    // 课表页：M4 注入自定义课程 + 悬浮窗
    if (/default\/curriculum\.do/.test(path)) {
      NS.custom.load();
      ready(function () {
        NS.timetable.start();
        NS.ui.start();
      });
      return;
    }

    // 其他页面也恢复数据，便于悬浮窗查看
    NS.tasks.load();
    NS.monitor.load();
    NS.custom.load();
  };

  NS.main();
})(typeof globalThis !== 'undefined' ? globalThis : this);
