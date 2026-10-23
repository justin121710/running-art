"""路網前處理：從 Overpass JSON 建圖、剪短分岔、角度簡化、只留主連通塊、算道路成本。"""
from shapely.geometry import LineString, MultiPoint

from .config import (debug_log, CROSSING_PENALTY, FOOTWAY_PENALTY, SIDEWALK_PENALTY,
                     PATH_PENALTY, STEPS_PENALTY, MINOR_ROAD_PENALTY, MAJOR_ROAD_PENALTY,
                     TRUNK_PENALTY, SPUR_PRUNE_M)
from .geometry import get_bearing, haversine
from .graphutil import unique_neighbors


def _first(v):
    """OSM 標籤有時是 list，取第一個。"""
    return v[0] if isinstance(v, list) else v


def _edge_len(G, a, b):
    ed = G.get_edge_data(a, b) or G.get_edge_data(b, a)
    if not ed:
        return haversine(G.nodes[a]['y'], G.nodes[a]['x'], G.nodes[b]['y'], G.nodes[b]['x'])
    return min(d.get('length', 0.0) for d in ed.values())


def prune_short_spurs(G, max_len_m=None, rounds=2):
    """
    剪掉「很短的死路分岔」：人行道接到馬路的小短線、車道出入口之類。
    走廊尋路很容易一頭鑽進去再折返，畫出一根小刺。

    以前的 remove_recursive_dead_ends 用 G.degree()==1 判斷死路，
    但路網每條路都存成雙向兩條邊，死路端點的 degree 是 2，所以**一個都沒剪到**。
    這裡改用不重複鄰居數，而且只剪總長 < max_len_m 的分岔——
    整條死巷（很多人家門口就是）不能剪，否則起訖點會被吸到很遠的地方。
    """
    if max_len_m is None:
        max_len_m = SPUR_PRUNE_M
    if not max_len_m or max_len_m <= 0:
        return G
    removed = 0
    for _ in range(rounds):
        leaves = [n for n in G.nodes if len(unique_neighbors(G, n)) == 1]
        doomed = set()
        for leaf in leaves:
            chain = [leaf]
            prev, cur = None, leaf
            total = 0.0
            ok = False
            while True:
                nb = unique_neighbors(G, cur) - ({prev} if prev is not None else set())
                if len(nb) != 1:
                    break
                nxt = next(iter(nb))
                total += _edge_len(G, cur, nxt)
                if total >= max_len_m:
                    break
                if len(unique_neighbors(G, nxt)) >= 3:
                    ok = True          # 走到路口了，這一串就是一根短分岔
                    break
                chain.append(nxt)
                prev, cur = cur, nxt
            if ok:
                doomed.update(chain)
        if not doomed:
            break
        G.remove_nodes_from(doomed)
        removed += len(doomed)
    debug_log(f"[前處理] 剪除 {removed} 個短分岔節點（< {max_len_m}m）")
    return G


def _same_kind(d1, d2):
    """兩條邊的道路種類一樣才能合併，否則成本（人行道／穿越道懲罰）會算錯。"""
    return (_first(d1.get('highway')) == _first(d2.get('highway')) and
            _first(d1.get('footway')) == _first(d2.get('footway')))


def _first_edge(G, a, b):
    ed = G.get_edge_data(a, b)
    if not ed:
        return None
    return ed[min(ed, key=lambda k: ed[k].get('length', float('inf')))]


def _merge_dir(G, a, n, b):
    """把 a->n->b 兩條邊合成一條 a->b（含幾何）。"""
    d1, d2 = _first_edge(G, a, n), _first_edge(G, n, b)
    if d1 is None or d2 is None:
        return
    new_data = dict(d1)
    new_data['length'] = d1.get('length', 0) + d2.get('length', 0)
    g1, g2 = d1.get('geometry'), d2.get('geometry')
    c1 = list(g1.coords) if g1 is not None else [(G.nodes[a]['x'], G.nodes[a]['y']), (G.nodes[n]['x'], G.nodes[n]['y'])]
    c2 = list(g2.coords) if g2 is not None else [(G.nodes[n]['x'], G.nodes[n]['y']), (G.nodes[b]['x'], G.nodes[b]['y'])]
    coords = c1[:-1] + c2
    if len(coords) >= 2:
        new_data['geometry'] = LineString(coords)
    G.add_edge(a, b, **new_data)


