"""
不依賴 osmnx 的路網工具：找最近節點、範圍查詢、鄰居計數。

為什麼要有這個檔案：
osmnx 需要 GDAL / geopandas，**無法在瀏覽器 (Pyodide) 裡安裝**。
演算法只需要「找最近節點」與「找某範圍內的節點」，這裡自己實作。

效能：節點座標第一次被查詢時整理成 numpy 陣列並快取（NodeIndex），
之後每次查詢都是一次向量化運算，不再用 Python 迴圈掃整張圖。
以前 route_in_corridor 每 40m 就要掃一次全圖，路網一大就慢到只能整段跳過。

座標：查詢內部先投影到「以路網中心為原點的平面公尺座標」
（等距圓柱投影，x 乘上 cos(中心緯度)）。幾公里範圍內誤差遠小於 1%，
而且東西、南北兩個方向的尺度一致——直接拿「度」比大小的話，
在台灣東西向會多算約 10%。
"""
import math
import weakref

import numpy as np

EARTH_RADIUS_M = 6371009.0   # 與 osmnx 相同的地球半徑
M_PER_DEG_LAT = 111320.0


class NodeIndex:
    """一張圖的節點座標快取。圖的節點有增減時要重建（見 node_index）。"""

    def __init__(self, G):
        self.ids = list(G.nodes())
        n = len(self.ids)
        self.lat = np.fromiter((G.nodes[i]['y'] for i in self.ids), dtype=float, count=n)
        self.lon = np.fromiter((G.nodes[i]['x'] for i in self.ids), dtype=float, count=n)
        self.lat0 = float(self.lat.mean()) if n else 0.0
        self.lon0 = float(self.lon.mean()) if n else 0.0
        self.kx = M_PER_DEG_LAT * math.cos(math.radians(self.lat0))
        self.x = (self.lon - self.lon0) * self.kx
        self.y = (self.lat - self.lat0) * M_PER_DEG_LAT
        self.pos = {nid: k for k, nid in enumerate(self.ids)}

    def xy(self, lat, lon):
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * M_PER_DEG_LAT

    def within(self, lat, lon, r_m):
        """半徑 r_m 內的節點，回傳 [(距離, 節點id), ...]，近到遠。"""
        px, py = self.xy(lat, lon)
        d = np.hypot(self.x - px, self.y - py)
        idx = np.nonzero(d <= r_m)[0]
        idx = idx[np.argsort(d[idx])]
        return [(float(d[k]), self.ids[k]) for k in idx]

    def nearest_k(self, lat, lon, k, r_max=None):
        px, py = self.xy(lat, lon)
        d = np.hypot(self.x - px, self.y - py)
        if r_max is not None:
            cand = np.nonzero(d <= r_max)[0]
        else:
            cand = np.arange(len(d))
        if len(cand) > k:
            part = cand[np.argpartition(d[cand], k)[:k]]
        else:
            part = cand
        part = part[np.argsort(d[part])]
        return [(float(d[j]), self.ids[j]) for j in part]

    def near_segment(self, a, b, r_m):
        """離線段 a-b（(lat,lon)）r_m 公尺內的節點 id。走廊查詢用。"""
        ax, ay = self.xy(*a)
        bx, by = self.xy(*b)
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        if L2 <= 0:
            d = np.hypot(self.x - ax, self.y - ay)
        else:
            t = np.clip(((self.x - ax) * vx + (self.y - ay) * vy) / L2, 0.0, 1.0)
            d = np.hypot(self.x - (ax + t * vx), self.y - (ay + t * vy))
        return [self.ids[k] for k in np.nonzero(d <= r_m)[0]]


_INDEX = weakref.WeakKeyDictionary()


def node_index(G):
    """取得（必要時重建）G 的 NodeIndex。節點數變了就視為過期。"""
    try:
        idx = _INDEX.get(G)
    except TypeError:
        idx = None
    if idx is None or len(idx.ids) != G.number_of_nodes():
        idx = NodeIndex(G)
        try:
            _INDEX[G] = idx
        except TypeError:
            pass
    return idx


def nearest_node(G, X, Y):
    """
    找出離 (X=經度, Y=緯度) 最近的節點，回傳節點 id。
    等同 osmnx.distance.nearest_nodes(G, X, Y) 在未投影圖上的行為（數公里內）。
    """
    if not G.number_of_nodes():
        raise ValueError("圖中沒有節點")
    return node_index(G).nearest_k(Y, X, 1)[0][1]


def nearest_node_dist(G, X, Y):
    """同 nearest_node，但一併回傳距離 (公尺)。"""
    if not G.number_of_nodes():
        raise ValueError("圖中沒有節點")
    d, nid = node_index(G).nearest_k(Y, X, 1)[0]
    return nid, d


def unique_neighbors(G, n):
    """不重複的相鄰節點。

    ⚠️ 路網是 MultiDiGraph 而且每條路都存成雙向兩條邊，所以 G.degree(n) 會把
    「一進一出」算成 2：死路端點的 degree 是 2、直路中間的點是 4。
    要判斷「死路」「路口」一律用這個函式，不能用 degree。
    """
    try:
        nb = set(G.successors(n)) | set(G.predecessors(n))
    except AttributeError:
        nb = set(G.neighbors(n))
    nb.discard(n)
    return nb
