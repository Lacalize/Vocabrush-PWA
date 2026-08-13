const CACHE_NAME = 'vocabbrush-v2'; // 版本升級，強制淘汰舊版有 clone 錯誤的 Service Worker
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
  // Cloud Functions / Firestore 的請求不快取，避免把即時資料誤存成靜態快取
  if (event.request.url.includes('cloudfunctions.net') || event.request.url.includes('.run.app') || event.request.url.includes('firestore.googleapis.com')) return;

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
