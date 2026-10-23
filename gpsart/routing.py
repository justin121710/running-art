"""路徑演算法核心：手繪線對齊道路（地圖匹配）、路徑清理、筆畫排序、連接段。

整體流程（solve_route）：
    筆畫 ──► match_stroke()            每一筆用 Viterbi 對齊到路網（全域最佳，不是逐段貪婪）
          ──► clean_path()             少量清理：小尖刺、小迴圈、截彎取直、折返
          ──► 連接段                   起點 → 第一筆 → … → 最後一筆 → 終點，純最短路
          ──► prune_non_overlapping…   砍掉離手繪線很遠、又有近路可取代的「幻覺繞路」
          ──► bridge_node_path_gaps()  最後統一把沒有道路相連的跳點沿真實道路接回

所有距離都是公尺；平面運算前先用 geometry.LocalProj 投影。
節點編號一律用 `is None` 判斷有沒有——編號 0 是合法的節點。
"""
import math
import itertools

import networkx as nx
from shapely.geometry import LineString, MultiLineString, Point

from .config import (BACKTRACK_MAX_THINNESS, BACKTRACK_MIN_EXCURSION_M, BACKTRACK_RETURN_RADIUS_M,
                     BACKTRACK_WINDOW, MATCH_STEP_M, MATCH_RADIUS_M, MATCH_K, MATCH_EMIT_W,
                     MATCH_DETOUR_W, MATCH_UTURN_PENALTY, SHORTCUT_MAX_DEV_M, FORCE_CLOCKWISE,
                     debug_log)
from .graphutil import nearest_node, node_index
from .geometry import (LocalProj, calculate_polygon_area, get_angle_diff, get_bearing, haversine,
                       interpolate_dense, safe_dist, smooth_drawn_stroke)


def _ll(G, n):
    return (G.nodes[n]['y'], G.nodes[n]['x'])


def _node_dist(G, a, b):
    return haversine(G.nodes[a]['y'], G.nodes[a]['x'], G.nodes[b]['y'], G.nodes[b]['x'])


def _edge_length(G, a, b):
    ed = G.get_edge_data(a, b) or G.get_edge_data(b, a)
    if ed:
        return min(d.get('length', 0.0) for d in ed.values())
    return _node_dist(G, a, b)


def path_length(G, nodes):
    return sum(_edge_length(G, a, b) for a, b in zip(nodes[:-1], nodes[1:]))


def robust_shortest_path(graph, start_node, end_node, weight='length'):
    """
    節點路徑的最短路。先找有向最短路；找不到（單行道方向或剪枝）就改用無向視角
    (對跑步而言方向沒有意義)。兩者都失敗才回傳 None。
    """
    if graph is None or start_node is None or end_node is None:
        return None
    if start_node == end_node:
        return [start_node]
    if start_node not in graph.nodes or end_node not in graph.nodes:
        return None
    try:
        return nx.shortest_path(graph, start_node, end_node, weight=weight)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        pass
    try:
        return nx.shortest_path(graph.to_undirected(as_view=True), start_node, end_node, weight='length')
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None


def bridge_node_path_gaps(G, nodes, max_detour_ratio=4.0, min_gap_m=25.0):
    """
    [Fix 切西瓜] 把節點路徑中「前後兩點沒有道路直接相連」的跳點，沿真實道路重新接起來。

    - 只有兩點確實沒有相連、且距離 > min_gap_m 時才處理。
    - 找到的道路繞路若超過直線的 max_detour_ratio 倍（或 +150m）就放棄，維持原樣。
    - 只會「插入」節點、絕不刪除 -> 覆蓋率只會持平或變好。
    """
    if not nodes or len(nodes) < 2 or G is None:
        return nodes
    out = [nodes[0]]
    for u, v in zip(nodes[:-1], nodes[1:]):
        if G.has_edge(u, v) or G.has_edge(v, u) or u not in G.nodes or v not in G.nodes:
            out.append(v)
            continue
        straight = _node_dist(G, u, v)
        if straight < min_gap_m:
            out.append(v)
            continue
        filled = robust_shortest_path(G, u, v, weight='length')
        if filled and len(filled) > 2 and \
                path_length(G, filled) <= max(straight * max_detour_ratio, straight + 150.0):
            out.extend(filled[1:])
            continue
        out.append(v)
    return out


