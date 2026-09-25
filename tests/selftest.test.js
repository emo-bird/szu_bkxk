/**
 * core/selftest.js 的离线单测。
 *
 * 【双重价值】
 *   1. 验证自检器本身的行为（失败不抛、结果可格式化）；
 *   2. **把内置用例在 Node 里整体跑一遍** —— 等于对全部模块做一次集成冒烟，
 *      任何模块漏挂/行为漂移都会在这里暴露。
 */
'use strict';

const { test, section, ok, eq } = require('./harness.js');

// 自检用例覆盖到的全部模块，一个都不能少
require('../src/core/ns.js');
require('../src/core/api.js');
require('../src/core/queue.js');
require('../src/core/log.js');
require('../src/core/session.js');
require('../src/core/store.js');
require('../src/core/schedule.js');
require('../src/core/task.js');
require('../src/core/time.js');
require('../src/core/customCourse.js');
require('../src/core/conflict.js');
require('../src/core/http.js');
require('../src/core/runner.js');
require('../src/core/diagnostics.js');
require('../src/core/selftest.js');
require('../src/data/model.js');
require('../src/data/capture.js');
require('../src/data/courseCache.js');
require('../src/data/query.js');
require('../src/core/timetable.js');
require('../src/ui/recon.js');

const NS = globalThis.SZUBKXK;
const ST = NS.selftest;

section('core/selftest.js 内置用例');

test('用例表非空且每项都有名字与函数', () => {
  ok(ST.CASES.length >= 15, '用例太少：' + ST.CASES.length);
  ST.CASES.forEach((c) => {
    ok(typeof c.name === 'string' && c.name.length > 0, '缺用例名');
    ok(typeof c.fn === 'function', '用例不是函数：' + c.name);
  });
});

test('除"版本注入"外，全部内置用例在源码环境通过（对整包的集成冒烟）', () => {
  // 源码里 NS.version 就是占位符（构建时才注入），所以这一条在 Node 下必然失败，单独排除；
  // 它在"构建产物"上的表现由文件末尾的产物级用例覆盖。
  const cases = ST.CASES.filter((c) => c.name.indexOf('版本号') === -1);
  const result = ST.run({ cases });
  if (result.failed > 0) {
    throw new Error('失败用例：' + result.failures.map((f) => f.name + ' -> ' + f.error).join(' | '));
  }
  eq(result.failed, 0);
  eq(result.passed, result.total);
});

test('版本号用例真的能抓到占位符（防"自检永远通过"）', () => {
  // 源码在 Node 下读到的就是占位符，这条用例本应失败 —— 反向证明断言有效
  const result = ST.run({
    cases: ST.CASES.filter((c) => c.name.indexOf('版本号') !== -1),
  });
  eq(result.total, 1);
  eq(result.failed, 1, '在未注入版本的源码环境下，版本用例必须失败（否则断言形同虚设）');
  ok(result.failures[0].error.indexOf('版本号未正确注入') !== -1, result.failures[0].error);
});

section('core/selftest.js 运行与容错');

test('自定义用例：统计与失败明细', () => {
  const result = ST.run({
    cases: [
      { name: 'ok-1', fn: () => {} },
      {
        name: 'bad-1',
        fn: () => {
          throw new Error('炸了');
        },
      },
      { name: 'ok-2', fn: () => {} },
    ],
  });
  eq(result.total, 3);
  eq(result.passed, 2);
  eq(result.failed, 1);
  eq(result.failures[0].name, 'bad-1');
  eq(result.failures[0].error, '炸了');
});

test('用例抛非 Error 也不中断', () => {
  const result = ST.run({
    cases: [
      {
        name: 'weird',
        fn: () => {
          throw 'string-throw';
        },
      },
      { name: 'after', fn: () => {} },
    ],
  });
  eq(result.failed, 1);
  eq(result.passed, 1, '后续用例必须继续执行');
  eq(result.failures[0].error, 'string-throw');
});

test('空用例表返回 0/0', () => {
  const result = ST.run({ cases: [] });
  eq(result.total, 0);
  eq(result.passed, 0);
  eq(result.failed, 0);
});

test('结果带上版本号与时间', () => {
  const result = ST.run({ cases: [] });
  eq(result.version, NS.version);
  ok(typeof result.at === 'number' && result.at > 0);
});

section('core/selftest.js 文本输出');

test('全部通过时输出 [OK] 与计数', () => {
  const text = ST.format({ total: 3, passed: 3, failed: 0, failures: [], version: '1.2.3' });
  ok(text.indexOf('共 3 项，通过 3 项，失败 0 项') !== -1, text);
  ok(text.indexOf('[OK] 全部通过') !== -1, text);
  ok(text.indexOf('1.2.3') !== -1, text);
});

test('有失败时逐条列出', () => {
  const text = ST.format({
    total: 2,
    passed: 1,
    failed: 1,
    failures: [{ name: '用例甲', error: '原因乙' }],
    version: '0.0.1',
  });
  ok(text.indexOf('[FAIL] 用例甲 -> 原因乙') !== -1, text);
});

test('空结果给占位', () => {
  eq(ST.format(null), '(未运行自检)');
});

section('core/selftest.js 构建产物级验证');

test('构建产物在干净上下文中通过全部自检（含版本注入）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const distPath = path.join(__dirname, '..', 'dist', 'szu_bkxk.user.js');
  if (!fs.existsSync(distPath)) {
    console.log('       [SKIP] 未找到 dist/szu_bkxk.user.js，请先运行 node scripts/build.mjs');
    return;
  }

  const code = fs.readFileSync(distPath, 'utf8');
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'szu_bkxk.user.js' });

  const built = sandbox.SZUBKXK;
  ok(built, '构建产物未挂载 SZUBKXK');
  ok(built.selftest, '构建产物缺少 selftest 模块');

  const result = built.selftest.run();
  if (result.failed > 0) {
    throw new Error('产物自检失败：' + result.failures.map((f) => f.name + ' -> ' + f.error).join(' | '));
  }
  eq(result.failed, 0);
  ok(/^\d+\.\d+\.\d+$/.test(result.version), '产物版本号未注入：' + result.version);
});

test('构建产物不含构建说明残留（防止误当安装包）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const distPath = path.join(__dirname, '..', 'dist', 'szu_bkxk.user.js');
  if (!fs.existsSync(distPath)) return;
  const code = fs.readFileSync(distPath, 'utf8');
  eq(code.indexOf('不是可直接安装的脚本'), -1, '产物里混入了构建输入说明');
  eq(code.indexOf('__SZUBKXK_VERSION__'), -1, '产物里残留版本占位符');
  ok(code.indexOf('// ==UserScript==') === 0, '产物必须以元数据块开头');
});

test('版本占位符在 src 中恰好出现一次（构建替换是全量的，多一处就会被悄悄改掉）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const srcDir = path.join(__dirname, '..', 'src');
  const token = '__SZUBKXK' + '_VERSION__';

  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.endsWith('.js')) files.push(full);
    });
  })(srcDir);

  let count = 0;
  const where = [];
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    const n = text.split(token).length - 1;
    if (n > 0) where.push(path.basename(f) + '×' + n);
    count += n;
  });
  eq(count, 1, '占位符出现次数异常，分布：' + where.join(', '));
});
