// sw.js — Sweden2026 PWA Service Worker(離線 app shell + 執行期資料/圖片快取)
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 重要:改任何前端檔案(index.html / css/* / js/* / vendor/* / manifest / │
// │ favicon)後,請同步 bump 下方 CACHE_VERSION。                             │
// │  - shell 快取名含 CACHE_VERSION → bump 後 install 會重新 precache 全部    │
// │    app shell,activate 會刪掉舊版 shell 快取,使用者下次載入即取得新版。 │
// │  - data / img 快取「不」含版本號:資料走 stale-while-revalidate 自動更新, │
// │    圖片為執行期 LRU 快取,兩者跨部署保留、無需隨版本重建。               │
// │  - 若新增/移除前端檔案,記得同步增修下方 PRECACHE_URLS 清單。            │
// └─────────────────────────────────────────────────────────────────────────┘
const CACHE_VERSION = 'v1';

const SHELL_CACHE = `sw26-shell-${CACHE_VERSION}`; // 版本化:bump 即重建
const DATA_CACHE  = 'sw26-data';                   // 穩定:SWR 自動保鮮
const IMG_CACHE   = 'sw26-img';                    // 穩定:執行期 LRU
const KEEP = new Set([SHELL_CACHE, DATA_CACHE, IMG_CACHE]);

const IMG_LIMIT = 300; // Commons 圖片快取上限,超過刪最舊(FIFO)

// App shell precache 清單。全部相對路徑(以 sw.js 所在目錄為基準),
// 本機 127.0.0.1 與 GitHub Pages 子路徑 /Sweden2026/ 皆可用。
// 涵蓋 index.html 完整 module import 鏈,含動態 import 的 mapview.js / routing.js。
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  // 站台 CSS
  './css/tokens.css',
  './css/layout.css',
  './css/map.css',
  './css/planner.css',
  // 站台 JS(app.js 靜態 import 鏈 + routedraw/routes 的動態 import 目標)
  './js/app.js',
  './js/state.js',
  './js/dom.js',
  './js/config.js',
  './js/store.js',
  './js/db.js',
  './js/mapview.js',
  './js/markers.js',
  './js/popup.js',
  './js/icons.js',
  './js/sidebar.js',
  './js/filters.js',
  './js/detail.js',
  './js/itinerary.js',
  './js/geo.js',
  './js/gmaps.js',
  './js/routes.js',
  './js/routedraw.js',
  './js/routing.js',
  './js/trash.js',
  './js/io.js',
  './js/theme.js',
  // vendor CSS
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet.markercluster/MarkerCluster.css',
  './vendor/leaflet.markercluster/MarkerCluster.Default.css',
  // vendor JS
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet.markercluster/leaflet.markercluster.js',
  './vendor/sortablejs/Sortable.min.js',
  // vendor 圖片(leaflet.css url() 參照 + marker/cluster 圖示)
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
];

// ---------- install:precache app shell(容錯,單檔失敗不整體中斷)----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐一 add(cache:'reload' 繞過 HTTP 快取取得最新檔);單檔失敗僅記 warn,不影響其餘。
    const results = await Promise.allSettled(
      PRECACHE_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' }))),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.warn('[sw] precache 失敗:', PRECACHE_URLS[i], r.reason);
    });
    await self.skipWaiting(); // 新版安裝完立即進入 waiting→activate
  })());
});

// ---------- activate:清舊版 cache + 立即接管所有 client ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      // 只清本 app 自己的舊快取(sw26- 前綴),且不在 KEEP 清單內者
      if (n.startsWith('sw26-') && !KEEP.has(n)) return caches.delete(n);
      return undefined;
    }));
    await self.clients.claim();
  })());
});

// ---------- fetch:依來源與型別分派策略 ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 只處理 GET;POST 等一律放行

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 同源:資料 → SWR;其餘 app shell → cache-first(背景更新)
  if (url.origin === self.location.origin) {
    if (isDataRequest(url)) {
      event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    } else {
      event.respondWith(cacheFirst(req, SHELL_CACHE));
    }
    return;
  }

  // 跨域:只快取 Wikimedia Commons 圖片(/w/index.php 重導端點),cache-first 執行期快取
  if (url.hostname === 'commons.wikimedia.org' && url.pathname.startsWith('/w/index.php')) {
    event.respondWith(cacheFirstImage(req, IMG_CACHE));
    return;
  }

  // 其餘跨域一律「不攔截」(直接放行,走瀏覽器預設):
  //  - 地圖 tile(basemaps.cartocdn.com、tile.openstreetmap.org)→ 遵守 tile 服務政策,不快取
  //  - OSRM 路徑規劃、Wikidata 等 API → 需即時,不快取
  // 不呼叫 respondWith 即為放行。
});

// data/manifest.json 與 data/pois/*.json(兼容根路徑與 /Sweden2026/ 子路徑)
function isDataRequest(url) {
  return url.pathname.endsWith('/data/manifest.json')
    || /\/data\/pois\/[^/]+\.json$/.test(url.pathname);
}

// cache-first + 背景更新:命中即回,並在背景重新抓取更新快取供下次使用;
// 未命中(如未 precache 的同源檔)則走網路並寫入快取;離線且無快取時對導覽請求回退 shell。
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    revalidate(cache, req); // 不 await,背景更新
    return cached;
  }
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    throw e;
  }
}

function revalidate(cache, req) {
  fetch(req).then((resp) => {
    if (resp && resp.ok) cache.put(req, resp.clone());
  }).catch(() => {});
}

// stale-while-revalidate:有快取先回(立即可用),同時背景抓網路更新快取(下次生效);
// 無快取則等網路;皆失敗回 503 JSON(讓 store.js 的 .json() 走既有失敗流程)。
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then((resp) => {
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => undefined);
  if (cached) return cached;
  const net = await network;
  return net || new Response(JSON.stringify({ error: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}

// Commons 圖片 cache-first:命中即回;未命中抓網路(含 opaque 回應)寫入並背景修剪至上限。
async function cacheFirstImage(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    // 跨域 <img> 為 no-cors → opaque(status 0);仍可快取供離線顯示。
    if (resp && (resp.ok || resp.type === 'opaque')) {
      await cache.put(req, resp.clone());
      trimCache(cacheName, IMG_LIMIT); // 不 await,背景修剪
    }
    return resp;
  } catch (e) {
    return cached || Response.error();
  }
}

// FIFO 修剪:Cache API keys() 依插入序回傳,刪最前(最舊)者直到不超過上限。
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const over = keys.length - max;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}
