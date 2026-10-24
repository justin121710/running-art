/*
 * Running Art — Service Worker（離線與重複造訪加速）
 *
 * · Pyodide（約 10MB，網址帶版本號、內容不會變）：先讀快取，沒有才下載。
 *   第二次進站引擎幾乎是瞬間載入，也能在離線時啟動。
 * · 本站自己的檔案（index.html、*.js、gpsart/*.py、圖示）：先連網拿最新的，
 *   連不上才用快取。所以改版後使用者一定拿到新版，不會被舊快取卡住。
 * · 其他外部服務（圖磚、Overpass、Nominatim、Open-Meteo）完全不經手，
 *   照它們自己的快取規則走（OSM 圖磚的使用政策也要求不要另外囤積）。
 */
const VERSION = '5bab29ff5c';
const APP_CACHE = 'runart-app-' + VERSION;
const CDN_CACHE = 'runart-cdn-v1';
const CDN_PREFIXES = ['https://cdn.jsdelivr.net/pyodide/v0.26.4/'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k.startsWith('runart-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  if (CDN_PREFIXES.some(p => url.startsWith(p))) {
    ev.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      /* 用 CORS 模式去抓：Worker 的 importScripts 是 no-cors 請求，原樣轉發會拿到
         「不透明」回應（status 0），沒辦法判斷成功與否、也不該存。jsDelivr 有回 CORS 標頭，
         改成 cors 之後回應可以檢查、可以快取，給 no-cors 的請求用也沒問題。 */
      const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (new URL(url).origin === self.location.origin) {
    ev.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw e;
      }
    })());
  }
});
