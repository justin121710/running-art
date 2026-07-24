"""路徑演算法核心：走廊尋路、中國郵差、路徑清理與修補。"""
import math
import heapq
import copy
import networkx as nx
from shapely.geometry import LineString, MultiLineString, Point, Polygon

from .config import BACKTRACK_MAX_THINNESS, BACKTRACK_MIN_EXCURSION_M, BACKTRACK_RETURN_RADIUS_M, BACKTRACK_WINDOW, CORRIDOR_SAMPLE_STEP_M, CORRIDOR_SAMPLE_STEP_RETRY_M, REUSE_PENALTY_FACTOR, debug_log
from .graphutil import nearest_node
from .geometry import calculate_polygon_area, find_nearest_point_on_strokes, get_angle_diff, get_bearing, get_winding_angle, haversine, interpolate_dense, safe_dist, smooth_drawn_stroke


def robust_shortest_path(graph, start_node, end_node, weight='length'):
    """
    在道路圖上找出節點路徑，用來避免「直線切西瓜穿過建築物」。
    先找有向最短路；若因單行道方向或剪枝而找不到，改用無向視角
    (對步行/跑步而言方向沒有意義)。兩者都失敗才回傳 None，
    交由呼叫端決定是否退回直線。
    """
    if graph is None or start_node is None or end_node is None:
        return None
    if start_node == end_node:
        return [start_node]
    if start_node not in graph.nodes or end_node not in graph.nodes:
        return None
    # 1. 有向最短路 (照原本邏輯)
    try:
        return nx.shortest_path(graph, start_node, end_node, weight=weight)
    except Exception:
        pass
    # 2. 無向 fallback (忽略單行道方向，僅求「有沒有一條路可走」)
    try:
        UG = graph.to_undirected(as_view=True)
        return nx.shortest_path(UG, start_node, end_node, weight='length')
    except Exception:
        return None

def bridge_node_path_gaps(G, nodes, max_detour_ratio=4.0, min_gap_m=25.0):
    """
    [Fix 切西瓜] 把節點路徑中「前後兩點其實沒有道路直接相連」的跳點，
    改成沿著真實道路重新接起來。

    為什麼會有跳點：走廊尋路本身是連續的，但後製步驟 (去迴圈 remove_short_loops、
    剪枝 prune_spurs_stack、捷徑最佳化 advanced_shortcut_optimizer) 會把中間節點刪掉，
    使前後兩節點之間沒有邊 —— 畫出來就變成一條直線硬連、切過建築物。

    這裡改為去找「附近最合適的真實道路」把它接回來：
    - 只有在兩點確實沒有相連、且距離 > min_gap_m 時才處理。
    - 找到的道路繞路若過於誇張 (超過直線的 max_detour_ratio 倍) 就放棄，維持原樣，
      避免為了避開一小段而繞一大圈。
    - 只會「插入」節點、絕不刪除 -> 覆蓋率只會持平或變好。
    """
    if not nodes or len(nodes) < 2 or G is None:
        return nodes
    out = [nodes[0]]
    for i in range(len(nodes) - 1):
        u, v = nodes[i], nodes[i + 1]
        # 已經有邊直接相連 -> 本來就是沿路走，不動它
        if G.has_edge(u, v) or G.has_edge(v, u):
            out.append(v)
            continue
        if u not in G.nodes or v not in G.nodes:
            out.append(v)
            continue
        try:
            straight = haversine(G.nodes[u]['y'], G.nodes[u]['x'],
                                 G.nodes[v]['y'], G.nodes[v]['x'])
        except Exception:
            out.append(v)
            continue
        # 很短的跳點畫成直線看不出來，不值得繞路
        if straight < min_gap_m:
            out.append(v)
            continue
        filled = robust_shortest_path(G, u, v, weight='length')
        if filled and len(filled) > 2:
            try:
                plen = 0.0
                for a, b in zip(filled[:-1], filled[1:]):
                    plen += haversine(G.nodes[a]['y'], G.nodes[a]['x'],
                                      G.nodes[b]['y'], G.nodes[b]['x'])
            except Exception:
                plen = float('inf')
            if plen <= max(straight * max_detour_ratio, straight + 150.0):
                out.extend(filled[1:])   # 插入沿路的中間節點
                continue
        out.append(v)
    return out

def get_path_geometry(G, path_nodes):
    """
    [A47] Construct proper geometry for a path, handling curves using Edge Geometry.
    """
    if not path_nodes or len(path_nodes) < 2: return []
    full_coords = []
    
    # Add Start Node
    if path_nodes[0] in G.nodes:
        full_coords.append((G.nodes[path_nodes[0]]['y'], G.nodes[path_nodes[0]]['x']))
        
    for i in range(len(path_nodes)-1):
        u, v = path_nodes[i], path_nodes[i+1]
        
        geometry = None
        
        # 1. Forward Edge
        edge_data = G.get_edge_data(u, v)
        if edge_data:
            # Pick shortest edge if multi-edge
            best_key = min(edge_data, key=lambda k: edge_data[k].get('length', float('inf')))
            data = edge_data[best_key]
            if 'geometry' in data:
                geometry = data['geometry']
                # Shapely coords are (lon, lat)
                coords = list(geometry.coords)
                # Append excluding start (already added)
                for p in coords[1:]: full_coords.append((p[1], p[0])) # (lat, lon)
                continue # Done for this segment
        
        # 2. Backward Edge (if no forward geometry)
        if not geometry:
            edge_data_rev = G.get_edge_data(v, u)
            if edge_data_rev:
                 best_key = min(edge_data_rev, key=lambda k: edge_data_rev[k].get('length', float('inf')))
                 data = edge_data_rev[best_key]
                 if 'geometry' in data:
                     geometry = data['geometry']
                     # Reverse geometry
                     coords = list(geometry.coords)[::-1]
                     for p in coords[1:]: full_coords.append((p[1], p[0]))
                     continue

        # 3. Fallback: u,v 之間沒有直接相連的邊 (路徑中有跳點)
        #    原本直接畫直線 -> 會切西瓜穿過建築物。
        #    改為：若兩點距離明顯 (>60m)，先嘗試在道路上補一段實際路徑，
        #    真的完全不連通才退回直線。
        if v in G.nodes:
            uy_ok = u in G.nodes
            gap_far = False
            if uy_ok:
                try:
                    gap_far = haversine(G.nodes[u]['y'], G.nodes[u]['x'],
                                        G.nodes[v]['y'], G.nodes[v]['x']) > 60
                except Exception:
                    gap_far = False
            filled = None
            if uy_ok and gap_far:
                try:
                    sp = robust_shortest_path(G, u, v, weight='length')
                    # 需要有中間節點才算「真的走道路」(len>2)，且避免無限遞迴
                    if sp and len(sp) > 2:
                        filled = get_path_geometry(G, sp)
                except Exception:
                    filled = None
            if filled and len(filled) > 1:
                for p in filled[1:]:
                    full_coords.append(p)
            else:
                full_coords.append((G.nodes[v]['y'], G.nodes[v]['x']))

    return full_coords

# [A46] 混合模式路徑計算：路網優先，失敗則直線補路
# [Phase 3] Dynamic Corridor Routing
def route_in_corridor(G_full, stroke_coords, start_n=None):
    """
    Route along a stroke using a dynamic corridor (buffer).
    Step 1: 40m Buffer (Strict)
    Step 2: 100m Buffer (Relaxed)
    Step 3: Fallback (Beeline)
    
    Returns: list of segments [{'type': 'road', 'nodes': ...}, ...]
    """
    from shapely.geometry import LineString, Point, Polygon
    
    if len(stroke_coords) < 2: return []
    
    line = LineString([(p[1], p[0]) for p in stroke_coords]) # lon, lat
    
    # helper to solve in sub-graph
    def solve_sub(buffer_radius_deg):
        # [vLINE Optim] Performance Check
        # If graph is large (e.g. Full City > 10k nodes), scanning nodes(data=True) is O(N) ~ Is slow in Python loop.
        # Fallback to direct routing on Full Graph to avoid Hang.
        if hasattr(G_full, 'number_of_nodes') and G_full.number_of_nodes() > 10000:
            # debug_log("Large Graph detected: Skipping Corridor Subgraph Scan (O(N) Avoidance).")
            # Try finding start/end on G_full directly.
            
            end_ll = stroke_coords[-1]
            try:
                target_n = nearest_node(G_full, end_ll[1], end_ll[0])
                src_n = start_n
                if not src_n:
                    start_ll = stroke_coords[0]
                    src_n = nearest_node(G_full, start_ll[1], start_ll[0])
                
                # Use standard shortest path (Robust)
                return nx.shortest_path(G_full, src_n, target_n, weight='length')
            except Exception:
                return None

        # 1. Create Buffer Polygon
        poly = line.buffer(buffer_radius_deg)
        
        # 2. Extract Subgraph Nodes
        # Manual clip to avoid OSMnx API variance
        nodes_in_corr = []
        for n, d in G_full.nodes(data=True):
             # Quick bbox check first
             if d['y'] < poly.bounds[1] or d['y'] > poly.bounds[3]: continue
             if d['x'] < poly.bounds[0] or d['x'] > poly.bounds[2]: continue
             
             if poly.contains(Point(d['x'], d['y'])):
                 nodes_in_corr.append(n)
                 
        if not nodes_in_corr: return None
        if start_n and start_n not in nodes_in_corr:
            # Should ensure start node is included if provided
            nodes_in_corr.append(start_n)
            
        G_sub = G_full.subgraph(nodes_in_corr)
        
        # 3. Find Route
        # Target: Closest node to stroke End
        end_ll = stroke_coords[-1]
        try:
            target_n = nearest_node(G_sub, end_ll[1], end_ll[0])
            
            src_n = start_n
            if not src_n:
                start_ll = stroke_coords[0]
                src_n = nearest_node(G_sub, start_ll[1], start_ll[0])
                
            path = nx.shortest_path(G_sub, src_n, target_n, weight='travel_weight')
            return path
        except Exception:
            return None

    # Step 1: Broad (150m ~ 0.0015 deg)
    path = solve_sub(0.0015)
    buffer_used = "150m"
    
    # Step 2: Very Relaxed (500m ~ 0.005 deg)
    if not path:
        path = solve_sub(0.005)
        buffer_used = "500m"
        
    # Result
    if path:
        # Construct simplified geometry
        # coords = []
        # for n in path:
        #    coords.append((G_full.nodes[n]['y'], G_full.nodes[n]['x']))
        coords = get_path_geometry(G_full, path)
        
        # Mark visited (Strict No Backtrack)
        # Note: We rely on global G_full 'travel_weight' being updated? 
        # Or we need to update it here for subsequent calls?
        # User wants "Strict No Meaningless U-turns".
        # We should increase weight of used edges in G_full.
        for i in range(len(path)-1):
            u, v = path[i], path[i+1]
            # [Fix 繞遠路] 原本設 1e9 等於把走過的路「封死」，會害路徑為了不重疊
            # 而繞一大圈 (畫圓繞回起點、想過馬路時特別明顯)。
            # 改為有限倍率：強烈不鼓勵重走，但必要時仍可通行。
            for (a, b) in ((u, v), (v, u)):
                if G_full.has_edge(a, b):
                    for k in G_full[a][b]:
                        _d = G_full[a][b][k]
                        _base = _d.get('length', 10)
                        _d['travel_weight'] = max(_d.get('travel_weight', _base),
                                                  _base * REUSE_PENALTY_FACTOR)
                
        return [{'type': 'road', 'kind': 'draw', 'nodes': path, 'coords': coords, 'buffer': buffer_used}]
        
    else:
        # Step 3: Fallback (Yellow Beeline)
        return [{'type': 'beeline', 'kind': 'impossible', 'coords': stroke_coords}]

