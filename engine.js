/*
 * Running Art — 瀏覽器端運算引擎
 * 用 Pyodide 直接執行桌面版同一份 gpsart/ 演算法，不需要任何伺服器。
 */
const Engine = (() => {
  const FILES = ['__init__.py', 'config.py', 'geometry.py', 'graphutil.py',
                 'graphprep.py', 'routing.py', 'export.py'];
  // 演算法版本：更新 gpsart/ 後要一起改，否則瀏覽器會沿用快取的舊演算法
  const VERSION = '20260723a';
  // 多台公用 Overpass 鏡像。全部「同時」發請求，誰先回誰贏（見 fetchOverpass）。
  // 公用伺服器隨時可能塞車，靠並行競速而不是逐台等逾時，是降低失敗率的關鍵。
  // 沒給 CORS 或連不上的鏡像會在競速中自然落敗，不影響其他台。
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];

  let py = null;
  let readyPromise = null;
  let onProgress = () => {};

  /*
   * Pyodide 端的膠水：把 gpsart/ 的演算法包成前端好用的形式。
   * 刻意放在這裡而不是 gpsart/ 裡，因為這些是「瀏覽器版專用」的接線，
   * 不屬於桌面版共用的演算法核心（動了 gpsart/ 就得跑基準測試並同步三份副本）。
   */
  const PY_SETUP = `
import sys
sys.path.insert(0, '/')
import json, math
from gpsart.graphprep import graph_from_overpass_json, prepare_graph
from gpsart.routing import (solve_route, stitch_nearby_strokes,
                            reorder_closed_strokes, bridge_node_path_gaps)
from gpsart.geometry import road_polyline_from_nodes, haversine
from gpsart.graphutil import nearest_node

G = None       # 下載並前處理好的路網（整個分頁共用）
Gw = None      # 這次生成用的副本，見下方 generate 的說明
SEGS = []      # solve_route 的原始分段（含節點編號）—— 微調路徑改的就是它
DRAWN = []     # 手繪點，重算吻合度用
BANNED = set() # 使用者刪掉的節點：重新接路時必須繞過
HISTORY = []   # 復原用的快照


def _pack():
    """把目前的 SEGS 轉成前端要的格式。

    si 是「在 SEGS 裡的索引」。前端微調時必須用 si 指回正確的段，
    不能用回傳陣列的索引 —— 太短的段會被跳過，兩者對不起來。
    """
    out = []
    total = 0.0
    for si, seg in enumerate(SEGS):
        pts = road_polyline_from_nodes(Gw, seg['nodes']) if seg.get('nodes') else (seg.get('coords') or [])
        pts = [(float(a), float(b)) for a, b in pts]
        if len(pts) < 2:
            continue
        d = sum(haversine(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1))
        total += d
        # 可編輯的節點座標。查不到的節點放 None 佔位，
        # 這樣陣列索引才會和 seg['nodes'] 一一對應（前端就是靠索引指定要刪哪個）。
        nodes = []
        for n in (seg.get('nodes') or []):
            if n in Gw.nodes:
                nodes.append((float(Gw.nodes[n]['y']), float(Gw.nodes[n]['x'])))
            else:
                nodes.append(None)
        out.append({'si': si, 'kind': seg.get('kind', 'draw'),
                    'pts': pts, 'len': d, 'nodes': nodes})

    # 吻合度：路線取樣點有多少落在手繪線 40m 內
    hit = 0
    samples = 0
    for seg in out:
        if seg['kind'] != 'draw':
            continue
        for p in seg['pts'][::3]:
            samples += 1
            best = min((haversine(p[0], p[1], q[0], q[1]) for q in DRAWN), default=9e9)
            if best <= 40:
                hit += 1
    fit = (hit / samples * 100.0) if samples else 0.0

    return json.dumps({'ok': True, 'segments': out, 'total_m': total,
                       'fit': fit, 'undo': len(HISTORY)})


def _bridge_graph():
    """接路時用的圖：排除使用者刪掉的節點，才會「繞過」而不是把它接回來。"""
    if not BANNED:
        return Gw
    try:
        return Gw.subgraph([n for n in Gw.nodes if n not in BANNED])
    except Exception:
        return Gw


def _snapshot():
    return ([list(s.get('nodes') or []) for s in SEGS], set(BANNED))


def _restore(snap):
    nds, banned = snap
    for seg, arr in zip(SEGS, nds):
        if seg.get('nodes'):
            seg['nodes'] = list(arr)
    BANNED.clear()
    BANNED.update(banned)


def _has_break():
    """檢查有沒有因為「繞不過去」而留下的斷線。"""
    for seg in SEGS:
        nd = seg.get('nodes') or []
        for i in range(len(nd) - 1):
            a, b = nd[i], nd[i + 1]
            if Gw.has_edge(a, b) or Gw.has_edge(b, a):
                continue
            try:
                if haversine(Gw.nodes[a]['y'], Gw.nodes[a]['x'],
                             Gw.nodes[b]['y'], Gw.nodes[b]['x']) > 25:
                    return True
            except Exception:
                pass
    return False


def _edit_delete(picks):
    """刪除選取的節點，邏輯與桌面版 RouteEditor.delete_selected 一致。

    picks: [{'si': 段索引, 'n': 節點索引}, ...]
    """
    by_seg = {}
    for p in picks:
        by_seg.setdefault(int(p['si']), []).append(int(p['n']))

    snap = _snapshot()
    removed = 0
    for si, idxs in by_seg.items():
        if not (0 <= si < len(SEGS)):
            continue
        seg = SEGS[si]
        arr = seg.get('nodes')
        if not arr:
            continue
        idxs = sorted({i for i in idxs if 0 <= i < len(arr)})
        if len(arr) - len(idxs) < 2:
            continue   # 這段會被刪光，跳過
        # [關鍵] 先把要刪的節點列入禁行，重新接路時才會繞過它們；
        # 否則沿最短路接回來會把剛刪掉的點原封不動放回去，看起來像沒刪成功。
        for i in idxs:
            BANNED.add(arr[i])
        for i in reversed(idxs):
            del arr[i]
            removed += 1
        # 繞過被刪的節點、沿真實道路把缺口接回，避免直線切過建築物
        try:
            seg['nodes'] = bridge_node_path_gaps(_bridge_graph(), arr)
        except Exception:
            pass

    if removed == 0:
        _restore(snap)
        return json.dumps({'ok': False, 'reason': 'none'})
    if _has_break():
        _restore(snap)
        return json.dumps({'ok': False, 'reason': 'break'})

    HISTORY.append(snap)
    del HISTORY[:-40]
    return _pack()


def _edit_undo():
    if not HISTORY:
        return json.dumps({'ok': False, 'reason': 'empty'})
    _restore(HISTORY.pop())
    return _pack()


def _reverse():
    """反轉整條路線的方向：段的順序反過來，每段內部的節點與座標也反過來。"""
    SEGS.reverse()
    for seg in SEGS:
        if seg.get('nodes'):
            seg['nodes'] = list(reversed(seg['nodes']))
        if seg.get('coords'):
            seg['coords'] = list(reversed(seg['coords']))
    # 段落順序變了，舊的復原快照會對到錯的段，直接清掉比留著安全
    HISTORY.clear()
    return _pack()
`;

  function setProgress(fn) { onProgress = fn || (() => {}); }

  async function boot() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      onProgress('載入運算引擎…');
      py = await loadPyodide();
      onProgress('載入數學套件…');
      await py.loadPackage(['micropip', 'numpy']);
      onProgress('載入路網套件…');
      await py.runPythonAsync(`
import micropip
await micropip.install("networkx")
await micropip.install("shapely")
`);
      onProgress('載入演算法…');
      py.FS.mkdir('/gpsart');
      for (const f of FILES) {
        const r = await fetch('gpsart/' + f + '?v=' + VERSION);
        if (!r.ok) throw new Error('讀不到 gpsart/' + f);
        py.FS.writeFile('/gpsart/' + f, new Uint8Array(await r.arrayBuffer()));
      }
      await py.runPythonAsync(PY_SETUP);
      onProgress('');
      return py;
    })();
    return readyPromise;
  }

  // ===== 已下載範圍的本地快取（IndexedDB）=====
  // 下載成功的整份 Overpass JSON 存起來，之後只要新範圍「被某個已存範圍涵蓋」
  // 就直接重用、完全不連網。使用者反覆測試同一區時特別有用（也能離線）。
  const CACHE_DB = 'runart-maps', CACHE_STORE = 'areas', CACHE_MAX = 12;

  function openCache() {
    return new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(CACHE_DB, 1); }
      catch (e) { return rej(e); }
      r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  // 找一個 bbox 完全涵蓋 [s,w,n,e] 的已存範圍，回傳它的原始 JSON 文字
  async function cacheFind(s, w, n, e) {
    let db;
    try { db = await openCache(); } catch (_) { return null; }
    return new Promise((res) => {
      const out = { hit: null };
      const cur = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { db.close(); return res(out.hit); }
        const a = c.value;
        if (a.s <= s && a.w <= w && a.n >= n && a.e >= e) { out.hit = a.raw; db.close(); return res(a.raw); }
        c.continue();
      };
      cur.onerror = () => { db.close(); res(null); };
    });
  }
  async function cachePut(s, w, n, e, raw) {
    let db;
    try { db = await openCache(); } catch (_) { return; }
    try {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const st = tx.objectStore(CACHE_STORE);
      st.put({ key: `${s},${w},${n},${e}`, s, w, n, e, raw, ts: Date.now() });
      // 超過上限就把最舊的刪掉，避免無限長大
      st.getAll().onsuccess = (ev) => {
        const all = ev.target.result || [];
        if (all.length > CACHE_MAX) {
          all.sort((x, y) => x.ts - y.ts).slice(0, all.length - CACHE_MAX)
            .forEach(o => st.delete(o.key));
        }
      };
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch (_) { /* 快取失敗不影響主流程 */ }
    finally { db.close(); }
  }

  // 同時向所有 Overpass 鏡像發請求，誰先成功就用誰的，其餘取消。
  function fetchOverpass(query) {
    const ctrls = OVERPASS.map(() => new AbortController());
    const attempt = (url, i) => {
      const timer = setTimeout(() => ctrls[i].abort(), 30000);
      return fetch(url, { method: 'POST', body: query, signal: ctrls[i].signal })
        .then(res => {
          if (res.status === 429 || res.status === 504) throw new Error('忙碌 ' + res.status);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(text => {
          if (!text || text.length < 200) throw new Error('空白');
          // Overpass 「軟逾時」會回 HTTP 200 但 elements 為空、只帶一段 remark。
          // 這種要當成失敗，讓競速去試別台，而不是收下空資料害後面建圖崩掉。
          if (/"remark"\s*:\s*"[^"]*(timed out|runtime error)/i.test(text)) throw new Error('伺服器逾時');
          if (!text.includes('"type":"node"')) throw new Error('無資料');
          return text;
        })
        .finally(() => clearTimeout(timer));
    };
    // Promise.any：任一成功即回傳；全部失敗才 reject
    return Promise.any(OVERPASS.map((u, i) => attempt(u, i)))
      .then(text => { ctrls.forEach(c => c.abort()); return text; })
      .catch(() => { throw new Error('所有伺服器都無回應'); });
  }

  /* 下載指定範圍的路網，並完成前處理 */
  async function loadArea(s, w, n, e) {
    await boot();

    // 1) 先看本地快取有沒有涵蓋這個範圍的，有就完全不連網
    let raw = await cacheFind(s, w, n, e), fromNet = false;
    if (raw) {
      onProgress('使用已下載的地圖…');
    } else {
      // 25 秒是「伺服器端」逾時，讓塞住的機器早點放棄、把機會讓給別台
      const query = `[out:json][timeout:25];(way["highway"](${s},${w},${n},${e});>;);out body qt;`;
      // 公用伺服器 504 常是暫時的，整輪競速失敗就短暫等一下再試一輪
      for (let round = 0; round < 2 && !raw; round++) {
        onProgress(round === 0 ? '下載路網（同時向多台伺服器請求）…' : '伺服器忙碌，重試中…');
        try { raw = await fetchOverpass(query); }
        catch (_) { if (round === 0) await new Promise(r => setTimeout(r, 1500)); }
      }
      if (!raw) {
        throw new Error('地圖下載失敗：目前公用伺服器（Overpass）都很忙碌。' +
                        '請縮小範圍、或等一兩分鐘再試。已下載過的範圍會被記住，可以離線重用。');
      }
      fromNet = true;
    }

    onProgress('建立路網…');
    py.globals.set('raw_json', raw);
    // G0 空的時候不要呼叫 prepare_graph（它的 max(connected_components) 會炸），
    // 改成回報 0 節點，讓下面丟出乾淨的錯誤訊息。
    const stats = JSON.parse(await py.runPythonAsync(`
data = json.loads(raw_json)
G0 = graph_from_overpass_json(data)
G = prepare_graph(G0) if G0.number_of_nodes() else G0
json.dumps({'nodes': G.number_of_nodes(), 'edges': G.number_of_edges()})
`));
    onProgress('');
    if (!stats.nodes) {
      throw new Error('這個範圍抓不到可跑的道路（伺服器可能回了空資料）。請換個地點、把範圍放大一點或稍後再試。');
    }
    if (fromNet) await cachePut(s, w, n, e, raw);   // 只快取「成功且非空」的結果
    return stats;
  }

  /* 把手繪筆畫對齊到真實道路 */
  async function generate(strokes, start, end) {
    await boot();
    onProgress('對齊道路中…');
    py.globals.set('strokes_json', JSON.stringify(strokes));
    py.globals.set('start_json', JSON.stringify(start));
    py.globals.set('end_json', JSON.stringify(end));
    const out = await py.runPythonAsync(`
strokes = json.loads(strokes_json)
start = tuple(json.loads(start_json))
end = tuple(json.loads(end_json))
strokes = [[tuple(p) for p in s] for s in strokes if len(s) > 1]
metas = [{'type': 'raw'} for _ in strokes]

# 依「整體圖形大小」決定容許誤差：小圖用小門檻、大圖用大門檻，
# 才不會小圖被亂縫、大圖又縫不起來。取整體對角線的 4%，夾在 15~120m。
_all = [p for s in strokes for p in s]
if _all:
    _lat = [p[0] for p in _all]; _lon = [p[1] for p in _all]
    _diag = haversine(min(_lat), min(_lon), max(_lat), max(_lon))
    TOL = max(15.0, min(120.0, _diag * 0.04))
else:
    TOL = 50.0

# 1) 把「畫斷掉但很近」「交錯但很近」的筆畫視為同一筆接起來
strokes, metas = stitch_nearby_strokes(strokes, metas=metas, tolerance_m=TOL)
# 2) 閉合圖形（例如圓）旋轉起點，讓它從「離使用者起點最近的地方」開始畫，
#    而不是從當初下筆的那個隨機位置開始
strokes = reorder_closed_strokes(strokes, start, close_tol_m=TOL)
metas = [{'type': 'raw'} for _ in strokes]

# 重要：route_in_corridor 會永久調高走過的邊的 travel_weight（避免重複走）。
# 若直接在 G 上算，第二次以後的生成就會被上一次的權重污染、結果越來越差。
# 桌面版每次都會重新裁切出一份新圖才不會出事，這裡改成用副本。
Gw = G.copy()
segs = solve_route(Gw, strokes, start, end, False,
                   full_G=Gw, G_drive=Gw, strokes_meta=metas, G_connect=Gw)

# 重設微調狀態：新的一次生成，之前刪過的節點與復原紀錄都不再適用
SEGS[:] = segs
DRAWN[:] = [p for s in strokes for p in s]
BANNED.clear()
HISTORY.clear()

_pack()
`);
    onProgress('');
    return JSON.parse(out);
  }

  /* ---- 微調路徑 ----
   * picks: [{si, n}]，si 是 generate 回傳的段 si，n 是該段 nodes 陣列的索引。
   * 成功回傳與 generate 相同格式；失敗回傳 {ok:false, reason}，
   * 且 Python 端已自動復原，前端不必善後。
   */
  async function editDelete(picks) {
    await boot();
    onProgress('重新接路中…');
    try {
      py.globals.set('picks_json', JSON.stringify(picks));
      return JSON.parse(await py.runPythonAsync(`_edit_delete(json.loads(picks_json))`));
    } finally {
      onProgress('');
    }
  }

  async function editUndo() {
    await boot();
    return JSON.parse(await py.runPythonAsync(`_edit_undo()`));
  }

  /* 反轉路線方向。回傳與 generate 相同格式（si 會重新編號，微調要重建節點圖層）。 */
  async function reverseRoute() {
    await boot();
    return JSON.parse(await py.runPythonAsync(`_reverse()`));
  }

  /* 產生 GPX（沿用桌面版的輸出格式） */
  function toGPX(segments) {
    const now = new Date().toISOString();
    const pts = [];
    for (const s of segments) for (const p of s.pts) pts.push(p);
    const body = pts.map(p => `      <trkpt lat="${p[0]}" lon="${p[1]}"><ele>0.0</ele></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Running Art" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${now}</time></metadata>
  <trk><name>Running Art</name><trkseg>
${body}
  </trkseg></trk>
</gpx>`;
  }

  return { boot, loadArea, generate, editDelete, editUndo, reverseRoute, toGPX, setProgress };
})();
