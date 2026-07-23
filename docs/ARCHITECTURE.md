# Running Art — 程式結構

## 一、資料夾

```
RUNNING_ART/
├─ GPS_ART_vFINAL.py        桌面版主程式（Tkinter GUI，約 3500 行）
├─ gpsart/                  演算法核心（桌面版與瀏覽器版共用）
│   ├─ config.py            所有可調參數 + debug_log
│   ├─ geometry.py          純幾何運算（15 個函式）
│   ├─ graphutil.py         取代 osmnx 的路網工具（找最近節點、範圍裁切）
│   ├─ graphprep.py         路網前處理 + 從 Overpass JSON 建圖
│   ├─ routing.py           路徑演算法核心（約 2500 行，23 個函式）
│   └─ export.py            GPX 輸出、下載時間估算
├─ web_prototype/           瀏覽器版開發區
│   ├─ ui_prototype.html    介面
│   ├─ engine.js            Pyodide 引擎橋接
│   └─ gpsart/              給瀏覽器抓的演算法副本
├─ deploy/                  ★ 部署用（自己是一個 git repo）
│   ├─ index.html           = ui_prototype.html
│   ├─ engine.js
│   ├─ gpsart/*.py
│   └─ .nojekyll            必要！否則 GitHub Pages 不會輸出 .py
├─ selftest_algorithms.py   行為基準測試
├─ fixture_graph.graphml    測試用固定路網
├─ baseline.json            已驗證的基準數值
└─ GPS_Results/             桌面版輸出（GPX／PNG）
```

**相依方向**（無循環）：
```
config ← geometry ← graphutil ← graphprep ← routing
                          ↖ export
```

---

## 二、⚠️ 動演算法前必讀：基準測試

```bash
python selftest_algorithms.py compare
```

會用固定路網跑 **28 項指標**（幾何、前處理、每個清理演算法、走廊尋路、
端對端 `solve_route`、GPX 點數）與基準值比對。輸出「行為未改變」才算安全。

**這是必要的安全網**——這個專案曾經因為沒有測試而發生兩次回歸
（一次路徑覆蓋率掉到 1/3，一次路線連到地圖邊界外）。

若是**刻意**要改變行為，確認新結果正確後再更新基準：
```bash
python selftest_algorithms.py baseline
```

---

## 三、主要函式導覽（`gpsart/routing.py`）

### 入口
| 函式 | 說明 |
|---|---|
| `solve_route()` | 總入口。把手繪筆畫轉成最終路線分段 |
| `route_in_corridor()` | 走廊尋路：在筆畫附近的緩衝區內找道路 |

### 路徑清理（依執行順序）
| 函式 | 作用 |
|---|---|
| `remove_geometric_spikes()` | 去除幾何尖刺 |
| `remove_short_loops()` | 去除短迴圈（相同節點重複） |
| `advanced_shortcut_optimizer()` | 截彎取直（**有 span_cap 保護閉合圖形**） |
| `prune_spurs_stack()` | 剪除 A→B→A 型分岔 |
| `remove_meaningless_uturns()` | 去除小尖刺折返（回到 12m 內） |
| `remove_backtracks()` | 去除長距離折返（**有細長度保護圓形**） |
| `bridge_node_path_gaps()` | **最後統一修補**：把跳點沿真實道路接回 |

### 前處理（生成前）
| 函式 | 作用 |
|---|---|
| `stitch_nearby_strokes()` | 斷開但很近的筆畫縫成一筆 |
| `reorder_closed_strokes()` | 閉合圖形旋轉起點到離使用者起點最近處 |
| `smooth_drawn_stroke()` | 輕度平滑手繪線（消手抖） |

### 幾何輸出
| 函式 | 作用 |
|---|---|
| `road_polyline_from_nodes()` | 節點串 → 座標串，**沿道路實際彎曲幾何** |
| `robust_shortest_path()` | 有向找不到路時改用無向（跑步不分單行道） |

---

## 四、可調參數（`gpsart/config.py`）

