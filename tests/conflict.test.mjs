/**
 * 冲突判定测试：单双周 / 周次 / 节次。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const T = NS.time;

const A = '5-18周 星期二 3-4节 致理楼L1-707';
const B = '5-18周 星期二 3-4节 汇文楼H3-104';

test('同天同节次同周 → 冲突（地点不同也算）', () => {
  ok(T.conflicts(A, B));
});

test('同天但节次不重叠 → 不冲突', () => {
  ok(!T.conflicts('5-18周 星期二 3-4节 X', '5-18周 星期二 5-6节 Y'));
});

test('节次相邻但不重叠 → 不冲突', () => {
  ok(!T.conflicts('5-18周 星期二 3-4节 X', '5-18周 星期二 5-6节 Y'));
});

test('节次部分重叠 → 冲突', () => {
  ok(T.conflicts('5-18周 星期二 3-4节 X', '5-18周 星期二 4-5节 Y'));
});

test('不同天 → 不冲突', () => {
  ok(!T.conflicts('5-18周 星期二 3-4节 X', '5-18周 星期四 3-4节 Y'));
});

test('周次无交集 → 不冲突', () => {
  ok(!T.conflicts('1-4周 星期二 3-4节 X', '5-8周 星期二 3-4节 Y'));
});

test('周次有交集 → 冲突', () => {
  ok(T.conflicts('1-8周 星期二 3-4节 X', '5-18周 星期二 3-4节 Y'));
});

test('单周 vs 双周 → 不冲突', () => {
  ok(!T.conflicts('1-16周(单) 星期二 3-4节 X', '1-16周(双) 星期二 3-4节 Y'));
});

test('单周 vs 全周 → 冲突', () => {
  ok(T.conflicts('1-16周(单) 星期二 3-4节 X', '1-16周 星期二 3-4节 Y'));
});

test('单周 vs 单周 → 冲突', () => {
  ok(T.conflicts('1-16周(单) 星期二 3-4节 X', '3-9周(单) 星期二 3-4节 Y'));
});

test('多段课程：任一段撞上即冲突', () => {
  const multi = '5-18周 星期二 3-4节 致理楼L1-707,5-18周 星期四 1-2节 致理楼L1-707';
  ok(T.conflicts(multi, '5-18周 星期四 1-2节 汇文楼H3-104'), '撞第二段');
  ok(!T.conflicts(multi, '5-18周 星期三 1-2节 汇文楼H3-104'), '都不撞');
});

test('MOOC 的 null → 不冲突（不误报）', () => {
  ok(!T.conflicts(null, A));
  ok(!T.conflicts(A, null));
  ok(!T.conflicts(null, null));
});

test('findConflicts 返回冲突课程列表', () => {
  const courses = [
    { courseName: '撞车课', teachingPlace: B },
    { courseName: '平安课', teachingPlace: '5-18周 星期五 1-2节 Z' },
  ];
  const hit = T.findConflicts(A, courses);
  eq(hit.length, 1);
  eq(hit[0].courseName, '撞车课');
});

await run();
