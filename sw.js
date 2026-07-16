/**
 * Service Worker —— 离线缓存应用外壳。
 * 缓存策略：
 *  - 应用外壳资源（同源 GET、HTML/CSS/JS/字体/图标/清单）：cache-first，回退网络并回填。
 *  - 其它请求：走网络（不缓存用户音频/外部资源）。
 *
 * 更新应用时把 CACHE 版本号递增即可让旧缓存失效。
 */
const CACHE = 'audio-studio-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/audio-engine.js',
  './js/waveform.js',
  './js/ui.js',
  './lib/lame.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map((u) => cache.add(u).catch(() => {}))
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不代理外部

  // 导航请求：网络优先，失败回退缓存中的 index.html（离线可用）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || caches.match(req)))
    );
    return;
  }

  // 静态资源：cache-first + 回填
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
