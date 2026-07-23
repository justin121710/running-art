"""純幾何 / 座標運算 (不依賴 networkx、osmnx)。"""
import math
from shapely.geometry import LineString, Polygon

from .config import SMOOTH_TOLERANCE_M


# ===========================
# 3. 幾何運算
# ===========================
def haversine(lat1, lon1, lat2, lon2):
    try:
        R = 6371000 
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
        return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    except Exception: return 9999999.0

def safe_dist(p1, p2):
    return haversine(p1[0], p1[1], p2[0], p2[1])

def get_bearing(lat1, lon1, lat2, lon2):
    dLon = math.radians(lon2 - lon1)
    lat1 = math.radians(lat1); lat2 = math.radians(lat2)
    y = math.sin(dLon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dLon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def get_angle_diff(a1, a2):
    """計算兩個角度的最小差值 (0~180)"""
    diff = abs(a1 - a2)
    return min(diff, 360 - diff)

def rdp_simplify(points, epsilon):
    if len(points) < 3: return points
    if LineString is None: return points
    try:
        ls = LineString(points)
        simplified = ls.simplify(epsilon, preserve_topology=False)
        return list(simplified.coords)
    except Exception:
        return points

def interpolate_points(p1, p2, step=10):
    # 用於直線模式的補點
    dist = safe_dist(p1, p2)
    num_steps = int(dist / step)
    if num_steps < 1: return [p1, p2]
    dense = []
    lat1, lon1 = p1; lat2, lon2 = p2
    for j in range(num_steps + 1):
        r = j / num_steps
        dense.append((lat1 + (lat2 - lat1) * r, lon1 + (lon2 - lon1) * r))
    return dense

def interpolate_dense(points, step=40): 
    # [A46] 稍微放寬間距到 40m，避免過度吸附到旁邊的小巷子，讓直線補路機制更容易觸發
    if len(points) < 2: return points
    dense = []
    for i in range(len(points)-1):
        p1 = points[i]; p2 = points[i+1]
        dist = safe_dist(p1, p2)
        num_steps = int(dist / step)
        if num_steps < 1: num_steps = 1
        lat1, lon1 = p1; lat2, lon2 = p2
        for j in range(num_steps):
            r = j / num_steps
            n_lat = lat1 + (lat2 - lat1) * r
            n_lon = lon1 + (lon2 - lon1) * r
            dense.append((n_lat, n_lon))
    dense.append(points[-1])
    return dense

def calculate_polygon_area(coords):
    if len(coords) < 3: return 0.0
    try:
        # Shapely area returns degrees^2, need metric approximation
        # Simple projection: multiply by rough meters/degree
        # Lat ~ 111km, Lon ~ 100km (in Taiwan). avg ~ 105km?
        # Better: project to UTM, but for ratio comparison, raw degree area is okay if shape is small?
        # Actually, let's use a simple projection for area:
        # projected_coords = [(lon * 111000 * cos(lat), lat * 111000) ...]
        # For ratio, relative area is fine as long as projection is consistent.
        # But `coords` are (lat, lon).
        
        # Simple local projection center
        c_lat = coords[0][0]
        c_lon = coords[0][1]
        
        proj_pts = []
        for p in coords:
            dy = (p[0] - c_lat) * 111000
            dx = (p[1] - c_lon) * 111000 * math.cos(math.radians(c_lat))
            proj_pts.append((dx, dy))
            
        return Polygon(proj_pts).area
    except Exception: return 0.0

def get_winding_angle(coords):
    """
    [Phase 38] Calculate cumulative turning angle (Winding Number).
    Returns total radians turned. Positive = CCW, Negative = CW.
    """
    if not coords or len(coords) < 3: return 0.0
    total_angle = 0.0
    import math
    
    v1x = coords[1][0] - coords[0][0]
    v1y = coords[1][1] - coords[0][1]
    
    for k in range(1, len(coords)-1):
        v2x = coords[k+1][0] - coords[k][0]
        v2y = coords[k+1][1] - coords[k][1]
        
        dot = v1x*v2x + v1y*v2y
        det = v1x*v2y - v1y*v2x # 2D Cross Product
        theta = math.atan2(det, dot)
        total_angle += theta
        
        v1x, v1y = v2x, v2y
    
    return total_angle

def smooth_drawn_stroke(points, tolerance_m=None):
    """
    [Fix 橫跳] 輕度平滑手繪紅線：只消除幾公尺級的手抖，保留整體圖案形狀。
    (RDP 簡化會保留頭尾端點，所以圖案起訖不變。)
    任何異常都回傳原始點，不影響既有流程。
    """
    if tolerance_m is None:
        tolerance_m = SMOOTH_TOLERANCE_M
    if not points or len(points) < 3 or not tolerance_m or tolerance_m <= 0:
        return points
    try:
        simplified = rdp_simplify(points, tolerance_m / 111000.0)
        if simplified and len(simplified) >= 2:
            return simplified
    except Exception:
        pass
    return points

def get_total_stroke_length_km(strokes):
    total_m = 0
    for s in strokes:
        for i in range(len(s)-1):
             total_m += safe_dist(s[i], s[i+1])
    return total_m / 1000.0

def find_nearest_point_on_strokes(target_lat, target_lon, strokes):
    best_point = None; min_dist = float('inf')
    for s in strokes:
        for p in s:
            d = safe_dist((target_lat, target_lon), p)
            if d < min_dist: min_dist = d; best_point = p
    return best_point, min_dist

def get_node_bearings(G, node_id):
    """
    [動態羅盤] 取得指定路口所有連外道路的方位角 (0~360度)
    用於決定使用者滑鼠可以吸附的方向。
    """
    angles = []
    if node_id not in G.nodes: return angles
    
    y1, x1 = G.nodes[node_id]['y'], G.nodes[node_id]['x']
    
    # 遍歷所有鄰居節點
    for neighbor in G.neighbors(node_id):
        y2, x2 = G.nodes[neighbor]['y'], G.nodes[neighbor]['x']
        angle = get_bearing(y1, x1, y2, x2)
        angles.append(angle)
        
        # 加上反向角度 (因為路通常是雙向的，即使是單行道，畫圖時通常容許逆向)
        angles.append((angle + 180) % 360)
        
    return list(set(angles)) # 去除重複角度

def calculate_segments_distance(G, segments):
    if not segments: return 0.0, 0.0 # Draw, Run
    
    draw_m = 0
    run_m = 0
    
    for s in segments:
        seg_len = 0
        kind = s.get('kind', 'draw')
        
        # -------------------------------------------------
        # [修正] 為了與 GPX/gpx.studio 顯示一致，
        # 我們放棄讀取 OSM 資料庫的 'length' (真實路長)，
        # 改為純粹計算「節點之間的直線距離累加」。
        # -------------------------------------------------
        
        if s['type'] == 'road':
            nodes = s.get('nodes', [])
            if len(nodes) > 1:
                # 預先快取節點座標以提升效能
                # 格式: (lat, lon) = (y, x)
                coords = []
                for n in nodes:
                    if n in G.nodes:
                        coords.append((G.nodes[n]['y'], G.nodes[n]['x']))
                
                # 累加每兩點之間的直線距離 (Haversine)
                for i in range(len(coords)-1):
                    seg_len += safe_dist(coords[i], coords[i+1])

        elif s['type'] == 'beeline':
            coords = s.get('coords', [])
            for i in range(len(coords)-1): 
                seg_len += safe_dist(coords[i], coords[i+1])
        
        # 分類累加
        if kind == 'draw':
            draw_m += seg_len
            run_m += seg_len
        elif kind == 'travel': # 灰色路徑
            run_m += seg_len
        elif kind == 'impossible': # 黃色路徑
            run_m += seg_len
            
    return draw_m / 1000.0, run_m / 1000.0

def road_polyline_from_nodes(G, nodes):
    """
    [Fix 切西瓜 - 安全版] 用來繪圖/匯出的座標展開。
    以「節點清單」為唯一依據 (與舊版節點渲染的覆蓋率完全相同，
    每個節點都會被走到，絕不會少畫、不會斷路)，差別只在於：
    當「相鄰兩節點之間確實存在有幾何形狀的道路邊」時，
    就把那一段展開成道路實際曲線，避免長路段被畫成一條直線切過建築。

    刻意「不做」shortest-path 補洞 —— 那會改變路徑，之前造成覆蓋率斷掉。
    相鄰節點若沒有邊或沒有幾何，維持原本的節點直線 (與舊版一致)。
    回傳 [(lat, lon), ...]。
    """
    if not nodes:
        return []
    coords = []
    if nodes[0] in G.nodes:
        coords.append((G.nodes[nodes[0]]['y'], G.nodes[nodes[0]]['x']))
    for i in range(len(nodes) - 1):
        u, v = nodes[i], nodes[i + 1]
        seg_pts = None
        # 找 u->v 或 v->u 之中「有 geometry」的邊
        for (a, b) in ((u, v), (v, u)):
            ed = G.get_edge_data(a, b)
            if not ed:
                continue
            best = min(ed, key=lambda k: ed[k].get('length', float('inf')))
            g = ed[best].get('geometry')
            if g is not None:
                seg_pts = [(p[1], p[0]) for p in list(g.coords)]  # (lon,lat)->(lat,lon)
                break
        if seg_pts and len(seg_pts) >= 2:
            # 對齊方向：讓 seg_pts 頭端接上目前終點 (geometry 可能反向儲存)
            if coords:
                d0 = (coords[-1][0] - seg_pts[0][0]) ** 2 + (coords[-1][1] - seg_pts[0][1]) ** 2
                d1 = (coords[-1][0] - seg_pts[-1][0]) ** 2 + (coords[-1][1] - seg_pts[-1][1]) ** 2
                if d1 < d0:
                    seg_pts = seg_pts[::-1]
                for p in seg_pts[1:]:
                    coords.append(p)
            else:
                coords.extend(seg_pts)
        else:
            # 後備：直線到 v (與舊節點渲染完全一致，保證覆蓋率不變)
            if v in G.nodes:
                coords.append((G.nodes[v]['y'], G.nodes[v]['x']))
    return coords
