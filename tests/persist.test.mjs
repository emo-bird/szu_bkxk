/**
 * 持久化测试：任务与监控刷新后不丢（用户明确要求）。
 * 同时锁死红线③：落盘数据里不得出现任何凭证。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();

const SESSION = {
  token: 'SECRET-TOKEN',
  studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'BATCH-9' } }),
  currentCampus: JSON.stringify({ code: '01' }),
};

function reset() {
  NS.__setSession(SESSION);
  NS.saveSettings({ writeApiEnabled: false });
  NS.tasks.clear();
  NS.monitor.clear();
  NS.custom.clear();
}

test('任务：添加后落盘，重新 load 能恢复', () => {
  reset();
  NS.tasks.add({ teachingClassID: 'TC1', courseName: '高数', category: 'FANKC' });
  NS.tasks.add({ teachingClassID: 'TC2', courseName: '线代', category: 'TJKC' });

  // 模拟刷新：清空内存再 load
  NS.tasks.items = [];
  const n = NS.tasks.load();
  eq(n, 2, '恢复 2 条');
  eq(NS.tasks.items[0].teachingClassID, 'TC1');
  eq(NS.tasks.items[0].courseName, '高数');
  eq(NS.tasks.items[0].category, 'FANKC');
});

test('任务：优先级 / 启停 / 重试模式都持久化', () => {
  reset();
  const t = NS.tasks.add({ teachingClassID: 'TC1', category: 'FANKC' });
  NS.tasks.setPriority(t.id, -1);
  NS.tasks.setRetryMode(t.id, 'always');
  NS.tasks.toggle(t.id); // 禁用

  NS.tasks.items = [];
  NS.tasks.load();
  const r = NS.tasks.items[0];
  eq(r.priority, -1, '优先级');
  eq(r.retryMode, 'always', '重试模式');
  eq(r.enabled, false, '禁用状态');
});

test('任务：刷新前正在请求的，恢复为等待态（不留在 running）', () => {
  reset();
  const t = NS.tasks.add({ teachingClassID: 'TC1', category: 'FANKC' });
  t.status = NS.tasks.STATUS.RUNNING;
  NS.tasks.save();

  NS.tasks.items = [];
  NS.tasks.load();
  eq(NS.tasks.items[0].status, NS.tasks.STATUS.PENDING, 'running 复位为 pending');
});

test('任务：尝试次数与最后消息也保留', () => {
  reset();
  const t = NS.tasks.add({ teachingClassID: 'TC1', category: 'FANKC' });
  t.attempts = 7;
  t.lastMsg = '已选人数超过课容量';
  NS.tasks.save();

  NS.tasks.items = [];
  NS.tasks.load();
  eq(NS.tasks.items[0].attempts, 7);
  eq(NS.tasks.items[0].lastMsg, '已选人数超过课容量');
});

test('任务：删除后落盘同步', () => {
  reset();
  const t = NS.tasks.add({ teachingClassID: 'TC1' });
  NS.tasks.add({ teachingClassID: 'TC2' });
  NS.tasks.remove(t.id);

  NS.tasks.items = [];
  NS.tasks.load();
  eq(NS.tasks.items.length, 1);
  eq(NS.tasks.items[0].teachingClassID, 'TC2');
});

test('监控：添加后落盘，重新 load 能恢复（含余量快照）', () => {
  reset();
  NS.monitor.add({ teachingClassID: 'TC1', courseName: '高数', category: 'FANKC' });
  NS.monitor._apply('TC1', 5);
  eq(NS.monitor.items[0].remain, 5);

  NS.monitor.items = [];
  const n = NS.monitor.load();
  eq(n, 1, '恢复 1 条');
  eq(NS.monitor.items[0].teachingClassID, 'TC1');
  eq(NS.monitor.items[0].category, 'FANKC');
  eq(NS.monitor.items[0].remain, 5, '上次余量也保留');
});

test('监控：刷新后一律不处于轮询态（红线⑤ 不自动续跑）', () => {
  reset();
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  NS.monitor.polling = true;
  NS.monitor.save();

  NS.monitor.items = [];
  NS.monitor.load();
  eq(NS.monitor.polling, false, '恢复后不自动轮询');
});

test('监控：移除后落盘同步', () => {
  reset();
  NS.monitor.add({ teachingClassID: 'TC1' });
  NS.monitor.add({ teachingClassID: 'TC2' });
  NS.monitor.remove('TC1');

  NS.monitor.items = [];
  NS.monitor.load();
  eq(NS.monitor.items.length, 1);
  eq(NS.monitor.items[0].teachingClassID, 'TC2');
});

test('红线③：落盘内容不得含 token / 学号等凭证', () => {
  reset();
  NS.tasks.add({ teachingClassID: 'TC1', courseName: '高数', category: 'FANKC' });
  NS.monitor.add({ teachingClassID: 'TC1', courseName: '高数', category: 'FANKC' });

  // 取出所有落到 localStorage 的东西，拼起来查敏感串
  const t = JSON.stringify(NS.store.get('tasks', null));
  const m = JSON.stringify(NS.store.get('monitor', null));
  const all = t + m;
  ok(all.indexOf('SECRET-TOKEN') === -1, '不得出现 token');
  ok(all.indexOf('2026280121') === -1, '不得出现学号');
  ok(all.indexOf('BATCH-9') === -1, '不得出现批次码');
  ok(all.indexOf('cookie') === -1, '不得出现 cookie');
});

test('存储：空数据 / 损坏数据不抛错', () => {
  eq(NS.store.get('不存在的键', '默认值'), '默认值');
  NS.store.set('坏数据', 123);
  eq(NS.store.get('坏数据', null), 123);

  // 清干净再验证「无数据时 load 不抛错」
  reset();
  NS.store.del('tasks');
  NS.tasks.items = [];
  NS.tasks.load();
  eq(NS.tasks.items.length, 0);

  // 损坏数据同样不抛
  NS.store.set('tasks', '这不是对象');
  NS.tasks.items = [];
  NS.tasks.load();
  eq(NS.tasks.items.length, 0);
});

await run();
