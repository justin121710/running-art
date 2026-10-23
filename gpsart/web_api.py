"""瀏覽器版的對外介面（在 Web Worker 裡的 Pyodide 執行，engine-worker.js 呼叫）。

以前這段膠水寫在 engine.js 的字串裡，不能 lint、不能測試；搬到這裡之後
tests/ 可以直接 import 來測（見 tests/test_web_api.py）。

所有函式回傳可以直接 json.dumps 的 dict / list。
狀態放在模組層級：一個 Worker 就是一個使用者分頁，同時只有一份路網與一條路線。
"""
import json

import numpy as np
from shapely.geometry import MultiLineString, Point

from .config import FIT_TOL_M
from .geometry import LocalProj, haversine, road_polyline_from_nodes
from .graphprep import graph_from_overpass_json, prepare_graph
from .graphutil import nearest_node, node_index, unique_neighbors
from .routing import bridge_node_path_gaps, prepare_strokes, robust_shortest_path, solve_route

G = None        # 下載並前處理好的路網
SEGS = []       # solve_route 的分段（含節點編號）—— 微調路徑改的就是它
DRAWN = []      # 前處理後的手繪筆畫，算吻合度用
BANNED = set()  # 使用者刪掉的節點：重新接路時必須繞過
HISTORY = []    # 復原用的快照
HISTORY_MAX = 40


# ---------------------------------------------------------------
# 路網
# ---------------------------------------------------------------
def load_area_json(raw_json):
    """Overpass JSON 文字 → 前處理好的路網。回傳節點數、邊數與孤立區域外框。"""
    global G
    data = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
    G0 = graph_from_overpass_json(data)
    G = prepare_graph(G0) if G0.number_of_nodes() else G0
    SEGS.clear(); DRAWN.clear(); BANNED.clear(); HISTORY.clear()
    return {'nodes': G.number_of_nodes(), 'edges': G.number_of_edges(),
            'islands': G.graph.get('islands', [])}


def _need_graph():
    if G is None or not G.number_of_nodes():
        raise RuntimeError('尚未載入路網')


# ---------------------------------------------------------------
# 吻合度
# ---------------------------------------------------------------
def _densify(pts, proj, step=8.0):
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        ax, ay = proj.xy(a); bx, by = proj.xy(b)
        n = max(1, int(np.hypot(bx - ax, by - ay) / step))
        for k in range(n):
            t = k / n
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    if pts:
        out.append(proj.xy(pts[-1]))
    return out


def match_score(route_polys, strokes, tol=None):
    """
    吻合度 = 準確率與覆蓋率的調和平均（F1）。
      準確率：路線上的點有幾成落在手繪線 tol 公尺內
      覆蓋率：手繪線上的點有幾成被路線蓋到（tol 公尺內）

    以前只算前者，而且是對「手繪點」量距離：路線只跑了半個圖也能 100%，
    手繪點稀疏（滑鼠畫很快）時又會被低估。兩邊都改成點到「線段」的距離。
    """
    if tol is None:
        tol = FIT_TOL_M
    strokes = [s for s in strokes if len(s) > 1]
    route_polys = [r for r in route_polys if len(r) > 1]
    if not strokes or not route_polys:
        return 0.0, 0.0, 0.0
    proj = LocalProj.around([p for s in strokes for p in s])
    draw_g = MultiLineString([[proj.xy(p) for p in s] for s in strokes])
    route_g = MultiLineString([[proj.xy(p) for p in r] for r in route_polys])
    rs = [q for r in route_polys for q in _densify(r, proj)]
    ds = [q for s in strokes for q in _densify(s, proj)]
    prec = float(np.mean([draw_g.distance(Point(q)) <= tol for q in rs])) if rs else 0.0
    rec = float(np.mean([route_g.distance(Point(q)) <= tol for q in ds])) if ds else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0
    return f1 * 100.0, prec * 100.0, rec * 100.0