def remove_redundant_straight_nodes(G, angle_threshold=20):
    """
    角度簡化：移除「只有兩個鄰居、而且幾乎是直線」的中間節點，把兩條邊合併
    （邊上保留原本的彎曲幾何）。轉角節點保留，給吸附用。

    只合併同一種道路的兩條邊（見 _same_kind）。以前會把「人行道 + 行人穿越道」
    合成一條、標籤只留前一段的，穿越道不懲罰的設計就失效了。
    """
    plan = []
    for n in list(G.nodes()):
        adj = unique_neighbors(G, n)
        if len(adj) != 2:
            continue
        u, v = list(adj)
        try:
            b1 = get_bearing(G.nodes[u]['y'], G.nodes[u]['x'], G.nodes[n]['y'], G.nodes[n]['x'])
            b2 = get_bearing(G.nodes[n]['y'], G.nodes[n]['x'], G.nodes[v]['y'], G.nodes[v]['x'])
        except KeyError:
            continue
        diff = abs(b1 - b2)
        if diff > 180:
            diff = 360 - diff
        if diff >= angle_threshold:
            continue
        d_un = _first_edge(G, u, n) or _first_edge(G, n, u)
        d_nv = _first_edge(G, n, v) or _first_edge(G, v, n)
        if d_un is None or d_nv is None or not _same_kind(d_un, d_nv):
            continue
        plan.append((n, u, v))

    count = 0
    for n, u, v in plan:
        # 前面的合併可能已經改掉了鄰居關係，要重新確認
        if n not in G or unique_neighbors(G, n) != {u, v}:
            continue
        if G.has_edge(u, n) and G.has_edge(n, v):
            _merge_dir(G, u, n, v)
        if G.has_edge(v, n) and G.has_edge(n, u):
            _merge_dir(G, v, n, u)
        G.remove_node(n)
        count += 1
    if count:
        debug_log(f"[前處理] 角度簡化移除 {count} 個直線節點（< {angle_threshold}°）")
    return G


# ==========================================================
# 從 Overpass JSON 直接建圖（不需要 osmnx）
# ==========================================================

# 可以跑步/走路的道路類型。
# trunk／trunk_link 刻意不在這裡：台灣的快速道路、市區高架在 OSM 多半標成 trunk，
# 行人禁止進入。真的可以走的 trunk 會標 foot=yes／sidewalk，見 _walk_allowed。
WALKABLE = {
    'footway', 'residential', 'service', 'tertiary', 'tertiary_link',
    'secondary', 'secondary_link', 'primary', 'primary_link',
    'living_street', 'pedestrian', 'path', 'unclassified', 'steps',
    'track', 'cycleway', 'road', 'bridleway',
}
TRUNK = {'trunk', 'trunk_link'}
# 禁止進入的 access 值（私人道路、禁行）
BLOCKED_ACCESS = {'private', 'no', 'customers', 'delivery', 'restricted', 'agricultural', 'forestry'}
FOOT_YES = {'yes', 'designated', 'permissive', 'official'}
FOOT_NO = {'no', 'private', 'use_sidepath'}

# 下載用的 Overpass 篩選：在伺服器端就把顯然不能走的路濾掉，少傳很多資料。
# 細節（access 與 foot 的優先順序）在 _walk_allowed 判斷，這裡只做粗篩。
OVERPASS_FILTER = ('["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|'
                   'abandoned|platform|raceway|bus_guideway|escape|elevator)$"]'
                   '["foot"!~"^(no|private|use_sidepath)$"]["motorroad"!="yes"]["area"!="yes"]')


def _walk_allowed(tags):
    """這條路可不可以走。foot 標籤優先於 access（access=private + foot=yes 是可以走的）。"""
    hw = _first(tags.get('highway'))
    foot = str(_first(tags.get('foot', ''))).lower()
    if foot in FOOT_NO:
        return False
    if str(_first(tags.get('motorroad', ''))).lower() == 'yes':
        return False
    if hw in TRUNK:
        # 快速道路只在明確允許行人或有人行道時才收
        sidewalk = str(_first(tags.get('sidewalk', ''))).lower()
        return foot in FOOT_YES or sidewalk in ('both', 'left', 'right', 'yes', 'separate')
    if hw not in WALKABLE:
        return False
    if foot in FOOT_YES:
        return True
    return str(_first(tags.get('access', ''))).lower() not in BLOCKED_ACCESS


