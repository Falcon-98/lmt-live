/* Builds real railway track geometry for every pair of consecutive SLR stations, and audits
   station positions against the actual tracks.

   The SLR feed has track shapes for only 3 of its 9 lines, so trains on the other lines were
   drawn in straight lines across the countryside. This routes every station-to-station hop
   over the OpenStreetMap rail network (© OpenStreetMap contributors, ODbL) and writes
   assets/rail-geometry.js (Google-encoded polylines, one per station pair).

   Usage: node tools/build-rail.mjs <snapshot dir>   (the data-snapshots branch: osm/rail.json, SLR/*.txt) */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../assets/lmt-core.js");
const FIX = require("../assets/station-fixes.js");

const snap = process.argv[2];
if (!snap) { console.error("usage: node tools/build-rail.mjs <snapshot dir>"); process.exit(2); }
const read = n => fs.readFileSync(path.join(snap, n), "utf8");

/* ---- graph ---- */
const osm = JSON.parse(read("osm/rail.json")).elements;
const node = new Map(); osm.forEach(e => { if (e.type === "node") node.set(e.id, [e.lat, e.lon]); });
const adj = new Map();
const link = (a, b) => { if (!node.has(a) || !node.has(b) || a === b) return; const d = C.distanceM(...node.get(a), ...node.get(b));
  (adj.get(a) || adj.set(a, []).get(a)).push([b, d]); (adj.get(b) || adj.set(b, []).get(b)).push([a, d]); };
osm.forEach(e => { if (e.type === "way") for (let i = 1; i < e.nodes.length; i++) link(e.nodes[i - 1], e.nodes[i]); });
const ids = [...adj.keys()];
// spatial grid for nearest-node lookup
const cell = (lat, lon) => Math.floor(lat * 50) + ":" + Math.floor(lon * 50);
const grid = new Map(); ids.forEach(id => { const [la, lo] = node.get(id); const k = cell(la, lo); (grid.get(k) || grid.set(k, []).get(k)).push(id); });
function nearestNode(lat, lon, maxM = 5000) {
  let best = null, bd = Infinity; const r = Math.ceil(maxM / 2200) + 1, cy = Math.floor(lat * 50), cx = Math.floor(lon * 50);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) (grid.get((cy + dy) + ":" + (cx + dx)) || []).forEach(id => {
    const d = C.distanceM(lat, lon, ...node.get(id)); if (d < bd) { bd = d; best = id; } });
  return best != null && bd <= maxM ? { id: best, d: bd } : null;
}
// Dijkstra with a binary heap, bounded by maxM
function route(a, b, maxM) {
  const dist = new Map([[a, 0]]), prev = new Map(), heap = [[0, a]];
  const push = x => { heap.push(x); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
    if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop(); if (u === b) break; if (d > (dist.get(u) ?? Infinity) || d > maxM) continue;
    for (const [v, w] of adj.get(u) || []) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); push([nd, v]); } }
  }
  if (!dist.has(b)) return null;
  const p = [b]; while (p[p.length - 1] !== a) p.push(prev.get(p[p.length - 1])); p.reverse();
  return { nodes: p, m: dist.get(b) };
}
/* ---- geometry helpers ---- */
function simplify(pts, tolM) { // Douglas–Peucker in metres (equirectangular)
  if (pts.length < 3) return pts;
  const k = Math.cos(pts[0][0] * Math.PI / 180) * 111320, toXY = p => [p[1] * k, p[0] * 110540];
  const xy = pts.map(toXY), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) { const [s, e] = stack.pop(); let md = 0, mi = -1; const [ax, ay] = xy[s], [bx, by] = xy[e], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
    for (let i = s + 1; i < e; i++) { const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L)); const d = Math.hypot(xy[i][0] - ax - t * dx, xy[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; } }
    if (md > tolM) { keep[mi] = 1; stack.push([s, mi], [mi, e]); } }
  return pts.filter((_, i) => keep[i]);
}

