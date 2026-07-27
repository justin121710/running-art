# Running Art — 文件導覽

在地圖上手繪圖案，程式把它對齊到真實道路，產生一條可以實際去跑的路線，
輸出 GPX 或分享圖片。

- **線上版**：https://justin121710.github.io/running-art/
- **原始碼**：`deploy/index.html`（介面，約 3000 行）＋ `deploy/engine.js`（引擎橋接）＋ `gpsart/*.py`（演算法）
- **桌面版 `GPS_ART_vFINAL.py` 已不再維護**（2026-07-23 起專注網頁版）

---

## 該讀哪一份

| 你想做的事 | 讀這份 |
|---|---|
| 剛接手，想先搞懂全貌 | 本檔 → `ARCHITECTURE.md` |
| 改路徑演算法（`gpsart/`） | `ARCHITECTURE.md` 二～四章 ⚠️ **動之前先看基準測試那節** |
| 改顏色、圖示、匯出版面 | `UI_DESIGN.md` |
| 想知道某個怪現象是不是已知問題 | `FEATURES.md` 第三章（12 個解過的路線品質問題） |
| 要開新對話接手 | `HANDOFF_PROMPT.md` |

---

## 三十秒版的架構

```
瀏覽器（不需要任何伺服器）
 ├─ Leaflet         地圖、手繪、圖層
 ├─ index.html      介面 + Canvas 匯出（單檔，約 3000 行）
 ├─ engine.js       橋接層 + Pyodide 膠水（Python 字串）
 └─ Pyodide (WASM)
     ├─ numpy / networkx / shapely
     └─ gpsart/*.py  ← 真正的路徑演算法，和桌面版同一份
```

資料流：

```
手繪筆畫 ──► Engine.generate()
                │
                ├─ stitch / reorder / smooth   （前處理）
                ├─ route_in_corridor()          （沿紅線的走廊裡找道路）
                ├─ 一連串清理（去尖刺、剪折返、截彎取直…）
                └─ bridge_node_path_gaps()      （最後統一把跳點沿道路接回）
                       │
                       ▼
                  SEGS（分段 + 節點編號）
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   地圖上的路線    微調（刪／拖節點）   匯出 PNG / GPX
```

---

## 三個一定要知道的規矩

### 1. 動 `gpsart/` 就要跑基準測試

```bash
python selftest_algorithms.py compare
```

這個專案發生過兩次嚴重回歸（路徑覆蓋率掉到 1/3、路線連到地圖邊界外），
測試是補回來的安全網。細節與**安全網本身的漏洞**見 `ARCHITECTURE.md` 第二章。

### 2. `gpsart/` 有三份副本，要一起同步

`gpsart/`（根目錄，測試用）、`web_prototype/gpsart/`、`deploy/gpsart/`。
改完演算法還要更新 `engine.js` 的 `VERSION`，否則瀏覽器沿用快取的舊演算法。

**同理，改了 `engine.js` 就要改 `index.html` 裡 `<script src="engine.js?v=…">` 的 `v`。**

### 3. 顏色只寫在 CSS 變數裡

所有顏色定義在 `index.html` 檔頭的 `--rt-*`，JS 用 `PC()` 讀。
不要在 JS 裡寫死色碼——曾經因此發生「地圖上箭頭是青色、匯出的圖卻是金色」。

---

## 本機開發

```bash
python -m http.server 8766 --directory deploy
```

然後開 http://localhost:8766/index.html

改完部署：

```bash
cd deploy && git add -A && git commit -m "說明" && git push
```

約一分鐘後線上版更新。**`deploy/` 自己是一個獨立的 git repo。**

> ⚠️ 不要短時間連推多個 commit——GitHub Pages 一次只允許一個部署，
> 併發會讓其中一個卡在 in progress 把後續全擋住。每次 push 後先確認上線再做下一次。
> 驗證是否真的更新：比對 `raw.githubusercontent.com/.../main/index.html`（repo 實際內容）
> 和 `justin121710.github.io/...`（Pages 服務層），兩者不一致就是部署卡住，不是快取。

---

## 驗證介面改動的注意事項

介面幾乎都是 Canvas 畫的，**用看的不準、要用量的**。
常用手法（對比度計算、形狀比例掃描、版面比對）整理在 `UI_DESIGN.md` 第九章。

一個容易誤判的坑：**瀏覽器窗格收合或沒在合成畫面時，CSS transition 不會前進**，
`getComputedStyle` 會卡在切換前的值，看起來像「主題切了顏色沒變」。
把 `transition` 暫時關掉再量一次就能分辨。
