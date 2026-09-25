/**
 * core/store.js 的离线单测。
 * 重点钉住"安全开关绝不猜成开启"与"数值一律钳位"这两条桌面版用血泪换来的经验。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/queue.js');
require('../src/core/store.js');

const NS = globalThis.SZUBKXK;
const Store = NS.store.Store;

/** 每次用全新的内存后端，避免用例之间互相污染。 */
const newStore = () => new Store({ backend: NS.store.memoryBackend() });

section('core/store.js 设置归一化');

test('无数据时返回完整默认设置', () => {
  const s = newStore().getSettings();
  eq(s.writeApiEnabled, false);
  eq(s.requestIntervalMs, 500);
  eq(s.maxQueueSize, 10);
  eq(s.pollIntervalMs, 1500);
  eq(s.panelLeft, null);
});

test('writeApiEnabled 只接受布尔 true（字符串 "true" / 1 都算关闭）', () => {
  eq(NS.store.normalizeSettings({ writeApiEnabled: true }).settings.writeApiEnabled, true);
  eq(NS.store.normalizeSettings({ writeApiEnabled: 'true' }).settings.writeApiEnabled, false);
  eq(NS.store.normalizeSettings({ writeApiEnabled: 1 }).settings.writeApiEnabled, false);
  eq(NS.store.normalizeSettings({ writeApiEnabled: 'false' }).settings.writeApiEnabled, false);
});

test('requestIntervalMs 钳位到硬下限 200 与上限 60000', () => {
  eq(NS.store.normalizeSettings({ requestIntervalMs: 50 }).settings.requestIntervalMs, 200);
  eq(NS.store.normalizeSettings({ requestIntervalMs: 1e9 }).settings.requestIntervalMs, 60000);
  eq(NS.store.normalizeSettings({ requestIntervalMs: 'abc' }).settings.requestIntervalMs, 500);
  eq(NS.store.normalizeSettings({ requestIntervalMs: 800 }).settings.requestIntervalMs, 800);
});

test('pollIntervalMs 不得低于 requestIntervalMs', () => {
  const s = NS.store.normalizeSettings({ requestIntervalMs: 1000, pollIntervalMs: 300 }).settings;
  eq(s.requestIntervalMs, 1000);
  eq(s.pollIntervalMs, 1000);
});

test('maxQueueSize 与 logLimit 钳位', () => {
  eq(NS.store.normalizeSettings({ maxQueueSize: 0 }).settings.maxQueueSize, 1);
  eq(NS.store.normalizeSettings({ maxQueueSize: 9999 }).settings.maxQueueSize, 100);
  eq(NS.store.normalizeSettings({ logLimit: 1 }).settings.logLimit, 50);
  eq(NS.store.normalizeSettings({ logLimit: 999999 }).settings.logLimit, 5000);
});

test('requestTimeoutSeconds 钳位到 [3, 60]，默认 10', () => {
  eq(NS.store.normalizeSettings({}).settings.requestTimeoutSeconds, 10);
  eq(NS.store.normalizeSettings({ requestTimeoutSeconds: 1 }).settings.requestTimeoutSeconds, 3);
  eq(NS.store.normalizeSettings({ requestTimeoutSeconds: 999 }).settings.requestTimeoutSeconds, 60);
  eq(NS.store.normalizeSettings({ requestTimeoutSeconds: 'abc' }).settings.requestTimeoutSeconds, 10);
  eq(NS.store.normalizeSettings({ requestTimeoutSeconds: 20 }).settings.requestTimeoutSeconds, 20);
});

test('拼错的键被收集到 unknownKeys（"改了没生效"要能查出来）', () => {
  const r = NS.store.normalizeSettings({ writeApiEnable: true, interval: 100 });
  eq(r.unknownKeys.sort(), ['interval', 'writeApiEnable']);
  eq(r.settings.writeApiEnabled, false);
});

test('非对象输入不炸', () => {
  eq(NS.store.normalizeSettings(null).settings.requestIntervalMs, 500);
  eq(NS.store.normalizeSettings('oops').settings.requestIntervalMs, 500);
});

section('core/store.js 读写');

test('get/set/remove 往返', () => {
  const st = newStore();
  eq(st.get('settings', 'FB'), 'FB');
  ok(st.set('settings', { a: 1 }));
  eq(st.get('settings', 'FB'), { a: 1 });
  st.remove('settings');
  eq(st.get('settings', 'FB'), 'FB');
});

test('损坏的 JSON 一律回退 fallback，不抛异常', () => {
  const backend = NS.store.memoryBackend();
  const st = new Store({ backend });
  backend.setItem(NS.store.PREFIX + NS.store.KEYS.SETTINGS, '{坏数据');
  const s = st.getSettings();
  eq(s.requestIntervalMs, 500);
  eq(s.writeApiEnabled, false);
});

test('saveSettings 会把坏值归一化后再落库', () => {
  const st = newStore();
  st.saveSettings({ requestIntervalMs: 10, writeApiEnabled: 'true' });
  const raw = st.get(NS.store.KEYS.SETTINGS, null);
  eq(raw.requestIntervalMs, 200);
  eq(raw.writeApiEnabled, false);
  eq(st.getSettings().requestIntervalMs, 200);
});

test('patchSettings 局部更新', () => {
  const st = newStore();
  const s = st.patchSettings({ requestIntervalMs: 800 });
  eq(s.requestIntervalMs, 800);
  eq(s.maxQueueSize, 10, '未改动的项应保持默认');
  eq(st.getSettings().requestIntervalMs, 800);
});

test('getTasks / getCustomCourses 异常数据一律返回空数组', () => {
  const backend = NS.store.memoryBackend();
  const st = new Store({ backend });
  eq(st.getTasks(), []);
  eq(st.getCustomCourses(), []);
  backend.setItem(NS.store.PREFIX + NS.store.KEYS.TASKS, '{"not":"array"}');
  eq(st.getTasks(), []);
  st.saveTasks([{ id: 't1' }]);
  eq(st.getTasks(), [{ id: 't1' }]);
});

test('memory 后端下 isPersistent 为 false（降级但可用）', () => {
  const st = newStore();
  eq(st.isPersistent, false);
  ok(st.set('settings', { a: 1 }), '内存后端仍应可写');
});

section('core/store.js 版本迁移与清空');

test('首次使用写入 schemaVersion', () => {
  const st = newStore();
  const r = st.migrate();
  eq(r.from, null);
  eq(r.to, NS.store.SCHEMA_VERSION);
  eq(r.migrated, true);
  eq(st.get(NS.store.KEYS.SCHEMA_VERSION, null), NS.store.SCHEMA_VERSION);
});

test('版本一致时不重复迁移', () => {
  const st = newStore();
  st.migrate();
  eq(st.migrate().migrated, false);
});

test('clearAll 清掉本脚本的键，但不动其它键', () => {
  const backend = NS.store.memoryBackend();
  const st = new Store({ backend });
  st.saveSettings({ requestIntervalMs: 800 });
  st.set(NS.store.KEYS.TASKS, [{ id: 't1' }]);
  backend.setItem('szu-other-key', 'keep-me');
  st.clearAll();
  eq(st.get(NS.store.KEYS.SETTINGS, null), null);
  eq(st.get(NS.store.KEYS.TASKS, null), null);
  eq(backend.getItem('szu-other-key'), 'keep-me');
});
