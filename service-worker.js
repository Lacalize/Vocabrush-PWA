const CACHE_NAME = 'vocabbrush-v4';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安裝階段：快取 App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // 對應原生 ForceUpdateManager 的「立即套用新版」概念
});

// 啟用階段：清除舊版快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 攔截請求：優先使用快取，背景更新（stale-while-revalidate）
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 所有 Google API 動態請求一律不快取：Firestore、Cloud Functions、Auth 都走這幾個網域，
  // 這些是即時/驗證用資料，快取住反而會造成登入或資料同步異常
  const url = event.request.url;
  const isDynamicApi =
    url.includes('googleapis.com') ||
    url.includes('.run.app') ||
    url.includes('gstatic.com/firebasejs'); // Firebase SDK 模組本身版本固定，交給瀏覽器 HTTP 快取即可，不用 SW 介入
  if (isDynamicApi) return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    try {
      const networkRes = await fetch(event.request);
      const resClone = networkRes.clone(); // 立即複製一份，原始 response 直接回傳給瀏覽器，複製品才拿去寫快取
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
      return networkRes;
    } catch (e) {
      if (cached) return cached;
      throw e;
    }
  })());
});
