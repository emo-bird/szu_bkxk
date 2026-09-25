/**
 * 拼接 src/*.js 为单文件 userscript，并校验体积上限。
 * 用法：node scripts/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 体积上限已按用户要求移除，只报告不拦截。 */
const SIZE_WARN = 150 * 1024;

/** 拼接顺序即依赖顺序。 */
const MODULES = ['core.js', 'api.js', 'time.js', 'courses.js', 'monitor.js', 'tasks.js', 'list.js', 'ui.js', 'main.js'];

const header = readFileSync(join(ROOT, 'src', 'userscript-header.txt'), 'utf8').trimEnd();

const parts = MODULES.map((name) => {
  const p = join(ROOT, 'src', name);
  if (!existsSync(p)) throw new Error('缺少模块: src/' + name);
  return `/* ==================== src/${name} ==================== */\n` + readFileSync(p, 'utf8').trimEnd();
});

const out = header + '\n\n' + parts.join('\n\n') + '\n';

const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const outPath = join(distDir, 'szu_bkxk.user.js');
writeFileSync(outPath, out, 'utf8');

const bytes = Buffer.byteLength(out, 'utf8');
const kb = (bytes / 1024).toFixed(1);
console.log(`✔ 构建完成 dist/szu_bkxk.user.js  ${bytes} 字节 (${kb} KB)`);
console.log(`  模块: ${MODULES.length} 个`);
if (bytes > SIZE_WARN) {
  console.log(`  ⚠ 体积偏大（> ${SIZE_WARN / 1024} KB），但仍会产出（已按要求移除上限）`);
} else {
  console.log('✔ 体积正常（无上限约束）');
}
