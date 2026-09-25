/**
 * core/diagnostics.js 与 ui/courseData.js 纯函数部分的离线单测。
 *
 * 这些文本是"把真机数据回传给我"的唯一通道，格式必须稳定、必须不泄露凭证。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/log.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');
require('../src/core/conflict.js');
require('../src/data/model.js');
require('../src/data/query.js');
require('../src/core/timetable.js');
require('../src/core/diagnostics.js');
require('../src/ui/courseData.js');

const NS = globalThis.SZUBKXK;
const D = NS.diagnostics;
const CD = NS.ui.courseData;

const S = (weekday, ps, pe) => ({
  weekStart: 1,
  weekEnd: 16,
  weekParity: 'all',
  weekday: weekday,
  periodStart: ps,
  periodEnd: pe,
});

const rec = (id, extra) =>
  Object.assign(
    {
      teachingClassId: id,
      courseName: '课程' + id,
      teacherName: '老师' + id,
      courseNumber: 'C' + id,
      teachingClassType: 'FANKC',
      classCapacity: 55,
      selectedCount: 52,
      sessions: [S(2, 3, 4)],
    },
    extra || {}
  );

section('core/diagnostics.js 基础格式');

test('formatTime 对非法输入给占位', () => {
  eq(D.formatTime(null), '(无)');
  eq(D.formatTime(0), '(无)');
  eq(D.formatTime(NaN), '(无)');
  ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(D.formatTime(1700000000000)), D.formatTime(1700000000000));
});

test('flagsOf 组合标记', () => {
  eq(D.flagsOf(rec('A')), ['有余量']);
  eq(D.flagsOf(rec('A', { classCapacity: 55, selectedCount: 55 })), ['已满']);
  eq(D.flagsOf(rec('A', { classCapacity: null, selectedCount: null })), ['余量未知']);
  eq(D.flagsOf(rec('A', { isMooc: true })), ['MOOC', '有余量']);
  eq(D.flagsOf(rec('A'), 2), ['有余量', '与自定义课程冲突×2']);
  eq(D.flagsOf(null), []);
});

section('core/diagnostics.js 课程数据文本');

test('没有数据时给出可操作提示', () => {
  const text = D.buildCourseDigest({ records: [], customCourses: [], now: 1700000000000 });
  ok(text.indexOf('课程记录：0 条') !== -1, text);
  ok(text.indexOf('还没有采集到课程数据') !== -1, text);
});

test('正常输出含统计、逐条明细与标记', () => {
  const text = D.buildCourseDigest({
    records: [rec('TC1')],
    customCourses: [NS.customCourse.normalize({ id: 'c1', name: '重修课', sessions: [S(2, 4, 5)] })],
    updatedAt: 1700000000000,
    now: 1700000000000,
  });
  ok(text.indexOf('课程记录：1 条') !== -1, text);
  ok(text.indexOf('自定义课程：1 门') !== -1, text);
  ok(text.indexOf('教学班 TC1') !== -1, text);
  ok(text.indexOf('有余量') !== -1, text);
  ok(text.indexOf('与自定义课程冲突×1') !== -1, '应标出与自定义课程的冲突：' + text);
});

test('输出名额分布（字段解析是否正确的关键信号）', () => {
  const text = D.buildCourseDigest({
    records: [
      rec('A'),
      rec('B', { classCapacity: 50, selectedCount: 50 }),
      rec('C', { classCapacity: null, selectedCount: null }),
    ],
    limit: 1,
  });
  ok(text.indexOf('名额分布：有余量 1 / 已满 1 / 未知 1') !== -1, text);
});

test('有自定义课程时输出课表布局摘要', () => {
  const text = D.buildCourseDigest({
    records: [],
    customCourses: [NS.customCourse.normalize({ id: 'c1', name: '重修', sessions: [S(2, 3, 4)] })],
  });
  ok(text.indexOf('课表布局：') !== -1, '缺布局摘要：' + text);
});

test('超过 limit 时截断并说明', () => {
  const many = [];
  for (let i = 0; i < 5; i++) many.push(rec('T' + i));
  const text = D.buildCourseDigest({ records: many, limit: 2 });
  ok(text.indexOf('另有 3 条未列出') !== -1, text);
});

test('空 options 不炸', () => {
  const text = D.buildCourseDigest({});
  ok(typeof text === 'string' && text.length > 0);
});

section('core/diagnostics.js 样本文本');

test('无样本时给出提示', () => {
  const text = D.buildSampleDigest([]);
  ok(text.indexOf('样本数：0') !== -1);
  ok(text.indexOf('暂无样本') !== -1);
});

test('输出样本的地址、来源与原文', () => {
  const text = D.buildSampleDigest([
    { url: 'http://x/elective/programCourse.do', source: 'xhr', length: 12, text: '{"code":"1"}' },
  ]);
  ok(text.indexOf('来源 xhr') !== -1, text);
  ok(text.indexOf('http://x/elective/programCourse.do') !== -1, text);
  ok(text.indexOf('{"code":"1"}') !== -1, text);
});

test('样本原文超长时再截断', () => {
  const text = D.buildSampleDigest([{ url: 'u', source: 'fetch', length: 999, text: 'A'.repeat(500) }], {
    textLimit: 100,
  });
  ok(text.indexOf('诊断输出再截断') !== -1, '应提示已截断');
});

section('core/diagnostics.js 回传包');

test('buildFullReport 含四个分区', () => {
  const text = D.buildFullReport({
    version: '9.9.9',
    selfTestText: 'SELFTEST-MARK',
    envText: 'ENV-MARK',
    courseText: 'COURSE-MARK',
    sampleText: 'SAMPLE-MARK',
  });
  ok(text.indexOf('9.9.9') !== -1);
  ok(text.indexOf('SELFTEST-MARK') !== -1, '缺自检分区');
  ok(text.indexOf('ENV-MARK') !== -1);
  ok(text.indexOf('COURSE-MARK') !== -1);
  ok(text.indexOf('SAMPLE-MARK') !== -1);
  ok(text.indexOf('零、页内自检') !== -1);
  ok(text.indexOf('一、环境侦察') !== -1);
});

test('buildFullReport 未传自检文本时给占位，不炸', () => {
  const text = D.buildFullReport({ version: '1.0.0' });
  ok(text.indexOf('(未运行)') !== -1, text);
});

section('ui/courseData.js 复制降级');

/** 造一个只实现复制所需接口的假 document。 */
function fakeDoc(execOk) {
  return {
    appended: 0,
    body: {
      appendChild() {
        this.appended = (this.appended || 0) + 1;
      },
      removeChild() {},
    },
    createElement() {
      return { value: '', style: {}, select() {} };
    },
    execCommand() {
      return execOk;
    },
  };
}

test('优先用 navigator.clipboard', () => {
  const written = [];
  const win = { navigator: { clipboard: { writeText: (t) => written.push(t) } } };
  eq(CD.copyText(win, fakeDoc(true), '你好'), true);
  eq(written, ['你好']);
});

test('没有 clipboard 时降级到 execCommand', () => {
  eq(CD.copyText({ navigator: {} }, fakeDoc(true), 'x'), true);
  eq(CD.copyText({ navigator: {} }, fakeDoc(false), 'x'), false);
});

test('clipboard 抛异常时仍能降级', () => {
  const win = {
    navigator: {
      clipboard: {
        writeText() {
          throw new Error('未授权');
        },
      },
    },
  };
  eq(CD.copyText(win, fakeDoc(true), 'x'), true);
});

test('空文本返回 false，不报错', () => {
  eq(CD.copyText({ navigator: {} }, fakeDoc(true), ''), false);
  eq(CD.copyText({ navigator: {} }, fakeDoc(true), null), false);
});
