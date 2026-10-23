"""路線品質基準測試：用真實 OSM 路網（tests/data/）跑一組固定圖形，量化品質。

用法：
    python tests/bench.py              # 印出目前演算法的成績
    python tests/bench.py --save       # 存成 tests/baseline_bench.json
    python tests/bench.py --compare    # 與 baseline_bench.json 比較

指標（全部以公尺計）：
    len      路線總長
    conn     連接段（灰色虛線）總長
    prec     路線上的點有幾成落在手繪線 30m 內（準確率）
    recall   手繪線上的點有幾成被路線覆蓋（30m 內）（覆蓋率）
    dev      路線到手繪線的平均距離
    uturn    路線中 >150° 的折返次數（腿長 >10m）——橫跳、原地來回的代理指標
    sec      運算時間
"""
import gzip
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from gpsart import web_api  # noqa: E402

M_LAT = 111320.0


def _load(name):
    p = os.path.join(HERE, 'data', name + '.json.gz')
    with gzip.open(p, 'rt', encoding='utf-8') as f:
        return f.read()


def _to_ll(c_lat, c_lon, pts_m):
    k = M_LAT * math.cos(math.radians(c_lat))
    return [(c_lat + y / M_LAT, c_lon + x / k) for x, y in pts_m]


def circle(r, n=72, start_deg=0):
    return [(r * math.cos(math.radians(start_deg + 360 * i / n)),
             r * math.sin(math.radians(start_deg + 360 * i / n))) for i in range(n + 1)]


def heart(s, n=120):
    out = []
    for i in range(n + 1):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        out.append((x * s, y * s))
    return out


def square(h, rot_deg):
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    pts = []
    for (x0, y0), (x1, y1) in zip([(-h, -h), (h, -h), (h, h), (-h, h)],
                                  [(h, -h), (h, h), (-h, h), (-h, -h)]):
        for k in range(10):
            x = x0 + (x1 - x0) * k / 10
            y = y0 + (y1 - y0) * k / 10
            pts.append((x * c - y * s, x * s + y * c))
    pts.append(pts[0])
    return pts


def star(r1, r2, n=5):
    pts = []
    for i in range(2 * n + 1):
        r = r1 if i % 2 == 0 else r2
        a = math.pi / 2 + math.pi * i / n
        pts.append((r * math.cos(a), r * math.sin(a)))
    return pts


def wobble(pts, amp=4.0):
    """模擬手抖：沿線加一點規律雜訊（固定、可重現）。"""
    return [(x + amp * math.sin(i * 1.7), y + amp * math.cos(i * 2.3)) for i, (x, y) in enumerate(pts)]


def zigzag_line(L, n=8):
    return [(-L / 2 + L * i / n, (60 if i % 2 else -60)) for i in range(n + 1)]


CASES = {
    'helsinki': {
        'center': (60.1700, 24.9440),
        'shapes': {
            'circle300': [wobble(circle(300))],
            'circle150': [wobble(circle(150, start_deg=40))],
            'heart': [wobble(heart(14))],
            'square_rot20': [wobble(square(220, 20))],
            'star': [wobble(star(330, 140))],
            'zigzag': [wobble(zigzag_line(700))],
            'two_circles': [wobble(circle(120)), [(x + 420, y) for x, y in wobble(circle(120))]],
            'straight': [[(-450 + 9 * i, -120 + 2 * i) for i in range(101)]],
        },
    },
}


def _polyline_len(pts):
    from gpsart.geometry import haversine
    return sum(haversine(a[0], a[1], b[0], b[1]) for a, b in zip(pts[:-1], pts[1:]))


def _densify_m(pts, step=5.0):
    from gpsart.geometry import haversine
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        d = haversine(a[0], a[1], b[0], b[1])
        n = max(1, int(d / step))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    if pts:
        out.append(pts[-1])
    return out


def _uturns(pts):
    from gpsart.geometry import haversine, get_bearing, get_angle_diff
    # 先把太近的點合併，避免浮點小抖動
    simp = []
    for p in pts:
        if not simp or haversine(simp[-1][0], simp[-1][1], p[0], p[1]) > 10:
            simp.append(p)
    n = 0
    for a, b, c in zip(simp, simp[1:], simp[2:]):
        d = get_angle_diff(get_bearing(a[0], a[1], b[0], b[1]), get_bearing(b[0], b[1], c[0], c[1]))
        if d > 150:
            n += 1
    return n


def metrics(res, strokes):
    import numpy as np
    from shapely.geometry import LineString, MultiLineString, Point
    route = []
    conn = 0.0
    for seg in res['segments']:
        if seg['kind'] != 'draw':
            conn += seg['len']
        for p in seg['pts']:
            if not route or route[-1] != tuple(p):
                route.append(tuple(p))
    c_lat = strokes[0][0][0]
    kx = M_LAT * math.cos(math.radians(c_lat))
    xy = lambda p: (p[1] * kx, p[0] * M_LAT)
    draw_geom = MultiLineString([[xy(p) for p in s] for s in strokes])
    route_geom = LineString([xy(p) for p in route]) if len(route) > 1 else None
    rs = _densify_m(route)
    ds = [p for s in strokes for p in _densify_m(s)]
    d_rd = np.array([draw_geom.distance(Point(xy(p))) for p in rs])
    d_dr = np.array([route_geom.distance(Point(xy(p))) for p in ds]) if route_geom else np.full(len(ds), 1e9)
    return {
        'len': round(_polyline_len(route)),
        'conn': round(conn),
        'prec': round(float((d_rd <= 30).mean()), 3),
        'recall': round(float((d_dr <= 30).mean()), 3),
        'dev': round(float(d_rd.mean()), 1),
        'uturn': _uturns(route),
    }


def run():
    out = {}
    for city, spec in CASES.items():
        t0 = time.time()
        st = web_api.load_area_json(_load(city))
        print(f'{city}: {st["nodes"]} 節點 / {st["edges"]} 邊（建圖 {time.time() - t0:.1f}s）')
        c_lat, c_lon = spec['center']
        for name, shapes in spec['shapes'].items():
            strokes = [_to_ll(c_lat, c_lon, s) for s in shapes]
            start = strokes[0][0]
            end = strokes[-1][-1]
            t0 = time.time()
            res = web_api.generate(strokes, start, end)
            dt = time.time() - t0
            m = metrics(res, strokes)
            m['sec'] = round(dt, 2)
            out[f'{city}/{name}'] = m
            print(f'  {name:14s} ' + '  '.join(f'{k}={v}' for k, v in m.items()))
    return out


if __name__ == '__main__':
    res = run()
    base_p = os.path.join(HERE, 'baseline_bench.json')
    if '--save' in sys.argv:
        with open(base_p, 'w', encoding='utf-8') as f:
            json.dump(res, f, indent=1, ensure_ascii=False)
        print('已存成', base_p)
    if '--compare' in sys.argv and os.path.exists(base_p):
        base = json.load(open(base_p, encoding='utf-8'))
        print('\n與基準比較（新 / 舊）：')
        for k, m in res.items():
            b = base.get(k)
            if not b:
                continue
            print(f'  {k:24s} ' + '  '.join(f'{x}={m[x]}/{b[x]}' for x in ('len', 'prec', 'recall', 'dev', 'uturn', 'sec')))
