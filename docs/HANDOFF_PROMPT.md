# 給下一個對話的接手提示

把下面整段（分隔線之間）貼到新對話即可。（2026-10-23 更新）

---

我有一個叫 **Running Art** 的專案：在地圖上手繪圖案，程式把它對齊到真實道路，
產生一條可以實際去跑的路線並輸出 GPX／分享圖片（跑步軌跡畫圖）。

**請先讀這兩份文件，再開始工作：**

- `docs/ARCHITECTURE.md` — 程式結構、演算法、參數、已知的坑
- `docs/FEATURES.md` — 功能與解決過的路線品質問題（每項都有實測數據）

## 現況

- GitHub：https://github.com/justin121710/running-art（repo 本身就是網站，推 `main` 即部署）
- 線上版：https://justin121710.github.io/running-art/
- 只維護瀏覽器版：`index.html` + `js/*.js` + `engine.js` + `engine-worker.js` + `gpsart/*.py`
  （Pyodide 在 Web Worker 裡跑 Python，免伺服器）
- 2026-10 做過一次全面檢討與修正（見 `docs/Running_Art_專案檢討報告.pdf`）：
  演算法改成 Viterbi 地圖匹配、引擎搬進 Web Worker、加上 pytest／真實路網基準／端對端測試與 CI。

## ⚠️ 最重要的規矩

```bash
python -m pytest                  # 改 gpsart/ 一定要跑；真實路網品質不能退步
python tests/bench.py --compare   # 各圖形的詳細成績
node tests/e2e/run_e2e.js         # 端對端（Playwright，真的跑 Pyodide）
python tools/stamp_versions.py    # 改任何 .js / .py 之後
```

刻意改變演算法行為、確認變好之後：`python tests/bench.py --save` 更新基準。
加新測試時要自問：「這個輸入真的會觸發我想守護的那段邏輯嗎？」
（以前好幾次回歸都是測試根本走不到那段程式。）

## 工作流程（使用者已授權，照做不用再問）

- 改完、測試通過後**直接推到 `main`**（`git push origin main`），然後確認線上版更新（約 1 分鐘）。
- 不要短時間連推多個 commit（GitHub Pages 一次只能一個部署）。

## 技術要點（詳見 ARCHITECTURE.md）

- 路網是雙向 `MultiDiGraph`：**死路端點 degree 是 2**，判斷死路／路口用 `unique_neighbors()`
- 節點編號用 `is None` 判斷，編號 0 是合法節點
- 距離門檻一律用公尺（`LocalProj`），不要拿經緯度的「度」比大小
- 清理步驟要分得出「使用者畫的尖角」和「演算法繞出來的折返」（看離手繪線多遠）
- Overpass 回應驗證要容許空白：`/"type"\s*:\s*"(node|way)"/`；`overpass.osm.ch` 是瑞士專用站，別加
- CARTO 圖磚要 key（`CARTO_KEY`），沒有就自動用 OSM 圖磚
- Nominatim 每秒最多 1 次、禁止邊打邊查
- 必須保留 `.nojekyll`

## 待辦與已知限制

- `CARTO_KEY` 還沒填：需要使用者自己到 https://carto.com/basemaps/apikey 申請（免費），
  網站限制設 `justin121710.github.io`。沒填時用 OSM 圖磚（深色模式是濾鏡反轉）。
- 「只反轉某一圈」的方向：目前做法是照想要的方向畫（不再強制順時針）；微調模式還沒有單段反轉。
- 底圖若要完全不受第三方政策影響：改用 MapLibre + OpenFreeMap 或自架 PMTiles（匯出要重寫）。
- Overpass 全忙時仍可能失敗（已有錯開競速、快取、過期快取備援）；終極解是自架代理。

## 我的偏好

- 請用**繁體中文**回答
- 重視實測數據，不要只說「應該可以」；UI 改動要附截圖驗證
- 發現我原本的想法有問題時直接說

---
