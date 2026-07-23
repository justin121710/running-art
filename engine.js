/*
 * Running Art — 瀏覽器端運算引擎
 * 用 Pyodide 直接執行桌面版同一份 gpsart/ 演算法，不需要任何伺服器。
 */
const Engine = (() => {
  const FILES = ['__init__.py', 'config.py', 'geometry.py', 'graphutil.py',
                 'graphprep.py', 'routing.py', 'export.py'];
  // 演算法版本：更新 gpsart/ 後要一起改，否則瀏覽器會沿用快取的舊演算法
  const VERSION = '20260723a';
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  let py = null;
  let readyPromise = null;
  let onProgress = () => {};

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
      await py.runPythonAsync(`
import sys
sys.path.insert(0, '/')
import json, math
from gpsart.graphprep import graph_from_overpass_json, prepare_graph
from gpsart.routing import solve_route, stitch_nearby_strokes, reorder_closed_strokes
from gpsart.geometry import road_polyline_from_nodes, haversine
from gpsart.graphutil import nearest_node
G = None
`);
      onProgress('');
      return py;
    })();
    return readyPromise;
  }

  /* 下載指定範圍的路網，並完成前處理 */
  async function loadArea(s, w, n, e) {
    await boot();
    const query = `[out:json][timeout:60];(way["highway"](${s},${w},${n},${e});>;);out body;`;
    let raw = null, lastErr = null;
    // 每台伺服器都要有逾時，否則 Overpass 忙碌時 fetch 會一直卡住、使用者只能重整
    for (let i = 0; i < OVERPASS.length; i++) {
      const url = OVERPASS[i];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      try {
        onProgress(i === 0 ? '下載路網…' : `主伺服器忙碌，改用備援 (${i + 1}/${OVERPASS.length})…`);
        const res = await fetch(url, { method: 'POST', body: query, signal: ctrl.signal });
        if (res.status === 429 || res.status === 504) throw new Error('伺服器忙碌 (' + res.status + ')');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        raw = await res.text();
        if (raw && raw.length > 200) break;
        raw = null;
        throw new Error('回傳空白資料');
      } catch (err) {
        lastErr = err.name === 'AbortError' ? new Error('連線逾時') : err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!raw) {
      throw new Error('地圖下載失敗（' + (lastErr ? lastErr.message : '未知') +
                      '）。Overpass 是免費公用伺服器，短時間內下載太多次會被限流，請等一兩分鐘再試，或縮小範圍。');
    }

    onProgress('建立路網…');
    py.globals.set('raw_json', raw);
    const stats = await py.runPythonAsync(`
data = json.loads(raw_json)
G = prepare_graph(graph_from_overpass_json(data))
json.dumps({'nodes': G.number_of_nodes(), 'edges': G.number_of_edges()})
`);
    onProgress('');
    return JSON.parse(stats);
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

out_segs = []
total = 0.0
for seg in segs:
    pts = road_polyline_from_nodes(Gw, seg['nodes']) if seg.get('nodes') else (seg.get('coords') or [])
    pts = [(float(a), float(b)) for a, b in pts]
    if len(pts) < 2:
        continue
    d = sum(haversine(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1))
    total += d
    out_segs.append({'kind': seg.get('kind', 'draw'), 'pts': pts, 'len': d})

# 吻合度：路線取樣點有多少落在手繪線 40m 內
drawn = [p for s in strokes for p in s]
hit = 0
samples = 0
for seg in out_segs:
    if seg['kind'] != 'draw':
        continue
    for p in seg['pts'][::3]:
        samples += 1
        best = min((haversine(p[0], p[1], q[0], q[1]) for q in drawn), default=9e9)
        if best <= 40:
            hit += 1
fit = (hit / samples * 100.0) if samples else 0.0

json.dumps({'segments': out_segs, 'total_m': total, 'fit': fit})
`);
    onProgress('');
    return JSON.parse(out);
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

  return { boot, loadArea, generate, toGPX, setProgress };
})();
