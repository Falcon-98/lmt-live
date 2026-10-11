/* Download every railway station/halt in Sri Lanka from OpenStreetMap (Overpass API)
   into data/osm-stations-lk.json. Data © OpenStreetMap contributors, ODbL. */
import fs from "node:fs";
const Q = `[out:json][timeout:180];
area["ISO3166-1"="LK"][admin_level=2]->.lk;
(
  node["railway"~"^(station|halt|stop)$"](area.lk);
  way["railway"~"^(station|halt)$"](area.lk);
  node["public_transport"="station"]["train"="yes"](area.lk);
  node["public_transport"="stop_position"]["train"="yes"](area.lk);
);
out center tags;`;
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
let json, last;
for (const u of MIRRORS) {
  try {
    const r = await fetch(u, { method: "POST", body: "data=" + encodeURIComponent(Q), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lmt-live station check (github.com/Falcon-98/lmt-live)" } });
    if (!r.ok) throw new Error(u + " HTTP " + r.status);
    json = await r.json(); console.log("ok from", u); break;
  } catch (e) { last = e; console.log("failed", e.message); }
}
if (!json) throw last;
const out = json.elements.map(e => ({
  id: e.type + "/" + e.id,
  lat: +(e.lat ?? e.center.lat).toFixed(6), lon: +(e.lon ?? e.center.lon).toFixed(6),
  name: e.tags.name || "", en: e.tags["name:en"] || "", si: e.tags["name:si"] || "", ta: e.tags["name:ta"] || "",
  alt: [e.tags.alt_name, e.tags.old_name, e.tags.official_name, e.tags.short_name].filter(Boolean).join(";"),
  kind: e.tags.railway || e.tags.public_transport || ""
})).filter(s => s.name || s.en).sort((a, b) => (a.en || a.name).localeCompare(b.en || b.name));
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/osm-stations-lk.json", JSON.stringify({ source: "OpenStreetMap via Overpass API", license: "ODbL — © OpenStreetMap contributors", fetched: new Date().toISOString(), stations: out }, null, 0) + "\n");
console.log(out.length, "stations written");
