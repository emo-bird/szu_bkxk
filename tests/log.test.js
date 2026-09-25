/**
 * core/log.js 的离线单测。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/log.js');

const NS = globalThis.SZUBKXK;
const LOG = NS.log;
const Logger = LOG.Logger;

/** 造一个不打印到控制台、时间可控的日志器。 */
function makeLogger(opts) {
  let t = 1700000000000;
  return new Logger(
    Object.assign({ echo: false, timeProvider: () => (t += 1000) }, opts)
  );
}

section('core/log.js 记录与缓冲');

test('记录可按分类取回', () => {
  const lg = makeLogger();
  lg.info(LOG.CATEGORY.SYSTEM, '启动');
  lg.warn(LOG.CATEGORY.QUEUE, '队列满');
  lg.error(LOG.CATEGORY.FAIL, '提交失败');
  eq(lg.records().length, 3);
  eq(lg.records(LOG.CATEGORY.QUEUE).length, 1);
  eq(lg.records(LOG.CATEGORY.QUEUE)[0].message, '队列满');
  eq(lg.records(LOG.CATEGORY.SUCCESS).length, 0);
});

test('环形缓冲丢弃最旧的记录', () => {
  const lg = makeLogger({ limit: 50 });
  for (let i = 0; i < 60; i++) lg.info(LOG.CATEGORY.SYSTEM, 'm' + i);
  eq(lg.records().length, 50);
  eq(lg.records()[0].message, 'm10');
  eq(lg.records()[49].message, 'm59');
});

test('limit 被钳位到 [50, 5000]', () => {
  eq(makeLogger({ limit: 1 }).limit, 50);
  eq(makeLogger({ limit: 999999 }).limit, 5000);
});

test('detail 为对象时序列化，为字符串时原样保留', () => {
  const lg = makeLogger();
  eq(lg.info(LOG.CATEGORY.SYSTEM, 'a', { k: 1 }).detail, '{"k":1}');
  eq(lg.info(LOG.CATEGORY.SYSTEM, 'b', 'raw').detail, 'raw');
  ok(!('detail' in lg.info(LOG.CATEGORY.SYSTEM, 'c')), '无 detail 时不应有该字段');
});

test('detail 循环引用不抛异常', () => {
  const lg = makeLogger();
  const cyclic = {};
  cyclic.self = cyclic;
  const rec = lg.info(LOG.CATEGORY.SYSTEM, 'cyclic', cyclic);
  ok(typeof rec.detail === 'string' && rec.detail.length > 0);
});

section('core/log.js 订阅与格式');

test('sink 收到每条记录', () => {
  const seen = [];
  const lg = makeLogger({ sink: (r) => seen.push(r.message) });
  lg.info(LOG.CATEGORY.SYSTEM, 'x');
  lg.info(LOG.CATEGORY.SYSTEM, 'y');
  eq(seen, ['x', 'y']);
});

test('sink 抛异常不影响记录本身', () => {
  const lg = makeLogger({
    sink: () => {
      throw new Error('订阅者炸了');
    },
  });
  const rec = lg.info(LOG.CATEGORY.SYSTEM, '仍然要记下来');
  eq(rec.message, '仍然要记下来');
  eq(lg.records().length, 1);
});

test('format 含时间、分类标签与级别前缀', () => {
  const lg = makeLogger();
  const warn = lg.warn(LOG.CATEGORY.QUEUE, '队列已满');
  const line = LOG.format(warn);
  ok(line.indexOf('[队列调度]') !== -1, '缺分类标签：' + line);
  ok(line.indexOf('[告警]') !== -1, '缺告警前缀：' + line);
  ok(/^\[\d\d:\d\d:\d\d\]/.test(line), '缺时间前缀：' + line);
});

test('format 带 detail 时另起一行', () => {
  const lg = makeLogger();
  eq(LOG.format(lg.info(LOG.CATEGORY.RECON, 'm', '多行详情')).split('\n').length, 2);
});

test('未识别返回走同一条链路，标记可被识别', () => {
  const lg = makeLogger();
  const rec = lg.warn(LOG.CATEGORY.FAIL, LOG.UNKNOWN_MARKER + ' 该情况尚未处理');
  ok(rec.message.indexOf(LOG.UNKNOWN_MARKER) === 0);
});

test('clear 清空缓冲', () => {
  const lg = makeLogger();
  lg.info(LOG.CATEGORY.SYSTEM, 'a');
  lg.clear();
  eq(lg.records(), []);
});

test('dump 输出纯文本，可直接展示/复制', () => {
  const lg = makeLogger();
  lg.info(LOG.CATEGORY.SYSTEM, 'A');
  lg.info(LOG.CATEGORY.SYSTEM, 'B');
  eq(lg.dump().split('\n').length, 2);
  eq(lg.dump(LOG.CATEGORY.SUCCESS), '');
});
