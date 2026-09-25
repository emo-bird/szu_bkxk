/**
 * 监控两种模式 + 轮询 + 命中自动抢 的请求级测试。
 * 起因：真机反馈「类别监控和单独监控发送的请求没有区别」——
 *      原实现两种模式都只发 capacity.do，等于没有区分。这里锁死两条路径。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();

const SESSION = {
  token: 'TOK',
  studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'BATCH-9' } }),
  currentCampus: JSON.stringify({ code: '01' }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 装一个假 fetch，记录全部请求，按 URL 关键字回不同响应。 */
function installFetch(NSx) {
  const calls = [];
  NSx.__setFetch((url, init) => {
    calls.push({ url, init });
    if (/capacity\.do/.test(url)) {
      return Promise.resolve(NSx.__resp(JSON.stringify({
        data: { mainClassCapacity: '55', mainElectiveNumber: '52' },
        msg: '查询教学班课容量成功', code: '1',
      })));
    }
    if (/programCourse\.do|publicCourse\.do/.test(url)) {
      return Promise.resolve(NSx.__resp(JSON.stringify({
        data: {
          dataList: [{
            courseNumber: '1900600001',
            tcList: [
              { teachingClassID: 'TC1', courseName: '高数', classCapacity: '60', numberOfFirstVolunteer: '55' },
              { teachingClassID: 'TC2', courseName: '线代', classCapacity: '50', numberOfFirstVolunteer: '50' },
            ],
          }],
        },
        totalCount: 2, msg: 'ok', code: '1',
      })));
    }
    if (/volunteer\.do/.test(url)) {
      return Promise.resolve(NSx.__resp('{"code":"1","msg":"添加选课志愿成功","data":null}'));
    }
    return Promise.resolve(NSx.__resp('{"code":"1","msg":"ok","data":null}'));
  });
  return calls;
}

/**
 * 每个用例前重置状态。
 * 所有请求都过限流队列，相邻两条至少间隔 intervalMs；故把间隔压到硬下限 200ms，
 * 并等上一用例遗留的请求跑完，否则会把上一个用例的请求算进本用例的 calls 里。
 */
async function resetMonitor(mode) {
  NS.monitor.stopPolling();
  NS.monitor.items = [];
  NS.monitor.pollCount = 0;
  NS.monitor.hitCount = 0;
  NS.monitor.polling = false;
  NS.__setSession(SESSION);
  NS.saveSettings({ monitorMode: mode, writeApiEnabled: false, intervalMs: 200 });
  NS.queue.intervalMs = NS.Queue.FLOOR_MS;
  await sleep(320);
}

// ---------- 两种模式走的端点不同 ----------

test('单独监控：打 teachingclass/capacity.do', async () => {
  await resetMonitor('single');
  const calls = installFetch(NS);
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  const r = await NS.monitor.pollOnce();
  eq(calls.length, 1, '只发一条');
  ok(/capacity\.do/.test(calls[0].url), '端点应为 capacity.do，实际: ' + calls[0].url);
  eq(r.checked, 1);
  eq(r.hits.length, 1, '余量 55-52=3 大于 0，应命中');
  eq(NS.monitor.items[0].remain, 3);
});

test('类别监控：打 programCourse.do，不再打 capacity.do', async () => {
  await resetMonitor('category');
  const calls = installFetch(NS);
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  const r = await NS.monitor.pollOnce();
  eq(calls.length, 1, '只发一条');
  ok(/programCourse\.do/.test(calls[0].url), '端点应为类别列表，实际: ' + calls[0].url);
  ok(!/capacity\.do/.test(calls[0].url), '不应再打 capacity.do');
  eq(r.checked, 1);
  eq(NS.monitor.items[0].remain, 5, '余量 60-55=5');
});

test('类别监控：余量用 classCapacity - numberOfFirstVolunteer', () => {
  eq(NS.monitor.remainOfClass({ classCapacity: '60', numberOfFirstVolunteer: '55' }), 5);
  eq(NS.monitor.remainOfClass({ classCapacity: '50', numberOfFirstVolunteer: '50' }), 0);
  eq(NS.monitor.remainOfClass({ classCapacity: '50', numberOfFirstVolunteer: '53' }), -3);
  eq(NS.monitor.remainOfClass({ classCapacity: null, numberOfFirstVolunteer: '1' }), null);
  eq(NS.monitor.remainOfClass({}), null);
  eq(NS.monitor.remainOfClass(null), null);
});

