"""純幾何 / 座標運算 (不依賴 networkx)。

距離一律用公尺。需要做平面運算（面積、點到線距離、簡化）時，
先用 LocalProj 投影到以某點為原點的平面公尺座標，
不要直接拿經緯度的「度」比大小——經度 1 度的長度是緯度的 cos(緯度) 倍，
在台灣東西向會多算約 10%，方向不同門檻就不同。
"""
import math

from shapely.geometry import LineString, Polygon

from .config import SMOOTH_TOLERANCE_M

M_PER_DEG_LAT = 111320.0


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


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
    diff = abs(a1 - a2) % 360
    return min(diff, 360 - diff)


class LocalProj:
    """以 (lat0, lon0) 為原點的平面公尺座標（等距圓柱投影）。數公里內誤差遠小於 1%。"""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    @classmethod
    def around(cls, points):
        pts = list(points)
        if not pts:
            return cls(0.0, 0.0)
        return cls(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    def xy(self, p):
        return ((p[1] - self.lon0) * self.kx, (p[0] - self.lat0) * M_PER_DEG_LAT)

    def ll(self, q):
        return (self.lat0 + q[1] / M_PER_DEG_LAT, self.lon0 + q[0] / self.kx)


def interpolate_dense(points, step=40):
    """沿折線每 step 公尺補一個點（頭尾保留）。"""
    if len(points) < 2:
        return list(points)
    dense = []
    for p1, p2 in zip(points[:-1], points[1:]):
        num_steps = max(1, int(safe_dist(p1, p2) / step))
        for j in range(num_steps):
            r = j / num_steps
            dense.append((p1[0] + (p2[0] - p1[0]) * r, p1[1] + (p2[1] - p1[1]) * r))
    dense.append(tuple(points[-1]))
    return dense


def calculate_polygon_area(coords):
    """(lat, lon) 多邊形的面積（平方公尺）。"""
    if len(coords) < 3:
        return 0.0
    pr = LocalProj(coords[0][0], coords[0][1])
    try:
        return Polygon([pr.xy(p) for p in coords]).area
    except Exception:
        return 0.0


def smooth_drawn_stroke(points, tolerance_m=None):
    """
    輕度平滑手繪線：只消除幾公尺級的手抖，保留整體圖案形狀。
    (RDP 簡化會保留頭尾端點，所以圖案起訖不變。) 在平面公尺座標上做。
    """
    if tolerance_m is None:
        tolerance_m = SMOOTH_TOLERANCE_M
    if not points or len(points) < 3 or not tolerance_m or tolerance_m <= 0:
        return list(points)
    pr = LocalProj.around(points)
    try:
        simp = LineString([pr.xy(p) for p in points]).simplify(tolerance_m, preserve_topology=False)
        out = [pr.ll(q) for q in simp.coords]
        if len(out) >= 2:
            out[0], out[-1] = tuple(points[0]), tuple(points[-1])
            return out
    except Exception:
        pass
    return list(points)


def polyline_length(points):
    return sum(safe_dist(a, b) for a, b in zip(points[:-1], points[1:]))


def road_polyline_from_nodes(G, nodes):
    """
    用來繪圖/匯出的座標展開。以「節點清單」為唯一依據（每個節點都會被走到），
    相鄰兩節點之間有帶幾何形狀的邊時，展開成道路實際曲線，
    避免長路段被畫成一條直線切過建築。

    刻意「不做」shortest-path 補洞 —— 那會改變路徑。
    相鄰節點若沒有邊或沒有幾何，維持節點直線。
    回傳 [(lat, lon), ...]。
    """
    if not nodes:
        return []
    coords = []
    if nodes[0] in G.nodes:
        coords.append((G.nodes[nodes[0]]['y'], G.nodes[nodes[0]]['x']))
    for u, v in zip(nodes[:-1], nodes[1:]):
        seg_pts = None
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
                coords.extend(seg_pts[1:])
            else:
                coords.extend(seg_pts)
        elif v in G.nodes:
            coords.append((G.nodes[v]['y'], G.nodes[v]['x']))
    return coords
