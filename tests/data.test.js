/**
 * data/model.js 与 data/capture.js 的离线单测。
 *
 * 模型样例按 docs/接口逆向记录.md §3.3 的真实字段名构造；
 * 抓取层用假的 fetch / XMLHttpRequest 验证 hook 行为，重点是**不改页面行为**与**幂等**。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/time.js');
require('../src/data/model.js');
require('../src/data/capture.js');

const NS = globalThis.SZUBKXK;
const M = NS.model;
const C = NS.capture;

const tick = () => new Promise((r) => setImmediate(r));
const INTERESTING = 'http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/elective/programCourse.do?timestamp=1';
const OTHER = 'http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/publicinfo/sysparam.do?timestamp=1';

section('data/model.js 层级合并（桌面版坑 #9）');

test('教学班级级的 null 不得覆盖课程级字段', () => {
  const merged = M.mergeLevels(
    { courseNumber: 'C1', courseName: '高等数学', credit: '4' },
    { courseNumber: null, courseName: '', credit: undefined, teachingClassID: 'TC1' }
  );
  eq(merged.courseNumber, 'C1');
  eq(merged.courseName, '高等数学');
  eq(merged.credit, '4');
  eq(merged.teachingClassID, 'TC1');
});

test('教学班级级的非空值应当覆盖课程级', () => {
  const merged = M.mergeLevels({ courseTypeName: '必修' }, { courseTypeName: '选修' });
  eq(merged.courseTypeName, '选修');
});

section('data/model.js 响应摊平');

test('嵌套结构（programCourse.do）：一行课程展开成多个教学班级', () => {
  const data = {
    dataList: [
      {
        courseName: '高等数学',
        courseNumber: 'C1',
        credit: '4',
        tcList: [
          { teachingClassID: 'TC1', teacherName: '张老师', classCapacity: '55', numberOfFirstVolunteer: '52' },
          { teachingClassID: 'TC2', teacherName: '李老师', classCapacity: '60', numberOfFirstVolunteer: '60' },
        ],
      },
    ],
  };
  const rows = M.flattenResponse(data, { teachingClassType: 'FANKC' });
  eq(rows.length, 2);
  eq(rows[0].teachingClassId, 'TC1');
  eq(rows[0].courseName, '高等数学', '课程级字段应被继承');
  eq(rows[0].teachingClassType, 'FANKC');
  eq(rows[1].teachingClassId, 'TC2');
});

test('扁平结构（publicCourse.do）：没有 tcList，一行即一个教学班级', () => {
  const data = {
    dataList: [
      { courseName: '校公选A', courseNumber: 'P1', teachingClassID: 'TC9', classCapacity: '100', numberOfFirstVolunteer: '30' },
    ],
  };
  const rows = M.flattenResponse(data, { teachingClassType: 'XGXK' });
  eq(rows.length, 1, '扁平结构必须也能取到记录（桌面版曾在此对已满课程发起抢课）');
  eq(rows[0].teachingClassId, 'TC9');
  eq(rows[0].courseName, '校公选A');
});

test('空的 tcList 也按扁平结构处理', () => {
  const data = { dataList: [{ courseName: 'X', teachingClassID: 'TC1', tcList: [] }] };
  eq(M.flattenResponse(data).length, 1);
});

test('没有 teachingClassId 的行被丢弃', () => {
  const data = { dataList: [{ courseName: '没有教学班' }, { teachingClassID: 'TC1', courseName: 'X' }] };
  eq(M.flattenResponse(data).length, 1);
});

test('extractRows 兼容多种列表字段名', () => {
  eq(M.extractRows({ dataList: [1] }), [1]);
  eq(M.extractRows({ rows: [2] }), [2]);
  eq(M.extractRows({ list: [3] }), [3]);
  eq(M.extractRows([4]), [4]);
  eq(M.extractRows({ nothing: true }), []);
  eq(M.extractRows(null), []);
});

section('data/model.js 字段映射');

test('布尔量按站点编码解析（"1"/"0" 与真假值）', () => {
  eq(M.isTruthy('1'), true);
  eq(M.isTruthy(1), true);
  eq(M.isTruthy(true), true);
  eq(M.isTruthy('0'), false);
  eq(M.isTruthy(''), false);
  eq(M.isTruthy(null), false);
  eq(M.isTruthy(undefined), false);
});

test('容量字段取不到时是 null，不是 0', () => {
  const rec = M.toRecord({ teachingClassID: 'TC1' });
  eq(rec.classCapacity, null);
  eq(rec.selectedCount, null);
  eq(M.remainCount(rec), null);
  eq(M.hasFreeSeat(rec), null, '无法判断时必须是 null，不能当成有余量');
});

test('有余量 / 已满 判定', () => {
  eq(M.hasFreeSeat({ classCapacity: '55', selectedCount: '52' }), true);
  eq(M.hasFreeSeat({ classCapacity: '55', selectedCount: '55' }), false);
  eq(M.hasFreeSeat({ classCapacity: '55', selectedCount: '60' }), false);
  eq(M.hasFreeSeat({ isFull: '1' }), false, '只有 isFull 时也能判满');
});

test('capacity.do 风格字段（mainClassCapacity）也能算余量', () => {
  const rec = M.toRecord({ teachingClassID: 'TC1', mainClassCapacity: '55', mainElectiveNumber: '52' });
  eq(M.remainCount(rec), 3);
});

test('课程时间被解析成 session', () => {
  const rec = M.toRecord({ teachingClassID: 'TC1', teachingPlace: '5-18周 星期二 3-4节 致理楼L1-707' });
  eq(rec.sessions.length, 1);
  eq(rec.sessions[0].weekday, 2);
  eq(rec.timePlace, '致理楼L1-707');
});

test('teachingPlace 为 null（MOOC）不抛异常', () => {
  const rec = M.toRecord({ teachingClassID: 'TC1', teachingPlace: null, isMooc: '1' });
  eq(rec.sessions, []);
  eq(rec.isMooc, true);
});

test('toTaskTarget：缺类别时返回 null（否则提交报文会残缺）', () => {
  const withType = M.toRecord({ teachingClassID: 'TC1', courseName: '甲', teacherName: '王' }, { teachingClassType: 'XGXK' });
  const target = M.toTaskTarget(withType);
  eq(target.teachingClassId, 'TC1');
  eq(target.teachingClassType, 'XGXK');
  eq(target.courseName, '甲');
  eq(M.toTaskTarget(M.toRecord({ teachingClassID: 'TC1' })), null);
});

test('mergeRecords 按教学班ID 去重并保留先出现的顺序', () => {
  const merged = M.mergeRecords([
    [{ teachingClassId: 'A', courseName: '甲' }, { teachingClassId: 'B' }],
    [{ teachingClassId: 'B', teacherName: '补上的老师' }, { teachingClassId: 'C' }],
  ]);
  eq(merged.map((r) => r.teachingClassId), ['A', 'B', 'C']);
  eq(merged[1].teacherName, '补上的老师');
});

section('data/capture.js URL 判定');

test('只对关心的端点返回 true', () => {
  eq(C.isInterestingUrl(INTERESTING), true);
  eq(C.isInterestingUrl(OTHER), false);
  eq(C.isInterestingUrl('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/elective/teachingclass/capacity.do'), true);
  eq(C.isInterestingUrl('http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/elective/curriculum.do'), false);
  eq(C.isInterestingUrl(null), false);
});

section('data/capture.js hook 行为');

/** 每个假 window 必须有自己的 XHR 类。
 *  若多个用例共享同一个类，capture.install 会反复包装同一个 prototype，
 *  导致 A 用例的 onResponse 被 B 用例的请求触发（这是踩过的坑，不是产品缺陷）。 */
