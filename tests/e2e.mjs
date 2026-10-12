/* End-to-end check: serves the app and fixture feeds locally, drives Chromium with Playwright.
   CDN libraries are answered from node_modules and map tiles are blanked so it runs offline.
   Usage: npm run test:e2e   (set CHROMIUM_PATH if Chromium isn't at /opt/pw-browsers) */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const F = require("./fixtures.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "tests", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
let mode = "ok"; // "ok" | "down" | "slr-no-rt" | "lmt-empty" (GPS feed online but empty, as observed live on 2026-10-11)
let hits = {};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const now = Date.now() / 1000;
  const send = (body, type) => { res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" }); res.end(body); };
  if (u.pathname.startsWith("/api/v1/")) {
    const ep = u.pathname.slice(8); hits[ep] = (hits[ep] || 0) + 1;
    if (mode === "down") { res.writeHead(503); return res.end("down"); }
    const agency = u.searchParams.get("agency");
    if (agency === "SLR") {
      if (ep === "gtfs/download") return send(await F.slrZip(now), "application/zip");
      if (mode === "slr-no-rt") { res.writeHead(404); return res.end("unknown agency"); }
      if (ep === "realtime/vehicle-positions") return send(F.slrVehiclesFeed(now), "application/x-protobuf");
      if (ep === "realtime/trip-updates") return send(F.slrTripUpdatesFeed(now), "application/x-protobuf");
      if (ep === "realtime/alerts") return send(F.slrAlertsFeed(now), "application/x-protobuf");
      res.writeHead(404); return res.end();
    }
    if (agency !== "LMT") { res.writeHead(400); return res.end("agency param missing"); }
    if (mode === "lmt-unrouted") {
      if (ep === "gtfs/download") return send(await F.staticZip(), "application/zip");
      if (ep === "realtime/vehicle-positions") return send(F.unroutedFeed(now), "application/x-protobuf");
      if (ep.startsWith("realtime/vehicle-positions/list")) return send("[]", "application/json");
      return send(F.emptyFeed(now), "application/x-protobuf");
    }
    if (mode === "lmt-empty") {
      if (ep === "gtfs/download") return send(await F.lmtScheduledZip(now), "application/zip");
      if (ep.startsWith("realtime/vehicle-positions/list")) return send("[]", "application/json");
      return send(F.emptyFeed(now), "application/x-protobuf");
    }
    if (ep === "gtfs/download") return send(await F.staticZip(), "application/zip");
    if (ep === "realtime/vehicle-positions") return send(F.vehiclesFeed(now), "application/x-protobuf");
    if (ep === "realtime/trip-updates") return send(F.tripUpdatesFeed(now), "application/x-protobuf");
    if (ep === "realtime/alerts") return send(F.alertsFeed(now), "application/x-protobuf");
    res.writeHead(404); return res.end();
  }
  const file = path.join(ROOT, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  send(fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const CDN = {
  "leaflet.min.css": "node_modules/leaflet/dist/leaflet.css", "leaflet.min.js": "node_modules/leaflet/dist/leaflet.js",
  "protobuf.min.js": "node_modules/protobufjs/dist/protobuf.min.js", "jszip.min.js": "node_modules/jszip/dist/jszip.min.js"
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
let failures = 0;
const document_defs = () => fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const check = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) failures++; };

async function open(viewport, url) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(/cdnjs\.cloudflare\.com/, r => { const f = Object.keys(CDN).find(k => r.request().url().endsWith(k)); return f ? r.fulfill({ path: path.join(ROOT, CDN[f]) }) : r.abort(); });
  await page.route(/fonts\.(googleapis|gstatic)\.com|tile\.openstreetmap\.org|mobilitydatabase\.org/, r => r.abort());
  await page.goto(base + url);
  return { page, errors };
}

try {
  console.log("Desktop, healthy feeds");
  const { page, errors } = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await page.waitForFunction(() => document.querySelectorAll(".veh.bus").length >= 4 && document.querySelectorAll(".veh.train").length >= 4, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  check((await page.locator(".veh.bus").count()) === 4, "exactly 4 LMT buses (stale, duplicate, train, out-of-area and 0,0 records dropped)");
  const tags0 = (await page.locator(".veh.bus .tag").allTextContents()).sort().join();
  check(tags0 === "CM01,CM02,CM02,CM05", "3D bus markers labelled with resolved route codes (" + tags0 + ")");
  check((await page.locator(".veh.bus svg.g").count()) === 4, "buses drawn as 3D SVG vehicles");
  check((await page.locator(".veh.bus.stale").count()) === 1, "4-minute-old bus faded as stale");
  check((await page.locator(".veh.bus.moving").count()) >= 2, "moving buses animate (bob + wheel spin)");
  check((await page.locator(".veh.train").count()) === 4, "4 trains: TR_4 GPS, TR_1 running, TR_2 (6 min late) + TR_6 waiting to depart; TR_3 (45 min away) and cancelled TR_5 hidden");
  check((await page.locator(".veh.train.gps").count()) === 1 && (await page.locator(".veh.train.est:not(.wait)").count()) === 1 && (await page.locator(".veh.train.wait").count()) === 2, "live GPS, timetable and waiting trains distinguished");
  check(/1[12]′/.test(await page.locator(".veh.train.wait .tag").allTextContents().then(t => t.join(" "))), "waiting train tag counts down to departure");
  const wb = await page.locator(".veh.train.wait").evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return Math.round(r.x) + "," + Math.round(r.y); }));
  check(new Set(wb).size === 2, "two trains waiting at Colombo Fort are fanned out, not stacked");
  check(await page.locator("#c-routes").textContent() === "3", "3 routes (2 bus + 1 rail line)");
  check(await page.locator("#c-stops").textContent() === "15", "15 stops (9 bus stops + 6 stations)");
  const nPaths = await page.locator(".leaflet-routes-pane path").count();
  check(nPaths >= 3, "2 CM01 shapes + Coast Line drawn (" + nPaths + " track pieces)");
  check(/Live · 4 buses · 1 live train \+ 1 ⏱ scheduled \+ 2 ⏳ departing/.test(await page.locator("#status").textContent()), "status line counts live, scheduled and departing");
  check(await page.locator("#h-bus").getAttribute("class") === "dot ok" && await page.locator("#h-train").getAttribute("class") === "dot ok", "bus and train feeds healthy");
  check(await page.locator("#c-alerts").textContent() === "3", "3 alerts (2 bus + 1 rail)");
  await page.screenshot({ path: path.join(SHOTS, "desktop.png") });
  if (process.env.CLOSEUP) {
    const z = await browser.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 4 });
    await z.route(/cdnjs|fonts|tile\.openstreetmap|mobilitydatabase/, r => r.abort());
    const html = await page.evaluate(() => [...document.querySelectorAll(".veh-wrap")].slice(0, 6).map(e => e.outerHTML.replace(/style="[^"]*transform[^"]*"/, "")).join(""));
    await z.setContent('<link rel="stylesheet" href="' + base + '/assets/app.css"><style>body{background:#e9ebe6;display:flex;gap:18px;padding:30px;overflow:visible}.veh-wrap{position:relative!important;width:66px;height:54px}</style>' + document_defs() + html);
    await z.waitForTimeout(400); await z.screenshot({ path: path.join(SHOTS, "closeup.png") }); await z.close();
  }

  await page.locator('[data-veh="LMT:WP-NE-5234"]').click();
  await page.waitForSelector(".leaflet-popup .pop");
  const pop = await page.locator(".leaflet-popup .pop").textContent();
  check(/32 km\/h/.test(pop) && /Next stops/.test(pop) && /Borella/.test(pop) && /Live GPS/.test(pop), "bus popup: live GPS, speed, next stops");
  check((await page.locator(".veh.sel").count()) === 1, "selected vehicle highlighted");
  await page.screenshot({ path: path.join(SHOTS, "bus-popup.png") });

  await page.locator('[data-veh="SLR:TR_1"]').click();
  await page.waitForTimeout(700);
  const tp = await page.locator(".leaflet-popup .pop").last().textContent();
  const ib = await page.locator(".veh.train.est:not(.wait)").boundingBox();
  check(ib && ib.x > 0 && ib.x + ib.width < 900 && ib.y > 58, "focused train is on screen, clear of the panel");
  check(/Timetable position/.test(tp) && /Colombo Fort → Panadura/.test(tp) && /Stops & times/.test(tp), "timetable train popup: label, headsign, stop timeline");
  check((await page.locator(".leaflet-popup .pb i").count()) === 1 && (await page.locator(".leaflet-popup .tl li").count()) >= 6, "train popup shows journey progress and every stop");
  await page.screenshot({ path: path.join(SHOTS, "train-popup.png") });

  await page.locator('[data-veh="SLR:8058"]').click();
  await page.waitForTimeout(700);
  const gp = await page.locator(".leaflet-popup .pop").last().textContent();
  check(/Live GPS/.test(gp) && /54 km\/h/.test(gp) && /Panadura → Colombo Fort/.test(gp), "live train popup: GPS, speed, headsign from timetable");

  await page.locator('[role=tab][data-pane="stops"]').click();
  await page.locator('[data-stop="SLR:ST_MORATUWA"]').click();
  await page.waitForTimeout(800);
  const board = await page.locator(".leaflet-popup .pop").last().textContent();
  check(/Moratuwa/.test(board) && /\+6 min/.test(board) && /Panadura/.test(board), "station departure board with live delay");
  const pb = await page.locator(".leaflet-popup").last().boundingBox();
  check(pb && pb.x + pb.width < 910 && pb.y > 58, "station popup fully visible beside the panel");
  await page.screenshot({ path: path.join(SHOTS, "station-board.png") });

  await page.locator('[data-stop="LMT:104"]').click();
  await page.waitForTimeout(800);
  check((await page.locator(".leaflet-popup").count()) === 1, "only one popup open at a time");
  const sp = await page.locator(".leaflet-popup .pop").textContent();
  check(/CM02/.test(sp) && /CM01/.test(sp) && /min|Due/.test(sp), "bus stop popup lists live arrivals");

  await page.locator('[role=tab][data-pane="alerts"]').click();
  const al = await page.locator("#pane-alerts").textContent();
  check(/CM01 diverted at Borella/.test(al) && /Coast Line delays/.test(al) && !/Expired/.test(al), "alerts from both systems, expired dropped");

  await page.locator('.modes [data-mode="train"]').click();
  await page.waitForTimeout(400);
  check((await page.locator(".veh.bus").count()) === 0 && (await page.locator(".veh.train").count()) === 4, "Trains filter hides buses");
  check(await page.locator("#c-alerts").textContent() === "1", "alert count follows the filter");
  await page.locator('[role=tab][data-pane="vehicles"]').click();
  await page.screenshot({ path: path.join(SHOTS, "trains-mode.png") });
  await page.locator('.modes [data-mode="all"]').click();
  await page.waitForTimeout(300);

  console.log("  — departing-soon section, route focus, favourites, keyboard");
  await page.locator('[role=tab][data-pane="vehicles"]').click();
  const pv = await page.locator("#pane-vehicles").textContent();
  check(/Departing in the next 30 min/.test(pv) && /Departs \d\d:\d\d · in \d+ min · Colombo Fort/.test(pv), "list has a 'departing in the next 30 min' section");
  await page.locator('[role=tab][data-pane="routes"]').click();
  await page.locator(`[data-route="LMT:${F.CM02}"] .t`).click();
  await page.waitForTimeout(400);
  check((await page.locator(".veh.bus").count()) === 2 && (await page.locator(".focus").count()) === 1, "tapping a route shows only its vehicles, with a clear-focus chip");
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  if (await page.locator(".focus").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
  check((await page.locator(".veh.bus").count()) === 4 && (await page.locator(".focus").count()) === 0, "Esc clears the route focus");
  await page.locator('[role=tab][data-pane="stops"]').click();
  await page.locator('[data-stop="LMT:104"]').click(); await page.waitForTimeout(700);
  await page.locator(".leaflet-popup [data-fav]").click(); await page.waitForTimeout(300);
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  check(/★ Saved/.test(await page.locator("#pane-stops").textContent()), "☆ saves a stop to the top of the Stops list");
  await page.locator("#map").click({ position: { x: 300, y: 400 } }); await page.keyboard.press("/");
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === "q"), "'/' focuses search");
  await page.keyboard.press("Escape");

  await page.locator('[role=tab][data-pane="routes"]').click();
  await page.locator(`[data-toggle="LMT:${F.CM02}"]`).uncheck();
  await page.waitForTimeout(300);
  check((await page.locator(".veh.bus").count()) === 2, "hiding CM02 removes its buses");
  await page.locator(`[data-toggle="LMT:${F.CM02}"]`).check();

  await page.locator("#q").fill("borella");
  await page.locator('[role=tab][data-pane="stops"]').click();
  await page.waitForTimeout(300);
  const hits2 = await page.locator("#pane-stops [data-stop] .t").allTextContents();
  check(hits2.length >= 1 && hits2.every(t => /Borella/.test(t)), "search filters stops (saved + matching only)");
  await page.locator("#q").fill("");

  await page.mouse.move(0, 0);
  await page.locator("#fit").click(); await page.waitForTimeout(600);
  const vis = page.locator(".veh.bus").filter({ hasNot: page.locator(".dim") });
  let box = null; for (let i = 0; i < await vis.count(); i++) { const b = await vis.nth(i).boundingBox(); if (b && b.x > 20 && b.x < 850 && b.y > 70 && b.y < 740) { box = b; break; } }
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.waitForTimeout(300);
  const scale = box ? await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); const v = el && el.closest(".veh"); return v ? getComputedStyle(v).transform : "none"; }, [box.x + box.width / 2, box.y + 12]) : "none";
  check(scale !== "none", "hover lifts and enlarges the vehicle");
  const mf = await page.evaluate(async () => { const r = await fetch("manifest.webmanifest"); return r.ok && (await r.json()).short_name; });
  check(mf === "LMT Live", "web app manifest served (installable)");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  check(Object.keys(hits).every(k => hits[k] > 0) && hits["realtime/vehicle-positions"] >= 2, "all endpoints requested for both agencies");
  await page.close();

  console.log("Phone, dark theme");
  const p2 = await open({ width: 390, height: 780 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await p2.page.emulateMedia({ colorScheme: "dark" });
  await p2.page.waitForFunction(() => document.querySelectorAll(".veh.bus").length >= 4, null, { timeout: 15000 });
  await p2.page.waitForTimeout(1000);
  check(!(await p2.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "no horizontal overflow at phone width");
  await p2.page.screenshot({ path: path.join(SHOTS, "phone-dark.png") });
  await p2.page.close();

  console.log("SLR publishes no realtime (timetable only)");
  mode = "slr-no-rt";
  const p4 = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await p4.page.waitForFunction(() => document.querySelectorAll(".veh.train").length >= 4, null, { timeout: 15000 });
  check((await p4.page.locator(".veh.train.est").count()) === 4 && (await p4.page.locator(".veh.train.gps").count()) === 0 && (await p4.page.locator(".veh.train.wait").count()) === 1, "running trains + the one leaving in 12 min, all from the timetable");
  check(await p4.page.locator("#h-train").getAttribute("class") === "dot warn", "train status shows timetable-only (amber)");
  check(!(await p4.page.locator("#banner.show").count()), "no error banner for missing train realtime");
  await p4.page.close();

  console.log("LMT GPS feed online but empty (the real situation on 2026-10-11)");
  mode = "lmt-empty";
  const p5 = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1") + "&trains=0");
  await p5.page.waitForFunction(() => document.querySelector("#banner.show") && document.querySelectorAll(".veh.bus").length >= 1, null, { timeout: 15000 });
  await p5.page.waitForTimeout(800);
  check((await p5.page.locator(".veh.bus.est").count()) === 1 && (await p5.page.locator(".veh.bus.gps").count()) === 0, "running CM01 trip shown at its ⏱ scheduled position, nothing passed off as GPS");
  check(/online but no buses are reporting/.test(await p5.page.locator("#banner").textContent()), "banner explains the GPS feed is empty");
  const st5 = await p5.page.locator("#status").textContent();
  check(/0 live buses \+ 1 ⏱ scheduled/.test(st5), "status line separates live from scheduled (" + st5 + ")");
  check(await p5.page.locator("#h-bus").getAttribute("class") === "dot warn", "bus light amber while GPS is empty");
  check(await p5.page.locator("#c-stops").textContent() === "9", "all bus stops kept although the timetable covers only CM01");
  await p5.page.locator('[data-veh^="LMT:TRIP_CM01_D0_T1"]').click();
  await p5.page.waitForTimeout(600);
  check(/Scheduled position — no live GPS/.test(await p5.page.locator(".leaflet-popup .pop").textContent()), "scheduled bus popup says it is not GPS");
  check(p5.errors.length === 0, "no page errors" + (p5.errors.length ? ": " + p5.errors.join(" | ") : ""));
  await p5.page.screenshot({ path: path.join(SHOTS, "lmt-empty.png") });
  await p5.page.close();

  console.log("Live buses without route_id (feed format of 2026-10-12)");
  mode = "lmt-unrouted";
  const p6 = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1") + "&trains=0");
  await p6.page.waitForFunction(() => document.querySelectorAll(".veh.bus.gps").length >= 3, null, { timeout: 15000 });
  await p6.page.waitForTimeout(600);
  const tags6 = (await p6.page.locator(".veh.bus .tag").allTextContents()).sort();
  check((await p6.page.locator(".veh.bus.gps").count()) === 3, "3 real GPS buses shown (45-min-old record and non-plate id dropped)");
  check(tags6.includes("CM01") && tags6.includes("LMT"), "route worked out from position (CM01), unknown shown as LMT (" + tags6.join(",") + ")");
  check((await p6.page.locator(".veh.bus.stale").count()) === 1, "20-minute-old position shown faded");
  check(!(await p6.page.locator("#banner.show").count()), "no 'GPS offline' banner when buses report");
  await p6.page.locator('[data-veh="LMT:WP-NE-6506"]').click(); await p6.page.waitForTimeout(500);
  check(/worked out from its position/.test(await p6.page.locator(".leaflet-popup .pop").textContent()), "popup explains the inferred route");
  check(p6.errors.length === 0, "no page errors" + (p6.errors.length ? ": " + p6.errors.join(" | ") : ""));
  await p6.page.screenshot({ path: path.join(SHOTS, "unrouted.png") });
  await p6.page.close();

  console.log("Feed down (no cache)");
  mode = "down";
  const p3 = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await p3.page.evaluate(() => localStorage.clear());
  await p3.page.reload();
  await p3.page.waitForFunction(() => document.querySelector("#banner.show"), null, { timeout: 20000 });
  check((await p3.page.locator(".veh").count()) === 0, "no invented vehicles when feeds are down");
  check(/unavailable|error/i.test(await p3.page.locator("#pane-vehicles").textContent()), "panel explains the feed is unavailable");
  await p3.page.screenshot({ path: path.join(SHOTS, "feed-down.png") });
  await p3.page.close();
} finally {
  await browser.close(); server.close();
}
console.log(failures ? "\n" + failures + " check(s) failed" : "\nAll e2e checks passed");
process.exit(failures ? 1 : 0);