def solve_inertia_path(G, start_node, end_node, initial_bearing=None):
    """
    [慣性導航] 優先選擇「角度變化最小」的路徑。
    模擬沿著彎道行駛的物理慣性，解決長距離微彎道路被切斷的問題。
    """
    # Priority Queue: (cost, current_node, arrival_bearing, path_list)
    pq = [(0, start_node, initial_bearing, [start_node])]
    
    # 紀錄最小成本 (node) -> cost
    # 簡化版：只記錄到達該點的最低成本 (不分角度，避免狀態爆炸，雖然犧牲一點精確度)
    min_costs = {start_node: 0} 

    LIMIT_COST = 500000 # 避免跑太遠
    
    while pq:
        cost, u, prev_bearing, path = heapq.heappop(pq)
        
        if cost > LIMIT_COST: continue
        if u == end_node:
            return path
        
        # 剪枝：如果已經有更低成本的方式到達此點，且成本差異過大，則跳過
        # (這裡放寬一點條件，允許稍微繞路以維持角度)
        if u in min_costs and min_costs[u] < cost * 0.8:
            continue
        min_costs[u] = cost
        
        # 遍歷鄰居
        for v, data in G[u].items():
            # 取出邊的長度
            edge_data = min(data.values(), key=lambda x: x.get('length', float('inf')))
            length = edge_data.get('length', 10)
            
            # 計算邊的方位角
            if 'bearing' in edge_data:
                curr_bearing = edge_data['bearing']
            else:
                curr_bearing = get_bearing(G.nodes[u]['y'], G.nodes[u]['x'], 
                                           G.nodes[v]['y'], G.nodes[v]['x'])
            
            # 計算轉彎懲罰 (Turn Penalty)
            penalty_factor = 1.0
            
            if prev_bearing is not None:
                diff = get_angle_diff(prev_bearing, curr_bearing)
                
                if diff < 15:      # 直行 / 微偏 (0~15度)
                    penalty_factor = 1.0 
                elif diff < 30:    # 輕微彎道 (15~30度)
                    penalty_factor = 1.2
                elif diff < 45:    # 明顯轉彎 (30~45度)
                    penalty_factor = 2.0
                elif diff < 90:    # 直角轉彎
                    penalty_factor = 5.0
                else:              # 迴轉/大轉角
                    penalty_factor = 10.0
            else:
                # 第一步，給予極小的懲罰
                penalty_factor = 1.0

            new_cost = cost + (length * penalty_factor)
            
            heapq.heappush(pq, (new_cost, v, curr_bearing, path + [v]))
            
    return None # 找不到路徑

# ===========================
# [vLINE] Line-Hugging A* Algorithm
# ===========================
def get_line_hugging_path(G, source, target):
    """
    [vLINE] 計算「擬合直線」的路徑 (Custom A* - Dynamic Compass)
    Feature 1: Line Hugging (Low Weight 0.5) - Allow flexibility around obstacles
    Feature 2: Inertia (Turn Penalty) - Smooth local turns
    Feature 3: Dynamic Target Compass - Encourage moving towards target
    """
    if source not in G or target not in G: return None
    
    # 1. Pre-calc line params
    y1, x1 = G.nodes[source]['y'], G.nodes[source]['x']
    y2, x2 = G.nodes[target]['y'], G.nodes[target]['x']
    
    # Priority Queue: (estimated_total_cost, g_cost, current_node, prev_bearing, path_list)
    pq = [(0, 0, source, None, [source])] 
    min_g = {source: 0}
    
    LIMIT_COST = 500000
    
    while pq:
        f, g, u, prev_bearing, path = heapq.heappop(pq)
        
        if g > LIMIT_COST: continue
        if u == target: return path
        
        # Pruning
        if u in min_g and min_g[u] < g * 0.95: continue
        min_g[u] = g
        
        # [C] Dynamic Target Compass
        # Calculate bearing from CURRENT node to TARGET
        uy, ux = G.nodes[u]['y'], G.nodes[u]['x']
        target_bearing = get_bearing(uy, ux, y2, x2)
        
        # Expand
        for v, data in G[u].items():
            edge_data = min(data.values(), key=lambda x: x.get('length', float('inf')))
            length = edge_data.get('length', 10)
            
            # 1. Bearing & Turn Penalty
            if 'bearing' in edge_data: curr_bearing = edge_data['bearing']
            else: curr_bearing = get_bearing(G.nodes[u]['y'], G.nodes[u]['x'], G.nodes[v]['y'], G.nodes[v]['x'])
            
            # [A] Inertia (Turn Penalty - Local)
            turn_penalty = 0
            if prev_bearing is not None:
                diff = get_angle_diff(prev_bearing, curr_bearing)
                if diff > 120: turn_penalty = 99999 # Strict Ban U-Turn
                elif diff > 90: turn_penalty = 500 
                elif diff > 45: turn_penalty = 100
                elif diff > 20: turn_penalty = 20
            
            # [B] Dynamic Compass Direction Penalty
            # Encourage moving towards target, Punish moving away
            compass_diff = get_angle_diff(target_bearing, curr_bearing)
            direction_penalty = 0
            
            if compass_diff < 45: # Moving Towards (Bonus)
                 direction_penalty = length * -0.5
            elif compass_diff > 90: # Moving Away (Penalty)
                 direction_penalty = length * 5.0 
            
            # 2. Line Deviation Penalty (Reduced Weight)
            vy, vx = G.nodes[v]['y'], G.nodes[v]['x']
            
            # Dist to line segment
            numerator = abs((x2 - x1) * (y1 - vy) - (x1 - vx) * (y2 - y1))
            denominator = ((x2 - x1)**2 + (y2 - y1)**2)**0.5
            dist_line_m = 0
            if denominator > 0:
                dist_line_deg = numerator / denominator
                dist_line_m = dist_line_deg * 111000
                
            deviation_penalty = dist_line_m * 0.1 # [Fix] Very Low Weight 0.1 (Allow Detour)
            
            new_g = g + length + turn_penalty + deviation_penalty + direction_penalty
            
            # Heuristic (Dist to Target)
            h = safe_dist((vy, vx), (y2, x2))
            new_f = new_g + h
            
            heapq.heappush(pq, (new_f, new_g, v, curr_bearing, path + [v]))
            
    return None

def prune_spurs_stack(nodes):
    """
    [A46] Stack-based Backtracking Pruner.
    Removes A -> B -> A patterns. (Spurs)
    """
    if not nodes: return []
    stack = [nodes[0]]
    
    for i in range(1, len(nodes)):
        curr = nodes[i]
        # Check if curr == stack[-2] (Going back to previous)
        if len(stack) >= 2 and curr == stack[-2]:
             stack.pop() # Remove the tip of the spur
        else:
             stack.append(curr)
             
    return stack

def remove_short_loops(path_nodes, window=10):
    """
    [新增] 智慧迴圈過濾：
    檢查當前節點是否在過去 window (預設10) 個步驟內出現過。
    如果出現過，代表走了一圈回到了原地，則直接刪除中間的繞路過程。
    例如: A -> B -> C -> D -> B -> E
    偵測到 B 重複，會變成: A -> B -> E (剪掉 C, D)
    """
    if not path_nodes: return []
    stack = []

    for node in path_nodes:
        # 1. 檢查 stack 最後 window 個元素中是否有 node
        # 我們只切片檢查最後 'window' 個節點，避免剪掉很久以前經過的交叉路口
        search_slice = stack[-window:] if len(stack) > window else stack
        
        if node in search_slice:
            # 找到重複了！發生繞路
            # 找出這個節點在 search_slice 中的相對位置
            relative_idx = search_slice.index(node)
            
            # 計算該節點在整個 stack 中的絕對位置
            # 公式：Stack總長 - Slice長度 + Slice中該節點的Index
            absolute_idx = len(stack) - len(search_slice) + relative_idx
            
            # 剪裁 Stack：只保留到第一次出現該節點的位置
            # 這樣中間加入的節點 (B->C->D->B 的 C,D,以及第二個B) 都會被丟棄
            stack = stack[:absolute_idx + 1]
        else:
            stack.append(node)
            
    return stack

# [A46] Original function wrapper
def remove_zigzags(path_nodes, G, threshold=50):
    # Simplified placeholder
    return path_nodes

# [B2] Spur Pruning (Advanced U-turn Removal)
def remove_meaningless_uturns(nodes, G, threshold=60, shortcut_m=5):
    if not nodes or len(nodes) < 3: return nodes
    
    # Pass 1: Zigzags 
    try:
        nodes = remove_zigzags(nodes, G, threshold=threshold)
    except Exception: pass
    
    if len(nodes) < 3: return nodes
    
    clean_nodes = [nodes[0]]
    skip_next = False
    
    for i in range(1, len(nodes)-1):
        if skip_next:
            skip_next = False
            continue
            
        p1 = nodes[i-1]
        p2 = nodes[i]   
        p3 = nodes[i+1]
        
        try:
            c1 = (G.nodes[p1]['y'], G.nodes[p1]['x'])
            c2 = (G.nodes[p2]['y'], G.nodes[p2]['x'])
            c3 = (G.nodes[p3]['y'], G.nodes[p3]['x'])
            
            dist_shortcut = safe_dist(c1, c3)
            dist_leg1 = safe_dist(c1, c2)
            dist_leg2 = safe_dist(c2, c3)
            
            # 繞出去又回到 shortcut_m 內、但實際走了 >20m -> 是無意義的折返，刪掉中間點
            if dist_shortcut < shortcut_m and (dist_leg1 + dist_leg2) > 20:
                continue
        except Exception: pass
        
        clean_nodes.append(p2)
        
    clean_nodes.append(nodes[-1])
    return clean_nodes

def remove_backtracks(G, nodes,
                      return_radius_m=None, min_excursion_m=None, window=None):
    """
    [Fix 無意義折返] 剪掉「繞出去又折返回原地」的來回路段。

    對每個位置 i 往後找 j：若走到 j 時「實際已走 >= min_excursion_m」，
    但 j 的位置卻回到 i 的 return_radius_m 以內，代表這段是白走的來回 -> 剪掉中間。
    會挑「最遠的合格 j」，以便一次剪掉整段來回。

    只刪除節點，之後由 bridge_node_path_gaps 沿真實道路把接縫補回。
    """
    if return_radius_m is None: return_radius_m = BACKTRACK_RETURN_RADIUS_M
    if min_excursion_m is None: min_excursion_m = BACKTRACK_MIN_EXCURSION_M
    if window is None: window = BACKTRACK_WINDOW
    if not nodes or len(nodes) < 4 or G is None:
        return nodes

    _pos = {}
    def P(n):
        if n not in _pos:
            _pos[n] = (G.nodes[n]['y'], G.nodes[n]['x']) if n in G.nodes else None
        return _pos[n]

    out = []
    i = 0
    N = len(nodes)
    while i < N:
        out.append(nodes[i])
        pi = P(nodes[i])
        best_j = None
        if pi is not None:
            walked = 0.0
            prev = pi
            for j in range(i + 1, min(i + window + 1, N)):
                pj = P(nodes[j])
                if pj is None:
                    continue
                walked += haversine(prev[0], prev[1], pj[0], pj[1])
                prev = pj
                if walked >= min_excursion_m and \
                   haversine(pi[0], pi[1], pj[0], pj[1]) <= return_radius_m:
                    # [關鍵防呆] 回到原地有兩種：
                    #   (a) 原路折返 -> 路徑幾乎重疊，圍出的面積 ~ 0 (要剪掉)
                    #   (b) 繞了一圈 -> 例如畫圓，圍出很大的面積 (絕對不能剪！)
                    # 用「細長度」= 實際面積 / 同周長圓的面積 來分辨。
                    ring = [P(n) for n in nodes[i:j + 1]]
                    ring = [p for p in ring if p is not None]
                    area = calculate_polygon_area(ring) if len(ring) >= 3 else 0.0
                    max_area = (walked ** 2) / (4 * math.pi) if walked > 0 else 0.0
                    thinness = (area / max_area) if max_area > 0 else 0.0
                    if thinness < BACKTRACK_MAX_THINNESS:
                        best_j = j      # 繼續找更遠的，盡量一次剪乾淨
        if best_j is not None:
            i = best_j              # 跳過中間的來回 (下一圈會 append nodes[best_j])
            continue
        i += 1
    return out

