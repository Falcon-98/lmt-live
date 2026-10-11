/* Station coordinate checker / fixer for the Sri Lanka Railways feed.

   The SLR stops.txt published by the feed server has stations placed tens to hundreds of km
   from where they really are (e.g. Sankathanai and Eliphant Pass sharing one coordinate ~300 km
   off). This tool matches every SLR station to OpenStreetMap (data/osm-stations-lk.json, fetched by
   the osm-stations workflow) and writes assets/station-fixes.js, which the app applies on load.

   Usage: node tools/fix-stations.mjs <dir with stops.txt + stop_times.txt>
   Matching: fuzzy name match tolerant of Sri Lankan transliteration (th/t, w/v, oo/u, doubled
   letters…), disambiguated by where the station's neighbours on the line are. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../assets/lmt-core.js");

const dir = process.argv[2];
if (!dir) { console.error("usage: node tools/fix-stations.mjs <gtfs dir>"); process.exit(2); }
const read = n => { try { return fs.readFileSync(path.join(dir, n), "utf8"); } catch (e) { return ""; } };
const osm = JSON.parse(fs.readFileSync(new URL("../data/osm-stations-lk.json", import.meta.url), "utf8")).stations;

const stops = {};
C.parseCsv(read("stops.txt")).forEach(s => { if (/^ST_/.test(s.stop_id)) stops[s.stop_id] = { id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon }; });
// Neighbours along trips (to know roughly where a station must be).
const nb = {}; const byTrip = {};
C.parseCsv(read("stop_times.txt")).forEach(r => { if (stops[r.stop_id]) (byTrip[r.trip_id] = byTrip[r.trip_id] || []).push(r); });
Object.values(byTrip).forEach(rs => { rs.sort((a, b) => a.stop_sequence - b.stop_sequence);
  rs.forEach((r, i) => { const s = (nb[r.stop_id] = nb[r.stop_id] || new Set()); if (i) s.add(rs[i - 1].stop_id); if (i < rs.length - 1) s.add(rs[i + 1].stop_id); }); });

/* ---- name similarity ---- */
const STOPWORDS = /\b(railway|station|halt|rs|r\/s|stn|train|stop|sub|platform)\b/g;
function norm(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\bjn\b|\bjct\b/g, "junction").replace(STOPWORDS, " ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}
function skel(s) {
  let x = norm(s).replace(/ /g, "");
  x = x.replace(/th/g, "t").replace(/dh/g, "d").replace(/kh/g, "k").replace(/ph/g, "p").replace(/bh/g, "b").replace(/gh/g, "g")
    .replace(/w/g, "v").replace(/oo/g, "u").replace(/ee/g, "i").replace(/aa/g, "a").replace(/ei$/, "ai").replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
  return x;
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
  return p[n];
}
function nameScore(a, b) {
  const A = skel(a), B = skel(b); if (!A || !B) return 0;
  if (A === B) return 1;
  // "Mihintale Junction" vs "Mihintale": allow a dropped trailing qualifier
  const A2 = skel(norm(a).replace(/\b(junction|town|north|south|road|pier|hospital|halt)\b/g, "")), B2 = skel(norm(b).replace(/\b(junction|town|north|south|road|pier|hospital|halt)\b/g, ""));
  const base = 1 - lev(A, B) / Math.max(A.length, B.length);
  const qual = A2 && B2 && A2 === B2 && norm(a).split(" ").length !== norm(b).split(" ").length ? 0.9 : 0;
  return Math.max(base, qual);
}
const osmNames = o => [o.en, o.name, ...String(o.alt || "").split(";")].filter(n => n && /[a-z]/i.test(n));
// Stations whose OSM name differs beyond what fuzzy matching should accept (checked by hand against neighbours).
const ALIASES = { ST_PARAKUMPURA: "Parakum Uyana", ST_ERUKKALAM_PENDU: "Erukkalampiddy", ST_FREE_TRADE_ZONE: "IPZ - Katunayake South", ST_HEENDENIYA: "Heendeniya-Pattigoda" };

/* ---- matching ---- */
const km = (a, b) => C.distanceM(a.lat, a.lon, b.lat, b.lon) / 1000;
function candidates(st) {
  const names = [st.name].concat(ALIASES[st.id] ? [ALIASES[st.id]] : []);
  return osm.map(o => ({ o, score: Math.max(...osmNames(o).flatMap(n => names.map(x => nameScore(x, n))), 0) }))
    .filter(c => c.score >= 0.72).sort((a, b) => b.score - a.score);
}
const result = {}; const cands = {};
Object.values(stops).forEach(st => { cands[st.id] = candidates(st); });
// Pass 1: anchors = a clearly best, near-exact name match.
Object.values(stops).forEach(st => {
  const c = cands[st.id];
  if (c.length && c[0].score >= 0.93 && (c.length === 1 || c[1].score < c[0].score - 0.05 || km(c[0].o, c[1].o) < 2)) result[st.id] = c[0];
});
// Pass 2..n: resolve the rest by name score and closeness to already-placed neighbours.
for (let pass = 0; pass < 4; pass++) {
  Object.values(stops).forEach(st => {
    if (result[st.id] && result[st.id].score >= 0.93) return;
    const placed = [...(nb[st.id] || [])].map(id => result[id] && result[id].o).filter(Boolean);
    let best = null;
    cands[st.id].forEach(c => {
      const d = placed.length ? Math.min(...placed.map(p => km(p, c.o))) : null;
      const fit = d == null ? 0 : d < 25 ? 0.08 : d < 60 ? 0 : -0.3; // a station is near its neighbours
      const v = c.score + fit;
      if (!best || v > best.v) best = { ...c, v, d };
    });
    if (best && best.d != null && best.d > 60) best = null; // a match far from every neighbour is a different station
    if (best && (best.score >= 0.85 || (best.score >= 0.78 && best.d != null && best.d < 25))) result[st.id] = best;
  });
}

// Final neighbour check for anchors too (e.g. two stations with near-identical names on different lines).
Object.keys(result).forEach(id => {
  const placed = [...(nb[id] || [])].map(n => result[n] && result[n].o).filter(Boolean);
  if (placed.length && Math.min(...placed.map(p => km(p, result[id].o))) > 60) delete result[id];
});

/* ---- decide fixes ---- */
const fixes = {}; const report = []; const unmatched = [];
Object.values(stops).forEach(st => {
  const m = result[st.id];
  if (!m) { unmatched.push(st); return; }
  const off = km(st, m.o);
  if (off > 0.3) { fixes[st.id] = [m.o.lat, m.o.lon]; report.push({ id: st.id, name: st.name, osm: (m.o.en || m.o.name) + " (" + m.o.id + ")", off: Math.round(off * 10) / 10, score: +m.score.toFixed(2) }); }
});

const pos = id => fixes[id] ? { lat: fixes[id][0], lon: fixes[id][1] } : stops[id];
const t = s => { const [h, m, x] = s.split(":").map(Number); return h * 3600 + m * 60 + (x || 0); };

/* ---- stations OSM doesn't know: if clearly misplaced, put them on the track between their neighbours,
   in proportion to the timetable (marked approximate) ---- */
const shapePts = {}; C.parseCsv(read("shapes.txt")).forEach(p => (shapePts[p.shape_id] = shapePts[p.shape_id] || []).push([+p.shape_pt_lat, +p.shape_pt_lon]));
const tripShape = {}; C.parseCsv(read("trips.txt")).forEach(r => { tripShape[r.trip_id] = r.shape_id; });
const approx = [];
unmatched.forEach(st => {
  const ns = [...(nb[st.id] || [])].map(pos);
  if (!ns.length) return;
  const nearest = Math.min(...ns.map(p => km(p, st)));
  // neighbours are usually 2–10 km apart; > 15 km from every neighbour means the published point is wrong
  if (nearest <= 15) return;
  for (const [tid, rs] of Object.entries(byTrip)) {
    const i = rs.findIndex(r => r.stop_id === st.id); if (i <= 0 || i >= rs.length - 1) continue;
    const a = rs[i - 1], b = rs[i + 1], A = pos(a.stop_id), B = pos(b.stop_id);
    const span = t(b.arrival_time) - t(a.departure_time); if (span <= 0) continue;
    const k = Math.min(0.95, Math.max(0.05, (t(rs[i].arrival_time) - t(a.departure_time)) / span));
    let p = [A.lat + (B.lat - A.lat) * k, A.lon + (B.lon - A.lon) * k];
    const sh = shapePts[tripShape[tid]];
    if (sh) { let bd = Infinity, bp = null; sh.forEach(q => { const d = km({ lat: p[0], lon: p[1] }, { lat: q[0], lon: q[1] }); if (d < bd) { bd = d; bp = q; } }); if (bd < 3) p = bp; }
    fixes[st.id] = [+p[0].toFixed(6), +p[1].toFixed(6)];
    approx.push({ id: st.id, name: st.name, off: Math.round(km(st, { lat: p[0], lon: p[1] }) * 10) / 10, between: stops[a.stop_id].name + " – " + stops[b.stop_id].name });
    break;
  }
});

/* ---- plausibility after fixing: implied train speed between consecutive stations ---- */
function implausible(usePos) {
  const bad = new Map();
  Object.values(byTrip).forEach(rs => rs.forEach((r, i) => {
    if (!i) return; const a = rs[i - 1]; const dt = (t(r.arrival_time) - t(a.departure_time)) / 3600; if (dt <= 0) return;
    const d = km(usePos(a.stop_id), usePos(r.stop_id)); const v = d / dt;
    if (v > 110 && d > 3) { bad.set(a.stop_id + ">" + r.stop_id, { d: Math.round(d), v: Math.round(v) }); }
  }));
  return bad;
}
const before = implausible(id => stops[id]), after = implausible(pos);

report.sort((a, b) => b.off - a.off);
console.log("SLR stations:", Object.keys(stops).length, "| OSM stations:", osm.length);
console.log("matched:", Object.keys(result).length, "| corrected (>300 m off):", report.length, "| unmatched:", unmatched.length);
console.log("\nCorrections (largest first):");
report.forEach(r => console.log(`  ${r.name.padEnd(24)} moved ${String(r.off).padStart(6)} km  ← ${r.osm}  [name ${r.score}]`));
console.log("\nNot in OSM, clearly misplaced → placed on the track between neighbours (approximate):");
approx.forEach(r => console.log(`  ${r.name.padEnd(24)} moved ${String(r.off).padStart(6)} km  ← between ${r.between}`));
const left = unmatched.filter(s => !fixes[s.id]);
console.log("\nNot in OSM, published position plausible (kept):", left.map(s => s.name).join(", ") || "none");
console.log("\nImpossible segments (>110 km/h) before:", before.size, "after:", after.size);
[...after].slice(0, 30).forEach(([k, v]) => console.log("  still:", k, JSON.stringify(v)));

const header = "/* Corrected Sri Lanka Railways station coordinates: stop_id → [lat, lon].\n" +
  "   Generated by tools/fix-stations.mjs from OpenStreetMap (© OpenStreetMap contributors, ODbL),\n" +
  "   because the published SLR stops.txt places many stations far from their real location. */\n";
fs.writeFileSync(new URL("../assets/station-fixes.js", import.meta.url), header +
  "(function (root) { var FIXES = " + JSON.stringify(fixes, null, 0).replace(/\],"/g, '],\n  "') + ";\n" +
  "  if (typeof module === \"object\" && module.exports) module.exports = FIXES; else root.LMT_STATION_FIXES = FIXES;\n" +
  "})(typeof self !== \"undefined\" ? self : this);\n");
fs.writeFileSync(new URL("../data/station-fixes-report.json", import.meta.url), JSON.stringify({ generated: new Date().toISOString(), corrected: report, approximate: approx, unmatched: left.map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })), impossibleSegmentsBefore: before.size, impossibleSegmentsAfter: after.size }, null, 1) + "\n");