# ===========================================================
# 地圖匹配：把一筆手繪線對齊到路網
# ===========================================================
class _DijkstraCache:
    """同一個起點的有限距離 Dijkstra 結果快取。相鄰樣點的候選點大量重複，省很多運算。"""

    def __init__(self, G, weight):
        self.G, self.weight, self.memo = G, weight, {}

    def get(self, src, cutoff):
        hit = self.memo.get(src)
        if hit is not None and hit[0] >= cutoff:
            return hit[1], hit[2]
        dist, paths = nx.single_source_dijkstra(self.G, src, cutoff=cutoff, weight=self.weight)
        self.memo[src] = (cutoff, dist, paths)
        return dist, paths


def match_stroke(G, stroke, step_m=None, radius_m=None, k=None):
    """
    [地圖匹配] 用 Viterbi 找出「最像這條手繪線」的路網節點序列。

    以前的做法是每 40m 各自找一段局部最短路再串起來（貪婪）：每一步只看下一個樣點，
    最近節點在馬路兩側之間反覆換邊就會橫跳，某一步選錯後面就得繞回來，
    然後再靠一長串清理步驟補救。這裡改成在所有候選組合中求「總成本最低」的一條：

        樣點 i 的候選 = 半徑 radius_m 內最近的 k 個節點
        發射成本     = MATCH_EMIT_W × 節點到樣點的距離
        轉移成本     = 路網成本(travel_weight) + MATCH_DETOUR_W × |實際路長 − 樣點直線距離|
                       + 原地迴轉的額外成本

    這就是 HMM 地圖匹配（Newson & Krumm 2009；Valhalla Meili、OSRM match 同一套）。
    回傳節點串的串列（通常只有一段；中間遇到過不去的障礙時會斷成好幾段）；
    完全對不上路網時回傳 []。
    """
    if step_m is None: step_m = MATCH_STEP_M
    if radius_m is None: radius_m = MATCH_RADIUS_M
    if k is None: k = MATCH_K
    if not stroke or len(stroke) < 2 or not G.number_of_nodes():
        return []
    idx = node_index(G)
    samples = interpolate_dense(smooth_drawn_stroke(stroke), step=step_m)

    layers = []
    for p in samples:
        # 這一帶沒有路（公園、河邊、鐵道）的樣點直接略過，不要硬找遠處的節點：
        # 前後有路的樣點之間，轉移時的 Dijkstra 自己會找出繞過去的路。
        cand = idx.nearest_k(p[0], p[1], k, r_max=radius_m)
        if cand:
            layers.append((p, cand))
    if not layers:
        # 整筆附近都沒有路：退一步，用離頭尾最近的節點至少接得起來
        ends = [idx.nearest_k(p[0], p[1], 1) for p in (samples[0], samples[-1])]
        if not all(ends):
            return []
        layers = [(samples[0], ends[0]), (samples[-1], ends[1])]

    dj = _DijkstraCache(G, 'travel_weight')

    def stray(path, pa, pb):
        """路徑上的節點離「樣點 pa→pb 這一小段手繪線」最遠多遠（超過候選半徑的部分）。
        只看端點的發射成本抓不到「中途鑽進旁邊巷子再出來」，要靠這一項。"""
        ax, ay = idx.xy(*pa); bx, by = idx.xy(*pb)
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        worst = 0.0
        for n in path[1:-1]:
            j = idx.pos.get(n)
            if j is None:
                continue
            px, py = idx.x[j], idx.y[j]
            t = 0.0 if L2 <= 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
            d = math.hypot(px - (ax + t * vx), py - (ay + t * vy))
            if d > worst:
                worst = d
        return max(0.0, worst - radius_m)
    # state: node -> (cost, prev_node, path_from_prev, penultimate_node)
    cost = {n: MATCH_EMIT_W * d for d, n in layers[0][1]}
    penult = {n: None for n in cost}
    back = []

    pa = layers[0][0]
    skipped = 0
    pieces = []
    for li, (pb, cand_b) in enumerate(layers[1:], start=1):
        straight = safe_dist(pa, pb)
        cutoff = 2.5 * (straight + 2 * radius_m) + 60.0
        new_cost, new_back, new_pen = {}, {}, {}
        for a, ca in cost.items():
            dist, paths = dj.get(a, cutoff)
            for d_b, b in cand_b:
                tw = dist.get(b)
                if tw is None:
                    continue
                path = paths[b]
                plen = path_length(G, path) if len(path) > 1 else 0.0
                c = ca + tw + MATCH_DETOUR_W * abs(plen - straight) + MATCH_EMIT_W * d_b
                if len(path) > 2:
                    sv = stray(path, pa, pb)
                    if sv > 2 * radius_m:
                        # 離這一小段手繪線太遠：這不是「沿著圖案走」，是繞道。
                        # 不採用，真的沒有別條路時會在這裡斷開成兩段（見下方）。
                        continue
                    c += 2.0 * MATCH_EMIT_W * sv
                if len(path) > 1 and penult[a] is not None and path[1] == penult[a]:
                    c += MATCH_UTURN_PENALTY
                if c < new_cost.get(b, float('inf')):
                    new_cost[b] = c
                    new_back[b] = (a, path)
                    new_pen[b] = path[-2] if len(path) > 1 else penult[a]
        if not new_cost and skipped < 3 and li < len(layers) - 1:
            # 這個樣點的候選點在 cutoff 內都接不上（常見於公園、廣場裡零碎的步道）：
            # 先跳過它，用下一個樣點再試。直接「不限距離硬接」會為了一個點繞出幾百公尺。
            skipped += 1
            continue
        if not new_cost:
            # 連續好幾個樣點都接不上（例如中間是鐵道、河、施工圍籬）：在這裡斷開，
            # 前半段收尾、從這個樣點重新開始一段。兩段之間由 solve_route 用連接段
            # （虛線）接起來——以前是「不限距離硬接」，接法常常是沿著已經畫好的
            # 路線整圈繞回去，又被當成圖案的一部分。
            pieces.append(_viterbi_trace(cost, back))
            cost = {n: MATCH_EMIT_W * d for d, n in cand_b}
            penult = {n: None for n in cost}
            back = []
            pa, skipped = pb, 0
            continue
        back.append(new_back)
        cost, penult = new_cost, new_pen
        pa, skipped = pb, 0

    pieces.append(_viterbi_trace(cost, back))
    return [pc for pc in pieces if len(pc) >= 2]


