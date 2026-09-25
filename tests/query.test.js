/**
 * data/query.js 的离线单测：筛选 / 排序 / 统计 / 去重。
 *
 * 重点钉住两条容易出错的行为：
 *   1. 排序必须**稳定**（同值保持原顺序）；
 *   2. 取不到的字段（null）**恒排最后**，不能因为降序就跑到最前面（"余量未知"排第一会误导用户）。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/time.js');
require('../src/data/model.js');
require('../src/core/conflict.js');
require('../src/data/query.js');

const NS = globalThis.SZUBKXK;
const Q = NS.query;

/** 造一条课程记录。 */
const mk = (id, extra) =>
  Object.assign(
    {
      teachingClassId: id,
      courseName: '课程' + id,
      teacherName: '老师' + id,
      courseNumber: 'C' + id,
      departmentName: '计算机学院',
      courseNatureName: '必修',
      teachingClassType: 'FANKC',
      classCapacity: 50,
      selectedCount: 40,
    },
    extra || {}
  );

const session = (weekday, ps, pe) => ({
  weekStart: 1,
  weekEnd: 16,
  weekParity: 'all',
  weekday: weekday,
  periodStart: ps,
  periodEnd: pe,
});

section('data/query.js 关键词匹配');

test('命中任一字段即算匹配，且大小写不敏感', () => {
  const r = mk('TC1', { courseName: '高等数学', teacherName: 'Zhang' });
  eq(Q.matchKeyword(r, '高数'), false, '不连续的中文不匹配');
  eq(Q.matchKeyword(r, '高等'), true);
  eq(Q.matchKeyword(r, 'zhang'), true, '应大小写不敏感');
  eq(Q.matchKeyword(r, 'TC1'), true, '教学班ID 也应可搜');
  eq(Q.matchKeyword(r, '计算机'), true, '开课单位也应可搜');
  eq(Q.matchKeyword(r, '不存在的东西'), false);
});

test('空关键词视为通过；空记录不通过', () => {
  eq(Q.matchKeyword(mk('TC1'), ''), true);
  eq(Q.matchKeyword(mk('TC1'), null), true);
  eq(Q.matchKeyword(mk('TC1'), '   '), true);
  eq(Q.matchKeyword(null, 'x'), false);
});

section('data/query.js 筛选');

const SAMPLE = [
  mk('A', { courseName: '高等数学', teachingClassType: 'FANKC', isMooc: false }),
  mk('B', { courseName: '大学英语', teachingClassType: 'XGXK', isMooc: false, classCapacity: 50, selectedCount: 50 }),
  mk('C', { courseName: '慕课甲', teachingClassType: 'MOOC', isMooc: true, classCapacity: null, selectedCount: null }),
  mk('D', { courseName: '体育', teachingClassType: 'TYKC', isFavorite: true, isConflict: true }),
];

const ids = (list) => list.map((r) => r.teachingClassId);

test('无条件筛选返回全部（副本）', () => {
  eq(ids(Q.filter(SAMPLE, {})), ['A', 'B', 'C', 'D']);
  const out = Q.filter(SAMPLE, {});
  out.push(mk('X'));
  eq(SAMPLE.length, 4, '不应影响原数组');
});

test('按类别筛选', () => {
  eq(ids(Q.filter(SAMPLE, { category: 'XGXK' })), ['B']);
  eq(ids(Q.filter(SAMPLE, { category: '不存在的类别' })), []);
});

test('只看有余量：余量未知的也要排除', () => {
  eq(ids(Q.filter(SAMPLE, { onlyFree: true })), ['A', 'D'], 'C 余量未知不能算有余量');
});

test('慕课的包含与排除', () => {
  eq(ids(Q.filter(SAMPLE, { excludeMooc: true })), ['A', 'B', 'D']);
  eq(ids(Q.filter(SAMPLE, { onlyMooc: true })), ['C']);
});

test('只看收藏 / 只看冲突标记', () => {
  eq(ids(Q.filter(SAMPLE, { onlyFavorite: true })), ['D']);
  eq(ids(Q.filter(SAMPLE, { onlyConflict: true })), ['D']);
});

test('词条筛选要真的生效（不是"传了就全过"）', () => {
  eq(ids(Q.filter(SAMPLE, { keyword: '英语' })), ['B']);
  eq(ids(Q.filter(SAMPLE, { keyword: '英语', category: 'FANKC' })), [], '条件之间是 AND');
  eq(ids(Q.filter(SAMPLE, { nature: '必修' })).length, 4, '都写了必修');
  eq(ids(Q.filter(SAMPLE, { nature: '选修' })), []);
  eq(ids(Q.filter(SAMPLE, { department: '计算机' })).length, 4);
  eq(ids(Q.filter(SAMPLE, { department: '外国语' })), []);
});

test('按星期筛选', () => {
  const list = [mk('A', { sessions: [session(2, 3, 4)] }), mk('B', { sessions: [session(5, 1, 2)] })];
  eq(ids(Q.filter(list, { weekday: 2 })), ['A']);
  eq(ids(Q.filter(list, { weekday: 5 })), ['B']);
  eq(ids(Q.filter(list, { weekday: 3 })), []);
});

