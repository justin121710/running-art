# Running Art — 程式結構

## 一、資料夾

```
running-art/                （這個 repo 就是 GitHub Pages 的網站根目錄）
├─ index.html               版面與 CSS（約 750 行）＋免責聲明的小段內嵌腳本
├─ js/                      介面程式（一般 <script>，依序載入，共用同一個全域範圍）
│   ├─ theme.js             地圖、底圖來源（TILE_PROVIDERS）、深淺主題、配色、箭頭造型
│   ├─ ui.js                中英文、狀態 S、引導提示、框選下載、畫圖與起訖點
│   ├─ route.js             路線預覽（跑者、箭頭、高程圖拉桿）、配速、生成、反轉
│   ├─ edit.js              微調路徑（刪節點、拖曳節點改道）
│   ├─ export.js            分享圖（renderScene）、GPX
│   └─ init.js              免責聲明、地點搜尋、作品保存／分享連結、啟動
├─ engine.js                主執行緒端的引擎介面（只負責和 Worker 傳話、產生 GPX）
├─ engine-worker.js         Web Worker：Pyodide、Overpass 下載、IndexedDB 路網快取
├─ sw.js                    Service Worker：快取 Pyodide 與本站檔案（離線可用）
├─ gpsart/                  演算法（Python，在 Worker 的 Pyodide 裡跑，也能用 CPython 測試）
│   ├─ config.py            所有可調參數
│   ├─ geometry.py          幾何運算、LocalProj 平面投影
│   ├─ graphutil.py         NodeIndex 空間索引、nearest_node、unique_neighbors
│   ├─ graphprep.py         Overpass JSON → 路網、前處理、道路成本
│   ├─ routing.py           地圖匹配、路徑清理、筆畫排序、solve_route
│   └─ web_api.py           給 Worker 呼叫的介面（生成、微調、吻合度）
├─ vendor/leaflet/          Leaflet 1.9.4（自己提供，不走 CDN）
├─ tests/
│   ├─ test_algorithms.py   pytest：單一函式行為＋真實路網品質不退步
│   ├─ bench.py             真實路網（赫爾辛基）品質基準
│   ├─ baseline_bench.json  目前演算法的基準成績
│   ├─ baseline_v1_greedy.json  舊演算法（逐段貪婪）的成績，留作對照
│   ├─ e2e/run_e2e.js       Playwright 端對端：真的在瀏覽器跑 Pyodide 走完整流程
│   └─ data/                測試路網（OSM，ODbL）
├─ tools/stamp_versions.py  依檔案內容更新所有 ?v= 版本號
├─ .github/workflows/ci.yml CI：pytest、版本號檢查、JS 語法、端對端測試
└─ docs/                    文件
```

**相依方向**（無循環）：
```
config ← geometry ← graphutil ← graphprep ← routing ← web_api
```

---

## 二、⚠️ 改程式之前

```bash
pip install numpy networkx shapely pytest
python -m pytest              # 約 15 秒，含真實路網品質檢查
python tests/bench.py --compare   # 看各圖形的詳細成績和基準比
node tests/e2e/run_e2e.js     # 端對端（需要 playwright；約 3 分鐘）
python tools/stamp_versions.py    # 改了任何 .js / gpsart/*.py 之後一定要跑
```

- **改 `gpsart/`**：pytest 的 `test_bench_not_worse_than_baseline` 會擋下品質退步
  （每個圖形的 F1 不能比基準低 0.03 以上、長度不能多 15%）。刻意改變行為、確認變好之後，
  `python tests/bench.py --save` 更新基準。
- **改任何 .js 或 .py**：跑 `tools/stamp_versions.py`，否則瀏覽器會沿用快取的舊檔。
  CI 會用 `--check` 檢查，忘了跑會紅燈。
- 這個專案過去發生過多次「改 A 壞 B」的回歸，而且好幾次是**測試本身測不到**
  （輸入根本不會觸發那段邏輯）。加新測試時問一句：這個輸入真的會走到我想守護的程式嗎？

---

## 三、演算法（`gpsart/routing.py`）

### 總流程

```
筆畫 ─► prepare_strokes()
          stitch_nearby_strokes()   斷開但很近、而且方向接得順的筆畫縫成一筆
          order_strokes()           決定筆畫順序與方向，讓連接段最短
          reorder_closed_strokes()  閉合圖形從離上一個終點最近的地方開始
     ─► solve_route()
          match_stroke()            每一筆用 Viterbi 對齊到路網（見下）
          clean_path()              收拾小毛邊
          連接段                    起點 → 各筆 → 終點，純最短路（與原路線重疊沒關係）
          prune_final_spurs()
          prune_non_overlapping_segments()   砍「幻覺繞路」（補得回才砍）
          bridge_node_path_gaps()   最後統一把跳點沿真實道路接回
```

