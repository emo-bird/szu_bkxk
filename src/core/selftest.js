/**
 * 页内自检：在**真实浏览器里**验证"构建出来的那一份脚本"是否完好。
 *
 * 【为什么需要】沙箱里只能用 Node 跑源码单测，而用户装的是 `dist/` 里拼接后的**另一个产物**。
 * 拼接顺序、`'use strict'` 作用域、模块漏拼一类问题，只有把整包在浏览器里跑一遍才看得出来。
 * 这个自检把核心不变量在页内重放一次，结论可以直接回传。
 *
 * 【约束】所有用例必须是**纯函数级、无网络、无 DOM、毫秒级**，随时可点。
 *
 * 依赖：几乎全部 NS.*（在用例函数体内延迟取值）。
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var ST = (NS.selftest = NS.selftest || {});

  /** 断言为真。 */
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
  }

  /** 深比较断言（JSON 序列化比较）。 */
  function eq(actual, expected, msg) {
    var a = JSON.stringify(actual);
    var b = JSON.stringify(expected);
    if (a !== b) throw new Error((msg || '不相等') + ' actual=' + a + ' expected=' + b);
  }

  /** 检查命名空间是否已挂载。 */
  function has(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || cur[parts[i]] === undefined) return false;
      cur = cur[parts[i]];
    }
    return true;
  }

  /**
   * 内置用例表。每条都是"改了会静默出大事"的不变量。
   * @type {{name:string, fn:Function}[]}
   */
  ST.CASES = [
    {
      name: '版本号已注入（不是占位符）',
      fn: function () {
        assert(typeof NS.version === 'string', 'version 非字符串');
        // 刻意**不写占位符字面量**：构建会对整个源码做字符串替换，
        // 字面量会被当成版本值替换掉，导致这条断言永远失败（踩过的坑）。
        // 占位符必然不符合 semver，用格式校验同样能抓到"未注入"。
        assert(/^\d+\.\d+\.\d+$/.test(NS.version), '版本号未正确注入，实际=' + NS.version);
      },
    },
    {
      name: '所有模块都已挂载',
      fn: function () {
        var required = [
          'util',
          'api',
          'queue',
          'log',
          'session',
          'store',
          'schedule',
          'task',
          'time',
          'customCourse',
          'conflict',
          'http',
          'runner',
          'model',
          'capture',
          'courseCache',
          'query',
          'timetable',
          'diagnostics',
          'selftest',
          'ui',
        ];
        var missing = [];
        for (var i = 0; i < required.length; i++) {
          if (!has(NS, required[i])) missing.push(required[i]);
        }
        eq(missing, [], '缺少模块');
      },
    },
    {
      name: '工具集：clamp / pick / parseJson',
      fn: function () {
        eq(NS.util.clamp(100, 200, 60000, 500), 200, 'clamp 下限');
        eq(NS.util.clamp(NaN, 200, 60000, 500), 500, 'clamp 回退');
        eq(NS.util.pick({ a: null, b: 'x' }, ['a', 'b'], 'fb'), 'x', 'pick');
        eq(NS.util.parseJson('{坏', 'FB'), 'FB', 'parseJson 坏数据');
      },
    },
    {
      name: '写开关只认布尔 true（安全红线）',
      fn: function () {
        eq(NS.api.isWriteAllowed({ writeApiEnabled: true }), true);
        eq(NS.api.isWriteAllowed({ writeApiEnabled: 'true' }), false, '字符串 "true" 必须视为关闭');
        eq(NS.api.isWriteAllowed({ writeApiEnabled: 1 }), false, '数字 1 必须视为关闭');
        eq(NS.api.isWriteAllowed({}), false);
      },
    },
    {
      name: '抢课报文字段顺序与实测一致',
      fn: function () {
        var p = NS.api.buildEnrollParam({
          studentCode: 'S',
          electiveBatchCode: 'B',
          teachingClassId: 'T',
          teachingClassType: 'FANKC',
        });
        eq(Object.keys(p.data), [
          'operationType',
          'studentCode',
          'electiveBatchCode',
          'teachingClassId',
          'isMajor',
          'campus',
          'teachingClassType',
        ]);
        eq(p.data.operationType, '1');
      },
    },
    {
      name: '查容量请求体格式',
      fn: function () {
        eq(NS.api.buildCapacityBody('TC-1', 'B-2'), 'teachingClassId=TC-1&batchCode=B-2');
      },
    },
    {
      name: '余量计算用 mainClassCapacity（字段可能全为 null）',
      fn: function () {
        eq(NS.api.capacityRemain({ mainClassCapacity: '55', mainElectiveNumber: '52' }), 3);
        eq(NS.api.capacityRemain({ classCapacity: null }), null, '取不到必须返回 null，不能是 0');
      },
    },
    {
      name: '限流队列间隔硬下限 200ms',
      fn: function () {
        eq(new NS.queue.RequestQueue({ intervalMs: 50 }).intervalMs, 200, '低于硬下限必须抬到 200');
        eq(new NS.queue.RequestQueue({}).intervalMs, 500, '默认 500');
      },
    },
    {
      name: '设置归一化：坏值一律回退，不猜成开启',
      fn: function () {
        var s = NS.store.normalizeSettings({ writeApiEnabled: 'true', requestIntervalMs: 10 }).settings;
        eq(s.writeApiEnabled, false, '字符串 true 必须回退为关闭');
        eq(s.requestIntervalMs, 200, '间隔必须钳位');
      },
    },
    {
      name: '任务模型：默认值 + 载入强制已停止',
      fn: function () {
        eq(NS.task.normalize({}).status, 'stopped');
        eq(NS.task.normalize({ kind: '乱写' }).kind, 'grab');
        var restored = NS.task.restoreOnLoad([{ id: 't1', status: 'running', enabled: true, targets: ['A'] }]);
        eq(restored[0].status, 'stopped', '重启后必须已停止');
        eq(restored[0].enabled, false, '重启后不得自动启用');
      },
    },
    {
      name: '教学时间解析（站点真实写法）',
      fn: function () {
        var r = NS.time.parseTeachingPlace('5-18周 星期二 3-4节 致理楼L1-707');
        eq(r.ok, true, '应解析成功');
        eq(r.sessions[0].weekday, 2);
        eq(r.sessions[0].periodStart, 3);
        eq(r.sessions[0].periodEnd, 4);
        eq(r.sessions[0].place, '致理楼L1-707');
        eq(NS.time.parseTeachingPlace(null).ok, false, 'null 必须安全');
      },
    },
    {
      name: '单双周互斥不算冲突',
      fn: function () {
        var a = { weekStart: 1, weekEnd: 16, weekParity: 'odd', weekday: 2, periodStart: 3, periodEnd: 4 };
        var b = { weekStart: 1, weekEnd: 16, weekParity: 'even', weekday: 2, periodStart: 3, periodEnd: 4 };
        eq(NS.time.sessionsOverlap(a, b), false);
        eq(NS.time.sessionsOverlap(a, a), true);
      },
    },
    {
      name: '课程模型：层级合并跳过 null + 兼容扁平结构',
      fn: function () {
        var merged = NS.model.mergeLevels({ courseNumber: 'C1' }, { courseNumber: null, teachingClassID: 'T1' });
        eq(merged.courseNumber, 'C1', 'tc 的 null 不得覆盖课程级字段');
        var flat = NS.model.flattenResponse({ dataList: [{ teachingClassID: 'T9', courseName: '校公选' }] });
        eq(flat.length, 1, '扁平结构必须也能取到记录');
        eq(flat[0].teachingClassId, 'T9');
      },
    },
    {
      name: '冲突分析：自定义课程 × 站点课程',
      fn: function () {
        var report = NS.conflict.analyze({
          siteRecords: [
            {
              teachingClassId: 'T1',
              courseName: '站点课',
              sessions: [{ weekStart: 1, weekEnd: 16, weekParity: 'all', weekday: 2, periodStart: 3, periodEnd: 4 }],
            },
          ],
          customCourses: [
            {
              id: 'c1',
              name: '自定义课',
              sessions: [{ weekStart: 1, weekEnd: 16, weekParity: 'all', weekday: 2, periodStart: 4, periodEnd: 5 }],
            },
          ],
        });
        eq(report.byCustomId.c1.withSite.length, 1, '应检出与站点课程的冲突');
        eq(report.bySiteId.T1.length, 1, '反向索引应可查');
      },
    },
    {
      name: '课程检索：排序稳定且取不到的恒排最后',
      fn: function () {
        var list = [
          { teachingClassId: 'A', classCapacity: 50, selectedCount: 45 },
          { teachingClassId: 'B', classCapacity: null, selectedCount: null },
          { teachingClassId: 'C', classCapacity: 50, selectedCount: 40 },
        ];
        var asc = NS.query.sort(list, 'remain', false).map(function (r) {
          return r.teachingClassId;
        });
        eq(asc, ['A', 'C', 'B'], '升序：未知排最后');
        var desc = NS.query.sort(list, 'remain', true).map(function (r) {
          return r.teachingClassId;
        });
        eq(desc, ['C', 'A', 'B'], '降序：未知仍排最后');
        eq(NS.query.filter(list, { onlyFree: true }).length, 2, '只看有余量应排除未知');
      },
    },
    {
      name: '课表布局：只有重叠的课才分列',
      fn: function () {
        var mk = function (id, day, ps, pe) {
          return {
            id: id,
            sessions: [{ weekStart: 1, weekEnd: 16, weekParity: 'all', weekday: day, periodStart: ps, periodEnd: pe }],
          };
        };
        // 同一天：一门重叠的课 + 一门完全不相干的课
        var layout = NS.timetable.buildLayout([mk('A', 2, 1, 2), mk('B', 2, 2, 3), mk('C', 2, 9, 10)]);
        var byId = {};
        layout.placements.forEach(function (p) {
          byId[p.entryId] = p;
        });
        assert(byId.A && byId.B && byId.C, '布局缺少课块');
        eq(byId.A.lanes, 2, 'A 与 B 重叠应分两列');
        eq(byId.C.lanes, 1, '不相干的 C 不该被挤成两列');
        eq(byId.C.lane, 0, 'C 应回到第 0 泳道');
      },
    },
    {
      name: '被动取数：只认关心的端点',
      fn: function () {
        eq(NS.capture.isInterestingUrl('http://x/xsxkapp/sys/xsxkapp/elective/programCourse.do'), true);
        eq(NS.capture.isInterestingUrl('http://x/xsxkapp/sys/xsxkapp/publicinfo/sysparam.do'), false);
      },
    },
    {
      name: '诊断时间格式化',
      fn: function () {
        eq(NS.diagnostics.formatTime(null), '(无)');
        assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(NS.diagnostics.formatTime(1700000000000)));
      },
    },
    {
      name: '本地存储可用（不可用会降级但不崩）',
      fn: function () {
        var st = new NS.store.Store();
        st.migrate();
        var s = st.getSettings();
        eq(s.writeApiEnabled, false, '写开关默认必须关闭');
        assert(typeof st.isPersistent === 'boolean');
      },
    },
  ];

  /**
   * 运行自检。
   * @param {object} [options] {cases} 自定义用例表（单测用）
   * @returns {{total:number, passed:number, failed:number, failures:object[], at:number}}
   */
  ST.run = function (options) {
    var cases = options && Array.isArray(options.cases) ? options.cases : ST.CASES;
    var failures = [];
    var passed = 0;
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      try {
        c.fn();
        passed += 1;
      } catch (e) {
        failures.push({ name: c.name, error: (e && e.message) || String(e) });
      }
    }
    return {
      total: cases.length,
      passed: passed,
      failed: failures.length,
      failures: failures,
      at: Date.now(),
      version: NS.version,
    };
  };

  /**
   * 把自检结果格式化成可回传文本。
   * @param {object} result ST.run() 的结果
   * @returns {string}
   */
  ST.format = function (result) {
    if (!result) return '(未运行自检)';
    var lines = [];
    lines.push('页内自检（版本 ' + (result.version || '?') + '）');
    lines.push('共 ' + result.total + ' 项，通过 ' + result.passed + ' 项，失败 ' + result.failed + ' 项');
    if (result.failed === 0) {
      lines.push('[OK] 全部通过：构建产物完好');
    } else {
      for (var i = 0; i < result.failures.length; i++) {
        lines.push('[FAIL] ' + result.failures[i].name + ' -> ' + result.failures[i].error);
      }
    }
    return lines.join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
