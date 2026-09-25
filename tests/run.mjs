/**
 * 测试入口：依次运行各测试文件。
 * 用法：node tests/run.mjs
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['payload.test.mjs', 'api.test.mjs', 'time.test.mjs', 'conflict.test.mjs', 'list.test.mjs'];

let failed = 0;
for (const f of FILES) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(HERE, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('');
if (failed) {
  console.error(`✘ ${failed} 个测试文件失败`);
  process.exit(1);
}
console.log('✔ 全部测试通过');
