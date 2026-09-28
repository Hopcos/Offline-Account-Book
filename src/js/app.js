/* ==========================================================================
 * 离线记账本 · 主程序
 * --------------------------------------------------------------------------
 * 架构：
 *   Worker(数据仓库, SQLite/WASM) ←RPC→ 主程序(Store + Router + Views)
 * 设计模式：
 *   - 观察者：Store 状态变更通知（路由重渲染）
 *   - 仓库模式：DbClient 封装全部数据访问
 *   - MVC-lite：View 只读 Store，命令经 DbClient 回写
 *   - 单例：DbClient / PersistService
 * ========================================================================== */
(function () {
  'use strict';

  /* ================= 0. 常量 ================= */
  const UI_CACHE_KEY = 'adb.ui.v1';     // 外观/路由/滚动 快照（首屏与刷新恢复）
  const DB_CACHE_KEY = 'adb.db.v1';     // 数据库镜像（localStorage，刷新恢复）
  const HANDLE_KEY = 'html-handle';     // FileSystemFileHandle（IndexedDB）
  const VERSION = '1.0.0';
  const PAGE_LOADED_AT = Date.now();    // 用于 Chrome"用户互动门槛"（约 30 秒）自检
  const APP_NAME = '个人记账';          // “添加到桌面”后的应用名称（Manifest / meta 保持一致）

  /** HTML 数据区正则（注意："<\/script" 写法避免内联脚本被提前闭合） */
  const HTML_DATA_RE = /(<script id="adb-data" type="text\/plain">)([\s\S]*?)(<\/script>)/;
  const SAVED_AT_RE = /<meta name="adb-saved-at" content="([^"]*)"/;
  const SQLITE_B64_PREFIX = 'U1FM';    // base64("SQLite format 3\0") 前缀，用于快速校验镜像完整性

  const DEFAULT_SETTINGS = {
    theme: 'auto', fontSize: 16, lineHeight: 1.6,
    font: 'system', pageWidth: 'normal', currency: '¥'
  };

  const DEFAULT_LOGO_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect width="48" height="48" rx="11" fill="#059669"/>' +
    '<path d="M24 15.5c-3-2.4-7-3.4-11-3v19c4-.4 8 .6 11 3 3-2.4 7-3.4 11-3v-19c-4-.4-8 .6-11 3z" fill="#fff" opacity=".95"/>' +
    '<path d="M24 15.5v19" stroke="#059669" stroke-width="1.6"/>' +
    '<path d="M17.5 19.5h4M17.5 23.5h4M26.5 19.5h4M26.5 23.5h4" stroke="#059669" stroke-width="1.4" stroke-linecap="round"/></svg>';

  /* ================= 1. DOM 工具 ================= */
  const $ = (sel, root) => (root || document).querySelector(sel);

  /** 声明式 DOM 构造器（全部走 textContent，天然防注入） */
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'value') node.value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    const append = (kid) => {
      if (kid === null || kid === undefined || kid === false || kid === '') return;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach((k) => Array.isArray(k) ? k.forEach(append) : append(k));
    return node;
  }

  function svg(markup) {
    const wrap = document.createElement('div');
    wrap.innerHTML = markup;
    return wrap.firstElementChild;
  }

  const ICON_BACK = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 12 20" width="14" height="20" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="4" r="1.6"/><circle cx="9" cy="4" r="1.6"/><circle cx="3" cy="10" r="1.6"/><circle cx="9" cy="10" r="1.6"/><circle cx="3" cy="16" r="1.6"/><circle cx="9" cy="16" r="1.6"/></g></svg>';
  const ICON_EMPTY = '<svg viewBox="0 0 24 24" width="52" height="52"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 10h6M7 14h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  /* ================= 2. 通用格式化 ================= */
  const pad2 = (n) => String(n).padStart(2, '0');

  function todayStr(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtModified(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmt(cents) {
    const cur = (state.settings && state.settings.currency) || '¥';
    const neg = cents < 0;
    const v = Math.abs(Number(cents) || 0) / 100;
    const s = v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + cur + s;
  }

  /* ================= 3. Base64 工具 ================= */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return btoa(s);
  }

  /* ================= 4. Store（状态 + 快照缓存） ================= */
  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    logo: '',
    modules: [],
    lastRoute: '',
    route: { name: 'modules', id: '' },
    prevRoute: { name: 'modules', id: '' },
    fileHandle: null,
    needPermission: false,
    fsSupported: typeof window.showOpenFilePicker === 'function'
  };

  function uiCacheRead() {
    try { return JSON.parse(localStorage.getItem(UI_CACHE_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function uiCacheWrite(patch) {
    const next = Object.assign(uiCacheRead(), patch);
    try { localStorage.setItem(UI_CACHE_KEY, JSON.stringify(next)); }
    catch (e) { console.warn('[cache]', e); }
    return next;
  }

  function lsRead() {
    try {
      const raw = localStorage.getItem(DB_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function lsSave(b64, savedAt) {
    try {
      localStorage.setItem(DB_CACHE_KEY, JSON.stringify({ b64, savedAt: savedAt || new Date().toISOString() }));
      return true;
    } catch (e) {
      lastError = 'lsSave: ' + (e && e.message);
      console.warn('[lsSave] 容量不足', e);
      return false;
    }
  }

  /** 把设置应用到 <html> 上（主题 / 字体 / 字号 / 行距 / 页宽 / 货币） */
  function applySettings(s) {
    const root = document.documentElement;
    let theme = s.theme || 'auto';
    if (theme === 'auto') {
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    root.dataset.theme = theme;
    root.dataset.font = s.font || 'system';
    root.dataset.width = s.pageWidth || 'normal';
    root.style.setProperty('--fs', (s.fontSize || 16) + 'px');
    root.style.setProperty('--lh', String(s.lineHeight || 1.6));
    root.style.setProperty('--currency', String(s.currency || '¥'));
    root.style.colorScheme = theme;
    root.dataset.hasLogo = state.logo ? '1' : '0';
    schedulePwaMeta();   // 主题/字号等外观变化 → 刷新 Manifest 中的主题色
  }

  function applyState(st) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS, st.settings || {});
    state.logo = st.logo || '';
    state.modules = st.modules || [];
    state.lastRoute = st.lastRoute || '';
    applySettings(state.settings);
    uiCacheWrite({ settings: state.settings, logo: state.logo });
  }

  /* ================= 4.5 PWA：动态 Manifest 与“添加到桌面” ================= */
  let deferredInstall = null;   // beforeinstallprompt 暂存的安装句柄
  let manifestBlobUrl = '';     // 当前 Manifest 的 blob URL（重建前回收）
  let manifestJson = '';        // 上次生成的 Manifest JSON（内容去重）
  let pwaTimer = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();         // 接管安装提示，改由设置页按钮触发
    deferredInstall = e;
    if (state.route && state.route.name === 'settings') render();
    if (!isInstalled()) toast('系统安装程序已就绪，点击「添加到桌面」即可');
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    toast('已添加到桌面');
    if (state.route && state.route.name === 'settings') render();
  });

  function isInstalled() {
    try {
      if (navigator.standalone) return true;                                   // iOS Safari
      if (window.matchMedia('(display-mode: standalone)').matches) return true; // 安装后打开
      if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function installState() {
    return isInstalled() ? 'installed' : (deferredInstall ? 'ready' : 'manual');
  }

  /** 将当前 LOGO（自定义图片或默认 SVG）栅格化为 PWA 图标（PNG dataURL） */
  function logoToIcon(size) {
    return new Promise((resolve) => {
      const fallback = () => resolve('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEFAULT_LOGO_SVG));
      const src = state.logo || ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEFAULT_LOGO_SVG));
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = size; cv.height = size;
          const ctx = cv.getContext('2d');
          const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#059669';
          ctx.fillStyle = accent;                 // maskable 图标要求安全边距底色
          ctx.fillRect(0, 0, size, size);
          const pad = Math.round(size * 0.09);
          const scale = Math.min((size - pad * 2) / img.width, (size - pad * 2) / img.height);
          const w = Math.round(img.width * scale);
          const hh = Math.round(img.height * scale);
          ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - hh) / 2), w, hh);
          resolve(cv.toDataURL('image/png'));
        } catch (e) { fallback(); }
      };
      img.onerror = fallback;
      img.src = src;
    });
  }

  /** 按当前 LOGO 与主题生成 Web App Manifest（决定桌面应用的名称/图标/启动方式） */
  async function updatePwaMeta() {
    const icon192 = await logoToIcon(192);
    const icon512 = await logoToIcon(512);
    const cs = getComputedStyle(document.documentElement);
    const bg = (cs.getPropertyValue('--bg') || '').trim() || '#ffffff';
    const manifest = {
      name: APP_NAME,
      short_name: APP_NAME,
      lang: 'zh-CN',
      description: '个人离线记账本（SQLite · WebAssembly）',
      start_url: location.href.split('#')[0] + '#/',
      display: 'standalone',
      background_color: bg,
      theme_color: bg,
      icons: [
        { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    };
    const json = JSON.stringify(manifest);
    if (json === manifestJson) return;            // 内容未变则不重建（避免无谓的重新抓取）
    manifestJson = json;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/manifest+json' }));
    if (manifestBlobUrl) URL.revokeObjectURL(manifestBlobUrl);
    manifestBlobUrl = url;
    const link = document.getElementById('manifest-link');
    if (link) link.href = url;
    const apple = document.getElementById('apple-touch-icon');
    if (apple) apple.href = icon192;
    const fav = document.getElementById('favicon-link');
    if (fav) fav.href = icon192;
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', bg);
  }

  function schedulePwaMeta() {
    if (pwaTimer) clearTimeout(pwaTimer);
    pwaTimer = setTimeout(() => { pwaTimer = null; updatePwaMeta().catch((e) => console.warn('[pwa]', e)); }, 300);
  }

  /** 等待系统安装事件：部分浏览器在页面加载后较晚才派发 beforeinstallprompt */
  function waitForInstallPrompt(ms) {
    if (deferredInstall) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => finish(false), ms);
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      };
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstall = e;
        finish(true);
      }, { once: true });
    });
  }

  /**
   * 「添加到桌面」点击：全程不经过任何浏览器菜单 ——
   * 可安装 → 等待/捕获系统安装事件后直接 prompt()（系统级安装框一步到桌面）；
   * 不可安装 → 弹出能力自检，指出卡住的具体环节。
   */
  async function onInstallClick() {
    if (isInstalled()) { toast('已在桌面'); return; }
    if (!deferredInstall) {
      toast('正在检测系统安装能力…');
      await waitForInstallPrompt(2500);            // 兜底等待迟到的系统事件
    }
    if (deferredInstall) {
      const promptEvent = deferredInstall;
      deferredInstall = null;
      try {
        promptEvent.prompt();                       // 直接调起系统安装确认框
        const choice = await promptEvent.userChoice;
        if (choice && choice.outcome === 'accepted') toast('正在添加到桌面…');
      } catch (e) {
        console.warn('[install]', e);
        openInstallGuide();
        return;
      }
      if (state.route && state.route.name === 'settings') render();
      return;
    }
    openInstallGuide();
  }

  /** 实时能力自检：逐条说明为什么能/不能"一键直接装到桌面" */
  function installChecks() {
    const host = location.hostname;
    const secureOk = location.protocol === 'https:' ||
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const apiOk = 'onbeforeinstallprompt' in window;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return [
      {
        ok: secureOk,
        okText: '页面地址满足安装条件（HTTPS / localhost）',
        badText: location.protocol === 'file:'
          ? '以本地文件（file://）方式打开 —— 系统禁止在此模式下安装'
          : '页面不是 HTTPS —— 系统安装接口仅在安全地址开放'
      },
      {
        ok: apiOk,
        okText: '浏览器提供「直接安装」标准接口（beforeinstallprompt）',
        badText: ios
          ? 'iOS 系统不向网页开放任何直接安装接口（仅可手动：Safari 分享 → 添加到主屏幕）'
          : '该浏览器未向网页开放直接安装接口（换用 Chrome / Edge / Samsung 等即可一键直装）'
      },
      {
        ok: !!deferredInstall,
        okText: '系统安装程序已就绪（点击后直接弹出系统安装框）',
        badText: '系统安装程序未就绪（受地址、浏览器或安装条件限制）'
      },
      {
        ok: !!manifestJson,
        okText: '应用描述已生成：名称「' + APP_NAME + '」+ 设置页 LOGO 图标',
        badText: '应用描述（Manifest）尚未生成'
      },
      {
        ok: Date.now() - PAGE_LOADED_AT >= 28000,
        okText: '页面已打开约 ' + Math.round((Date.now() - PAGE_LOADED_AT) / 1000) + ' 秒（满足 Chrome 互动门槛）',
        badText: '页面仅打开了 ' + Math.max(1, Math.round((Date.now() - PAGE_LOADED_AT) / 1000)) +
          ' 秒 —— Chrome 需约 30 秒使用时长后才派发安装事件，请留在本页稍候再点「添加」'
      }
    ];
  }

  function openInstallGuide() {
    const checks = installChecks();
    const allOk = checks.every((c) => c.ok);
    const ua = navigator.userAgent;
    let conclusion;
    if (allOk) {
      conclusion = '环境已就绪：请再点一次「立即添加」，将直接弹出系统安装确认框（无需任何浏览器菜单），完成后桌面出现「' +
        APP_NAME + '」与你设置的 LOGO。若页面是刚打开的，Chrome 可能要求先停留约 30 秒（用户互动门槛），稍等再点即可。';
    } else if (/iPhone|iPad|iPod/.test(ua)) {
      conclusion = 'iOS 不向网页开放直接安装接口（系统限制，非本应用问题）。Safari：「分享」→「添加到主屏幕」；桌面名称与 LOGO 仍由本应用配置决定。';
    } else if (location.protocol === 'file:') {
      conclusion = '本地文件方式无法安装。电脑上用 npm run serve（或 npx serve .）以 localhost 打开即可一键直装；若要装到手机桌面，见设置页下方"手机安装路线"或 README。应用名「' +
        APP_NAME + '」，图标为设置页的 LOGO。';
    } else if (!checks[0].ok) {
      conclusion = '只差一个"安全地址"（HTTPS/localhost 是浏览器硬性门槛，任何网页都绕不过）。电脑上任选一条路线，之后手机重新打开本页再点本按钮，即可一步装到桌面：' +
        '① npx surge ./ 一键发布到免费 HTTPS（最简单）；' +
        '② 本仓库运行 npm run lan，手机访问 https://电脑IP:8443（需信任一次根证书 .cert/rootCA.pem）；' +
        '③ 安卓手机+数据线：npm run serve 后执行 adb reverse tcp:8000 tcp:8000，手机打开 http://localhost:8000。';
    } else if (checks[0].ok && checks[1].ok && checks[3].ok && !checks[2].ok && checks[4].ok) {
      conclusion = '地址、浏览器接口、应用描述、使用时长均已满足，但系统安装事件仍未派发。按可能性排查：' +
        '① 国行手机缺少 Google 服务（GMS）—— 安卓的网页直装（WebAPK）依赖 Google Play，无 GMS 时 Chrome 不会派发安装事件。此时请改用浏览器菜单「添加到主屏幕 / 安装应用」：本页已把图标与名称（「' +
        APP_NAME + '」+ 你的 LOGO）配置好，菜单添加的效果等同桌面入口；' +
        '② 当前浏览器内核不支持安装事件：换用 Chrome / Edge / Samsung Internet 重新打开本页再点添加；' +
        '③ 个别版本 Chrome 要求页面被访问过两次：完全关闭本页重新打开一次，再试。';
    } else {
      conclusion = '当前浏览器未向网页开放「直接安装」接口 —— 任何网页都无法绕过系统安全限制直接写入桌面图标，只能换用支持标准安装接口的浏览器（Chrome / Edge / Samsung Internet 等）；届时本按钮将一键直装，全程无需浏览器菜单。';
    }
    openModal({
      title: '添加到桌面',
      confirmText: '知道了',
      hideCancel: true,
      extra: h('div', { class: 'install-guide' },
        h('div', { class: 'install-checks' },
          checks.map((c) => h('div', { class: 'install-check ' + (c.ok ? 'ok' : 'bad') },
            h('span', { class: 'ico', text: c.ok ? '✓' : '!' }),
            h('span', { text: c.ok ? c.okText : c.badText })))),
        h('p', { text: conclusion }))
    });
  }

  // 跟随系统主题时监听系统变化
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSysTheme = () => { if (state.settings.theme === 'auto') applySettings(state.settings); };
    mq.addEventListener ? mq.addEventListener('change', onSysTheme) : mq.addListener(onSysTheme);
  }

  /* ================= 5. DbClient（Worker RPC 仓库，单例） ================= */
  class DbClient {
    constructor() {
      this.worker = null;
      this.seq = 0;
      this.pending = new Map();
      this.ready = false;
      this.queue = [];
    }

    start(dbB64) {
      const src = document.getElementById('adb-worker').textContent;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => {
        lastError = 'worker: ' + (e.message || '未知错误');
        console.error('[worker]', lastError);
        bootFail('数据线程启动失败：' + (e.message || '未知错误'));
      };
      this.worker.onmessageerror = () => { lastError = 'worker messageerror'; };
      const glue = document.getElementById('adb-sqljs').textContent;
      const wasmB64 = document.getElementById('adb-wasm').textContent.trim();
      this.worker.postMessage({ type: 'init', glue, wasmB64, dbB64: dbB64 || '' });
    }

    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        const msg = { type: 'call', id, method, params: params || {} };
        if (this.ready) this.worker.postMessage(msg);
        else this.queue.push(msg);
      });
    }

    _onMessage(msg) {
      if (msg.type === 'ready') {
        this.ready = true;
        this.queue.forEach((m) => this.worker.postMessage(m));
        this.queue = [];
        return;
      }
      if (msg.type === 'fatal') { bootFail('数据引擎初始化失败：' + msg.error); return; }
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || '未知错误'));
      }
    }
  }

  const db = new DbClient();

  /* 诊断探针（供自动化测试/高级用户检查内部状态） */
  let lastError = '';
  const toastLog = [];
  let flushCount = 0, lsCount = 0, schedCount = 0;
  window.__ADB__ = {
    get ready() { return db.ready; },
    get pending() { return db.pending.size; },
    get settings() { return state.settings; },
    get lastError() { return lastError; },
    get toasts() { return toastLog.slice(-5); },
    get stats() { return { flushCount, lsCount, schedCount }; },
    get install() { return { state: installState(), name: APP_NAME, checks: installChecks() }; },
    flush: () => flushPersist()
  };

  /* ================= 6. 持久化服务（localStorage 镜像 + 写回 HTML） ================= */
  let persistTimer = null;
  let persisting = false;
  let persistDirty = false;
  let settingsSaveTimer = null;

  function schedulePersist() {
    schedCount++;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { persistTimer = null; flushPersist(); }, 500);
  }

  async function flushPersist() {
    if (persisting) { persistDirty = true; return; }
    persisting = true;
    flushCount++;
    try {
      const ret = await db.call('exportB64');
      const now = new Date().toISOString();
      if (lsSave(ret.b64, now)) lsCount++;                   // 1) 镜像到 localStorage（刷新必恢复）
      uiCacheWrite({ settings: state.settings, logo: state.logo, savedAt: now });
      if (state.fileHandle && !state.needPermission) {
        const ok = await writeToHtml(ret.b64);                 // 2) 写回 HTML 文件（数据真正"存进 HTML"）
        if (ok) console.info('[sync] 已写回 HTML 数据区');
      }
    } catch (e) {
      lastError = 'persist: ' + (e && e.message);
      console.warn('[persist]', e);
      toast('保存失败：' + (e.message || e), 'err');
    } finally {
      persisting = false;
      if (persistDirty) { persistDirty = false; schedulePersist(); }
    }
  }

  /** 设置变更（节流）：写入 DB meta + 触发持久化 */
  function persistSettings() {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(async () => {
      settingsSaveTimer = null;
      try {
        await db.call('setMeta', { key: 'settings', value: JSON.stringify(state.settings) });
      } catch (e) { console.warn(e); }
      uiCacheWrite({ settings: state.settings });
      schedulePersist();
    }, 400);
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    applySettings(state.settings);
    uiCacheWrite({ settings: state.settings });
    persistSettings();
  }

  async function queryPerm(handle) {
    if (typeof handle.queryPermission !== 'function') return 'granted';
    try { return await handle.queryPermission({ mode: 'readwrite' }); }
    catch (e) { return 'prompt'; }
  }

  /** 将当前数据库 base64 写回已绑定的 HTML 文件数据区 */
  async function writeToHtml(b64) {
    const handle = state.fileHandle;
    if (!handle) return false;
    const perm = await queryPerm(handle);
    if (perm !== 'granted') { state.needPermission = true; return false; }
    const file = await handle.getFile();
    const text = await file.text();
    const m = HTML_DATA_RE.exec(text);
    if (!m) throw new Error('所选 HTML 文件中未找到数据区标记');
    const now = new Date().toISOString();
    let next = text.slice(0, m.index) + m[1] + b64 + m[3] + text.slice(m.index + m[0].length);
    next = next.replace(SAVED_AT_RE, (_, a, b2) => a + now + b2);
    const w = await handle.createWritable();
    await w.write(next);
    await w.close();
    return true;
  }

  /* ---- IndexedDB：持久化文件句柄 ---- */
  let idbMem = {}; // IndexedDB 不可用时的内存兜底

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
      const r = indexedDB.open('adb.kv', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function kvSet(key, val) {
    idbMem[key] = val;
    try {
      const idb = await idbOpen();
      await new Promise((res, rej) => {
        const tx = idb.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { console.warn('[kvSet]', e); }
  }

  async function kvGet(key) {
    if (key in idbMem) return idbMem[key];
    try {
      const idb = await idbOpen();
      const val = await new Promise((res, rej) => {
        const tx = idb.transaction('kv', 'readonly');
        const rq = tx.objectStore('kv').get(key);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      if (val !== undefined) idbMem[key] = val;
      return val;
    } catch (e) { console.warn('[kvGet]', e); return undefined; }
  }

  async function kvDel(key) {
    delete idbMem[key];
    try {
      const idb = await idbOpen();
      await new Promise((res) => {
        const tx = idb.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    } catch (e) { console.warn(e); }
  }

  /* ---- 绑定 / 授权 / 解除 ---- */
  async function bindHtmlFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: '网页文件', accept: { 'text/html': ['.html', '.htm'] } }]
      });
      const file = await handle.getFile();
      const text = await file.text();
      if (!HTML_DATA_RE.test(text)) {
        toast('所选文件不是本记账本的 HTML', 'err');
        return false;
      }
      state.fileHandle = handle;
      state.needPermission = false;
      await kvSet(HANDLE_KEY, handle);
      await flushPersist();
      toast('已绑定，数据变更将自动写回该 HTML 文件');
      return true;
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return false;
      toast('绑定失败：' + (e.message || e), 'err');
      return false;
    }
  }

  async function reauthorize() {
    try {
      const perm = await state.fileHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        state.needPermission = false;
        await flushPersist();
        toast('已恢复与 HTML 文件的同步');
        return true;
      }
      toast('未获得授权', 'err');
      return false;
    } catch (e) {
      toast('授权失败：' + (e.message || e), 'err');
      return false;
    }
  }

  async function unbindHtmlFile() {
    state.fileHandle = null;
    state.needPermission = false;
    await kvDel(HANDLE_KEY);
    toast('已解除绑定（数据仍保留本地缓存）');
  }

  /** 构造"带数据的完整 HTML"文本（下载副本用） */
  async function buildFullHtml() {
    const { b64 } = await db.call('exportB64');
    // 优先取原始文件文本（http 环境），否则序列化当前 DOM
    try {
      const res = await fetch(location.href, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const m = HTML_DATA_RE.exec(text);
        if (m) {
          const now = new Date().toISOString();
          let out = text.slice(0, m.index) + m[1] + b64 + m[3] + text.slice(m.index + m[0].length);
          return out.replace(SAVED_AT_RE, (_, a, b2) => a + now + b2);
        }
      }
    } catch (e) { /* file:// 下 fetch 不可用，走序列化兜底 */ }
    document.getElementById('adb-data').textContent = b64;
    const clone = document.documentElement.cloneNode(true);
    const v = clone.querySelector('#view'); if (v) v.innerHTML = '';
    const o = clone.querySelector('#overlay-root'); if (o) o.innerHTML = '';
    const t = clone.querySelector('#toast-root'); if (t) t.innerHTML = '';
    const bootEl = clone.querySelector('#boot'); if (bootEl) bootEl.removeAttribute('hidden');
    const appEl = clone.querySelector('#app'); if (appEl) appEl.setAttribute('hidden', '');
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function downloadHtmlCopy() {
    try {
      const text = await buildFullHtml();
      downloadBlob(new Blob([text], { type: 'text/html;charset=utf-8' }), `${APP_NAME}-${todayStr()}.html`);
      toast('已生成带数据的 HTML 文件');
    } catch (e) { toast('生成失败：' + (e.message || e), 'err'); }
  }

  async function exportBackup() {
    try {
      const { b64 } = await db.call('exportB64');
      downloadBlob(new Blob([b64ToBytes(b64)], { type: 'application/octet-stream' }),
        `${APP_NAME}备份-${todayStr()}.adb`);
      toast('备份文件已导出');
    } catch (e) { toast('导出失败：' + (e.message || e), 'err'); }
  }

  async function importBackup() {
    const inp = h('input', { type: 'file', accept: '.adb,.db,.sqlite,application/octet-stream', style: { display: 'none' } });
    document.body.append(inp);
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) return;
      const ok = await openModal({
        title: '导入备份？',
        message: '导入将覆盖当前全部数据（包括已写回 HTML 的内容），此操作不可撤销。',
        danger: true, confirmText: '导入并覆盖'
      });
      if (!ok) return;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const st = await db.call('importB64', { b64: bytesToB64(buf) });
        applyState(st);
        await flushPersist();
        Router.go('#/');
        render();
        toast('备份已导入');
      } catch (e) { toast('导入失败：' + (e.message || e), 'err'); }
    });
    inp.click();
  }

  async function clearAllData() {
    const step1 = await openModal({
      title: '清理所有数据？',
      message: '将删除全部记账模块、明细，以及外观与 LOGO 设置；已写回 HTML 的数据区也会被清空。此操作不可恢复。',
      danger: true, confirmText: '继续'
    });
    if (!step1) return;
    const step2 = await openModal({
      title: '二次确认',
      message: '请在下方输入「清空」两个字，确认删除所有数据。',
      requireText: '清空', danger: true, confirmText: '清空数据'
    });
    if (!step2) return;
    try {
      const st = await db.call('clearAll');
      applyState(st);
      uiCacheWrite({ settings: state.settings, logo: '', scroll: {} });
      await flushPersist();
      Router.go('#/');
      await render();
      toast('已清理全部数据');
    } catch (e) { toast('清理失败：' + (e.message || e), 'err'); }
  }

  /* ================= 7. UI 组件 ================= */
  let toastSeed = 0;
  function toast(msg, type) {
    const root = $('#toast-root');
    toastLog.push({ msg: String(msg), type: type || '' });
    if (toastLog.length > 20) toastLog.shift();
    const t = h('div', { class: 'toast' + (type === 'err' ? ' err' : ''), dataset: { i: String(++toastSeed) }, text: msg });
    root.append(t);
    while (root.children.length > 3) root.firstElementChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2300);
  }

  /** 通用确认/输入对话框（Promise 化；requireText 实现二次确认） */
  function openModal(opt) {
    return new Promise((resolve) => {
      const root = $('#overlay-root');
      let input = null;
      const close = (val) => {
        backdrop.remove(); modal.remove();
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };

      const confirmBtn = h('button', {
        class: 'btn ' + (opt.danger ? 'btn-danger' : 'btn-primary'), text: opt.confirmText || '确定',
        onClick: () => {
          if (opt.requireText && input.value.trim() !== opt.requireText) {
            input.classList.add('err');
            input.focus();
            toast(`请输入「${opt.requireText}」以确认`, 'err');
            return;
          }
          close(true);
        }
      });
      const cancelBtn = h('button', { class: 'btn', text: opt.cancelText || '取消', onClick: () => close(false) });

      const body = h('div', { class: 'modal-body' },
        h('h3', { text: opt.title || '确认' })
      );
      if (opt.message) body.append(h('p', { class: opt.danger ? 'danger-text' : '', text: opt.message }));
      if (opt.extra) body.append(opt.extra);
      if (opt.requireText) {
        input = h('input', { class: 'input', type: 'text', autocapitalize: 'none', spellcheck: 'false',
          placeholder: `输入 ${opt.requireText}`,
          onInput: () => input.classList.remove('err'),
          onKeydown: (e) => { if (e.key === 'Enter') confirmBtn.click(); } });
        body.append(h('div', { style: { height: '14px' } }), input);
      }

      const backdrop = h('div', { class: 'modal-backdrop', onClick: () => close(false) });
      const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        body, h('div', { class: 'modal-foot' }, opt.hideCancel ? null : cancelBtn, confirmBtn));
      root.append(backdrop, modal);
      document.addEventListener('keydown', onKey);
      (input || confirmBtn).focus({ preventScroll: true });
      if (input) setTimeout(() => input.select(), 60);
    });
  }

  /** 底部弹层（移动端习惯）/ 桌面居中卡片 */
  function openSheet(opt) {
    const root = $('#overlay-root');
    const close = (reason) => {
      backdrop.remove(); sheetEl.remove();
      document.removeEventListener('keydown', onKey);
      if (opt.onClose) opt.onClose(reason);
    };
    const onKey = (e) => { if (e.key === 'Escape') close('esc'); };

    const backdrop = h('div', { class: 'sheet-backdrop', onClick: () => close('backdrop') });
    const sheetEl = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'sheet-head' },
        h('h3', { text: opt.title || '' }),
        h('button', { class: 'sheet-close', 'aria-label': '关闭', text: '×', onClick: () => close('close') })),
      h('div', { class: 'sheet-body' }, opt.body),
      opt.foot ? h('div', { class: 'sheet-foot' }, opt.foot) : null
    );
    root.append(backdrop, sheetEl);
    document.addEventListener('keydown', onKey);
    const first = sheetEl.querySelector('.sheet-body .input');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 120);
    return { close };
  }

  function field(label, control, hint) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label', text: label }),
      control,
      hint ? h('span', { class: 'field-hint', text: hint }) : null);
  }

  function showFieldError(input, msg) {
    input.classList.add('err');
    let err = input.parentElement.querySelector('.field-error');
    if (!err) { err = h('span', { class: 'field-error' }); input.parentElement.append(err); }
    err.textContent = msg;
    input.focus({ preventScroll: false });
  }

  function clearFieldErrors(scope) {
    scope.querySelectorAll('.input.err').forEach((i) => i.classList.remove('err'));
    scope.querySelectorAll('.field-error').forEach((e) => e.remove());
  }

  function logoNode(size) {
    if (state.logo) {
      return h('img', { src: state.logo, alt: 'LOGO', width: size || 36, height: size || 36 });
    }
    const el = svg(DEFAULT_LOGO_SVG);
    if (size) { el.setAttribute('width', size); el.setAttribute('height', size); }
    return el;
  }

  /* ================= 8. 路由 ================= */
  const Router = {
    parse(hash) {
      const p = (hash || '').replace(/^#/, '');
      if (p.indexOf('/m/') === 0) return { name: 'records', id: decodeURIComponent(p.slice(3)) };
      if (p.indexOf('/settings') === 0) return { name: 'settings', id: '' };
      return { name: 'modules', id: '' };
    },
    go(hash) {
      if (location.hash === hash) render();
      else location.hash = hash;
    },
    start() {
      window.addEventListener('hashchange', () => onRoute());
      onRoute();
    }
  };

  let renderSeq = 0;

  function routeKey(r) {
    return r.name === 'records' ? '#/m/' + r.id : (r.name === 'settings' ? '#/settings' : '#/');
  }

  function saveScroll(r) {
    if (!r) return;
    const cache = uiCacheRead();
    const scroll = Object.assign({}, cache.scroll || {});
    const y = Math.round(window.scrollY);
    if (y > 0) scroll[routeKey(r)] = y;
    uiCacheWrite({ scroll });
  }

  function restoreScroll(r) {
    const cache = uiCacheRead();
    const y = (cache.scroll || {})[routeKey(r)] || 0;
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  }

  async function onRoute() {
    saveScroll(state.route);
    state.prevRoute = state.route;
    state.route = Router.parse(location.hash);
    uiCacheWrite({ route: location.hash });
    // 持久化"最后所在页面"到 DB（写回 HTML）
    db.call('setMeta', { key: 'lastRoute', value: location.hash }).then(schedulePersist).catch(() => {});
    await render();
    restoreScroll(state.route);
  }

  async function render() {
    const seq = ++renderSeq;
    const r = state.route;
    try {
      if (r.name === 'modules') await renderModules(seq);
      else if (r.name === 'records') await renderRecords(seq, r.id);
      else if (r.name === 'settings') await renderSettings(seq);
    } catch (e) {
      console.error('[render]', e);
      if (seq === renderSeq) toast('渲染出错：' + (e.message || e), 'err');
    }
  }

  function setHeader(...kids) {
    const hd = $('#app-header');
    hd.replaceChildren(h('div', { class: 'hdr-inner' }, kids));
  }

  function setFab(onClick, label) {
    const fab = $('#fab');
    if (onClick) {
      fab.hidden = false;
      fab.setAttribute('aria-label', label || '新建');
      fab.onclick = onClick;
    } else {
      fab.hidden = true;
      fab.onclick = null;
    }
  }

  /* ================= 9. 视图：记账模块 ================= */
  async function renderModules(seq) {
    const [st, agg] = await Promise.all([db.call('getState'), db.call('stats')]);
    if (seq !== renderSeq) return;
    applyState(st);
    document.title = APP_NAME;

    setHeader(
      h('button', { class: 'hdr-btn logo-btn', title: '设置', 'aria-label': '打开设置', onClick: () => Router.go('#/settings') },
        logoNode(36)),
      h('div', { class: 'hdr-titles' },
        h('h1', { class: 'hdr-title', text: APP_NAME }),
        h('span', { class: 'hdr-sub', text: state.modules.length ? `${state.modules.length} 个模块` : '离线 · SQLite/WebAssembly' })),
      h('span', { class: 'hdr-btn', 'aria-hidden': 'true' })
    );
    setFab(() => moduleSheet(null), '新建记账模块');

    const view = $('#view');
    view.replaceChildren();

    if (state.needPermission && state.fileHandle) {
      view.append(h('div', { class: 'banner' },
        h('span', { text: '与 HTML 文件的同步需要重新授权。' }),
        h('button', { class: 'btn btn-sm btn-primary', text: '授权恢复', onClick: async () => { if (await reauthorize()) render(); } })));
    }

    if (!state.modules.length) {
      view.append(h('div', { class: 'empty' }, svg(ICON_EMPTY),
        h('p', { text: '还没有记账模块，先新建一个吧' }),
        h('button', { class: 'btn btn-primary', text: '＋ 新建模块', onClick: () => moduleSheet(null) })));
      return;
    }

    // 顶部金额汇总：所有模块全部明细的 总金额 / 已支付 / 未支付
    view.append(h('div', { class: 'summary' },
      h('div', { class: 'sum-card total' }, h('label', { text: '总金额' }), h('b', { text: fmt(agg.totalCents) })),
      h('div', { class: 'sum-card paid' }, h('label', { text: '已支付' }), h('b', { text: fmt(agg.paidCents) })),
      h('div', { class: 'sum-card unpaid' }, h('label', { text: '未支付' }), h('b', { text: fmt(agg.unpaidCents) }))
    ));

    const list = h('ul', { class: 'module-list' });
    state.modules.forEach((m) => list.append(moduleCard(m)));
    view.append(list);
    view.append(h('p', { class: 'mc-hint', text: '拖动右侧手柄可排序 · 长按卡片可编辑' }));
    attachSortable(list);
  }

  function moduleCard(m) {
    const openBtn = h('button', { class: 'mc-open', onClick: () => Router.go('#/m/' + encodeURIComponent(m.id)) },
      h('div', { class: 'mc-main' },
        h('div', { class: 'mc-name', text: m.name }),
        h('div', { class: 'mc-meta', text: '修改于 ' + fmtModified(m.modified_at) })),
      h('div', { class: 'mc-amount', text: fmt(m.amount_cents) }));
    const handle = h('div', { class: 'drag-handle', title: '拖动排序', role: 'button', 'aria-label': '拖动排序' }, svg(ICON_GRIP));
    return h('li', { class: 'module-card', dataset: { id: m.id } }, openBtn, handle);
  }

  /** 拖动排序（Pointer Events，兼容触屏与鼠标；长按进入编辑） */
  function attachSortable(list) {
    let drag = null;
    let lpTimer = null;
    let lpCard = null;
    let lpStart = null;
    let suppressClick = false;

    const resetStyles = () => {
      if (!drag) return;
      drag.cards.forEach((c) => { c.style.transform = ''; c.classList.remove('is-shifted'); });
      drag.card.classList.remove('is-dragging');
      list.classList.remove('dragging');
      document.body.style.userSelect = '';
      drag = null;
    };

    const onDown = (e) => {
      suppressClick = false;
      const handle = e.target.closest ? e.target.closest('.drag-handle') : null;
      if (handle) {
        const card = handle.closest('.module-card');
        if (!card) return;
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const cards = Array.from(list.querySelectorAll('.module-card'));
        const cs = getComputedStyle(list);
        drag = {
          pointerId: e.pointerId, handle, card, cards, list,
          fromIndex: cards.indexOf(card),
          targetIndex: cards.indexOf(card),
          startY: e.clientY,
          gap: parseFloat(cs.rowGap || cs.gap) || 10,
          slots: cards.map((c) => c.offsetTop),
          heights: cards.map((c) => c.offsetHeight)
        };
        card.classList.add('is-dragging');
        list.classList.add('dragging');
        document.body.style.userSelect = 'none';
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* ignore */ } }
        return;
      }
      // 长按卡片 → 编辑
      const card = e.target.closest ? e.target.closest('.module-card') : null;
      if (card && e.isPrimary) {
        lpCard = card;
        lpStart = { x: e.clientX, y: e.clientY };
        lpTimer = setTimeout(() => {
          lpTimer = null;
          suppressClick = true;
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignore */ } }
          const m = state.modules.find((x) => x.id === card.dataset.id);
          if (m) moduleSheet(m);
        }, 480);
      }
    };

    const onMove = (e) => {
      if (lpTimer && lpStart) {
        if (Math.abs(e.clientX - lpStart.x) > 10 || Math.abs(e.clientY - lpStart.y) > 10) {
          clearTimeout(lpTimer); lpTimer = null; lpCard = null;
        }
      }
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      const dy = e.clientY - drag.startY;
      drag.card.style.transform = `translateY(${dy}px)`;

      // 计算落点：以其他卡片的布局中心（不含 transform）判断插入位置
      const listTop = drag.list.getBoundingClientRect().top;
      const h0 = drag.heights[drag.fromIndex];
      let below = 0;
      drag.cards.forEach((c, i) => {
        if (c === drag.card) return;
        const center = listTop + drag.slots[i] + drag.heights[i] / 2;
        if (e.clientY > center) below++;
      });
      const target = Math.max(0, Math.min(drag.cards.length - 1, below));
      if (target !== drag.targetIndex) {
        drag.targetIndex = target;
        const slotSize = (drag.fromIndex < drag.slots.length - 1)
          ? drag.slots[drag.fromIndex + 1] - drag.slots[drag.fromIndex]
          : h0 + drag.gap;
        drag.cards.forEach((c, i) => {
          if (c === drag.card) return;
          let shift = 0;
          if (drag.fromIndex < target && i > drag.fromIndex && i <= target) shift = -slotSize;
          else if (drag.fromIndex > target && i >= target && i < drag.fromIndex) shift = slotSize;
          c.classList.toggle('is-shifted', shift !== 0);
          c.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      }
    };

    const onUp = async (e) => {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      if (!drag || e.pointerId !== drag.pointerId) return;
      const { fromIndex, targetIndex, card } = drag;
      resetStyles();
      if (targetIndex !== fromIndex) {
        const ids = state.modules.map((m) => m.id);
        const [moved] = ids.splice(fromIndex, 1);
        ids.splice(targetIndex, 0, moved);
        const arr = state.modules.slice();
        const [m2] = arr.splice(fromIndex, 1);
        arr.splice(targetIndex, 0, m2);
        state.modules = arr;
        try {
          await db.call('reorderModules', { ids });
          schedulePersist();
        } catch (err) {
          toast('排序保存失败：' + (err.message || err), 'err');
        }
        await render();
        const nc = list.querySelector(`.module-card[data-id="${CSS.escape(moved)}"]`);
        if (nc) nc.classList.add('just-dropped');
      }
    };

    const onCancel = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } resetStyles(); };

    list.addEventListener('pointerdown', onDown);
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerup', onUp);
    list.addEventListener('pointercancel', onCancel);
    list.addEventListener('click', (e) => {
      if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; }
    }, true);
    list.addEventListener('contextmenu', (e) => { if (e.target.closest('.drag-handle')) e.preventDefault(); });
  }

  /* ================= 10. 视图：记账明细列表 ================= */
  async function renderRecords(seq, moduleId) {
    let st = await db.call('getState');
    if (seq !== renderSeq) return;
    applyState(st);
    let mod = state.modules.find((m) => m.id === moduleId);
    if (!mod) {
      if (state.route.name === 'records' && state.route.id === moduleId) Router.go('#/');
      return;
    }
    const data = await db.call('getRecords', { moduleId });
    if (seq !== renderSeq) return;
    document.title = `${mod.name} · ${APP_NAME}`;

    setHeader(
      h('button', { class: 'hdr-btn', 'aria-label': '返回', onClick: () => Router.go('#/') }, svg(ICON_BACK)),
      h('div', { class: 'hdr-titles' },
        h('h1', { class: 'hdr-title', text: mod.name }),
        h('span', { class: 'hdr-sub', text: `${data.summary.count} 笔记录`})),
      h('span', { class: 'hdr-btn', 'aria-hidden': 'true' })
    );
    setFab(() => recordSheet(moduleId, null), '记一笔');

    const view = $('#view');
    view.replaceChildren();

    const s = data.summary;
    view.append(h('div', { class: 'summary' },
      h('div', { class: 'sum-card total' }, h('label', { text: '总金额' }), h('b', { text: fmt(s.totalCents) })),
      h('div', { class: 'sum-card paid' }, h('label', { text: '已支付' }), h('b', { text: fmt(s.paidCents) })),
      h('div', { class: 'sum-card unpaid' }, h('label', { text: '未支付' }), h('b', { text: fmt(s.unpaidCents) }))
    ));

    if (!data.records.length) {
      view.append(h('div', { class: 'empty' }, svg(ICON_EMPTY),
        h('p', { text: '暂无明细，点击右下角记一笔' })));
      return;
    }

    const tbody = h('tbody');
    let lastCat = null, lastSub = null;
    data.records.forEach((r) => {
      // 严格排序（大类 → 子类 → 日期）下的分组分隔行
      if (r.category !== lastCat || r.subcategory !== lastSub) {
        tbody.append(h('tr', { class: 'group-row' },
          h('td', { colspan: '6', text: r.category + (r.subcategory ? ' · ' + r.subcategory : '') })));
        lastCat = r.category; lastSub = r.subcategory;
      }
      tbody.append(h('tr', { class: 'item', tabindex: '0', onClick: () => recordSheet(moduleId, r),
        onKeydown: (e) => { if (e.key === 'Enter') recordSheet(moduleId, r); } },
        h('td', { class: 'c-cat' }, h('span', { class: 'chip', text: r.category })),
        h('td', { class: 'c-sub' }, r.subcategory ? h('span', { class: 'chip', text: r.subcategory }) : ''),
        h('td', { class: 'c-name', text: r.name }),
        h('td', { class: 'c-amount', text: fmt(r.amount_cents) }),
        h('td', { class: 'c-paid' },
          h('span', { class: 'chip ' + (r.paid ? 'paid' : 'unpaid'), text: r.paid ? '已支付' : '未支付' })),
        h('td', { class: 'c-date', text: r.date })
      ));
    });

    const table = h('table', { class: 'data-table' },
      h('thead', null,
        h('tr', null,
          h('th', { class: 'h-cat', text: '大类' }),
          h('th', { class: 'h-sub', text: '子类' }),
          h('th', { text: '名称' }),
          h('th', { class: 'h-amount', text: '金额' }),
          h('th', { class: 'h-paid', text: '是否支付' }),
          h('th', { text: '日期' }))),
      tbody);
    view.append(table);
  }

  /* ================= 11. 弹层：模块 新建/编辑 ================= */
  function moduleSheet(module) {
    const isEdit = !!module;
    const nameInput = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: '例如：日常开销', value: isEdit ? module.name : '' });
    const body = h('div', null, field('模块名称', nameInput));

    const foot = [];
    if (isEdit) {
      foot.push(h('button', { class: 'btn btn-danger', text: '删除', onClick: async () => {
        const ok = await openModal({
          title: '删除模块？',
          message: `「${module.name}」及其全部记账明细将被删除，此操作不可恢复。`,
          danger: true, confirmText: '删除'
        });
        if (!ok) return;
        try {
          await db.call('deleteModule', { id: module.id });
          sheet.close('deleted');
          state.modules = state.modules.filter((m) => m.id !== module.id);
          await render();
          schedulePersist();
          toast('模块已删除');
        } catch (e) { toast('删除失败：' + (e.message || e), 'err'); }
      } }));
    }
    foot.push(h('button', { class: 'btn', text: '取消', onClick: () => sheet.close('cancel') }));
    foot.push(h('button', { class: 'btn btn-primary grow-2', text: '保存', onClick: save }));

    async function move(dir) {
      try {
        const ret = await db.call('moveModule', { id: module.id, dir });
        if (ret.moved) {
          sheet.close('moved');
          await render();
          schedulePersist();
        } else {
          toast(dir < 0 ? '已经在最顶部' : '已经在最底部');
        }
      } catch (e) { toast('排序失败：' + (e.message || e), 'err'); }
    }

    if (isEdit) {
      body.append(h('div', { class: 'btn-row', style: { display: 'flex', gap: '10px', margin: '4px 0 14px' } },
        h('button', { class: 'btn btn-sm', text: '▲ 上移', onClick: () => move(-1) }),
        h('button', { class: 'btn btn-sm', text: '▼ 下移', onClick: () => move(1) }),
        h('span', { class: 'field-hint', style: { alignSelf: 'center' }, text: '亦可拖动排序' })));
    }

    async function save() {
      clearFieldErrors(body);
      const name = nameInput.value.trim();
      if (!name) { showFieldError(nameInput, '请输入模块名称'); return; }
      try {
        if (isEdit) await db.call('updateModule', { id: module.id, name });
        else await db.call('createModule', { name });
        sheet.close('saved');
        await render();
        schedulePersist();
        toast(isEdit ? '已保存' : '模块已创建');
      } catch (e) { toast('保存失败：' + (e.message || e), 'err'); }
    }

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const sheet = openSheet({ title: isEdit ? '编辑模块' : '新建记账模块', body, foot });
  }

  /* ================= 12. 弹层：明细 新建/编辑 ================= */
  function parseAmount(str) {
    const s = String(str).replace(/[¥$,\s]/g, '');
    if (s === '') return { error: '请输入金额' };
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: '金额格式不正确（最多两位小数）' };
    return { cents: Math.round(parseFloat(s) * 100) };
  }

  function fillDatalist(dl, items) {
    dl.replaceChildren(...items.map((v) => h('option', { value: v })));
  }

  async function recordSheet(moduleId, rec) {
    const isEdit = !!rec;
    const suggestP = db.call('suggest').catch(() => ({ categories: [], pairs: [] }));

    const dlCat = h('datalist', { id: 'dl-cat' });
    const dlSub = h('datalist', { id: 'dl-sub' });
    const catIn = h('input', { class: 'input', type: 'text', list: 'dl-cat', maxlength: '20', placeholder: '如：餐饮', value: isEdit ? rec.category : '' });
    const subIn = h('input', { class: 'input', type: 'text', list: 'dl-sub', maxlength: '20', placeholder: '如：午餐（可留空）', value: isEdit ? rec.subcategory : '' });
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: '如：公司楼下快餐', value: isEdit ? rec.name : '' });
    const amtIn = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0.00', value: isEdit ? (rec.amount_cents / 100).toFixed(2) : '' });
    const paidIn = h('input', { type: 'checkbox' });
    paidIn.checked = isEdit ? !!rec.paid : true;
    const dateIn = h('input', { class: 'input', type: 'date', value: isEdit ? rec.date : todayStr() });

    const body = h('div', null,
      dlCat, dlSub,
      h('div', { class: 'field-row' },
        field('大类', catIn), field('子类', subIn)),
      field('名称', nameIn),
      h('div', { class: 'field-row' },
        field('金额', h('div', { class: 'amount-wrap' },
          h('span', { class: 'cur', text: state.settings.currency || '¥' }), amtIn)),
        field('日期', dateIn)),
      h('div', { class: 'field' },
        h('div', { class: 'switch-row' },
          h('span', { class: 'field-label', style: { fontSize: '.82rem' }, text: '是否已支付' }),
          h('label', { class: 'switch' }, paidIn, h('span', { class: 'track' }), h('span', { class: 'thumb' }))))
    );

    // 子类联想：随大类联动
    let suggest = { categories: [], pairs: [] };
    const refreshSubs = () => {
      const cat = catIn.value.trim();
      const matched = [...new Set(suggest.pairs.filter((p) => p.category === cat).map((p) => p.subcategory))]
        .filter(Boolean);
      fillDatalist(dlSub, matched.length ? matched : [...new Set(suggest.suggestSubs || [])].filter(Boolean));
    };
    catIn.addEventListener('input', refreshSubs);

    suggestP.then((s) => {
      suggest = s;
      suggest.suggestSubs = s.pairs.map((p) => p.subcategory);
      fillDatalist(dlCat, s.categories);
      fillDatalist(dlSub, [...new Set(suggest.suggestSubs)].filter(Boolean));
    });

    const foot = [];
    if (isEdit) {
      foot.push(h('button', { class: 'btn btn-danger', text: '删除', onClick: async () => {
        const ok = await openModal({ title: '删除该明细？', message: `「${rec.name}」将被删除，不可恢复。`, danger: true, confirmText: '删除' });
        if (!ok) return;
        try {
          await db.call('deleteRecord', { id: rec.id });
          sheet.close('deleted');
          await render();
          schedulePersist();
          toast('明细已删除');
        } catch (e) { toast('删除失败：' + (e.message || e), 'err'); }
      } }));
    }
    foot.push(h('button', { class: 'btn', text: '取消', onClick: () => sheet.close('cancel') }));
    foot.push(h('button', { class: 'btn btn-primary grow-2', text: '保存', onClick: save }));

    async function save() {
      clearFieldErrors(body);
      const amount = parseAmount(amtIn.value);
      const errs = [];
      if (!catIn.value.trim()) errs.push([catIn, '请填写大类']);
      if (!nameIn.value.trim()) errs.push([nameIn, '请填写名称']);
      if (amount.error) errs.push([amtIn, amount.error]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIn.value)) errs.push([dateIn, '请选择日期']);
      if (errs.length) {
        errs.forEach(([inp, msg]) => showFieldError(inp, msg));
        errs[0][0].focus({ preventScroll: false });
        toast('请检查表单', 'err');
        return;
      }
      const payload = {
        category: catIn.value.trim(),
        subcategory: subIn.value.trim(),
        name: nameIn.value.trim(),
        amount_cents: amount.cents,
        paid: paidIn.checked,
        date: dateIn.value
      };
      try {
        if (isEdit) await db.call('updateRecord', Object.assign({ id: rec.id }, payload));
        else await db.call('createRecord', Object.assign({ moduleId }, payload));
        sheet.close('saved');
        await render();
        schedulePersist();
        toast(isEdit ? '已保存' : '已记一笔');
      } catch (e) { toast('保存失败：' + (e.message || e), 'err'); }
    }

    const sheet = openSheet({ title: isEdit ? '编辑明细' : '记一笔', body, foot });
  }

  /* ================= 13. 视图：设置 ================= */
  function segControl(options, current, onPick) {
    const box = h('div', { class: 'seg', role: 'group' });
    options.forEach((o) => {
      const btn = h('button', {
        class: 'seg-btn' + (o.value === current ? ' on' : ''), type: 'button', text: o.label,
        onClick: () => {
          box.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('on'));
          btn.classList.add('on');
          onPick(o.value);
        }
      });
      box.append(btn);
    });
    return box;
  }

  function rangeControl(min, max, step, value, format, onInput) {
    const val = h('span', { class: 'range-val', text: format(value) });
    const inp = h('input', { type: 'range', min, max, step, value });
    inp.value = value;
    inp.addEventListener('input', () => { val.textContent = format(parseFloat(inp.value)); onInput(parseFloat(inp.value)); });
    return h('div', { class: 'range-row' }, inp, val);
  }

  function selectControl(options, current, onChange) {
    const sel = h('select', { class: 'input', style: { minWidth: '140px' } },
      options.map((o) => h('option', { value: o.value, text: o.label })));
    sel.value = current;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function setRow(label, desc, control) {
    return h('div', { class: 'set-row' },
      h('div', null, h('div', { class: 'lbl', text: label }), desc ? h('div', { class: 'desc', text: desc }) : null),
      control);
  }

  async function renderSettings(seq) {
    const view = $('#view');
    setHeader(
      h('button', { class: 'hdr-btn', 'aria-label': '返回', onClick: () => Router.go(state.prevRoute.name === 'settings' ? '#/' : routeKey(state.prevRoute)) }, svg(ICON_BACK)),
      h('div', { class: 'hdr-titles' }, h('h1', { class: 'hdr-title', text: '设置' })),
      h('span', { class: 'hdr-btn', 'aria-hidden': 'true' })
    );
    setFab(null);
    document.title = `设置 · ${APP_NAME}`;
    view.replaceChildren();
    const s = state.settings;

    if (state.fileHandle && state.needPermission) {
      view.append(h('div', { class: 'banner' },
        h('span', { text: '同步已暂停：浏览器需要重新授权访问 HTML 文件。' }),
        h('button', { class: 'btn btn-sm btn-primary', text: '重新授权', onClick: async () => { if (await reauthorize()) render(); } })));
    }

    /* ---- LOGO ---- */
    const logoRow = h('div', { class: 'set-section' },
      h('div', { class: 'logo-editor' },
        h('div', { id: 'logo-preview' }, logoNode(64)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-sm', text: '更换 LOGO', onClick: pickLogo }),
          h('button', { class: 'btn btn-sm btn-ghost', text: '恢复默认', onClick: resetLogo }))));
    view.append(h('div', { class: 'set-title', text: '标识' }), logoRow);

    /* ---- 外观 ---- */
    view.append(h('div', { class: 'set-title', text: '外观' }),
      h('div', { class: 'set-section' },
        setRow('主题', '浅色 / 深色 / 跟随系统', segControl([
          { label: '浅色', value: 'light' },
          { label: '深色', value: 'dark' },
          { label: '跟随系统', value: 'auto' }
        ], s.theme, (v) => setSetting('theme', v))),
        setRow('字号', '全局文字大小', rangeControl(14, 24, 1, s.fontSize, (v) => v + ' px', (v) => setSetting('fontSize', v))),
        setRow('行距', '正文行间距离', rangeControl(1.3, 2, 0.1, s.lineHeight, (v) => v.toFixed(1), (v) => setSetting('lineHeight', v))),
        setRow('字体', '正文与界面字体', selectControl([
          { label: '系统默认', value: 'system' },
          { label: '黑体', value: 'hei' },
          { label: '衬线体', value: 'serif' },
          { label: '等宽字体', value: 'mono' }
        ], s.font, (v) => setSetting('font', v))),
        setRow('页宽', '内容区域最大宽度', selectControl([
          { label: '窄（460px）', value: 'narrow' },
          { label: '标准（640px）', value: 'normal' },
          { label: '宽（900px）', value: 'wide' },
          { label: '全宽', value: 'full' }
        ], s.pageWidth, (v) => setSetting('pageWidth', v))),
        (() => {
          const cur = h('input', { class: 'input', style: { width: '84px', textAlign: 'center' }, maxlength: '3', value: s.currency });
          cur.addEventListener('input', () => setSetting('currency', cur.value || '¥'));
          return setRow('货币符号', '金额显示前缀', cur);
        })()));

    /* ---- 数据与同步 ---- */
    const syncBox = h('div', { class: 'set-section' });
    const ui = uiCacheRead();
    const savedAt = ui.savedAt ? fmtModified(ui.savedAt) : '—';

    if (!state.fsSupported) {
      syncBox.append(
        h('div', { class: 'set-notice warn', text: '当前浏览器不支持写回文件：数据保存在本机浏览器缓存中，index.html 文件不会变化。换浏览器或清理浏览器数据前，请先导出备份。' }),
        setRow('写回 HTML', '需要 Chrome / Edge 的 File System Access 能力',
          h('span', { class: 'sync-state off' }, h('span', { class: 'dot' }), h('span', { text: '仅本地缓存' }))));
    } else if (!state.fileHandle) {
      syncBox.append(
        h('div', { class: 'set-notice warn', text: '尚未绑定文件：新增数据只保存在本机浏览器缓存里，index.html 文件大小不会变化。点击下方「绑定 HTML 文件」选择本页面后，数据才会真正内嵌写进 HTML（绑定成功瞬间即写入一次）。' }),
        setRow('写回 HTML', '绑定后每次改动自动写入所选 HTML 的内嵌数据区',
          h('button', { class: 'btn btn-sm btn-primary', text: '绑定 HTML 文件', onClick: async () => { if (await bindHtmlFile()) render(); } })));
    } else if (state.needPermission) {
      syncBox.append(
        h('div', { class: 'set-notice warn', text: '浏览器已回收该文件的访问权限，暂时不会写回 HTML（数据仍安全保存在本地缓存中）。' }),
        setRow('写回 HTML', '文件句柄有效，但需要重新授权',
          h('button', { class: 'btn btn-sm btn-primary', text: '重新授权', onClick: async () => { if (await reauthorize()) render(); } })));
    } else {
      syncBox.append(setRow('写回 HTML', '每次改动约 0.5 秒后自动写回「' + (state.fileHandle.name || '所选文件') + '」的数据区（文件大小随之变化）',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('span', { class: 'sync-state ok' }, h('span', { class: 'dot' }), h('span', { text: '自动同步中' })),
          h('button', { class: 'btn btn-sm btn-ghost', text: '解绑', onClick: async () => { await unbindHtmlFile(); render(); } }))));
    }
    syncBox.append(
      setRow('上次保存', '浏览器本地镜像写入时间（绑定文件后与写回同步更新）', h('span', { class: 'val mono', text: savedAt })),
      setRow('下载 HTML 副本', '生成一份包含当前数据的完整 HTML（可直接分发/备份）',
        h('button', { class: 'btn btn-sm', text: '生成并下载', onClick: downloadHtmlCopy })),
      setRow('导出备份', '导出 .adb 数据库文件', h('button', { class: 'btn btn-sm', text: '导出', onClick: exportBackup })),
      setRow('导入备份', '从 .adb 文件恢复（覆盖当前）', h('button', { class: 'btn btn-sm', text: '导入', onClick: importBackup }))
    );
    view.append(h('div', { class: 'set-title', text: '数据与同步' }), syncBox);

    /* ---- 添加到桌面 ---- */
    const inst = installState();
    view.append(h('div', { class: 'set-title', text: '添加到桌面' }),
      h('div', { class: 'set-section' },
        setRow('安装为桌面应用', '添加后桌面将出现「' + APP_NAME + '」，图标为你设置的 LOGO，点击直接进入应用',
          inst === 'installed'
            ? h('span', { class: 'sync-state ok' }, h('span', { class: 'dot' }), h('span', { text: '已添加' }))
            : h('button', {
                class: 'btn btn-sm btn-primary', id: 'install-btn',
                text: inst === 'ready' ? '立即添加' : '添加',
                onClick: onInstallClick
              }))));

    /* ---- 清理 ---- */
    view.append(h('div', { class: 'set-title', text: '危险操作' }),
      h('div', { class: 'set-section danger-zone' },
        setRow('清理所有数据', '删除全部模块、明细与外观设置（需两次确认）',
          h('button', { class: 'btn btn-sm btn-danger', text: '清理', onClick: clearAllData }))));

    /* ---- 关于 ---- */
    let statsText = '统计获取中…';
    db.call('stats').then((v) => {
      const el = view.querySelector('#stat-line');
      if (el) el.textContent = `${v.moduleCount} 个模块 · ${v.recordCount} 条明细 · 数据库 ${(v.dbBytes / 1024).toFixed(1)} KB`;
    }).catch(() => {});
    view.append(h('div', { class: 'set-title', text: '关于' }),
      h('div', { class: 'set-section' },
        h('div', { class: 'about-logo' }, logoNode(48),
          h('div', { class: 't' }, h('b', { text: APP_NAME }), h('span', { text: `v${VERSION} · 单文件离线应用` }))),
        setRow('数据引擎', 'SQLite 编译为 WebAssembly，运行于独立线程', h('span', { class: 'val', text: 'WASM + Worker' })),
        setRow('数据统计', null, h('span', { class: 'val', id: 'stat-line', text: statsText }))));
  }

  async function pickLogo() {
    const inp = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    document.body.append(inp);
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) return;
      try {
        const dataUrl = await resizeImage(file, 256);
        state.logo = dataUrl;
        await db.call('setMeta', { key: 'logo', value: dataUrl });
        uiCacheWrite({ logo: dataUrl });
        applySettings(state.settings);
        const pv = document.querySelector('#logo-preview');
        if (pv) pv.replaceChildren(logoNode(64));
        schedulePersist();
        toast('LOGO 已更新');
      } catch (e) { toast('图片处理失败：' + (e.message || e), 'err'); }
    });
    inp.click();
  }

  async function resetLogo() {
    state.logo = '';
    try { await db.call('setMeta', { key: 'logo', value: '' }); } catch (e) { console.warn(e); }
    uiCacheWrite({ logo: '' });
    applySettings(state.settings);
    const pv = document.querySelector('#logo-preview');
    if (pv) pv.replaceChildren(logoNode(64));
    schedulePersist();
    toast('已恢复默认 LOGO');
  }

  /** 图片等比压缩到指定边长（WebP 优先，回退 PNG） */
  function resizeImage(file, maxSize) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const hh = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = hh;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, w, hh);
          let out = cv.toDataURL('image/webp', 0.86);
          if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve(out);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      img.src = url;
    });
  }

  /* ================= 14. 启动 ================= */
  function bootFail(msg) {
    const bootEl = $('#boot');
    if (bootEl) bootEl.hidden = false;
    const appEl = $('#app'); if (appEl) appEl.hidden = true;
    const box = document.getElementById('boot-error');
    const txt = document.getElementById('boot-error-text');
    if (box && txt) { box.hidden = false; txt.textContent = msg; }
    const bt = document.getElementById('boot-text');
    if (bt) bt.hidden = true;
    console.error('[boot]', msg);
  }

  /** 决定初始数据来源：已授权文件 > localStorage 镜像 > 内嵌数据区 */
  async function resolveInitialB64() {
    const handle = await kvGet(HANDLE_KEY);
    if (handle) {
      state.fileHandle = handle;
      try {
        const perm = await queryPerm(handle);
        if (perm !== 'granted') {
          state.needPermission = true;
        } else {
          const file = await handle.getFile();
          const text = await file.text();
          const m = HTML_DATA_RE.exec(text);
          const at = text.match(SAVED_AT_RE);
          const fileSavedAt = at ? at[1] : '';
          const ls = lsRead();
          if (m && m[2].indexOf(SQLITE_B64_PREFIX) === 0) {
            if (!ls || !ls.b64 || !ls.savedAt || fileSavedAt >= ls.savedAt) {
              return { b64: m[2].trim(), origin: 'file' };
            }
          }
        }
      } catch (e) { console.warn('[resolve] 读取绑定文件失败', e); }
    }
    const ls = lsRead();
    if (ls && ls.b64 && ls.b64.indexOf(SQLITE_B64_PREFIX) === 0) return { b64: ls.b64, origin: 'local' };
    const emb = (document.getElementById('adb-data').textContent || '').trim();
    if (emb.indexOf(SQLITE_B64_PREFIX) === 0) return { b64: emb, origin: 'embedded' };
    return { b64: '', origin: 'fresh' };
  }

  async function boot() {
    try {
      const src = await resolveInitialB64();
      db.start(src.b64);
      await db.call('ping');            // 等待 Worker + WASM 就绪（排队机制）
      const st = await db.call('getState');
      applyState(st);

      // 恢复路由状态（replaceState 不触发 hashchange，随后由 Router.start 统一渲染）
      const cached = uiCacheRead();
      const initial = location.hash || st.lastRoute || cached.route || '#/';
      if (location.hash !== initial) {
        try { history.replaceState(null, '', initial); } catch (e) { location.hash = initial; }
      }
      state.route = Router.parse(initial);

      $('#boot').hidden = true;
      $('#app').hidden = false;

      Router.start();
      updatePwaMeta().catch((e) => console.warn('[pwa]', e));   // 生成桌面安装用 Manifest

      if (state.needPermission && state.fileHandle) {
        toast('HTML 文件同步需重新授权（可在设置中恢复）');
      }
      // 启动时若本地镜像比文件新，立即补写
      if (src.origin === 'local' && state.fileHandle && !state.needPermission) schedulePersist();

      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPersist();
      });
      window.addEventListener('pagehide', () => { flushPersist(); });
      window.addEventListener('beforeunload', () => { if (persistTimer) { clearTimeout(persistTimer); flushPersist(); } });
    } catch (e) {
      bootFail((e && e.message) || String(e));
    }
  }

  boot();
})();