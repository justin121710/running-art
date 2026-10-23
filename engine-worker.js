/*
 * Running Art — 運算引擎（Web Worker）
 *
 * Pyodide 跑在這裡，不在主執行緒：生成路線的那幾秒畫面照樣能動、能取消。
 * 主執行緒那邊是 engine.js，用 postMessage 呼叫這裡：
 *   主 → worker：{id, op, args}
 *   worker → 主：{id, ok:true, result} | {id, ok:false, error} | {type:'progress', text}
 *
 * 路網下載（Overpass）與本地快取（IndexedDB）也在這裡做，大份 JSON 不必在兩邊搬來搬去。
 */
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
importScripts(PYODIDE_URL + 'pyodide.js');

const FILES = ['__init__.py', 'config.py', 'geometry.py', 'graphutil.py',
               'graphprep.py', 'routing.py', 'web_api.py'];
// 演算法版本：tools/stamp_versions.py 依 gpsart/ 內容自動更新，否則瀏覽器會沿用快取的舊檔
const VERSION = 'a75f69632e';

// 公用 Overpass 鏡像。依序「錯開」發請求（見 fetchOverpass），不是一次全打。
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// 註：overpass.osm.ch 是瑞士專用站，台灣會回空資料，別加。
const OVERPASS_STAGGER_MS = 4000;    // 前一台這麼久還沒回，才加開下一台
const OVERPASS_TIMEOUT_MS = 30000;

let py = null;
let ready = null;
let lastStats = null;

const progress = text => postMessage({ type: 'progress', text });

/* ---------- 啟動 ----------
   失敗時把 ready 清掉，下一次呼叫會整個重來。以前失敗的 promise 被快取住，
   網路一閃斷之後就只能重新整理頁面。 */
function boot() {
  if (ready) return ready;
  ready = (async () => {
    progress('載入運算引擎…');
    if (!py) py = await loadPyodide({ indexURL: PYODIDE_URL });
    progress('載入數學與路網套件…');
    // numpy / networkx / shapely 都是 Pyodide 內建套件，從同一個 CDN 載，不必經過 PyPI
    await py.loadPackage(['numpy', 'networkx', 'shapely']);
    progress('載入演算法…');
    try { py.FS.mkdir('/gpsart'); } catch (_) { /* 重試時已存在 */ }
    for (const f of FILES) {
      const r = await fetch('gpsart/' + f + '?v=' + VERSION);
      if (!r.ok) throw new Error('讀不到 gpsart/' + f);
      py.FS.writeFile('/gpsart/' + f, new Uint8Array(await r.arrayBuffer()));
    }
    py.runPython(`
import sys, json
if '/' not in sys.path:
    sys.path.insert(0, '/')
from gpsart import web_api as W
from gpsart.graphprep import OVERPASS_FILTER
`);
    progress('');
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

/* 呼叫 web_api 裡的函式。參數與回傳都走 JSON，避免 Pyodide 代理物件的生命週期問題。 */
function callPy(fn, args) {
  py.globals.set('_args_json', JSON.stringify(args || []));
  try {
    return JSON.parse(py.runPython(`json.dumps(W.${fn}(*json.loads(_args_json)))`));
  } catch (e) {
    // PythonError 的訊息是整段 traceback；最後一行才是給人看的
    const lines = String(e && e.message || e).trim().split('\n');
    throw new Error(lines[lines.length - 1].replace(/^\w+Error:\s*/, ''));
  }
}

/* ---------- 已下載範圍的本地快取（IndexedDB） ----------
   下載成功的整份 Overpass JSON 存起來，之後新範圍只要被某個已存範圍涵蓋就直接重用。
   · 超過 CACHE_TTL_MS 的視為過期（OSM 會更新：封路、新路），有網路就重新下載；
     離線或下載失敗時才退回用過期的。
   · 有好幾份都涵蓋時挑面積最小的——用一大塊快取建圖會變慢、節點也多。 */
const CACHE_DB = 'runart-maps', CACHE_STORE = 'areas', CACHE_MAX = 12;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

function openCache() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(CACHE_DB, 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function cacheFind(s, w, n, e) {
  let db;
  try { db = await openCache(); } catch (_) { return { fresh: null, stale: null }; }
  return new Promise(res => {
    const hits = [];
    const cur = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        const a = c.value;
        if (a.s <= s && a.w <= w && a.n >= n && a.e >= e) hits.push(a);
        c.continue();
        return;
      }
      db.close();
      const area = a => (a.n - a.s) * (a.e - a.w);
      hits.sort((x, y) => area(x) - area(y));
      const now = Date.now();
      const fresh = hits.find(a => now - a.ts < CACHE_TTL_MS) || null;
      res({ fresh: fresh && fresh.raw, stale: hits.length ? hits[0].raw : null });
    };
    cur.onerror = () => { db.close(); res({ fresh: null, stale: null }); };
  });
}
async function cachePut(s, w, n, e, raw) {
  let db;
  try { db = await openCache(); } catch (_) { return; }
  try {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const st = tx.objectStore(CACHE_STORE);
    st.put({ key: `${s},${w},${n},${e}`, s, w, n, e, raw, ts: Date.now() });
    st.getAll().onsuccess = ev => {
      const all = ev.target.result || [];
      if (all.length > CACHE_MAX)
        all.sort((x, y) => x.ts - y.ts).slice(0, all.length - CACHE_MAX).forEach(o => st.delete(o.key));
    };
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  } catch (_) { /* 快取失敗不影響主流程 */ }
  finally { db.close(); }
}

/* ---------- Overpass 下載 ----------
   錯開競速：先打第一台，OVERPASS_STAGGER_MS 內沒回應（或失敗）才加開下一台，
   誰先成功用誰的、其餘取消。以前一次同時打 6 台，每次載入都給公用伺服器 6 倍負載，
   容易被限流（429）甚至封 IP，長期反而降低成功率。 */
function checkOverpassText(text) {
  if (!text || text.length < 200) throw new Error('空白');
  // 「軟逾時」會回 HTTP 200 但 elements 為空、只帶一段 remark
  if (/"remark"\s*:\s*"[^"]*(timed out|runtime error|out of memory)/i.test(text)) throw new Error('伺服器逾時');
  // ⚠️ Overpass JSON 是排版過的（"type": "node"），要容許冒號後的空白
  if (!/"type"\s*:\s*"(node|way)"/.test(text)) throw new Error('無資料');
}
function fetchOverpass(query) {
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let next = 0, running = 0, done = false, stagger = null, retryAfter = 0;
    const finish = (ok, val) => {
      if (done) return;
      done = true;
      clearTimeout(stagger);
      ctrls.forEach(c => c.abort());
      ok ? resolve(val) : reject(Object.assign(new Error('所有伺服器都無回應'), { retryAfter }));
    };
    const launch = () => {
      if (done || next >= OVERPASS.length) return;
      const url = OVERPASS[next++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      running++;
      const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
      fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
                   headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal })
        .then(async res => {
          if (res.status === 429 || res.status === 504) {
            const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
            if (ra > 0) retryAfter = Math.max(retryAfter, ra * 1000);
            throw new Error('忙碌 ' + res.status);
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          checkOverpassText(text);
          return text;
        })
        .then(text => finish(true, text))
        .catch(() => { if (!done) launch(); })      // 這台失敗：馬上換下一台
        .finally(() => {
          clearTimeout(timer);
          running--;
          if (!done && running === 0 && next >= OVERPASS.length) finish(false);
        });
      clearTimeout(stagger);
      stagger = setTimeout(launch, OVERPASS_STAGGER_MS);
    };
    launch();
  });
}