test('类别监控：按类别分组，一个类别只拉一次列表', async () => {
  await resetMonitor('category');
  const calls = installFetch(NS);
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  NS.monitor.add({ teachingClassID: 'TC2', category: 'FANKC' });
  const r = await NS.monitor.pollOnce();
  eq(calls.length, 1, '同一类别只发一次');
  eq(r.checked, 2, '两个监控项都被回填');
});

test('类别监控：列表里找不到该教学班时 remain 为 null，不当成有余量', async () => {
  await resetMonitor('category');
  installFetch(NS);
  NS.monitor.add({ teachingClassID: 'NOT-IN-LIST', category: 'FANKC' });
  const r = await NS.monitor.pollOnce();
  eq(NS.monitor.items[0].remain, null);
  eq(r.hits.length, 0, '不得误判为命中');
});

test('类别监控：监控项缺类别时无法查询，且不发请求', async () => {
  await resetMonitor('category');
  const calls = installFetch(NS);
  NS.monitor.add({ teachingClassID: 'TC1', category: '' });
  const r = await NS.monitor.pollOnce();
  eq(calls.length, 0, '不发请求');
  eq(r.checked, 0);
});

// ---------- 命中后的动作 ----------

test('写接口关闭：命中也不发抢课请求，只提醒', async () => {
  await resetMonitor('single');
  const calls = installFetch(NS);
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  await NS.monitor.pollOnce();
  await sleep(320);
  eq(calls.filter((c) => /volunteer\.do/.test(c.url)).length, 0, '写接口关闭时不得自动抢');
});

test('写接口开启：命中后自动发抢课请求，成功后移出监控', async () => {
  await resetMonitor('single');
  const calls = installFetch(NS);
  NS.saveSettings({ writeApiEnabled: true });
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  await NS.monitor.pollOnce();
  await sleep(320);
  const vols = calls.filter((c) => /volunteer\.do/.test(c.url));
  eq(vols.length, 1, '应自动抢一次');
  const json = JSON.parse(decodeURIComponent(vols[0].init.body.slice('addParam='.length)));
  eq(json.data.teachingClassId, 'TC1');
  eq(json.data.teachingClassType, 'FANKC');
  eq(vols[0].init.headers.token, 'TOK', 'token 必须带');
  eq(NS.monitor.has('TC1'), false, '抢成功后从监控列表移除');
});

test('满课（余量为 0）：即使写接口开启也不抢', async () => {
  await resetMonitor('category');
  const calls = installFetch(NS);
  NS.saveSettings({ writeApiEnabled: true });
  NS.monitor.add({ teachingClassID: 'TC2', category: 'FANKC' }); // 50-50=0
  await NS.monitor.pollOnce();
  await sleep(320);
  eq(calls.filter((c) => /volunteer\.do/.test(c.url)).length, 0, '满课不抢');
});

// ---------- 轮询开关 ----------

test('轮询：无监控项时不启动', async () => {
  await resetMonitor('single');
  eq(NS.monitor.startPolling(), false);
  eq(NS.monitor.polling, false);
});

test('轮询：有监控项时可启动并停止', async () => {
  await resetMonitor('single');
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  eq(NS.monitor.startPolling(), true);
  eq(NS.monitor.polling, true);
  eq(NS.monitor.startPolling(), false, '重复启动返回 false');
  NS.monitor.stopPolling();
  eq(NS.monitor.polling, false);
});

test('轮询：加入监控本身不启动轮询（红线⑤ 不自动启动任务）', async () => {
  await resetMonitor('single');
  NS.monitor.add({ teachingClassID: 'TC1', category: 'FANKC' });
  eq(NS.monitor.polling, false);
  eq(NS.monitor.pollCount, 0, '未启动就没有轮次');
});

await run();
