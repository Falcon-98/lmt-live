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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
let mode = "ok"; // "ok" | "down"
let hits = {};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const now = Date.now() / 1000;
  const send = (body, type) => { res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" }); res.end(body); };
  if (u.pathname.startsWith("/api/v1/")) {
    const ep = u.pathname.slice(8); hits[ep] = (hits[ep] || 0) + 1;
    if (mode === "down") { res.writeHead(503); return res.end("down"); }
    if (u.searchParams.get("agency") !== "LMT") { res.writeHead(400); return res.end("agency param missing"); }
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
  await page.waitForFunction(() => document.querySelectorAll(".bus").length >= 4, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  check((await page.locator(".bus").count()) === 4, "exactly 4 LMT buses on the map (stale, duplicate, train, out-of-area and 0,0 records dropped)");
  check((await page.locator(".bus span").allTextContents()).sort().join() === "CM01,CM02,CM02,CM05", "bus markers labelled with route codes resolved from code, trip id and UUID");
  check((await page.locator(".bus.stale").count()) === 1, "4-minute-old position shown faded as stale");
  check(await page.locator("#c-routes").textContent() === "2", "2 routes");
  check(await page.locator("#c-stops").textContent() === "9", "9 platform stops (parent hub excluded)");
  check((await page.locator(".leaflet-routes-pane path").count()) === 2, "CM01 route lines drawn from name-matched shapes");
  check(/Live · 4 buses/.test(await page.locator("#status").textContent()), "status line shows live count");
  check(await page.locator("#h-vehicles").getAttribute("class") === "dot ok", "vehicle feed healthy");
  check(/WP-NE-5234/.test(await page.locator("#pane-vehicles").textContent()), "buses list shows plates");
  await page.screenshot({ path: path.join(SHOTS, "desktop.png") });

  await page.locator('[data-bus="WP-NE-5234"]').click();
  await page.waitForSelector(".leaflet-popup .pop");
  const pop = await page.locator(".leaflet-popup .pop").textContent();
  check(/32 km\/h/.test(pop) && /Next stops/.test(pop) && /Borella/.test(pop), "bus popup: speed, next stops from trip updates");
  await page.screenshot({ path: path.join(SHOTS, "bus-popup.png") });

  await page.locator('[role=tab][data-pane="stops"]').click();
  await page.locator('[data-stop="104"]').click();
  await page.waitForTimeout(600);
  check((await page.locator(".leaflet-popup").count()) === 1, "only one popup open at a time");
  const sp = await page.locator(".leaflet-popup .pop").textContent();
  check(/CM02/.test(sp) && /CM01/.test(sp) && /min|Due/.test(sp), "stop popup lists live arrivals for both routes");
  await page.screenshot({ path: path.join(SHOTS, "stop-popup.png") });

  await page.locator('[role=tab][data-pane="alerts"]').click();
  const al = await page.locator("#pane-alerts").textContent();
  check(/CM01 diverted at Borella/.test(al) && /Smart Card/.test(al) && !/Expired/.test(al) && !/Coast line/.test(al), "alerts: active LMT alerts only");
  check(await page.locator("#c-alerts").textContent() === "2", "alert count 2");
  await page.screenshot({ path: path.join(SHOTS, "alerts.png") });

  await page.locator('[role=tab][data-pane="routes"]').click();
  await page.locator(`[data-toggle="${F.CM02}"]`).uncheck();
  await page.waitForTimeout(300);
  check((await page.locator(".bus").count()) === 2, "hiding CM02 removes its buses");
  await page.locator(`[data-toggle="${F.CM02}"]`).check();

  await page.locator("#q").fill("borella");
  await page.locator('[role=tab][data-pane="stops"]').click();
  await page.waitForTimeout(300);
  check((await page.locator("#pane-stops [data-stop]").count()) === 1, "search filters stops");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  check(Object.keys(hits).every(k => hits[k] > 0) && hits["realtime/vehicle-positions"] >= 1, "all endpoints requested with ?agency=LMT");
  await page.close();

  console.log("Phone, dark theme");
  const p2 = await open({ width: 390, height: 780 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await p2.page.emulateMedia({ colorScheme: "dark" });
  await p2.page.waitForFunction(() => document.querySelectorAll(".bus").length >= 4, null, { timeout: 15000 });
  await p2.page.waitForTimeout(1000);
  const overflow = await p2.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, "no horizontal overflow at phone width");
  await p2.page.screenshot({ path: path.join(SHOTS, "phone-dark.png") });
  await p2.page.close();

  console.log("Feed down (no cache)");
  mode = "down";
  const p3 = await open({ width: 1280, height: 800 }, "/?api=" + encodeURIComponent(base + "/api/v1"));
  await p3.page.evaluate(() => localStorage.clear());
  await p3.page.reload();
  await p3.page.waitForFunction(() => document.querySelector("#banner.show"), null, { timeout: 20000 });
  check((await p3.page.locator(".bus").count()) === 0, "no invented buses when the feed is down");
  check(/unavailable|error/i.test(await p3.page.locator("#pane-vehicles").textContent()), "panel explains the feed is unavailable");
  await p3.page.screenshot({ path: path.join(SHOTS, "feed-down.png") });
  await p3.page.close();
} finally {
  await browser.close(); server.close();
}
console.log(failures ? "\n" + failures + " check(s) failed" : "\nAll e2e checks passed");
process.exit(failures ? 1 : 0);
