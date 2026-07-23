"""路網前處理：剪除死路、角度簡化、依繪圖範圍裁切。"""
import math
from .graphutil import truncate_graph_bbox, truncate_graph_polygon
from shapely.geometry import LineString, MultiLineString

from .config import debug_log, CROSSING_PENALTY, FOOTWAY_PENALTY
from .geometry import get_bearing, haversine


def remove_recursive_dead_ends(G):
    # [Step 1B] Recursive Dead-end Pruning
    # Iteratively remove nodes with degree=1
    removed_count = 0
    while True:
        dead_ends = [n for n, d in G.degree() if d==1]
        if not dead_ends: break
        G.remove_nodes_from(dead_ends)
        removed_count += len(dead_ends)
    debug_log(f"Pruned {removed_count} dead-end nodes.")
    return G

def remove_redundant_straight_nodes(G, angle_threshold=20):
    """
    [A46] Angle-Based Node Simplification
    Removes degree-2 nodes that form a straight line (angle diff < threshold).
    Preserves corners for snapping.
    """
    nodes_to_remove = []
    
    # Iterate copy of nodes
    try:
        all_nodes = list(G.nodes())
        for n in all_nodes:
            # Check topology: 2 adjacent nodes (u, v) (Successors + Predecessors in Directed Graph)
            successors = list(G.successors(n))
            predecessors = list(G.predecessors(n))
            
            # For 2-way street: succ=[u,v], pred=[u,v]. Union={u,v}
            # For 1-way street: succ=[v], pred=[u]. Union={u,v}
            adj = set(successors + predecessors) - {n}
            if len(adj) == 2:
                u, v = list(adj)
                
                # Check Geometry (Angle)
                y_n, x_n = G.nodes[n]['y'], G.nodes[n]['x']
                y_u, x_u = G.nodes[u]['y'], G.nodes[u]['x']
                y_v, x_v = G.nodes[v]['y'], G.nodes[v]['x']
                
                # Treat as path U -> N -> V
                b1 = get_bearing(y_u, x_u, y_n, x_n)
                b2 = get_bearing(y_n, x_n, y_v, x_v)
                
                diff = abs(b1 - b2)
                if diff > 180: diff = 360 - diff
                
                if diff < angle_threshold:
                    nodes_to_remove.append((n, u, v))
    except Exception: pass
            
    count = 0
    for n, u, v in nodes_to_remove:
        if n not in G: continue
        
        # Merge Edges: U->N->V and V->N->U (if two-way)
        
        # 1. Forward: U->V
        if G.has_edge(u, n) and G.has_edge(n, v):
            try:
                # Use 0 key for simplicity
                k_un = list(G[u][n].keys())[0]
                k_nv = list(G[n][v].keys())[0]
                d1 = G[u][n][k_un]
                d2 = G[n][v][k_nv]
                
                new_data = d1.copy()
                new_data['length'] = d1.get('length', 0) + d2.get('length', 0)
                
                # Merge Geometry
                coords1 = d1.get('geometry', None)
                coords2 = d2.get('geometry', None)
                
                new_geom = None
                c1 = list(coords1.coords) if coords1 else [(G.nodes[u]['x'], G.nodes[u]['y']), (G.nodes[n]['x'], G.nodes[n]['y'])]
                c2 = list(coords2.coords) if coords2 else [(G.nodes[n]['x'], G.nodes[n]['y']), (G.nodes[v]['x'], G.nodes[v]['y'])]
                
                # Combine (c1 ends at n, c2 starts at n)
                # If c1[-1] approx c2[0], skip duplicate
                full_coords = c1[:-1] + c2
                if len(full_coords) >= 2:
                    new_geom = LineString(full_coords)
                
                if new_geom: new_data['geometry'] = new_geom
                
                G.add_edge(u, v, **new_data)
            except Exception: pass
        
        # 2. Backward: V->U
        if G.has_edge(v, n) and G.has_edge(n, u):
            try:
                k_vn = list(G[v][n].keys())[0]
                k_nu = list(G[n][u].keys())[0]
                d1 = G[v][n][k_vn]
                d2 = G[n][u][k_nu]
                
                new_data = d1.copy()
                new_data['length'] = d1.get('length', 0) + d2.get('length', 0)
                
                coords1 = d1.get('geometry', None)
                coords2 = d2.get('geometry', None)
                
                new_geom = None
                c1 = list(coords1.coords) if coords1 else [(G.nodes[v]['x'], G.nodes[v]['y']), (G.nodes[n]['x'], G.nodes[n]['y'])]
                c2 = list(coords2.coords) if coords2 else [(G.nodes[n]['x'], G.nodes[n]['y']), (G.nodes[u]['x'], G.nodes[u]['y'])]
                
                full_coords = c1[:-1] + c2
                if len(full_coords) >= 2:
                    new_geom = LineString(full_coords)
                
                if new_geom: new_data['geometry'] = new_geom
                
                G.add_edge(v, u, **new_data)
            except Exception: pass

        # Remove Node
        try:
            G.remove_node(n)
            count += 1
        except Exception: pass
        
    if count > 0:
        debug_log(f"[Simplification] Removed {count} straight nodes (Angle<{angle_threshold}).")
        
    return G

