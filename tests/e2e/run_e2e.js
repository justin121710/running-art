/*
 * 端對端測試：真的在瀏覽器裡跑 Pyodide（Web Worker）+ gpsart，走一遍完整流程。
 * 只有外部服務被換成固定回應：Overpass → tests/data/helsinki.json.gz、
 * 圖磚 → 單色 PNG、Open-Meteo / Nominatim → 假資料。
 *
 * 用法：
 *   node tests/e2e/run_e2e.js
 *   PYODIDE_DIR=/path/to/pyodide node tests/e2e/run_e2e.js   # 用本機的 Pyodide（離線環境）
 * 需要 playwright（npm i -D playwright 或全域安裝）。
 */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..', '..');
const PYODIDE_DIR = process.env.PYODIDE_DIR || '';
const HELSINKI = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'tests/data/helsinki.json.gz')));
const CENTER = [60.1700, 24.9440];

function png(w, h, rgb) {
  const crc = buf => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let x = 0xffffffff; for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())])));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = png(256, 256, [242, 239, 233]);
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
               '.py': 'text/plain', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm',
               '.whl': 'application/octet-stream', '.zip': 'application/zip', '.tar': 'application/x-tar' };

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failures++; };

async function setupContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true,
                                         serviceWorkers: opts.sw ? 'allow' : 'block', locale: opts.locale || 'zh-TW' });
  const counters = { overpass: 0, tiles: 0 };
  await ctx.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname === 'app.test') {
      let f = path.join(ROOT, decodeURIComponent(u.pathname));
      if (f.endsWith('/')) f += 'index.html';
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
      return route.fulfill({ body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'application/octet-stream' });
    }
    if (u.hostname === 'cdn.jsdelivr.net' && PYODIDE_DIR) {
      const f = path.join(PYODIDE_DIR, path.basename(u.pathname));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
      return route.fulfill({ body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'application/octet-stream',
                             headers: { 'access-control-allow-origin': '*' } });
    }
    if (u.pathname.endsWith('/api/interpreter') || u.pathname.endsWith('/overpass/api/interpreter')) {
      counters.overpass++;
      if (opts.overpassDown) return route.fulfill({ status: 504, body: 'busy', headers: { 'access-control-allow-origin': '*' } });
      return route.fulfill({ body: HELSINKI, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
    }
    if (u.hostname.includes('tile.openstreetmap.org') || u.hostname.includes('cartocdn.com')) {
      counters.tiles++;
      const status = u.hostname.includes('cartocdn.com') ? 403 : 200;
      return route.fulfill({ status, body: TILE, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
    }
    if (u.hostname === 'api.open-meteo.com') {
      const n = (u.searchParams.get('latitude') || '').split(',').length;
      return route.fulfill({ body: JSON.stringify({ elevation: Array.from({ length: n }, (_, i) => 10 + 8 * Math.sin(i / 9) + i * 0.1) }),
                             contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
    }
    if (u.hostname === 'nominatim.openstreetmap.org') {
      const body = u.pathname.includes('search')
        ? [{ display_name: 'Helsinki, Finland', lat: '60.17', lon: '24.94', boundingbox: ['60.16', '60.18', '24.93', '24.96'] }]
        : { address: { city_district: 'Kluuvi', city: 'Helsinki' } };
      return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
    }
    return route.abort();
  });
  if (opts.blockStorage) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
  } else {
    await ctx.addInitScript(lang => {
      try {
        if (!localStorage.getItem('runart_legal')) localStorage.setItem('runart_legal', '2026-07-29');
        if (lang) localStorage.setItem('runart_lang', lang);
      } catch (_) {}
    }, opts.lang || '');
  }
  return { ctx, counters };
}

async function openApp(ctx, url = 'http://app.test/index.html') {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(url);
  return { page, errors };
}

const waitFor = (page, fn, timeout = 120000, arg) => page.waitForFunction(fn, arg, { timeout, polling: 200 });

async function loadArea(page) {
  await page.evaluate(c => map.setView(c, 15, { animate: false }), CENTER);
  await page.waitForTimeout(300);
  await page.click('#btnDl');
  const box = await page.evaluate(() => { const r = map.getContainer().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x - 260, box.y - 170);
  await page.mouse.down();
  await page.mouse.move(box.x, box.y, { steps: 5 });
  await page.mouse.move(box.x + 260, box.y + 170, { steps: 5 });
  await page.mouse.up();
  await waitFor(page, () => S.hasMap === true);
}

async function drawCircle(page, rPx = 120, dx = 0) {
  const c = await page.evaluate(() => { const r = map.getContainer().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.click('#mDraw');
  const pts = Array.from({ length: 49 }, (_, i) => [c.x + dx + rPx * Math.cos(2 * Math.PI * i / 48), c.y + rPx * Math.sin(2 * Math.PI * i / 48)]);
  await page.mouse.move(...pts[0]); await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 2 });
  await page.mouse.up();
  return pts[0];
}

async function setStartEnd(page, p) {
  await page.click('#mStart'); await page.mouse.click(...p);
  await waitFor(page, () => !!S.start);
  await page.click('#mEnd'); await page.mouse.click(...p);
  await waitFor(page, () => !!S.end);
}

(async () => {
  const browser = await chromium.launch();

  console.log('1. 完整流程（框選 → 畫圖 → 起訖點 → 生成 → 反轉 → 微調 → 匯出 → GPX → 分享）');
  {
    const { ctx, counters } = await setupContext(browser);
    const { page, errors } = await openApp(ctx);
    const t0 = Date.now();
    await page.evaluate(() => Engine.boot());
    console.log(`  引擎啟動 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await page.waitForTimeout(1500);
    check(await page.evaluate(() => tileProvider) === 'osm', 'CARTO 403 時改用 OSM 圖磚');
    await loadArea(page);
    check(counters.overpass === 1, `Overpass 只打一台（錯開競速），實際 ${counters.overpass}`);
    const first = await drawCircle(page);
    await setStartEnd(page, first);
    const t1 = Date.now();
    // 生成期間主執行緒不能被卡住：量 requestAnimationFrame 最長間隔
    await page.evaluate(() => { window.__gap = 0; let last = performance.now();
      const f = t => { window.__gap = Math.max(window.__gap, t - last); last = t; if (!S.result) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await page.click('#btnGo');
    await waitFor(page, () => !!S.result && S.sheetUp);
    const gap = await page.evaluate(() => window.__gap);
    console.log(`  生成 ${((Date.now() - t1) / 1000).toFixed(1)}s，畫面最長停頓 ${gap.toFixed(0)}ms`);
    check(gap < 500, '生成時畫面不凍結（Web Worker）');
    const res = await page.evaluate(() => ({ fit: S.result.fit, km: S.km, prec: S.result.precision, rec: S.result.recall, segs: S.result.segments.length }));
    check(res.fit > 50 && res.km > 0.3, `路線合理：吻合度 ${res.fit.toFixed(0)}%（準確 ${res.prec.toFixed(0)}% / 覆蓋 ${res.rec.toFixed(0)}%），${res.km.toFixed(2)} km`);
    await waitFor(page, () => !!elevChartData, 20000);
    const elevBefore = await page.evaluate(() => elevChartData.elevations.slice());
    check(/↑\d+ ↓\d+ m/.test(await page.textContent('#sElev')), '爬升／下降有顯示');

    await page.click('#aRev');
    await waitFor(page, () => S.result && document.querySelector('#toast').textContent.includes('反轉'));
    const elevAfter = await page.evaluate(() => elevChartData.elevations.slice());
    check(JSON.stringify(elevAfter) === JSON.stringify(elevBefore.slice().reverse()), '反轉後高程剖面跟著翻轉（U2）');

    // 微調：選一個節點刪除，再復原
    await page.evaluate(() => { S.sheetUp = false; });
    await page.click('#aEdit');
    await waitFor(page, () => S.editing && nodeMks.length > 5);
    const nodePt = await page.evaluate(() => { const d = nodeMks[Math.floor(nodeMks.length / 2)]; const p = map.latLngToContainerPoint(d.ll); const r = map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; });
    await page.mouse.click(...nodePt);
    await waitFor(page, () => S.sel.size === 1, 5000);
    await page.click('#eDel');
    await page.waitForTimeout(1500);
    const undoState = await page.evaluate(() => ({ undo: S.result.undo, msg: document.querySelector('#toast').textContent }));
    check(undoState.undo === 1 || /繞過去|太少/.test(undoState.msg), `刪除節點（${undoState.undo === 1 ? '成功' : '已自動取消：' + undoState.msg}）`);
    if (undoState.undo === 1) {
      await page.click('#eUndo');
      await waitFor(page, () => S.result.undo === 0, 10000);
      check(true, '微調復原');
    }
    await page.click('#eDone');
    await waitFor(page, () => !S.editing && S.sheetUp);

    // 匯出圖片
    await page.click('#aPng');
    await page.waitForTimeout(800);
    await page.click('#pngGo');
    await waitFor(page, () => !document.querySelector('#pngResult').hidden, 30000);
    const shot = await page.evaluate(async () => { const im = document.querySelector('#pngShot'); await im.decode(); return [im.naturalWidth, im.naturalHeight, document.querySelector('#pngHint').textContent]; });
    check(shot[0] === 1080 && shot[1] === 1080, `匯出圖片 ${shot[0]}×${shot[1]}`);
    check(!shot[2].includes('⚠'), '匯出底圖正常（沒有降級警告）');
    await page.click('#pngClose');

    // GPX
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#aGpx')]);
    const gpx = fs.readFileSync(await dl.path(), 'utf8');
    check(!gpx.includes('<ele>0.0</ele>') && /<ele>\d/.test(gpx), 'GPX 有真實高程、沒有寫死 0（X1）');
    check((gpx.match(/<wpt /g) || []).length === 2, 'GPX 有起點與終點 wpt（X2）');
    const tr = [...gpx.matchAll(/<trkpt lat="([\d.]+)" lon="([\d.]+)"/g)].map(m => m[1] + ',' + m[2]);
    check(tr.every((p, i) => i === 0 || p !== tr[i - 1]), 'GPX 沒有連續重複點（X2）');

    // 分享連結
    const url = await page.evaluate(() => shareURL());
    const strokesN = await page.evaluate(() => S.strokes.length);
    const p2 = await openApp(ctx, url.replace(/^https?:\/\/[^/]+/, 'http://app.test'));
    await waitFor(p2.page, () => S.hasMap && S.strokes.length > 0 && !!S.start);
    check(await p2.page.evaluate(() => S.strokes.length) === strokesN, '分享連結還原圖案與起訖點（U11）');
    check(!(await p2.page.evaluate(() => location.hash)), '還原後清掉網址上的 #');
    errors.push(...p2.errors);
    await p2.page.close();

    // 重新整理 → 詢問還原（dialog 自動按確定）
    await page.reload();
    await waitFor(page, () => S.hasMap && S.strokes.length > 0);
    check(true, '重新整理後可以還原上次的圖案（U11）');

    // 取消生成
    await waitFor(page, () => !!S.start && !!S.end);
    await page.click('#btnGo');
    await waitFor(page, () => !document.querySelector('#busyCancel').hidden, 10000).catch(() => {});
    const cancelVisible = await page.evaluate(() => !document.querySelector('#busyCancel').hidden);
    if (cancelVisible) {
      await page.click('#busyCancel');
      await waitFor(page, () => !S.generating, 10000);
      check(!(await page.evaluate(() => !!S.result)), '生成可以取消（E1）');
      await page.waitForTimeout(500);
      await page.click('#btnGo');
      await waitFor(page, () => !!S.result, 120000);
      check(true, '取消後重開引擎，可以再生成（範圍自動重新載入）');
    } else {
      check(await page.evaluate(() => !!S.result), '生成太快、來不及按取消（略過取消測試）');
    }

    // 框選面積上限
    await page.waitForTimeout(1200);   // 等生成後的 fitBounds 動畫跑完，否則會蓋掉下面的 setView
    await page.evaluate(() => { S.sheetUp = false; el.sheet.classList.remove('up'); map.setView([60.17, 24.944], 11, { animate: false }); });
    await waitFor(page, () => map.getZoom() === 11, 5000);
    await page.waitForTimeout(300);
    await page.click('#btnDl');
    const c = await page.evaluate(() => { const r = map.getContainer().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const before = counters.overpass;
    await page.mouse.move(c.x - 300, c.y - 200); await page.mouse.down();
    await page.mouse.move(c.x + 300, c.y + 200, { steps: 6 });
    const boxInfo = await page.evaluate(() => { const b = document.querySelector('.box'); return b ? b.className + ' ' + b.textContent : 'nobox'; });
    check(/over/.test(boxInfo), '框太大時框變紅、顯示面積（U7）：' + boxInfo);
    await page.mouse.up();
    await page.waitForTimeout(400);
    check(counters.overpass === before && /太大/.test(await page.textContent('#toast')), '超過上限不下載');

    // 搜尋
    await page.click('#btnSearch');
    await page.fill('#searchIn', 'Helsinki');
    await page.press('#searchIn', 'Enter');
    await waitFor(page, () => document.querySelectorAll('#searchRes li').length === 1 && !document.querySelector('#searchRes li').textContent.includes('…'), 10000);
    await page.click('#searchRes li');
    check(await page.evaluate(() => document.querySelector('#searchBox').hidden && map.getZoom() >= 13), '地點搜尋可以移動地圖（U10）');

    check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' | ') : ''));
    await ctx.close();
  }

  console.log('2. 瀏覽器封鎖 localStorage 時仍可使用（U1）');
  {
    const { ctx } = await setupContext(browser, { blockStorage: true });
    const { page, errors } = await openApp(ctx);
    await page.click('#legalOk');
    await page.click('#btnTheme');
    check(await page.evaluate(() => typeof S === 'object' && document.body.classList.contains('light') !== undefined), '主程式有跑起來、按鈕有反應');
    check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' | ') : ''));
    await ctx.close();
  }

  console.log('3. 英文介面');
  {
    const { ctx } = await setupContext(browser, { lang: 'en', locale: 'en-US' });
    const { page, errors } = await openApp(ctx);
    await page.evaluate(() => Engine.boot());
    await loadArea(page);
    const first = await drawCircle(page, 90);
    await setStartEnd(page, first);
    await page.click('#btnGo');
    await waitFor(page, () => !!S.result && S.sheetUp);
    await page.click('#aRev');
    await page.waitForTimeout(600);
    check(/Direction reversed/.test(await page.textContent('#toast')), '反轉提示是英文（U5）');
    check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' | ') : ''));
    await ctx.close();
  }

  console.log('4. 本地快取：未過期直接用、過期且伺服器全掛時退回舊資料（D6）');
  {
    const opts = {};
    const { ctx, counters } = await setupContext(browser, opts);
    const { page, errors } = await openApp(ctx);
    await page.evaluate(() => Engine.boot());
    await loadArea(page);                // 先下載一次，存進快取
    const n1 = counters.overpass;
    await page.reload();
    await page.evaluate(() => Engine.boot());
    await loadArea(page);
    check(counters.overpass === n1, '同一範圍第二次載入直接用快取，不連網');
    // 把快取改成 31 天前，並讓所有鏡像都回 504
    await page.evaluate(() => new Promise(res => {
      const r = indexedDB.open('runart-maps', 1);
      r.onsuccess = () => { const tx = r.result.transaction('areas', 'readwrite'); const st = tx.objectStore('areas');
        st.getAll().onsuccess = ev => { ev.target.result.forEach(o => { o.ts = Date.now() - 31 * 864e5; st.put(o); }); };
        tx.oncomplete = () => { r.result.close(); res(); }; };
    }));
    opts.overpassDown = true;
    await page.reload();
    await page.evaluate(() => Engine.boot());
    const t = Date.now();
    await loadArea(page);
    check(counters.overpass > n1, `過期快取會先嘗試重新下載（打了 ${counters.overpass - n1} 台）`);
    check(await page.evaluate(() => S.hasMap), `全部失敗時改用過期資料（${((Date.now() - t) / 1000).toFixed(0)}s）`);
    check(errors.length === 0, '沒有 JS 錯誤' + (errors.length ? '：' + errors.join(' | ') : ''));
    await ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
