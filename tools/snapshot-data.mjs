/* Snapshot reference data for offline analysis (run by .github/workflows/data-snapshots.yml):
   - OpenStreetMap railway tracks + stations in Sri Lanka (Overpass API; © OpenStreetMap contributors, ODbL)
   - the LMT and SLR GTFS static feeds from the transit server, unzipped
   Writes everything under ./snap/. */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
fs.mkdirSync("snap/osm", { recursive: true });
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
async function overpass(q) {
  let last;
  for (const u of MIRRORS) {
    try {
      const r = await fetch(u, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lmt-live data check (github.com/Falcon-98/lmt-live)" } });
      if (!r.ok) throw new Error(u + " HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; console.log("overpass failed:", e.message); }
  }
  throw last;
}
const AREA = 'area["ISO3166-1"="LK"][admin_level=2]->.lk;';
// Running lines only (no sidings/yards/spurs), with node ids so a routable graph can be built.
const rail = await overpass(`[out:json][timeout:240];${AREA}way["railway"~"^(rail|narrow_gauge)$"]["service"!~"."](area.lk);out body;>;out skel qt;`);
fs.writeFileSync("snap/osm/rail.json", JSON.stringify(rail));
console.log("rail elements", rail.elements.length);
const busStops = await overpass(`[out:json][timeout:180];area["ISO3166-1"="LK"][admin_level=2]->.lk;node["highway"="bus_stop"](6.6,79.78,7.3,80.25);out tags;`);
fs.writeFileSync("snap/osm/bus_stops_colombo.json", JSON.stringify(busStops));
console.log("bus stops", busStops.elements.length);
for (const a of ["LMT", "SLR"]) {
  const r = await fetch("https://api.transit.seyone.dev/api/v1/gtfs/download?agency=" + a);
  if (!r.ok) { console.log(a, "HTTP", r.status); continue; }
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  fs.mkdirSync("snap/" + a, { recursive: true });
  for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) fs.writeFileSync("snap/" + a + "/" + n.split("/").pop(), await zip.files[n].async("nodebuffer"));
  console.log(a, Object.keys(zip.files).join(" "));
}
fs.writeFileSync("snap/README.md", "Reference data snapshot taken " + new Date().toISOString() + " by tools/snapshot-data.mjs.\nOSM data © OpenStreetMap contributors (ODbL). Feeds from api.transit.seyone.dev (LMT data CC-BY-4.0).\n");