### 地圖匹配 `match_stroke()`

舊版是「每 40m 各自找一段局部最短路再串起來」，每一步只看下一個樣點：
最近節點在馬路兩側反覆換邊就會橫跳，某一步選錯後面就得繞回來，
再靠一長串清理步驟補救。現在改成 HMM 地圖匹配（Newson & Krumm 2009，
Valhalla Meili / OSRM match 同一套想法），在所有候選組合中求總成本最低的一條：

| 成本 | 內容 |
|---|---|
| 候選 | 每個樣點（每 `MATCH_STEP_M`）半徑 `MATCH_RADIUS_M` 內最近的 `MATCH_K` 個節點 |
| 發射 | `MATCH_EMIT_W` × 節點到樣點的距離 |
| 轉移 | 路網成本（travel_weight）＋ `MATCH_DETOUR_W` × \|實際路長 − 樣點直線距離\| |
| 偏離 | 轉移路徑離「這一小段手繪線」超過候選半徑的部分 × 2 × `MATCH_EMIT_W`；超過 2 倍半徑直接不採用 |
| 迴轉 | 剛走過來的邊馬上走回去 ＋ `MATCH_UTURN_PENALTY` |

**接不上時**：某個樣點的候選都接不上，先跳過它（最多連續 3 個）；還是接不上
（鐵道、河、施工圍籬）就**斷成兩段**，中間由連接段（虛線）接起來。
以前是不限距離硬接，常常沿著已經畫好的路線整圈繞回去，又被當成圖案的一部分。

### 清理 `clean_path()`

| 函式 | 作用 | 保護 |
|---|---|---|
| `remove_geometric_spikes` | 去掉兩腿都 < 45m、轉角 > 135° 的小尖刺 | 尖端貼著手繪線（< 25m）就保留 |
| `remove_short_loops` | 同一節點 10 步內又出現＝小圈，剪掉 | 只剪 < 150m 的圈；圈上全貼著手繪線就不剪 |
| `advanced_shortcut_optimizer` | 截彎取直（用真實路長） | `span_cap`（最多跳 1/4）；捷徑要貼著手繪線；**不能跳過畫出來的部分** |
| `prune_spurs_stack` | A→B→A 分岔 | 尖端貼著手繪線就保留（星星的角） |
| `remove_meaningless_uturns` | 回到 12m 內的三點折返 | — |
| `remove_backtracks` | 走出去 ≥80m 又回到 30m 內的來回 | 細長度防呆（圓不剪）；來回段全貼著手繪線就不剪 |

「保護」欄是這次修正的重點：以前這些步驟分不出「使用者畫的尖角」和「演算法繞出來的折返」，
星星的五個角幾乎全被剪掉（覆蓋率 33%）。

### 品質（`tests/bench.py`，赫爾辛基市中心真實路網）

| 圖形 | 舊（貪婪）F1 | 新（Viterbi）F1 | 舊耗時 | 新耗時 |
|---|---|---|---|---|
| 圓 R300 | 0.64 | 0.69 | 0.9s | 0.7s |
| 圓 R150 | 0.57 | 0.72 | 0.6s | 0.4s |
| 愛心 | 0.52 | 0.74 | 0.9s | 1.2s |
| 旋轉正方形 | 0.49 | 0.76 | 1.0s | 0.7s |
| 星星 | 0.39 | 0.75 | 1.1s | 2.0s |
| 鋸齒線 | 0.81 | 0.82 | 0.5s | 0.4s |
| 兩個圓 | 0.65 | 0.79 | 1.0s | 0.5s |
| 直線 | 0.70 | 0.77 | **152s** | 0.4s |
| **平均** | **0.60** | **0.76** | | |

F1 = 準確率（路線落在手繪線 30m 內）與覆蓋率（手繪線被路線蓋到）的調和平均。
時間是 CPython；瀏覽器的 Pyodide 約慢 2～4 倍（實測 R≈160m 的圓 3.5 秒）。

---

## 四、路網前處理（`gpsart/graphprep.py`）

1. **下載篩選**（`OVERPASS_FILTER`，Worker 會讀這個常數組查詢）：
   排除 motorway、施工中、`foot=no`、`motorroad=yes`、`area=yes`。
