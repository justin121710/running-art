"""
不依賴 osmnx 的路網工具。

為什麼要有這個檔案：
osmnx 需要 GDAL / geopandas，**無法在瀏覽器 (Pyodide) 裡安裝**。
但整包演算法其實只用到 osmnx 的兩個功能：找最近節點、依範圍裁切路網。
把這兩個自己實作掉之後，gpsart/ 就能整包搬到瀏覽器裡執行。

行為刻意與 osmnx 2.x 對齊：
- nearest_node：未投影的圖 (EPSG:4326) osmnx 用 BallTree + haversine，
  也就是「大圓距離」最近，而不是經緯度的歐氏距離。這裡用向量化 haversine 完全對齊。
- truncate_graph_polygon：保留「點落在多邊形內」的節點，其餘移除，並回傳副本。
- truncate_graph_bbox：bbox 格式為 (left, bottom, right, top) = (西, 南, 東, 北)，
  先轉成多邊形再走 truncate_graph_polygon。
"""
import math

import numpy as np
from shapely.geometry import Point, Polygon

EARTH_RADIUS_M = 6371009.0   # 與 osmnx 相同的地球半徑


def nearest_node(G, X, Y):
    """
    找出離 (X=經度, Y=緯度) 最近的節點，回傳節點 id。
    等同 osmnx.distance.nearest_nodes(G, X, Y) 在未投影圖上的行為。
    """
    ids = list(G.nodes())
    if not ids:
        raise ValueError("圖中沒有節點")
    n = len(ids)
    lat = np.fromiter((G.nodes[i]['y'] for i in ids), dtype=float, count=n)
    lon = np.fromiter((G.nodes[i]['x'] for i in ids), dtype=float, count=n)

    # 向量化 haversine (與 osmnx 的 BallTree(metric="haversine") 等價)
    phi1 = np.radians(lat)
    phi2 = math.radians(Y)
    dphi = phi2 - phi1
    dlam = np.radians(X - lon)
    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * math.cos(phi2) * np.sin(dlam / 2.0) ** 2
    # 只需要比大小，不用真的乘上地球半徑；但保留同樣的單調轉換以避免誤差差異
    d = 2.0 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
    return ids[int(np.argmin(d))]


def nearest_node_dist(G, X, Y):
    """同 nearest_node，但一併回傳距離 (公尺)。"""
    nid = nearest_node(G, X, Y)
    p = G.nodes[nid]
    phi1, phi2 = math.radians(p['y']), math.radians(Y)
    dphi = phi2 - phi1
    dlam = math.radians(X - p['x'])
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return nid, 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, a)))


def bbox_to_poly(bbox):
    """(left, bottom, right, top) -> 多邊形 (與 osmnx.utils_geo.bbox_to_poly 相同)。"""
    left, bottom, right, top = bbox
    return Polygon([(left, bottom), (right, bottom), (right, top), (left, top)])


def truncate_graph_polygon(G, polygon, truncate_by_edge=False):
    """移除所有落在多邊形外的節點，回傳新圖 (不動到傳入的圖)。"""
    outside = set()
    for nid, d in G.nodes(data=True):
        try:
            if not polygon.contains(Point(d['x'], d['y'])):
                outside.add(nid)
        except Exception:
            outside.add(nid)

    if len(outside) == G.number_of_nodes():
        raise ValueError("多邊形範圍內沒有任何節點。")

    if truncate_by_edge:
        # 若鄰居中有任何一個在範圍內，就保留這個節點
        keep_back = set()
        for nid in outside:
            try:
                nbrs = set(G.successors(nid)) | set(G.predecessors(nid))
            except Exception:
                nbrs = set(G.neighbors(nid))
            if not nbrs.issubset(outside):
                keep_back.add(nid)
        outside -= keep_back

    H = G.copy()
    H.remove_nodes_from(outside)
    return H


def truncate_graph_bbox(G, bbox, truncate_by_edge=False):
    """bbox = (left, bottom, right, top) = (西, 南, 東, 北)。"""
    return truncate_graph_polygon(G, bbox_to_poly(bbox), truncate_by_edge=truncate_by_edge)