function makeXHRClass() {
  function XHR() {
    this._listeners = {};
    this.responseText = '';
  }
  XHR.prototype.open = function (method, url) {
    this._method = method;
    this._url = url;
  };
  XHR.prototype.send = function () {
    this._sent = true;
  };
  XHR.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  XHR.prototype.emit = function (type) {
    (this._listeners[type] || []).forEach((fn) => fn());
  };
  return XHR;
}

/** 造一个带假 fetch / XMLHttpRequest 的 window。 */
function makeWin(body) {
  const text = body || '{"code":"1","data":{"dataList":[]}}';
  const seen = [];
  const win = {
    XMLHttpRequest: makeXHRClass(),
    fetch(url) {
      seen.push(url);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(text),
        clone() {
          return this;
        },
      });
    },
  };
  win.__originalFetch = win.fetch;
  return { win, seen, text };
}

test('fetch：捕获响应体，并原样把 promise 返回给页面', async () => {
  const { win } = makeWin();
  const got = [];
  C.install({ win, onResponse: (p) => got.push(p) });
  const res = await win.fetch(INTERESTING);
  await tick();
  eq(res.status, 200, '页面拿到的响应对象必须不变');
  eq(got.length, 1);
  eq(got[0].source, 'fetch');
  ok(got[0].json && got[0].json.code === '1', 'json 应被解析');
});