test('只看与自定义课程冲突的教学班', () => {
  eq(ids(Q.filter(SAMPLE, { customConflictIds: ['B', 'D'] })), ['B', 'D']);
  eq(ids(Q.filter(SAMPLE, { customConflictIds: [] })), [], '空数组是"没有冲突项"，不是"不过滤"');
  eq(ids(Q.filter(SAMPLE, {})), ['A', 'B', 'C', 'D'], '不给该条件时不过滤');
});

section('data/query.js 时间排序键');

test('取最早一次课：周几 × 1000 + 起始节', () => {
  eq(Q.timeOrderOf({ sessions: [session(2, 3, 4)] }), 2003);
  eq(Q.timeOrderOf({ sessions: [session(5, 1, 2), session(2, 3, 4)] }), 2003, '应取最早的那次');
});

test('没有时间的记录返回 null（排序时靠后）', () => {
  eq(Q.timeOrderOf({ sessions: [] }), null);
  eq(Q.timeOrderOf({ teachingPlace: null }), null);
  eq(Q.timeOrderOf(null), null);
});

section('data/query.js 排序');

test('按余量升序，取不到的排最后', () => {
  const list = [
    mk('A', { classCapacity: 50, selectedCount: 45 }), // 5
    mk('B', { classCapacity: 50, selectedCount: 50 }), // 0
    mk('C', { classCapacity: null, selectedCount: null }), // 未知
    mk('D', { classCapacity: 50, selectedCount: 40 }), // 10
  ];
  eq(ids(Q.sort(list, 'remain', false)), ['B', 'A', 'D', 'C']);
});

test('按余量降序时，未知的仍然排最后（关键：不能因为降序跑到最前）', () => {
  const list = [
    mk('A', { classCapacity: 50, selectedCount: 45 }),
    mk('C', { classCapacity: null, selectedCount: null }),
    mk('D', { classCapacity: 50, selectedCount: 40 }),
  ];
  eq(ids(Q.sort(list, 'remain', true)), ['D', 'A', 'C']);
});

test('排序是稳定的：同值保持原有相对顺序', () => {
  const list = [
    mk('A', { classCapacity: 50, selectedCount: 45 }),
    mk('B', { classCapacity: 50, selectedCount: 45 }),
    mk('C', { classCapacity: 50, selectedCount: 45 }),
  ];
  eq(ids(Q.sort(list, 'remain', false)), ['A', 'B', 'C']);
  eq(ids(Q.sort(list, 'remain', true)), ['A', 'B', 'C']);
});

test('按时间排序遵循周几→节次', () => {
  const list = [
    mk('A', { sessions: [session(5, 1, 2)] }),
    mk('B', { sessions: [session(2, 5, 6)] }),
    mk('C', { sessions: [session(2, 1, 2)] }),
    mk('D', { sessions: [] }),
  ];
  eq(ids(Q.sort(list, 'time', false)), ['C', 'B', 'A', 'D']);
});

test('中文按拼音排序而不是码位', () => {
  const list = [mk('A', { courseName: '数学' }), mk('B', { courseName: '英语' }), mk('C', { courseName: '编译原理' })];
  const sorted = ids(Q.sort(list, 'name', false));
  eq(sorted[0], 'C', '“编”拼音应排最前（按码位会排错）');
});

test('按名称/教师排序，缺失值排最后', () => {
  const list = [mk('A', { courseName: 'A课' }), mk('B', { courseName: null }), mk('C', { courseName: 'C课' })];
  eq(ids(Q.sort(list, 'name', false)), ['A', 'C', 'B']);
  eq(ids(Q.sort(list, 'name', true)), ['C', 'A', 'B']);
});

test('未知排序键退化为原顺序；default + desc 反转', () => {
  const list = [mk('A'), mk('B'), mk('C')];
  eq(ids(Q.sort(list, '乱写', false)), ['A', 'B', 'C']);
  eq(ids(Q.sort(list, 'default', true)), ['C', 'B', 'A']);
});

test('排序不修改原数组，坏输入不炸', () => {
  const list = [mk('B'), mk('A')];
  Q.sort(list, 'name', false);
  eq(ids(list), ['B', 'A']);
  eq(Q.sort(null, 'name', false), []);
  eq(Q.sort([null, mk('A')], 'name').length, 2, '保留元素个数（null 排最后）');
});

section('data/query.js 统计与去重');

test('stats 汇总余量/MOOC/收藏/冲突与类别分布', () => {
  const st = Q.stats(SAMPLE);
  eq(st.total, 4);
  eq(st.free, 2, 'A、D 有余量');
  eq(st.full, 1, 'B 已满');
  eq(st.unknown, 1, 'C 余量未知');
  eq(st.mooc, 1);
  eq(st.favorite, 1);
  eq(st.conflict, 1);
  eq(st.byCategory, { FANKC: 1, XGXK: 1, MOOC: 1, TYKC: 1 });
});

test('stats 对空/坏输入安全', () => {
  eq(Q.stats([]).total, 0);
  eq(Q.stats(null).free, 0);
  eq(Q.stats([null]).total, 1);
});

test('uniqueValues 去重、去空、保持顺序', () => {
  const list = [mk('A', { courseNatureName: '必修' }), mk('B', { courseNatureName: '选修' }), mk('C', { courseNatureName: '必修' }), mk('D', { courseNatureName: null })];
  eq(Q.uniqueValues(list, 'courseNatureName'), ['必修', '选修']);
  eq(Q.uniqueValues(null, 'x'), []);
});
