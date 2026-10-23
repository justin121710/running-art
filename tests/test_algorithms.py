"""演算法的行為測試。執行：python -m pytest tests

小型合成路網測單一函式的行為（含過去發生過的回歸），
真實路網（tests/data/helsinki）測端對端的品質不能比基準差。
"""
import json
import math
import os
import sys

import networkx as nx
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from gpsart import graphprep, routing, web_api  # noqa: E402
from gpsart.geometry import haversine, road_polyline_from_nodes  # noqa: E402
from gpsart.graphutil import nearest_node, unique_neighbors  # noqa: E402

LAT0, LON0 = 25.05, 121.53
M_LAT = 111320.0
KX = M_LAT * math.cos(math.radians(LAT0))


def ll(x, y):
    """平面公尺 → (lat, lon)，原點在 (LAT0, LON0)。"""
    return (LAT0 + y / M_LAT, LON0 + x / KX)


def overpass(nodes, ways):
    """nodes: {id: (x,y)}, ways: [(node_ids, tags)] → Overpass JSON dict。"""
    el = [{'type': 'node', 'id': i, 'lat': ll(*p)[0], 'lon': ll(*p)[1]} for i, p in nodes.items()]
    el += [{'type': 'way', 'id': 1000 + k, 'nodes': ns, 'tags': tags} for k, (ns, tags) in enumerate(ways)]
    return {'elements': el}


def grid(n=8, block=80.0, hw='residential'):
    """n×n 的棋盤路網，每段路都是一條 way（中間點不會被角度簡化掉的路口）。"""
    nodes, ways = {}, []
    nid = lambda i, j: 1 + i * n + j
    for i in range(n):
        for j in range(n):
            nodes[nid(i, j)] = (j * block, i * block)
    for i in range(n):
        ways.append(([nid(i, j) for j in range(n)], {'highway': hw}))
        ways.append(([nid(j, i) for j in range(n)], {'highway': hw}))
    return nodes, ways


def load(data):
    return web_api.load_area_json(json.dumps(data))


# ---------------------------------------------------------------
# 路網前處理
# ---------------------------------------------------------------
def test_degree_is_misleading_on_bidirectional_graph():
    """MultiDiGraph 雙向邊：死路端點 degree 是 2、直路中間是 4。要用 unique_neighbors。"""
    G = nx.MultiDiGraph()
    for a, b in [(1, 2), (2, 3), (3, 4), (3, 5)]:
        G.add_edge(a, b); G.add_edge(b, a)
    assert dict(G.degree())[1] == 2
    assert len(unique_neighbors(G, 1)) == 1
    assert len(unique_neighbors(G, 2)) == 2
    assert len(unique_neighbors(G, 3)) == 3


def test_short_spurs_pruned_but_long_dead_ends_kept():
    nodes = {1: (0, 0), 2: (100, 0), 3: (200, 0), 4: (100, 10), 5: (100, -200)}
    ways = [([1, 2, 3], {'highway': 'residential'}),
            ([2, 4], {'highway': 'footway'}),          # 10m 小短線 → 剪
            ([2, 5], {'highway': 'residential'})]       # 200m 死巷 → 留
    G = graphprep.prune_short_spurs(graphprep.graph_from_overpass_json(overpass(nodes, ways)), 30)
    assert 4 not in G and 5 in G and 1 in G


@pytest.mark.parametrize('tags,ok', [
    ({'highway': 'residential'}, True),
    ({'highway': 'residential', 'foot': 'no'}, False),
    ({'highway': 'service', 'access': 'private'}, False),
    ({'highway': 'service', 'access': 'private', 'foot': 'yes'}, True),
    ({'highway': 'trunk'}, False),
    ({'highway': 'trunk', 'sidewalk': 'both'}, True),
    ({'highway': 'primary', 'motorroad': 'yes'}, False),
    ({'highway': 'motorway'}, False),
    ({'highway': 'footway', 'footway': 'sidewalk'}, True),
])
def test_walk_allowed(tags, ok):
    assert graphprep._walk_allowed(tags) is ok


