#!/usr/bin/env node
/**
 * scripts/e2e.js —— 无头浏览器端到端冒烟测试（Edge/Chrome + CDP）
 *
 * 覆盖：启动 → 新建模块 → 记两笔（校验严格排序与金额汇总）→ 设置页主题切换
 *      → 刷新后数据与状态恢复 → localStorage 镜像校验。
 *
 * 用法：node scripts/e2e.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const PROFILE = path.join(ROOT, '.e2e-profile');
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

let failed = 0;
const ok = (n) => console.log('  ✔ ' + n);
const fail = (n, x) => { failed++; console.error('  ✘ ' + n + (x ? ' -> ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  return cands.find((p) => p && fs.existsSync(p));
}

/** 极简静态服务器：仅用于验证 http(s) 环境下的 PWA 安装能力 */
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/' || url === '/index.html') {
        try {
          const html = fs.readFileSync(path.join(ROOT, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (e) { res.writeHead(500); res.end(String(e)); }
      } else if (url.indexOf('/favicon') === 0) {
        res.writeHead(204); res.end();
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function httpGetJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => { req.destroy(new Error('timeout')); });
  });
}

async function waitTarget(urlPrefix) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpGetJson('/json/list');
      const t = list.find((x) => x.type === 'page' && x.url.startsWith(urlPrefix));
      if (t) return t;
    } catch (e) { /* retry */ }
    await sleep(500);
  }
  throw new Error('未找到页面调试目标');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    this.consoleErrors = [];
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('WebSocket 连接失败'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          this.consoleErrors.push((d.exception && d.exception.description) || d.text);
        }
        if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
          this.consoleErrors.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
          this.consoleErrors.push(msg.params.entry.text);
        }
        this.listeners.forEach((fn) => fn(msg));
      }
    };
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  /** 等待表达式（Promise）返回 truthy 值 */
  async waitFor(expression, timeoutMs, label) {
    const t0 = Date.now();
    const js = `new Promise(function(res){
      var t0 = Date.now();
      (function chk(){
        var v = false;
        try { v = (${expression}); } catch(e) { v = false; }
        if (v) res(v);
        else if (Date.now() - t0 > ${timeoutMs}) res(false);
        else setTimeout(chk, 120);
      })();
    })`;
    const r = await this.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    const val = r.result && r.result.value;
    if (!val) throw new Error(`等待超时：${label || expression}`);
    return val;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function main() {
  const edge = findEdge();
  if (!edge) { fail('未找到 Edge/Chrome'); process.exit(1); }
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) { fail('index.html 不存在（先 node build.js）'); process.exit(1); }
  fs.rmSync(PROFILE, { recursive: true, force: true });

  console.log('[启动] ' + edge);
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    'about:blank'
  ], { stdio: 'ignore', detached: false });
  child.on('error', (e) => { fail('浏览器启动', e.message); process.exit(1); });

  let cdp;
  let httpServer = null;
  const HTTP_PORT = 9473;
  try {
    const target = await waitTarget('about:blank');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    console.log('[1/13] 启动应用');
    await cdp.send('Page.navigate', { url: PAGE_URL });
    const bootState = await cdp.waitFor(
      `document.getElementById('app') && !document.getElementById('app').hidden ? 'ready'
        : (document.getElementById('boot-error') && !document.getElementById('boot-error').hidden
            ? 'error:' + document.getElementById('boot-error-text').textContent : false)`,
      25000, '应用启动');
    if (String(bootState).startsWith('error:')) { fail('应用启动', bootState.slice(6)); throw new Error('boot'); }
    ok('应用启动完成（WASM 数据引擎就绪）');
    await cdp.waitFor(`document.querySelector('.empty') && document.querySelector('.empty').textContent.indexOf('还没有记账模块') >= 0`, 5000, '空状态');
    ok('空状态展示正确');

    console.log('[2/13] 新建记账模块');
    await cdp.eval(`document.getElementById('fab').click()`);
    await cdp.waitFor(`!!document.querySelector('.sheet')`, 3000, '弹层打开');
    await cdp.eval(`
      document.querySelector('.sheet-body .input').value = '日常开销';
      [...document.querySelectorAll('.sheet-foot .btn')].find(b => b.textContent === '保存').click();
    `);
    await cdp.waitFor(`!!document.querySelector('.module-card')`, 5000, '模块创建');
    const modName = await cdp.eval(`document.querySelector('.mc-name').textContent`);
    modName === '日常开销' ? ok('模块已创建并展示名称') : fail('模块名称', modName);

    console.log('[3/13] 记两笔明细（校验排序与汇总）');
    const modId = await cdp.eval(`document.querySelector('.module-card').dataset.id`);
    await cdp.eval(`location.hash = '#/m/' + encodeURIComponent('${modId}')`);
    await cdp.waitFor(`document.querySelector('.summary') && document.getElementById('fab') && !document.getElementById('fab').hidden`, 5000, '明细页');
    ok('进入明细列表页（顶部汇总展示）');

    const fillRecord = async (cat, sub, name, amt, date, checkPaid) => {
      await cdp.eval(`document.getElementById('fab').click()`);
      await cdp.waitFor(`!!document.querySelector('.sheet')`, 3000, '记账弹层');
      await cdp.eval(`
        (function(){
          var ins = document.querySelectorAll('.sheet-body .input');
          ins[0].value = ${JSON.stringify(cat)};
          ins[1].value = ${JSON.stringify(sub)};
          ins[2].value = ${JSON.stringify(name)};
          ins[3].value = ${JSON.stringify(amt)};
          ins[4].value = ${JSON.stringify(date)};
          var cb = document.querySelector('.sheet-body input[type=checkbox]');
          cb.checked = ${checkPaid ? 'true' : 'false'};
          [...document.querySelectorAll('.sheet-foot .btn')].find(b => b.textContent === '保存').click();
        })()
      `);
      await cdp.waitFor(`!document.querySelector('.sheet')`, 5000, '弹层关闭');
    };

    await fillRecord('餐饮', '晚餐', '麻辣香锅', '12.34', '2024-05-03', true);
    await fillRecord('交通', '', '地铁', '5', '2024-05-01', false);
    await cdp.waitFor(`document.querySelectorAll('tr.item').length === 2`, 5000, '两笔记录');
    ok('两笔明细已保存');

    const order = await cdp.eval(`[...document.querySelectorAll('tr.group-row td')].map(td => td.textContent).join('|')`);
    order === '交通|餐饮 · 晚餐' ? ok('严格排序：大类「交通」先于「餐饮」，子类分组正确') : fail('排序结果', order);

    const sums = await cdp.eval(`[...document.querySelectorAll('.sum-card b')].map(b => b.textContent).join('|')`);
    const expectSum = (n) => (n ? '¥' + n : '');
    sums === '¥17.34|¥12.34|¥5.00'
      ? ok('汇总正确：总 17.34 / 已付 12.34 / 未付 5.00')
      : fail('汇总金额', sums);

    const cols = await cdp.eval(`[...document.querySelectorAll('thead th')].map(t => t.textContent).join(',')`);
    cols === '大类,子类,名称,金额,是否支付,日期'
      ? ok('六列齐全') : fail('表头列', cols);

    console.log('[4/13] 设置页与主题');
    await cdp.eval(`location.hash = '#/settings'`);
    await cdp.waitFor(`!!document.querySelector('.set-section')`, 5000, '设置页');
    await cdp.eval(`
      [...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '深色').click();
    `);
    await sleep(300);
    const theme = await cdp.eval(`document.documentElement.dataset.theme`);
    theme === 'dark' ? ok('主题切换为深色') : fail('主题', theme);

    console.log('[5/13] 刷新恢复（数据 + 状态）');
    await sleep(2500); // 等待防抖持久化落盘（设置 400ms + 同步 500ms + 导出）
    const probe = await cdp.eval(`(async function(){
      var before = Object.keys(localStorage);
      var stats0 = __ADB__.stats;
      await __ADB__.flush();
      var after = Object.keys(localStorage);
      return JSON.stringify({
        stats: stats0,
        before: before,
        after: after,
        dbIdx: (localStorage.getItem('adb.db.v1') || '').indexOf('U1FM'),
        theme: __ADB__.settings.theme,
        lastErr: __ADB__.lastError,
        toasts: __ADB__.toasts
      });
    })()`);
    console.log('  [probe] ' + probe);
    const lsOk = await cdp.eval(`(function(){ var r = localStorage.getItem('adb.db.v1'); return !!(r && r.indexOf('U1FM') > 0); })()`);
    lsOk ? ok('localStorage 数据镜像存在') : fail('localStorage 镜像缺失');
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await cdp.waitFor(`document.getElementById('app') && !document.getElementById('app').hidden`, 25000, '刷新启动');
    const restored = await cdp.eval(`(location.hash + '|' + document.documentElement.dataset.theme)`);
    restored === '#/settings|dark' ? ok('路由与主题状态已恢复') : fail('状态恢复', restored);

    console.log('[6/13] 刷新后数据完整性');
    await cdp.eval(`location.hash = '#/'`);
    await cdp.waitFor(`!!document.querySelector('.module-card')`, 5000, '模块列表恢复');
    const amount = await cdp.eval(`document.querySelector('.mc-amount').textContent`);
    amount === '¥17.34' ? ok('刷新后模块金额仍为 ¥17.34') : fail('模块金额', amount);
    await cdp.eval(`location.hash = '#/m/' + encodeURIComponent('${modId}')`);
    await cdp.waitFor(`document.querySelectorAll('tr.item').length === 2`, 5000, '明细恢复');
    ok('刷新后 2 条明细完整恢复');

    console.log('[7/13] 拖拽排序（Pointer 事件驱动 + 持久化）');
    await cdp.eval(`location.hash = '#/'`);
    await cdp.waitFor(`!!document.querySelector('.module-card')`, 5000, '模块页');
    await cdp.eval(`document.getElementById('fab').click()`);
    await cdp.waitFor(`!!document.querySelector('.sheet')`, 3000, '新建模块弹层');
    await cdp.eval(`
      document.querySelector('.sheet-body .input').value = '旅行基金';
      [...document.querySelectorAll('.sheet-foot .btn')].find(b => b.textContent === '保存').click();
    `);
    await cdp.waitFor(`document.querySelectorAll('.module-card').length === 2`, 5000, '两个模块');
    ok('第二个模块已创建');

    const pt = JSON.parse(await cdp.eval(`(function(){
      var cards = document.querySelectorAll('.module-card');
      var h0 = cards[0].querySelector('.drag-handle').getBoundingClientRect();
      var c1 = cards[1].getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(h0.x + h0.width / 2),
        y0: Math.round(h0.y + h0.height / 2),
        y1: Math.round(c1.y + c1.height / 2 + 8)
      });
    })()`));
    // 合成 PointerEvent 驱动应用自身的拖拽处理（按下第一个卡片手柄 → 移过第二张卡片中心 → 抬起）
    await cdp.eval(`(function(){
      var handle = document.querySelector('.module-card .drag-handle');
      var x = ${pt.x}, y0 = ${pt.y0}, y1 = ${pt.y1};
      function pe(type, cy, buttons) {
        handle.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: cy, pointerId: 7, pointerType: 'mouse',
          isPrimary: true, button: 0, buttons: buttons
        }));
      }
      pe('pointerdown', y0, 1);
      for (var i = 1; i <= 6; i++) pe('pointermove', Math.round(y0 + (y1 - y0) * i / 6), 1);
      pe('pointerup', y1, 0);
    })()`);
    await sleep(700);
    const names1 = await cdp.eval(`[...document.querySelectorAll('.mc-name')].map(n => n.textContent).join('|')`);
    names1 === '旅行基金|日常开销' ? ok('拖拽后顺序已交换') : fail('拖拽排序', names1);

    await cdp.send('Page.navigate', { url: PAGE_URL });
    await cdp.waitFor(`document.getElementById('app') && !document.getElementById('app').hidden`, 25000, '排序刷新');
    await cdp.eval(`location.hash = '#/'`);
    await cdp.waitFor(`document.querySelectorAll('.module-card').length === 2`, 5000, '排序恢复');
    const names2 = await cdp.eval(`[...document.querySelectorAll('.mc-name')].map(n => n.textContent).join('|')`);
    names2 === '旅行基金|日常开销' ? ok('新顺序已持久化（刷新不丢）') : fail('排序持久化', names2);

    console.log('[8/13] 数据写入 HTML 文件后从内嵌数据区恢复');
    const b64 = await cdp.eval(`(function(){
      var r = JSON.parse(localStorage.getItem('adb.db.v1') || 'null');
      if (!r) return '';
      localStorage.clear();               // 清掉本地镜像，强制走"内嵌数据区"路径
      document.getElementById('adb-data').textContent = r.b64;
      return r.b64;
    })()`);
    if (!b64 || b64.indexOf('U1FM') !== 0) fail('导出数据用于模拟写回', String(b64).slice(0, 20));
    const TMP = path.join(ROOT, '.e2e-data.html');
    const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const injected = rawHtml.replace(/(<script id="adb-data" type="text\/plain">)([\s\S]*?)(<\/script>)/,
      (m, a, b2, c) => a + b64 + c);
    fs.writeFileSync(TMP, injected, 'utf8');
    await cdp.send('Page.navigate', { url: 'file:///' + TMP.replace(/\\/g, '/') });
    await cdp.waitFor(`document.getElementById('app') && !document.getElementById('app').hidden`, 25000, 'HTML 数据区启动');
    await cdp.eval(`location.hash = '#/'`);
    await cdp.waitFor(`document.querySelectorAll('.module-card').length === 2`, 8000, '内嵌数据恢复');
    const emb = await cdp.eval(`[...document.querySelectorAll('.mc-name')].map(n => n.textContent).join('|') + '#' +
      [...document.querySelectorAll('.mc-amount')].map(n => n.textContent).join('|')`);
    emb === '旅行基金|日常开销#¥0.00|¥17.34'
      ? ok('从 HTML 内嵌数据区完整恢复（含顺序与金额）')
      : fail('内嵌恢复', emb);

    console.log('[9/13] 长按进入编辑 + 删除确认');
    await cdp.eval(`(function(){
      var card = document.querySelectorAll('.module-card')[0];
      function pe(type) {
        card.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: 40, clientY: card.getBoundingClientRect().top + 20,
          pointerId: 9, pointerType: 'touch', isPrimary: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1
        }));
      }
      pe('pointerdown');
      setTimeout(function () { pe('pointerup'); }, 560);
    })()`);
    await cdp.waitFor(
      `document.querySelector('.sheet') &&
       document.querySelector('.sheet-head h3').textContent === '编辑模块' &&
       location.hash === '#/'`,
      4000, '长按打开编辑弹层');
    ok('长按卡片进入编辑态（未误触详情页跳转）');
    await cdp.eval(`[...document.querySelectorAll('.sheet-foot .btn')].find(b => b.textContent === '删除').click()`);
    await cdp.waitFor(`!!document.querySelector('.modal')`, 3000, '删除确认框');
    await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '删除').click()`);
    await cdp.waitFor(`!document.querySelector('.sheet') && document.querySelectorAll('.module-card').length === 1`, 5000, '模块删除完成');
    const left = await cdp.eval(`[...document.querySelectorAll('.mc-name')].map(n => n.textContent).join('|')`);
    left === '日常开销' ? ok('确认后仅剩「日常开销」') : fail('删除结果', left);

    console.log('[10/13] 导出备份（下载内容校验）');
    await cdp.eval(`location.hash = '#/settings'`);
    await cdp.waitFor(`!!document.querySelector('.set-section')`, 5000, '设置页');
    await cdp.eval(`(function () {
      window.__exported = null; window.__dlName = '';
      var origCreate = URL.createObjectURL;
      URL.createObjectURL = function (b) { window.__exported = b; return origCreate.call(URL, b); };
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__dlName = this.download; return; }   // 截获下载，不真正落盘
        return origClick.apply(this, arguments);
      };
      [...document.querySelectorAll('.set-row .btn')].find(b => b.textContent === '导出').click();
    })()`);
    const dl = JSON.parse(await cdp.eval(`(async function () {
      for (var i = 0; i < 60 && !window.__exported; i++) await new Promise(r => setTimeout(r, 100));
      if (!window.__exported) return JSON.stringify({ err: 'no blob' });
      var u8 = new Uint8Array(await window.__exported.arrayBuffer());
      var head = '';
      for (var j = 0; j < 15; j++) head += String.fromCharCode(u8[j]);
      return JSON.stringify({ head: head, len: u8.length, name: window.__dlName });
    })()`));
    dl.head === 'SQLite format 3' && dl.len > 1000 && /\.adb$/.test(dl.name || '')
      ? ok(`导出为合法 SQLite 备份（${(dl.len / 1024).toFixed(1)} KB，${dl.name}）`)
      : fail('导出备份', JSON.stringify(dl));

    console.log('[11/13] 导入备份（UI 往返，升级更新不丢数据）');
    await cdp.eval(`[...document.querySelectorAll('.set-row .btn')].find(b => b.textContent === '导入').click()`);
    await cdp.waitFor(`!!document.querySelector('input[type=file]')`, 3000, '导入文件选择器创建');
    await cdp.eval(`(async function () {
      var input = document.querySelector('input[type=file]');
      var buf = await window.__exported.arrayBuffer();
      var dt = new DataTransfer();
      dt.items.add(new File([buf], 'backup.adb'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await cdp.waitFor(
      `document.querySelector('.modal-body p') && document.querySelector('.modal-body p').textContent.indexOf('覆盖') >= 0`,
      3000, '导入覆盖确认框');
    await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '导入并覆盖').click()`);
    await cdp.waitFor(`!document.querySelector('.modal') && location.hash === '#/'`, 5000, '导入完成回首页');
    await cdp.waitFor(`document.querySelectorAll('.module-card').length === 1`, 5000, '导入后模块恢复');
    const impAmt = await cdp.eval(`document.querySelector('.mc-amount').textContent`);
    impAmt === '¥17.34' ? ok('导入往返成功，数据完整（¥17.34）') : fail('导入结果', impAmt);

    console.log('[12/13] 清理数据（两步二次确认）');
    await cdp.eval(`location.hash = '#/settings'`);
    await cdp.waitFor(`!!document.querySelector('.set-section')`, 5000, '设置页');
    await cdp.eval(`[...document.querySelectorAll('.set-row .btn')].find(b => b.textContent === '清理').click()`);
    await cdp.waitFor(`!!document.querySelector('.modal')`, 3000, '第一步确认框');
    ok('第一步：风险提示确认框');
    await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '继续').click()`);
    await cdp.waitFor(`!!document.querySelector('.modal-body input')`, 3000, '第二步输入框');
    await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '清空数据').click()`);
    const blocked = await cdp.eval(`!!document.querySelector('.modal')`);
    blocked ? ok('未输入确认词时拒绝执行（可绕过 = 失败）') : fail('二次确认可被绕过');
    await cdp.eval(`
      document.querySelector('.modal-body input').value = '清空';
      [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '清空数据').click();
    `);
    await cdp.waitFor(`!document.querySelector('.modal') && location.hash === '#/' && !!document.querySelector('.empty')`, 5000, '清理完成');
    const emptied = await cdp.eval(`document.querySelector('.empty').textContent`);
    emptied.indexOf('还没有记账模块') >= 0
      ? ok('清理完成，回到空状态')
      : fail('清理结果', emptied);

    console.log('[13/13] 添加到桌面（应用名 / LOGO 图标 / PWA Manifest）');
    // ① file:// 环境不可直接安装 → 按钮应给出平台指引
    await cdp.eval(`location.hash = '#/settings'`);
    await cdp.waitFor(
      `[...document.querySelectorAll('.set-row .btn')].some(b => b.textContent === '添加' || b.textContent === '立即添加')`,
      5000, '添加到桌面按钮');
    const ist = await cdp.eval(`__ADB__.install.state`);
    ist === 'manual' ? ok('file:// 下安装状态 = manual（降级为指引）') : fail('安装状态', ist);
    await cdp.eval(`document.getElementById('install-btn').click()`);
    await cdp.waitFor(`document.querySelector('.modal-body h3') && document.querySelector('.modal-body h3').textContent === '添加到桌面'`, 3000, '指引弹层');
    const helpText = await cdp.eval(`document.querySelector('.modal-body p').textContent`);
    helpText.indexOf('个人记账') >= 0 ? ok('指引文案包含应用名「个人记账」') : fail('指引文案', helpText.slice(0, 60));
    await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '知道了').click()`);
    await cdp.waitFor(`!document.querySelector('.modal')`, 3000, '关闭指引');

    // ② http 环境（真实可安装条件）：校验动态 Manifest 的名称 / 图标 / 主题
    httpServer = await startServer(HTTP_PORT);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
    await cdp.waitFor(`document.getElementById('app') && !document.getElementById('app').hidden`, 25000, 'http 启动');
    await sleep(900);  // 等待动态 Manifest 注入稳定
    let manRes = {};
    try { manRes = await cdp.send('Page.getAppManifest'); } catch (e) { manRes = { error: e.message }; }
    let manData = null;
    try { manData = manRes && manRes.data ? JSON.parse(manRes.data) : null; } catch (e) { manData = null; }
    if (!manData) {
      manData = JSON.parse(await cdp.eval(`fetch(document.getElementById('manifest-link').href).then(r => r.text())`));
    }
    const manErrs = (manRes && manRes.errors) || [];
    manErrs.length === 0
      ? ok('浏览器加载 Manifest 无错误')
      : fail('Manifest 加载错误', JSON.stringify(manErrs).slice(0, 220));
    manData.name === '个人记账' && manData.short_name === '个人记账'
      ? ok('Manifest 应用名 = 个人记账')
      : fail('Manifest name', String(manData.name));
    manData.display === 'standalone' &&
      Array.isArray(manData.icons) && manData.icons.length >= 3 &&
      manData.icons.every(i => /^data:image\/png/.test(i.src)) &&
      manData.icons.some(i => i.sizes === '192x192') &&
      manData.icons.some(i => i.sizes === '512x512')
      ? ok('Manifest 图标为 LOGO 栅格化 PNG（192 / 512 / maskable）')
      : fail('Manifest icons', JSON.stringify(manData.icons || []).slice(0, 160));
    typeof manData.theme_color === 'string' && typeof manData.background_color === 'string'
      ? ok(`主题色已同步（theme ${manData.theme_color}）`)
      : fail('Manifest 主题色', JSON.stringify({ t: manData.theme_color, b: manData.background_color }));
    const appleHref = await cdp.eval(`document.getElementById('apple-touch-icon').href`);
    appleHref.indexOf('data:image/png') === 0
      ? ok('apple-touch-icon 已指向 LOGO PNG')
      : fail('apple-touch-icon', String(appleHref).slice(0, 50));
    const t13 = await cdp.eval(`document.title`);
    t13.indexOf('个人记账') >= 0 ? ok('页面标题为「个人记账」') : fail('页面标题', t13);
    let instErrs = [];
    try { instErrs = ((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors) || []; }
    catch (e) { /* 老版本无此 API 时跳过 */ }
    const badInst = instErrs.filter(e => /manifest|icon|name|start/i.test(e.errorType || ''));
    if (badInst.length === 0) {
      ok('安装可检测性：manifest/图标/名称/start_url 无缺失');
    } else {
      fail('安装可检测性', JSON.stringify(badInst).slice(0, 220));
    }
    if (instErrs.length) console.log('  [installability] ' + instErrs.map(e => e.errorType).join(', '));
    console.log('  [install] beforeinstallprompt 状态: ' + await cdp.eval(`__ADB__.install.state`));

    const errs = cdp.consoleErrors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND|navigator\.vibrate/.test(e));
    errs.length === 0 ? ok('无控制台错误') : fail('控制台错误', errs.slice(0, 3).join(' / '));
  } catch (e) {
    if (failed === 0 || !String(e).includes('超时')) fail('流程中断', e.message);
    if (cdp && cdp.consoleErrors.length) console.error('  [console] ' + cdp.consoleErrors.slice(0, 5).join('\n  [console] '));
  } finally {
    if (cdp) cdp.close();
    if (httpServer) { try { httpServer.close(); } catch (e) { /* ignore */ } }
    try { child.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(path.join(ROOT, '.e2e-data.html'), { force: true }); } catch (e) { /* ignore */ }
    for (let i = 0; i < 25; i++) {
      try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); break; }
      catch (e) { await sleep(200); }
    }
  }

  console.log(failed === 0 ? '\nE2E 全部通过 ✔' : `\nE2E ${failed} 项失败 ✘`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });