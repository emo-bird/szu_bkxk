/**
 * 入口：装配 store / logger / 悬浮窗 / 请求链路 / 各功能面板，并输出一次环境侦察。
 *
 * 【加载顺序】本文件由构建脚本**强制排在最后**（见 scripts/build.mjs），
 *   因为它要装配其它模块；而按路径字母序 main.js 会排在 ui/ 之前。
 *
 * 【运行形态】只在**顶层页面**运行（@noframes 已挡一次，这里再挡一次），
 *   且只在用户打开选课站点时运行 —— 不做任何后台常驻。
 *
 * 【失败隔离】除"store/logger/面板"这一条关键路径外，其余每个面板都各自 try/catch：
 *   某个面板出错只会在日志里留下一条错误，**不影响其它功能**（真机排错时这一点很重要）。
 *
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = root.SZUBKXK;
  if (!NS || !NS.ui || !NS.ui.panel || !NS.store || !NS.log) {
    try {
      console.error('[szubkxk] 核心模块缺失，脚本未启动');
    } catch (e) {
      /* 控制台都不可用时只能放弃 */
    }
    return;
  }

  /** 启动：加载设置、建面板、装配各面板、做一次侦察。 */
  function boot() {
    var doc = root.document;
    if (!doc || !doc.body) return;
    // 不在 iframe 里跑，避免同一页面注入多份面板
    if (root.top !== root.self) return;

    /* ---------------- 关键路径：store / logger / 面板 ---------------- */
    var store;
    var logger;
    var settings;
    try {
      store = new NS.store.Store();
      var migration = store.migrate();
      settings = store.getSettings();
      logger = new NS.log.Logger({ limit: settings.logLimit, echo: true });

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
    } catch (e) {
      try {
        console.error('[szubkxk] 初始化失败：', e);
      } catch (e2) {
        /* 忽略 */
      }
      return;
    }

    var panel;
    try {
      panel = NS.ui.panel.create({ doc: doc, win: root, store: store, logger: logger, settings: settings });
      panel.mount();
    } catch (e) {
      try {
        console.error('[szubkxk] 悬浮窗创建失败：', e);
      } catch (e2) {
        /* 忽略 */
      }
      return;
    }

    /**
     * 受保护的初始化步骤：出错只记日志，不让整个脚本挂掉。
     * @param {string} label 步骤名（写进日志）
     * @param {Function} fn 步骤体
     * @returns {*} 步骤返回值；出错时返回 null
     */
    function step(label, fn) {
      try {
        return fn();
      } catch (e) {
        logger.error(
          NS.log.CATEGORY.SYSTEM,
          '初始化「' + label + '」失败（其余功能不受影响）',
          (e && e.message) || e
        );
        return null;
      }
    }

    /* ---------------- 请求链路：限流队列 → 唯一 HTTP 出口 → 任务执行器 ----------------
       这一步只是"装配"，不会发任何请求；任务要用户显式点开始才会跑。 */
    var chain =
      step('请求链路', function () {
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
        return { clock: clock, queue: queue, http: http, runner: runner };
      }) || {};
    var clock = chain.clock || null;
    var runner = chain.runner || null;

    /* ---------------- 课程数据缓存（被动采集的落地处） ---------------- */
    var courseCache = step('课程缓存', function () {
      return NS.courseCache.create({ store: store, logger: logger });
    });
    if (courseCache && courseCache.size() > 0) {
      logger.info(NS.log.CATEGORY.SYSTEM, '已载入本地课程缓存 ' + courseCache.size() + ' 条');
    }
    function siteRecords() {
      return courseCache ? courseCache.list() : [];
    }

    /* ---------------- 抢课任务 ---------------- */
    var taskView = step('任务面板', function () {
      var view = NS.ui.tasks.create({ doc: doc, runner: runner, logger: logger, clock: clock });
      panel.addSection(view.element);
      return view;
    });
    if (runner) {
      step('载入任务', function () {
        runner.onChange = function () {
          if (taskView) {
            try {
              taskView.refresh();
            } catch (e) {
              /* UI 刷新失败不影响调度 */
            }
          }
        };
        runner.load();
      });
    }

    /* ---------------- 自定义课程 ---------------- */
    var customView = step('自定义课程面板', function () {
      var view = NS.ui.customCourses.create({
        doc: doc,
        store: store,
        logger: logger,
        getSiteRecords: siteRecords,
      });
      panel.addSection(view.element);
      return view;
    });

    /* ---------------- 被动取数（零额外请求） ---------------- */
    var captureHandle = step('被动取数', function () {
      return NS.capture.install({
        win: root,
        onResponse: function (payload) {
          var records = NS.capture.recordsFromResponse(payload);
          if (records.length === 0 || !courseCache) return;
          var total = courseCache.add(records);
          logger.info(
            NS.log.CATEGORY.QUERY,
            '旁听到课程数据：本次 ' + records.length + ' 条，累计 ' + total + ' 条'
          );
          // 站点课程变了：冲突要重算，诊断面板要刷新
          if (customView) {
            try {
              customView.refresh();
            } catch (e) {
              /* 忽略 */
            }
          }
          if (courseDataView) {
            try {
              courseDataView.refresh();
            } catch (e) {
              /* 忽略 */
            }
          }
        },
      });
    });
    if (captureHandle) logger.info(NS.log.CATEGORY.SYSTEM, '已开始被动旁听课程数据（不发额外请求）');

    /* ---------------- 诊断类面板（放在面板最下方） ---------------- */
    var selfTestView = step('自检面板', function () {
      var view = NS.ui.selfTest.create({ doc: doc, logger: logger });
      panel.addSection(view.element, true);
      return view;
    });

    var courseDataView = step('课程数据面板', function () {
      var view = NS.ui.courseData.create({
        doc: doc,
        win: root,
        courseCache: courseCache,
        logger: logger,
        captureHandle: captureHandle,
        getCustomCourses: function () {
          return customView ? customView.list() : [];
        },
        getEnvText: function () {
          return NS.ui.recon ? NS.ui.recon.format(NS.ui.recon.collect(root)) : '';
        },
        getSelfTestText: function () {
          if (!NS.selftest || !selfTestView) return '';
          var result = selfTestView.lastResult();
          if (!result) result = selfTestView.run();
          return NS.selftest.format(result);
        },
      });
      panel.addSection(view.element, true);
      return view;
    });

    /* ---------------- 环境侦察 ---------------- */
    step('环境侦察', function () {
      var facts = NS.ui.recon.collect(root);
      logger.info(NS.log.CATEGORY.RECON, '页面侦察结果（可复制回传）', NS.ui.recon.format(facts));
    });

    /* ---------------- 供真机排错时在控制台直接操作 ---------------- */
    step('暴露调试句柄', function () {
      root.__SZUBKXK__ = {
        version: NS.version,
        store: store,
        logger: logger,
        panel: panel,
        clock: clock,
        queue: chain.queue || null,
        http: chain.http || null,
        runner: runner,
        courseCache: courseCache,
        capture: captureHandle,
        selfTest: selfTestView,
        courses: siteRecords,
      };
    });
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