def test_straight_merge_keeps_crossing_tag():
    """人行道 + 行人穿越道不能被合成一條（穿越道不罰的設計會失效）。"""
    nodes = {1: (0, 0), 2: (50, 0), 3: (60, 0), 4: (110, 0), 5: (50, 50), 6: (60, -50)}
    ways = [([1, 2], {'highway': 'footway'}), ([2, 3], {'highway': 'footway', 'footway': 'crossing'}),
            ([3, 4], {'highway': 'footway'}), ([2, 5], {'highway': 'footway'}), ([3, 6], {'highway': 'footway'})]
    G = graphprep.graph_from_overpass_json(overpass(nodes, ways))
    G = graphprep.remove_redundant_straight_nodes(G)
    assert any(d.get('footway') == 'crossing' for _, _, d in G.edges(data=True))


def test_penalties():
    P = graphprep.edge_penalty
    assert P({'highway': 'footway', 'footway': 'crossing'}) == 1.0
    assert P({'highway': 'footway', 'footway': 'sidewalk'}) > P({'highway': 'path'}) > 1.0
    assert P({'highway': 'steps'}) > P({'highway': 'footway'})


def test_islands_reported():
    nodes, ways = grid(4)
    nodes.update({900: (2000, 0), 901: (2050, 0), 902: (2050, 50), 903: (2000, 50), 904: (2025, 80), 905: (2025, 25)})
    ways.append(([900, 901, 902, 903, 900], {'highway': 'path'}))
    ways.append(([903, 904, 902], {'highway': 'path'}))
    ways.append(([900, 905, 902], {'highway': 'path'}))
    st = load(overpass(nodes, ways))
    assert st['nodes'] == 16
    assert len(st['islands']) == 1


# ---------------------------------------------------------------
# 地圖匹配與路徑清理
# ---------------------------------------------------------------
def rect_stroke(x0, y0, x1, y1, wob=3.0):
    pts = []
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    for (ax, ay), (bx, by) in zip(corners[:-1], corners[1:]):
        for k in range(12):
            t = k / 12
            pts.append((ax + (bx - ax) * t + wob * math.sin(len(pts)), ay + (by - ay) * t + wob * math.cos(len(pts))))
    pts.append(pts[0])
    return [ll(x, y) for x, y in pts]


def test_match_follows_grid_rectangle():
    load(overpass(*grid(8)))
    stroke = rect_stroke(80, 80, 400, 320)
    res = web_api.generate([stroke], stroke[0], stroke[0])
    assert res['recall'] > 90 and res['precision'] > 90
    draw = [s for s in res['segments'] if s['kind'] == 'draw']
    length = sum(s['len'] for s in draw)
    assert abs(length - 2 * (320 + 240)) < 80


def test_node_id_zero_is_a_real_node():
    """節點編號 0 不能被當成「沒有節點」（以前到處用真假值判斷）。"""
    nodes, ways = grid(6)
    nodes = {k - 1: v for k, v in nodes.items()}
    ways = [([n - 1 for n in ns], t) for ns, t in ways]
    load(overpass(nodes, ways))
    assert 0 in web_api.G
    start = ll(0, 0)
    assert nearest_node(web_api.G, start[1], start[0]) == 0
    stroke = rect_stroke(0, 0, 240, 160)
    res = web_api.generate([stroke], start, start)
    assert res['recall'] > 85
    first = next(s for s in res['segments'] if s['kind'] == 'draw')
    assert abs(first['pts'][0][0] - start[0]) < 1e-6


def test_closed_ring_not_collapsed_by_shortcut():
    """閉合圖形不能被截彎取直整圈抄掉（span_cap 與真實路長的回歸）。"""
    load(overpass(*grid(8)))
    G = web_api.G
    ring = [nearest_node(G, ll(x, y)[1], ll(x, y)[0]) for x, y in
            [(160, 160), (240, 160), (320, 160), (320, 240), (320, 320), (240, 320), (160, 320), (160, 240), (160, 160)]]
    ring = routing.bridge_node_path_gaps(G, ring)
    out = routing.advanced_shortcut_optimizer(G, ring, lookahead=50)
    assert routing.path_length(G, out) > 0.9 * routing.path_length(G, ring)


def test_backtrack_removed_but_circle_kept():
    load(overpass(*grid(8)))
    G = web_api.G
    n = lambda x, y: nearest_node(G, ll(x, y)[1], ll(x, y)[0])
    # 出去 240m 再原路回來
    spur = [n(0, 0), n(80, 0), n(160, 0), n(240, 0), n(160, 0), n(80, 0), n(0, 0), n(0, 80)]
    assert len(routing.remove_backtracks(G, spur)) < len(spur)
    ring = [n(0, 0), n(80, 0), n(160, 0), n(160, 80), n(160, 160), n(80, 160), n(0, 160), n(0, 80), n(0, 0)]
    assert routing.remove_backtracks(G, ring) == ring