def remove_geometric_spikes(nodes, G):
    """
    [A46] Geometric Spike Filter:
    Removes 'B' in A->B->C if the angle is too sharp (V-turn), 
    often caused by snapping to side streets.
    """
    if len(nodes) < 3: return nodes
    
    clean_nodes = [nodes[0]]
    # Iterate from 1 to len-2
    # We will manually manage the loop to allow skipping 'B'
    
    i = 1
    while i < len(nodes) - 1:
        prev_n = clean_nodes[-1] # Validated prev
        curr_n = nodes[i]
        next_n = nodes[i+1]
        
        # 1. Direct Reversal
        if prev_n == next_n:
            i += 1
            continue
            
        # 2. Geometric Angle
        should_prune = False
        if G and prev_n in G.nodes and curr_n in G.nodes and next_n in G.nodes:
            try:
                x1, y1 = G.nodes[prev_n]['x'], G.nodes[prev_n]['y']
                x2, y2 = G.nodes[curr_n]['x'], G.nodes[curr_n]['y']
                x3, y3 = G.nodes[next_n]['x'], G.nodes[next_n]['y']
                
                # Vectors
                v1x, v1y = x2 - x1, y2 - y1
                v2x, v2y = x3 - x2, y3 - y2
                
                # Norms
                n1 = math.sqrt(v1x*v1x + v1y*v1y)
                n2 = math.sqrt(v2x*v2x + v2y*v2y)
                
                if n1 > 0 and n2 > 0:
                    dot = v1x*v2x + v1y*v2y
                    cos_theta = dot / (n1 * n2)
                    
                    # -0.7 approx 135 degrees rebound
                    # If sharp rebound AND short spike (e.g. < 40m leg)
                    if cos_theta < -0.7:
                         # Length check: Only prune if 'excursion' is short.
                         # If it's a long detour, it might be real.
                         if n1 < 0.0004 and n2 < 0.0004: # Approx 40-50m in degrees (rough)
                             should_prune = True
            except Exception: pass
            
        if should_prune:
             # Skip curr_n
             pass
        else:
             clean_nodes.append(curr_n)
        i += 1
        
    clean_nodes.append(nodes[-1])
    return clean_nodes

def prune_final_spurs(segments, G_mid):
    """
    [Phase 75] Spur Pruning: Multi-pass removal of A->B->A artifacts (<50m).
    """
    for seg in segments:
        if not seg.get('nodes'): continue
        nodes = seg['nodes']
        
        while True:
            changed = False
            if len(nodes) < 3: break
            
            i = 0
            while i < len(nodes) - 2:
                n1, n2, n3 = nodes[i], nodes[i+1], nodes[i+2]
                
                # Check for A-B-A
                if n1 == n3:
                    should_prune = False
                    
                    # Distance Check
                    try:
                        if G_mid and n1 in G_mid.nodes and n2 in G_mid.nodes:
                            y1, x1 = G_mid.nodes[n1]['y'], G_mid.nodes[n1]['x']
                            y2, x2 = G_mid.nodes[n2]['y'], G_mid.nodes[n2]['x']
                            dist_m = ((x1-x2)**2 + (y1-y2)**2)**0.5 * 111000
                            # Increased threshold to 50m to catch larger U-turn artifacts
                            if dist_m < 50: should_prune = True
                        else:
                            should_prune = True
                    except Exception: should_prune = True

                    if should_prune:
                        nodes.pop(i+1) # Remove B
                        nodes.pop(i+1) # Remove A (duplicate)
                        changed = True
                        # Don't increment i, check new neighbor
                        continue
                        
                i += 1
            
            if not changed: break
            
        seg['nodes'] = nodes
        # Re-generate coords
        if G_mid: seg['coords'] = get_path_geometry(G_mid, nodes)
        
    return segments

def prune_non_overlapping_segments(segments, red_strokes, G, threshold=40):
    """
    [A46] Strict Overlap Check:
    Deletes any generated blue nodes/coords that are more than `threshold` meters 
    away from the red strokes. This effectively removes "hallucinated" detours.
    """
    if not segments or not red_strokes: return segments
    
    # 1. Flatten and densify red strokes
    red_points = []
    for s in red_strokes:
        if len(s) > 1:
            # Interpolate (20m step) to ensure coverage
            red_points.extend(interpolate_dense(s, step=20))
        else:
            red_points.extend(s)
            
    if not red_points: return segments
    
    keep_segments = []
    
    for seg in segments:
        # Skip 'travel' or 'impossible' (Keep them always as they bridge gaps)
        if seg.get('kind') in ['travel', 'impossible']:
            keep_segments.append(seg)
            continue
            
        filtered_seg = None
        
        # ROAD type
        if seg.get('type') == 'road' and seg.get('nodes'):
            valid_nodes = []
            ns = seg['nodes']
            
            for n in ns:
                is_valid = False
                # Check distance
                if G and n in G.nodes:
                    p = (G.nodes[n]['y'], G.nodes[n]['x'])
                    # Quick check against nearest red point
                    _, d = find_nearest_point_on_strokes(p[0], p[1], [red_points])
                    if d < threshold: is_valid = True
                else: 
                    is_valid = False # [Fix] If node unknown, assume Invalid (safe deletion)
                    
                if is_valid: valid_nodes.append(n)
            
            # Reconstruct if we have roughly enough nodes relative to original unique nodes?
            # Or just keep whatever valid pieces? 
            # If we cut the middle, we join A->C. That matches "Remove non-overlapping".
            
            if len(valid_nodes) >= 2: # Keep segment if at least 2 points remain
                # Optimization: Check if we just removed everything
                new_s = seg.copy()
                new_s['nodes'] = valid_nodes
                # Refresh coords
                if G: new_s['coords'] = get_path_geometry(G, valid_nodes)
                filtered_seg = new_s
        
        # COORDS type (Beeline Draw)
        elif seg.get('coords'):
            valid_coords = []
            for p in seg['coords']:
                _, d = find_nearest_point_on_strokes(p[0], p[1], [red_points])
                if d < threshold: valid_coords.append(p)
                
            if len(valid_coords) >= 2:
                new_s = seg.copy()
                new_s['coords'] = valid_coords
                filtered_seg = new_s
                
        if filtered_seg:
             keep_segments.append(filtered_seg)
        # else: Drop segment
    

    return keep_segments

