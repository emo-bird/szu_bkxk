/**
 * core/timetable.js 的离线单测：泳道分配、裁剪、槽位矩阵、条目转换。
 *
 * 最关键的一条：**只有互相重叠的课才分列** —— 否则同一天里只要有一对课撞车，
 * 其余不相干的课都会被挤成窄条（这是日历布局最经典的错误）。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');
require('../src/core/conflict.js');
require('../src/core/timetable.js');

const NS = globalThis.SZUBKXK;
const TT = NS.timetable;

const S = (weekday, ps, pe) => ({
  weekStart: 1,
  weekEnd: 16,
  weekParity: 'all',
  weekday: weekday,
  periodStart: ps,
  periodEnd: pe,
});

const entry = (id, sessions, extra) =>
  Object.assign({ id: id, kind: 'custom', title: '课' + id, sessions: sessions }, extra || {});

/** 取 placements 的精简表示，便于断言。 */
const brief = (layout) =>
  layout.placements.map((p) => [p.entryId, p.day, p.startPeriod, p.endPeriod, p.lane, p.lanes]);

section('core/timetable.js 基本布局');

test('一门课一段 → 单块、第 0 泳道、单列', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 3, 4)])]);
  eq(brief(layout), [['A', 2, 3, 4, 0, 1]]);
  eq(layout.maxLanes, 1);
  eq(layout.skipped, 0);
});

test('同一门课多段 → 多块', () => {
  const layout = TT.buildLayout([entry('A', [S(1, 1, 2), S(3, 5, 6)])]);
  eq(brief(layout), [
    ['A', 1, 1, 2, 0, 1],
    ['A', 3, 5, 6, 0, 1],
  ]);
});

test('同一天互不重叠的课共用第 0 泳道', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(2, 3, 4)])]);
  eq(brief(layout), [
    ['A', 2, 1, 2, 0, 1],
    ['B', 2, 3, 4, 0, 1],
  ]);
  eq(layout.maxLanes, 1);
});

test('相邻但不重叠（1-2 与 3-4）也可以共用泳道', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(2, 2, 3)])]);
  // 1-2 与 2-3 真的重叠（共用第 2 节），应分列
  eq(layout.placements.map((p) => p.lanes), [2, 2]);
  const layout2 = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(2, 3, 4)])]);
  eq(layout2.placements.map((p) => p.lane), [0, 0]);
});

section('core/timetable.js 重叠与泳道');

test('两门重叠的课并排成两列，两块的列数都是 2', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 3, 5)]), entry('B', [S(2, 4, 6)])]);
  eq(brief(layout), [
    ['A', 2, 3, 5, 0, 2],
    ['B', 2, 4, 6, 1, 2],
  ]);
  eq(layout.maxLanes, 2);
});

test('三门互相重叠 → 三列', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 4)]), entry('B', [S(2, 2, 5)]), entry('C', [S(2, 3, 6)])]);
  eq(layout.placements.map((p) => p.lane), [0, 1, 2]);
  eq(layout.placements.map((p) => p.lanes), [3, 3, 3]);
});

test('关键：不相干的重叠组不能把整天都挤成多列', () => {
  // 第 2 天：1-2 与 2-3 重叠（一组，2 列）；9-10 单独（应与第 0 泳道，1 列）
  const layout = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(2, 2, 3)]), entry('C', [S(2, 9, 10)])]);
  const c = layout.placements.filter((p) => p.entryId === 'C')[0];
  eq(c.lane, 0, 'C 应回到第 0 泳道');
  eq(c.lanes, 1, 'C 所在组只有它自己，不该是 2 列');
  eq(layout.maxLanes, 2, '整体最大列数仍是 2');
});

test('通过中间一门课串起来的链式重叠共享列数', () => {
  // A(1-3) 与 B(3-5) 重叠；B 与 C(5-7) 重叠；A 与 C 不重叠
  const layout = TT.buildLayout([entry('A', [S(2, 1, 3)]), entry('B', [S(2, 3, 5)]), entry('C', [S(2, 5, 7)])]);
  // placements 是按 天→泳道→起始节 排过序的，所以按 id 查，别假设输入顺序
  const byId = {};
  layout.placements.forEach((p) => {
    byId[p.entryId] = p;
  });
  eq([byId.A.lane, byId.B.lane, byId.C.lane], [0, 1, 0], 'C 可以复用 A 的泳道');
  eq([byId.A.lanes, byId.B.lanes, byId.C.lanes], [2, 2, 2], '连通组内列数一致，避免渲染错位');
});

section('core/timetable.js 网格边界');

test('超出天数的星期被跳过并计数', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(7, 1, 2)])], { days: 5 });
  eq(layout.placements.length, 1);
  eq(layout.skipped, 1);
});

test('超出节次上限的部分被裁剪到边界', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 20)])], { periods: 12 });
  eq(brief(layout), [['A', 2, 1, 12, 0, 1]]);
});

test('完全在网格之外的节次被跳过', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 20, 22)])], { periods: 12 });
  eq(layout.placements, []);
  eq(layout.skipped, 1);
});