def graph_from_overpass_json(data):
    """
    把 Overpass API 回傳的 JSON 直接轉成 networkx 圖。
    步行路網視為雙向（每條路存兩條方向相反的邊）。
    """
    import networkx as nx

    pos = {e['id']: (e['lat'], e['lon'])
           for e in data.get('elements', []) if e.get('type') == 'node'}

    G = nx.MultiDiGraph()
    G.graph['crs'] = 'epsg:4326'

    for e in data.get('elements', []):
        if e.get('type') != 'way':
            continue
        tags = e.get('tags') or {}
        if not _walk_allowed(tags):
            continue
        hw = _first(tags.get('highway'))
        attrs_base = {'highway': hw}
        for k in ('footway', 'name'):
            v = _first(tags.get(k))
            if v:
                attrs_base[k] = v
        nds = e.get('nodes', [])
        for a, b in zip(nds[:-1], nds[1:]):
            pa, pb = pos.get(a), pos.get(b)
            if pa is None or pb is None or a == b:
                continue
            for n, p in ((a, pa), (b, pb)):
                if n not in G:
                    G.add_node(n, y=p[0], x=p[1])
            attrs = dict(attrs_base, length=haversine(pa[0], pa[1], pb[0], pb[1]))
            G.add_edge(a, b, **attrs)
            G.add_edge(b, a, **attrs)

    debug_log(f"[Overpass] 建圖完成：{G.number_of_nodes()} 節點 / {G.number_of_edges()} 邊")
    return G


def edge_penalty(d):
    """道路成本倍率（住宅區道路 = 1.0）。"""
    hw = _first(d.get('highway'))
    fw = str(_first(d.get('footway')) or '').lower()
    if fw == 'crossing':
        # 過馬路是必要動作且距離很短，懲罰的話路徑會繞去別的路口過馬路
        return CROSSING_PENALTY
    if hw == 'steps':
        return STEPS_PENALTY
    if hw in ('footway', 'pedestrian', 'path', 'cycleway', 'bridleway', 'track'):
        # 與車道平行的人行道（footway=sidewalk）罰重：每條街兩側各一條，
        # 不罰的話會在兩側之間橫跳。獨立步道（公園、巷弄步道）只輕罰。
        if fw == 'sidewalk':
            return SIDEWALK_PENALTY
        return FOOTWAY_PENALTY if hw == 'footway' and not fw else PATH_PENALTY
    if hw in ('service', 'living_street', 'unclassified', 'road'):
        return MINOR_ROAD_PENALTY
    if hw in ('primary', 'primary_link', 'secondary', 'secondary_link'):
        return MAJOR_ROAD_PENALTY
    if hw in TRUNK:
        return TRUNK_PENALTY
    return 1.0


def prepare_graph(G, angle_threshold=20):
    """
    路網前處理：剪短分岔 -> 角度簡化 -> 只保留最大連通塊 -> 計算 travel_weight。

    被丟掉的孤立區域（例如橋沒畫進 OSM 的河濱公園）記在 G.graph['islands']，
    前端會在地圖上標出來——不然使用者在那裡畫圖，路線會被吸到很遠的地方卻不知道為什麼。
    """
    import networkx as nx

    G = prune_short_spurs(G.copy())
    G = remove_redundant_straight_nodes(G, angle_threshold=angle_threshold)

    comps = list(nx.connected_components(G.to_undirected(as_view=True)))
    if not comps:
        return G
    cc = max(comps, key=len)
    islands = []
    for comp in comps:
        if comp is cc or len(comp) < 3:
            continue
        hull = MultiPoint([(G.nodes[n]['x'], G.nodes[n]['y']) for n in comp]).convex_hull
        if hull.geom_type == 'Polygon':
            islands.append([(round(y, 6), round(x, 6)) for x, y in hull.exterior.coords])
        elif hull.geom_type == 'LineString':
            islands.append([(round(y, 6), round(x, 6)) for x, y in hull.coords])
    G = G.subgraph(cc).copy()
    G.graph['islands'] = islands

    for u, v, k, d in G.edges(keys=True, data=True):
        d['travel_weight'] = d.get('length', 10) * edge_penalty(d)

    debug_log(f"[前處理] {G.number_of_nodes()} 節點 / {G.number_of_edges()} 邊，"
              f"孤立區域 {len(islands)} 塊")
    return G
