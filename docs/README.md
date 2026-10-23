# Running Art — 文件導覽

在地圖上手繪圖案，程式把它對齊到真實道路，產生一條可以實際去跑的路線，
輸出 GPX 或分享圖片。

- **線上版**：https://justin121710.github.io/running-art/
- **原始碼**：這個 repo 本身就是網站（GitHub Pages），推到 `main` 約一分鐘後上線
- 只維護瀏覽器版；舊的桌面版 `GPS_ART_vFINAL.py` 已停止維護

---

## 該讀哪一份

| 你想做的事 | 讀這份 |
|---|---|
| 剛接手，想先搞懂全貌 | 本檔 → `ARCHITECTURE.md` |
| 改路徑演算法（`gpsart/`） | `ARCHITECTURE.md` 二～四章 ⚠️ **先看「改程式之前」那節** |
| 改顏色、圖示、匯出版面 | `UI_DESIGN.md` |
| 想知道某個怪現象是不是已知問題 | `FEATURES.md` 第三章 |
| 要開新對話接手 | `HANDOFF_PROMPT.md` |
| 這次全面檢討的問題清單與修正結果 | `Running_Art_專案檢討報告.pdf` |

---

## 三十秒版的架構

```
瀏覽器（不需要任何伺服器）
 ├─ 主執行緒
 │   ├─ Leaflet（vendor/）   地圖、手繪、圖層
 │   ├─ index.html + js/*.js  介面、分享圖匯出、GPX
 │   └─ engine.js             和 Worker 傳話
 └─ Web Worker（engine-worker.js）
     ├─ Pyodide (WASM)：numpy / networkx / shapely
     │   └─ gpsart/*.py   ← 真正的路徑演算法
     ├─ Overpass 下載（錯開競速）
     └─ IndexedDB 路網快取
```

資料流：

```
手繪筆畫 ──► Engine.generate()
                │
                ├─ 縫合 / 排序 / 閉合圖形旋轉      （prepare_strokes）
                ├─ match_stroke()   Viterbi 地圖匹配：找「最像這條線」的道路
                ├─ clean_path()     收拾小毛邊（會保護畫出來的尖角）
                ├─ 連接段           起點 → 各筆 → 終點，純最短路
                └─ bridge_node_path_gaps()   最後統一把跳點沿道路接回
                       │
                       ▼
                  SEGS（分段 + 節點編號）
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   地圖上的路線    微調（刪／拖節點）   匯出 PNG / GPX / 分享連結
```

---

## 三個一定要知道的規矩

### 1. 改了就跑測試

```bash
python -m pytest                   # 演算法行為＋真實路網品質不退步（約 15 秒）
node tests/e2e/run_e2e.js          # 端對端：真的在瀏覽器跑一次完整流程（約 3 分鐘）
```

這個專案發生過好幾次嚴重回歸（路徑覆蓋率掉到 1/3、路線連到地圖邊界外、
閉合圖形被整圈抄掉），而且好幾次是「測試測不到」。CI 每次 push 都會跑。

### 2. 改了 .js 或 gpsart/*.py 就更新版本號

```bash
python tools/stamp_versions.py
```

瀏覽器（和 Service Worker）靠網址上的 `?v=` 判斷檔案有沒有換新。
這支工具依檔案內容自動算，不用再手動改。忘了跑 CI 會紅燈。

### 3. 顏色只寫在 CSS 變數裡

所有顏色定義在 `index.html` 檔頭的 `--rt-*`，JS 用 `PC()` 讀。
不要在 JS 裡寫死色碼——曾經因此發生「地圖上箭頭是青色、匯出的圖卻是金色」。

---

## 本機開發

```bash
python -m http.server 8766
```

然後開 http://localhost:8766/index.html

部署：`git push origin main`，約一分鐘後線上版更新。

> ⚠️ 不要短時間連推多個 commit——GitHub Pages 一次只允許一個部署，
> 併發會讓其中一個卡在 in progress 把後續全擋住。每次 push 後先確認上線再做下一次。

---

## 驗證介面改動的注意事項

介面幾乎都是 Canvas 畫的，**用看的不準、要用量的**。
常用手法（對比度計算、形狀比例掃描、版面比對）整理在 `UI_DESIGN.md` 第九章。

一個容易誤判的坑：**瀏覽器窗格收合或沒在合成畫面時，CSS transition 不會前進**，
`getComputedStyle` 會卡在切換前的值，看起來像「主題切了顏色沒變」。
把 `transition` 暫時關掉再量一次就能分辨。另一個：`fitBounds` 預設會動畫，
同一段程式裡馬上量到的是動畫前的值（端對端測試就踩過）。
