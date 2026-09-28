'use strict';
/**
 * ============================================================
 *  离线记账本 · 数据服务 Worker（独立线程）
 * ------------------------------------------------------------
 *  - SQLite 以 WebAssembly 形式运行在本 Worker 中，主线程永不阻塞；
 *  - 主线程通过 postMessage RPC 调用本文件暴露的 HANDLERS；
 *  - 所有查询 / 排序 / 汇总均在 SQLite(WASM) 内完成。
 * ============================================================
 */

var SQL = null;   // sql.js 模块（SQLite -> WebAssembly）
var db = null;    // 当前数据库连接

/* ---------- 数据库结构（版本 1） ---------- */
var SCHEMA_SQL = [
  'PRAGMA foreign_keys=ON;',
  'CREATE TABLE IF NOT EXISTS meta (',
  '  key   TEXT PRIMARY KEY,',
  '  value TEXT',
  ');',
  'CREATE TABLE IF NOT EXISTS modules (',
  '  id         TEXT PRIMARY KEY,',
  '  name       TEXT NOT NULL,',
  '  sort_order INTEGER NOT NULL DEFAULT 0,',
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS records (',
  '  id          TEXT PRIMARY KEY,',
  '  module_id   TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,',
  '  category    TEXT NOT NULL DEFAULT \'\',',
  '  subcategory TEXT NOT NULL DEFAULT \'\',',
  '  name        TEXT NOT NULL DEFAULT \'\',',
  '  amount_cents INTEGER NOT NULL DEFAULT 0,',
  '  paid        INTEGER NOT NULL DEFAULT 0,',
  '  date        TEXT NOT NULL,',
  '  created_at  TEXT NOT NULL,',
  '  updated_at  TEXT NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_records_sort',
  '  ON records(module_id, category, subcategory, date);'
].join('\n');

var DEFAULT_SETTINGS = {
  theme: 'auto',        // light | dark | auto
  fontSize: 16,         // px
  lineHeight: 1.6,
  font: 'system',       // system | serif | hei | mono
  pageWidth: 'normal',  // narrow | normal | wide | full
  currency: '¥'
};

var META_KEYS = ['settings', 'logo', 'lastRoute'];

/* ---------- 基础工具 ---------- */
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function nowIso() { return new Date().toISOString(); }

function b64ToBytes(b64) {
  var bin = atob(b64);
  var n = bin.length;
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  var parts = [];
  var CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length))));
  }
  return btoa(parts.join(''));
}

function isSqliteBytes(bytes) {
  var head = 'SQLite format 3\u0000';
  if (!bytes || bytes.length < 16) return false;
  for (var i = 0; i < 16; i++) {
    if (bytes[i] !== head.charCodeAt(i)) return false;
  }
  return true;
}

/* ---------- SQL 辅助 ---------- */
function queryRows(sql, params) {
  var res = db.exec(sql, params || []);
  if (!res.length) return [];
  var cols = res[0].columns;
  return res[0].values.map(function (v) {
    var o = {};
    for (var i = 0; i < cols.length; i++) o[cols[i]] = v[i];
    return o;
  });
}

function queryOne(sql, params) {
  var r = queryRows(sql, params);
  return r.length ? r[0] : null;
}

function scalar(sql, params) {
  var r = queryOne(sql, params);
  if (!r) return null;
  var k = Object.keys(r)[0];
  return r[k];
}

