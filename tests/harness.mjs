/**
 * 极简测试框架：零依赖，不用 jest（开发文档 §二：不引入 jest 式框架）。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tests = [];
let passed = 0;
let failed = 0;

export function test(name, fn) {
  tests.push({ name, fn });
}

export function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'eq 失败'}\n    实际: ${a}\n    期望: ${e}`);
}

export function ok(value, label) {
  if (!value) throw new Error(label || 'ok 断言失败');
}

/**
 * 把 src 各模块按顺序拼接后在一个隔离上下文中求值，返回挂好的 SZUBKXK 命名空间。
 * 这样测试跑的就是真正会打包进产物、且在浏览器里运行的那份代码。
 *
 * 传入 docMock 时，把该对象作为 document 注入（供 list/intercept 的 DOM 用例使用）。
 */
export function loadNS(docMock) {
  const MODULES = ['core.js', 'api.js', 'time.js', 'courses.js', 'monitor.js', 'list.js', 'intercept.js'];
  const src = MODULES.map((m) => readFileSync(join(ROOT, 'src', m), 'utf8')).join('\n');

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    Error,
    TypeError,
    isFinite,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    localStorage: null,
    document: docMock || null,
    sessionStorage: docMock ? docMock._sessionStorage || null : null,
    location: { pathname: '/' },
    fetch: null,
    XMLHttpRequest: function () { this.addEventListener = function () {}; },
    MutationObserver: function () { this.observe = function () {}; },
    BH_UTILS: { doAjax: function () { return { done() { return this; } }; } },
  };
  sandbox.globalThis = sandbox;

  const fn = new Function(
    'globalThis', 'console', 'setTimeout', 'clearTimeout', 'localStorage', 'sessionStorage',
    'document', 'location', 'fetch', 'XMLHttpRequest', 'MutationObserver', 'BH_UTILS', src
  );
  fn(
    sandbox, sandbox.console, sandbox.setTimeout, sandbox.clearTimeout, sandbox.localStorage,
    sandbox.sessionStorage, sandbox.document, sandbox.location, sandbox.fetch,
    sandbox.XMLHttpRequest, sandbox.MutationObserver, sandbox.BH_UTILS
  );
  return sandbox.SZUBKXK;
}

export async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  \u2714 ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  \u2718 ${t.name}`);
      console.log(`      ${e.message}`);
    }
  }
  console.log(`\n${passed} 通过, ${failed} 失败, 共 ${tests.length} 项`);
  if (failed > 0) process.exit(1);
}
