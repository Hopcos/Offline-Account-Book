#!/usr/bin/env node
/**
 * build.js —— 构建脚本
 * 将 CSS / JS / Worker / SQL.js(WebAssembly) 资源全部内联进 src/index.template.html，
 * 产出完全自包含的单文件 index.html。
 *
 * 用法：node build.js   （或 npm run build）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 防止内联脚本内容中出现 "</script>" 提前闭合 <script> 标签。
 * "</" -> "<\/" 在 JS 字符串与正则字面量中均为合法等价写法。
 */
const escapeInline = (s) => s.replace(/<\/script/gi, '<\\/script');

function replaceToken(html, token, value) {
  if (!html.includes(token)) {
    throw new Error(`构建失败：模板中缺少占位符 ${token}`);
  }
  // 使用函数形式替换，避免 value 中的 "$&" 等特殊序列被解释
  return html.replace(token, () => value);
}

function main() {
  const started = Date.now();

  const template = read('src/index.template.html');
  const css = read('src/css/app.css');
  const appJs = read('src/js/app.js');
  const workerJs = read('src/worker/worker.js');
  const glue = read('vendor/sql-wasm.js');
  const wasmB64 = fs.readFileSync(path.join(ROOT, 'vendor', 'sql-wasm.wasm')).toString('base64');

  let out = template;
  out = replaceToken(out, '{{APP_CSS}}', css.replace(/<\/style/gi, '<\\/style'));
  out = replaceToken(out, '{{APP_JS}}', escapeInline(appJs));
  out = replaceToken(out, '{{WORKER_SRC}}', escapeInline(workerJs));
  out = replaceToken(out, '{{SQLJS_GLUE}}', escapeInline(glue));
  out = replaceToken(out, '{{SQL_WASM_B64}}', wasmB64);

  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`构建失败：存在未替换的占位符 ${leftover.join(', ')}`);
  }

  const target = path.join(ROOT, 'index.html');
  fs.writeFileSync(target, out, 'utf8');

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('[build] 完成 ->', target);
  console.log(`[build] index.html = ${kb(Buffer.byteLength(out))}（含 WebAssembly 数据库 ${kb(Buffer.byteLength(wasmB64))}）`);
  console.log(`[build] 耗时 ${Date.now() - started} ms`);
}

main();