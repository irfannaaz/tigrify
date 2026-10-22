/* Tigrify service worker: makes Tigrify installable and usable offline. */
const VERSION = 'tigrify-1.3.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'tools.js', 'editor.js', 'pdftools.js', 'media.js', 'manifest.json',
  'assets/logo.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'vendor/pdf-lib.min.js', 'vendor/jszip.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'vendor/ffmpeg/ffmpeg.js', 'vendor/ffmpeg/814.ffmpeg.js',
];
// The 32 MB video engine and the 3 MB HEIC decoder are cached the first time they're needed, not on install.
const LAZY = /vendor\/(ffmpeg\/ffmpeg-core\.(js|wasm)|heic-to\.js)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    // Also removes caches left by the app's earlier name ("tiger-…").
    .then((keys) => Promise.all(keys.filter((k) => (k.startsWith('tigrify-') && k !== VERSION && k !== 'tigrify-engine') || k.startsWith('tiger-')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/__ping')) return;

  if (LAZY.test(url.pathname)) {
    // Cache first: the engine never changes within a version.
    e.respondWith(caches.open('tigrify-engine').then(async (c) => {
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