async function loadArea(s, w, n, e) {
  await boot();
  const cached = await cacheFind(s, w, n, e);
  let raw = cached.fresh, fromNet = false;
  if (raw) {
    progress('使用已下載的地圖…');
  } else {
    const filter = py.globals.get('OVERPASS_FILTER');
    // timeout 是伺服器端逾時；maxsize 讓太大的範圍直接被拒絕，而不是把伺服器拖垮
    const query = `[out:json][timeout:25][maxsize:67108864];(way${filter}(${s},${w},${n},${e});>;);out body qt;`;
    for (let round = 0; round < 2 && !raw; round++) {
      progress(round === 0 ? '下載路網…' : '伺服器忙碌，重試中…');
      try { raw = await fetchOverpass(query); fromNet = true; }
      catch (err) {
        if (round === 0) await new Promise(r => setTimeout(r, Math.min(15000, Math.max(1500, err.retryAfter || 0))));
      }
    }
    if (!raw && cached.stale) { raw = cached.stale; progress('伺服器忙碌，改用之前下載過的地圖…'); }
    if (!raw) {
      throw new Error('地圖下載失敗：目前公用伺服器（Overpass）都很忙碌。' +
                      '請縮小範圍、或等一兩分鐘再試。已下載過的範圍會被記住，可以離線重用。');
    }
  }
  progress('建立路網…');
  const stats = callPy('load_area_json', [raw]);
  progress('');
  if (!stats.nodes) {
    throw new Error('這個範圍抓不到可跑的道路（伺服器可能回了空資料）。請換個地點、把範圍放大一點或稍後再試。');
  }
  if (fromNet) await cachePut(s, w, n, e, raw);   // 只快取「成功且非空」的結果
  lastStats = stats;
  return stats;
}

const OPS = {
  boot: async () => { await boot(); return true; },
  loadArea: (s, w, n, e) => loadArea(s, w, n, e),
  generate: async (strokes, start, end) => {
    await boot();
    progress('對齊道路中…');
    try { return callPy('generate', [strokes, start, end]); } finally { progress(''); }
  },
  editDelete: async picks => {
    await boot();
    progress('重新接路中…');
    try { return callPy('edit_delete', [picks]); } finally { progress(''); }
  },
  editUndo: async () => { await boot(); return callPy('edit_undo', []); },
  editMove: async (si, n, id) => { await boot(); return callPy('edit_move', [si, n, String(id)]); },
  previewMove: async (si, n, id) => { await boot(); return callPy('preview_move', [si, n, String(id)]); },
  nearbyJunctions: async (lat, lon, r, lim) => { await boot(); return callPy('nearby_junctions', [lat, lon, r || 20, lim || 40]); },
  reverseRoute: async () => { await boot(); return callPy('reverse_route', []); },
  snapToNode: async (lat, lon) => { await boot(); return callPy('snap_to_node', [lat, lon]); },
};

/* 一次只處理一個請求。onmessage 的 async 處理器會在 await 時交錯執行，
   兩個請求同時改 Python 端的全域狀態（SEGS、HISTORY）會互相蓋掉。 */
let chain = Promise.resolve();
onmessage = ev => {
  const { id, op, args } = ev.data || {};
  chain = chain.then(async () => {
    try {
      const fn = OPS[op];
      if (!fn) throw new Error('未知的操作：' + op);
      postMessage({ id, ok: true, result: await fn(...(args || [])) });
    } catch (e) {
      postMessage({ id, ok: false, error: String(e && e.message || e) });
    }
  });
};
