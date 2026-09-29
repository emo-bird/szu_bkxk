/**
 * 日志与时间参数测试。
 * 日志渲染在 ui.js（依赖真实 DOM，不进 harness 拼接列表），
 * 故此处对源码文本做静态断言 —— 与 wire.test.mjs 同一思路：查真正会打包的那份代码。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, loadNS, run } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = readFileSync(join(ROOT, 'src', 'ui.js'), 'utf8');

const NS = loadNS();

// ---------- 日志缓冲语义：仍是 push 追加（旧→新） ----------

test('LOG.buf 追加语义不变：新日志 push 到末尾', () => {
  NS.LOG.buf.length = 0;
  NS.info('第一条');
  NS.info('第二条');
  eq(NS.LOG.buf.length, 2);
  ok(NS.LOG.buf[0].indexOf('第一条') >= 0, '第 0 项应是最旧的「第一条」');
  ok(NS.LOG.buf[1].indexOf('第二条') >= 0, '第 1 项应是最新的「第二条」');
});

test('LOG 上限 300，超出丢最旧的', () => {
  NS.LOG.buf.length = 0;
  for (let i = 0; i < 305; i++) NS.info('第' + i + '条');
  eq(NS.LOG.buf.length, 300);
  ok(NS.LOG.buf[0].indexOf('第5条') >= 0, '最旧的 5 条应被丢弃，头部是「第5条」');
  ok(NS.LOG.buf[299].indexOf('第304条') >= 0, '尾部是最新的「第304条」');
});

test('日志行格式为 [HH:MM:SS][级别] 内容', () => {
  NS.LOG.buf.length = 0;
  const line = NS.warn('磁盘告警');
  ok(/^\[\d{2}:\d{2}:\d{2}\]\[warn\] 磁盘告警$/.test(line), '实际: ' + line);
});

// ---------- 渲染必须倒序（用户要求：新内容在上，旧内容在下） ----------

test('renderLog 对缓冲副本反转后再渲染，不改动 NS.LOG.buf 本身', () => {
  ok(/NS\.LOG\.buf\.slice\(\)\.reverse\(\)\.join\(/.test(UI_SRC),
    'renderLog 应使用 NS.LOG.buf.slice().reverse().join(...)');
  ok(UI_SRC.indexOf('NS.LOG.buf.reverse()') < 0,
    '不得就地 reverse 缓冲数组 —— 那会永久颠倒日志顺序');
});

// ---------- 抢课重试间隔下限 200（用户要求） ----------

test('retryIntervalMs 下限 200，不再夹到 500', () => {
  NS.saveSettings({ retryIntervalMs: 200 });
  eq(NS.tasks.retryIntervalMs(), 200, '200 应被接受');
  NS.saveSettings({ retryIntervalMs: 100 });
  eq(NS.tasks.retryIntervalMs(), 200, '低于 200 应夹到 200');
  NS.saveSettings({ retryIntervalMs: 60000 });
  eq(NS.tasks.retryIntervalMs(), 60000);
  NS.saveSettings({ retryIntervalMs: 999999 });
  eq(NS.tasks.retryIntervalMs(), 60000, '高于 60000 应夹到 60000');
});

test('retryIntervalMs 默认 1500（设置缺失/非法时）', () => {
  NS.saveSettings({ retryIntervalMs: 'abc' });
  eq(NS.tasks.retryIntervalMs(), 1500);
});

test('请求间隔硬下限仍是 200（红线②不得放松）', () => {
  eq(NS.util.clamp(NS.settings().intervalMs, 200, 60000, 200) >= 200, true);
  eq(NS.queue.intervalMs >= 200, true, '队列间隔不得低于 200ms');
});

test('设置页两个间隔输入框的下限都已同步为 200', () => {
  const m = UI_SRC.match(/numberRow\('抢课重试间隔[^']*',\s*'retryIntervalMs',\s*(\d+),\s*(\d+)/);
  ok(m, '应能匹配到抢课重试间隔的 numberRow');
  eq(m[1], '200', '抢课重试间隔 UI 下限应为 200');
  eq(m[2], '60000', '抢课重试间隔 UI 上限应为 60000');
  const mi = UI_SRC.match(/numberRow\('请求间隔[^']*',\s*'intervalMs',\s*(\d+),\s*(\d+)/);
  ok(mi, '应能匹配到请求间隔的 numberRow');
  eq(mi[1], '200', '请求间隔 UI 下限应为 200');
});

await run();