def _viterbi_trace(cost, back):
    """從最後一層成本最低的狀態沿 back 指標回溯出節點串（去掉連續重複）。"""
    end = min(cost, key=cost.get)
    seq = [end]
    cur = end
    for bk in reversed(back):
        a, path = bk[cur]
        seq.extend(reversed(path[:-1]))
        cur = a
    seq.reverse()
    out = [seq[0]]
    for n in seq[1:]:
        if n != out[-1]:
            out.append(n)
    return out


# ===========================================================
# 路徑清理
# ===========================================================
def prune_spurs_stack(nodes, G=None, stroke=None, keep_dev_m=25.0):
    """
    移除 A -> B -> A 型的分岔（只看節點編號；會連鎖剪掉一整段原路來回）。

    有給 G 與 stroke 時，分岔尖端 B 貼著手繪線（< keep_dev_m）就保留：
    星星的角、文字的尖端本來就是「沿同一條路出去再回來」，剪掉就畫不出來了。
    """
    if not nodes:
        return []
    dev = _dev_checker(stroke) if (stroke and G is not None) else None
    stack = [nodes[0]]
    for curr in nodes[1:]:
        if len(stack) >= 2 and curr == stack[-2]:
            tip = stack[-1]
            if dev is None or tip not in G.nodes or dev(*_ll(G, tip)) > keep_dev_m:
                stack.pop()
                continue
        stack.append(curr)
    return stack


def remove_short_loops(path_nodes, window=10, G=None, max_loop_m=150.0, stroke=None):
    """
    同一個節點在 window 步內又出現 = 繞了一小圈回到原地，剪掉中間。
    例如 A -> B -> C -> D -> B -> E 變成 A -> B -> E。

    有給 G 時，只剪總長 < max_loop_m 的圈。節點經過角度簡化後可能相距上百公尺，
    「10 個節點」可能就是半個使用者畫的圓——只用步數判斷的話會整段剪掉（實測過）。
    有給 stroke 時，圈上所有節點都貼著手繪線（< 30m）就不剪：那是使用者畫的
    （星星的角、文字的尖端是「出去再回來」，看起來就像一個小圈）。
    """
    if not path_nodes:
        return []
    dev = _dev_checker(stroke) if (stroke and G is not None) else None
    stack = []
    for node in path_nodes:
        search = stack[-window:]
        if node in search:
            k = len(stack) - len(search) + search.index(node)
            loop = stack[k:] + [node]
            if G is None or path_length(G, loop) < max_loop_m:
                if dev is None or any(dev(*_ll(G, n)) > 30.0 for n in loop):
                    stack = stack[:k + 1]
                    continue
        stack.append(node)
    return stack


def remove_meaningless_uturns(nodes, G, shortcut_m=12):
    """A->B->C 中，C 回到 A 的 shortcut_m 內、但實際走了 >20m：B 是無意義的折返，刪掉。"""
    if not nodes or len(nodes) < 3:
        return nodes
    clean = [nodes[0]]
    for p1, p2, p3 in zip(nodes[:-2], nodes[1:-1], nodes[2:]):
        try:
            if _node_dist(G, p1, p3) < shortcut_m and _node_dist(G, p1, p2) + _node_dist(G, p2, p3) > 20:
                continue
        except KeyError:
            pass
        clean.append(p2)
    clean.append(nodes[-1])
    return clean


