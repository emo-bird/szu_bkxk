/**
 * 测试入口：自动发现并运行 tests/ 下所有 *.test.js，最后输出汇总。
 *
 * 用法：node tests/run.js
 * 约定：测试文件用 `require('../src/xxx.js')` 加载被测模块（模块执行时会自挂 globalThis.SZUBKXK）。
 * 注意：report() 是 async 的；Node 事件循环会等到异步用例结束，无需手动 await。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.log('[WARN] tests/ 下没有任何 *.test.js');
}

files.forEach((f) => require(path.join(dir, f)));

require('./harness.js').report();
