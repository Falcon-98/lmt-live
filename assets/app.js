/* ============================================================
   LMT Live — UI controller (Leaflet map + panel).
   Data rules live in lmt-core.js; this file fetches, schedules and renders.
   ============================================================ */
(function () {
  "use strict";
  const C = window.LMTCore;
  const qs = new URLSearchParams(location.search);

  /* ---------------- configuration ----------------
     Override any of these with window.LMT_CONFIG = {...} before this script,
     or from the URL: ?api=https://your-proxy.example/api/v1 */
  const CFG = Object.assign({
    api: "https://api.transit.seyone.dev/api/v1",
    // Optional second API base (e.g. your CORS proxy, see proxy/cloudflare-worker.js). Tried when the first fails.
    fallbackApi: "",
    agency: "LMT",
    // Static GTFS mirrors on the Mobility Database (feed mdb-3490), tried if the producer download fails.
    staticMirrors: [
      "https://files.mobilitydatabase.org/mdb-3490/latest.zip",
      "https://files.mobilitydatabase.org/mdb-3490/mdb-3490-202610110023/mdb-3490-202610110023.zip"
    ],
    refreshMs: { vehicles: 10000, tripUpdates: 30000, alerts: 60000 },
    maxVehicleAgeSec: 900,   // positions older than this are dropped (the feed keeps expiring records)
    staleVehicleSec: 180,    // older than this are shown faded as "last seen"
    speedUnit: "kmh",        // the LMT producer publishes km/h; set "ms" if the feed switches to the GTFS-RT standard m/s
    stopZoom: 13,
    staticCacheHours: 24,
    serviceHours: [330, 1320] // 05:30–22:00 local, used only for the "no buses" message
  }, window.LMT_CONFIG || {});
  if (qs.get("api")) CFG.api = qs.get("api").replace(/\/+$/, "");
  if (qs.get("fallbackApi")) CFG.fallbackApi = qs.get("fallbackApi").replace(/\/+$/, "");
  if (qs.get("speed") === "ms" || qs.get("speed") === "kmh") CFG.speedUnit = qs.get("speed");

  const ENDPOINTS = {
    staticGtfs: "/gtfs/download?agency=" + encodeURIComponent(CFG.agency),
    vehicles: "/realtime/vehicle-positions?agency=" + encodeURIComponent(CFG.agency),
    vehiclesJson: "/realtime/vehicle-positions/list?agency=" + encodeURIComponent(CFG.agency),
    tripUpdates: "/realtime/trip-updates?agency=" + encodeURIComponent(CFG.agency),
    alerts: "/realtime/alerts?agency=" + encodeURIComponent(CFG.agency)
  };

  /* ---------------- state ---------------- */
  const S = {
    static: null, idx: C.indexStatic({}), staticSource: "",
    vehicles: new Map(), markers: new Map(), prevPos: new Map(),
    trip: { byStop: new Map(), byVehicle: new Map(), count: 0 },
    alerts: [], hiddenRoutes: new Set(),
    routeLayers: new Map(), stopLayer: null, stopMarkers: new Map(),
    feeds: {}, FeedMessage: null, following: null, openKey: null,
    userLoc: null, userMarker: null, tab: "vehicles", query: "", lastVehicleOk: 0
  };
  try { JSON.parse(localStorage.getItem("lmt-hidden-routes") || "[]").forEach(id => S.hiddenRoutes.add(id)); } catch (e) { /* storage blocked */ }

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nowS = () => Date.now() / 1000;
  const tz = () => (S.static && S.static.timezone) || "Asia/Colombo";
  function clock(ts) {
    try { return new Intl.DateTimeFormat([], { timeZone: tz(), hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000)); }
    catch (e) { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  }
  function dist(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1) + " km"; }
  function routeOf(v) { return S.idx.byId.get(v.routeId) || null; }
  function routeColor(v) { const r = routeOf(v); return r ? r.color : "#46505a"; }
  function routeBadge(r, code) {
    if (r) return '<span class="badge" style="background:' + r.color + ";color:" + r.text + '">' + esc(r.short) + "</span>";
    return '<span class="badge" style="background:#46505a;color:#fff">' + esc(code || "?") + "</span>";
  }

  /* ---------------- map ---------------- */
  const map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: false }).setView([6.905, 79.92], 12);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.createPane("routes").style.zIndex = 410;
  map.createPane("stops").style.zIndex = 420;
  map.createPane("buses").style.zIndex = 640;
  const stopRenderer = L.canvas({ pane: "stops", padding: 0.3 });
  map.on("dragstart", () => { if (S.following) { S.following = null; toast("Stopped following bus"); } });

  /* ---------------- fetching ---------------- */
  class FeedError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
  async function fetchWithTimeout(url, ms) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctl && ctl.signal });
      if (!r.ok) throw new FeedError("HTTP " + r.status, "http");
      return r;
    } catch (e) {
      if (e instanceof FeedError) throw e;
      throw new FeedError(e && e.name === "AbortError" ? "timed out" : "blocked or offline (network/CORS)", e && e.name === "AbortError" ? "timeout" : "network");
    } finally { if (t) clearTimeout(t); }
  }
  /** Try the primary API base, then the fallback base; remember whichever works. */
  let preferredBase = CFG.api;
  async function apiFetch(path, ms) {
    const bases = [preferredBase, CFG.api, CFG.fallbackApi].filter((b, i, a) => b && a.indexOf(b) === i);
    let last;
    for (const b of bases) {
      try { const r = await fetchWithTimeout(b + path, ms); preferredBase = b; return r; } catch (e) { last = e; }
    }
    throw last;
  }
  function decode(buf) {
    if (!S.FeedMessage) throw new FeedError("protobuf decoder unavailable", "decode");
    try {
      const msg = S.FeedMessage.decode(new Uint8Array(buf));
      return S.FeedMessage.toObject(msg, { enums: String, longs: Number, defaults: false, arrays: true });
    } catch (e) { throw new FeedError("could not decode GTFS-Realtime (" + e.message + ")", "decode"); }
  }

  /* ---------------- feed health ---------------- */
  const FEED_LABEL = { static: "Schedule", vehicles: "Buses", tripUpdates: "Arrivals", alerts: "Alerts" };
  function setFeed(name, status, info) {
    S.feeds[name] = Object.assign({ status, at: nowS() }, info || {});
    const el = $("#h-" + name); if (!el) return;
    el.className = "dot " + status;
    el.title = FEED_LABEL[name] + ": " + (info && info.detail ? info.detail : status);
    renderFeedDetails();
  }
  function renderFeedDetails() {
    const rows = Object.keys(FEED_LABEL).map(k => {
      const f = S.feeds[k]; if (!f) return '<li><b class="d"></b>' + FEED_LABEL[k] + ": waiting…</li>";
      return '<li><b class="d ' + f.status + '"></b>' + FEED_LABEL[k] + ": " + esc(f.detail || f.status) + "</li>";
    });
    $("#feed-details").innerHTML = rows.join("") +
      '<li class="muted">Source: <code>' + esc(preferredBase) + "</code></li>";
  }

  /* ---------------- banner / toast ---------------- */
  function banner(kind, html) {
    const b = $("#banner");
    if (!html) { b.classList.remove("show"); b.dataset.kind = ""; return; }
    b.dataset.kind = kind; b.className = "banner show " + kind;
    b.innerHTML = html + '<button class="x" aria-label="Dismiss">✕</button>';
    b.querySelector(".x").onclick = () => b.classList.remove("show");
  }
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600); }

  /* ---------------- static GTFS ---------------- */
  const CACHE_KEY = "lmt-static-v2";
  function readCache() { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return c && c.data && c.data.routes ? c : null; } catch (e) { return null; } }
  function writeCache(data) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch (e) { /* quota or blocked */ } }

  async function downloadStatic() {
    const tries = [() => apiFetch(ENDPOINTS.staticGtfs, 45000)].concat(CFG.staticMirrors.map(u => () => fetchWithTimeout(u, 45000)));
    let last;
    for (let i = 0; i < tries.length; i++) {
      try {
        const r = await tries[i]();
        const zip = await JSZip.loadAsync(await r.arrayBuffer());
        const read = async n => { const f = zip.file(n) || zip.file(new RegExp("(^|/)" + n.replace(".", "\\.") + "$"))[0]; return f ? f.async("string") : ""; };
        const names = ["agency", "routes", "stops", "trips", "shapes", "stop_times", "feed_info"];
        const files = {}; for (const n of names) files[n] = await read(n + ".txt");
        if (!files.routes || !files.stops) throw new FeedError("zip has no routes/stops", "data");
        return { data: C.buildStatic(files, { agency: CFG.agency }), source: i === 0 ? "live" : "mirror" };
      } catch (e) { last = e; }
    }
    throw last || new FeedError("no source", "network");
  }

  function applyStatic(data, source) {
    S.static = data; S.staticSource = source; S.idx = C.indexStatic(data);
    drawRoutes(); drawStops();
    $("#c-routes").textContent = data.routes.length;
    $("#c-stops").textContent = S.idx.platforms.length;
    renderAll();
    const nShapes = Object.values(data.routeShapes).reduce((n, a) => n + a.length, 0);
    setFeed("static", source === "cache" ? "warn" : "ok", { detail: data.routes.length + " routes, " + S.idx.platforms.length + " stops, " + nShapes + " route lines (" + (source === "live" ? "live" : source === "mirror" ? "Mobility Database mirror" : "cached copy") + ")" });
  }

  async function loadStatic() {
    const cached = readCache();
    let fitted = false;
    if (cached) { applyStatic(cached.data, "cache"); fitInitial(); fitted = true; }
    const fresh = !cached || (Date.now() - cached.at) > CFG.staticCacheHours * 3600e3;
    if (!fresh && cached) { setFeed("static", "ok", { detail: S.feeds.static.detail.replace("cached copy", "cached " + C.ago((Date.now() - cached.at) / 1000)) }); }
    if (fresh || !cached) {
      try {
        const res = await downloadStatic();
        writeCache(res.data); applyStatic(res.data, res.source);
        if (!fitted) fitInitial();
      } catch (e) {
        if (cached) { setFeed("static", "warn", { detail: "using cached copy — refresh failed: " + e.message }); }
        else {
          setFeed("static", "err", { detail: e.message });
          banner("warn", "<b>Route &amp; stop data couldn't be loaded</b> (" + esc(e.message) + "). Live buses will still show, but without route names, lines or stops.");
        }
      }
    }
  }
  /** fitBounds padding that keeps content clear of the top bar and the panel (right dock or bottom sheet). */
  function fitOpts(maxZoom, pad) {
    pad = pad || 30; const panel = $("#panel").getBoundingClientRect(); const top = $(".topbar").offsetHeight;
    const phone = matchMedia("(max-width: 720px)").matches;
    return { paddingTopLeft: [pad, top + pad], paddingBottomRight: [phone ? pad : panel.width + 12 + pad, phone ? panel.height + pad : pad], maxZoom };
  }
  function fitInitial() {
    if (location.hash.length > 1) return;
    const pts = S.idx.platforms.map(s => [s.lat, s.lon]);
    Object.values(S.static.routeShapes).forEach(list => list.forEach(line => { pts.push(line[0], line[line.length - 1]); }));
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), fitOpts(14));
  }

  function drawRoutes() {
    S.routeLayers.forEach(l => map.removeLayer(l)); S.routeLayers.clear();
    S.static.routes.forEach(r => {
      const lines = S.static.routeShapes[r.id] || []; if (!lines.length) return;
      const g = L.featureGroup(lines.map(pts => L.polyline(pts, { pane: "routes", color: r.color, weight: 5, opacity: 0.8, lineJoin: "round" })));
      g.on("click", () => showRoute(r.id));
      g.bindTooltip(r.short + (r.long ? " · " + r.long : ""), { sticky: true });
      S.routeLayers.set(r.id, g);
      if (!S.hiddenRoutes.has(r.id)) g.addTo(map);
    });
  }
  function drawStops() {
    if (S.stopLayer) map.removeLayer(S.stopLayer);
    S.stopMarkers.clear();
    S.stopLayer = L.layerGroup();
    S.idx.platforms.forEach(s => {
      const m = L.circleMarker([s.lat, s.lon], { renderer: stopRenderer, radius: 5, weight: 2.5, color: "#1b1f24", fillColor: "#ffffff", fillOpacity: 1 });
      m.bindPopup(() => stopPopup(s), { maxWidth: 280, minWidth: 210 });
      m.on("popupopen", () => { S.openKey = "stop:" + s.id; setHash("stop", s.id); });
      m.on("popupclose", () => { if (S.openKey === "stop:" + s.id) { S.openKey = null; setHash(); } });
      m.bindTooltip(s.name, { direction: "top", offset: [0, -4] });
      S.stopMarkers.set(s.id, m); S.stopLayer.addLayer(m);
    });
    syncStopVisibility();
  }
  function syncStopVisibility() {
    if (!S.stopLayer) return;
    const show = map.getZoom() >= CFG.stopZoom;
    if (show && !map.hasLayer(S.stopLayer)) S.stopLayer.addTo(map);
    else if (!show && map.hasLayer(S.stopLayer)) map.removeLayer(S.stopLayer);
  }
  map.on("zoomend", syncStopVisibility);

  /* ---------------- vehicles ---------------- */
  async function loadVehicles() {
    let feed, via = "protobuf";
    try { feed = decode(await (await apiFetch(ENDPOINTS.vehicles)).arrayBuffer()); }
    catch (e) {
      // The producer also serves the same positions as JSON; use it if the protobuf feed fails.
      try { feed = C.jsonListToFeed(await (await apiFetch(ENDPOINTS.vehiclesJson)).json()); via = "json"; }
      catch (e2) { vehicleFailure(e); throw e; }
    }
    const res = C.processVehicles(feed, S.idx, { maxAgeSec: CFG.maxVehicleAgeSec, staleSec: CFG.staleVehicleSec, speedUnit: CFG.speedUnit });
    S.lastVehicleOk = nowS();
    S.vehicleStats = res.stats; S.vehicleHeaderTs = res.headerTs;
    updateVehicles(res.vehicles);
    const age = res.headerTs ? nowS() - res.headerTs : null;
    const st = res.stats;
    const parts = [res.vehicles.length + " live bus" + (res.vehicles.length === 1 ? "" : "es")];
    if (st.total) parts.push(st.total + " records in feed" + (st.stale ? ", " + st.stale + " expired" : "") + (st.foreign ? ", " + st.foreign + " other services" : "") + (st.duplicate ? ", " + st.duplicate + " duplicates" : ""));
    if (age != null) parts.push("feed generated " + C.ago(age));
    if (via === "json") parts.push("via JSON fallback");
    setFeed("vehicles", age != null && age > 300 ? "warn" : "ok", { detail: parts.join(" · ") });
    if ($("#banner").dataset.kind === "net") banner();
  }
  function vehicleFailure(e) {
    setFeed("vehicles", "err", { detail: e.message });
    if (e.kind === "network") {
      banner("net", "<b>Can't reach the live bus feed.</b> Either you're offline or the feed server isn't allowing this site to read it (CORS). " +
        "Retrying automatically. Site owners: deploy <code>proxy/cloudflare-worker.js</code> and open this page with <code>?api=&lt;worker-url&gt;/api/v1</code>.");
    } else {
      banner("net", "<b>Live bus feed error:</b> " + esc(e.message) + ". Retrying automatically.");
    }
    renderVehicles();
  }

  function updateVehicles(list) {
    const seen = new Set();
    list.forEach(v => {
      seen.add(v.id);
      const prev = S.prevPos.get(v.id);
      // Fill a missing bearing from movement since the last fix.
      if (v.bearing == null && prev) {
        if (C.distanceM(prev.lat, prev.lon, v.lat, v.lon) > 15) v.bearing = C.bearingDeg(prev.lat, prev.lon, v.lat, v.lon);
        else v.bearing = prev.bearing;
      }
      if (!prev || prev.lat !== v.lat || prev.lon !== v.lon || v.bearing != null) S.prevPos.set(v.id, { lat: v.lat, lon: v.lon, bearing: v.bearing });
      const near = C.nearestStop(S.idx, v.lat, v.lon); v.near = near;
      S.vehicles.set(v.id, v);
      upsertMarker(v);
    });
    [...S.vehicles.keys()].forEach(id => {
      if (seen.has(id)) return;
      S.vehicles.delete(id);
      const m = S.markers.get(id); if (m) { map.removeLayer(m); S.markers.delete(id); }
      if (S.following === id) S.following = null;
    });
    $("#c-vehicles").textContent = S.vehicles.size;
    renderVehicles(); renderRoutes();
    refreshOpenPopup();
    if (S.following && S.vehicles.has(S.following)) { const v = S.vehicles.get(S.following); map.panTo([v.lat, v.lon], { animate: true }); }
  }

  function busIconHtml(v) {
    const r = routeOf(v); const color = routeColor(v), text = r ? r.text : "#fff";
    const code = r ? r.short : (v.routeCode || "BUS");
    const arrow = v.bearing != null ? '<i class="hd" style="transform:rotate(' + Math.round(v.bearing) + 'deg)"></i>' : "";
    return '<div class="bus' + (v.stale ? " stale" : "") + '" style="--c:' + color + ";--t:" + text + '">' + arrow + "<span>" + esc(code) + "</span></div>";
  }
  function upsertMarker(v) {
    const hidden = v.routeId && S.hiddenRoutes.has(v.routeId);
    let m = S.markers.get(v.id);
    if (hidden) { if (m) { map.removeLayer(m); S.markers.delete(v.id); } return; }
    const html = busIconHtml(v);
    if (!m) {
      m = L.marker([v.lat, v.lon], { pane: "buses", icon: L.divIcon({ className: "bus-wrap", html, iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18] }), keyboard: true, title: (v.routeCode || "Bus") + " " + v.label, riseOnHover: true });
      m._html = html;
      m.bindPopup(() => busPopup(S.vehicles.get(v.id) || v), { maxWidth: 300, minWidth: 230 });
      m.on("popupopen", () => { S.openKey = "bus:" + v.id; setHash("bus", v.id); });
      m.on("popupclose", () => { if (S.openKey === "bus:" + v.id) { S.openKey = null; setHash(); } });
      m.addTo(map); S.markers.set(v.id, m);
    } else {
      if (m._html !== html) { m.setIcon(L.divIcon({ className: "bus-wrap", html, iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18] })); m._html = html; }
      glide(m, [v.lat, v.lon]);
    }
  }
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function glide(m, to) {
    const from = m.getLatLng(); if (from.lat === to[0] && from.lng === to[1]) return;
    if (reduceMotion || document.hidden || C.distanceM(from.lat, from.lng, to[0], to[1]) > 2000) { m.setLatLng(to); return; }
    const t0 = performance.now(), dur = 1200; cancelAnimationFrame(m._raf);
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]); if (k < 1) m._raf = requestAnimationFrame(step); };
    m._raf = requestAnimationFrame(step);
  }

  function busPopup(v) {
    const r = routeOf(v);
    const age = v.ts ? nowS() - v.ts : null;
    const status = v.stopId && S.idx.stops[v.stopId] ? (C.STOP_STATUS[v.status] || "Next stop") + " " + S.idx.stops[v.stopId].name : "";
    const occ = v.occupancy && C.OCCUPANCY[v.occupancy];
    const next = (S.trip.byVehicle.get(v.id) || []).filter(x => x.time >= nowS() - 30 && !x.skipped).slice(0, 4);
    let h = '<div class="pop">' + routeBadge(r, v.routeCode) + (r && r.long ? '<div class="pl">' + esc(r.long) + "</div>" : "");
    h += '<div class="kv"><span>Bus</span><b>' + esc(v.label) + "</b></div>";
    if (status) h += '<div class="kv"><span>Status</span>' + esc(status) + "</div>";
    else if (v.near && v.near.distance < 1500) h += '<div class="kv"><span>Near</span>' + esc(v.near.stop.name) + " (" + dist(v.near.distance) + ")</div>";
    if (v.speedKmh != null) h += '<div class="kv"><span>Speed</span>' + Math.round(v.speedKmh) + " km/h</div>";
    if (occ) h += '<div class="kv"><span>Crowding</span>' + occ[1] + (v.occupancyPct != null ? " (" + v.occupancyPct + "%)" : "") + "</div>";
    h += '<div class="kv"><span>Updated</span>' + (age != null ? C.ago(age) + (v.stale ? ' <em class="st">signal delayed</em>' : "") : "—") + "</div>";
    if (next.length) h += '<div class="nx"><div class="nh">Next stops</div>' + next.map(x => '<div class="kv"><span>' + esc(clock(x.time)) + "</span>" + esc((S.idx.stops[x.stopId] || {}).name || x.stopId) + "</div>").join("") + "</div>";
    h += '<div class="acts"><button data-follow="' + esc(v.id) + '">' + (S.following === v.id ? "Following ✓" : "Follow bus") + "</button></div></div>";
    return h;
  }
  function stopPopup(s) {
    const arr = (S.trip.byStop.get(s.id) || []).filter(x => x.time >= nowS() - 30 && !(x.routeId && S.hiddenRoutes.has(x.routeId))).slice(0, 6);
    let h = '<div class="pop"><b class="pt">' + esc(s.name) + "</b>" + (s.code ? ' <span class="code">' + esc(s.code) + "</span>" : "");
    if (arr.length) {
      h += '<div class="arr">' + arr.map(x => {
        const m = C.minutesUntil(x.time); const r = S.idx.byId.get(x.routeId);
        const when = x.cancelled ? "Cancelled" : x.skipped ? "Skips stop" : m <= 0 ? "Due" : m + " min";
        return '<div class="ar' + (x.cancelled || x.skipped ? " off" : "") + '">' + routeBadge(r, x.routeCode) + '<span class="w">' + esc(x.vehicleId || "") + "</span><b>" + when + '</b><span class="tm">' + clock(x.time) + "</span></div>";
      }).join("") + "</div>";
    } else {
      const buses = [...S.vehicles.values()].map(v => ({ v, d: C.distanceM(v.lat, v.lon, s.lat, s.lon) })).filter(x => x.d < 3000).sort((a, b) => a.d - b.d).slice(0, 3);
      h += '<div class="muted sm">No live arrival predictions for this stop right now.</div>';
      if (buses.length) h += '<div class="nx"><div class="nh">Buses nearby</div>' + buses.map(x => '<div class="kv">' + routeBadge(routeOf(x.v), x.v.routeCode) + " " + esc(x.v.label) + " · " + dist(x.d) + "</div>").join("") + "</div>";
    }
    return h + "</div>";
  }
  function refreshOpenPopup() {
    if (!S.openKey) return;
    const [kind, id] = [S.openKey.slice(0, S.openKey.indexOf(":")), S.openKey.slice(S.openKey.indexOf(":") + 1)];
    const m = kind === "bus" ? S.markers.get(id) : S.stopMarkers.get(id);
    if (!m || !m.isPopupOpen()) return;
    if (kind === "bus" && S.vehicles.has(id)) m.setPopupContent(busPopup(S.vehicles.get(id)));
    if (kind === "stop") m.setPopupContent(stopPopup(S.idx.stops[id]));
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-follow]"); if (!b) return;
    const id = b.dataset.follow; S.following = S.following === id ? null : id;
    const v = S.vehicles.get(id); if (S.following && v) map.setView([v.lat, v.lon], Math.max(map.getZoom(), 15));
    toast(S.following ? "Following bus " + (v ? v.label : id) : "Stopped following");
    refreshOpenPopup();
  });

  /* ---------------- trip updates + alerts ---------------- */
  async function loadTripUpdates() {
    try {
      const feed = decode(await (await apiFetch(ENDPOINTS.tripUpdates)).arrayBuffer());
      S.trip = C.processTripUpdates(feed, S.idx, {});
      const nStops = S.trip.byStop.size;
      setFeed("tripUpdates", "ok", { detail: S.trip.count ? S.trip.count + " trips with predictions for " + nStops + " stops" : "no arrival predictions published right now" });
      refreshOpenPopup(); if (S.tab === "stops") renderStops();
    } catch (e) { setFeed("tripUpdates", "err", { detail: e.message }); throw e; }
  }
  async function loadAlerts() {
    try {
      const feed = decode(await (await apiFetch(ENDPOINTS.alerts)).arrayBuffer());
      S.alerts = C.processAlerts(feed, S.idx, { agency: CFG.agency, languages: [(navigator.language || "en").split("-")[0], "en"] });
      setFeed("alerts", "ok", { detail: S.alerts.length ? S.alerts.length + " active" : "no active alerts" });
      $("#c-alerts").textContent = S.alerts.length;
      $("#c-alerts").classList.toggle("hot", S.alerts.length > 0);
      renderAlerts();
    } catch (e) { setFeed("alerts", "err", { detail: e.message }); throw e; }
  }

  /* ---------------- panel rendering ---------------- */
  const match = (q, ...fields) => !q || fields.some(f => String(f || "").toLowerCase().includes(q));
  function renderAll() { renderVehicles(); renderRoutes(); renderStops(); renderAlerts(); }

  function renderVehicles() {
    const el = $("#pane-vehicles"); const q = S.query;
    const all = [...S.vehicles.values()];
    const list = all.filter(v => match(q, v.label, v.routeCode, routeOf(v) && routeOf(v).long, v.near && v.near.stop.name))
      .sort((a, b) => (a.routeCode || "").localeCompare(b.routeCode || "", undefined, { numeric: true }) || a.label.localeCompare(b.label));
    if (!list.length) {
      let msg;
      if (S.feeds.vehicles && S.feeds.vehicles.status === "err" && !all.length) msg = "Live bus positions are unavailable right now.<br><span class='sm'>" + esc(S.feeds.vehicles.detail) + "</span>";
      else if (q && all.length) msg = "No buses match “" + esc(q) + "”.";
      else if (!S.feeds.vehicles) msg = "Connecting to live buses…";
      else {
        const mins = C.localMinutes(tz()); const [a, b] = CFG.serviceHours;
        msg = "No LMT buses are reporting their position right now." +
          (mins < a || mins >= b ? "<br><span class='sm'>Buses usually run " + fmtMin(a) + "–" + fmtMin(b) + " (Colombo time) and are parked overnight.</span>" : "<br><span class='sm'>Positions appear here as soon as buses report in.</span>");
      }
      el.innerHTML = '<div class="empty">' + msg + "</div>"; return;
    }
    el.innerHTML = list.map(v => {
      const r = routeOf(v); const age = v.ts ? nowS() - v.ts : null;
      const where = v.stopId && S.idx.stops[v.stopId] ? (C.STOP_STATUS[v.status] || "Next") + " " + S.idx.stops[v.stopId].name
        : v.near && v.near.distance < 1500 ? "Near " + v.near.stop.name : "";
      const occ = v.occupancy && C.OCCUPANCY[v.occupancy];
      return '<button class="row' + (v.stale ? " stale" : "") + (S.hiddenRoutes.has(v.routeId) ? " hiddenr" : "") + '" data-bus="' + esc(v.id) + '">' + routeBadge(r, v.routeCode) +
        '<span class="main"><span class="t">' + esc(v.label) + "</span>" +
        '<span class="s">' + esc(where || (r && r.long) || "") + "</span>" +
        '<span class="m">' + (v.speedKmh != null ? Math.round(v.speedKmh) + " km/h · " : "") + (age != null ? C.ago(age) : "") + "</span></span>" +
        (occ ? '<span class="chip ' + occ[0] + '">' + occ[1] + "</span>" : "") + "</button>";
    }).join("");
  }
  function fmtMin(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

  function renderRoutes() {
    const el = $("#pane-routes"); const q = S.query;
    const routes = (S.static ? S.static.routes : []).filter(r => match(q, r.short, r.long, r.desc));
    if (!routes.length) { el.innerHTML = '<div class="empty">' + (S.static ? "No routes match." : "Loading routes…") + "</div>"; return; }
    const counts = new Map(); S.vehicles.forEach(v => counts.set(v.routeId, (counts.get(v.routeId) || 0) + 1));
    el.innerHTML = routes.map(r => {
      const n = counts.get(r.id) || 0; const hasLine = (S.static.routeShapes[r.id] || []).length > 0;
      return '<div class="row rrow" data-route="' + esc(r.id) + '">' + routeBadge(r) +
        '<span class="main"><span class="t">' + esc(r.long || r.short) + "</span>" +
        '<span class="m">' + (n ? '<b class="live">' + n + " live</b>" : "no buses reporting") + (hasLine ? "" : " · no route line in feed") + "</span></span>" +
        '<label class="toggle" title="Show on map"><input type="checkbox" data-toggle="' + esc(r.id) + '" ' + (S.hiddenRoutes.has(r.id) ? "" : "checked") + ' aria-label="Show ' + esc(r.short) + ' on map"><span></span></label></div>';
    }).join("");
  }

  function renderStops() {
    const el = $("#pane-stops"); const q = S.query;
    let list = S.idx.platforms.filter(s => match(q, s.name, s.code));
    if (!S.idx.platforms.length) { el.innerHTML = '<div class="empty">' + (S.feeds.static && S.feeds.static.status === "err" ? "Stop data unavailable." : "Loading stops…") + "</div>"; return; }
    if (S.userLoc) list = list.map(s => Object.assign({ d: C.distanceM(S.userLoc[0], S.userLoc[1], s.lat, s.lon) }, s)).sort((a, b) => a.d - b.d);
    else list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) { el.innerHTML = '<div class="empty">No stops match “' + esc(q) + "”.</div>"; return; }
    const shown = list.slice(0, 300);
    el.innerHTML = (S.userLoc ? '<div class="hint">Sorted by distance from you</div>' : "") + shown.map(s => {
      const next = (S.trip.byStop.get(s.id) || []).find(x => x.time >= nowS() - 30 && !x.skipped && !x.cancelled);
      const nr = next && S.idx.byId.get(next.routeId);
      return '<button class="row" data-stop="' + esc(s.id) + '"><span class="stopi" aria-hidden="true"></span>' +
        '<span class="main"><span class="t">' + esc(s.name) + "</span>" +
        '<span class="m">' + (s.code ? esc(s.code) : "") + (s.d != null ? (s.code ? " · " : "") + dist(s.d) : "") + "</span></span>" +
        (next ? '<span class="nxt">' + routeBadge(nr, next.routeCode) + "<b>" + (C.minutesUntil(next.time) <= 0 ? "Due" : C.minutesUntil(next.time) + "′") + "</b></span>" : "") + "</button>";
    }).join("") + (list.length > shown.length ? '<div class="hint">Showing 300 of ' + list.length + " — search to narrow down.</div>" : "");
  }

  function renderAlerts() {
    const el = $("#pane-alerts");
    const q = S.query;
    const list = S.alerts.filter(a => match(q, a.header, a.description, a.routes.map(r => r.short).join(" ")));
    if (!list.length) {
      const f = S.feeds.alerts;
      el.innerHTML = '<div class="empty">' + (f && f.status === "err" ? "Service alerts are unavailable right now." : !f ? "Checking for service alerts…" : q ? "No alerts match." : "✓ No active service alerts.<br><span class='sm'>Good service reported on all LMT routes.</span>") + "</div>";
      return;
    }
    el.innerHTML = list.map(a => '<article class="alert ' + a.severity + '">' +
      '<div class="meta">' + esc(a.effect) + (a.cause ? " · " + esc(a.cause) : "") + (a.until ? " · until " + esc(clock(a.until)) : "") + "</div>" +
      '<h3 class="hd">' + esc(a.header) + "</h3>" +
      (a.routes.length ? '<div class="rts">' + a.routes.map(r => routeBadge(r)).join("") + "</div>" : "") +
      (a.description ? '<p class="ds">' + esc(a.description).replace(/\n/g, "<br>") + "</p>" : "") +
      (a.stops.length ? '<div class="m">Stops: ' + a.stops.map(s => esc(s.name)).join(", ") + "</div>" : "") +
      (a.url && /^https?:\/\//i.test(a.url) ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">More information ↗</a>' : "") +
      "</article>").join("");
  }

  /* ---------------- panel interactions ---------------- */
  $("#pane-vehicles").addEventListener("click", e => { const n = e.target.closest("[data-bus]"); if (n) focusBus(n.dataset.bus); });
  $("#pane-stops").addEventListener("click", e => { const n = e.target.closest("[data-stop]"); if (n) focusStop(n.dataset.stop); });
  $("#pane-routes").addEventListener("click", e => {
    if (e.target.closest(".toggle")) return;
    const n = e.target.closest("[data-route]"); if (n) showRoute(n.dataset.route);
  });
  $("#pane-routes").addEventListener("change", e => {
    const id = e.target.dataset.toggle; if (!id) return;
    if (e.target.checked) S.hiddenRoutes.delete(id); else S.hiddenRoutes.add(id);
    try { localStorage.setItem("lmt-hidden-routes", JSON.stringify([...S.hiddenRoutes])); } catch (err) { /* ignore */ }
    const g = S.routeLayers.get(id); if (g) { if (e.target.checked) g.addTo(map); else map.removeLayer(g); }
    S.vehicles.forEach(v => { if (v.routeId === id) upsertMarker(v); });
    renderVehicles();
  });

  function collapseSheetOnMobile() { if (matchMedia("(max-width: 720px)").matches) $("#panel").classList.add("min"); }
  function focusBus(id) {
    const v = S.vehicles.get(id); const m = S.markers.get(id); if (!v) return;
    if (!m) { toast("This route is hidden — turn it on in Routes"); return; }
    collapseSheetOnMobile();
    map.setView([v.lat, v.lon], Math.max(map.getZoom(), 15)); m.openPopup();
  }
  function focusStop(id) {
    const s = S.idx.stops[id]; if (!s) return; collapseSheetOnMobile();
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16));
    syncStopVisibility(); const m = S.stopMarkers.get(id); if (m) setTimeout(() => m.openPopup(), 50);
  }
  function showRoute(id) {
    const g = S.routeLayers.get(id); const pts = [];
    if (g) { const b = g.getBounds(); if (b.isValid()) pts.push(b.getSouthWest(), b.getNorthEast()); }
    S.vehicles.forEach(v => { if (v.routeId === id) pts.push(L.latLng(v.lat, v.lon)); });
    if (!pts.length) { toast("No route line or live buses to show for this route"); return; }
    collapseSheetOnMobile(); setHash("route", (S.idx.byId.get(id) || {}).short || id);
    map.fitBounds(L.latLngBounds(pts), fitOpts(15, 40));
    if (g) { g.setStyle({ weight: 8, opacity: 1 }); g.bringToFront(); setTimeout(() => g.setStyle({ weight: 5, opacity: 0.8 }), 1800); }
  }

  /* tabs */
  document.querySelectorAll(".tabs [role=tab]").forEach(b => b.addEventListener("click", () => selectTab(b.dataset.pane)));
  function selectTab(name) {
    S.tab = name;
    document.querySelectorAll(".tabs [role=tab]").forEach(x => { const on = x.dataset.pane === name; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; });
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("show", p.id === "pane-" + name));
    $("#q").placeholder = { vehicles: "Search buses, plates, stops…", routes: "Search routes…", stops: "Search stops…", alerts: "Search alerts…" }[name];
    $("#panel").classList.remove("min");
    renderAll();
  }
  $(".tabs").addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...document.querySelectorAll(".tabs [role=tab]")]; const i = tabs.findIndex(t => t.dataset.pane === S.tab);
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; selectTab(n.dataset.pane); n.focus();
  });
  let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.query = e.target.value.trim().toLowerCase(); renderAll(); }, 120); });
  $(".grab").addEventListener("click", () => $("#panel").classList.toggle("min"));

  /* locate */
  $("#locate").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Location isn't available in this browser"); return; }
    toast("Finding your location…");
    navigator.geolocation.getCurrentPosition(p => {
      S.userLoc = [p.coords.latitude, p.coords.longitude];
      if (!S.userMarker) S.userMarker = L.circleMarker(S.userLoc, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, pane: "buses" }).bindTooltip("You are here").addTo(map);
      else S.userMarker.setLatLng(S.userLoc);
      const n = C.nearestStop(S.idx, S.userLoc[0], S.userLoc[1]);
      if (n && n.distance < 20000) { map.fitBounds(L.latLngBounds([S.userLoc, [n.stop.lat, n.stop.lon]]), fitOpts(16, 60)); toast("Nearest stop: " + n.stop.name + " (" + dist(n.distance) + ")"); }
      else { map.setView(S.userLoc, 15); toast("You're outside the LMT service area"); }
      selectTab("stops");
    }, () => toast("Couldn't get your location"), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });

  /* theme */
  (function themeInit() {
    let t = null; try { t = localStorage.getItem("lmt-theme"); } catch (e) { /* ignore */ }
    if (t) document.documentElement.setAttribute("data-theme", t);
    $("#theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; const next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next); try { localStorage.setItem("lmt-theme", next); } catch (e) { /* ignore */ }
    });
  })();

  /* deep links: #bus=<id>, #stop=<id>, #route=<code> */
  function setHash(kind, id) { const h = kind ? "#" + kind + "=" + encodeURIComponent(id) : " "; try { history.replaceState(null, "", h === " " ? location.pathname + location.search : h); } catch (e) { /* ignore */ } }
  let hashDone = false;
  function applyHash() {
    if (hashDone) return; const m = location.hash.match(/^#(bus|stop|route)=(.+)$/); if (!m) { hashDone = true; return; }
    const id = decodeURIComponent(m[2]);
    if (m[1] === "stop" && S.idx.stops[id]) { hashDone = true; focusStop(id); }
    else if (m[1] === "route") { const r = S.idx.byShort.get(id.toUpperCase()) || S.idx.byId.get(id); if (r) { hashDone = true; showRoute(r.id); } }
    else if (m[1] === "bus" && S.vehicles.has(id)) { hashDone = true; focusBus(id); }
  }

  /* ---------------- polling ---------------- */
  function poller(name, fn, every) {
    let timer = null, fails = 0, busy = false;
    async function run() {
      if (busy) return; clearTimeout(timer); busy = true;
      try { await fn(); fails = 0; } catch (e) { fails++; console.warn("[" + name + "]", e.message || e); }
      finally { busy = false; }
      if (!document.hidden) timer = setTimeout(run, fails ? Math.min(every * Math.pow(2, fails), 300000) : every);
    }
    return { run, stop() { clearTimeout(timer); timer = null; } };
  }
  const pollers = {
    vehicles: poller("vehicles", loadVehicles, CFG.refreshMs.vehicles),
    tripUpdates: poller("tripUpdates", loadTripUpdates, CFG.refreshMs.tripUpdates),
    alerts: poller("alerts", loadAlerts, CFG.refreshMs.alerts)
  };
  function runAll() { return Promise.all(Object.values(pollers).map(p => p.run())); }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) Object.values(pollers).forEach(p => p.stop());
    else runAll();
  });
  window.addEventListener("online", runAll);
  $("#refresh").addEventListener("click", async () => {
    const b = $("#refresh"); b.classList.add("spin"); await runAll(); b.classList.remove("spin"); toast("Updated");
  });

  /* live "updated N s ago" + countdown refresh */
  setInterval(() => {
    const s = $("#status");
    if (!S.lastVehicleOk) { s.textContent = S.feeds.vehicles && S.feeds.vehicles.status === "err" ? "Live feed unavailable" : "Connecting…"; s.className = "status" + (S.feeds.vehicles && S.feeds.vehicles.status === "err" ? " err" : ""); return; }
    const age = nowS() - S.lastVehicleOk;
    const err = S.feeds.vehicles && S.feeds.vehicles.status === "err";
    s.className = "status " + (err ? "err" : age > 60 ? "warn" : "live");
    s.innerHTML = (err ? "Reconnecting · " : '<i class="pulse"></i>Live · ') + S.vehicles.size + " bus" + (S.vehicles.size === 1 ? "" : "es") + " · " + C.ago(age);
  }, 1000);
  setInterval(() => { refreshOpenPopup(); if (S.tab === "vehicles") renderVehicles(); if (S.tab === "stops") renderStops(); }, 15000);

  /* ---------------- boot ---------------- */
  async function boot() {
    renderFeedDetails();
    try { S.FeedMessage = protobuf.parse(C.GTFS_RT_PROTO, { keepCase: true }).root.lookupType("transit_realtime.FeedMessage"); }
    catch (e) { console.error("GTFS-RT schema failed to load", e); }
    const staticP = loadStatic();
    // Show buses as soon as routes are known (the cached copy makes that instant on repeat visits).
    await Promise.race([staticP, new Promise(r => setTimeout(r, 8000))]);
    $("#loader").classList.add("hide");
    await runAll().catch(() => { /* handled per feed */ });
    await staticP;
    // Re-resolve buses against fresh static data if it arrived after the first poll.
    pollers.vehicles.run();
    applyHash(); setTimeout(applyHash, 1500);
  }
  window.LMTApp = { state: S, config: CFG, refresh: runAll };
  boot();
})();
