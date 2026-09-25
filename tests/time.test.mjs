/**
 * 教学时间解析测试。
 * 用例字符串全部取自 HAR 实测的 teachingPlace 原文（两种空格风格）。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const T = NS.time;

test('解析带空格形态（HAR-1 原文）', () => {
  const segs = T.parse('5-18周 星期二 3-4节 致理楼L1-707');
  eq(segs.length, 1);
  eq(segs[0].weekFrom, 5);
  eq(segs[0].weekTo, 18);
  eq(segs[0].parity, null);
  eq(segs[0].day, 2, '星期二 → 2');
  eq(segs[0].sectionFrom, 3);
  eq(segs[0].sectionTo, 4);
  eq(segs[0].place, '致理楼L1-707');
});

test('解析无空格形态（HAR-2 原文）', () => {
  const segs = T.parse('5-18周星期二3-4节致理楼L1-707');
  eq(segs.length, 1);
  eq(segs[0].day, 2);
  eq(segs[0].sectionFrom, 3);
  eq(segs[0].sectionTo, 4);
  eq(segs[0].place, '致理楼L1-707');
});

test('多段逗号分隔全部解析（HAR 原文，3 段）', () => {
  const segs = T.parse('5-18周 星期二 3-4节 致理楼L1-707,5-18周 星期四 1-2节 致理楼L1-707,5-18周 星期五 3-4节 致理楼L1-707');
  eq(segs.length, 3);
  eq(segs.map((s) => s.day), [2, 4, 5]);
  eq(segs.map((s) => s.sectionFrom), [3, 1, 3]);
});

test('中文逗号也能分隔', () => {
  eq(T.parse('5-18周星期二1-2节汇文楼H3-104，5-18周星期四3-4节汇文楼H3-104').length, 2);
});

test('单节次（如「3节」）首尾相同', () => {
  const segs = T.parse('1-16周 星期一 3节 致理楼L1-101');
  eq(segs[0].sectionFrom, 3);
  eq(segs[0].sectionTo, 3);
});

test('单周/双周标记被识别', () => {
  eq(T.parse('1-16周(单) 星期一 3-4节 致理楼L1-101')[0].parity, '单');
  eq(T.parse('1-16周（双） 星期一 3-4节 致理楼L1-101')[0].parity, '双');
});

test('单周周次（无区间）', () => {
  const s = T.parse('3周 星期一 1-2节 致理楼L1-101')[0];
  eq(s.weekFrom, 3);
  eq(s.weekTo, 3);
});

test('MOOC 的 null / 空串 / 非字符串 → 空数组（不抛错）', () => {
  eq(T.parse(null), []);
  eq(T.parse(''), []);
  eq(T.parse(undefined), []);
});

test('无法解析的段被丢弃，不影响其它段', () => {
  const segs = T.parse('乱码,5-18周 星期二 3-4节 致理楼L1-707');
  eq(segs.length, 1);
  eq(segs[0].day, 2);
});

test('星期七天全覆盖', () => {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const days = names.map((n) => T.parse(`1-2周 星期${n} 1-2节 X`)[0].day);
  eq(days, [1, 2, 3, 4, 5, 6, 7]);
});

test('weekMatches 处理单双周', () => {
  const odd = T.parse('1-10周(单) 星期一 1-2节 X')[0];
  ok(T.weekMatches(odd, 1), '第1周在内');
  ok(T.weekMatches(odd, 3), '第3周在内');
  ok(!T.weekMatches(odd, 2), '第2周不在内');
  ok(!T.weekMatches(odd, 11), '超出范围');
});

await run();