def remove_backtracks(G, nodes, return_radius_m=None, min_excursion_m=None, window=None, stroke=None):
    """
    剪掉「繞出去又折返回原地」的來回路段：走到 j 時已走 >= min_excursion_m，
    但 j 回到 i 的 return_radius_m 以內 -> 剪掉中間（挑最遠的合格 j，一次剪乾淨）。

    防呆：畫圓也會「回到原地」。用「細長度」= 圍出的面積 / 同周長圓的面積分辨：
    原路折返 ~0（剪），繞一圈 ~1（保留）。只刪節點，接縫由 bridge_node_path_gaps 補回。

    有給 stroke 時，「使用者自己畫了一根刺」（星星的角、文字的筆畫）不算折返：
    只有來回段裡有節點離手繪線 > return_radius_m 時才剪。
    """
    if return_radius_m is None: return_radius_m = BACKTRACK_RETURN_RADIUS_M
    if min_excursion_m is None: min_excursion_m = BACKTRACK_MIN_EXCURSION_M
    if window is None: window = BACKTRACK_WINDOW
    if not nodes or len(nodes) < 4 or G is None:
        return nodes

    pos = {}
    def P(n):
        if n not in pos:
            pos[n] = _ll(G, n) if n in G.nodes else None
        return pos[n]

    dev = _dev_checker(stroke) if stroke else None
    out = []
    i, N = 0, len(nodes)
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
                walked += safe_dist(prev, pj)
                prev = pj
                if walked >= min_excursion_m and safe_dist(pi, pj) <= return_radius_m:
                    ring = [p for p in (P(n) for n in nodes[i:j + 1]) if p is not None]
                    area = calculate_polygon_area(ring) if len(ring) >= 3 else 0.0
                    max_area = walked ** 2 / (4 * math.pi)
                    if max_area > 0 and area / max_area < BACKTRACK_MAX_THINNESS:
                        if dev is None or any(dev(*p) > return_radius_m for p in ring):
                            best_j = j
        if best_j is not None:
            i = best_j
            continue
        i += 1
    return out


def remove_geometric_spikes(nodes, G, max_leg_m=45.0, stroke=None, keep_dev_m=25.0):
    """去掉 A->B->C 中轉角超過 ~135° 的短尖刺 B（兩條腿都 < max_leg_m）。
    有給 stroke 時，貼著手繪線的尖端保留（那是使用者畫的角）。"""
    if len(nodes) < 3:
        return nodes
    dev = _dev_checker(stroke) if stroke else None
    clean = [nodes[0]]
    for i in range(1, len(nodes) - 1):
        a, b, c = clean[-1], nodes[i], nodes[i + 1]
        if a == c and (dev is None or dev(*_ll(G, b)) > keep_dev_m):
            continue
        try:
            l1, l2 = _node_dist(G, a, b), _node_dist(G, b, c)
            if l1 < max_leg_m and l2 < max_leg_m and l1 > 0 and l2 > 0:
                turn = get_angle_diff(get_bearing(*_ll(G, a), *_ll(G, b)), get_bearing(*_ll(G, b), *_ll(G, c)))
                if turn > 135 and (dev is None or dev(*_ll(G, b)) > keep_dev_m):
                    continue
        except KeyError:
            pass
        clean.append(b)
    clean.append(nodes[-1])
    return clean


def _dev_checker(stroke):
    """回傳 f(lat, lon) -> 到手繪線的距離（公尺）。"""
    pr = LocalProj.around(stroke)
    line = LineString([pr.xy(p) for p in stroke]) if len(stroke) > 1 else None
    if line is None:
        return lambda lat, lon: 0.0
    return lambda lat, lon: line.distance(Point(pr.xy((lat, lon))))


def _skips_drawn(G, orig, short, dev, tol=SHORTCUT_MAX_DEV_M):
    """orig 裡貼著手繪線的節點，有沒有離捷徑 short 太遠的（= 被跳過的圖案）。"""
    pr = LocalProj(*_ll(G, short[0]))
    line = LineString([pr.xy(_ll(G, n)) for n in short]) if len(short) > 1 else Point(pr.xy(_ll(G, short[0])))
    for n in orig[1:-1]:
        p = _ll(G, n)
        if dev(*p) <= tol and line.distance(Point(pr.xy(p))) > tol:
            return True
    return False