function tx(fn) {
  db.run('BEGIN');
  try {
    fn();
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

/* ---------- 元数据 / 设置 ---------- */
function getMeta(key, fallback) {
  var row = queryOne('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : (fallback === undefined ? null : fallback);
}

function setMeta(key, value) {
  if (META_KEYS.indexOf(key) === -1) throw new Error('不允许的 meta 键：' + key);
  db.run(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

function getSettings() {
  var raw = getMeta('settings', '');
  var merged = {};
  try { merged = raw ? JSON.parse(raw) : {}; } catch (e) { merged = {}; }
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    out[k] = merged[k] !== undefined ? merged[k] : DEFAULT_SETTINGS[k];
  });
  return out;
}

/* ---------- 领域查询 ---------- */
function listModules() {
  return queryRows([
    'SELECT m.id, m.name, m.sort_order, m.created_at, m.updated_at,',
    '  COALESCE((SELECT SUM(r.amount_cents) FROM records r WHERE r.module_id = m.id), 0) AS amount_cents,',
    '  MAX(m.updated_at, COALESCE((SELECT MAX(r.updated_at) FROM records r WHERE r.module_id = m.id), m.updated_at)) AS modified_at',
    'FROM modules m',
    'ORDER BY m.sort_order ASC, m.created_at ASC'
  ].join('\n'));
}

function getState() {
  return {
    settings: getSettings(),
    logo: getMeta('logo', ''),
    lastRoute: getMeta('lastRoute', ''),
    modules: listModules()
  };
}

function assertModule(id) {
  var m = queryOne('SELECT id FROM modules WHERE id = ?', [id]);
  if (!m) throw new Error('记账模块不存在');
  return m;
}

function normalizeRecord(p) {
  var category = String(p.category || '').trim();
  var name = String(p.name || '').trim();
  if (!category) throw new Error('请填写大类');
  if (!name) throw new Error('请填写名称');
  var cents = parseInt(p.amount_cents, 10);
  if (!isFinite(cents)) cents = 0;
  var date = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  return {
    category: category,
    subcategory: String(p.subcategory || '').trim(),
    name: name,
    amount_cents: cents,
    paid: p.paid ? 1 : 0,
    date: date
  };
}

/* ---------- RPC 处理器 ---------- */
var HANDLERS = {
  ping: function () { return { pong: true, engine: 'SQLite/WebAssembly', thread: 'worker' }; },

  getState: function () { return getState(); },

  /* ---- 记账模块 ---- */
  createModule: function (p) {
    var name = String(p.name || '').trim();
    if (!name) throw new Error('请填写模块名称');
    var id = uuid();
    var maxOrder = scalar('SELECT COALESCE(MAX(sort_order), -1) FROM modules');
    var t = nowIso();
    db.run('INSERT INTO modules(id, name, sort_order, created_at, updated_at) VALUES(?,?,?,?,?)',
      [id, name, maxOrder + 1, t, t]);
    return { id: id };
  },

  updateModule: function (p) {
    assertModule(p.id);
    var name = String(p.name || '').trim();
    if (!name) throw new Error('请填写模块名称');
    db.run('UPDATE modules SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), p.id]);
    return { ok: true };
  },

  deleteModule: function (p) {
    assertModule(p.id);
    db.run('DELETE FROM modules WHERE id = ?', [p.id]); // 级联删除明细
    return { ok: true };
  },

  /** 拖动排序后提交：ids 为完整的新顺序 */
  reorderModules: function (p) {
    var ids = (p.ids || []).map(String);
    var current = queryRows('SELECT id FROM modules').map(function (r) { return r.id; });
    if (ids.length !== current.length ||
        ids.slice().sort().join('|') !== current.slice().sort().join('|')) {
      throw new Error('排序数据不一致');
    }
    tx(function () {
      ids.forEach(function (id, i) {
        db.run('UPDATE modules SET sort_order = ? WHERE id = ?', [i, id]);
      });
    });
    return { ok: true };
  },

  /** 键盘 / 按钮替代排序：dir = -1 上移，1 下移 */
  moveModule: function (p) {
    assertModule(p.id);
    var ids = queryRows('SELECT id FROM modules ORDER BY sort_order, created_at')
      .map(function (r) { return r.id; });
    var i = ids.indexOf(p.id);
    var j = i + (Number(p.dir) || 0);
    if (i < 0 || j < 0 || j >= ids.length) return { ok: true, moved: false };
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    tx(function () {
      ids.forEach(function (id, k) {
        db.run('UPDATE modules SET sort_order = ? WHERE id = ?', [k, id]);
      });
    });
    return { ok: true, moved: true };
  },

  /* ---- 记账明细 ---- */
  getRecords: function (p) {
    assertModule(p.moduleId);
    var records = queryRows([
      'SELECT id, module_id, category, subcategory, name, amount_cents, paid, date, created_at, updated_at',
      'FROM records WHERE module_id = ?',
      'ORDER BY category ASC, subcategory ASC, date ASC, created_at ASC, id ASC'
    ].join('\n'), [p.moduleId]);
    var s = queryOne([
      'SELECT COUNT(*) AS cnt,',
      '  COALESCE(SUM(amount_cents), 0) AS total_cents,',
      '  COALESCE(SUM(CASE WHEN paid = 1 THEN amount_cents ELSE 0 END), 0) AS paid_cents',
      'FROM records WHERE module_id = ?'
    ].join('\n'), [p.moduleId]);
    return {
      records: records,
      summary: {
        count: s.cnt,
        totalCents: s.total_cents,
        paidCents: s.paid_cents,
        unpaidCents: s.total_cents - s.paid_cents
      }
    };
  },

  createRecord: function (p) {
    assertModule(p.moduleId);
    var r = normalizeRecord(p);
    var id = uuid();
    var t = nowIso();
    db.run([
      'INSERT INTO records(id, module_id, category, subcategory, name, amount_cents, paid, date, created_at, updated_at)',
      'VALUES(?,?,?,?,?,?,?,?,?,?)'
    ].join(' '), [id, p.moduleId, r.category, r.subcategory, r.name, r.amount_cents, r.paid, r.date, t, t]);
    return { id: id };
  },

  updateRecord: function (p) {
    var row = queryOne('SELECT id FROM records WHERE id = ?', [p.id]);
    if (!row) throw new Error('明细不存在');
    var r = normalizeRecord(p);
    db.run([
      'UPDATE records SET category = ?, subcategory = ?, name = ?, amount_cents = ?, paid = ?, date = ?, updated_at = ?',
      'WHERE id = ?'
    ].join(' '), [r.category, r.subcategory, r.name, r.amount_cents, r.paid, r.date, nowIso(), p.id]);
    return { ok: true };
  },

  deleteRecord: function (p) {
    db.run('DELETE FROM records WHERE id = ?', [p.id]);
    return { ok: true };
  },

  /** 大类 / 子类 输入联想（严格排序的 DISTINCT 查询） */
  suggest: function () {
    return {
      categories: queryRows('SELECT DISTINCT category FROM records ORDER BY category ASC')
        .map(function (r) { return r.category; }),
      pairs: queryRows('SELECT DISTINCT category, subcategory FROM records ORDER BY category ASC, subcategory ASC')
    };
  },

  /* ---- 统计 ---- */
  stats: function () {
    return {
      moduleCount: scalar('SELECT COUNT(*) FROM modules'),
      recordCount: scalar('SELECT COUNT(*) FROM records'),
      dbBytes: db.export().length
    };
  },

  /* ---- 元数据 / 设置 ---- */
  setMeta: function (p) {
    setMeta(p.key, p.value);
    return { ok: true };
  },

  /* ---- 持久化：导出 / 导入 / 清空 ---- */
  exportB64: function () {
    return { b64: bytesToB64(db.export()) };
  },

  importB64: function (p) {
    var bytes = b64ToBytes(String(p.b64 || ''));
    if (!isSqliteBytes(bytes)) throw new Error('不是有效的记账本数据文件');
    var next = new SQL.Database(bytes);
    next.exec(SCHEMA_SQL); // 兼容旧结构升级
    var check;
    try {
      check = next.exec('SELECT COUNT(*) FROM records');
      if (!check.length) throw new Error('数据表结构异常');
    } catch (e) {
      next.close();
      throw new Error('数据文件损坏或不是记账本备份');
    }
    if (db) db.close();
    db = next;
    return getState();
  },

  /** 全部清空（模块、明细、设置、LOGO），恢复初始状态 */
  clearAll: function () {
    if (db) db.close();
    db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    return getState();
  }
};

/* ---------- 引擎初始化 ---------- */
function openDatabase(bytes) {
  db = (bytes && bytes.length) ? new SQL.Database(bytes) : new SQL.Database();
  db.exec(SCHEMA_SQL);
}

function initEngine(msg) {
  // 以函数作用域动态加载 sql.js（UMD 尾部导出 initSqlJs）
  var factory = new Function('module', 'exports', msg.glue + '\n;return initSqlJs;')(
    { exports: {} }, {}
  );
  var wasmBytes = b64ToBytes(msg.wasmB64);
  return Promise.resolve(factory({ wasmBinary: wasmBytes })).then(function (SQLMod) {
    SQL = SQLMod;
    var bytes = msg.dbB64 ? b64ToBytes(msg.dbB64) : null;
    if (bytes && !isSqliteBytes(bytes)) bytes = null; // 数据区损坏则重建
    openDatabase(bytes);
  });
}

/* ---------- 消息入口 ---------- */
self.onmessage = function (e) {
  var msg = e.data;
  if (!msg) return;

  if (msg.type === 'init') {
    initEngine(msg).then(function () {
      self.postMessage({ type: 'ready' });
    }, function (err) {
      self.postMessage({ type: 'fatal', error: String((err && err.message) || err) });
    });
    return;
  }

  if (msg.type === 'call') {
    var handler = HANDLERS[msg.method];
    if (!handler) {
      self.postMessage({ type: 'result', id: msg.id, ok: false, error: '未知方法：' + msg.method });
      return;
    }
    try {
      var result = handler(msg.params || {});
      self.postMessage({ type: 'result', id: msg.id, ok: true, result: result });
    } catch (err) {
      self.postMessage({
        type: 'result', id: msg.id, ok: false,
        error: String((err && err.message) || err)
      });
    }
  }
};