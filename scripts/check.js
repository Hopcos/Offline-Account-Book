#!/usr/bin/env node
/**
 * scripts/check.js —— 冒烟测试
 * 1) 校验 index.html 已生成且占位符全部替换、关键标记齐全；
 * 2) 抽取内联脚本做语法检查（app.js / worker.js）；
 * 3) 在 Node 中真实加载 vendor 的 SQLite(WebAssembly) 并执行建库/读写；
 * 4) 校验数据区正则与"写回 HTML"逻辑可正确提取/替换数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = (name) => console.log('  ✔ ' + name);
const fail = (name, extra) => { failed++; console.error('  ✘ ' + name + (extra ? ' -> ' + extra : '')); };

async function main() {
  console.log('[1/4] 校验 index.html 结构');
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    fail('index.html 存在（请先执行 node build.js）');
    process.exit(1);
  }
  const html = read('index.html');
  if (!/\{\{[A-Z_]+\}\}/.test(html)) ok('无未替换占位符'); else fail('存在未替换占位符');
  const marks = ['<script id="adb-data"', '<script id="adb-sqljs"', '<script id="adb-wasm"',
    '<script id="adb-worker"', 'id="app-header"', 'id="view"', 'name="adb-saved-at"'];
  const missing = marks.filter((m) => !html.includes(m));
  missing.length === 0 ? ok('关键标记齐全') : fail('缺少标记', missing.join(','));
  // script 标签配对（同时统计转义写法 <\/script>，它不会闭合标签但应成对出现）
  const opens = (html.match(/<script\b/g) || []).length;
  const closes = (html.match(/<\\?\/script>/g) || []).length;
  opens === closes ? ok(`script 标签配对 (${opens})`) : fail('script 标签不配对', `${opens} vs ${closes}`);

  console.log('[2/4] 内联脚本语法检查');
  const extract = (id) => {
    const m = html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`));
    return m ? m[1] : null;
  };
  const srcs = {
    'app.js': (() => {
      const m = html.match(/<!-- 主程序 -->\s*<script>([\s\S]*?)<\/script>/);
      return m ? m[1] : null;
    })(),
    'worker.js': extract('adb-worker')
  };
  for (const [name, src] of Object.entries(srcs)) {
    if (!src) { fail(`${name} 可提取`); continue; }
    try {
      new Function(src); // 仅做解析
      ok(`${name} 语法有效 (${src.length} 字符)`);
    } catch (e) { fail(`${name} 语法`, e.message); }
  }

  console.log('[3/4] SQLite(WebAssembly) 引擎真实加载与读写');
  try {
    const initSqlJs = require(path.join(ROOT, 'vendor', 'sql-wasm.js'));
    const wasmBinary = fs.readFileSync(path.join(ROOT, 'vendor', 'sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary });
    const d = new SQL.Database();
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t(name) VALUES(\'记账\'),(\'测试\');');
    const rows = d.exec('SELECT COUNT(*) FROM t');
    const n = rows[0].values[0][0];
    n === 2 ? ok('WASM 引擎可建库读写 (rows=' + n + ')') : fail('读写结果异常', String(n));
    const bytes = d.export();
    const magic = Buffer.from(bytes.slice(0, 16)).toString('latin1');
    magic.startsWith('SQLite format 3') ? ok('导出为合法 SQLite 文件头') : fail('SQLite 文件头', JSON.stringify(magic));
    d.close();
  } catch (e) { fail('WASM 引擎加载', e.message); }

  console.log('[4/4] 数据区写回 / 提取逻辑');
  try {
    const appJs = read('src/js/app.js');
    const reSrc = appJs.match(/const HTML_DATA_RE = (\/[\s\S]*?\/);/);
    if (!reSrc) throw new Error('未找到 HTML_DATA_RE 定义');
    // 还原正则（源码中的 <\/script> 即 </script>）
    const RE = eval(reSrc[1]);
    const fakeHtml = '<head></head><script id="adb-data" type="text/plain">OLD_B64</script><script>var x=1<' + '/script></body>';
    const m = RE.exec(fakeHtml);
    if (!m) throw new Error('正则未匹配数据区');
    const NEW = 'NEW_B64_DATA';
    const out = fakeHtml.slice(0, m.index) + m[1] + NEW + m[3] + fakeHtml.slice(m.index + m[0].length);
    out.includes('OLD_B64') ? fail('旧数据未替换') : ok('旧数据已替换');
    out.includes(NEW) ? ok('新数据已写入') : fail('新数据缺失');
    const again = RE.exec(out);
    again && again[2] === NEW ? ok('再次提取得到新数据') : fail('再次提取', String(again && again[2]));
  } catch (e) { fail('写回逻辑', e.message); }

  console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });