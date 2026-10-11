/* Optional CORS proxy for LMT Live (Cloudflare Worker, free tier is plenty).
   Only needed if the browser reports "blocked or offline (network/CORS)" for the feeds.

   Deploy: Cloudflare dashboard → Workers → Create → paste this file → Deploy.
   Then open the app with  ?api=https://<your-worker>.workers.dev/api/v1
   or set window.LMT_CONFIG = { fallbackApi: "https://<your-worker>.workers.dev/api/v1" } in index.html.

   It forwards only the read-only LMT feed paths below, caches briefly, and adds CORS headers. */
const UPSTREAM = "https://api.transit.seyone.dev";
const ALLOWED = {
  "/api/v1/gtfs/download": 3600,                      // static GTFS zip
  "/api/v1/realtime/vehicle-positions": 5,
  "/api/v1/realtime/vehicle-positions/list": 5,
  "/api/v1/realtime/trip-updates": 15,
  "/api/v1/realtime/alerts": 30
};
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });
    const url = new URL(request.url);
    const ttl = ALLOWED[url.pathname];
    if (ttl === undefined) return new Response("Not found", { status: 404, headers: CORS });
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, { cf: { cacheTtl: ttl, cacheEverything: true } });
    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=" + ttl);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
