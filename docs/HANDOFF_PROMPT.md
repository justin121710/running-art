# 給下一個對話的接手提示

把下面整段（分隔線之間）貼到新對話即可。（2026-07-24 更新，含本次任務）

---

我有一個叫 **Running Art** 的專案：在地圖上手繪圖案，程式把它對齊到真實道路，
產生一條可以實際去跑的路線並輸出 GPX／分享圖片（跑步軌跡畫圖）。

## 這次的任務

**連接段不是最短路徑**：「起點→路線」與「路線→終點」的連接線，實測明顯繞路。
回終點那段已在上一輪改成純最短（FEATURES 3.9，×1000 罰則已移除），但問題仍在。

上一輪留下的診斷線索（先驗證再改）：`gpsart/routing.py` 的 Phase 2（約 2121～2195 行）
連接段是在 `G_routing` 上用 `weight='routing_weight'` 找路——`routing_weight` 初始化為
length，但**沿藍線的邊會被打 0.7 折**（Pre-discount 吸引）、走過的連接段再打 0.7 折
（Bundling）。折扣後便宜 ≠ 實際距離短，所以連接段會為了貼藍線／貼舊連接段而多走
真實距離。使用者的規則（2026-07-24 已定案）：**連接段一律純最短路徑
（`weight='length'`），與原路線重疊沒關係。**

驗收方式比照 FEATURES 3.9：在真實路網（台北中山區，快取裡可能已有）量測改前/改後
連接段長度，並附畫面截圖。這是 `gpsart/` 演算法改動——跑 compare、確認是預期差異、
更新 baseline、同步三份、升 VERSION、部署，一套流程照規矩走。

**請先讀這兩份文件，再開始工作：**

- `C:\Users\justi\OneDrive\桌面\RUNNING_ART\docs\ARCHITECTURE.md` — 程式結構、參數、已知的坑
- `C:\Users\justi\OneDrive\桌面\RUNNING_ART\docs\FEATURES.md` — 功能與解決過的路線品質問題（3.1～3.9 每項都有實測數據）

## 現況

- 專案根目錄：`C:\Users\justi\OneDrive\桌面\RUNNING_ART`
- 線上版（已部署、可用）：https://justin121710.github.io/running-art/
- GitHub：https://github.com/justin121710/running-art（`deploy/` 自己是 git repo）
- **只維護瀏覽器版**：`deploy/index.html` + `engine.js` + `gpsart/*.py`（Pyodide 跑 Python，免伺服器）。
  桌面版 `GPS_ART_vFINAL.py` 已停止維護，不要花時間在它身上。
- 穩定版還原點：git tag `stable-20260724`（已推上 GitHub）＋ `backups/stable-20260724/`

## 已完成的主要功能（瀏覽器版）

- 框選「載入地圖範圍」（並行競速 6 台 Overpass 鏡像＋IndexedDB 快取，涵蓋範圍可離線重用）
- 手繪→生成路線（走廊尋路＋六道清理，詳見 FEATURES 3.x）、生成後鎖定（修改圖案／重新繪製解鎖）
- 微調路徑（刪節點自動繞道、復原；轉彎節點橘色突顯）、反轉方向
- 結果面板：距離／吻合度／預估時間／爬升下降（Open-Meteo）、路線預覽拉桿（跑者小人：靜止站立、移動舉手）
- 匯出圖片：1:1／4:5／9:16、圖層可選（路線/箭頭/紅線/起訖點）、📍地點（Nominatim）、比例尺、深淺色跟主題
- 深／淺色主題（右上角切換，含底圖與匯出）、中／英文切換（EN／中，含匯出）
- 引導提示會貼在當前步驟的按鈕旁；桌面版（≥900px）左側工具列＋右下浮空結果卡

## ⚠️ 最重要的規矩

**動 `gpsart/` 裡的演算法後，一定要跑基準測試：**

```bash
cd "C:\Users\justi\OneDrive\桌面\RUNNING_ART"
python selftest_algorithms.py compare
```

必須輸出「行為未改變」（30 項）。刻意改變行為時，確認新結果正確再
`python selftest_algorithms.py baseline` 更新基準。
加新指標時要自問：「這個輸入真的會觸發我想守護的那段邏輯嗎？」
（advanced_shortcut 曾是餵最短路徑的空測試，閉合圖形崩塌因此裸奔很久。）

## 工作流程（使用者已授權，照做不用再問）

1. 改 `gpsart/` → 跑 compare →（刻意改變才 baseline）→ 同步三份：
   `gpsart/`、`web_prototype/gpsart/`、`deploy/gpsart/` → 升 `engine.js` 的 `VERSION`
2. 改 `engine.js` 或 `index.html` → 同步到 `web_prototype/`（engine.js 同名、index.html→ui_prototype.html），
   並升 `index.html` 裡 `<script src="engine.js?v=…">` 的版本參數
3. **每次改完自動部署**：`cd deploy && git add -A && git commit && git push`，
   然後 curl 輪詢線上版確認更新（約 30 秒）。不需要問使用者。
4. 本機測試：`python -m http.server 8766 --directory deploy`（launch.json 有 running-art-deploy）

## 技術要點（詳見 ARCHITECTURE.md）

- 每次生成必須 `Gw = G.copy()`（route_in_corridor 會永久污染權重）
- Overpass 回應驗證要容許空白：`/"type"\s*:\s*"(node|way)"/`（冒號後有空格！曾因此全掛）
- `overpass.osm.ch` 是瑞士專用站，台灣回空資料，別加回鏡像清單
- Nominatim 快取 key 要含語言；箭頭角度要先 `map.project()` 再 `atan2`（Mercator 拉伸）
- 拉桿等原生控制項靠 CSS `color-scheme` 跟主題，不是跟 `.light` class
- deploy/ 必須保留 `.nojekyll`

## 待辦與已知問題

- **[追蹤中] 切西瓜與連接線**：回終點×1000 罰則已移除（FEATURES 3.9，實測省 27~52%）。
  使用者若再回報斜穿街區或連接線缺漏，要拿實際截圖對症（可能是 OSM 資料或另一種成因）。
- PWA 化（加到主畫面、離線）
- 路口節點合併停用中（`CONSOLIDATE_TOLERANCE_M = 0`，重啟前要先稽核節點編號一致性）
- `CORRIDOR_SAMPLE_STEP_M` 40→60 可再減橫跳，但未確認對尖角圖案的影響
- Overpass 全忙時仍會失敗（已有競速＋快取＋乾淨錯誤訊息；終極解是自架代理，使用者傾向免費方案）

## 我的偏好

- 請用**繁體中文**回答
- 改動前先說明你要做什麼；**大改動請先跟我討論並提出選項、問我問題**
- 重視實測數據，不要只說「應該可以」；UI 改動要附截圖驗證
- 發現我原本的想法有問題時直接說

---
