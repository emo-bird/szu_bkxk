/**
 * core/conflict.js 的离线单测：站点课程 × 自定义课程、自定义 × 自定义、反向索引。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');
require('../src/core/conflict.js');

const NS = globalThis.SZUBKXK;
const CF = NS.conflict;

const S = (weekStart, weekEnd, parity, weekday, ps, pe) => ({
  weekStart: weekStart,
  weekEnd: weekEnd,
  weekParity: parity || 'all',
  weekday: weekday,
  periodStart: ps,
  periodEnd: pe,
});

const siteRec = (id, sessions, extra) =>
  Object.assign({ teachingClassId: id, courseName: '站点课' + id, teacherName: '老师' + id, sessions: sessions }, extra || {});

const customRec = (id, name, sessions) =>
  NS.customCourse.normalize({ id: id, name: name, sessions: sessions });

section('core/conflict.js sessionsOf');

test('优先用已解析的 sessions', () => {
  eq(CF.sessionsOf(siteRec('A', [S(1, 18, 'all', 2, 3, 4)])).length, 1);
});

test('没有 sessions 时现场解析 teachingPlace', () => {
  const sessions = CF.sessionsOf({ teachingClassId: 'A', teachingPlace: '5-18周 星期二 3-4节 致理楼' });
  eq(sessions.length, 1);
  eq(sessions[0].weekday, 2);
});

test('teachingPlace 为 null（MOOC）时返回空数组，不抛异常', () => {
  eq(CF.sessionsOf({ teachingClassId: 'A', teachingPlace: null }), []);
  eq(CF.sessionsOf(null), []);
});

section('core/conflict.js 自定义 × 站点');

test('时间重叠 → 记入 withSite 并计入统计', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'all', 2, 3, 4)])],
    customCourses: [customRec('c1', '重修高数', [S(1, 16, 'all', 2, 4, 5)])],
  });
  eq(report.byCustomId.c1.withSite.length, 1);
  eq(report.byCustomId.c1.withSite[0].teachingClassId, 'TC1');
  eq(report.byCustomId.c1.total, 1);
  eq(report.totals.customWithSite, 1);
});

test('反向索引 bySiteId 可反查冲突的自定义课程（供 M3 卡片标记）', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'all', 2, 3, 4)])],
    customCourses: [customRec('c1', '重修高数', [S(1, 16, 'all', 2, 4, 5)])],
  });
  eq(report.bySiteId.TC1.length, 1);
  eq(report.bySiteId.TC1[0].customName, '重修高数');
  eq(CF.conflictsOfSiteRecord({ teachingClassId: 'TC1' }, report).length, 1);
  eq(CF.conflictsOfSiteRecord({ teachingClassId: 'TC9' }, report).length, 0);
  eq(CF.conflictsOfSiteRecord(null, report).length, 0);
});

test('星期不同 / 周次不相交 → 不算冲突', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'all', 2, 3, 4)]), siteRec('TC2', [S(9, 16, 'all', 3, 3, 4)])],
    customCourses: [customRec('c1', '甲', [S(1, 8, 'all', 2, 3, 4)])],
  });
  eq(report.byCustomId.c1.withSite.length, 1, '只跟 TC1 冲突');
  eq(report.byCustomId.c1.withSite[0].teachingClassId, 'TC1');
});

test('单周 vs 双周 → 不算冲突', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'even', 2, 3, 4)])],
    customCourses: [customRec('c1', '甲', [S(1, 18, 'odd', 2, 3, 4)])],
  });
  eq(report.totals.customWithSite, 0);
});

test('站点记录没有教学班ID 时不写反向索引，但仍计冲突', () => {
  const report = CF.analyze({
    siteRecords: [{ courseName: '无ID课', sessions: [S(1, 18, 'all', 2, 3, 4)] }],
    customCourses: [customRec('c1', '甲', [S(1, 16, 'all', 2, 3, 4)])],
  });
  eq(report.byCustomId.c1.withSite.length, 1);
  eq(report.bySiteId, {});
});

section('core/conflict.js 自定义 × 自定义');

test('互相冲突的两门自定义课程各记一条', () => {
  const report = CF.analyze({
    siteRecords: [],
    customCourses: [customRec('c1', '甲', [S(1, 16, 'all', 2, 1, 2)]), customRec('c2', '乙', [S(1, 16, 'all', 2, 2, 3)])],
  });
  eq(report.byCustomId.c1.withCustom.length, 1);
  eq(report.byCustomId.c1.withCustom[0].name, '乙');
  eq(report.byCustomId.c2.withCustom[0].name, '甲');
  eq(report.totals.customWithCustom, 1);
  eq(report.byCustomId.c1.total, 1);
});

test('三门互不冲突 → 全为 0', () => {
  const report = CF.analyze({
    customCourses: [
      customRec('c1', '甲', [S(1, 16, 'all', 1, 1, 2)]),
      customRec('c2', '乙', [S(1, 16, 'all', 3, 1, 2)]),
      customRec('c3', '丙', [S(1, 16, 'all', 5, 1, 2)]),
    ],
  });
  eq(report.totals.customWithCustom, 0);
  eq(report.totals.customWithSite, 0);
});

section('core/conflict.js 边界与汇总');

test('空输入不炸', () => {
  const report = CF.analyze({});
  eq(report.byCustomId, {});
  eq(report.totals, { customWithSite: 0, customWithCustom: 0 });
  eq(CF.analyze(null).totals.customWithSite, 0);
});

test('没有时间的自定义课程不参与冲突', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'all', 2, 3, 4)])],
    customCourses: [customRec('c1', '没填时间')],
  });
  eq(report.byCustomId.c1.total, 0);
});

test('summarize 输出可读汇总', () => {
  const report = CF.analyze({
    siteRecords: [siteRec('TC1', [S(1, 18, 'all', 2, 3, 4)])],
    customCourses: [customRec('c1', '甲', [S(1, 16, 'all', 2, 3, 4)])],
  });
  const text = CF.summarize(report);
  ok(text.indexOf('自定义课程 1 门') !== -1, text);
  ok(text.indexOf('与站点课程冲突 1 处') !== -1, text);
  eq(CF.summarize(null), '无冲突数据');
});

section('core/conflict.js 站点课程彼此冲突');

test('findSiteConflicts 找出互相冲突的站点课程', () => {
  const pairs = CF.findSiteConflicts([
    siteRec('A', [S(1, 18, 'all', 2, 3, 4)]),
    siteRec('B', [S(1, 18, 'all', 2, 4, 5)]),
    siteRec('C', [S(1, 18, 'all', 5, 1, 2)]),
  ]);
  eq(pairs.length, 1);
  eq([pairs[0].a.teachingClassId, pairs[0].b.teachingClassId], ['A', 'B']);
});

test('findSiteConflicts 受 limit 限制', () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(siteRec('T' + i, [S(1, 18, 'all', 2, 3, 4)]));
  eq(CF.findSiteConflicts(list, { limit: 3 }).length, 3);
});

test('findSiteConflicts 忽略没有时间的课程', () => {
  eq(CF.findSiteConflicts([siteRec('A', []), siteRec('B', [])]), []);
  eq(CF.findSiteConflicts(null), []);
});