def advanced_shortcut_optimizer(G, path_nodes, lookahead=40, max_search_dist=300, stroke=None):
    """
    截彎取直：把局部繞路換成路網上的最短路。

    - 用真實累積路長比較（以前用「每節點 5 公尺」估算，又比節點數，閉合圖形會被整圈抄掉）。
    - 單次捷徑最多跳過整條路徑的 1/4（span_cap），保護閉合圖形。
    - 有傳 stroke 時，捷徑上每個節點都要在手繪線 SHORTCUT_MAX_DEV_M 內才採用，
      否則圖案的小細節（愛心的凹口、星星的角）會被抄平。
    """
    if not path_nodes or len(path_nodes) < 3:
        return path_nodes
    dev = _dev_checker(stroke) if stroke else None
    cum = [0.0]
    for a, b in zip(path_nodes[:-1], path_nodes[1:]):
        cum.append(cum[-1] + _edge_length(G, a, b))
    span_cap = max(2, len(path_nodes) // 4)
    new_path = [path_nodes[0]]
    i = 0
    while i < len(path_nodes) - 1:
        curr = path_nodes[i]
        best = None
        # 先挑出「直線距離明顯比原路短」的候選終點；沒有的話這一步根本不用算最短路
        cands = []
        for kk in range(min(lookahead, len(path_nodes) - 1 - i, span_cap), 1, -1):
            tgt = path_nodes[i + kk]
            if tgt == curr:
                continue
            air = _node_dist(G, curr, tgt)
            orig = cum[i + kk] - cum[i]
            if air <= max_search_dist and air * 1.5 < orig:
                cands.append((kk, tgt, orig))
        if cands:
            # 一次有限距離的 Dijkstra 同時回答所有候選（以前每個候選各跑一次全圖最短路）
            # 捷徑必須比原路短 20%；travel_weight 對一般道路是路長的 1~1.2 倍，
            # 放到 1.5 倍已足夠，再大只是白白展開大半張圖
            reach = max(o for _, _, o in cands) * 0.8 * 1.5
            dist, paths = nx.single_source_dijkstra(G, curr, cutoff=reach, weight='travel_weight')
            for kk, tgt, orig in cands:
                sp = paths.get(tgt)
                if sp is None or path_length(G, sp) >= orig * 0.8:
                    continue
                if dev is not None:
                    if any(dev(*_ll(G, n)) > SHORTCUT_MAX_DEV_M for n in sp):
                        continue
                    # 也不能「跳過」畫出來的部分：原路上貼著手繪線的節點，
                    # 捷徑都要經過它附近。否則星星的角會被從底部一刀抄掉。
                    if _skips_drawn(G, path_nodes[i:i + kk + 1], sp, dev):
                        continue
                best = (sp, kk)
                break
        if best:
            new_path.extend(best[0][1:])
            i += best[1]
        else:
            new_path.append(path_nodes[i + 1])
            i += 1
    return new_path


def clean_path(G, nodes, stroke):
    """匹配結果的後製。Viterbi 本身已經避開大部分橫跳與繞路，這裡只收拾小毛邊。"""
    nodes = remove_geometric_spikes(nodes, G, stroke=stroke)
    nodes = remove_short_loops(nodes, window=10, G=G, stroke=stroke)
    nodes = advanced_shortcut_optimizer(G, nodes, lookahead=50, max_search_dist=300, stroke=stroke)
    nodes = prune_spurs_stack(nodes, G, stroke)
    nodes = remove_meaningless_uturns(nodes, G, shortcut_m=12)
    nodes = remove_backtracks(G, nodes, stroke=stroke)
    return nodes


def prune_final_spurs(segments, G):
    """所有段串起來之後，再剪一次 A->B->A 型的短分岔（< 50m）。"""
    for seg in segments:
        nodes = seg.get('nodes')
        if not nodes:
            continue
        changed = True
        while changed and len(nodes) >= 3:
            changed = False
            i = 0
            while i < len(nodes) - 2:
                n1, n2, n3 = nodes[i], nodes[i + 1], nodes[i + 2]
                if n1 == n3:
                    try:
                        short = _node_dist(G, n1, n2) < 50
                    except KeyError:
                        short = True
                    if short:
                        del nodes[i + 1:i + 3]
                        changed = True
                        continue
                i += 1
        seg['nodes'] = nodes
    return segments


def prune_non_overlapping_segments(segments, red_strokes, G, threshold=40):
    """
    砍「幻覺繞路」：一段連續離手繪線 > threshold 的節點，如果把它拿掉後
    兩端可以用合理的最短路接起來（<= bridge 的上限），就換成最短路；
    接不回來的就是唯一的路（格網逼出來的），保留原樣，否則會切西瓜。
    """
    if not segments or not red_strokes:
        return segments
    allpts = [p for s in red_strokes for p in s]
    pr = LocalProj.around(allpts)
    geom = MultiLineString([[pr.xy(p) for p in s] for s in red_strokes if len(s) > 1])
    far = lambda n: geom.distance(Point(pr.xy(_ll(G, n)))) >= threshold

    out = []
    for seg in segments:
        if seg.get('kind') != 'draw' or seg.get('type') != 'road' or not seg.get('nodes'):
            out.append(seg)
            continue
        ns = seg['nodes']
        flags = [(n in G.nodes) and not far(n) for n in ns]
        new = []
        i = 0
        while i < len(ns):
            if flags[i]:
                new.append(ns[i]); i += 1
                continue
            j = i
            while j < len(ns) and not flags[j]:
                j += 1
            a = new[-1] if new else None
            b = ns[j] if j < len(ns) else None
            keep = True
            if a is not None and b is not None:
                straight = _node_dist(G, a, b)
                filled = robust_shortest_path(G, a, b, weight='length')
                if filled and len(filled) >= 2 and path_length(G, filled) <= max(straight * 4.0, straight + 150.0):
                    new.extend(filled[1:-1])
                    keep = False
            if keep:
                new.extend(ns[i:j])
            i = j
        if len(new) >= 2:
            s2 = dict(seg)
            s2['nodes'] = new
            out.append(s2)
    return out


# ===========================================================
# 筆畫前處理：縫合、排序、閉合圖形旋轉
# ===========================================================
def _tangent_out(s, at_end, probe_m=15.0):
    """筆畫在某一端「往外」的方位角：從離端點 probe_m 的內側點指向端點。"""
    pts = s if at_end else s[::-1]
    tip = pts[-1]
    acc = 0.0
    inner = pts[0]
    for q, p in zip(reversed(pts[:-1]), reversed(pts[1:])):
        acc += safe_dist(q, p)
        inner = q
        if acc >= probe_m:
            break
    return get_bearing(inner[0], inner[1], tip[0], tip[1])


def stitch_nearby_strokes(strokes, tolerance_m=50.0):
    """
    把「畫斷掉但很近」的筆畫縫成一筆（頭頭、頭尾、尾尾都看）。

    只有在「接得順」時才縫：兩端非常近（< 35% 門檻，等於同一筆被手指中斷），
    或是 A 的出口方向和 B 的入口方向夾角 < 90°。寫字時字母之間的空隙
    可能小於門檻，但筆畫方向通常接不順，這樣就不會被硬接成一筆。
    """
    pool = [list(s) for s in strokes if len(s) > 1]
    while True:
        best = None
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                s1, s2 = pool[i], pool[j]
                for e1 in (0, -1):
                    for e2 in (0, -1):
                        d = safe_dist(s1[e1], s2[e2])
                        if d >= tolerance_m or (best and d >= best[0]):
                            continue
                        if d >= tolerance_m * 0.35:
                            out_b = _tangent_out(s1, e1 == -1)
                            in_b = (_tangent_out(s2, e2 == -1) + 180) % 360
                            if get_angle_diff(out_b, in_b) >= 90:
                                continue
                        best = (d, i, j, e1, e2)
        if not best:
            return pool
        _, i, j, e1, e2 = best
        s1, s2 = pool[i], pool[j]
        a = s1 if e1 == -1 else s1[::-1]      # a 以接點結尾
        b = s2 if e2 == 0 else s2[::-1]       # b 以接點開頭
        pool[i] = a + b
        pool.pop(j)


def _is_closed(s, tol_m):
    return len(s) >= 3 and safe_dist(s[0], s[-1]) < tol_m


def _close_crossed(s, tol_m):
    """
    頭尾「交錯」的閉合圖形：最後一段畫過了頭、跟開頭疊到，頭尾端點反而差了一段
    → 會被誤判成開放線條。在頭 20% × 尾 20% 的窗口裡找最近點對，在門檻內就剪掉
    多出來的頭尾視為閉合。剪掉超過 20% 的不算（R、9、6 這種「環 + 尾巴」是開放的）。
    """
    if _is_closed(s, tol_m) or len(s) < 8:
        return s
    win = max(3, len(s) // 5)
    best = None
    for i in range(win):
        for j in range(len(s) - win, len(s)):
            if j - i < len(s) * 0.8:
                continue
            d = safe_dist(s[i], s[j])
            if d < tol_m and (best is None or d < best[0]):
                best = (d, i, j)
    if best:
        _, bi, bj = best
        t = s[bi:bj + 1]
        if len(t) >= 3:
            return t + [t[0]]
    return s


def _entry_cost(s, ref, closed):
    """從 ref 進入筆畫 s 的直線距離，以及進入後的出口點與（開放線條的）方向。"""
    if closed:
        k = min(range(len(s) - 1), key=lambda i: safe_dist(ref, s[i]))
        return safe_dist(ref, s[k]), s[k], False
    d0, d1 = safe_dist(ref, s[0]), safe_dist(ref, s[-1])
    if d1 < d0:
        return d1, s[0], True
    return d0, s[-1], False


def order_strokes(strokes, start, end, close_tol_m=30.0, brute_max=7):
    """
    多筆畫時決定「先跑哪一筆、從哪頭進」，讓連接段（灰色虛線）總長最短。
    以前完全照下筆順序，畫文字時連接段會跨來跨去。

    成本 = 起點 → 各筆畫 → 終點 的直線距離總和。筆畫數 <= brute_max 時窮舉，
    否則用最近鄰 + 2-opt。開放線條可以反著跑；閉合圖形之後由 reorder_closed_strokes
    旋轉到最近的入口。
    """
    if len(strokes) < 2:
        return strokes
    closed = [_is_closed(s, close_tol_m) for s in strokes]

    def eval_order(order):
        ref, total, plan = start, 0.0, []
        for i in order:
            d, exit_pt, rev = _entry_cost(strokes[i], ref, closed[i])
            total += d
            plan.append((i, rev))
            ref = exit_pt
        if end is not None:
            total += safe_dist(ref, end)
        return total, plan

    n = len(strokes)
    if n <= brute_max:
        best = min((eval_order(p) for p in itertools.permutations(range(n))), key=lambda x: x[0])
    else:
        left, order, ref = set(range(n)), [], start
        while left:
            i = min(left, key=lambda i: _entry_cost(strokes[i], ref, closed[i])[0])
            order.append(i)
            ref = _entry_cost(strokes[i], ref, closed[i])[1]
            left.discard(i)
        best = eval_order(order)
        improved = True
        while improved:
            improved = False
            for a in range(n - 1):
                for b in range(a + 1, n):
                    cand = order[:a] + order[a:b + 1][::-1] + order[b + 1:]
                    r = eval_order(cand)
                    if r[0] < best[0] - 1e-6:
                        best, order, improved = r, cand, True
    return [strokes[i][::-1] if rev else strokes[i] for i, rev in best[1]]


def reorder_closed_strokes(strokes, user_pos, close_tol_m=30.0):
    """
    閉合圖形旋轉起點：第 N 筆從「離第 N-1 筆終點（第一筆則是使用者起點）最近的地方」開始，
    而不是從當初下筆的隨機位置開始。

    方向預設保留使用者下筆的方向；config.FORCE_CLOCKWISE=True 才統一改成順時針。
    """
    if not strokes:
        return strokes
    ref = tuple(user_pos) if user_pos else tuple(strokes[0][0])
    out = []
    for s in strokes:
        s = [tuple(p) for p in s]
        if len(s) >= 3:
            s = _close_crossed(s, close_tol_m)
        if _is_closed(s, close_tol_m):
            uniq = s[:-1]
            k = min(range(len(uniq)), key=lambda i: safe_dist(ref, uniq[i]))
            rot = uniq[k:] + uniq[:k]
            s = rot + [rot[0]]
            if FORCE_CLOCKWISE:
                edge_sum = sum((b[1] - a[1]) * (b[0] + a[0]) for a, b in zip(s[:-1], s[1:]))
                if edge_sum < 0:
                    s = [s[0]] + list(reversed(s[1:-1])) + [s[0]]
        out.append(s)
        ref = s[-1]
    return out


def stroke_tolerance(strokes):
    """縫合／閉合判斷的門檻：整體圖形對角線的 4%，夾在 15~120m。"""
    allp = [p for s in strokes for p in s]
    if not allp:
        return 50.0
    lat = [p[0] for p in allp]; lon = [p[1] for p in allp]
    return max(15.0, min(120.0, haversine(min(lat), min(lon), max(lat), max(lon)) * 0.04))


def prepare_strokes(strokes, start, end):
    """生成前的筆畫前處理：縫合 → 排序 → 閉合圖形旋轉。"""
    strokes = [[tuple(p) for p in s] for s in strokes if len(s) > 1]
    tol = stroke_tolerance(strokes)
    strokes = stitch_nearby_strokes(strokes, tolerance_m=tol)
    strokes = order_strokes(strokes, tuple(start) if start else strokes[0][0],
                            tuple(end) if end else None, close_tol_m=tol)
    return reorder_closed_strokes(strokes, start, close_tol_m=tol)


# ===========================================================
# 總入口
# ===========================================================
def solve_route(G, red_strokes, user_start, user_end):
    """
    把（已經過 prepare_strokes 的）手繪筆畫轉成路線分段：
        [{'type':'road','kind':'draw'|'travel','nodes':[...]},
         {'type':'beeline','kind':'draw'|'travel','coords':[(lat,lon),...]}, ...]
    kind='travel' 是連接段（起點→第一筆、筆畫之間、最後一筆→終點）。

    注意：G 的 travel_weight 不會被改動（以前會永久調高走過的邊，
    呼叫端必須每次給副本，否則結果逐次劣化）。
    """
    if not red_strokes:
        return []

    pool = []
    for stroke in red_strokes:
        pieces = match_stroke(G, stroke)
        if len(pieces) == 1:
            nodes = pieces[0]
            # 閉合圖形：Viterbi 的頭尾可能落在同一個路口兩側的不同節點，
            # 補上最後一小段讓它真的閉合，後面的旋轉與連接段才會把它當成一圈
            if safe_dist(stroke[0], stroke[-1]) < 1.0 and nodes[0] != nodes[-1]:
                tail = robust_shortest_path(G, nodes[-1], nodes[0], weight='length')
                if tail and path_length(G, tail) < 3 * MATCH_RADIUS_M:
                    nodes = nodes + tail[1:]
            pieces = [nodes]
        for k, nodes in enumerate(pieces):
            # 斷成多段時，後面各段的入口方向已經由匹配決定，不能再反轉／旋轉
            pool.append({'type': 'road', 'kind': 'draw', 'nodes': clean_path(G, nodes, stroke),
                         'fixed': k > 0})
        if not pieces:
            pool.append({'type': 'beeline', 'kind': 'draw', 'coords': list(stroke)})

    # 每一筆的入口：閉合的旋轉到離上一個終點最近的節點；開放的看要不要反過來跑
    prev = None
    if user_start:
        try:
            prev = nearest_node(G, user_start[1], user_start[0])
        except ValueError:
            prev = None
    for st in pool:
        nodes = st.get('nodes')
        if st['type'] != 'road':
            continue
        if prev is not None and not st.get('fixed'):
            pp = _ll(G, prev)
            if nodes[0] == nodes[-1] and len(nodes) > 2:
                uniq = nodes[:-1]
                k = min(range(len(uniq)), key=lambda i: safe_dist(pp, _ll(G, uniq[i])))
                if k:
                    rot = uniq[k:] + uniq[:k]
                    st['nodes'] = rot + [rot[0]]
            elif safe_dist(pp, _ll(G, nodes[-1])) < safe_dist(pp, _ll(G, nodes[0])):
                st['nodes'] = nodes[::-1]
        prev = st['nodes'][-1]

    def connector(a_node, b_node, a_geo, b_geo):
        if a_node is not None and b_node is not None:
            path = robust_shortest_path(G, a_node, b_node, weight='length')
            if path and len(path) > 1:
                return {'type': 'road', 'kind': 'travel', 'nodes': path}
            if path:
                return None
        if a_geo is not None and b_geo is not None and safe_dist(a_geo, b_geo) > 5:
            return {'type': 'beeline', 'kind': 'travel', 'coords': [a_geo, b_geo]}
        return None

    def snap(geo):
        try:
            return nearest_node(G, geo[1], geo[0])
        except ValueError:
            return None

    out = []
    cur_node = snap(user_start) if user_start else None
    cur_geo = tuple(user_start) if user_start else None
    for st in pool:
        if st['type'] == 'road':
            tgt_node = st['nodes'][0]
            tgt_geo = _ll(G, tgt_node)
        else:
            tgt_geo = st['coords'][0]
            tgt_node = snap(tgt_geo)
        c = connector(cur_node, tgt_node, cur_geo, tgt_geo)
        if c:
            out.append(c)
        out.append(st)
        if st['type'] == 'road':
            cur_node = st['nodes'][-1]
            cur_geo = _ll(G, cur_node)
        else:
            cur_geo = st['coords'][-1]
            cur_node = snap(cur_geo)

    if user_end:
        end_node = snap(user_end)
        c = connector(cur_node, end_node, cur_geo, tuple(user_end))
        if c:
            out.append(c)

    out = prune_final_spurs(out, G)
    out = prune_non_overlapping_segments(out, red_strokes, G, threshold=40)
    for seg in out:
        seg.pop('fixed', None)
        if seg.get('type') == 'road' and seg.get('nodes') and len(seg['nodes']) >= 2:
            seg['nodes'] = bridge_node_path_gaps(G, seg['nodes'])
    debug_log(f"[solve_route] {len(out)} 段")
    return out