| 參數 | 預設 | 作用 |
|---|---|---|
| `FOOTWAY_PENALTY` | 2.5 | 人行道成本倍率。調高→偏好車道中心線，減少橫跳 |
| `CROSSING_PENALTY` | 1.0 | 行人穿越道倍率。**不要調高**，否則過馬路會繞遠路 |
| `REUSE_PENALTY_FACTOR` | 4.0 | 已走過的路再走一次的倍率。原本是 1e9（封死）導致繞遠路 |
| `SMOOTH_TOLERANCE_M` | 10 | 手繪線平滑容差 |
| `CORRIDOR_SAMPLE_STEP_M` | 40 | 沿紅線取樣間距。**調大到 60 可明顯減少橫跳且不犧牲貼合度** |
| `BACKTRACK_MIN_EXCURSION_M` | 80 | 走多遠才算折返。調小→剪更兇 |
| `BACKTRACK_RETURN_RADIUS_M` | 30 | 回到多近算「回原地」 |
| `BACKTRACK_MAX_THINNESS` | 0.05 | **保護圓形不被剪爛的關鍵，不建議調高** |
| `CONSOLIDATE_TOLERANCE_M` | **0（停用）** | 路口節點合併，見下方 |

### 為什麼路口合併是停用的

合併 10m 內的路口節點可以大幅減少橫跳與折返（實測節點數 −62%、原地繞回歸零），
但實際使用時會造成「路徑連到地圖邊界外、線條互相平行」的異常。

**未查明的原因**：`ox.consolidate_intersections` 會把節點編號重編成 `0..N` 的小整數。
程式裡同時存在多份路網（`cached_G` / `cached_G_drive` / `graph_to_solve` / `last_gen_G`），
以前用 OSM 長編號時拿錯圖會直接查不到（安靜跳過），
改成小整數後**拿錯圖也會查到一個「存在但完全錯誤」的座標**。

要重新啟用前，必須先稽核所有路網之間的節點編號一致性。

---

## 五、瀏覽器版運作方式

```
瀏覽器
 ├─ Leaflet          地圖與繪圖
 ├─ engine.js        橋接層
 └─ Pyodide (WASM)
     ├─ numpy / networkx / shapely   （micropip 安裝）
     └─ gpsart/*.py                  （fetch 後寫進 Pyodide 檔案系統）
```

**完全不需要伺服器**：Overpass 允許瀏覽器直接 `fetch`，運算在使用者裝置上跑。

### `engine.js` API
| 方法 | 作用 |
|---|---|
| `Engine.boot()` | 載入 Pyodide、套件、gpsart（約 3 秒，之後有快取） |
| `Engine.loadArea(s,w,n,e)` | 下載該範圍路網並前處理 |
| `Engine.generate(strokes,start,end)` | 對齊道路，回傳分段、總長、吻合度 |
| `Engine.toGPX(segments)` | 產生 GPX 字串 |
| `Engine.setProgress(fn)` | 設定進度回呼 |

### 實測效能（線上版）
| 項目 | 時間 |
|---|---|
| 引擎啟動 | 約 3 秒（首次） |
| 下載路網（697 個路口） | 4.9 秒 |
| 生成路線 | 1.8 秒 |

---

## 六、瀏覽器版的三個坑（都已修，但要知道）

1. **每次生成必須用路網副本**
   `route_in_corridor` 會**永久**調高走過的邊的 `travel_weight`。
   桌面版每次重新裁切一份新圖所以沒事，瀏覽器版重複用同一份會被上次污染、結果逐次劣化。
   → `engine.js` 裡固定 `Gw = G.copy()`。

2. **Overpass 一定要有逾時**
   沒逾時的話被限流時 fetch 會永遠卡住，畫面停在「下載路網…」只能重整。
   → 每台伺服器 45 秒逾時 + 備援伺服器 + 明確錯誤訊息。

3. **更新 `gpsart/` 要同時改 `engine.js` 的 `VERSION`**
   否則瀏覽器會沿用快取的舊演算法（`fetch('gpsart/x.py?v=VERSION')`）。

---

## 七、部署

`deploy/` 自己就是一個 git repo，已設好 origin。

```bash
cd deploy && git add -A && git commit -m "更新" && git push
```

約一分鐘後 https://justin121710.github.io/running-art/ 會更新。

**坑**：GitHub Pages 一開始建置失敗（`Page build failed`），
因為 Jekyll 不肯輸出 `gpsart/*.py`。**必須有 `.nojekyll`**。
另外 Pages 有時會卡在舊的失敗 commit，可用 API 強制重建：
`POST /repos/justin121710/running-art/pages/builds`

---

## 八、開發流程建議

1. 改 `gpsart/` → 跑 `python selftest_algorithms.py compare`
2. 同步到兩個位置：`web_prototype/gpsart/` 與 `deploy/gpsart/`
3. 若改了演算法，記得更新 `engine.js` 的 `VERSION`
4. 本機測試：`python -m http.server 8765 --directory web_prototype`
5. 推上 `deploy/` 部署
