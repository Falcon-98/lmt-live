/* LMT Live service worker: installable app + offline shell.
   Network-first for everything so a new deploy is picked up immediately; the cache is only a fallback.
   Live feeds (api.transit.seyone.dev) are never cached. */
const CACHE = "lmt-live-shell-v1";
const SHELL = ["./", "index.html", "assets/app.css", "assets/app.js", "assets/lmt-core.js", "assets/icon.svg", "manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!cacheable) return; // feeds, tiles: straight to the network
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
});
