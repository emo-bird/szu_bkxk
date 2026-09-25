/**
 * core/task.js 的离线单测。
 * 重点：坏数据不炸、数值钳位、目标去重与上限、"重启后一律已停止"。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/task.js');

const NS = globalThis.SZUBKXK;
const T = NS.task;

section('core/task.js 规范化');

test('默认值：grab、1.5s 间隔、满课停止、已停止、无目标', () => {
  const t = T.normalize({});
  eq(t.kind, 'grab');
  eq(t.intervalMs, 1500);
  eq(t.fullStrategy, 'stop');
  eq(t.allowUnknownCapacity, false);
  eq(t.enabled, false);
  eq(t.status, 'stopped');
  eq(t.targets, []);
  eq(t.startAt, null);
  ok(typeof t.id === 'string' && t.id.length > 0, '应自动生成 id');
});

test('非法 kind 回退为 grab', () => {
  eq(T.normalize({ kind: 'xxx' }).kind, 'grab');
  eq(T.normalize({ kind: 'monitor' }).kind, 'monitor');
});

test('间隔钳位到 [200, 60000]', () => {
  eq(T.normalize({ intervalMs: 10 }).intervalMs, 200);
  eq(T.normalize({ intervalMs: 999999 }).intervalMs, 60000);
  eq(T.normalize({ intervalMs: 'abc' }).intervalMs, 1500);
  eq(T.normalize({ intervalMs: 3000 }).intervalMs, 3000);
});

test('startAt 非法值归为 null（= 立即开始）', () => {
  eq(T.normalize({ startAt: 0 }).startAt, null);
  eq(T.normalize({ startAt: -5 }).startAt, null);
  eq(T.normalize({ startAt: 'abc' }).startAt, null);
  eq(T.normalize({ startAt: 1700000000000 }).startAt, 1700000000000);
});

test('allowUnknownCapacity 只接受布尔 true', () => {
  eq(T.normalize({ allowUnknownCapacity: true }).allowUnknownCapacity, true);
  eq(T.normalize({ allowUnknownCapacity: 'true' }).allowUnknownCapacity, false);
  eq(T.normalize({ allowUnknownCapacity: 1 }).allowUnknownCapacity, false);
});

test('未知状态回退为 stopped', () => {
  eq(T.normalize({ status: 'running' }).status, 'running');
  eq(T.normalize({ status: 'nonsense' }).status, 'stopped');
});

test('非对象输入不炸', () => {
  eq(T.normalize(null).kind, 'grab');
  eq(T.normalize('oops').targets, []);
  eq(T.normalizeList('oops'), []);
  eq(T.normalizeList(null), []);
});

section('core/task.js 目标处理');

test('接受字符串形式的教学班ID（监控清单只填 ID）', () => {
  const t = T.normalize({ targets: ['TC-1', 'TC-2'] });
  eq(t.targets.length, 2);
  eq(t.targets[0].teachingClassId, 'TC-1');
  eq(t.targets[0].courseNumber, null);
});

test('按教学班ID 去重，保持首次出现顺序', () => {
  const t = T.normalize({
    targets: [
      { teachingClassId: 'A', courseName: '甲' },
      { teachingClassId: 'B' },
      { teachingClassId: 'A', courseName: '甲的重复项' },
    ],
  });
  eq(t.targets.map((x) => x.teachingClassId), ['A', 'B']);
  eq(t.targets[0].courseName, '甲');
});

test('缺少 teachingClassId 的目标被丢弃', () => {
  const t = T.normalize({ targets: [{ courseName: '没有ID' }, 'TC-9', null, {}] });
  eq(t.targets.map((x) => x.teachingClassId), ['TC-9']);
});

test('目标数量上限 20', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push('TC-' + i);
  eq(T.normalize({ targets: many }).targets.length, 20);
});

test('空白字符串字段归一为 null（避免提交空串）', () => {
  const t = T.normalize({ targets: [{ teachingClassId: 'A', courseNumber: '   ', teacher: '王' }] });
  eq(t.targets[0].courseNumber, null);
  eq(t.targets[0].teacher, '王');
});

section('core/task.js 创建与载入');

test('create 补齐 createdAt/updatedAt 与新 id', () => {
  const t = T.create({ name: '抢高数', kind: 'monitor', targets: ['A'] });
  ok(t.id && t.id.length > 0);
  ok(typeof t.createdAt === 'number' && t.createdAt > 0);
  ok(typeof t.updatedAt === 'number' && t.updatedAt > 0);
  eq(t.name, '抢高数');
  eq(t.kind, 'monitor');
});

test('restoreOnLoad 强制把所有任务重置为已停止且未启用', () => {
  const restored = T.restoreOnLoad([
    { id: 't1', status: 'running', enabled: true, targets: ['A'] },
    { id: 't2', status: 'success', enabled: true, targets: ['B'] },
  ]);
  eq(restored.map((x) => x.status), ['stopped', 'stopped']);
  eq(restored.map((x) => x.enabled), [false, false]);
  eq(restored.length, 2);
});

section('core/task.js 表格列与显示');

test('两种类型的列不同', () => {
  eq(T.columns('grab').map((c) => c.key).indexOf('fullStrategyText') !== -1, true);
  eq(T.columns('monitor').map((c) => c.key).indexOf('fullStrategyText'), -1);
  eq(T.columns('乱传').map((c) => c.key), T.columns('grab').map((c) => c.key));
});

test('display 渲染各列', () => {
  const t = { name: '甲', kind: 'grab', intervalMs: 2000, fullStrategy: 'keep', status: 'running', targets: ['TC-1', 'TC-2'] };
  eq(T.display(t, 'name'), '甲');
  eq(T.display(t, 'intervalText'), '2000ms');
  eq(T.display(t, 'targetsText'), 'TC-1, TC-2');
  eq(T.display(t, 'targetCount'), '2');
  eq(T.display(t, 'fullStrategyText'), '满课继续轮询');
  eq(T.display(t, 'statusText'), '运行中');
  eq(T.display({}, 'name').indexOf('(未命名'), 0);
  eq(T.display({}, 'targetsText'), '(未设置)');
});

test('monitor 的满课策略列显示为不适用', () => {
  eq(T.display({ kind: 'monitor' }, 'fullStrategyText'), '不适用（不因满课停止）');
});

test('formatStartAt 未设置时显示"立即开始"', () => {
  eq(T.formatStartAt(null), '立即开始');
  eq(T.formatStartAt(0), '立即开始');
  ok(/^\d\d:\d\d:\d\d$/.test(T.formatStartAt(1700000000000)), T.formatStartAt(1700000000000));
});

test('任务可 JSON 往返（持久化形状稳定）', () => {
  const t = T.create({ name: 'x', targets: [{ teachingClassId: 'A', teachingClassType: 'FANKC' }] });
  const back = T.normalize(JSON.parse(JSON.stringify(t)));
  eq(JSON.stringify(back), JSON.stringify(t));
});
