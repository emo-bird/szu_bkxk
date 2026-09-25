/**
 * 命名空间与工具集的离线单测。
 * 这些工具被后续所有模块复用，先钉住行为。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');

const NS = globalThis.SZUBKXK;

section('core/ns.js 命名空间');

test('模块加载后挂载到 globalThis.SZUBKXK', () => {
  ok(NS && typeof NS === 'object', 'SZUBKXK 未挂载');
  ok(NS.util && typeof NS.util.clamp === 'function');
});

test('NS.META 标记了 studyOnly', () => {
  eq(NS.META.studyOnly, true);
});

section('core/ns.js util.clamp');

test('正常区间钳位', () => {
  eq(NS.util.clamp(500, 200, 60000, 500), 500);
  eq(NS.util.clamp(100, 200, 60000, 500), 200);
  eq(NS.util.clamp(999999, 200, 60000, 500), 60000);
});

test('非法值回退到 fallback（不猜、不抛）', () => {
  eq(NS.util.clamp(NaN, 200, 60000, 500), 500);
  eq(NS.util.clamp(undefined, 200, 60000, 500), 500);
  eq(NS.util.clamp('abc', 200, 60000, 500), 500);
});

test('数字字符串按数值处理', () => {
  eq(NS.util.clamp('800', 200, 60000, 500), 800);
});

section('core/ns.js util.parseJson');

test('正常解析', () => {
  eq(NS.util.parseJson('{"a":1}', null), { a: 1 });
});

test('坏 JSON 返回 fallback，不抛异常', () => {
  eq(NS.util.parseJson('{oops', 'FALLBACK'), 'FALLBACK');
  eq(NS.util.parseJson('', 'FALLBACK'), 'FALLBACK');
});

section('core/ns.js util.pick');

test('按候选顺序取第一个有效值', () => {
  const row = { a: null, b: '', c: '0', d: 'x' };
  eq(NS.util.pick(row, ['a', 'b', 'c', 'd'], 'fb'), '0');
});

test('候选全部落空时返回 fallback', () => {
  eq(NS.util.pick({ a: null, b: '' }, ['a', 'b'], 'fb'), 'fb');
  eq(NS.util.pick(null, ['a'], 'fb'), 'fb');
});

section('core/ns.js util.uid');

test('uid 非空且不重复', () => {
  const a = NS.util.uid();
  const b = NS.util.uid();
  ok(typeof a === 'string' && a.length > 0, 'uid 为空');
  ok(a !== b, '连续两次 uid 相同');
});
