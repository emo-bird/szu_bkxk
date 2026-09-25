/**
 * data/courseCache.js 的离线单测：累计、去重、持久化、订阅。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/log.js');
require('../src/core/store.js');
require('../src/core/time.js');
require('../src/data/model.js');
require('../src/data/courseCache.js');

const NS = globalThis.SZUBKXK;

const newStore = () => new NS.store.Store({ backend: NS.store.memoryBackend() });
const rec = (id, extra) => Object.assign({ teachingClassId: id, courseName: '课程' + id }, extra || {});

section('data/courseCache.js 基本读写');

test('初始为空', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  eq(cache.list(), []);
  eq(cache.size(), 0);
  eq(cache.updatedAt(), null);
});

test('add 追加并按教学班ID 去重', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  eq(cache.add([rec('A'), rec('B')]), 2);
  eq(cache.add([rec('B'), rec('C')]), 3);
  eq(cache.list().map((r) => r.teachingClassId), ['A', 'B', 'C']);
});

test('add 会补全已有记录的非空字段', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.add([rec('A')]);
  cache.add([{ teachingClassId: 'A', teacherName: '补上的老师' }]);
  eq(cache.list()[0].teacherName, '补上的老师');
  eq(cache.list()[0].courseName, '课程A', '原有字段不应被清掉');
});

test('add 空数组不改变状态', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.add([rec('A')]);
  eq(cache.add([]), 1);
  eq(cache.add(null), 1);
});

test('list 返回副本，外部改动不影响内部', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.add([rec('A')]);
  const list = cache.list();
  list.push(rec('B'));
  eq(cache.size(), 1);
});

section('data/courseCache.js 持久化');

test('写入后新实例能读回来（含 updatedAt）', () => {
  const store = newStore();
  const cache1 = NS.courseCache.create({ store: store });
  cache1.add([rec('A'), rec('B')]);
  ok(typeof cache1.updatedAt() === 'number' && cache1.updatedAt() > 0);

  const cache2 = NS.courseCache.create({ store: store });
  eq(cache2.size(), 2);
  eq(cache2.list().map((r) => r.teachingClassId), ['A', 'B']);
});

test('存储里的坏数据一律当作空缓存', () => {
  const store = newStore();
  store.set(NS.store.KEYS.COURSE_CACHE, { records: 'not-an-array' });
  eq(NS.courseCache.create({ store: store }).list(), []);
  store.set(NS.store.KEYS.COURSE_CACHE, 'garbage');
  eq(NS.courseCache.create({ store: store }).list(), []);
});

test('replace 整体替换', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.add([rec('A'), rec('B')]);
  eq(cache.replace([rec('C')]), 1);
  eq(cache.list().map((r) => r.teachingClassId), ['C']);
});

test('clear 清空', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.add([rec('A')]);
  cache.clear();
  eq(cache.size(), 0);
  eq(cache.updatedAt(), null);
});

test('没有 store 时也能工作（内存模式）', () => {
  const cache = NS.courseCache.create({});
  eq(cache.add([rec('A')]), 1);
  eq(cache.size(), 1);
});

section('data/courseCache.js 订阅');

test('add/replace/clear 都会通知订阅者', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  const seen = [];
  cache.subscribe((list) => seen.push(list.length));
  cache.add([rec('A')]);
  cache.add([rec('B')]);
  cache.clear();
  eq(seen, [1, 2, 0]);
});

test('退订后不再收到通知', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  const seen = [];
  const off = cache.subscribe((list) => seen.push(list.length));
  cache.add([rec('A')]);
  off();
  cache.add([rec('B')]);
  eq(seen, [1]);
});

test('订阅者抛异常不影响缓存自身', () => {
  const cache = NS.courseCache.create({ store: newStore() });
  cache.subscribe(() => {
    throw new Error('订阅者炸了');
  });
  eq(cache.add([rec('A')]), 1);
  eq(cache.size(), 1);
});