test('days/periods 会被钳位到合法范围', () => {
  eq(TT.buildLayout([], { days: 99 }).days, 7);
  eq(TT.buildLayout([], { days: 0 }).days, 1);
  eq(TT.buildLayout([], { periods: 999 }).periods, 24);
  eq(TT.buildLayout([]).days, 7);
  eq(TT.buildLayout([]).periods, 14);
});

section('core/timetable.js 健壮性');

test('没有 session 的条目被忽略', () => {
  const layout = TT.buildLayout([entry('A', []), entry('B', null), { id: 'C' }]);
  eq(layout.placements, []);
});

test('空输入与坏输入不炸', () => {
  eq(TT.buildLayout(null).placements, []);
  eq(TT.buildLayout([null, undefined, 'x']).placements, []);
  eq(TT.buildLayout([entry('A', [S(2, 1, 2)])], null).placements.length, 1);
});

test('布局顺序稳定：按 天 → 泳道 → 起始节', () => {
  const layout = TT.buildLayout([entry('A', [S(3, 1, 2)]), entry('B', [S(1, 5, 6)]), entry('C', [S(1, 1, 2)])]);
  eq(layout.placements.map((p) => p.entryId), ['C', 'B', 'A']);
});

test('placement 带上可渲染的文本与颜色', () => {
  const layout = TT.buildLayout([
    entry('A', [{ weekStart: 5, weekEnd: 18, weekParity: 'all', weekday: 2, periodStart: 3, periodEnd: 4, place: '致理楼' }], {
      color: '#abc',
      subtitle: '王老师',
      conflicts: 2,
    }),
  ]);
  const p = layout.placements[0];
  eq(p.sessionText, '5-18周 周二 3-4节');
  eq(p.place, '致理楼');
  eq(p.color, '#abc');
  eq(p.subtitle, '王老师');
  eq(p.conflicts, 2);
  eq(p.kind, 'custom');
});

section('core/timetable.js 槽位矩阵');

test('slotMatrix 把每块铺到它覆盖的每一节', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 3, 4)])], { periods: 5 });
  const m = TT.slotMatrix(layout);
  eq(m[2][3].length, 1);
  eq(m[2][4].length, 1);
  eq(m[2][5].length, 0);
  eq(m[1][3].length, 0);
});

test('同一格内的多门课都出现在矩阵里（渲染时按 lane 分列）', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 3, 4)]), entry('B', [S(2, 4, 5)])]);
  const m = TT.slotMatrix(layout);
  eq(m[2][4].length, 2);
  eq(m[2][4].map((p) => p.lane).sort(), [0, 1]);
});

test('slotMatrix 对坏输入安全', () => {
  eq(TT.slotMatrix(null).length, 1);
  eq(TT.slotMatrix({ days: 2, periods: 2 }).length, 3);
});

section('core/timetable.js 条目转换');

test('自定义课程 → 条目，并带上冲突数', () => {
  const courses = [
    NS.customCourse.normalize({ id: 'c1', name: '重修高数', teacher: '王', color: '#abc', sessions: [S(2, 1, 2)] }),
  ];
  const report = NS.conflict.analyze({
    siteRecords: [
      { teachingClassId: 'T1', courseName: '站点课', sessions: [S(2, 2, 3)] },
    ],
    customCourses: courses,
  });
  const entries = TT.entriesFromCustomCourses(courses, report);
  eq(entries.length, 1);
  eq(entries[0].kind, 'custom');
  eq(entries[0].title, '重修高数');
  eq(entries[0].conflicts, 1);
});

test('站点课程 → 条目，没时间的被排除', () => {
  const records = [
    { teachingClassId: 'T1', courseName: '甲', teacherName: '王', sessions: [S(1, 1, 2)] },
    { teachingClassId: 'T2', courseName: '慕课', sessions: [] },
  ];
  const entries = TT.entriesFromSiteRecords(records, null);
  eq(entries.length, 1);
  eq(entries[0].kind, 'site');
  eq(entries[0].id, 'site:T1');
  eq(entries[0].title, '甲');
});

test('站点课程条目也能反查与自定义课程的冲突', () => {
  const courses = [NS.customCourse.normalize({ id: 'c1', name: '自定义', sessions: [S(1, 1, 2)] })];
  const records = [{ teachingClassId: 'T1', courseName: '甲', sessions: [S(1, 1, 2)] }];
  const report = NS.conflict.analyze({ siteRecords: records, customCourses: courses });
  eq(TT.entriesFromSiteRecords(records, report)[0].conflicts, 1);
});

section('core/timetable.js 汇总');

test('summarize 输出可读信息', () => {
  const layout = TT.buildLayout([entry('A', [S(2, 1, 2)]), entry('B', [S(2, 1, 2)])]);
  const text = TT.summarize(layout);
  ok(text.indexOf('7 天 × 14 节') !== -1, text);
  ok(text.indexOf('自定义课块 2 个') !== -1, text);
  ok(text.indexOf('最大并排 2 列') !== -1, text);
  eq(TT.summarize(null), '(无布局)');
});
