/**
 * 零依赖单测框架（CommonJS，Node 直接运行）。
 *
 * 【为什么不用 jest/vitest】本仓库刻意保持零 npm 依赖，一条 node 命令即可跑测试。
 * 【输出纪律】断言结果只看 [OK] / [FAIL]；不要靠肉眼读中文（控制台编码可能乱码）。
 *
 * 支持同步与异步用例：
 *   同步用例正常返回即可；异步用例返回 Promise（会等它 settle）。
 *   tests/run.js 调用 report()，report() 是 async 的，会等所有异步用例结束。
 *
 * 用法：
 *   const { test, section, ok, eq, throws, report } = require('./harness.js');
 *   test('某某行为', () => { eq(1 + 1, 2); });
 *   test('异步行为', async () => { await something(); });
 */
'use strict';

let total = 0;
let passed = 0;
const failures = [];
const pending = [];
let currentSection = null;

/**
 * 开始一个新的测试分组（仅用于输出分隔）。
 * @param {string} title 分组标题
 */
function section(title) {
  currentSection = title;
  console.log(`\n---- ${title} ----`);
}

function pass(name) {
  passed += 1;
  console.log(`[OK] ${name}`);
}

function fail(name, e) {
  failures.push({ name, error: e });
  console.log(`[FAIL] ${name} -> ${e && e.message ? e.message : e}`);
}

/**
 * 登记并立即执行一个用例。用例抛异常（或返回 rejected Promise）即视为失败，不中断后续用例。
 * @param {string} name 用例名
 * @param {Function} fn 用例体
 */
function test(name, fn) {
  total += 1;
  let result;
  try {
    result = fn();
  } catch (e) {
    fail(name, e);
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => pass(name), (e) => fail(name, e)));
  } else {
    pass(name);
  }
}

/** 断言为真 */
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

/** 深比较断言（用 JSON 序列化比较，适合纯数据结构） */
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg || 'not equal'}\n     actual   = ${a}\n     expected = ${b}`);
  }
}

/** 断言抛出异常；matcher 为字符串时断言 message 包含该子串 */
function throws(fn, matcher, msg) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${msg || 'expected throw'}: 没有抛出异常`);
  if (typeof matcher === 'string' && String(threw.message).indexOf(matcher) === -1) {
    throw new Error(`${msg || 'expected throw'}: message 不含 "${matcher}"，实际 "${threw.message}"`);
  }
}

/** 输出汇总并设置退出码（有失败则非 0，便于脚本/CI 判断） */
async function report() {
  if (pending.length) await Promise.all(pending);
  console.log(`\n共 ${total} 项，通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  [FAIL] ${f.name}`));
    process.exitCode = 1;
  }
}

module.exports = { test, section, ok, eq, throws, report };