# ---------------------------------------------------------------
# 打包給前端
# ---------------------------------------------------------------
def _pack():
    """
    把 SEGS 轉成前端格式。si 是「在 SEGS 裡的索引」：前端微調時必須用 si 指回段，
    不能用回傳陣列的索引 —— 太短的段會被跳過，兩者對不起來。
    nodes 裡查不到的節點放 None 佔位，索引才會和 seg['nodes'] 一一對應。
    """
    out = []
    total = 0.0
    for si, seg in enumerate(SEGS):
        pts = road_polyline_from_nodes(G, seg['nodes']) if seg.get('nodes') else (seg.get('coords') or [])
        pts = [(float(a), float(b)) for a, b in pts]
        if len(pts) < 2:
            continue
        d = sum(haversine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) for i in range(len(pts) - 1))
        total += d
        nodes = [(float(G.nodes[n]['y']), float(G.nodes[n]['x'])) if n in G.nodes else None
                 for n in (seg.get('nodes') or [])]
        out.append({'si': si, 'kind': seg.get('kind', 'draw'), 'pts': pts, 'len': d, 'nodes': nodes})
    fit, prec, rec = match_score([s['pts'] for s in out if s['kind'] == 'draw'], DRAWN)
    return {'ok': True, 'segments': out, 'total_m': total, 'fit': fit,
            'precision': prec, 'recall': rec, 'undo': len(HISTORY)}


# ---------------------------------------------------------------
# 生成
# ---------------------------------------------------------------
def generate(strokes, start, end):
    """手繪筆畫 [[(lat,lon),...],...] + 起訖點 → 路線。"""
    _need_graph()
    start = tuple(start) if start else None
    end = tuple(end) if end else None
    prepared = prepare_strokes(strokes, start, end)
    segs = solve_route(G, prepared, start, end)
    SEGS[:] = segs
    DRAWN[:] = prepared
    BANNED.clear()
    HISTORY.clear()
    return _pack()


def snap_to_node(lat, lon):
    if G is None or not G.number_of_nodes():
        return None
    n = nearest_node(G, lon, lat)
    return [float(G.nodes[n]['y']), float(G.nodes[n]['x'])]


# ---------------------------------------------------------------
# 微調
# ---------------------------------------------------------------
def _bridge_graph():
    """接路時用的圖：排除使用者刪掉的節點，才會「繞過」而不是把它接回來。"""
    if not BANNED:
        return G
    return G.subgraph([n for n in G.nodes if n not in BANNED])


def _snapshot():
    return ([list(s.get('nodes') or []) for s in SEGS], set(BANNED))


def _restore(snap):
    nds, banned = snap
    for seg, arr in zip(SEGS, nds):
        if seg.get('nodes'):
            seg['nodes'] = list(arr)
    BANNED.clear()
    BANNED.update(banned)


def _push_history(snap):
    HISTORY.append(snap)
    del HISTORY[:-HISTORY_MAX]


def _has_break():
    """有沒有因為「繞不過去」而留下的斷線（相鄰節點沒有邊、又相距 > 25m）。"""
    for seg in SEGS:
        nd = seg.get('nodes') or []
        for a, b in zip(nd[:-1], nd[1:]):
            if G.has_edge(a, b) or G.has_edge(b, a):
                continue
            if a in G.nodes and b in G.nodes and haversine(
                    G.nodes[a]['y'], G.nodes[a]['x'], G.nodes[b]['y'], G.nodes[b]['x']) > 25:
                return True
    return False


def edit_delete(picks):
    """刪除選取的節點並沿道路重接。picks: [{'si': 段索引, 'n': 節點索引}, ...]"""
    by_seg = {}
    for p in picks:
        by_seg.setdefault(int(p['si']), []).append(int(p['n']))
    snap = _snapshot()
    removed = 0
    for si, idxs in by_seg.items():
        if not (0 <= si < len(SEGS)):
            continue
        arr = SEGS[si].get('nodes')
        if not arr:
            continue
        idxs = sorted({i for i in idxs if 0 <= i < len(arr)})
        if len(arr) - len(idxs) < 2:
            continue   # 這段會被刪光，跳過
        # 先列入禁行，重新接路時才會繞過；否則最短路會把剛刪掉的點原封不動接回來
        for i in idxs:
            BANNED.add(arr[i])
        for i in reversed(idxs):
            del arr[i]
            removed += 1
        SEGS[si]['nodes'] = bridge_node_path_gaps(_bridge_graph(), arr)
    if removed == 0:
        _restore(snap)
        return {'ok': False, 'reason': 'none'}
    if _has_break():
        _restore(snap)
        return {'ok': False, 'reason': 'break'}
    _push_history(snap)
    return _pack()


