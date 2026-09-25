/**
 * 拼接 src/*.js 为单文件 userscript。
 * 用法：node scripts/build.mjs
 *
 * 【版本号单一来源】package.json 的 version 会被强制写进产物头部，
 * 避免头部版本与发布版本不一致（自动更新靠 @version 比对，写错就不会更新）。
 * 只改 package.json 的 version，脚本里的 src/main.js 用 __VERSION__ 占位。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 体积上限已按用户要求移除，只报告不拦截。 */
const SIZE_WARN = 150 * 1024;

/** 拼接顺序即依赖顺序。 */
const MODULES = ['core.js', 'api.js', 'time.js', 'courses.js', 'custom.js', 'monitor.js', 'tasks.js', 'list.js', 'timetable.js', 'hijack.js', 'ui.js', 'main.js'];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// 头部：把 @version 强制成 package.json 的版本
let header = readFileSync(join(ROOT, 'src', 'userscript-header.txt'), 'utf8').trimEnd();
if (!/@version\s+\S+/.test(header)) throw new Error('头部缺少 @version');
header = header.replace(/@version\s+\S+/, '@version      ' + VERSION);

const parts = MODULES.map((name) => {
  const p = join(ROOT, 'src', name);
  if (!existsSync(p)) throw new Error('缺少模块: src/' + name);
  const code = readFileSync(p, 'utf8').trimEnd().replace(/__VERSION__/g, VERSION);
  return `/* ==================== src/${name} ==================== */\n` + code;
});

const out = header + '\n\n' + parts.join('\n\n') + '\n';

const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const outPath = join(distDir, 'szu_bkxk.user.js');
writeFileSync(outPath, out, 'utf8');

const bytes = Buffer.byteLength(out, 'utf8');
const kb = (bytes / 1024).toFixed(1);
console.log(`✔ 构建完成 dist/szu_bkxk.user.js  ${bytes} 字节 (${kb} KB)`);
console.log(`  版本: ${VERSION}　模块: ${MODULES.length} 个`);
if (bytes > SIZE_WARN) {
  console.log(`  ⚠ 体积偏大（> ${SIZE_WARN / 1024} KB），但仍会产出（已按要求移除上限）`);
} else {
  console.log('✔ 体积正常（无上限约束）');
}