def test_drawn_spike_is_kept():
    """使用者自己畫的「出去再回來」（星星的角）不能被當成折返剪掉。"""
    load(overpass(*grid(8)))
    G = web_api.G
    n = lambda x, y: nearest_node(G, ll(x, y)[1], ll(x, y)[0])
    path = [n(0, 0), n(80, 0), n(160, 0), n(240, 0), n(160, 0), n(80, 0), n(80, 80)]
    stroke = [ll(0, 0), ll(240, 0), ll(80, 0), ll(80, 80)]
    assert n(240, 0) in routing.prune_spurs_stack(path, G, stroke)
    assert n(240, 0) not in routing.prune_spurs_stack(path)


def test_stitch_requires_smooth_join():
    a = [ll(0, 0), ll(100, 0)]
    b_cont = [ll(120, 0), ll(220, 0)]          # 同方向接下去 → 縫
    b_turn = [ll(115, 30), ll(0, 30)]          # 折回來 → 不縫
    assert len(routing.stitch_nearby_strokes([a, b_cont], tolerance_m=50)) == 1
    assert len(routing.stitch_nearby_strokes([a, b_turn], tolerance_m=50)) == 2


def test_order_strokes_minimises_connectors():
    s1 = [ll(0, 0), ll(50, 0)]
    s2 = [ll(1000, 0), ll(1050, 0)]
    s3 = [ll(500, 0), ll(550, 0)]
    out = routing.order_strokes([s1, s2, s3], ll(-10, 0), ll(1060, 0))
    assert [o[0] for o in out] == [s1[0], s3[0], s2[0]]


def test_drawing_direction_kept():
    ccw = [ll(100 * math.cos(t), 100 * math.sin(t)) for t in [2 * math.pi * k / 24 for k in range(25)]]
    out = routing.reorder_closed_strokes([ccw], ccw[0])[0]
    # 第二個點仍然是逆時針方向
    assert out[1] == ccw[1]


# ---------------------------------------------------------------
# 吻合度與微調
# ---------------------------------------------------------------
def test_match_score_penalises_half_coverage():
    stroke = [ll(0, 0), ll(400, 0)]
    half = [ll(0, 0), ll(200, 0)]
    f1, prec, rec = web_api.match_score([half], [stroke])
    assert prec > 95 and 40 < rec < 60 and f1 < 75


def test_edit_cycle_and_junctions():
    load(overpass(*grid(8)))
    stroke = rect_stroke(80, 80, 400, 320)
    res = web_api.generate([stroke], stroke[0], stroke[0])
    draw = next(s for s in res['segments'] if s['kind'] == 'draw')
    # 路口候選只能是真的路口（不重複鄰居 >= 3）
    j = web_api.nearby_junctions(draw['nodes'][2][0], draw['nodes'][2][1], 200, 20)
    assert j and all(len(unique_neighbors(web_api.G, type(next(iter(web_api.G.nodes)))(x['id']))) >= 3 for x in j)
    k = len(draw['nodes']) // 2
    r = web_api.edit_delete([{'si': draw['si'], 'n': k}])
    assert r['ok'] and r['undo'] == 1
    r = web_api.edit_undo()
    assert r['ok'] and r['undo'] == 0
    pv = web_api.preview_move(draw['si'], k, j[0]['id'])
    assert pv['ok'] and len(pv['pts']) >= 2
    r = web_api.reverse_route()
    assert r['ok'] and r['undo'] == 0


# ---------------------------------------------------------------
# 真實路網的品質不能比基準差
# ---------------------------------------------------------------
@pytest.mark.slow
def test_bench_not_worse_than_baseline():
    import bench
    base = json.load(open(os.path.join(HERE, 'baseline_bench.json'), encoding='utf-8'))
    res = bench.run()
    for k, m in res.items():
        b = base[k]
        f1 = lambda x: 2 * x['prec'] * x['recall'] / (x['prec'] + x['recall'])
        assert f1(m) >= f1(b) - 0.03, (k, m, b)
        assert m['len'] <= b['len'] * 1.15 + 50, (k, m, b)
