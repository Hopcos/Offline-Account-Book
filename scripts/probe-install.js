#!/usr/bin/env node
/**
 * probe-install.js —— 对已部署地址做"可安装性"体检（无头 Edge + CDP 浏览器级接口）
 *
 * 用法：node scripts/probe-install.js https://tools.itech.run/temp/index.html
 *
 * 输出：
 *   1) Page.getAppManifest        浏览器实际解析到的 Manifest（名称/图标/错误）
 *   2) Page.getInstallabilityErrors  Chrome 安装判据逐条错误
 *   3) 页面环境（安全上下文/协议/标题/manifest link/自检状态）
 *   4) 服务器响应头（Content-Type / CSP 等，排查托管端干扰）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 9399;
const TARGET = process.argv[2];
if (!TARGET || !/^https?:\/\//.test(TARGET)) {
  console.error('用法：node scripts/probe-install.js <部署地址>');
  process.exit(1);
}

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

function httpGetJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0) 服务器响应头（看托管端有没有加 CSP / 奇怪 content-type）
  try {
    const head = await fetch(TARGET, { method: 'GET', signal: AbortSignal.timeout(15000) });
    console.log('== 响应头 ==');
    console.log('  status:', head.status, head.headers.get('content-type'));
    for (const k of ['content-security-policy', 'content-security-policy-report-only', 'cross-origin-opener-policy', 'x-content-type-options']) {
      const v = head.headers.get(k);
      if (v) console.log(`  ${k}: ${v}`);
    }
    const body = await head.text();
    console.log('  字节数:', body.length, '含manifest-link:', body.includes('id="manifest-link"'),
      '含动态Manifest逻辑:', body.includes('updatePwaMeta'));
  } catch (e) { console.log('响应头获取失败:', e.message); }

  const edge = findEdge();
  if (!edge) { console.error('未找到 Edge/Chrome'); process.exit(1); }
  const profile = path.join(os.tmpdir(), 'adb-probe-profile');
  const child = spawn(edge, [
    `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-allow-origins=*', `--remote-debugging-port=${PORT}`, 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try {
        const list = await httpGetJson('/json/list');
        target = list.find((t) => t.type === 'page');
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('CDP 未就绪');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: TARGET });

    // 1) 等应用启动（动态 Manifest 在启动时注入）
    let ready = false;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      const r = await send('Runtime.evaluate', {
        expression: '!!(window.__ADB__ && window.__ADB__.state && window.__ADB__.stats)',
        returnByValue: true
      });
      if (r.result && r.result.value) { ready = true; break; }
    }
    console.log('\n== 页面启动 ==', ready ? '成功 ✔（再等 4 秒让 Manifest 注入稳定）' : '失败 ✘');
    await sleep(4000);

    const env = JSON.parse(await send('Runtime.evaluate', {
      expression: `(function(){
        var link = document.getElementById('manifest-link');
        var st = window.__ADB__ ? JSON.stringify(window.__ADB__.install) : '{}';
        return JSON.stringify({
          protocol: location.protocol, hostname: location.hostname,
          secure: window.isSecureContext,
          title: document.title,
          manifestHref: link && link.href ? link.href.slice(0, 40) : '',
          install: JSON.parse(st)
        });
      })()`,
      returnByValue: true
    }).then((r) => r.result.value));
    console.log('  protocol:', env.protocol, '| hostname:', env.hostname, '| isSecureContext:', env.secure);
    console.log('  title:', env.title);
    console.log('  manifest-link:', env.manifestHref);
    console.log('  __ADB__.install:', JSON.stringify(env.install, null, 2));

    // 2) 浏览器解析到的 Manifest
    try {
      const man = await send('Page.getAppManifest');
      console.log('\n== Page.getAppManifest ==');
      console.log('  url:', (man.url || '').slice(0, 60));
      console.log('  errors:', JSON.stringify(man.errors || [], null, 2));
      if (man.data) {
        try {
          const d = JSON.parse(man.data);
          console.log('  name:', d.name, '| display:', d.display, '| start_url:', d.start_url);
          console.log('  icons:', (d.icons || []).map((i) => i.sizes + '/' + i.purpose + '/' + String(i.src).slice(0, 24)).join(' | '));
        } catch (e) { console.log('  data 解析失败:', e.message); }
      } else {
        console.log('  data: (无 —— 浏览器没有成功解析 Manifest)');
      }
    } catch (e) { console.log('\n== Page.getAppManifest 调用失败 ==', e.message); }

    // 3) 安装判据逐条错误
    try {
      const inst = await send('Page.getInstallabilityErrors');
      console.log('\n== Page.getInstallabilityErrors ==');
      console.log(' ', JSON.stringify(inst.installabilityErrors || [], null, 2));
    } catch (e) { console.log('\n== getInstallabilityErrors 调用失败 ==', e.message); }

    // 4) Manifest 内容能否真正抓到（blob 是否可用）
    const fetched = await send('Runtime.evaluate', {
      expression: `fetch(document.getElementById('manifest-link').href)
        .then(r => r.text()).then(t => 'OK ' + t.slice(0, 80)).catch(e => 'FAIL ' + e.message)`,
      awaitPromise: true, returnByValue: true
    });
    console.log('\n== 页内抓取 Manifest ==', fetched.result.value);
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8 }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
