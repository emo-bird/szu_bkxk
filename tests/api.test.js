/**
 * core/api.js 的离线单测。
 *
 * 样例全部来自 docs/接口逆向记录.md 记录的真实响应/报文（已脱敏），
 * 逐字段钉住，避免后续改动悄悄破坏与真实抓包的一致性。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/api.js');

const API = globalThis.SZUBKXK.api;

section('core/api.js 响应分类');

test('code=1 → 成功，并取出 msg/timestamp/data', () => {
  const r = API.classifyResponse({
    status: 200,
    text: '{"data":null,"msg":"添加选课志愿成功","code":"1","timestamp":"1700000000000"}',
  });
  eq(r.kind, 'ok');
  eq(r.code, '1');
  eq(r.msg, '添加选课志愿成功');
  eq(r.timestamp, '1700000000000');
});

test('code=2 → 业务拒绝，msg 原样保留给用户看', () => {
  const r = API.classifyResponse({
    status: 200,
    text: '{"data":null,"msg":"已选mooc课程，学生每学期只允许4门mooc课程","code":"2"}',
  });
  eq(r.kind, 'business');
  eq(r.msg, '已选mooc课程，学生每学期只允许4门mooc课程');
});

test('code=302 → 登录失效', () => {
  const r = API.classifyResponse({ status: 200, text: '{"code":"302","msg":"未查询到登录信息"}' });
  eq(r.kind, 'unauthenticated');
});

test('code 是业务自定义串但 msg 含「认证」→ 登录失效（实测反例）', () => {
  const r = API.classifyResponse({ status: 200, text: '{"code":"#E2140600091","msg":"认证失败"}' });
  eq(r.kind, 'unauthenticated');
});

test('code 为数字 1 也能判成功（类型容错）', () => {
  const r = API.classifyResponse({ status: 200, text: '{"code":1,"msg":"ok"}' });
  eq(r.kind, 'ok');
  eq(r.code, '1');
});

test('HTTP 401（AJAX 登录失效）→ 登录失效', () => {
  const r = API.classifyResponse({ status: 401, text: '<html>401</html>' });
  eq(r.kind, 'unauthenticated');
});

test('HTTP 302（页面跳转首页）→ 登录失效', () => {
  const r = API.classifyResponse({ status: 302, text: '' });
  eq(r.kind, 'unauthenticated');
});

test('非 JSON 响应 → 未识别', () => {
  const r = API.classifyResponse({ status: 200, text: '<html><body>系统异常</body></html>' });
  eq(r.kind, 'unknown');
  eq(r.msg, '响应不是 JSON');
});

test('缺少 code → 未识别（结构变更的报警信号）', () => {
  eq(API.classifyResponse({ status: 200, text: '{"msg":"ok","data":null}' }).kind, 'unknown');
});

test('未知 code → 未识别', () => {
  eq(API.classifyResponse({ status: 200, text: '{"code":"9","msg":"风控"}' }).kind, 'unknown');
});

test('空响应体 → 未识别', () => {
  eq(API.classifyResponse({ status: 200, text: '' }).kind, 'unknown');
});

section('core/api.js 报文构造');

test('抢课报文字段与顺序和实测一致', () => {
  const p = API.buildEnrollParam({
    studentCode: '2026000000',
    electiveBatchCode: 'BATCH1',
    teachingClassId: 'TC123',
    teachingClassType: 'FANKC',
  });
  eq(Object.keys(p.data), [
    'operationType',
    'studentCode',
    'electiveBatchCode',
    'teachingClassId',
    'isMajor',
    'campus',
    'teachingClassType',
  ]);
  eq(p.data.operationType, '1');
  eq(p.data.isMajor, '1');
  eq(p.data.campus, '01');
  eq(p.data.teachingClassType, 'FANKC');
});

test('抢课报文不含 chooseVolunteer（早期按参考仓库多写的字段已删除）', () => {
  const p = API.buildEnrollParam({
    studentCode: 's',
    electiveBatchCode: 'b',
    teachingClassId: 't',
    teachingClassType: 'XGXK',
  });
  eq('chooseVolunteer' in p.data, false);
});

test('退课报文：operationType=2，且不带 campus / teachingClassType', () => {
  const p = API.buildDeleteParam({ studentCode: 's', electiveBatchCode: 'b', teachingClassId: 't' });
  eq(Object.keys(p.data), ['operationType', 'studentCode', 'electiveBatchCode', 'teachingClassId', 'isMajor']);
  eq(p.data.operationType, '2');
  eq('campus' in p.data, false);
  eq('teachingClassType' in p.data, false);
});

test('查容量请求体与实测一致', () => {
  eq(API.buildCapacityBody('TC-1', 'B-2'), 'teachingClassId=TC-1&batchCode=B-2');
});

test('查容量请求体做 URL 编码', () => {
  eq(API.buildCapacityBody('a b', 'c&d'), 'teachingClassId=a%20b&batchCode=c%26d');
});

test('buildFormBody 编码并保持键顺序', () => {
  eq(API.buildFormBody({ addParam: '{"a":1}' }), 'addParam=%7B%22a%22%3A1%7D');
  eq(API.buildFormBody({ a: '1', b: '2' }), 'a=1&b=2');
});

test('appendTimestamp 正确处理有无 query 两种情况', () => {
  eq(API.appendTimestamp('http://x/y.do', 123), 'http://x/y.do?timestamp=123');
  eq(API.appendTimestamp('http://x/y.do?a=1', 123), 'http://x/y.do?a=1&timestamp=123');
});

test('buildHeaders 只带 token 与 X-Requested-With（cookie 由浏览器自动附带）', () => {
  const h = API.buildHeaders('TK');
  eq(h, { token: 'TK', 'X-Requested-With': 'XMLHttpRequest' });
});

section('core/api.js 余量计算（capacity.do）');

test('用 mainClassCapacity - mainElectiveNumber 计算余量', () => {
  eq(API.capacityRemain({ mainClassCapacity: '55', mainElectiveNumber: '52' }), 3);
});

test('classCapacity 等字段全为 null 时仍能算出余量', () => {
  eq(
    API.capacityRemain({
      mainClassCapacity: '55',
      mainElectiveNumber: '52',
      classCapacity: null,
      numberOfFirstVolunteer: null,
      isFull: null,
    }),
    3
  );
});

test('关键字段缺失时返回 null（调用方不得当作"有余量"）', () => {
  eq(API.capacityRemain({ classCapacity: '10' }), null);
  eq(API.capacityRemain(null), null);
  eq(API.capacityRemain({ mainClassCapacity: 'abc', mainElectiveNumber: '1' }), null);
});

section('core/api.js 写开关守卫');

test('只接受布尔 true，字符串 "true" / 数字 1 一律视为关闭', () => {
  eq(API.isWriteAllowed({ writeApiEnabled: true }), true);
  eq(API.isWriteAllowed({ writeApiEnabled: 'true' }), false);
  eq(API.isWriteAllowed({ writeApiEnabled: 1 }), false);
  eq(API.isWriteAllowed({ writeApiEnabled: 'false' }), false);
  eq(API.isWriteAllowed({ writeApiEnabled: false }), false);
  eq(API.isWriteAllowed({}), false);
  eq(API.isWriteAllowed(null), false);
  eq(API.isWriteAllowed(undefined), false);
});

section('core/api.js 未识别落档');

test('byteLength 按 UTF-8 计算', () => {
  eq(API.byteLength('abc'), 3);
  eq(API.byteLength('中'), 3);
  eq(API.byteLength(''), 0);
});

test('formatUnknownDump 含全部留档要素', () => {
  const text = '{"data":null,"msg":"未知情况","code":"9"}';
  const dump = API.formatUnknownDump({
    action: '选课提交',
    url: 'http://bkxk.szu.edu.cn/xsxkapp/sys/xsxkapp/elective/volunteer.do',
    body: 'addParam=%7B%7D',
    text: text,
  });
  ok(dump.indexOf('[未识别返回]') === 0, '应以 [未识别返回] 开头');
  ok(dump.indexOf('动作：选课提交') !== -1, '缺动作');
  ok(dump.indexOf('地址：') !== -1, '缺地址');
  ok(dump.indexOf('请求体：addParam=%7B%7D') !== -1, '缺请求体');
  ok(dump.indexOf('响应长度：' + API.byteLength(text) + ' 字节') !== -1, '缺响应长度');
  ok(dump.indexOf('响应原文：' + text) !== -1, '缺响应原文');
});

test('formatUnknownDump 对空响应体与缺参有兜底', () => {
  const dump = API.formatUnknownDump({});
  ok(dump.indexOf('响应原文：(空)') !== -1, '空响应应有兜底文案');
  ok(dump.indexOf('请求体：(无)') !== -1, '缺请求体应有兜底文案');
});
