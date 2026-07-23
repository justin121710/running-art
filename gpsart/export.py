"""輸出：GPX 軌跡檔、下載時間估算。"""
import os
import datetime

from .config import DL_FIXED_OVERHEAD_S, DL_SECONDS_PER_KM2
from .geometry import road_polyline_from_nodes


def save_gpx_file(G, segments, folder, filename):
    filepath = os.path.join(folder, filename)
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    gpx = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GPS Art A46" xmlns="http://www.topografix.com/GPX/1/1">',
        '  <metadata>', f'    <time>{now_iso}</time>', '  </metadata>',
        '  <trk>', '    <name>GPS Art Run</name>', '    <trkseg>'
    ]
    for seg in segments:
        # [A46] 支援 Beeline (直線) 類型
        if seg.get('type') == 'beeline':
            # 直接使用經緯度座標
            for p in seg['coords']:
                gpx.append(f'      <trkpt lat="{p[0]}" lon="{p[1]}"><ele>0.0</ele></trkpt>')
        else:
            # [Fix 切西瓜] 沿道路實際幾何展開 (覆蓋率與節點版完全一致，只是更貼路)
            for lat, lon in road_polyline_from_nodes(G, seg.get('nodes', [])):
                gpx.append(f'      <trkpt lat="{lat}" lon="{lon}"><ele>0.0</ele></trkpt>')
    gpx.append('    </trkseg>'); gpx.append('  </trk>'); gpx.append('</gpx>')
    with open(filepath, "w", encoding="utf-8") as f: f.write("\n".join(gpx))
    return filepath

def save_red_gpx_file(strokes, folder, filename):
    # [A46] Export ONLY "User Drawn" (Red) raw strokes for verification
    # Using multiple <trkseg> to represent discontinuous strokes
    filepath = os.path.join(folder, filename)
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    gpx = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GPS Art A46 - Red Line (Raw)" xmlns="http://www.topografix.com/GPX/1/1">',
        '  <metadata>', f'    <time>{now_iso}</time>', '  </metadata>',
        '  <trk>', '    <name>User Drawn Red Line</name>'
    ]
    
    # strokes is a list of list of (lat, lon)
    for s in strokes:
        if not s: continue
        gpx.append('    <trkseg>')
        
        for p in s:
             # p is (lat, lon) or [lat, lon]
             gpx.append(f'      <trkpt lat="{p[0]}" lon="{p[1]}"><ele>0.0</ele></trkpt>')
        
        gpx.append('    </trkseg>')
        
    gpx.append('  </trk>'); gpx.append('</gpx>')
    with open(filepath, "w", encoding="utf-8") as f: f.write("\n".join(gpx))
    return filepath

def estimate_download_seconds(area_km2):
    return DL_FIXED_OVERHEAD_S + DL_SECONDS_PER_KM2 * max(area_km2, 0.0)

def format_duration(sec):
    if sec < 60:
        return f"{int(round(sec))} 秒"
    return f"{sec/60:.1f} 分鐘"

def format_download_estimate(area_km2):
    """回傳預估下載時間的區間字串 (實際受網路與伺服器忙碌程度影響)。"""
    est = estimate_download_seconds(area_km2)
    return f"{format_duration(est * 0.7)}～{format_duration(est * 1.8)}"
