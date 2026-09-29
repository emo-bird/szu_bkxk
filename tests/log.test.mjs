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

test('NS.LIMITS 是时间参数的唯一下限来源，全部为 200', () => {
  ['intervalMs', 'retryIntervalMs', 'pollIntervalMs'].forEach((k) => {
    ok(NS.LIMITS[k], 'NS.LIMITS.' + k + ' 应存在');
    eq(NS.LIMITS[k].min, 200, k + ' 下限应为 200');
    eq(NS.LIMITS[k].max, 60000, k + ' 上限应为 60000');
  });
  eq(NS.LIMITS.retryIntervalMs.def, 1500, '抢课重试间隔默认值应为 1500');
  eq(NS.LIMITS.pollIntervalMs.def, 1500, '监控轮询间隔默认值应为 1500');
  eq(NS.LIMITS.intervalMs.def, 500, '请求间隔默认值应为 500');
});

test('NS.LIMITS.clamp：非法值退回默认，越界夹到边界', () => {
  eq(NS.LIMITS.clamp('retryIntervalMs', 200), 200);
  eq(NS.LIMITS.clamp('retryIntervalMs', 199), 200, '低于 200 夹到 200');
  eq(NS.LIMITS.clamp('retryIntervalMs', 999999), 60000);
  eq(NS.LIMITS.clamp('retryIntervalMs', 'abc'), 1500, '非数字退回默认值');
  eq(NS.LIMITS.clamp('retryIntervalMs', undefined), 1500);
  eq(NS.LIMITS.clamp('pollIntervalMs', 500), 500, '范围内原样返回，不夹到下限');
  eq(NS.LIMITS.clamp('pollIntervalMs', 199), 200, '监控间隔下限也已是 200');
});

test('DEFAULT_SETTINGS 的默认值取自 NS.LIMITS，未再写裸数字', () => {
  const d = NS.DEFAULT_SETTINGS;
  eq(d.intervalMs, NS.LIMITS.intervalMs.def);
  eq(d.retryIntervalMs, NS.LIMITS.retryIntervalMs.def);
  eq(d.pollIntervalMs, NS.LIMITS.pollIntervalMs.def);
});

test('设置页三个时间输入框一律走 limitRow（上下限取自 NS.LIMITS）', () => {
  const calls = UI_SRC.match(/limitRow\(/g) || [];
  eq(calls.length, 4, 'limitRow 应出现 4 次：定义 1 + 调用 3');
  ['intervalMs', 'retryIntervalMs', 'pollIntervalMs'].forEach((k) => {
    ok(new RegExp("limitRow\\([^,]+, '" + k + "'").test(UI_SRC), `应有 ${k} 的 limitRow 调用`);
  });
  ok(UI_SRC.indexOf('numberRow') < 0, 'numberRow 应已被 limitRow 取代，不得残留');
});

test('UI 不得再硬编码时间下限，一律引用 NS.LIMITS', () => {
  const nums = UI_SRC.match(/limitRow\('[^']+',\s*'\w+',\s*\d+/g) || [];
  eq(nums.length, 0, 'limitRow 调用不得再传裸数字边界：' + nums.join(' | '));
  ok(UI_SRC.indexOf('NS.LIMITS.clamp') >= 0, 'UI 钳位应走 NS.LIMITS.clamp');
});

await run();