/* ---- stations ---- */
const stops = {};
C.parseCsv(read("SLR/stops.txt")).forEach(s => { if (/^ST_/.test(s.stop_id)) { const f = FIX[s.stop_id]; stops[s.stop_id] = { id: s.stop_id, name: s.stop_name, lat: f ? f[0] : +s.stop_lat, lon: f ? f[1] : +s.stop_lon, fixed: !!f }; } });
const byTrip = {}; C.parseCsv(read("SLR/stop_times.txt")).forEach(r => { if (stops[r.stop_id]) (byTrip[r.trip_id] = byTrip[r.trip_id] || []).push(r); });
Object.values(byTrip).forEach(rs => rs.sort((a, b) => a.stop_sequence - b.stop_sequence));
const snapOf = {}; const offTrack = [];
Object.values(stops).forEach(s => { const n = nearestNode(s.lat, s.lon, 20000); snapOf[s.id] = n; if (!n || n.d > 400) offTrack.push({ s, d: n ? Math.round(n.d) : null }); });

/* ---- route every consecutive pair ---- */
const pairs = new Map(); // "A|B" (A<B) → {m, pts}
const failed = [];
const pairKey = (a, b) => a < b ? a + "|" + b : b + "|" + a;
Object.values(byTrip).forEach(rs => rs.forEach((r, i) => {
  if (!i) return; const a = rs[i - 1].stop_id, b = r.stop_id; if (a === b) return; const k = pairKey(a, b); if (pairs.has(k) || failed.some(f => f.k === k)) return;
  const [A, B] = k.split("|"); const sa = snapOf[A], sb = snapOf[B];
  const straight = C.distanceM(stops[A].lat, stops[A].lon, stops[B].lat, stops[B].lon);
  if (!sa || !sb || sa.d > 1500 || sb.d > 1500) { failed.push({ k, why: "station not near any track" }); return; }
  const r2 = route(sa.id, sb.id, Math.max(4 * straight, straight + 30000));
  if (!r2) { failed.push({ k, why: "no track connection" }); return; }
  if (r2.m > 3 * straight + 3000) { failed.push({ k, why: "track route " + Math.round(r2.m / 1000) + " km vs " + Math.round(straight / 1000) + " km straight" }); return; }
  const pts = simplify([[stops[A].lat, stops[A].lon], ...r2.nodes.map(id => node.get(id)), [stops[B].lat, stops[B].lon]], 12);
  pairs.set(k, { m: r2.m, pts });
}));

/* ---- report ---- */
const npts = [...pairs.values()].reduce((n, p) => n + p.pts.length, 0);
console.log("OSM rail nodes:", ids.length, "| SLR stations:", Object.keys(stops).length);
console.log("Stations more than 400 m from any running track:", offTrack.length);
offTrack.sort((a, b) => (b.d ?? 1e9) - (a.d ?? 1e9)).forEach(o => console.log("  ", o.s.name.padEnd(22), o.d == null ? "no track within 20 km" : o.d + " m", o.s.fixed ? "(already corrected)" : ""));
console.log("Station pairs routed over real track:", pairs.size, "(", npts, "points after 12 m simplification ) | failed:", failed.length);
failed.forEach(f => console.log("   ✗", f.k.split("|").map(id => stops[id].name).join(" – "), "→", f.why));

/* ---- write ---- */
function enc(pts) { let out = "", pl = 0, pn = 0; const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * 1e5), b = Math.round(lo * 1e5); out += e(a - pl) + e(b - pn); pl = a; pn = b; } return out; }
const obj = {}; [...pairs.entries()].sort().forEach(([k, v]) => { obj[k] = enc(v.pts); });
fs.writeFileSync(new URL("../assets/rail-geometry.js", import.meta.url),
  "/* Railway track geometry between consecutive SLR stations: \"STOP_A|STOP_B\" (A<B) → encoded polyline (A→B).\n" +
  "   Generated by tools/build-rail.mjs from OpenStreetMap (© OpenStreetMap contributors, ODbL). */\n" +
  "(function (root) { var RAIL = " + JSON.stringify(obj).replace(/","/g, '",\n"') + ";\n" +
  "  if (typeof module === \"object\" && module.exports) module.exports = RAIL; else root.LMT_RAIL_GEOMETRY = RAIL;\n" +
  "})(typeof self !== \"undefined\" ? self : this);\n");
fs.writeFileSync(new URL("../data/rail-audit.json", import.meta.url), JSON.stringify({ generated: new Date().toISOString(),
  offTrack: offTrack.map(o => ({ id: o.s.id, name: o.s.name, metres: o.d })), routedPairs: pairs.size, failed }, null, 1) + "\n");
console.log("wrote assets/rail-geometry.js", Math.round(fs.statSync(new URL("../assets/rail-geometry.js", import.meta.url)).size / 1024), "KB");
