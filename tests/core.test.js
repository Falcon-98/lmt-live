"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../assets/lmt-core.js");
const F = require("./fixtures.js");

const NOW = 1791700000;
const decode = buf => F.FeedMessage.toObject(F.FeedMessage.decode(buf), { enums: String, longs: Number, defaults: false, arrays: true });
const st = C.buildStatic(F.files, { agency: "LMT" });
const idx = C.indexStatic(st);

test("parseCsv handles quotes, commas, CRLF and BOM", () => {
  const rows = C.parseCsv("﻿a,b,c\r\n1,\"x, \"\"y\"\"\",3\r\n\r\n");
  assert.deepEqual(rows, [{ a: "1", b: 'x, "y"', c: "3" }]);
});

test("static: routes, colours, platform stops and name-matched shapes", () => {
  assert.deepEqual(st.routes.map(r => r.short), ["CM01", "CM02"]);
  assert.equal(st.routes[0].color, "#008080");
  assert.equal(st.routes[0].text, "#ffffff");
  assert.equal(idx.platforms.length, 9, "parent hub excluded from platforms");
  assert.equal(st.routeShapes[F.CM01].length, 2, "SHAPE_CM01_D0 and _D1 linked to CM01 without trips.txt");
  assert.equal(st.routeShapes[F.CM02].length, 0);
  assert.equal(st.timezone, "Asia/Colombo");
});

test("static: multi-agency zip keeps only LMT routes and in-area stops", () => {
  const multi = Object.assign({}, F.files, {
    agency: F.files.agency + "SLR,Sri Lanka Railways,http://www.railway.gov.lk,Asia/Colombo,en\n",
    routes: F.files.routes + "COAST_LINE,SLR,Coast,Coast Line (Colombo - Matara),,2,,,\n",
    stops: F.files.stops + "ST_MATARA,,Matara,5.9485,80.5353,0,\n"
  });
  const s = C.buildStatic(multi, { agency: "LMT" });
  assert.deepEqual(s.routes.map(r => r.short), ["CM01", "CM02"]);
  assert.ok(!s.stops.ST_MATARA);
});

test("resolveRoute: by UUID, by route code, by synthetic trip id", () => {
  assert.equal(C.resolveRoute(idx, F.CM01).short, "CM01");
  assert.equal(C.resolveRoute(idx, "cm02").short, "CM02");
  assert.equal(C.resolveRoute(idx, "", "LMT_CM02_1_NB-1234").short, "CM02");
  assert.equal(C.resolveRoute(idx, "COAST_LINE", "TR_25"), null);
});

test("vehicles: fresh, de-duplicated, LMT-only, in-area", () => {
  const r = C.processVehicles(decode(F.vehiclesFeed(NOW)), idx, { now: NOW, speedUnit: "kmh" });
  const ids = r.vehicles.map(v => v.id).sort();
  assert.deepEqual(ids, ["NB-1234", "NC-4455", "ND-7788", "WP-NE-5234"]);
  const cm05 = r.vehicles.find(v => v.id === "NC-4455");
  assert.equal(cm05.routeId, ""); assert.equal(cm05.routeCode, "CM05", "unscheduled LMT route kept with its code");
  const a = r.vehicles.find(v => v.id === "WP-NE-5234");
  assert.equal(a.lat.toFixed(3), "6.871", "newest duplicate wins");
  assert.equal(a.routeId, F.CM01);
  assert.equal(Math.round(a.speedKmh), 32);
  assert.equal(a.stale, false);
  const b = r.vehicles.find(v => v.id === "NB-1234");
  assert.equal(b.routeCode, "CM02");
  assert.equal(b.stale, true, "240 s old > 180 s stale threshold");
  assert.equal(b.bearing, null);
  assert.equal(r.vehicles.find(v => v.id === "ND-7788").occupancy, "FEW_SEATS_AVAILABLE");
  assert.equal(r.stats.stale, 1); assert.equal(r.stats.foreign, 1); assert.equal(r.stats.outside, 1);
  assert.equal(r.stats.invalid, 1); assert.equal(r.stats.duplicate, 1);
});

test("vehicles: speed unit m/s converts to km/h", () => {
  const r = C.processVehicles(decode(F.vehiclesFeed(NOW)), idx, { now: NOW, speedUnit: "ms" });
  assert.equal(Math.round(r.vehicles.find(v => v.id === "ND-7788").speedKmh), 65);
});

test("vehicles: without static data, keeps in-area vehicles and guesses the route code", () => {
  const r = C.processVehicles(decode(F.vehiclesFeed(NOW)), C.indexStatic({}), { now: NOW });
  const v = r.vehicles.find(x => x.id === "WP-NE-5234");
  assert.equal(v.routeCode, "CM01");
  assert.ok(!r.vehicles.find(x => x.id === "CP-1234"));
});

test("vehicles: JSON list fallback maps to the same records", () => {
  const list = [{ trip_id: "LMT_CM01_0_WP-NE-5234", route_id: "CM01", vehicle_id: "WP-NE-5234", latitude: 6.87, longitude: 79.89, speed: 25, bearing: 90,
    timestamp: new Date((NOW - 30) * 1000).toISOString(), updated_at: new Date((NOW - 30) * 1000).toISOString() }];
  const r = C.processVehicles(C.jsonListToFeed(list), idx, { now: NOW });
  assert.equal(r.vehicles.length, 1);
  assert.equal(r.vehicles[0].routeId, F.CM01);
  assert.equal(r.vehicles[0].ts, NOW - 30);
});

test("millisecond timestamps are normalised to seconds", () => {
  assert.equal(C.toSeconds(1791700000123), 1791700000);
  assert.equal(C.toSeconds(1791700000), 1791700000);
  assert.equal(C.toSeconds(0), null);
});

test("trip updates: indexed by stop and vehicle, past and foreign dropped", () => {
  const tu = C.processTripUpdates(decode(F.tripUpdatesFeed(NOW)), idx, { now: NOW });
  assert.equal(tu.count, 2);
  assert.ok(!tu.byStop.has("102"), "passed stop dropped");
  assert.deepEqual(tu.byStop.get("104").map(x => x.routeCode), ["CM02", "CM01"], "sorted by time");
  assert.equal(tu.byStop.get("203")[0].skipped, true);
  assert.ok(!tu.byStop.has("ST_FORT"));
  assert.equal(tu.byVehicle.get("WP-NE-5234").length, 2);
});

test("alerts: active, LMT-relevant, English preferred", () => {
  const al = C.processAlerts(decode(F.alertsFeed(NOW)), idx, { now: NOW, agency: "LMT", languages: ["en"] });
  assert.deepEqual(al.map(a => a.header), ["CM01 diverted at Borella", "New Smart Card top-up points"]);
  assert.equal(al[0].effect, "Detour"); assert.equal(al[0].cause, "Construction"); assert.equal(al[0].severity, "bad");
  assert.equal(al[0].routes[0].short, "CM01");
  const si = C.processAlerts(decode(F.alertsFeed(NOW)), idx, { now: NOW, languages: ["si", "en"] });
  assert.equal(si[0].header, "සංවර්ධන කටයුතු");
});

test("decoder tolerates feeds missing fields that GTFS-RT marks required", () => {
  const buf = F.FeedMessage.encode(F.FeedMessage.fromObject({ entity: [{ vehicle: { position: { latitude: 6.9 } } }] })).finish();
  const r = C.processVehicles(decode(buf), idx, { now: NOW });
  assert.equal(r.vehicles.length, 0); assert.equal(r.stats.invalid, 1);
});