def crop_graph_buffer(G, strokes, buffer_dist_m=100, manual_bbox=None):
    if manual_bbox:
        debug_log(f"使用手動裁切範圍: {manual_bbox}")
        # manual_bbox = (n, s, e, w) -> (maxy, miny, maxx, minx)
        # truncate_graph_bbox expects (north, south, east, west)
        return truncate_graph_bbox(G, bbox=manual_bbox)

    debug_log(f"裁切路網 Buffer: {buffer_dist_m}m (Extensive Grid)")
    all_lats = []; all_lons = []
    for s in strokes:
        for p in s: all_lats.append(p[0]); all_lons.append(p[1])
    if not all_lats: return G
    
    lines = [LineString([(p[1], p[0]) for p in s]) for s in strokes if len(s)>1]
    if not lines: return G
    
    multi_line = MultiLineString(lines)
    buffer_deg = buffer_dist_m / 111000.0
    polygon = multi_line.buffer(buffer_deg)
    
    try:
        minx, miny, maxx, maxy = polygon.bounds
        G_sub = truncate_graph_bbox(G, bbox=(maxy, miny, maxx, minx))
        G_final = truncate_graph_polygon(G_sub, polygon)
        if len(G_final.nodes) < 10: return G_sub
        return G_final
    except Exception as e:
        debug_log(f"裁切失敗 ({e})，使用原圖。")
        return G


# ==========================================================
# 從 Overpass JSON 直接建圖（給瀏覽器版用，不需要 osmnx）
# ==========================================================

# 可以跑步/走路的道路類型
WALKABLE = {
    'footway', 'residential', 'service', 'tertiary', 'tertiary_link',
    'secondary', 'secondary_link', 'primary', 'primary_link',
    'living_street', 'pedestrian', 'path', 'unclassified', 'steps',
    'track', 'cycleway', 'trunk', 'trunk_link', 'road',
}
# 禁止進入的 access 值（私人道路、禁行）
BLOCKED_ACCESS = {'private', 'no', 'customers', 'delivery', 'restricted'}


def _first(v):
    """OSM 標籤有時是 list，取第一個。"""
    return v[0] if isinstance(v, list) else v


def graph_from_overpass_json(data):
    """
    把 Overpass API 回傳的 JSON 直接轉成 networkx 圖。
    取代 osmnx 的下載功能，讓核心可以在瀏覽器 (Pyodide) 裡跑。
    步行路網視為雙向。
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
        hw = _first(tags.get('highway'))
        if hw not in WALKABLE:
            continue
        if str(_first(tags.get('access', ''))).lower() in BLOCKED_ACCESS:
            continue

        nds = e.get('nodes', [])
        for a, b in zip(nds[:-1], nds[1:]):
            pa, pb = pos.get(a), pos.get(b)
            if pa is None or pb is None:
                continue
            for n, p in ((a, pa), (b, pb)):
                if n not in G:
                    G.add_node(n, y=p[0], x=p[1])
            length = haversine(pa[0], pa[1], pb[0], pb[1])
            attrs = {'length': length, 'highway': hw}
            fw = _first(tags.get('footway'))
            if fw:
                attrs['footway'] = fw
            name = _first(tags.get('name'))
            if name:
                attrs['name'] = name
            G.add_edge(a, b, **attrs)
            G.add_edge(b, a, **attrs)

    debug_log(f"[Overpass] 建圖完成：{G.number_of_nodes()} 節點 / {G.number_of_edges()} 邊")
    return G


def prepare_graph(G, angle_threshold=20):
    """
    路網前處理，與桌面版 _process_final_graph 的核心步驟一致：
    剪除死路 -> 角度簡化 -> 只保留最大連通塊 -> 計算 travel_weight。
    """
    import networkx as nx

    G = remove_recursive_dead_ends(G.copy())
    G = remove_redundant_straight_nodes(G, angle_threshold=angle_threshold)

    cc = max(nx.connected_components(G.to_undirected()), key=len)
    G = G.subgraph(cc).copy()

    for u, v, k, d in G.edges(keys=True, data=True):
        hw = _first(d.get('highway'))
        w = d.get('length', 10)
        penalty = 1.0
        if hw in ['service', 'living_street', 'unclassified']:
            penalty = 1.2
        elif hw in ['footway', 'pedestrian', 'path', 'steps', 'track', 'cycleway']:
            fw = _first(d.get('footway'))
            # 行人穿越道不懲罰，否則路徑會繞遠路去別的路口過馬路
            penalty = CROSSING_PENALTY if str(fw).lower() == 'crossing' else FOOTWAY_PENALTY
        d['travel_weight'] = w * penalty

    debug_log(f"[前處理] {G.number_of_nodes()} 節點 / {G.number_of_edges()} 邊")
    return G
