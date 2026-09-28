#!/usr/bin/env node
/**
 * lan-serve.js —— 局域网静态服务器（HTTPS / HTTP 两种模式）
 *
 * 背景：浏览器只允许"安全地址"（HTTPS 或 localhost）使用 PWA 安装接口
 * beforeinstallprompt。手机用 http://192.168.x.x 访问是装不上桌面的。
 *
 * 两种用法：
 *   node scripts/lan-serve.js          局域网 HTTPS：手机同 WiFi 直接打开 https://<电脑IP>:8443
 *                                      （证书用系统已安装的 mkcert 自动签发，详见输出）
 *   node scripts/lan-serve.js --http   局域网 HTTP：配合安卓数据线 `adb reverse` 后，
 *                                      手机访问 http://localhost:<端口>（localhost 即安全地址）
 *
 * 也可用 npm run lan / npm run serve。零 npm 依赖。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CERT_DIR = path.join(ROOT, '.cert');
const HTTP_MODE = process.argv.includes('--http');
const pIdx = process.argv.indexOf('--port');
const PORT = pIdx > -1 && process.argv[pIdx + 1] ? Number(process.argv[pIdx + 1]) : (HTTP_MODE ? 8000 : 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.adb': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

function handler(req, res) {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { p = '/'; }
  if (p === '/' || p === '\\') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/** mkcert 是否可用 */
function mkcertAvailable() {
  const r = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8', windowsHide: true });
  return !r.error && r.status === 0 && (r.stdout || '').trim();
}

function runMkcert(args) {
  return spawnSync('mkcert', args, { stdio: 'inherit', windowsHide: true });
}

function ensureCerts(ips) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const cert = path.join(CERT_DIR, 'lan.pem');
  const key = path.join(CERT_DIR, 'lan-key.pem');
  const roots = path.join(CERT_DIR, 'rootCA.pem');   // 发给手机信任的根证书

  if (fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(roots)) {
    return { cert, key, roots, reused: true };
  }
  if (runMkcert(['-install']).status !== 0) return null;
  const car = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8', windowsHide: true });
  const rootSrc = path.join((car.stdout || '').trim(), 'rootCA.pem');
  try { fs.copyFileSync(rootSrc, roots); } catch (e) { console.warn('[lan] 根证书导出失败：', e.message); }
  const names = [...new Set([...ips, 'localhost', '127.0.0.1', '::1'])];
  if (runMkcert(['-cert-file', cert, '-key-file', key, ...names]).status !== 0) return null;
  return { cert, key, roots, reused: false };
}

function banner(ips, mode, extraLines) {
  console.log('');
  console.log('  个人记账 · 局域网 ' + mode + ' 服务器已启动（手机需与电脑连同一 WiFi / 网络）');
  console.log('  ----------------------------------------------------------------');
  for (const ip of ips) console.log(`   ${mode === 'HTTPS' ? 'https' : 'http'}://${ip}:${PORT}/index.html`);
  if (!ips.length) console.log(`   （未检测到局域网 IPv4 地址，可用本机 http://localhost:${PORT}/index.html）`);
  console.log('  ----------------------------------------------------------------');
  for (const l of extraLines) console.log('  ' + l);
  console.log('');
  console.log('  打开页面后：设置 → 添加到桌面 → 立即添加（直接弹系统安装框，无需浏览器菜单）');
  console.log('  提示：Chrome 有"用户互动"门槛——首次请让页面停留约 30 秒再点添加。');
  console.log('  提示：Windows 首次监听可能弹出防火墙授权，请允许（仅局域网可访问）。');
  console.log('');
}

function main() {
  const ips = lanIPs();

  if (HTTP_MODE) {
    http.createServer(handler).listen(PORT, '0.0.0.0', () => {
      banner(ips, 'HTTP', [
        'HTTP 地址不满足安装条件；安卓手机可用数据线执行：',
        `   adb reverse tcp:${PORT} tcp:${PORT}`,
        `然后手机浏览器打开  http://localhost:${PORT}/index.html  （localhost 视为安全地址，可一键安装）`
      ]);
    });
    return;
  }

  if (!mkcertAvailable()) {
    console.error('[lan] 未找到 mkcert（HTTPS 证书签发工具）。安装其一后重试：');
    console.error('   winget install FiloSottile.mkcert');
    console.error('   或  choco install mkcert   /   scoop bucket add extras; scoop install mkcert');
    console.error('');
    console.error('替代方案：');
    console.error('   1) 免费一键发布：在仓库目录执行  npx surge ./   （按提示填邮箱，几十秒得到 https 地址）');
    console.error('   2) 安卓 + 数据线：npm run serve 后执行  adb reverse tcp:8000 tcp:8000，');
    console.error('      手机打开 http://localhost:8000/index.html 同样满足安装条件');
    process.exit(1);
  }

  const c = ensureCerts(ips);
  if (!c) { console.error('[lan] mkcert 签证书失败，请查看上方输出（或删除 .cert 目录后重试）'); process.exit(1); }

  https.createServer({ cert: fs.readFileSync(c.cert), key: fs.readFileSync(c.key) }, handler)
    .listen(PORT, '0.0.0.0', () => {
      banner(ips, 'HTTPS（mkcert 本地受信任证书）', [
        c.reused ? `证书已存在，复用：${path.relative(ROOT, c.cert)}` : `证书已签发：${path.relative(ROOT, c.cert)}`,
        `手机若弹证书警告：把根证书  ${path.relative(ROOT, c.roots)}  传到手机安装信任：`,
        '   Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书',
        '   iOS：装描述文件后 → 通用 → 关于本机 → 证书信任设置 → 开启完全信任',
        '   （嫌麻烦也可直接在警告页点「继续访问」，多数浏览器随后仍按 HTTPS 安全地址处理）',
        `若换了 IP 或证书过期：删除 .cert 目录重新运行 npm run lan`
      ]);
    });
}

main();
