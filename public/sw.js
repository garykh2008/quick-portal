// 極簡 Service Worker，僅用於啟用 PWA 安裝識別
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
