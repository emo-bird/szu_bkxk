/**
 * core/session.js 的离线单测。
 * 用假的 window.sessionStorage 模拟站点登录后的状态，不联网。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

require('../src/core/ns.js');
require('../src/core/session.js');

const SESS = globalThis.SZUBKXK.session;

/** 造一个带 sessionStorage 的假 window。 */
function fakeWin(entries) {
  const map = Object.assign({}, entries);
  return {
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => {
        map[k] = String(v);
      },
      removeItem: (k) => {
        delete map[k];
      },
    },
  };
}

section('core/session.js 读取会话');

test('正常读取 token / 学号 / 批次号 / 学期', () => {
  const win = fakeWin({
    token: 'TOKEN-ABCDEFGH',
    studentInfo: '{"studentCode":"2026000000","name":"张三"}',
    currentBatch: '{"code":"BATCH-1","schoolTerm":"2026-2027-1"}',
  });
  const s = SESS.read(win);
  eq(s.token, 'TOKEN-ABCDEFGH');
  eq(s.studentCode, '2026000000');
  eq(s.electiveBatchCode, 'BATCH-1');
  eq(s.schoolTerm, '2026-2027-1');
  eq(s.ok, true);
  eq(s.missing, []);
});

test('缺 token 时 ok=false 且列出缺失项', () => {
  const win = fakeWin({
    studentInfo: '{"studentCode":"2026000000"}',
    currentBatch: '{"code":"BATCH-1"}',
  });
  const s = SESS.read(win);
  eq(s.ok, false);
  eq(s.missing, ['token']);
});

test('studentInfo 是坏 JSON 时视为缺失该字段', () => {
  const win = fakeWin({ token: 'T', studentInfo: '{坏', currentBatch: '{"code":"B"}' });
  const s = SESS.read(win);
  eq(s.studentCode, null);
  eq(s.ok, false);
  eq(s.missing, ['studentCode']);
});

test('sessionStorage 不可用时 available=false 并列出全部缺失', () => {
  const s = SESS.read({});
  eq(s.available, false);
  eq(s.ok, false);
  eq(s.missing, ['token', 'studentInfo', 'currentBatch']);
});

test('学号候选字段名容错（studentcode / xh 等）', () => {
  eq(SESS.read(fakeWin({ token: 'T', studentInfo: '{"studentcode":"A"}', currentBatch: '{"code":"B"}' })).studentCode, 'A');
  eq(SESS.read(fakeWin({ token: 'T', studentInfo: '{"xh":"C"}', currentBatch: '{"code":"B"}' })).studentCode, 'C');
});

test('批次号候选字段名容错（electiveBatchCode / batchCode）', () => {
  eq(SESS.read(fakeWin({ token: 'T', studentInfo: '{"studentCode":"A"}', currentBatch: '{"electiveBatchCode":"E"}' })).electiveBatchCode, 'E');
  eq(SESS.read(fakeWin({ token: 'T', studentInfo: '{"studentCode":"A"}', currentBatch: '{"batchCode":"K"}' })).electiveBatchCode, 'K');
});

section('core/session.js 脱敏显示');

test('mask 保留前 8 个字符 + 长度', () => {
  eq(SESS.mask('ABCDEFGHIJKL'), 'ABCDEFGH…(长度 12)');
  eq(SESS.mask('AB'), 'A***(长度 2)');
  eq(SESS.mask(''), '(空)');
  eq(SESS.mask(null), '(空)');
});

test('describe 给出可读摘要，且不泄露完整凭证', () => {
  const win = fakeWin({
    token: 'TOKEN-ABCDEFGH',
    studentInfo: '{"studentCode":"2026000000"}',
    currentBatch: '{"code":"BATCH-1"}',
  });
  const text = SESS.describe(SESS.read(win));
  ok(text.indexOf('会话已就绪') !== -1, '摘要不对：' + text);
  ok(text.indexOf('TOKEN-ABCDEFGH') === -1, '不应出现完整 token');
  ok(text.indexOf('2026000000') === -1, '不应出现完整学号');
});

test('describe 对残缺会话给出可操作提示', () => {
  const text = SESS.describe(SESS.read(fakeWin({})));
  ok(text.indexOf('缺少') !== -1, '提示不对：' + text);
});