def advanced_shortcut_optimizer(G, path_nodes, lookahead=40, max_search_dist=300):
    """
    [穩定版] 智慧截彎取直
    只使用 Graph 最短路徑來優化，不進行強制穿越 (Jaywalking) 或全域剪除。
    保證生成的路徑一定是在路網上合法的。
    """
    if not path_nodes or len(path_nodes) < 3: return path_nodes

    # 建立座標快取
    node_coords = {}
    for n in path_nodes:
        if n not in node_coords and n in G.nodes:
            node_coords[n] = (G.nodes[n]['y'], G.nodes[n]['x'])
            
    new_path = [path_nodes[0]]
    i = 0
    
    while i < len(path_nodes) - 1:
        best_shortcut_path = None
        best_jump_idx = -1
        
        curr_n = path_nodes[i]
        if curr_n not in node_coords:
            new_path.append(path_nodes[i+1]); i += 1; continue
            
        c_y, c_x = node_coords[curr_n]
        
        # 搜尋範圍
        # [Fix 閉合圖形崩塌] 單次捷徑最多只能跳過整條路徑的 1/4。
        # 否則畫圓這種「終點就在起點旁邊」的閉合圖形，會被視為一個超划算的捷徑
        # 而整圈被抄掉 (實測 58 節點的圓會被縮成 1 個節點)。
        # 截彎取直的用途是修掉局部繞路，不該把使用者畫的形狀本身抹掉。
        span_cap = max(2, len(path_nodes) // 4)
        max_step = min(lookahead, len(path_nodes) - 1 - i, span_cap)
        
        # 倒序搜尋
        for k in range(max_step, 1, -1): 
            target_idx = i + k
            target_n = path_nodes[target_idx]
            if target_n not in node_coords: continue
            
            t_y, t_x = node_coords[target_n]
            air_dist = haversine(c_y, c_x, t_y, t_x)
            
            # 如果物理距離太遠，就不嘗試 (避免跨河)
            if air_dist > max_search_dist: continue
            
            # 估算原本路徑長度 (保守估計)
            original_path_est = k * 5 
            
            # 只有當「物理距離」明顯小於「路徑距離」時才嘗試運算
            if air_dist * 1.5 < original_path_est:
                try:
                    # 嘗試找出兩點間的最短路徑 (完全依照路網)
                    shortcut_path = nx.shortest_path(G, curr_n, target_n, weight='length')
                    
                    # 只有當真的省下節點時才替換
                    if len(shortcut_path) < k:
                        best_shortcut_path = shortcut_path
                        best_jump_idx = k
                        break
                except Exception:
                    continue
        
        if best_shortcut_path:
            # 接上捷徑 (去掉頭)
            new_path.extend(best_shortcut_path[1:])
            i += best_jump_idx
        else:
            new_path.append(path_nodes[i+1])
            i += 1
            
    return new_path

def optimize_stroke_order(strokes, user_end=None):
    """
    [新增] 筆畫順序最佳化 (Greedy Reordering)
    將多筆畫重新排序與翻轉，使筆畫之間的連接距離最短。
    解決「非一筆畫」導致的亂連問題。
    """
    if not strokes or len(strokes) < 2:
        return strokes

    # 複製一份以免影響原始資料
    pool = strokes[:] 
    ordered = []
    
    # helper to get geo
    def get_geo(item):
        if isinstance(item, dict) and 'geo' in item: return item['geo']
        return item
    
    # [End Anchor] Reserve Last Stroke
    final_stroke = None
    if user_end:
        best_end_idx = -1
        min_end_dist = float('inf')
        should_reverse_final = False
        
        for i, s_item in enumerate(pool):
            s = get_geo(s_item)
            # Distance from TAIL to user_end
            d1 = safe_dist(s[-1], user_end)
            # Distance from HEAD to user_end (if reversed)
            d2 = safe_dist(s[0], user_end)
            
            if d1 < min_end_dist:
                min_end_dist = d1; best_end_idx = i; should_reverse_final = False
            if d2 < min_end_dist:
                min_end_dist = d2; best_end_idx = i; should_reverse_final = True
                
        if best_end_idx != -1:
            final_item = pool.pop(best_end_idx)
            if should_reverse_final:
                # Need to reverse 'geo' inside dict or list
                if isinstance(final_item, dict) and 'geo' in final_item:
                    final_item['geo'] = final_item['geo'][::-1]
                else:
                    final_item = final_item[::-1]
            final_stroke = final_item

    # 1. 以第一筆為起點 (或者也可以找最接近 User Start 的筆畫)
    # 這裡簡單起見，保留使用者的第一筆作為起始
    if pool:
        current_stroke = pool.pop(0)
        ordered.append(current_stroke)
    
    while pool:
        # 目前路徑的最後一點
        s_curr = get_geo(ordered[-1])
        current_end = s_curr[-1]
        
        # Calculate incoming vector (for angle continuity)
        v_in = (0, 0)
        if len(s_curr) > 1:
            p_prev = s_curr[-2]
            v_in = (current_end[0] - p_prev[0], current_end[1] - p_prev[1]) # dy, dx (lat, lon)
        
        best_cost = float('inf')
        best_idx = -1
        should_reverse = False
        
        # Heuristic Weights
        W_DIST = 1.0
        W_ANGLE = 500.0 # Penalty per radian (High penalty for turning)
        
        # 2. 在剩餘池中尋找最佳筆畫
        for i, s_item in enumerate(pool):
            s = get_geo(s_item)
            start_pt = s[0]
            end_pt = s[-1]
            
            # --- Check HEAD connection ---
            d_head = safe_dist(current_end, start_pt)
            cost_head = d_head * W_DIST
            
            # Angle Penalty
            if v_in != (0, 0) and d_head > 0.1: # If very close, angle doesn't matter (it's a join)
                 # Vector to start
                 v_conn = (start_pt[0] - current_end[0], start_pt[1] - current_end[1])
                 # Angle difference
                 ang_in = math.atan2(v_in[0], v_in[1])
                 ang_conn = math.atan2(v_conn[0], v_conn[1])
                 diff = abs(ang_in - ang_conn)
                 if diff > math.pi: diff = 2*math.pi - diff
                 cost_head += diff * W_ANGLE
            
            # --- Check TAIL connection (Reverse) ---
            d_tail = safe_dist(current_end, end_pt)
            cost_tail = d_tail * W_DIST
            
            if v_in != (0, 0) and d_tail > 0.1:
                 v_conn = (end_pt[0] - current_end[0], end_pt[1] - current_end[1])
                 ang_in = math.atan2(v_in[0], v_in[1])
                 ang_conn = math.atan2(v_conn[0], v_conn[1])
                 diff = abs(ang_in - ang_conn)
                 if diff > math.pi: diff = 2*math.pi - diff
                 cost_tail += diff * W_ANGLE
            
            if cost_head < best_cost:
                best_cost = cost_head
                best_idx = i
                should_reverse = False
            
            if cost_tail < best_cost:
                best_cost = cost_tail
                best_idx = i
                should_reverse = True
        
        # 3. 取出最佳筆畫並加入結果
        if best_idx != -1:
            next_stroke = pool.pop(best_idx)
            # Handle reverse for object or list
            if should_reverse:
                if isinstance(next_stroke, dict) and 'geo' in next_stroke:
                    # Don't mutate original dict logic if possible, or copy?
                    # But we made a shallow copy of list. Dicts are ref.
                    # Create new dict
                    new_item = next_stroke.copy()
                    new_item['geo'] = next_stroke['geo'][::-1]
                    
                    # [vLINE Fix] Reverse Metadata Nodes too!
                    if 'meta' in new_item and 'nodes' in new_item['meta']:
                        # Copy meta to avoid mutating shared ref?
                        new_meta = new_item['meta'].copy()
                        if isinstance(new_meta['nodes'], list):
                             new_meta['nodes'] = new_meta['nodes'][::-1]
                        new_item['meta'] = new_meta
                        
                    next_stroke = new_item
                else:
                    next_stroke = next_stroke[::-1] # 翻轉筆畫
            ordered.append(next_stroke)
        else:
            # 防呆：如果不幸沒找到 (極罕見)，就隨便拿一個
            ordered.append(pool.pop(0))
            
    # [End Anchor] Append the reserved last stroke
    if final_stroke:
        ordered.append(final_stroke)

    return ordered

# [Phase 26] Micro-Bridge Autoconnect
def patch_micro_gaps(G_full, blue_pool):
    """
    Detects small gaps (<20m) between stroke endpoints and other strokes.
    Inserts 'Blue' bridges (Required Edges) and splits strokes at T-junctions
    to allow the CPP solver to treat them as connected drawing components.
    """
    debug_log("[Phase 26] Patching Micro-Gaps (<20m)...")
    
    # 1. Index Strokes
    # stroke_id -> { 'nodes': [n1, n2...], 'type': ... }
    # Only care about road/nodes strokes for splitting
    valid_strokes = []
    for s in blue_pool:
        if s.get('type') == 'road' and s.get('nodes'):
             valid_strokes.append(s)
    
    if not valid_strokes: return blue_pool

    # 2. Collect Tips (Endpoints)
    tips = [] # (stroke_idx, node_id, is_start, coords)
    for i, s in enumerate(valid_strokes):
        nodes = s['nodes']
        if not nodes: continue
        
        # Start
        n_s = nodes[0]
        if n_s in G_full.nodes:
             tips.append( (i, n_s, True, (G_full.nodes[n_s]['y'], G_full.nodes[n_s]['x'])) )
        
        # End
        n_e = nodes[-1]
        if n_e != n_s and n_e in G_full.nodes:
             tips.append( (i, n_e, False, (G_full.nodes[n_e]['y'], G_full.nodes[n_e]['x'])) )

    # 3. Find Bridges & Splits
    bridges = [] # (u, v, dist)
    splits = {i: set() for i in range(len(valid_strokes))} # stroke_idx -> set(node_ids)
    
    # Threshold in degrees approx 20m
    # 1 deg lat ~ 111km -> 20m ~ 0.00018 deg
    # Threshold in degrees approx 30m (User Request)
    THRESH = 30.0 * 0.000009 # 1m approx 0.000009 deg
    if THRESH < 0.0003: THRESH = 0.0003 # Min ~33m 
    
    for t_idx, t_node, _, t_coords in tips:
        # Scan ALL strokes (including self? No, skip self-gap usually, but loop closing is distinct)
        for s_idx, s in enumerate(valid_strokes):
            # Optimization: Bounding box check? For now brute force (N < 100 usually)
            
            # Find closest node in s
            best_n = None
            best_d = float('inf')
            
            # Iterate nodes of s
            for n in s['nodes']:
                 # Avoid self-connect to immediate neighbor?
                 # If s_idx == t_idx and n == t_node: continue
                 
                 # Check dist
                 if n in G_full.nodes:
                     ny, nx_ = G_full.nodes[n]['y'], G_full.nodes[n]['x']
                     d = haversine(t_coords[1], t_coords[0], nx_, ny) # lon, lat
                     if d < best_d:
                         best_d = d
                         best_n = n
            
            # Check Valid Bridge
            if best_n and best_d < THRESH and best_d > 0.1: # >0.1 means distinct node
                
                # [Phase 39] Seam Rotation (User Request)
                # If bridging to a Circle, rotate geometry so Start/End aligns with bridge.
                # This eliminates 'East Node' and redundant traversals.
                target_s = valid_strokes[s_idx]
                if target_s.get('mode') in ['circle', 'brush']:
                    try:
                        k = target_s['nodes'].index(best_n)
                        # If internal point (not 0 or last), rotate
                        if 0 < k < len(target_s['nodes']) - 1:
                            debug_log(f"  [Phase 39] Rotating Seam to {best_n} (idx {k})")
                            # Rotate Nodes: [C, D, A, B, C]
                            ns = target_s['nodes']
                            target_s['nodes'] = ns[k:-1] + ns[:k] + [ns[k]]
                            # Rotate Coords
                            cs = target_s['coords']
                            target_s['coords'] = cs[k:-1] + cs[:k] + [cs[k]]
                    except Exception: pass

                # Found Bridge!
                # Is it duplicate? (u, v) vs (v, u)
                # Check exist
                pair = tuple(sorted((t_node, best_n)))
                exists = False
                for b in bridges:
                    if tuple(sorted((b[0], b[1]))) == pair: exists = True; break
                
                if not exists:
                    debug_log(f"  Gap Found: {best_d:.1f}m. Connecting {t_node} -> {best_n} (Stroke {s_idx})")
                    bridges.append( (t_node, best_n, best_d) )
                    
                    # Mark split on target stroke if it's internal
                    splits[s_idx].add(best_n)

    if not bridges: 
        return blue_pool

    # 4. Reconstruct Blue Pool
    new_pool = []
    
    # Process original strokes with splits
    for i, s in enumerate(valid_strokes):
        split_points = splits[i]
        
        if not split_points:
            new_pool.append(s)
            continue
            
        # Split logic
        current_sub = []
        original_nodes = s['nodes']
        
        for n in original_nodes:
            current_sub.append(n)
            if n in split_points and n != original_nodes[-1]: # Don't split at very last node effectively
                 # Finish sub-stroke
                 if len(current_sub) > 1:
                      # Create new stroke
                      coords = get_path_geometry(G_full, current_sub)
                      new_pool.append({'type': 'road', 'nodes': current_sub, 'coords': coords, 'kind': 'draw'})
                 # Start new sub-stroke from this node
                 current_sub = [n]
        
        # Add remaining
        if len(current_sub) > 1:
             coords = get_path_geometry(G_full, current_sub)
             new_pool.append({'type': 'road', 'nodes': current_sub, 'coords': coords, 'kind': 'draw'})

    # 5. Add Bridges
    for u, v, d in bridges:
        try:
            path = nx.shortest_path(G_full, u, v, weight='length')
            coords = get_path_geometry(G_full, path)
            new_pool.append({'type': 'road', 'nodes': path, 'coords': coords, 'kind': 'draw'}) # Blue!
        except Exception:
             pass
             
    # Add back non-road items? (like beelines if any?)
    for s in blue_pool:
        if s.get('type') != 'road': new_pool.append(s)
    debug_log(f"[Phase 26] Patched. Strokes: {len(blue_pool)} -> {len(new_pool)}")
    return new_pool

# [vCPP] Chinese Postman Solver (Stochastic Wrapper)
# ===========================
def solve_chinese_postman(G_full, blue_pool, user_start_geo, user_end_geo, weight_key='length'):
    """
    [vCPP] Stochastic Wrapper (Phase 38 Strict):
    Delegates to _solve_cpp_core with perturbations.
    Rank candidates by Overlap, Backtrack, Flow Consistency, and Terminal Isolation.
    """
    import random
    import math
    
    # [Phase 44] Precise Seam Rotation (User Request)
    # Rotate Circle strokes to align Seam with nearest "Magnet" (Start, End, or Junction).
    # Identify Magnets
    magnets = []
    if user_start_geo: magnets.append(user_start_geo)
    if user_end_geo: magnets.append(user_end_geo)
    
    # Add endpoints of NON-Circle strokes as Magnets
    for s in blue_pool:
        if s.get('mode') not in ['circle', 'brush'] and s.get('coords'):
            magnets.append(s['coords'][0])
            magnets.append(s['coords'][-1])
            
    # [Phase 48] Strict User Algorithm (Rotation + Wormhole)
    # 1. Atomic Ring: Treat circle as one unit (Revert Splitting).
    # 2. First Contact (Magnet): Rotate Start to nearest Magnet.
    # 3. Wormhole: Inject shortcut to override road network.
    
    
    # Identify Magnets
    magnets = []
    if user_start_geo: magnets.append(user_start_geo)
    if user_end_geo: magnets.append(user_end_geo)
    for s in blue_pool:
        if s.get('mode') not in ['circle', 'brush'] and s.get('coords'):
            magnets.append(s['coords'][0])
            magnets.append(s['coords'][-1])

    for s in blue_pool:
        if s.get('mode') in ['circle', 'brush']:
             if not s.get('coords'): continue
             
             # Find Primary Magnet (Closest)
             coords = s['coords']
             best_k = 0
             best_dist = float('inf')
             best_mag = None
             
             for mag in magnets:
                 mx, my = mag[1], mag[0]
                 for k, p in enumerate(coords):
                     d = (p[0]-mx)**2 + (p[1]-my)**2
                     if d < best_dist:
                         best_dist = d; best_k = k; best_mag = mag
             
             # 1. Rotate Coords
             if best_k > 0:
                 s['coords'] = coords[best_k:-1] + coords[:best_k] + [coords[best_k]]
                 
             # 2. Rotate Nodes
             if s.get('nodes'):
                 ns = s['nodes']
                 # Find node closest to best_mag (Precise)
                 best_nk = 0
                 best_ndist = float('inf')
                 
                 if best_mag:
                     mx, my = best_mag[1], best_mag[0]
                     for k, n in enumerate(ns):
                         if n in G_full.nodes:
                             ny, nx_ = G_full.nodes[n]['y'], G_full.nodes[n]['x']
                             d = (nx_-mx)**2 + (ny-my)**2
                             if d < best_ndist:
                                 best_ndist = d; best_nk = k
                 
                 if best_nk > 0:
                      debug_log(f"  [Phase 48] Rotating Circle to Magnet: Node {best_nk}")
                      s['nodes'] = ns[best_nk:-1] + ns[:best_nk] + [ns[best_nk]]
             
             # 3. Inject Wormhole to New Start
             if best_mag and s.get('nodes'):
                 n_target = s['nodes'][0]
                 mx, my = best_mag[1], best_mag[0]
                 
                 # Dist limit 80m approx 5e-7
                 if best_dist < 0.0000008: 
                      # Find ID for Magnet
                      n_mag = None
                      try: n_mag = nearest_node(G_full, mx, my)
                      except Exception: pass
                      
                      if n_mag and n_mag != n_target:
                          dist_m = math.sqrt(best_dist) * 111000
                          debug_log(f"  [Phase 48] Injecting Wormhole: {n_mag}->{n_target} ({dist_m:.1f}m)")
                          G_full.add_edge(n_mag, n_target, length=dist_m, type='beeline', weight=dist_m)
                          G_full.add_edge(n_target, n_mag, length=dist_m, type='beeline', weight=dist_m)

    # [Phase 26] Patch Micro-Gaps (Auto-Connect <30m)
    blue_pool = patch_micro_gaps(G_full, blue_pool)
            

    
    CANDIDATES = []
    
    # [Phase 38] Increase Attempts to 20 to find valid path in strict constraint space
    attempts = [0.0] + [random.uniform(0.01, 0.2) for _ in range(19)]
    
    debug_log(f"[vCPP] Running {len(attempts)} optimization passes (Strict Mode)...")
    
    # Pre-calc edge maps for scoring
    edge_mode_map = {}
    blue_edges_req = {}
    blue_adj = {}
    
    for item in blue_pool:
         mode = item.get('mode', 'line')
         if item.get('nodes'):
             ns = item['nodes']
             for k in range(len(ns)-1):
                 u, v = ns[k], ns[k+1]
                 key = tuple(sorted((u, v)))
                 edge_mode_map[key] = mode
                 blue_edges_req[key] = blue_edges_req.get(key, 0) + 1
                 
                 blue_adj.setdefault(u, []).append(key)
                 blue_adj.setdefault(v, []).append(key)

    # [Phase 37] Identify Terminal Nodes
    s_node_id = None
    e_node_id = None
    s_req_visits = 1
    e_req_visits = 1
    
    try:
        if user_start_geo:
            s_node_id = nearest_node(G_full, user_start_geo[1], user_start_geo[0])
            # [Phase 38] Smart Check: Required Visits = ceil((Degree+1)/2)
            deg = len(blue_adj.get(s_node_id, []))
            s_req_visits = math.ceil((deg + 1) / 2.0)
            if s_req_visits < 1: s_req_visits = 1 # Always at least 1 (Depart)

        if user_end_geo:
            e_node_id = nearest_node(G_full, user_end_geo[1], user_end_geo[0])
            deg = len(blue_adj.get(e_node_id, []))
            e_req_visits = math.ceil((deg + 1) / 2.0)
            if e_req_visits < 1: e_req_visits = 1 # Always at least 1 (Arrive)
            
    except Exception: pass
    
    debug_log(f"  Gap Constraints: Start {s_req_visits} visits, End {e_req_visits} visits allowed.")

    seen_signatures = set()

    for i, noise in enumerate(attempts):
        try:
            # Delegate to Core
            segments = _solve_cpp_core(G_full, blue_pool, user_start_geo, user_end_geo, perturbation=noise, weight_key=weight_key)
            if not segments: continue
            
            # --- Scoring ---
            # 1. Signature Deduplication
            sig_edges = set()
            path_edge_counts = {}
            all_nodes = []
            
            for s in segments:
                if s.get('nodes'):
                    ns = s['nodes']
                    if not all_nodes: all_nodes.extend(ns)
                    else:
                        if all_nodes[-1] == ns[0]: all_nodes.extend(ns[1:])
                        else: all_nodes.extend(ns)

                    for k in range(len(ns)-1):
                        key = tuple(sorted((ns[k], ns[k+1])))
                        if s.get('kind') == 'travel': sig_edges.add(key)
                        path_edge_counts[key] = path_edge_counts.get(key, 0) + 1
            
            sig_frozen = frozenset(sig_edges)
            if sig_frozen in seen_signatures: continue
            seen_signatures.add(sig_frozen)
            
            # 2. Total Distance (Score)
            total_score = len(all_nodes) 
            
            # 3. Overlap Penalty
            overlap_penalty = 0
            for key, act_count in path_edge_counts.items():
                req = blue_edges_req.get(key, 0)
                if req > 0:
                    if act_count > req + 1: overlap_penalty += (act_count - req - 1) * 100 # High penalty
                else: 
                     if act_count > 1: overlap_penalty += (act_count - 1) * 50

            # 4. Backtrack Penalty
            backtrack_pen = 0
            visited_e = set()
            if len(all_nodes) > 2:
                for k in range(len(all_nodes)-2):
                    c, n, f = all_nodes[k], all_nodes[k+1], all_nodes[k+2]
                    visited_e.add(tuple(sorted((c, n))))
                    if f == c: # U-Turn
                        if n in blue_adj:
                             for be in blue_adj[n]:
                                 if be not in visited_e:
                                     mode = edge_mode_map.get(be, 'line')
                                     w = 5000 if mode in ['circle', 'brush'] else 10 # Massive penalty
                                     backtrack_pen += w
                                     break
            
            # 5. [Phase 52] Strict Clockwise Constraint
            flow_penalty = 0
            # Iterate segments. If 'circle' and winding is CCW (Angle > 0.5), FATAL PENALTY.
            
            for s in segments:
                 # Check mode
                 if s.get('nodes'):
                     key = tuple(sorted((s['nodes'][0], s['nodes'][1])))
                     mode = edge_mode_map.get(key, 'line')
                     
                     if mode == 'circle' and s.get('coords'):
                         angle = get_winding_angle(s['coords'])
                         # CW is Negative/Small?
                         # My get_winding_angle: 
                         # sum of turning angles.
                         # CCW circle ~ +2pi (+6.28)
                         # CW circle ~ -2pi (-6.28)
                         # So if angle > 2.0 (radians approx? check implementation), it is CCW.
                         
                         if angle > 1.0: # Strongly CCW
                             flow_penalty += 100000000 # INSTANT DEATH
                             # debug_log(f"  [Penalty] CCW Circle Segment detected (Angle={angle:.2f}).")
            
            # 6. [Phase 38] Smart Terminal Isolation
            
            # 6. [Phase 38] Smart Terminal Isolation
            term_penalty = 0
            
            if s_node_id:
                s_count = all_nodes.count(s_node_id)
                if s_count > s_req_visits: term_penalty += 10000000
            
            if e_node_id:
                e_count = all_nodes.count(e_node_id)
                if e_count > e_req_visits: term_penalty += 10000000

            CANDIDATES.append( (total_score, segments, overlap_penalty, backtrack_pen + flow_penalty + term_penalty) )
            debug_log(f"  Pass {i}: Ov={overlap_penalty}, Bt={backtrack_pen}, Flow={flow_penalty:.0f}, Term={term_penalty}")
            
        except Exception as e:
            debug_log(f"  Attempt {i} failed: {e}")

    # Sort: 1. Term (Fatal), 2. Overlap/Flow/Backtrack (Critical), 3. Length
    # Combine constraints into one 'Badness' score
    CANDIDATES.sort(key=lambda x: (x[3] + x[2]*100, x[0])) 
    
    if CANDIDATES:
        return [c[1] for c in CANDIDATES]
    else:
        return []

def _solve_cpp_core(G_full, blue_pool, user_start_geo, user_end_geo, perturbation=0.0, weight_key='length'):
    """
    """
    import networkx as nx
    import itertools
    import random
    import math

    # [Phase 62] Decoupled Access Strategy
    # 1. Build Art Graph (Strictly from Blue Pool, NO User Nodes yet)
    G_art = nx.MultiGraph()
    
    for i, item in enumerate(blue_pool):
        if item.get('type') == 'road' and item.get('nodes'):
            raw_nodes = item['nodes']
            if not raw_nodes: continue
            
            # [Phase 23] Stroke Fragmentation
            # Split long strokes at intersections (degree > 2) to allow flexible routing
            # But ensure we don't split at every node, only at key junctions.
            
            current_seg_nodes = [raw_nodes[0]]
            
            for k in range(1, len(raw_nodes)):
                u = raw_nodes[k]
                current_seg_nodes.append(u)
                
                # Check split condition: 
                # 1. End of stroke
                # 2. Intersection (Degree > 2 in G_full) - Allow departure
                is_last = (k == len(raw_nodes) - 1)
                is_intersection = False
                
                if not is_last and u in G_full.nodes:
                    try:
                         # Use cached degree if possible? Or just check adjacency
                         # G_full is MultiDiGraph. 
                         # A true intersection usually has > 2 neighbors.
                         if G_full.degree(u) > 2: is_intersection = True
                    except Exception: pass
                
                if is_last or is_intersection:
                    # Finalize Segment
                    if len(current_seg_nodes) > 1:
                        seg_u, seg_v = current_seg_nodes[0], current_seg_nodes[-1]
                        
                        # Calculate length
                        seg_len = 0
                        coords = []
                        # Retrieve coords
                        for ci in range(len(current_seg_nodes)-1):
                            n1, n2 = current_seg_nodes[ci], current_seg_nodes[ci+1]
                            # Try to get edge length
                            try:
                                # Get shortest edge between n1, n2
                                edata = G_full.get_edge_data(n1, n2)
                                # Pick min length key
                                min_l = 100000
                                best_key = 0
                                if edata:
                                     for ek, eval_d in edata.items():
                                         l = eval_d.get('length', 10)
                                         if l < min_l: 
                                             min_l = l
                                             best_key = ek
                                seg_len += min_l
                                
                                # Coords?
                                # This is expensive. For now, rely on nodes and post-processing.
                            except Exception: seg_len += 10
                            
                        G_art.add_edge(seg_u, seg_v, key=f"stroke_{i}_seg_{k}", length=seg_len, 
                                       original=True, path=current_seg_nodes, type='road', 
                                       coords=None) # Coords deferred
                                       
                    current_seg_nodes = [u] # Start new segment from here

        elif item.get('coords') and len(item['coords']) > 1:
            # [Fix] Support Raw/Beeline Strokes (Manual Mode)
            # Find nearest nodes for endpoints
            c_start = item['coords'][0]
            c_end = item['coords'][-1]
            try:
                u = nearest_node(G_full, c_start[1], c_start[0])
                v = nearest_node(G_full, c_end[1], c_end[0])
                
                # Calculate direct distance
                dist_m = safe_dist(c_start, c_end)
                
                G_art.add_edge(u, v, key=f"stroke_{i}", length=dist_m,
                               original=True, path=None, type='beeline',
                               coords=item['coords'])
            except Exception: pass
                           
    if len(G_art.nodes) == 0: return []
    
    # === [Fix] Step 2: Ensure Connectivity FIRST ===
    if not nx.is_connected(G_art):
        debug_log("[CPP] Graph disconnected. Running Smart Bridge (Terminal Priority)...")
        components = list(nx.connected_components(G_art))
        
        # [Phase 64.5] Identify Terminal Hubs (Start/End of components)
        node_strokes_map = {}
        
        # [Fix] Use G_art edges to map Nodes -> Stroke Indices (Supports Beelines)
        # Iterate all edges in the graph we just built
        for u, v, k, data in G_art.edges(keys=True, data=True):
             # Check if this edge belongs to a stroke (key="stroke_N")
             if isinstance(k, str) and k.startswith("stroke_"):
                 try:
                     parts = k.split("_")
                     if len(parts) >= 2:
                         idx = int(parts[1])
                         
                         if u not in node_strokes_map: node_strokes_map[u] = []
                         if v not in node_strokes_map: node_strokes_map[v] = []
                         
                         if idx not in node_strokes_map[u]: node_strokes_map[u].append(idx)
                         if idx not in node_strokes_map[v]: node_strokes_map[v].append(idx)
                 except Exception: pass
                 
        debug_log(f"  [Smart Bridge] Mapped {len(node_strokes_map)} hub nodes from G_art.")
        
        comp_hubs = []
        for c in components:
             min_idx = 99999999; max_idx = -1
             start_n = None; end_n = None
             for n in c:
                  if n in node_strokes_map:
                      indices = node_strokes_map[n]
                      if min(indices) < min_idx: min_idx = min(indices); start_n = n
                      if max(indices) > max_idx: max_idx = max(indices); end_n = n
             if not start_n: start_n = list(c)[0]
             if not end_n: end_n = list(c)[-1]
             comp_hubs.append( {'start': start_n, 'end': end_n} )

        C_graph = nx.Graph()
        
        for i, j in itertools.combinations(range(len(components)), 2):
            c1 = list(components[i]); c2 = list(components[j])
            min_d = float('inf'); best_pair = None
            
            s1 = c1 if len(c1) < 50 else c1[::len(c1)//50]
            s2 = c2 if len(c2) < 50 else c2[::len(c2)//50]
            
            h1 = comp_hubs[i]; h2 = comp_hubs[j]
            s1 = set(s1); s1.add(h1['end']); s1.add(h1['start'])
            s2 = set(s2); s2.add(h2['end']); s2.add(h2['start'])
            
            for u in s1:
                 # Penalty: Dist from Terminals
                 # This ensures we don't break out from the middle of a shape unless necessary
                 y1, x1 = G_full.nodes[u]['y'], G_full.nodes[u]['x']
                 ey1, ex1 = G_full.nodes[h1['end']]['y'], G_full.nodes[h1['end']]['x']
                 sy1, sx1 = G_full.nodes[h1['start']]['y'], G_full.nodes[h1['start']]['x']
                 p_u = min(((y1-ey1)**2 + (x1-ex1)**2)**0.5, ((y1-sy1)**2 + (x1-sx1)**2)**0.5) * 111000 * 1.5 
                 
                 for v in s2:
                      y2, x2 = G_full.nodes[v]['y'], G_full.nodes[v]['x']
                      sy2, sx2 = G_full.nodes[h2['start']]['y'], G_full.nodes[h2['start']]['x']
                      ey2, ex2 = G_full.nodes[h2['end']]['y'], G_full.nodes[h2['end']]['x']
                      p_v = min(((y2-sy2)**2 + (x2-sx2)**2)**0.5, ((y2-ey2)**2 + (x2-ex2)**2)**0.5) * 111000 * 1.5
                      
                      air_d = ((x1-x2)**2 + (y1-y2)**2)**0.5 * 111000
                      
                      if air_d + p_u + p_v < min_d: 
                           try:
                               d = nx.shortest_path_length(G_full, u, v, weight='length')
                               if d + p_u + p_v < min_d: min_d = d + p_u + p_v; best_pair = (u,v)
                           except Exception: pass
            
            if best_pair:
                final_w = min_d
                if perturbation > 0: final_w *= random.uniform(1.0 - perturbation, 1.0 + perturbation)
                C_graph.add_edge(i, j, weight=final_w, pair=best_pair)
                
        # MST
        mst_edges = nx.minimum_spanning_edges(C_graph, data=True)
        for u_idx, v_idx, data in mst_edges:
            real_u, real_v = data['pair']
            try:
                path = nx.shortest_path(G_full, real_u, real_v, weight=weight_key)
                dist = data['weight']
                coords = get_path_geometry(G_full, path)
                
                # Double Edge for Parity
                G_art.add_edge(real_u, real_v, length=dist, original=False, kind='travel', path=path, coords=coords)
                G_art.add_edge(real_v, real_u, length=dist, original=False, kind='travel', path=path[::-1], coords=coords[::-1])
            except Exception: pass
    
    # 3. Identify Entry/Exit on Art Graph (AFTER Connectivity Fix)
    s_node_art = None
    e_node_art = None
    
    nodes_art_list = list(G_art.nodes)
    
    # Helper to find nearest node in G_art
    def get_nearest_art_node(geo):
         best_n = None
         best_d = float('inf')
         y, x = geo
         for n in nodes_art_list:
             if n in G_full.nodes:
                 ny, nx_ = G_full.nodes[n]['y'], G_full.nodes[n]['x']
                 d = (nx_-x)**2 + (ny-y)**2
                 if d < best_d:
                     best_d = d
                     best_n = n
         return best_n

    if user_start_geo: s_node_art = get_nearest_art_node(user_start_geo)
    if user_end_geo: e_node_art = get_nearest_art_node(user_end_geo)
    
    if not s_node_art: s_node_art = nodes_art_list[0]
    if not e_node_art: e_node_art = nodes_art_list[-1]
    
    # Determine Mode
    dist_user = 1000.0
    if user_start_geo and user_end_geo:
        dist_user = ((user_start_geo[1]-user_end_geo[1])**2 + (user_start_geo[0]-user_end_geo[0])**2)**0.5 * 111000
    
    is_loop_mode = (dist_user < 50.0)
    
    if is_loop_mode:
        debug_log(f"[Phase 62] Loop Mode (Dist={dist_user:.1f}m). Entry==Exit.")
        e_node_art = s_node_art
    else:
        debug_log(f"[Phase 62] Open Mode (Dist={dist_user:.1f}m). Strict Entry/Exit.")
        
    debug_log(f"  Entry: {s_node_art}, Exit: {e_node_art}")

    # 4. Parity Logic (Updated: Uses Degree from Connected Graph)
    current_degrees = dict(G_art.degree())
    odd_nodes = [n for n, d in current_degrees.items() if d % 2 == 1]
    
    # Define Target Parity
    target_odds = []
    if not is_loop_mode and s_node_art != e_node_art:
        target_odds = [s_node_art, e_node_art]
    
    # Calculate Nodes to Fix (XOR Logic)
    # We want nodes in 'target_odds' to be ODD.
    # We want all other nodes to be EVEN.
    # 'odd_nodes' are currently ODD.
    
    nodes_to_fix = []
    all_involved = set(odd_nodes) | set(target_odds)
    
    for n in all_involved:
        is_odd = (n in odd_nodes)
        should_be_odd = (n in target_odds)
        
        # If mismatch, we need to toggle parity (add to fix list)
        # Even -> want Odd => Fix
        # Odd -> want Even => Fix
        # Odd -> want Odd => OK
        # Even -> want Even => OK
        if is_odd != should_be_odd:
            nodes_to_fix.append(n)
            
    debug_log(f"  [Parity] Needs Fixing: {len(nodes_to_fix)} nodes.")
    
    # 5. Matching (Using G_full for weights)
    if nodes_to_fix:
        G_odd = nx.Graph()
        for u, v in itertools.combinations(nodes_to_fix, 2):
            try:
                # [Phase 64] Shortcut Logic
                d_road = nx.shortest_path_length(G_full, u, v, weight=weight_key)
                
                final_cost = d_road
                use_blue = False
                
                try:
                    d_blue = nx.shortest_path_length(G_art, u, v, weight=weight_key)
                    # Gap > 30%? (Blue > 1.3 * Road) -> Shortcut
                    if d_blue > 1.3 * d_road:
                        final_cost = d_road
                        use_blue = False
                    else:
                        final_cost = d_blue - 0.1 # Tiny prejudice to prefer Blue if costs are close
                        use_blue = True
                except Exception:
                    # Not connected via Blue -> Must use Road
                    pass
                
                # [Perturbation]
                if perturbation > 0: final_cost *= random.uniform(1.0 - perturbation, 1.0 + perturbation)
                G_odd.add_edge(u, v, weight=-final_cost, use_blue=use_blue)
            except Exception: pass
            
        matches = nx.max_weight_matching(G_odd, maxcardinality=True)
        
        for u, v in matches:
             try:
                 use_blue = G_odd[u][v].get('use_blue', False)
                 
                 if use_blue:
                      # Backtrack on Art
                      # Must reconstruct exact path node-by-node from Art Graph
                      art_path_nodes = nx.shortest_path(G_art, u, v, weight=weight_key)
                      full_coords = []
                      full_path_nodes = []
                      
                      # Reconstruct
                      for k in range(len(art_path_nodes)-1):
                          n1, n2 = art_path_nodes[k], art_path_nodes[k+1]
                          # Find edge with min length (handle parallel edges)
                          best_key = min(G_art[n1][n2], key=lambda k: G_art[n1][n2][k]['length'])
                          edge = G_art[n1][n2][best_key]
                          
                          # Append coords
                          # Handle direction
                          seg_nodes = edge.get('path', [])
                          seg_coords = edge.get('coords', [])
                          
                          # Determine orientation: seg_nodes[0] should be n1?
                          # Not strict if bidirectional graph logic is fuzzy, but usually yes for undirected.
                          # Check if nodes reversed
                          if seg_nodes and seg_nodes[0] != n1 and seg_nodes[-1] == n1:
                               seg_nodes = seg_nodes[::-1]
                               seg_coords = seg_coords[::-1]
                          
                          full_coords.extend(seg_coords)
                          full_path_nodes.extend(seg_nodes)
                      
                      dist = nx.shortest_path_length(G_art, u, v, weight=weight_key)
                      G_art.add_edge(u, v, length=dist, original=False, kind='travel', 
                                     path=full_path_nodes, coords=full_coords, virtual=False)
                      debug_log(f"  [Backtrack] Use Blue Path ({dist:.1f}m)")
                 else:
                     path = nx.shortest_path(G_full, u, v, weight=weight_key)
                     dist = nx.shortest_path_length(G_full, u, v, weight=weight_key)
                     coords = get_path_geometry(G_full, path)
                     
                     G_art.add_edge(u, v, length=dist, original=False, kind='travel', 
                                    path=path, coords=coords, virtual=False)
                     debug_log(f"  [Shortcut] Use Road Path ({dist:.1f}m)")
             except Exception: pass
             


    # 7. Generate Art Path (Custom Spatial Heuristic)
    circuit = []
    
    # Revised Implementation Tracking Keys (Custom Spatial Heuristic)
    def solve_eulerian_with_heuristic_keys(G, source, end_node_geo=None):
        G_temp = G.copy()
        
        stack = [(source, None, None)] # node, edge_to_reach_here (u, v, k)
        circuit_edges = []
        
        while stack:
            u_node, _, _ = stack[-1]
            
            if G_temp.degree(u_node) > 0:
                # Find best edge
                candidates = []
                for v in G_temp.neighbors(u_node):
                    for k in G_temp[u_node][v]:
                         candidates.append((v, k))
                
                best_v, best_k = candidates[0], candidates[0][1] # Default
                
                if end_node_geo:
                    # Priority: 
                    # 1. Farther is better (Higher dist) - Clear distant nodes first
                    # 2. Travel lines is better (Higher priority) - Burn bridging lines first, save Art last.
                    
                    def get_prio(cand):
                        v_cand, k_cand = cand
                        # Spatial score
                        y = G_temp.nodes[v_cand]['y']
                        x = G_temp.nodes[v_cand]['x']
                        dist_sq = (y - end_node_geo[0])**2 + (x - end_node_geo[1])**2
                        
                        # Type score (Tie-Breaker)
                        # If edge is 'original' (Blue), we want to save it for later.
                        # So 'original' gets LOWER score.
                        # 'travel' gets HIGHER score.
                        is_original = G_temp[u_node][v_cand][k_cand].get('original', False)
                        type_score = 0 if is_original else 1 # Travel > Original
                        
                        return (dist_sq, type_score)

                    best_cand = max(candidates, key=get_prio)
                    best_v, best_k = best_cand
                
                G_temp.remove_edge(u_node, best_v, key=best_k)
                stack.append((best_v, u_node, best_k)) # dest, source, key
            else:
                # Backtrack
                node, from_node, key = stack.pop()
                if from_node is not None:
                    circuit_edges.append((from_node, node, key))
                    
        return circuit_edges[::-1] # Reverse to get Start->End

    try:
        if s_node_art == e_node_art:
            # Circuit default
            if not nx.is_eulerian(G_art):
                 debug_log("[CPP] Warning: Art Graph not Eulerian for Circuit.")
            circuit = solve_eulerian_with_heuristic_keys(G_art, s_node_art, user_end_geo)
        else:
            # Path default
            if not nx.has_eulerian_path(G_art):
                 debug_log("[CPP] Warning: Art Graph has no Eulerian Path.")
            circuit = solve_eulerian_with_heuristic_keys(G_art, s_node_art, user_end_geo)
            
    except Exception as e:
        debug_log(f"[CPP] Euler Solver Failed: {e}")
        return []
        
    final_segments = []
    
    # === [Phase 80] Generate Segments with HARD STOP ===
    
    # 1. 統計總共需要走幾條藍線 (Dynamic Target Counting)
    total_blue_goals = 0
    for u, v, k, d in G_art.edges(keys=True, data=True):
        if d.get('original', False):
            total_blue_goals += 1
            
    visited_blue_count = 0
    final_segments = []
    
    # 2. 加入起點引導路徑 (Entry Path)
    # [Prepend] Access Path (User -> Art Entry)
    if user_start_geo and s_node_art:
        try:
             u_node = nearest_node(G_full, user_start_geo[1], user_start_geo[0])
             if u_node != s_node_art:
                 path = nx.shortest_path(G_full, u_node, s_node_art, weight=weight_key)
                 dist = nx.shortest_path_length(G_full, u_node, s_node_art, weight=weight_key)
                 coords = get_path_geometry(G_full, path)
                 final_segments.append({'type':'road','kind':'travel', 'nodes':path, 'coords':coords})
                 debug_log(f"  [Access] Added path to Entry ({dist:.1f}m)")
        except Exception: pass

    current_node = s_node_art # 更新當前位置

    # 3. 遍歷回路
    for i, (u, v, key) in enumerate(circuit):
        edge_data = G_art[u][v][key]
        
        # 轉換為 Segment
        # (注意方向性：如果我們是從 u 走到 v，但 edge data 的 nodes 是反的，要 reverse)
        seg = {
            'type': edge_data.get('type', 'road'),
            'kind': edge_data.get('kind', 'draw'), # 'draw' or 'travel'
            'nodes': edge_data.get('path', []),
            'coords': edge_data.get('coords', [])
        }
        
        # Direction Logic
        if seg['nodes']:
            if seg['nodes'][-1] == u and seg['nodes'][0] != u:
                seg['nodes'] = seg['nodes'][::-1]
                if seg['coords']: seg['coords'] = seg['coords'][::-1]
        elif seg['coords'] and len(seg['coords']) > 1 and u in G_full.nodes:
            # [Fix] Manual strokes direction check
            sy, sx = G_full.nodes[u]['y'], G_full.nodes[u]['x']
            c_start = seg['coords'][0]
            c_end = seg['coords'][-1]
            d_start = (sy-c_start[0])**2 + (sx-c_start[1])**2
            d_end = (sy-c_end[0])**2 + (sx-c_end[1])**2
            
            if d_end < d_start: 
                 seg['coords'] = seg['coords'][::-1]

        final_segments.append(seg)
        current_node = v # 更新當前腳步
        
        # --- [關鍵修改] 檢查進度 (Real-time Monitoring) ---
        if edge_data.get('original', False):
            visited_blue_count += 1
            
        # --- [關鍵修改] 任務完成，強制下班 (Hard Stop) ---
        if visited_blue_count >= total_blue_goals:
            debug_log(f"[CPP Hard-Stop] Visited {visited_blue_count}/{total_blue_goals} blue edges. Stopping immediately.")
            
            # 最後檢查：我現在在終點嗎？
            # 注意：需處理 user_end_geo 為 None 的情況
            if user_end_geo:
                end_node_id = None
                try: 
                    end_node_id = nearest_node(G_full, user_end_geo[1], user_end_geo[0])
                except Exception: pass
                
                if end_node_id and current_node != end_node_id:
                    # 還沒到家，補最後一條灰線 (Last Mile)
                    debug_log(f"  [Hard-Stop] Routing to User End Node...")
                    try:
                        home_path = nx.shortest_path(G_full, current_node, end_node_id, weight=weight_key)
                        # 加入這段回家路
                        final_segments.append({
                            'type': 'road',
                            'kind': 'travel',
                            'nodes': home_path,
                            'coords': get_path_geometry(G_full, home_path)
                        })
                    except Exception:
                        debug_log("  [Hard-Stop] Failed to route to end node.")
                        pass
            
            # 觸發 Break，丟棄後續所有指令
            break 

    return final_segments

def solve_route(G, red_strokes, user_start, user_end, is_loop, full_G=None, G_drive=None, retry_mode=False, strokes_meta=None, G_connect=None):
    """
    [vFINAL SEQ] Smart Sequential Routing (Dynamic Entry + Mandatory Separation)
    1. Dynamic Entry Optimization: Rotate loops/Reverse lines to minimize travel distance.
    2. Mandatory Separation: ALWAYS insert a gray travel line between strokes.
    3. Exact Geometry: Trust 'road_exact' strokes fully (no trim, use G_connect).
    """
    if not red_strokes: return []
    
    final_segments = []
    blue_pool = []
    step_val = CORRIDOR_SAMPLE_STEP_RETRY_M if retry_mode else CORRIDOR_SAMPLE_STEP_M
    
    # Use G_connect for connectivity checks if available, otherwise full_G
    solver_G = G_connect if G_connect else full_G
    
    # ---------------------------------------------------------
    # 1. Processing Strokes into Blue Pool (Geometry & Meta)
    # ---------------------------------------------------------
    for i, stroke in enumerate(red_strokes):
        if not stroke: continue
        
        # [A] Exact Road (Straight Line Mode) - High Priority
        if strokes_meta and i < len(strokes_meta):
             meta = strokes_meta[i]
             if meta.get('type') == 'road_exact' and 'nodes' in meta:
                 nodes = meta['nodes']
                 
                 # [Fix] TRUST USER: Do not trim stubs for exact mode.
                 # Using G_connect ensures we can render alleys/private roads.
                 geometry_G = G_connect if G_connect else full_G
                 coords = get_path_geometry(geometry_G, nodes)
                 
                 blue_pool.append({'nodes': nodes, 'coords': coords, 'type': 'road', 'meta': meta})
                 continue

        # [B] Standard Logic (Beeline detection, Inertia, etc.)
        is_straight_line = False
        inertia_path_nodes = None
        
        stroke_len = sum(safe_dist(stroke[k], stroke[k+1]) for k in range(len(stroke)-1))
        beeline_dist = safe_dist(stroke[0], stroke[-1])
        
        if stroke_len > 0 and (beeline_dist / stroke_len) > 0.95 and beeline_dist > 50:
            is_straight_line = True
            
        if is_straight_line and full_G:
            try:
                start_n = nearest_node(full_G, stroke[0][1], stroke[0][0])
                end_n = nearest_node(full_G, stroke[-1][1], stroke[-1][0])
                red_line_bearing = get_bearing(stroke[0][0], stroke[0][1], stroke[-1][0], stroke[-1][1])
                inertia_path_nodes = solve_inertia_path(full_G, start_n, end_n, initial_bearing=red_line_bearing)
            except Exception: pass
            
        if inertia_path_nodes:
            nodes_accum = inertia_path_nodes
            coords = get_path_geometry(full_G, nodes_accum)
            blue_pool.append({'nodes': nodes_accum, 'coords': coords, 'type': 'road', 'meta': strokes_meta[i] if strokes_meta and i < len(strokes_meta) else {}})
            continue 

        # [C] General Corridor Routing
        # [Fix 橫跳] 先輕度平滑手繪線再取樣：手抖幾公尺會讓每一小段的「最近節點」
        # 在馬路兩側的人行道之間反覆翻面，造成規律的左右橫跳。
        # 只用於尋路取樣，red_strokes 原始資料不動 (重疊比對仍用原線)。
        dense = interpolate_dense(smooth_drawn_stroke(stroke), step=step_val)
        nodes_accum = []
        curr_n = None
        try: curr_n = nearest_node(full_G, dense[0][1], dense[0][0])
        except Exception: pass
        
        for k in range(len(dense)-1):
            sub_s = [dense[k], dense[k+1]]
            path = route_in_corridor(full_G, sub_s, start_n=curr_n)
            if path:
                s = path[0]
                if s['type'] == 'road':
                    if nodes_accum and s['nodes']:
                         if nodes_accum[-1] == s['nodes'][0]: nodes_accum.extend(s['nodes'][1:])
                         else: nodes_accum.extend(s['nodes'])
                    else:
                         nodes_accum.extend(s['nodes'])
                    curr_n = s['nodes'][-1]
        
        if nodes_accum:
            # [A46] Geometric Spike Filter (Remove V-turns)
            nodes_accum = remove_geometric_spikes(nodes_accum, full_G)

            nodes_accum = remove_short_loops(nodes_accum, window=10)
            if full_G: nodes_accum = advanced_shortcut_optimizer(full_G, nodes_accum, lookahead=50, max_search_dist=300)
            nodes_accum = prune_spurs_stack(nodes_accum)
            # [Fix 折返] 啟用原本寫好卻沒被呼叫的折返清除：
            # 刪掉「繞出去又回到 12m 內」的無意義來回 (路口/人行道密集節點造成)。
            # 產生的小跳點會由後面的 bridge_node_path_gaps 沿真實道路接回。
            if full_G: nodes_accum = remove_meaningless_uturns(nodes_accum, full_G, shortcut_m=12)
            # [Fix 無意義折返] 剪掉「繞出去 80m 又回到 30m 內」這種較長的來回，
            # 上面那些只抓得到相同節點或三點小尖刺。剪完的接縫由 bridge 沿道路補回。
            if full_G: nodes_accum = remove_backtracks(full_G, nodes_accum)
            coords = get_path_geometry(full_G, nodes_accum)
            blue_pool.append({'nodes': nodes_accum, 'coords': coords, 'type': 'road', 'meta': strokes_meta[i] if strokes_meta and i < len(strokes_meta) else {}})
        else:
            blue_pool.append({
                'type': 'beeline',
                'coords': stroke,
                'meta': strokes_meta[i] if strokes_meta and i < len(strokes_meta) else {}
            })

    if not blue_pool: return []

    # ---------------------------------------------------------
    # 2. Phase 1: Dynamic Entry Optimization (Smart Reordering)
    # ---------------------------------------------------------
    
    # Initialize prev_end_node
    prev_end_node = None
    if user_start and solver_G:
        try: prev_end_node = nearest_node(solver_G, user_start[1], user_start[0])
        except Exception: pass
    
    # If no user start, assume start of first stroke
    if not prev_end_node and blue_pool[0].get('nodes'):
        prev_end_node = blue_pool[0]['nodes'][0]

    for i in range(len(blue_pool)):
        stroke = blue_pool[i]
        nodes = stroke.get('nodes')
        if not nodes or stroke['type'] != 'road': 
             # For beelines, we can't really reorder nodes easily without coords check
             # Just update prev_end (approx)
             if stroke.get('coords'): 
                 # Todo: Update prev_end_node to nearest node of coords[-1]
                 pass
             continue

        # Need previous end node to optimize
        if prev_end_node and solver_G and prev_end_node in solver_G.nodes:
             py, px = solver_G.nodes[prev_end_node]['y'], solver_G.nodes[prev_end_node]['x']
             
             # Check type
             is_cyc = (nodes[0] == nodes[-1])
             
             if is_cyc and len(nodes) > 2:
                 # [Loop] Find closest node to prev_end
                 best_idx = 0
                 min_d = float('inf')
                 
                 unique_nodes = nodes[:-1]
                 for k, n in enumerate(unique_nodes):
                     if n in solver_G.nodes:
                         ny, nx_ = solver_G.nodes[n]['y'], solver_G.nodes[n]['x']
                         d = (nx_-px)**2 + (ny-py)**2
                         if d < min_d:
                             min_d = d
                             best_idx = k
                 
                 # Rotate
                 if best_idx > 0:
                     unique_nodes = unique_nodes[best_idx:] + unique_nodes[:best_idx]
                     unique_nodes.append(unique_nodes[0])
                     stroke['nodes'] = unique_nodes
                     # Update coords
                     geometry_G = G_connect if G_connect else full_G
                     stroke['coords'] = get_path_geometry(geometry_G, unique_nodes)
                     debug_log(f"  [Smart] Rotated Loop {i} to index {best_idx}")

             else:
                 # [Line] Check Forward vs Reverse
                 start_n = nodes[0]
                 end_n = nodes[-1]
                 
                 d_start = float('inf')
                 d_end = float('inf')
                 
                 if start_n in solver_G.nodes:
                     sy, sx = solver_G.nodes[start_n]['y'], solver_G.nodes[start_n]['x']
                     d_start = (sx-px)**2 + (sy-py)**2
                 
                 if end_n in solver_G.nodes:
                     ey, ex = solver_G.nodes[end_n]['y'], solver_G.nodes[end_n]['x']
                     d_end = (ex-px)**2 + (ey-py)**2
                 
                 if d_end < d_start:
                     stroke['nodes'].reverse()
                     geometry_G = G_connect if G_connect else full_G
                     stroke['coords'] = get_path_geometry(geometry_G, stroke['nodes'])
                     debug_log(f"  [Smart] Reversed Line {i}")

        # Update for next
        if stroke.get('nodes'):
             prev_end_node = stroke['nodes'][-1]

    # ---------------------------------------------------------
    # 3. Phase 2: Generating Segments (Mandatory Separation)
    # ---------------------------------------------------------
    
    current_node = None
    if user_start and solver_G:
         try: current_node = nearest_node(solver_G, user_start[1], user_start[0])
         except Exception: pass
         
    current_geo = user_start

    for i, stroke in enumerate(blue_pool):
        
        target_start_node = None
        target_end_node = None
        target_start_geo = None
        
        if stroke['type'] == 'road':
            target_start_node = stroke['nodes'][0]
            target_end_node = stroke['nodes'][-1] # For next loop
            # Geo lookup
            if target_start_node in solver_G.nodes:
                target_start_geo = (solver_G.nodes[target_start_node]['y'], solver_G.nodes[target_start_node]['x'])
            else:
                 target_start_geo = stroke['coords'][0] if stroke.get('coords') else None
        else:
            # Beeline
            target_start_geo = stroke['coords'][0]
            # Try to map to node for routing
            if solver_G:
                 try: target_start_node = nearest_node(solver_G, target_start_geo[1], target_start_geo[0])
                 except Exception: pass

        # [Mandatory Separation] Always insert Travel Segment if we have nodes
        bridged = False
        
        # Only bridge if we have a current node (from prev stroke or user start)
        if current_node and target_start_node and solver_G:
            # [2026-07-24 使用者決定] 連接段一律純最短路徑 (weight='length')，
            # 與原路線重疊沒關係。舊行為在打過折的 G_routing 上找路
            # （藍線邊 ×0.7 的 Pre-discount、走過的連接段再 ×0.7 的 Bundling），
            # 折扣後便宜 ≠ 實際距離短：實測中山區閉合環 718/2211 個起點會因此
            # 多走真實距離（最嚴重 828m vs 純最短 673m, +23%）。
            # [Fix 切西瓜] robust_shortest_path 會在有向路徑失敗時改用無向視角，
            # 避免因單行道/剪枝找不到路而退回直線。
            path = robust_shortest_path(solver_G, current_node, target_start_node, weight='length')
            if path and len(path) > 1:
                # Geometry from solver_G (Physical graph)
                coords = get_path_geometry(solver_G, path)

                final_segments.append({
                    'type': 'road',
                    'kind': 'travel',
                    'nodes': path,
                    'coords': coords
                })
                bridged = True

        # Fallback for Beeline or Failed Route
        if not bridged and current_geo and target_start_geo:
             dist = safe_dist(current_geo, target_start_geo)
             if dist > 5: # Only if distinct
                 # [Fix 切西瓜] 直線前先試著把兩端吸附到最近道路節點再走道路，
                 # 真的完全不連通 (不同連通塊) 才退回直線。
                 road_bridge_coords = None
                 road_bridge_nodes = None
                 if solver_G is not None:
                     try:
                         n1 = nearest_node(solver_G, current_geo[1], current_geo[0])
                         n2 = nearest_node(solver_G, target_start_geo[1], target_start_geo[0])
                         np_path = robust_shortest_path(solver_G, n1, n2, weight='length')
                         if np_path and len(np_path) > 1:
                             road_bridge_nodes = np_path
                             road_bridge_coords = get_path_geometry(solver_G, np_path)
                     except Exception:
                         road_bridge_coords = None
                 if road_bridge_coords and len(road_bridge_coords) > 1:
                     final_segments.append({
                         'type': 'road',
                         'kind': 'travel',
                         'nodes': road_bridge_nodes,
                         'coords': road_bridge_coords
                     })
                 else:
                     final_segments.append({
                         'type': 'beeline',
                         'kind': 'travel', # 真正無法連通 -> 直線
                         'coords': [current_geo, target_start_geo]
                     })
        
        # Add the Stroke Itself
        stroke['kind'] = 'draw'
        final_segments.append(stroke)
        
        # Update State
        if stroke['type'] == 'road':
             current_node = stroke['nodes'][-1]
             if current_node in solver_G.nodes:
                 current_geo = (solver_G.nodes[current_node]['y'], solver_G.nodes[current_node]['x'])
        else:
             current_geo = stroke['coords'][-1]
             try: current_node = nearest_node(solver_G, current_geo[1], current_geo[0])
             except Exception: pass

    # ---------------------------------------------------------
    # 4. Phase 3: Departure to User End
    # ---------------------------------------------------------
    if user_end and current_node and solver_G:
        end_node = None
        try: end_node = nearest_node(solver_G, user_end[1], user_end[0])
        except Exception: pass
        
        if end_node:
            try:
                # [2026-07-24 使用者決定] 回終點的最後一段改走「純最短路徑」。
                # 舊行為是把已跑過的藍線邊 ×1000 罰到等於禁走（"不能重踩藍線"），
                # 實測會為了避開藍線硬鑽進巷弄繞一大圈，巷弄路網有缺口時
                # 還會畫出斜線切西瓜（實例：台北長春路/松江路156巷）。
                # 使用者明確要求：最短路徑回終點，與原路線重疊沒關係。
                path = robust_shortest_path(solver_G, current_node, end_node, weight='length')
                if path and len(path) > 1:
                    coords = get_path_geometry(solver_G, path)
                    final_segments.append({'type': 'road', 'kind': 'travel', 'nodes': path, 'coords': coords})
            except Exception: pass
            
    # [Phase 75] Global Spur Pruning
    final_segments = prune_final_spurs(final_segments, solver_G)
    
    # [A46] Strict Overlap Pruning (Remove Hallucinations)
    if red_strokes:
        final_segments = prune_non_overlapping_segments(final_segments, red_strokes, solver_G, threshold=40)

    # [Fix 切西瓜] 最後統一修補：上面所有剪枝/最佳化步驟都可能把中間節點刪掉，
    # 造成前後節點沒有道路相連而被畫成直線 (切西瓜)。
    # 這裡沿真實道路把這些跳點接回來。只插入節點、不刪除，故不影響覆蓋率。
    _bridge_G = full_G if full_G is not None else solver_G
    if _bridge_G is not None:
        for seg in final_segments:
            if seg.get('type') == 'road' and seg.get('nodes') and len(seg['nodes']) >= 2:
                try:
                    seg['nodes'] = bridge_node_path_gaps(_bridge_G, seg['nodes'])
                except Exception:
                    pass

    return final_segments

# [Round 5] Connectivity Validator
def check_continuity(segments):
    if not segments: return
    
    warnings = []
    for i in range(len(segments)-1):
        s1 = segments[i]
        s2 = segments[i+1]
        
        # [防呆修正] 檢查 coords 是否存在且不為空
        if 'coords' not in s1 or not s1['coords']: continue
        if 'coords' not in s2 or not s2['coords']: continue

        # 取得上一段的終點與下一段的起點
        p_end = s1['coords'][-1]
        p_start = s2['coords'][0]
             
        dist = safe_dist(p_end, p_start)
        if dist > 1.0: # 1 meter gap
            warnings.append(f"Gap found at Segment {i}->{i+1}: {dist:.2f}m")
            
    if warnings:
        print("[Connectivity Check] FAILED:")
        for w in warnings: print(w)
        return False
    else:
        print("[Connectivity Check] PASSED: Chain is continuous.")
        return True

def reorder_closed_strokes(strokes, user_pos, close_tol_m=None):
    """
    [Phase 49+54] Upstream Optimization: Rotate closed loops.
    [Phase 54 Update] Use Sequential Reference:
    The reference point for Stroke N is the End Point of Stroke N-1.
    If N=0, use User Start.
    This ensures concentric circles entry points are logical (chain reaction).
    """
    if not strokes: return strokes
    new_strokes = []
    
    # 1. Determine Initial Reference Point
    # Use user_pos if available, else first point of first stroke
    current_ref_x, current_ref_y = 0, 0
    if user_pos:
        current_ref_x, current_ref_y = user_pos[0], user_pos[1] # lat, lon
    elif strokes and len(strokes[0]) > 0:
        current_ref_x, current_ref_y = strokes[0][0][0], strokes[0][0][1]
    
    for s in strokes:
        if not s or len(s) < 3: 
            new_strokes.append(s)
            # Update Ref to End of this stroke
            if s: current_ref_x, current_ref_y = s[-1]
            continue
            
        # Check closed loop (< 30m approx)
        p_start = s[0]; p_end = s[-1]
        d_close = (p_start[0]-p_end[0])**2 + (p_start[1]-p_end[1])**2
        
        final_s = s
        
        # 閉合判定門檻：預設約 30m；可傳入 close_tol_m 依整體圖形大小調整
        _close_thr = 0.00000015 if close_tol_m is None else (close_tol_m / 111000.0) ** 2
        if d_close < _close_thr: # Is Closed Loop
             best_i = 0
             best_d = float('inf')
             
             # Find point closest to CURRENT REFERENCE (Sequential)
             for i, p in enumerate(s[:-1]):
                 d = (p[0]-current_ref_x)**2 + (p[1]-current_ref_y)**2
                 if d < best_d:
                     best_d = d; best_i = i
             
             if best_i > 0:
                 # Rotate
                 unique = s[:-1]
                 rotated = unique[best_i:] + unique[:best_i]
                 final_s = rotated + [rotated[0]]
                 # debug_log(f"  [Phase 54] Rotated Loop to align with previous end.")
             
             # [Phase 52] Force Clockwise
             edge_sum = 0
             for k in range(len(final_s)-1):
                 x1, y1 = final_s[k][1], final_s[k][0] # x=lon, y=lat
                 x2, y2 = final_s[k+1][1], final_s[k+1][0]
                 edge_sum += (x2 - x1) * (y2 + y1)
             
             if edge_sum < 0: # Means CCW -> Reverse
                 final_s = [final_s[0]] + list(reversed(final_s[1:-1])) + [final_s[0]]
                 # debug_log("  [Phase 52] Loop Reversed to Clockwise.")

        new_strokes.append(final_s)
        
        # Update Reference to END of this stroke
        # (For a closed loop, End == Start == New Entry Point)
        current_ref_x, current_ref_y = final_s[-1]
             
    return new_strokes

def stitch_nearby_strokes(strokes, metas=None, tolerance_m=None):
    """
    [Phase 51] Auto-Connect Red Lines (Geometry + Metadata).
    If Head-Head, Head-Tail, Tail-Tail dist < 50m, merge them.
    Also handles T-Junctions via endpoint proximity.
    Supported Metas: Merges 'nodes' if 'road_exact' type.
    """
    if not strokes: 
        if metas is not None: return [], []
        return []
    
    # Deep copy to avoid mutating original
    pool = [list(s) for s in strokes if len(s) > 1]
    
    # Initialize Meta Pool
    pool_meta = []
    if metas:
        # Align length
        if len(metas) < len(strokes):
            pool_meta = list(metas) + ([{}] * (len(strokes) - len(metas)))
        else:
            pool_meta = list(metas[:len(strokes)])
    else:
        pool_meta = [{} for _ in pool]
    
    merged = True
    while merged:
        merged = False
        best_pair = None
        # 縫合門檻：預設約 50m；可傳入 tolerance_m 依整體圖形大小調整
        min_d = 0.00000025 if tolerance_m is None else (tolerance_m / 111000.0) ** 2
        
        # O(N^2) greedy merge
        for i in range(len(pool)):
            for j in range(i+1, len(pool)):
                s1 = pool[i]; s2 = pool[j]
                
                ends1 = [(0, s1[0]), (-1, s1[-1])]
                ends2 = [(0, s2[0]), (-1, s2[-1])]
                
                for idx1, p1 in ends1:
                    for idx2, p2 in ends2:
                        d = (p1[0]-p2[0])**2 + (p1[1]-p2[1])**2
                        if d < min_d:
                            min_d = d
                            best_pair = (i, j, idx1, idx2)
        
        if best_pair:
            i, j, idx1, idx2 = best_pair
            s1 = pool[i]; s2 = pool[j]
            m1 = pool_meta[i]; m2 = pool_meta[j]
            
            # Helper to access nodes
            n1 = m1.get('nodes', []) if m1.get('type') == 'road_exact' else []
            n2 = m2.get('nodes', []) if m2.get('type') == 'road_exact' else []
            
            new_s = []
            new_n = []
            
            # Logic: We want s1 ... s2 (Keep i, consume j)
            
            # Case 1: Tail to Head (s1 -> s2)
            if idx1 == -1 and idx2 == 0:
                new_s = s1 + s2
                if n1 and n2: new_n = n1 + n2[1:] # Drop dup node if connected
                elif n1: new_n = n1
                elif n2: new_n = n2
                
            # Case 2: Head to Tail (s2 -> s1)
            elif idx1 == 0 and idx2 == -1:
                new_s = s2 + s1
                if n1 and n2: new_n = n2 + n1[1:]
                elif n1: new_n = n1 # Only s1 has nodes (rare)
                elif n2: new_n = n2

            # Case 3: Tail to Tail (s1 -> rev(s2))
            elif idx1 == -1 and idx2 == -1:
                new_s = s1 + list(reversed(s2))
                if n1 and n2: new_n = n1 + list(reversed(n2))[1:] # Drop dup
                elif n1: new_n = n1
                elif n2: new_n = list(reversed(n2))

            # Case 4: Head to Head (rev(s1) -> s2)
            elif idx1 == 0 and idx2 == 0:
                new_s = list(reversed(s1)) + s2
                if n1 and n2: new_n = list(reversed(n1)) + n2[1:]
                elif n1: new_n = list(reversed(n1))
                elif n2: new_n = n2
            
            # Update Pool
            # Remove j, replace i
            pool.pop(j)
            pool_meta.pop(j)
            
            pool[i] = new_s
            
            # Update Meta
            new_meta = m1.copy() # Inherit from s1 primarily
            # If both were exact, result is exact
            if m1.get('type') == 'road_exact' and m2.get('type') == 'road_exact':
                new_meta['type'] = 'road_exact'
                new_meta['nodes'] = new_n
            else:
                 new_meta['type'] = 'raw' # Mixed/Raw -> fallback to raw geometry
                 if 'nodes' in new_meta: del new_meta['nodes']
            
            pool_meta[i] = new_meta
            
            merged = True
            
    if metas is not None:
        return pool, pool_meta
    return pool
