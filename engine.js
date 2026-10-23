/*
 * Running Art — 運算引擎的主執行緒端
 *
 * 真正的運算（Pyodide + gpsart/）在 engine-worker.js 這個 Web Worker 裡跑，
 * 這裡只負責傳話。API 與以前相同，全部回傳 Promise。
 *
 * Worker 當掉（記憶體不足、使用者按取消）時會自動重開，並在背景重新載入上一次的範圍
 * ——路網快取在 IndexedDB，通常一兩秒就回來，使用者不必重新框選。
 */
const Engine = (() => {
  const WORKER_URL = 'engine-worker.js?v=9bcd8f73e5';
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let onProgress = () => {};
  let lastArea = null;
  let bootPromise = null;

  function spawn() {
    worker = new Worker(WORKER_URL);
    worker.onmessage = ev => {
      const m = ev.data || {};
      if (m.type === 'progress') { onProgress(m.text); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    };
    worker.onerror = ev => {
      ev.preventDefault && ev.preventDefault();
      restart(new Error('運算引擎發生錯誤：' + (ev.message || '未知錯誤')));
    };
  }

  function call(op, ...args) {
    if (!worker) spawn();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op });
      worker.postMessage({ id, op, args });
    });
  }

  /* 丟掉目前的 Worker，所有還在等的呼叫都以 err 失敗。 */
  function restart(err) {
    if (worker) { try { worker.terminate(); } catch (_) {} }
    worker = null;
    bootPromise = null;
    onProgress('');
    const list = [...pending.values()];
    pending.clear();
    list.forEach(p => p.reject(err));
    // 背景把路網接回來，之後的操作不必重新框選
    if (lastArea) call('loadArea', ...lastArea).catch(() => {});
  }

  return {
    setProgress(fn) { onProgress = fn || (() => {}); },
    /* 失敗的話下次呼叫會重試（Worker 端也不會把失敗快取住） */
    boot() {
      if (!bootPromise) {
        bootPromise = call('boot');
        bootPromise.catch(() => { bootPromise = null; });
      }
      return bootPromise;
    },
    async loadArea(s, w, n, e) {
      const st = await call('loadArea', s, w, n, e);
      lastArea = [s, w, n, e];
      return st;
    },
    generate: (strokes, start, end) => call('generate', strokes, start, end),
    editDelete: picks => call('editDelete', picks),
    editUndo: () => call('editUndo'),
    editMove: (si, n, id) => call('editMove', si, n, id),
    previewMove: (si, n, id) => call('previewMove', si, n, id),
    nearbyJunctions: (lat, lon, r, lim) => call('nearbyJunctions', lat, lon, r, lim),
    reverseRoute: () => call('reverseRoute'),
    snapToNode: (lat, lon) => (worker || bootPromise) ? call('snapToNode', lat, lon) : Promise.resolve(null),
    /* 中止目前的運算（例如路線太長算太久）。Worker 會被重開、範圍在背景重新載入。 */
    cancel() {
      const e = new Error('已取消');
      e.cancelled = true;
      restart(e);
    },
    busy: () => pending.size > 0,

    /* 產生 GPX。elev(d) 回傳距起點 d 公尺處的高度，沒有高程資料時傳 null（就不寫 <ele>）。
       · 不再寫死 <ele>0.0</ele>：Strava、Garmin 會把它當成真的海拔，顯示爬升 0m。
       · 相鄰分段的接點只寫一次，避免 0 距離的重複點讓手錶多出奇怪的轉向提示。
       · 起點、終點各加一個 <wpt>。 */
    toGPX(segments, elev) {
      const now = new Date().toISOString();
      const pts = [];
      for (const s of segments) for (const p of s.pts) {
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
      }
      const R = 6371000, rad = Math.PI / 180;
      let cum = 0;
      const body = pts.map((p, i) => {
        if (i) {
          const a = pts[i - 1];
          const dl = (p[0] - a[0]) * rad, dn = (p[1] - a[1]) * rad;
          const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(p[0] * rad) * Math.sin(dn / 2) ** 2;
          cum += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
        }
        const e = elev ? elev(cum) : null;
        const ele = (e != null && isFinite(e)) ? `<ele>${e.toFixed(1)}</ele>` : '';
        return `      <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}">${ele}</trkpt>`;
      }).join('\n');
      const wpt = (p, name) => p ? `  <wpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"><name>${name}</name></wpt>\n` : '';
      return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Running Art" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Running Art</name><time>${now}</time></metadata>
${wpt(pts[0], 'Start')}${wpt(pts[pts.length - 1], 'Finish')}  <trk><name>Running Art</name><type>running</type><trkseg>
${body}
  </trkseg></trk>
</gpx>`;
    },
  };
})();
