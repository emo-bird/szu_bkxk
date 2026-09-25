/**
 * 构建脚本：把 src/ 下的模块拼接为单文件油猴脚本 dist/szu_bkxk.user.js。
 *
 * 【零依赖】只用 node: 内置模块，不引入 npm 包（保持"双击即可构建"）。
 * 【单一事实源】@version 只在 src/userscript-header.txt 里维护，
 *   构建时读取并替换代码中的 __SZUBKXK_VERSION__ 占位符。
 * 【模块顺序】按路径字母序拼接。所有模块都自挂命名空间，
 *   因此**模块间不得存在加载顺序依赖**（这是硬约定，见 src/core/ns.js 注释）。
 *
 * 用法：node scripts/build.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const HEADER_FILE = join(SRC, 'userscript-header.txt');
const OUT_FILE = join(ROOT, 'dist', 'szu_bkxk.user.js');

const VERSION_TOKEN = '__SZUBKXK_VERSION__';

/**
 * 读取元数据头，并取出 @version（构建注入用）。
 *
 * 只截取 `// ==UserScript==` 到 `// ==/UserScript==` 之间的块；
 * 该块之外的注释是"给维护者看的构建输入说明"，**不能**出现在产物里
 * （否则产物里会写着"这不是可直接安装的脚本"这种自相矛盾的话）。
 */
function readHeader() {
  const raw = readFileSync(HEADER_FILE, 'utf8').replace(/\r\n/g, '\n');
  const block = raw.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  if (!block) throw new Error(`[FAIL] ${relative(ROOT, HEADER_FILE)} 里找不到 ==UserScript== 块`);
  const header = block[0];
  const v = header.match(/^\/\/\s*@version\s+(\S+)\s*$/m);
  if (!v) throw new Error(`[FAIL] ${relative(ROOT, HEADER_FILE)} 里找不到 @version`);
  return { header, version: v[1] };
}

/** 递归列出 src 下所有 .js 模块，按路径字母序；入口 src/main.js 强制排到最后。 */
function listModules() {
  const all = readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => join(d.parentPath, d.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // 入口负责装配其它模块，必须最后执行；而字母序里 main.js 排在 ui/ 之前，所以显式后移。
  const isEntry = (p) => p === join(SRC, 'main.js');
  return all.filter((p) => !isEntry(p)).concat(all.filter(isEntry));
}

function main() {
  if (!existsSync(HEADER_FILE)) throw new Error(`[FAIL] 缺少 ${relative(ROOT, HEADER_FILE)}`);
  const { header, version } = readHeader();
  const modules = listModules();

  // 版本占位符必须**恰好出现 1 次**（就是 NS.version 的赋值）。
  // 替换是全量的：若有人在别处也写了这个字面量（注释/断言里很容易发生），
  // 它会被悄悄换成版本号，行为随之改变 —— 所以在这里硬性拦住。
  const tokenCount = modules.reduce((n, p) => {
    const src = readFileSync(p, 'utf8');
    return n + src.split(VERSION_TOKEN).length - 1;
  }, 0);
  if (tokenCount !== 1) {
    throw new Error(
      `[FAIL] 版本占位符 ${VERSION_TOKEN} 应恰好出现 1 次，实际 ${tokenCount} 次；` +
        `请检查是否有模块把该字面量写进了注释或断言`
    );
  }

  const body = modules
    .map((p) => {
      const rel = relative(SRC, p).split('\\').join('/');
      const code = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split(VERSION_TOKEN).join(version).trimEnd();
      return `// ======== ${rel} ========\n${code}`;
    })
    .join('\n\n');

  const out =
    `${header}\n\n` +
    `// 本文件由 scripts/build.mjs 自动生成，请勿直接修改；改动请改 src/ 后重新构建。\n` +
    `(function () {\n'use strict';\n\n${body}\n\n})();\n`;

  if (out.includes(VERSION_TOKEN)) {
    throw new Error(`[FAIL] 输出中仍残留 ${VERSION_TOKEN} 占位符，检查构建注入逻辑`);
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log(`[OK] version=${version} modules=${modules.length} size=${kb}KB`);
  modules.forEach((p) => console.log(`     - ${relative(SRC, p).split('\\').join('/')}`));
  console.log(`[OK] -> ${relative(ROOT, OUT_FILE).split('\\').join('/')}`);
}

main();
