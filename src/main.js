/**
 * 入口：装配 store / logger / 悬浮窗，并输出一次 M0 侦察。
 *
 * 【加载顺序】本文件由构建脚本**强制排在最后**（见 scripts/build.mjs），
 *   因为它要装配其它模块；而按路径字母序 main.js 会排在 ui/ 之前。
 *
 * 【运行形态】只在**顶层页面**运行（@noframes 已挡一次，这里再挡一次），
 *   且只在用户打开选课站点时运行 —— 不做任何后台常驻。
 *
 * 【失败安全】整个启动过程包 try/catch：脚本报错不能把站点页面搞坏。
 *   注意控制台中文在 GBK 终端会乱码，排错请看 [szubkxk] 前缀。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  if (!NS || !NS.ui || !NS.ui.panel || !NS.store || !NS.log) return;

  /** 启动：加载设置、建面板、做一次侦察。 */
  function boot() {
    try {
      var doc = root.document;
      if (!doc || !doc.body) return;
      // 不在 iframe 里跑，避免同一页面注入多份面板
      if (root.top !== root.self) return;

      var store = new NS.store.Store();
      var migration = store.migrate();
      var settings = store.getSettings();
      var logger = new NS.log.Logger({ limit: settings.logLimit, echo: true });

      logger.info(NS.log.CATEGORY.SYSTEM, '脚本已注入 v' + NS.version + '（' + root.location.href + '）');
      if (!store.isPersistent) {
        logger.warn(NS.log.CATEGORY.SYSTEM, 'localStorage 不可用，本次运行的设置与任务不会被保存');
      }
      if (migration.migrated) {
        logger.info(NS.log.CATEGORY.SYSTEM, '数据结构迁移：' + migration.from + ' -> ' + migration.to);
      }
      logger.info(
        NS.log.CATEGORY.SYSTEM,
        '写接口开关：' + (settings.writeApiEnabled ? '★已开启★（会真实提交）' : '关闭（只构造并打印报文）')
      );
      if (store.unknownSettingKeys.length) {
        logger.warn(NS.log.CATEGORY.SYSTEM, '设置里有无法识别的键：' + store.unknownSettingKeys.join('、'));
      }

      var panel = NS.ui.panel.create({
        doc: doc,
        win: root,
        store: store,
        logger: logger,
        settings: settings,
      });
      panel.mount();

      // ---- 请求链路：限流队列 → 唯一 HTTP 出口 → 任务执行器 ----
      // 这一步只是"装配"，不会发任何请求；任务要用户显式点开始才会跑。
      var clock = new NS.schedule.Clock();
      var queue = new NS.queue.RequestQueue({
        intervalMs: settings.requestIntervalMs,
        maxQueueSize: settings.maxQueueSize,
      });
      var http = new NS.http.HttpClient({
        queue: queue,
        logger: logger,
        clock: clock,
        timeoutMs: settings.requestTimeoutSeconds * 1000,
      });
      var runner = new NS.runner.Runner({
        http: http,
        clock: clock,
        logger: logger,
        store: store,
        // 以面板里的当前设置为准，用户改完立即生效
        getSettings: function () {
          return panel.settings;
        },
      });
      // 任务管理界面（插在"会话"与"设置"之间）
      var taskView = null;
      if (NS.ui.tasks) {
        taskView = NS.ui.tasks.create({ doc: doc, runner: runner, logger: logger, clock: clock });
        panel.addSection(taskView.element);
        runner.onChange = function () {
          if (taskView) taskView.refresh();
        };
      }
      runner.load();

      // 自定义课程（M4）：只存 localStorage，参与冲突计算
      if (NS.ui.customCourses) {
        var customView = NS.ui.customCourses.create({ doc: doc, store: store, logger: logger });
        panel.addSection(customView.element);
      }

      // 被动取数（M3 数据层）：只旁听页面自己发出的请求，**不额外发一条请求**
      var captured = [];
      if (NS.capture && NS.model) {
        NS.capture.install({
          win: root,
          onResponse: function (payload) {
            var records = NS.capture.recordsFromResponse(payload);
            if (records.length === 0) return;
            captured = NS.model.mergeRecords([captured, records]);
            logger.info(
              NS.log.CATEGORY.QUERY,
              '旁听到课程数据：本次 ' + records.length + ' 条，累计 ' + captured.length + ' 条'
            );
          },
        });
        logger.info(NS.log.CATEGORY.SYSTEM, '已开始被动旁听课程数据（不发额外请求）');
      }

      if (NS.ui.recon) {
        var facts = NS.ui.recon.collect(root);
        logger.info(NS.log.CATEGORY.RECON, '页面侦察结果（可复制回传）', NS.ui.recon.format(facts));
      }

      // 供真机排错时在控制台直接操作
      root.__SZUBKXK__ = {
        version: NS.version,
        store: store,
        logger: logger,
        panel: panel,
        clock: clock,
        queue: queue,
        http: http,
        runner: runner,
        courses: function () {
          return captured.slice();
        },
      };
    } catch (e) {
      try {
        console.error('[szubkxk] 启动失败：', e);
      } catch (e2) {
        /* 控制台都不可用时只能放弃 */
      }
    }
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
