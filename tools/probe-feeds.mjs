/* Feed diagnostics: run where the internet is reachable (CI runs it via .github/workflows/probe-feeds.yml).
   Prints HTTP status, CORS headers and a decoded summary of every feed the app uses. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const protobuf = require("protobufjs");
const JSZip = require("jszip");
const C = require("../assets/lmt-core.js");

const API = process.env.API || "https://api.transit.seyone.dev/api/v1";
const ORIGIN = process.env.ORIGIN || "https://falcon-98.github.io";
const FM = protobuf.parse(C.GTFS_RT_PROTO, { keepCase: true }).root.lookupType("transit_realtime.FeedMessage");
const decode = b => FM.toObject(FM.decode(new Uint8Array(b)), { enums: String, longs: Number, defaults: false, arrays: true });
const now = Date.now() / 1000;

async function get(path) {
  const url = path.startsWith("http") ? path : API + path;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { Origin: ORIGIN } });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = k => r.headers.get(k);
    console.log(`\n### GET ${url}\n  status=${r.status} type=${h("content-type")} bytes=${buf.length} ms=${Date.now() - t0}` +
      `\n  access-control-allow-origin=${h("access-control-allow-origin")} vary=${h("vary")} cache-control=${h("cache-control")}`);
    return { r, buf };
  } catch (e) { console.log(`\n### GET ${url}\n  FAILED ${e.message} ${e.cause ? e.cause.code || e.cause.message : ""}`); return null; }
}
async function preflight(path) {
  try {
    const r = await fetch(API + path, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    console.log(`  OPTIONS status=${r.status} allow-origin=${r.headers.get("access-control-allow-origin")} allow-methods=${r.headers.get("access-control-allow-methods")}`);
  } catch (e) { console.log("  OPTIONS failed " + e.message); }
}
function summarizeVehicles(feed, label) {
  const ents = feed.entity || [];
  const ages = ents.map(e => e.vehicle && (C.toSeconds(e.vehicle.timestamp) || C.toSeconds(feed.header && feed.header.timestamp))).filter(Boolean).map(t => now - t);
  const bucket = { "<2m": 0, "2-15m": 0, "15m-1h": 0, "1h-1d": 0, ">1d": 0, future: 0 };
  ages.forEach(a => { if (a < -60) bucket.future++; else if (a < 120) bucket["<2m"]++; else if (a < 900) bucket["2-15m"]++; else if (a < 3600) bucket["15m-1h"]++; else if (a < 86400) bucket["1h-1d"]++; else bucket[">1d"]++; });
  const routes = {}; ents.forEach(e => { const k = (e.vehicle && e.vehicle.trip && e.vehicle.trip.route_id) || "(none)"; routes[k] = (routes[k] || 0) + 1; });
  const ids = new Set(ents.map(e => e.vehicle && e.vehicle.vehicle && (e.vehicle.vehicle.id || e.vehicle.vehicle.label)).filter(Boolean));
  console.log(`  [${label}] header=${JSON.stringify(feed.header)} entities=${ents.length} uniqueVehicleIds=${ids.size}`);
  console.log(`  age buckets: ${JSON.stringify(bucket)}`);
  console.log(`  route_id counts (top 15): ${JSON.stringify(Object.entries(routes).sort((a, b) => b[1] - a[1]).slice(0, 15))}`);
  const fresh = ents.filter(e => e.vehicle && now - (C.toSeconds(e.vehicle.timestamp) || 0) < 900).slice(0, 4);
  (fresh.length ? fresh : ents.slice(0, 3)).forEach(e => console.log("  sample: " + JSON.stringify(e).slice(0, 600)));
}

(async () => {
  console.log("now", new Date().toISOString(), "origin", ORIGIN);
  const idx = {};
  for (const a of ["LMT", "SLR"]) {
    const z = await get("/gtfs/download?agency=" + a);
    if (z && z.r.ok) {
      try {
        const zip = await JSZip.loadAsync(z.buf); const files = {};
        console.log("  files: " + Object.keys(zip.files).map(n => n + ":" + zip.files[n]._data.uncompressedSize).join(" "));
        for (const n of ["agency", "routes", "stops", "trips", "shapes", "stop_times", "calendar", "calendar_dates", "feed_info"]) { const f = zip.file(n + ".txt"); files[n] = f ? await f.async("string") : ""; }
        console.log("  routes.txt:\n" + files.routes.split("\n").slice(0, 12).map(l => "    " + l).join("\n"));
        console.log("  stops.txt head:\n" + files.stops.split("\n").slice(0, 4).map(l => "    " + l).join("\n"));
        const st = C.buildStatic(files, { agency: a, schedule: a === "SLR" });
        idx[a] = C.indexStatic(st);
        console.log(`  built: routes=${st.routes.map(r => r.short + "=" + r.id).join(", ")} platforms=${idx[a].platforms.length} shapes=${JSON.stringify(Object.fromEntries(Object.entries(st.routeShapes).map(([k, v]) => [k, v.length])))} schedTrips=${st.schedule ? st.schedule.trips.length : 0}`);
      } catch (e) { console.log("  zip error " + e.message); }
    }
  }
  await preflight("/realtime/vehicle-positions?agency=LMT");
  for (const q of ["?agency=LMT", "", "?agency=SLR"]) {
    const v = await get("/realtime/vehicle-positions" + q);
    if (v && v.r.ok) {
      try {
        const feed = decode(v.buf); summarizeVehicles(feed, "vehicles" + q);
        for (const a of ["LMT", "SLR"]) {
          if (!idx[a]) continue;
          const res = C.processVehicles(feed, idx[a], { now, area: a === "LMT" ? C.SERVICE_AREA : C.SRI_LANKA, agency: a, speedUnit: a === "LMT" ? "kmh" : "ms" });
          console.log(`  app filter as ${a}: kept=${res.vehicles.length} stats=${JSON.stringify(res.stats)}`);
          res.vehicles.slice(0, 5).forEach(x => console.log("    kept: " + JSON.stringify({ id: x.id, route: x.routeCode, trip: x.tripId, lat: x.lat, lon: x.lon, age: Math.round(now - x.ts), spd: x.speedKmh, brg: x.bearing })));
        }
      } catch (e) { console.log("  decode error " + e.message + " first bytes " + v.buf.subarray(0, 80).toString("hex") + " text=" + v.buf.subarray(0, 200).toString()); }
    }
  }
  for (const q of ["?agency=LMT", ""]) {
    const j = await get("/realtime/vehicle-positions/list" + q);
    if (j && j.r.ok) {
      const t = j.buf.toString(); console.log("  json head: " + t.slice(0, 900));
      try { const arr = JSON.parse(t); const list = Array.isArray(arr) ? arr : (arr.data || arr.items || []); console.log("  json count " + list.length + " fresh<15m " + list.filter(x => now - Date.parse(x.updated_at || x.timestamp) / 1000 < 900).length); } catch (e) { console.log("  json parse " + e.message); }
    }
  }
  for (const a of ["LMT", "SLR"]) for (const k of ["trip-updates", "alerts"]) {
    const v = await get("/realtime/" + k + "?agency=" + a);
    if (v && v.r.ok) { try { const f = decode(v.buf); console.log(`  header=${JSON.stringify(f.header)} entities=${(f.entity || []).length} sample=${JSON.stringify((f.entity || [])[0] || null).slice(0, 700)}`); } catch (e) { console.log("  decode error " + e.message); } }
  }
  await get("https://files.mobilitydatabase.org/mdb-3490/latest.zip");
  await get("https://lmt-transit-bridge-production.up.railway.app/health");
  const hb = await get("https://lmt-transit-bridge-production.up.railway.app/health"); if (hb && hb.r.ok) console.log("  " + hb.buf.toString().slice(0, 800));
})();
