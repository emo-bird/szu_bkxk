/**
 * 实际发出去的请求测试 —— 用假 fetch 捕获 URL / 请求头 / body。
 *
 * 起因：真机上抢课与查容量都返回
 *   {"data":null,"msg":"value sent to redis cannot be null","code":"0"}
 * 查证为 **请求头漏带 token**（站点要求 cookie + token 缺一不可），
 * 且 URL 多带了站点并不发送的 timestamp。这两条在此锁死。
 */
import { test, eq, ok, loadNS, run } from './harness.mjs';

const NS = loadNS();
const K = NS.api.RESP_KIND;

/** 捕获一次请求。 */
async function capture(opts) {
  let got = null;
  NS.__setFetch((url, init) => {
    got = { url, init };
    return Promise.resolve(NS.__resp('{"code":"1","msg":"ok","data":null}'));
  });
  await NS.api.send(opts);
  return got;
}

test('send：未显式传 token 时，自动取 sessionStorage.token 并放进请求头', async () => {
  NS.__setSession({ token: 'TOKEN-ABC' });
  const c = await capture({ url: '/x.do', method: 'POST', body: 'a=1' });
  eq(c.init.headers.token, 'TOKEN-ABC', 'token 请求头必须存在');
  eq(c.init.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('send：显式传 token 时优先用传入值', async () => {
  NS.__setSession({ token: 'TOKEN-ABC' });
  const c = await capture({ url: '/x.do', method: 'POST', body: 'a=1', token: 'OVERRIDE' });
  eq(c.init.headers.token, 'OVERRIDE');
});

test('send：未设置 token 时不伪造该头（但请求照发）', async () => {
  NS.__setSession({});
  const c = await capture({ url: '/x.do', method: 'POST', body: 'a=1' });
  ok(!('token' in c.init.headers), '不该出现空 token 头');
  eq(c.init.method, 'POST');
});

test('send：默认不追加 timestamp（站点 volunteer.do / capacity.do 都没这个参数）', async () => {
  NS.__setSession({ token: 'T' });
  const c = await capture({ url: '/xsxkapp/sys/xsxkapp/elective/volunteer.do', method: 'POST', body: 'addParam=x' });
  ok(c.url.indexOf('timestamp') === -1, '默认不应带 timestamp，实际: ' + c.url);
});

test('send：显式 timestamp:true 时才追加（供确实需要的端点使用）', async () => {
  NS.__setSession({ token: 'T' });
  const c = await capture({ url: '/a/b.do', method: 'POST', body: '', timestamp: true });
  ok(/\?timestamp=\d{13}$/.test(c.url), '应带 13 位时间戳，实际: ' + c.url);
});

test('send：请求头不含 cookie（同源自动附带，不得手工设置）', async () => {
  NS.__setSession({ token: 'T' });
  const c = await capture({ url: '/x.do', method: 'POST', body: 'a=1' });
  ok(!('cookie' in c.init.headers) && !('Cookie' in c.init.headers));
  eq(c.init.credentials, 'include', '靠 credentials 带 cookie');
});

test('send：body 原样发出', async () => {
  NS.__setSession({ token: 'T' });
  const c = await capture({ url: '/x.do', method: 'POST', body: 'teachingClassId=A&batchCode=B' });
  eq(c.init.body, 'teachingClassId=A&batchCode=B');
});

test('查容量：batchCode 取页面会话，而不是设置里手填的值', async () => {
  NS.monitor.items = [];
  NS.__setSession({
    token: 'T',
    studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'SESSION-BATCH' } }),
  });
  NS.saveSettings({ batchCode: 'WRONG-SETTING-BATCH' });
  let got = null;
  NS.__setFetch((url, init) => {
    got = { url, init };
    return Promise.resolve(NS.__resp(JSON.stringify({
      data: { mainClassCapacity: '55', mainElectiveNumber: '52' },
      msg: '查询教学班课容量成功', code: '1',
    })));
  });
  NS.monitor.add({ teachingClassID: 'TC1' });
  const r = await NS.monitor.checkOne('TC1');
  eq(got.init.body, 'teachingClassId=TC1&batchCode=SESSION-BATCH', '必须用会话里的批次码');
  ok(got.init.headers.token === 'T', '必须带 token');
  eq(r.kind, 'ok');
  eq(r.remain, 3, '余量 55-52=3');
});

test('查容量：会话里没有批次码时不发请求', async () => {
  NS.monitor.items = [];
  NS.__setSession({ token: 'T' });
  NS.saveSettings({ batchCode: '' });
  let called = false;
  NS.__setFetch(() => { called = true; return Promise.resolve(NS.__resp('{}')); });
  const r = await NS.monitor.checkOne('TC1');
  eq(called, false, '不该发请求');
  eq(r.kind, 'nobatch');
});

test('抢课：发出的报文带 token、包着 data 层、且不带 timestamp', async () => {
  NS.__setSession({
    token: 'TOK',
    studentInfo: JSON.stringify({ code: '2026280121', electiveBatch: { code: 'BATCH-X' } }),
    currentCampus: JSON.stringify({ code: '01' }),
  });
  NS.tasks.clear();
  const t = NS.tasks.add({ teachingClassID: 'TC9', category: 'FANKC' });
  let got = null;
  NS.__setFetch((url, init) => {
    got = { url, init };
    return Promise.resolve(NS.__resp('{"code":"1","msg":"添加选课志愿成功","data":null}'));
  });
  await NS.tasks.attempt(t);
  eq(got.init.headers.token, 'TOK', 'token 必须带');
  ok(got.url.indexOf('timestamp') === -1, 'volunteer.do 不带 timestamp');
  const json = JSON.parse(decodeURIComponent(got.init.body.slice('addParam='.length)));
  eq(Object.keys(json), ['data'], '包一层 data');
  eq(json.data.electiveBatchCode, 'BATCH-X');
  eq(json.data.teachingClassType, 'FANKC');
  eq(t.status, NS.tasks.STATUS.SUCCESS, '任务标记成功');
});

await run();
