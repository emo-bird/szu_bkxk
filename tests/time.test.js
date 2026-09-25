/**
 * core/time.js 的离线单测：教学时间解析 + 冲突计算 + 自定义课程模型。
 *
 * 解析用的样例全部取自 docs/接口逆向记录.md §3.3 记载的真实字段形态。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');

const NS = globalThis.SZUBKXK;
const TI = NS.time;
const CC = NS.customCourse;

section('core/time.js 教学时间解析');

test('标准形态：5-18周 星期二 3-4节 地点', () => {
  const r = TI.parseTeachingPlace('5-18周 星期二 3-4节 致理楼L1-707');
  eq(r.ok, true);
  eq(r.sessions.length, 1);
  eq(r.sessions[0], {
    weekStart: 5,
    weekEnd: 18,
    weekParity: 'all',
    weekday: 2,
    periodStart: 3,
    periodEnd: 4,
    place: '致理楼L1-707',
  });
});

test('单周：1-16周单周 星期三 5-6节 → parity=odd，地点不带残留"周"字', () => {
  const r = TI.parseTeachingPlace('1-16周单周 星期三 5-6节 A101');
  eq(r.sessions[0].weekParity, 'odd');
  eq(r.sessions[0].weekday, 3);
  eq(r.sessions[0].place, 'A101');
});

test('双周：parity=even', () => {
  eq(TI.parseTeachingPlace('1-16周双周 星期四 7-8节 B202').sessions[0].weekParity, 'even');
});

test('括号写法的单双周也能识别，且地点干净', () => {
  const r = TI.parseTeachingPlace('1-16周(单) 星期五 1-2节 C303');
  eq(r.sessions[0].weekParity, 'odd');
  eq(r.sessions[0].place, 'C303');
});

test('连堂/单节次', () => {
  eq(TI.parseTeachingPlace('1-18周 星期一 3节 X').sessions[0].periodStart, 3);
  eq(TI.parseTeachingPlace('1-18周 星期一 3节 X').sessions[0].periodEnd, 3);
});

test('多个节次段：1-2,5-6节 拆成两个 session', () => {
  const r = TI.parseTeachingPlace('1-18周 星期二 1-2,5-6节 D404');
  eq(r.sessions.length, 2);
  eq([r.sessions[0].periodStart, r.sessions[0].periodEnd], [1, 2]);
  eq([r.sessions[1].periodStart, r.sessions[1].periodEnd], [5, 6]);
  eq(r.sessions[0].place, 'D404');
});

test('多段课程时间（同一字符串里出现两次 x周）', () => {
  const r = TI.parseTeachingPlace('1-8周 星期一 1-2节 甲楼; 9-16周 星期一 3-4节 乙楼');
  eq(r.sessions.length, 2);
  eq(r.sessions[0].place, '甲楼');
  eq(r.sessions[1].place, '乙楼');
  eq(r.sessions[1].weekStart, 9);
  eq(r.sessions[1].periodStart, 3);
});

test('全角数字与全角标点', () => {
  const r = TI.parseTeachingPlace('５-１８周 星期二 ３-４节 某楼');
  eq(r.ok, true);
  eq(r.sessions[0].weekStart, 5);
  eq(r.sessions[0].periodEnd, 4);
});

test('"周天"/"星期日" 都算周日(7)', () => {
  eq(TI.parseTeachingPlace('1-18周 周天 1-2节 X').sessions[0].weekday, 7);
  eq(TI.parseTeachingPlace('1-18周 星期日 1-2节 X').sessions[0].weekday, 7);
});

test('缺周次时用 1..18 兜底并置 assumedWeeks', () => {
  const r = TI.parseTeachingPlace('星期二 3-4节 某楼');
  eq(r.assumedWeeks, true);
  eq(r.sessions[0].weekStart, 1);
  eq(r.sessions[0].weekEnd, 18);
});

test('MOOC 的 null / 空串 → ok=false，不抛异常', () => {
  eq(TI.parseTeachingPlace(null).ok, false);
  eq(TI.parseTeachingPlace('').ok, false);
  eq(TI.parseTeachingPlace('   ').ok, false);
  eq(TI.parseTeachingPlace(undefined).sessions, []);
});

test('无法识别的内容不产生 session（不猜）', () => {
  const r = TI.parseTeachingPlace('网络课程 自主学习');
  eq(r.ok, false);
  eq(r.sessions, []);
});

test('parsePeriods 容错', () => {
  eq(TI.parsePeriods('1-2'), [{ start: 1, end: 2 }]);
  eq(TI.parsePeriods('5'), [{ start: 5, end: 5 }]);
  eq(TI.parsePeriods('4-3'), [{ start: 3, end: 4 }], '倒序自动交换');
  eq(TI.parsePeriods('1-2，5'), [{ start: 1, end: 2 }, { start: 5, end: 5 }], '全角逗号');
  eq(TI.parsePeriods(''), []);
  eq(TI.parsePeriods('abc'), []);
});

section('core/time.js 冲突计算');

const S = (weekStart, weekEnd, parity, weekday, ps, pe) => ({
  weekStart: weekStart,
  weekEnd: weekEnd,
  weekParity: parity || 'all',
  weekday: weekday,
  periodStart: ps,
  periodEnd: pe,
});

test('同一天、周次与节次都相交 → 冲突', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'all', 2, 3, 4), S(5, 8, 'all', 2, 4, 5)), true, '第4节重叠');
});

test('星期不同 → 不冲突', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'all', 2, 3, 4), S(1, 18, 'all', 3, 3, 4)), false);
});

test('周次不相交 → 不冲突', () => {
  eq(TI.sessionsOverlap(S(1, 8, 'all', 2, 3, 4), S(9, 16, 'all', 2, 3, 4)), false);
});

test('节次紧邻但不重叠 → 不冲突', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'all', 2, 3, 4), S(1, 18, 'all', 2, 5, 6)), false);
});

test('单周 vs 双周 → 永不冲突', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'odd', 2, 3, 4), S(1, 18, 'even', 2, 3, 4)), false);
});

test('单周 vs 单周 → 冲突', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'odd', 2, 3, 4), S(3, 9, 'odd', 2, 3, 4)), true);
});

test('每周 vs 单周 → 看交集里有没有单周', () => {
  eq(TI.sessionsOverlap(S(1, 18, 'all', 2, 3, 4), S(2, 2, 'odd', 2, 3, 4)), false, '第2周是双周');
  eq(TI.sessionsOverlap(S(1, 18, 'all', 2, 3, 4), S(3, 3, 'odd', 2, 3, 4)), true, '第3周是单周');
});

test('每双周判定（lo 为偶数时也要正确）', () => {
  eq(TI.weekRangeHasParity(2, 2, 'even'), true);
  eq(TI.weekRangeHasParity(2, 2, 'odd'), false);
  eq(TI.weekRangeHasParity(1, 1, 'odd'), true);
  eq(TI.weekRangeHasParity(1, 1, 'even'), false);
  eq(TI.weekRangeHasParity(4, 7, 'even'), true);
  eq(TI.weekRangeHasParity(4, 7, 'all'), true);
});

test('combinedParity 语义', () => {
  eq(TI.combinedParity('all', 'odd'), 'odd');
  eq(TI.combinedParity('odd', 'all'), 'odd');
  eq(TI.combinedParity('all', 'all'), 'all');
  eq(TI.combinedParity('odd', 'odd'), 'odd');
  eq(TI.combinedParity('odd', 'even'), null);
});

test('findConflictPairs 找出所有冲突对', () => {
  const site = [S(1, 18, 'all', 2, 3, 4)];
  const custom = [S(1, 18, 'all', 2, 4, 5), S(1, 18, 'all', 5, 1, 2)];
  const pairs = TI.findConflictPairs(site, custom);
  eq(pairs.length, 1);
  eq(pairs[0].indexB, 0);
});

test('findConflictPairs 自比较时不与自身配对', () => {
  const list = [S(1, 18, 'all', 2, 3, 4), S(1, 18, 'all', 2, 3, 4), S(1, 18, 'all', 6, 3, 4)];
  eq(TI.findConflictPairs(list, list).length, 1, '只有前两个互相冲突');
});

test('非法 session 被安全丢弃', () => {
  eq(TI.normalizeSession(null), null);
  eq(TI.normalizeSession({ weekday: 9, periodStart: 1 }), null);
  eq(TI.normalizeSession({ weekday: 2 }), null);
  eq(TI.normalizeSessions([{ weekday: 2, periodStart: 1 }, null, 'x']).length, 1);
  eq(TI.sessionsOverlap(null, null), false);
});

test('formatSession / formatSessions 可读输出', () => {
  eq(TI.formatSession(S(5, 18, 'all', 2, 3, 4)), '5-18周 周二 3-4节');
  eq(TI.formatSession(S(8, 8, 'odd', 7, 3, 3)), '8周单 周日 3节');
  eq(TI.formatSessions([S(1, 2, 'all', 1, 1, 2), S(3, 4, 'all', 1, 3, 4)]), '1-2周 周一 1-2节; 3-4周 周一 3-4节');
  eq(TI.formatSessions([]), '');
});

section('core/customCourse.js 自定义课程');

test('从 sessions 直接构造', () => {
  const c = CC.normalize({ name: '重修高数', sessions: [S(1, 18, 'all', 3, 1, 2)] });
  eq(c.name, '重修高数');
  eq(c.sessions.length, 1);
  eq(c.color, CC.COLORS[0]);
  ok(c.id && c.id.length > 0);
});

test('从 timeText 解析构造（用户按站点格式粘贴）', () => {
  const c = CC.normalize({ name: '外院日语', timeText: '1-16周 星期五 5-6节 文科楼' });
  eq(c.sessions.length, 1);
  eq(c.sessions[0].weekday, 5);
  eq(c.place, '文科楼', '地点应能从时间串里带出来');
});

test('颜色非法时回退默认色', () => {
  eq(CC.normalize({ color: 'red' }).color, CC.COLORS[0]);
  eq(CC.normalize({ color: '#abc' }).color, '#abc');
  eq(CC.normalize({ color: '#1a5fb4' }).color, '#1a5fb4');
});

test('create 补齐时间戳；坏输入不炸', () => {
  const c = CC.create({ name: 'x' });
  ok(typeof c.createdAt === 'number' && c.createdAt > 0);
  eq(CC.normalize(null).sessions, []);
  eq(CC.normalizeList('oops'), []);
});

test('与站点课程时间求冲突', () => {
  const course = CC.normalize({ name: '实验', timeText: '1-18周 星期二 3-4节 实验楼' });
  const siteSessions = [S(1, 18, 'all', 2, 4, 5)];
  eq(CC.conflictsWith(course, siteSessions).length, 1);
  eq(CC.conflictsWith(course, [S(1, 18, 'all', 5, 4, 5)]).length, 0);
});

test('display 渲染各列', () => {
  const c = { name: '甲', teacher: '王老师', sessions: [S(1, 18, 'all', 2, 3, 4)] };
  eq(CC.display(c, 'name'), '甲');
  eq(CC.display(c, 'teacher'), '王老师');
  eq(CC.display(c, 'timeText'), '1-18周 周二 3-4节');
  eq(CC.display(c, 'sessionCount'), '1');
  eq(CC.display({}, 'timeText'), '(未设置时间)');
});