def _parse_id(new_id):
    """前端傳回來的節點編號是字串；換回路網實際用的型別。"""
    try:
        return type(next(iter(G.nodes)))(new_id)
    except (StopIteration, ValueError, TypeError):
        return new_id


def _moved_path(si, n, new_id):
    if not (0 <= si < len(SEGS)):
        return None, 'seg'
    arr = SEGS[si].get('nodes') or []
    if not (0 <= n < len(arr)):
        return None, 'idx'
    target = _parse_id(new_id)
    if target not in G.nodes:
        return None, 'missing'
    Gb = _bridge_graph()
    left = arr[n - 1] if n > 0 else None
    right = arr[n + 1] if n < len(arr) - 1 else None
    head = robust_shortest_path(Gb, left, target) if left is not None else []
    if left is not None and not head:
        return None, 'unreachable'
    tail = robust_shortest_path(Gb, target, right) if right is not None else []
    if right is not None and not tail:
        return None, 'unreachable'
    if left is None and right is None:
        mid = [target]
    elif left is None:
        mid = tail
    elif right is None:
        mid = head
    else:
        mid = head + tail[1:]
    lo = n - 1 if left is not None else n
    hi = n + 1 if right is not None else n
    return (arr, lo, hi, mid), None


def preview_move(si, n, new_id):
    """「如果把這個節點搬到 new_id」路徑會長怎樣；**不改動 SEGS**（拖曳中反覆呼叫）。"""
    r, _ = _moved_path(int(si), int(n), new_id)
    if r is None:
        return {'ok': False}
    _, _, _, mid = r
    return {'ok': True, 'pts': [(float(a), float(b)) for a, b in road_polyline_from_nodes(G, mid)]}


def edit_move(si, n, new_id):
    """把第 si 段的第 n 個節點搬到 new_id 這個路口，只重接相鄰兩小段。"""
    si, n = int(si), int(n)
    snap = _snapshot()
    r, reason = _moved_path(si, n, new_id)
    if r is None:
        return {'ok': False, 'reason': reason}
    arr, lo, hi, mid = r
    arr[lo:hi + 1] = mid
    SEGS[si]['nodes'] = arr
    if _has_break():
        _restore(snap)
        return {'ok': False, 'reason': 'break'}
    _push_history(snap)
    return _pack()


def edit_undo():
    if not HISTORY:
        return {'ok': False, 'reason': 'empty'}
    _restore(HISTORY.pop())
    return _pack()


def nearby_junctions(lat, lon, radius_m, limit):
    """
    座標附近的「路口」節點（不重複鄰居 >= 3），近到遠。
    只留路口：直路中間的節點移過去不會改變走法。
    ⚠️ 不能用 G.degree：路網是雙向 MultiDiGraph，直路中間的點 degree 就是 4。
    """
    if G is None or not G.number_of_nodes():
        return []
    out = []
    for d, nid in node_index(G).within(lat, lon, radius_m):
        if len(unique_neighbors(G, nid)) >= 3:
            out.append({'id': str(nid), 'lat': float(G.nodes[nid]['y']),
                        'lon': float(G.nodes[nid]['x']), 'd': round(d, 1)})
            if len(out) >= limit:
                break
    return out


def reverse_route():
    """反轉整條路線：段的順序反過來，每段內部的節點與座標也反過來。"""
    SEGS.reverse()
    for seg in SEGS:
        if seg.get('nodes'):
            seg['nodes'] = list(reversed(seg['nodes']))
        if seg.get('coords'):
            seg['coords'] = list(reversed(seg['coords']))
    # 段落順序變了，舊的復原快照會對到錯的段，直接清掉比留著安全
    HISTORY.clear()
    return _pack()