test('fetch：不关心的 URL 不捕获，但仍正常返回', async () => {
  const { win } = makeWin();
  const got = [];
  C.install({ win, onResponse: (p) => got.push(p) });
  const res = await win.fetch(OTHER);
  await tick();
  eq(res.status, 200);
  eq(got.length, 0);
});

test('XHR：open/send 后 load 事件捕获响应体', () => {
  const { win } = makeWin();
  const got = [];
  C.install({ win, onResponse: (p) => got.push(p) });
  const x = new win.XMLHttpRequest();
  x.open('POST', INTERESTING);
  x.send();
  x.responseText = '{"code":"1","data":{}}';
  x.emit('load');
  eq(got.length, 1);
  eq(got[0].source, 'xhr');
  eq(got[0].url, INTERESTING);
});

test('XHR：不关心的 URL 不捕获', () => {
  const { win } = makeWin();
  const got = [];
  C.install({ win, onResponse: (p) => got.push(p) });
  const x = new win.XMLHttpRequest();
  x.open('GET', OTHER);
  x.send();
  x.emit('load');
  eq(got.length, 0);
});

test('install 幂等：重复安装不叠加包装（一次请求只捕获一次）', async () => {
  const { win } = makeWin();
  const got = [];
  const h1 = C.install({ win, onResponse: (p) => got.push(p) });
  const h2 = C.install({ win, onResponse: (p) => got.push(p) });
  eq(h1 === h2, true, '应返回同一句柄');
  await win.fetch(INTERESTING);
  await tick();
  eq(got.length, 1, '叠加包装会导致重复捕获');
});

test('uninstall 还原原始 fetch', async () => {
  const { win } = makeWin();
  const h = C.install({ win, onResponse: () => {} });
  ok(win.fetch !== win.__originalFetch, '安装后应被包装');
  h.uninstall();
  eq(win.fetch, win.__originalFetch);
  eq(win[C.INSTALL_FLAG], undefined);
});

test('onResponse 抛异常不会影响页面调用', async () => {
  const { win } = makeWin();
  C.install({
    win,
    onResponse: () => {
      throw new Error('订阅者炸了');
    },
  });
  const res = await win.fetch(INTERESTING);
  await tick();
  eq(res.status, 200, '页面必须照常拿到响应');
  eq(win[C.INSTALL_FLAG].stats.errors, 1);
});

test('非 JSON 响应：json 为 null 且计入 parseFailed，不抛异常', async () => {
  const { win } = makeWin('<html>系统异常</html>');
  const got = [];
  const h = C.install({ win, onResponse: (p) => got.push(p) });
  await win.fetch(INTERESTING);
  await tick();
  eq(got.length, 1);
  eq(got[0].json, null);
  eq(h.stats.parseFailed, 1);
});

test('未提供 onResponse 时只计数，不报错', async () => {
  const { win } = makeWin();
  const h = C.install({ win });
  await win.fetch(INTERESTING);
  await tick();
  eq(h.stats.captured, 1);
});

section('data/capture.js 与模型串联');

test('recordsFromResponse 把捕获到的响应直接变成记录', () => {
  const payload = {
    url: INTERESTING,
    source: 'fetch',
    json: {
      code: '1',
      data: {
        dataList: [
          { courseName: '甲', teachingClassID: 'TC1', classCapacity: '10', numberOfFirstVolunteer: '8' },
        ],
      },
    },
  };
  const records = C.recordsFromResponse(payload, { teachingClassType: 'FANKC' });
  eq(records.length, 1);
  eq(records[0].teachingClassId, 'TC1');
  eq(M.hasFreeSeat(records[0]), true);
  eq(C.recordsFromResponse({ json: null }), []);
  eq(C.recordsFromResponse(null), []);
});