2. **建圖**（`_walk_allowed`）：`foot=yes` 優先於 `access`（`access=private + foot=yes` 可以走）；
   trunk 只有標了 `foot=yes` 或有人行道才收（台灣快速道路多半是 trunk）。每條路存雙向兩條邊。
3. **剪短分岔**（`prune_short_spurs`）：總長 < `SPUR_PRUNE_M` 的死路分岔。整條死巷保留。
4. **角度簡化**：兩個鄰居、幾乎直線的中間節點合併；**只合併同一種道路**（穿越道標籤才不會遺失）。
5. **只留最大連通塊**：其他區域的外框回傳給前端，畫成灰色虛線框。
6. **道路成本**（`edge_penalty`）：

| 道路 | 倍率 | 參數 |
|---|---|---|
| 住宅區道路等 | 1.0 | — |
| 行人穿越道 | 1.0 | `CROSSING_PENALTY` |
| 主要幹道 primary/secondary | 1.1 | `MAJOR_ROAD_PENALTY` |
| 巷弄 service/living_street | 1.2 | `MINOR_ROAD_PENALTY` |
| 獨立步道 path/pedestrian/cycleway | 1.3 | `PATH_PENALTY` |
| 平行人行道 footway=sidewalk、未標子類型的 footway | 2.5 | `SIDEWALK_PENALTY`、`FOOTWAY_PENALTY` |
| trunk（有人行道的） | 2.0 | `TRUNK_PENALTY` |
| 階梯 | 3.0 | `STEPS_PENALTY` |

### ⚠️ degree 的陷阱

路網是 `MultiDiGraph`，而且每條路都存成雙向兩條邊，所以 `G.degree(n)` 會把
「一進一出」算兩次：**死路端點的 degree 是 2、直路中間的點是 4**。
判斷死路、路口一律用 `graphutil.unique_neighbors()`。舊版的「剪除死路」和
「附近路口」都踩到這個坑：前者一個都沒剪到，後者把彎道上的形狀點也當成路口。

### 節點編號

一律用 `is None` 判斷「有沒有節點」。舊版到處用真假值判斷（`if not src_n`），
OSM 編號都是大正整數所以沒出事，但節點編號 0 會被當成沒有節點——
舊文件記載「路口合併會把編號重編成 0..N、然後出現原因不明的異常」，這很可能就是原因之一。
`tests/test_algorithms.py::test_node_id_zero_is_a_real_node` 守護這件事。

---

## 五、瀏覽器端

```
主執行緒                                   Web Worker（engine-worker.js）
 ├─ Leaflet（vendor/）                      ├─ Pyodide 0.26.4（CDN）
 ├─ js/*.js 介面                            │   └─ numpy / networkx / shapely（Pyodide 內建套件）
 └─ engine.js ── postMessage ───────────►   ├─ gpsart/*.py（fetch 後寫進 Pyodide 檔案系統）
                                            ├─ Overpass 下載（錯開競速）
                                            └─ IndexedDB 路網快取
```

### `Engine` API（engine.js，全部回傳 Promise）

| 方法 | 作用 |
|---|---|
| `boot()` | 啟動 Worker、載入 Pyodide 與 gpsart。失敗後再呼叫會重試 |
| `loadArea(s,w,n,e)` | 下載（或從快取讀）範圍路網並前處理。回傳 `{nodes, edges, islands}` |
| `generate(strokes,start,end)` | 生成路線。回傳分段、總長、`fit`／`precision`／`recall` |
| `editDelete(picks)` / `editUndo()` | 微調：刪節點沿道路重接 / 復原 |
| `editMove(si,n,id)` / `previewMove(si,n,id)` | 拖曳節點到路口（預覽不改動路線） |
| `nearbyJunctions(lat,lon,r,limit)` | 附近的路口（不重複鄰居 ≥ 3） |
| `snapToNode(lat,lon)` | 吸附到最近節點 |
| `reverseRoute()` | 反轉整條路線 |
| `cancel()` | 中止目前的運算：重開 Worker，並在背景重新載入上一個範圍 |
| `toGPX(segments, elevAt)` | 產生 GPX（主執行緒同步執行） |
| `setProgress(fn)` | 進度回呼 |

微調的兩個注意事項（和以前一樣）：回傳的 `si` 是「在 SEGS 裡的索引」，不是回傳陣列的索引；
`nodes` 陣列裡查不到的節點放 `null` 佔位。失敗時回傳 `{ok:false, reason}`，Python 端已自動復原。

