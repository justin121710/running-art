"""可調參數與共用設定。

改這裡的數字會改變路線結果——改完跑 `python tests/bench.py --compare`
（真實路網的品質基準）和 `python -m pytest tests`。
"""
import datetime

# ===========================
# 1. 道路成本倍率（住宅區道路 = 1.0）
# ===========================
# 與車道平行的人行道（footway=sidewalk）。每條街兩側各一條，
# 成本太低的話路徑會在兩側之間來回橫跳。2.5 = 偏好車道中心線；過高 (>4) 可能繞遠路。
SIDEWALK_PENALTY = 2.5

# 沒標子類型的 footway。很多地方的人行道沒有標 footway=sidewalk，
# 分不出是不是平行人行道，所以維持和舊版相同的 2.5。
FOOTWAY_PENALTY = 2.5

# 獨立步道（path、pedestrian、cycleway、track）：公園、河濱、巷弄步道，
# 通常正是想跑的地方，只輕罰。
PATH_PENALTY = 1.3

# 階梯：跑步不方便，能繞就繞。
STEPS_PENALTY = 3.0

# 行人穿越道（footway=crossing）：過馬路是必要動作且距離很短（實測平均約 10m），
# 懲罰的話路徑會繞到很遠的路口過馬路，所以不罰。
CROSSING_PENALTY = 1.0

# service / living_street / unclassified：巷弄、停車場車道。
MINOR_ROAD_PENALTY = 1.2

# primary / secondary 主要幹道：車多，稍微不鼓勵。
MAJOR_ROAD_PENALTY = 1.1

# trunk（只有標了 foot=yes 或有人行道的才會進路網）：盡量少走。
TRUNK_PENALTY = 2.0

# ===========================
# 2. 路網前處理
# ===========================
# 剪掉總長小於這個值的死路分岔（人行道接馬路的小短線、車道出入口）。
# 走廊尋路很容易一頭鑽進去再折返，畫出小刺。0 = 不剪。
# 不要調太大：整條死巷不能剪，否則起訖點會被吸到很遠的地方。
SPUR_PRUNE_M = 30.0

# ===========================
# 3. 手繪線對齊道路（地圖匹配，routing.match_stroke）
# ===========================
# 沿手繪線取樣的間距。越小越貼合，但運算量越大。
MATCH_STEP_M = 30.0
# 每個樣點在這個半徑內找候選路網節點。
MATCH_RADIUS_M = 45.0
# 每個樣點最多保留幾個候選節點。
MATCH_K = 8
# 「節點離手繪線多遠」的成本權重（每公尺）。越大越貼線、越不在意繞路。
MATCH_EMIT_W = 1.5
# 「兩個樣點之間實際走的路比直線長多少」的成本權重（每公尺）。越大越不繞路。
MATCH_DETOUR_W = 1.0
# 原地迴轉（剛走過來的那條邊馬上走回去）的額外成本（公尺）。
MATCH_UTURN_PENALTY = 80.0

# 手繪線輕度平滑的容差 (公尺)。只消除手抖，圖案幾乎不變。0 = 不平滑。
SMOOTH_TOLERANCE_M = 10

# 閉合圖形是否一律改成順時針。預設保留使用者下筆的方向——
# 想讓某一圈反方向跑，照那個方向畫就好。
FORCE_CLOCKWISE = False

# ===========================
# 4. 路徑清理
# ===========================
# 「繞出去又折返回原地」的判定：實際走了 >= MIN_EXCURSION 公尺，
# 最後卻回到出發點 RETURN_RADIUS 公尺內 -> 視為無意義折返，剪掉。
BACKTRACK_RETURN_RADIUS_M = 30.0
BACKTRACK_MIN_EXCURSION_M = 80.0
BACKTRACK_WINDOW = 60          # 往後最多檢查幾個節點

# 「細長度」門檻：圍出的面積 / 同周長圓的面積。
# 原路折返 ~= 0 (剪掉)；畫圓 = 1.0 (保留)。0.05 = 只剪掉又細又長的來回。
BACKTRACK_MAX_THINNESS = 0.05

# 截彎取直：捷徑上每一點離手繪線都要在這個距離內才採用，
# 否則會把圖案的小細節（例如愛心的凹口）抄平。
SHORTCUT_MAX_DEV_M = 30.0

# ===========================
# 5. 吻合度
# ===========================
# 路線與手繪線距離在這個範圍內算「吻合」。
FIT_TOL_M = 30.0


DEBUG = False


def debug_log(msg):
    if not DEBUG:
        return
    timestamp = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)
