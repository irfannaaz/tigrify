/* Tiger service worker: makes Tiger installable and usable offline. */
const VERSION = 'tiger-1.2.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'tools.js', 'editor.js', 'pdftools.js', 'media.js', 'manifest.json',
  'assets/logo.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'vendor/pdf-lib.min.js', 'vendor/jszip.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'vendor/ffmpeg/ffmpeg.js', 'vendor/ffmpeg/814.ffmpeg.js',
];
// The 32 MB video engine is cached the first time a video/audio tool is used, not on install.
const LAZY = /vendor\/ffmpeg\/ffmpeg-core\.(js|wasm)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tiger-') && k !== VERSION && k !== 'tiger-engine').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/__ping')) return;

  if (LAZY.test(url.pathname)) {
    // Cache first: the engine never changes within a version.
    e.respondWith(caches.open('tiger-engine').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // Everything else: serve from cache instantly, refresh it in the background.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