Worker 一次只處理一個請求（Promise 鏈排隊），避免兩個請求同時改 Python 端的 `SEGS`／`HISTORY`。

### Overpass 下載

- **錯開競速**：先打第一台，4 秒沒回應或失敗才加開下一台。以前一次同時打 6 台，
  每次載入都給公用伺服器 6 倍負載，容易被限流。遇到 429／504 會讀 `Retry-After`。
- 查詢帶 `[timeout:25][maxsize:64MiB]`，介面上框選範圍上限 6 km²（框選時即時顯示面積與預估時間）。
- 辨識「軟逾時」（HTTP 200 但只有 remark）與空回應；⚠️ 驗證要容許空白：`/"type"\s*:\s*"(node|way)"/`。
- `overpass.osm.ch` 是瑞士專用站，台灣會回空資料，別加。

### 本地快取（IndexedDB `runart-maps`）

下載成功的整份 JSON 存起來（最多 12 份）。新範圍被某份涵蓋就直接用；多份涵蓋時挑面積最小的。
**30 天過期**：過期的有網路就重新下載，全部伺服器都失敗時才退回用舊的。

### Service Worker（sw.js）

- Pyodide（網址帶版本號，內容不變）：先讀快取。第二次進站引擎不必再下載，離線也能啟動。
  CDN 檔案用 CORS 模式抓——Worker 的 `importScripts` 是 no-cors 請求，原樣轉發會拿到不透明回應存不了。
- 本站檔案：先連網、失敗才用快取，所以改版後一定拿到新版。
- 圖磚、Overpass、Nominatim、Open-Meteo 完全不經手。

### 底圖（js/theme.js 的 `TILE_PROVIDERS`）

CARTO 從 2026-09 起點陣圖磚必須帶 key，沒帶就回 403 並印滿「API KEY REQUIRED」。
到 https://carto.com/basemaps/apikey 免費申請、網站限制設 `justin121710.github.io`，
填進 `CARTO_KEY` 即可用回 dark_all／light_all。沒填或驗證失敗（`probeTiles()`）會自動改用
OpenStreetMap 官方圖磚（深色模式用濾鏡反轉）。匯出圖片走同一個來源；OSM 沒有 @2x，
`tilePlan()` 會改抓下一級縮放補清晰度。地圖右下角與匯出圖片底邊都會標出圖資版權。

### 其他外部服務（都有 CORS，失敗都不影響主流程）

- **Nominatim**：反向地理編碼（匯出圖的地名）與地點搜尋。所有請求排同一個佇列、間隔 ≥ 1.1 秒
  （使用政策每秒最多 1 次；也禁止邊打邊查，所以搜尋只在按下 Enter 時查）。
- **Open-Meteo Elevation**：查高程算爬升／下降，一次最多 100 點，**依距離等距**取樣。
  爬升用 3m 遲滯門檻累計，避免 DEM 雜訊灌水。GPX 的 `<ele>` 也從這裡內插。

### 作品保存與分享

- 範圍、筆畫、起訖點存在 `localStorage.runart_session`（經過 `store` 包裝，被封鎖時不會讓整頁掛掉）。
  下次進站（同意聲明之後）詢問要不要還原。
- 分享連結把同樣的資料編進網址 `#v1;b=…;a=…;z=…;s=…`（筆畫用 Google encoded polyline），
  不經過任何伺服器。開啟時自動載入範圍、放回筆畫，再由使用者按生成。

---

## 六、部署

這個 repo 推到 `main` 約一分鐘後 https://justin121710.github.io/running-art/ 會更新。
**必須有 `.nojekyll`**，否則 GitHub Pages 不會輸出 `gpsart/*.py`。

⚠️ 不要短時間連推多個 commit——GitHub Pages 一次只允許一個部署。驗證是否真的更新：
比對 `raw.githubusercontent.com/.../main/index.html` 與線上版，兩者不一致就是部署卡住。

---

## 七、配色與介面

配色（`--rt-*` 變數）、跑者小人、方向箭頭、高程折線圖、匯出版面、
深淺主題與 i18n 的細節都在 **`UI_DESIGN.md`**。

一句話版本：**顏色只定義在 CSS 的 `--rt-*`，JS 透過 `PC()` 讀出來用。**
Leaflet 圖層和 divIcon 的顏色是建立當下寫死的，所以 `setTheme()` 尾端要手動重染。
匯出圖片與對話框預覽共用 `renderScene()`，只差縮放係數，改版面只要改一個地方。
