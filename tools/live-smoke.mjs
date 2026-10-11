/* Live smoke test: serve this repo, open it in Chromium against the REAL feeds, report what a visitor sees.
   Needs internet + a Chromium (CI installs one). Writes tests/screenshots/live-*.png. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "tests", "screenshots"); fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const f = path.join(ROOT, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8123, "127.0.0.1", r));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out after " + ms + " ms")), ms))]);
log("launching chromium");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
log("launched");
let bad = 0;
for (const [name, vp] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 800 }]]) {
  const page = await browser.newPage({ viewport: vp });
  const errors = [], failed = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push("console." + m.type() + ": " + m.text()); });
  page.on("requestfailed", r => failed.push(r.url().slice(0, 120) + " " + (r.failure() || {}).errorText));
  log(name + ": goto");
  await page.goto("http://127.0.0.1:8123/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => log("goto: " + e.message));
  for (let i = 0; i < 5; i++) { await page.waitForTimeout(5000); log(name + ": " + await withTimeout(page.evaluate(() => document.querySelector("#status").textContent), 5000, "status read").catch(e => e.message)); }
  const state = await withTimeout(page.evaluate(() => {
    const S = window.LMTApp && window.LMTApp.state; if (!S) return { error: "app did not start" };
    return {
      status: document.querySelector("#status").textContent,
      banner: document.querySelector("#banner.show") ? document.querySelector("#banner").textContent : null,
      markers: { busGps: document.querySelectorAll(".veh.bus.gps").length, busScheduled: document.querySelectorAll(".veh.bus.est").length,
        trainGps: document.querySelectorAll(".veh.train.gps").length, trainScheduled: document.querySelectorAll(".veh.train.est").length },
      routeLines: document.querySelectorAll(".leaflet-routes-pane path").length,
      counts: ["vehicles", "routes", "stops", "alerts"].map(k => k + "=" + document.querySelector("#c-" + k).textContent).join(" "),
      systems: S.systems.map(s => ({ id: s.id, feeds: Object.fromEntries(Object.entries(s.feeds).map(([k, v]) => [k, v.status + ": " + v.detail])) })),
      sampleVehicles: [...S.all.values()].slice(0, 6).map(v => ({ sys: v.sys.id, id: v.id, route: (v.sys.idx.byId.get(v.routeId) || {}).short || v.routeCode, scheduled: !!v.scheduled, lat: +v.lat.toFixed(4), lon: +v.lon.toFixed(4), head: v.headsign }))
    };
  }), 10000, "state read").catch(e => ({ error: e.message }));
  console.log("\n===== " + name + " =====\n" + JSON.stringify(state, null, 2));
  if (errors.length) console.log("page errors/warnings:\n  " + errors.join("\n  "));
  if (failed.length) console.log("failed requests:\n  " + failed.join("\n  "));
  if (!state || state.error || errors.some(e => !e.startsWith("console.warning"))) bad++;
  await withTimeout(page.screenshot({ path: path.join(SHOTS, "live-" + name + ".png"), timeout: 15000 }), 20000, "screenshot").catch(e => log(e.message));
  await page.close().catch(() => {});
}
log("done, failures=" + bad);
await withTimeout(browser.close(), 10000, "browser close").catch(() => {});
process.exit(bad ? 1 : 0);
