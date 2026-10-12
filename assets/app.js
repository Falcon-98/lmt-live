/* ============================================================
   LMT Live — UI controller (Leaflet map + panel).
   Shows two systems from the same open feed server:
     • LMT buses   — live GPS (GTFS-Realtime)
     • SLR trains  — live GPS / delays when published, otherwise positions
                     estimated from the official timetable (clearly labelled)
   Data rules live in lmt-core.js; this file fetches, schedules and renders.
   ============================================================ */
(function () {
  "use strict";
  const C = window.LMTCore;
  const qs = new URLSearchParams(location.search);

  /* ---------------- configuration ----------------
     Override with window.LMT_CONFIG = {...} before this script, or from the URL:
     ?api=https://your-proxy.example/api/v1   ?trains=0   ?speed=ms */
  const CFG = Object.assign({
    api: "https://api.transit.seyone.dev/api/v1",
    // Optional second API base (e.g. your CORS proxy, see proxy/cloudflare-worker.js). Tried when the first fails.
    fallbackApi: "",
    refreshMs: { vehicles: 10000, tripUpdates: 30000, alerts: 60000, estimates: 5000 },
    maxVehicleAgeSec: 1800,  // GPS positions older than this are dropped (the producer keeps buses ~45 min after their last ticket)
    staleVehicleSec: 180,    // older than this are shown faded as "signal delayed"
    staticCacheHours: 24,
    trains: true,
    systems: [
      {
        id: "LMT", mode: "bus", one: "bus", many: "buses", title: "Bus routes",
        area: C.SERVICE_AREA, stopZoom: 13,
        // LMT now publishes trips + stop_times: when the GPS feed is empty, buses are placed from the timetable (labelled ⏱).
        schedule: true,
        speedUnit: "kmh", // the LMT producer publishes km/h (GTFS-RT says m/s); ?speed=ms switches
        // Positions often arrive without route_id (opaque trip ids): accept LMT buses by their plate, then infer the route.
        platePattern: /^(?:[A-Z]{2}-)?[A-Z]{2,3}-\d{3,4}$|^[A-Z]{2,3}\d{4}$/,
        staticPaths: ["/gtfs/download?agency=LMT"],
        // Mobility Database mirrors of feed mdb-3490, tried if the producer download fails.
        staticMirrors: [
          "https://files.mobilitydatabase.org/mdb-3490/latest.zip",
          "https://files.mobilitydatabase.org/mdb-3490/mdb-3490-202610110023/mdb-3490-202610110023.zip"
        ],
        serviceHours: [330, 1320] // 05:30–22:00, only for the "no buses" message
      },
      {
        id: "SLR", mode: "train", one: "train", many: "trains", title: "Rail lines",
        area: C.SRI_LANKA, stopZoom: 10, schedule: true, speedUnit: "ms",
        // Show trains that are running, plus trains waiting at their first station that leave within this many minutes.
        preDepartMin: 30,
        staticPaths: ["/gtfs/download?agency=SLR", "/gtfs/download"],
        staticMirrors: [],
        // The SLR feed has no route colours; these keep each line recognisable.
        // The published SLR stops.txt has many stations in the wrong place; corrected from OpenStreetMap.
        stopFixes: window.LMT_STATION_FIXES || {},
        // Station-to-station railway tracks, so trains follow the rails and every line is drawn.
        rail: window.LMT_RAIL_GEOMETRY || null,
        colors: { Main: "#c62828", Coast: "#1565c0", Puttalam: "#2e7d32", Northern: "#6a1b9a", Kelani: "#ef6c00",
          Batticaloa: "#00838f", Trincomalee: "#ad1457", Talaimannar: "#5d4037", Suburban: "#546e7a" },
        serviceHours: [240, 1440]
      }
    ]
  }, window.LMT_CONFIG || {});
  if (qs.get("api")) CFG.api = qs.get("api").replace(/\/+$/, "");
  if (qs.get("fallbackApi")) CFG.fallbackApi = qs.get("fallbackApi").replace(/\/+$/, "");
  if (qs.get("speed") === "ms" || qs.get("speed") === "kmh") CFG.systems[0].speedUnit = qs.get("speed");
  if (qs.get("trains") === "0") CFG.trains = false;

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nowS = () => Date.now() / 1000;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked or full */ } }
  };

  /* ---------------- state ---------------- */
  const S = {
    systems: CFG.systems.filter(s => CFG.trains || s.mode !== "train").map(cfg => Object.assign({}, cfg, {
      static: null, idx: C.indexStatic({}), live: new Map(), est: [],
      trip: { byStop: new Map(), byVehicle: new Map(), delays: new Map(), cancelled: new Set(), count: 0 },
      alerts: [], feeds: {}, lastOk: 0, routeLayers: new Map(), stopLayer: null, stopMarkers: new Map(),
      ep: p => p.replace("{a}", encodeURIComponent(cfg.id))
    })),
    all: new Map(), markers: new Map(), prevPos: new Map(),
    hiddenRoutes: new Set(store.get("lmt-hidden-routes-v2", [])),
    mode: store.get("lmt-mode", "all"), FeedMessage: null, following: null, openKey: null,
    userLoc: null, userMarker: null, tab: "vehicles", query: "",
    favs: new Set(store.get("lmt-favs", [])), focus: null // focus = "SYS:routeId" while one route is singled out
  };
  if (!["all", "bus", "train"].includes(S.mode) || !S.systems.some(s => s.mode === S.mode)) S.mode = "all";
  const BUS = S.systems.find(s => s.mode === "bus"), TRAIN = S.systems.find(s => s.mode === "train");
  const sysById = id => S.systems.find(s => s.id === id);
  const shown = sys => S.mode === "all" || S.mode === sys.mode;
  const tz = () => ((BUS && BUS.static) || (TRAIN && TRAIN.static) || {}).timezone || "Asia/Colombo";
  function clock(ts) {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts * 1000)); }
    catch (e) { return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
  }
  const dist = m => m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1) + " km";
  const plural = (n, sys) => n + " " + (n === 1 ? sys.one : sys.many);
  const routeOf = v => v.sys.idx.byId.get(v.routeId) || null;
  const codeOf = v => String((routeOf(v) || {}).short || v.routeCode || "");
  function badge(r, code) {
    if (r) return '<span class="badge" style="background:' + r.color + ";color:" + r.text + '">' + esc(r.short) + "</span>";
    return '<span class="badge" style="background:#46505a;color:#fff">' + esc(code || "?") + "</span>";
  }
  function delayText(d) {
    if (d == null) return "";
    const m = Math.round(d / 60);
    return m >= 1 ? m + " min late" : m <= -1 ? -m + " min early" : "On time";
  }
  function delayChip(d) {
    if (d == null) return "";
    const m = Math.round(d / 60);
    return '<span class="chip ' + (m >= 5 ? "bad" : m >= 2 ? "warn" : "good") + '">' + (m >= 1 ? "+" + m + " min" : m <= -1 ? m + " min" : "On time") + "</span>";
  }
  const stopName = (sys, id) => (sys.idx.stops[id] || {}).name || id;

  /* ---------------- map ---------------- */
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([6.905, 79.92], 12);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.createPane("routes").style.zIndex = 410;
  map.createPane("stops").style.zIndex = 420;
  map.createPane("vehicles").style.zIndex = 640;
  const stopRenderer = L.canvas({ pane: "stops", padding: 0.3 });
  map.on("dragstart", () => { if (S.following) { S.following = null; toast("Stopped following"); } });
  function zoomClass() {
    const z = map.getZoom(), el = map.getContainer();
    el.classList.toggle("z-far", z < 12); el.classList.toggle("z-vfar", z < 9);
  }
  map.on("zoomend", () => { zoomClass(); S.systems.forEach(syncStopVisibility); });
  zoomClass();

  /* ---------------- fetching ---------------- */
  class FeedError extends Error { constructor(msg, kind, status) { super(msg); this.kind = kind; this.status = status; } }
  async function fetchWithTimeout(url, ms) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctl && ctl.signal });
      if (!r.ok) throw new FeedError("HTTP " + r.status, "http", r.status);
      return r;
    } catch (e) {
      if (e instanceof FeedError) throw e;
      const abort = e && e.name === "AbortError";
      throw new FeedError(abort ? "timed out" : "blocked or offline (network/CORS)", abort ? "timeout" : "network");
    } finally { if (t) clearTimeout(t); }
  }
  /** Try the primary API base, then the fallback base; remember whichever works. */
  let preferredBase = CFG.api;
  async function apiFetch(path, ms) {
    const bases = [preferredBase, CFG.api, CFG.fallbackApi].filter((b, i, a) => b && a.indexOf(b) === i);
    let last;
    for (const b of bases) {
      try { const r = await fetchWithTimeout(b + path, ms); preferredBase = b; return r; }
      catch (e) { last = e; if (e.kind === "http" && e.status >= 400 && e.status < 500) break; }
    }
    throw last;
  }
  function decode(buf) {
    if (!S.FeedMessage) throw new FeedError("protobuf decoder unavailable", "decode");
    try {
      return S.FeedMessage.toObject(S.FeedMessage.decode(new Uint8Array(buf)), { enums: String, longs: Number, defaults: false, arrays: true });
    } catch (e) { throw new FeedError("could not decode GTFS-Realtime (" + e.message + ")", "decode"); }
  }
  const rt = (sys, kind) => "/realtime/" + kind + "?agency=" + encodeURIComponent(sys.id);

  /* ---------------- feed health ---------------- */
  const FEED_LABEL = { static: "Timetable & map", vehicles: "Live positions", tripUpdates: "Predictions", alerts: "Alerts" };
  function setFeed(sys, name, status, detail) {
    sys.feeds[name] = { status, detail, at: nowS() };
    renderHealth();
  }
  function systemStatus(sys) {
    const f = sys.feeds;
    if (sys.mode === "train") {
      if (f.vehicles && f.vehicles.status === "ok" && sys.live.size) return "ok";
      if (sys.static && sys.static.schedule) return "warn"; // timetable only
      return f.static && f.static.status === "err" ? "err" : "";
    }
    return f.vehicles ? f.vehicles.status : "";
  }
  const liveCount = sys => [...S.all.values()].filter(v => v.sys === sys && !v.scheduled).length;
  function renderHealth() {
    S.systems.forEach(sys => {
      const el = $("#h-" + sys.mode); if (!el) return;
      const st = systemStatus(sys);
      el.className = "dot " + st; el.hidden = false;
      el.title = sys.many[0].toUpperCase() + sys.many.slice(1) + ": " + ((sys.feeds.vehicles || {}).detail || "waiting…");
    });
    const al = S.systems.map(s => s.feeds.alerts).filter(Boolean);
    $("#h-alerts").className = "dot " + (al.some(a => a.status === "ok") ? "ok" : al.length ? "err" : "");
    $("#feed-details").innerHTML = S.systems.map(sys =>
      '<li class="fh">' + esc(sys.id === "LMT" ? "Lanka Metro Transit buses" : "Sri Lanka Railways trains") + "</li>" +
      Object.keys(FEED_LABEL).map(k => {
        const f = sys.feeds[k];
        return '<li><b class="d ' + (f ? f.status : "") + '"></b>' + FEED_LABEL[k] + ": " + esc(f ? f.detail : "waiting…") + "</li>";
      }).join("")).join("") + '<li class="muted">Source: <code>' + esc(preferredBase) + "</code></li>";
  }

  /* ---------------- banner / toast ---------------- */
  function banner(kind, html) {
    const b = $("#banner");
    if (!html) { b.classList.remove("show"); b.dataset.kind = ""; return; }
    b.dataset.kind = kind; b.className = "banner show " + kind;
    b.innerHTML = html + '<button class="x" aria-label="Dismiss">✕</button>';
    b.querySelector(".x").onclick = () => { b.classList.remove("show"); if (kind === "empty") try { sessionStorage.setItem("lmt-empty-dismissed", "1"); } catch (e) { /* ignore */ } };
  }
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600); }

  /* ---------------- static GTFS ---------------- */
  const cacheKey = sys => "lmt-static-v5-" + sys.id; // v5: corrected station positions
  try { ["lmt-static-v2", "lmt-static-v3-LMT", "lmt-static-v3-SLR", "lmt-static-v4-LMT", "lmt-static-v4-SLR", "lmt-hidden-routes"].forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
  async function downloadStatic(sys) {
    const tries = sys.staticPaths.map(p => () => apiFetch(p, 60000)).concat(sys.staticMirrors.map(u => () => fetchWithTimeout(u, 60000)));
    let last;
    for (let i = 0; i < tries.length; i++) {
      try {
        const r = await tries[i]();
        const zip = await JSZip.loadAsync(await r.arrayBuffer());
        const read = async n => { const f = zip.file(n) || zip.file(new RegExp("(^|/)" + n.replace(".", "\\.") + "$"))[0]; return f ? f.async("string") : ""; };
        const files = {};
        for (const n of ["agency", "routes", "stops", "trips", "shapes", "stop_times", "feed_info", "calendar", "calendar_dates"]) {
          if (n === "stop_times" && !sys.schedule && !(await read("trips.txt")).trim()) { files[n] = ""; continue; }
          files[n] = await read(n + ".txt");
        }
        if (!files.routes || !files.stops) throw new FeedError("zip has no routes/stops", "data");
        const data = C.buildStatic(files, { agency: sys.id, schedule: sys.schedule, colors: sys.colors, stopFixes: sys.stopFixes });
        if (!data.routes.length) throw new FeedError("no " + sys.id + " routes in this download", "data");
        return { data, source: i < sys.staticPaths.length ? "live" : "mirror" };
      } catch (e) { last = e; }
    }
    throw last || new FeedError("no source", "network");
  }

  function applyStatic(sys, data, source) {
    // Real track geometry (from OpenStreetMap) for trains and rail lines; not part of the cached data.
    if (sys.rail) C.attachRail(data, sys.rail);
    sys.static = data; sys.idx = C.indexStatic(data);
    drawRoutes(sys); drawStops(sys);
    const lines = Object.values(data.routeShapes).reduce((n, a) => n + a.length, 0);
    const trips = data.schedule ? ", " + data.schedule.trips.length + " timetabled trips" : "";
    setFeed(sys, "static", source === "cache" ? "warn" : "ok", data.routes.length + " routes, " + sys.idx.platforms.length + " stops, " +
      lines + " route lines" + trips + " (" + (source === "live" ? "live" : source === "mirror" ? "Mobility Database mirror" : "cached copy") + ")");
    if (sys.schedule) updateEstimates(sys);
    refreshAll();
  }

  async function loadStatic(sys) {
    const cached = store.get(cacheKey(sys), null);
    const usable = cached && cached.data && cached.data.routes;
    if (usable) applyStatic(sys, cached.data, "cache");
    const fresh = !usable || (Date.now() - cached.at) > CFG.staticCacheHours * 3600e3;
    if (!fresh) { setFeed(sys, "static", "ok", sys.feeds.static.detail.replace("cached copy", "cached " + C.ago((Date.now() - cached.at) / 1000))); return; }
    try {
      const res = await downloadStatic(sys);
      store.set(cacheKey(sys), { at: Date.now(), data: res.data });
      applyStatic(sys, res.data, res.source);
    } catch (e) {
      if (usable) setFeed(sys, "static", "warn", "using cached copy — refresh failed: " + e.message);
      else {
        setFeed(sys, "static", "err", e.message);
        if (sys.mode === "bus") banner("warn", "<b>Bus route &amp; stop data couldn't be loaded</b> (" + esc(e.message) + "). Live buses will still show, but without route names, lines or stops.");
      }
    }
  }

  /** Popup options whose auto-pan keeps the popup clear of the top bar and the panel. */
  function popOpts(minWidth) {
    const panel = $("#panel").getBoundingClientRect(), top = $(".topbar").offsetHeight, phone = matchMedia("(max-width: 720px)").matches;
    return { maxWidth: 320, minWidth, autoPanPaddingTopLeft: L.point(16, top + 16),
      autoPanPaddingBottomRight: L.point(phone ? 16 : panel.width + 28, phone ? panel.height + 16 : 16) };
  }
  /** fitBounds padding that keeps content clear of the top bar and the panel (right dock or bottom sheet). */
  function fitOpts(maxZoom, pad) {
    pad = pad || 30; const panel = $("#panel").getBoundingClientRect(); const top = $(".topbar").offsetHeight;
    const phone = matchMedia("(max-width: 720px)").matches;
    return { paddingTopLeft: [pad, top + pad], paddingBottomRight: [phone ? pad : panel.width + 12 + pad, phone ? panel.height + pad : pad], maxZoom };
  }
  function systemBounds(sys) {
    const pts = sys.idx.platforms.map(s => [s.lat, s.lon]);
    Object.values((sys.static || {}).routeShapes || {}).forEach(list => list.forEach(line => pts.push(line[0], line[line.length - 1])));
    return pts.length > 1 ? L.latLngBounds(pts) : null;
  }
  function fitTo(mode) {
    const sys = S.systems.find(s => s.mode === mode) || BUS || TRAIN; const b = sys && systemBounds(sys);
    if (b) map.fitBounds(b, fitOpts(mode === "train" ? 9 : 14));
  }

  function drawRoutes(sys) {
    sys.routeLayers.forEach(l => map.removeLayer(l)); sys.routeLayers.clear();
    sys.static.routes.forEach(r => {
      const lines = sys.static.routeShapes[r.id] || []; if (!lines.length) return;
      const train = sys.mode === "train";
      const g = L.featureGroup(lines.map(pts => L.polyline(pts, { pane: "routes", color: r.color, weight: train ? 4 : 5, opacity: train ? 0.7 : 0.8, lineJoin: "round", dashArray: null })));
      g.on("click", () => showRoute(sys, r.id));
      g.bindTooltip((train ? "🚆 " : "🚌 ") + (r.long || r.short), { sticky: true });
      sys.routeLayers.set(r.id, g);
    });
    syncRouteVisibility(sys);
  }
  function syncRouteVisibility(sys) {
    sys.routeLayers.forEach((g, id) => {
      const on = shown(sys) && !S.hiddenRoutes.has(sys.id + ":" + id);
      if (on && !map.hasLayer(g)) g.addTo(map); else if (!on && map.hasLayer(g)) map.removeLayer(g);
    });
  }
  function drawStops(sys) {
    if (sys.stopLayer) map.removeLayer(sys.stopLayer);
    sys.stopMarkers.clear(); sys.stopLayer = L.layerGroup();
    const train = sys.mode === "train";
    sys.idx.platforms.forEach(s => {
      const m = L.circleMarker([s.lat, s.lon], train
        ? { renderer: stopRenderer, radius: 5, weight: 2.5, color: "#3b2a73", fillColor: "#ffffff", fillOpacity: 1 }
        : { renderer: stopRenderer, radius: 5, weight: 2.5, color: "#1b1f24", fillColor: "#ffffff", fillOpacity: 1 });
      const key = (train ? "station:" : "stop:") + sys.id + ":" + s.id;
      m.bindPopup(() => train ? stationPopup(sys, s) : stopPopup(sys, s), popOpts(train ? 280 : 230));
      m.on("popupopen", () => { S.openKey = key; setHash(train ? "station" : "stop", s.id); });
      m.on("popupclose", () => { if (S.openKey === key) { S.openKey = null; setHash(); } });
      m.bindTooltip((train ? "🚉 " : "") + s.name, { direction: "top", offset: [0, -4] });
      sys.stopMarkers.set(s.id, m); sys.stopLayer.addLayer(m);
    });
    syncStopVisibility(sys);
  }
  function syncStopVisibility(sys) {
    if (!sys.stopLayer) return;
    const on = shown(sys) && map.getZoom() >= sys.stopZoom;
    if (on && !map.hasLayer(sys.stopLayer)) sys.stopLayer.addTo(map);
    else if (!on && map.hasLayer(sys.stopLayer)) map.removeLayer(sys.stopLayer);
  }

  /* ---------------- realtime: positions ---------------- */
  async function loadVehicles(sys) {
    let feed, via = "protobuf";
    try { feed = decode(await (await apiFetch(rt(sys, "vehicle-positions"))).arrayBuffer()); }
    catch (e) {
      // The producer also serves the same positions as JSON; use it if the protobuf feed fails.
      try { feed = C.jsonListToFeed(await (await apiFetch("/realtime/vehicle-positions/list?agency=" + encodeURIComponent(sys.id))).json()); via = "json"; }
      catch (e2) { vehicleFailure(sys, e); throw e; }
    }
    const res = C.processVehicles(feed, sys.idx, { maxAgeSec: CFG.maxVehicleAgeSec, staleSec: CFG.staleVehicleSec,
      speedUnit: sys.speedUnit, area: sys.area, agency: sys.id, platePattern: sys.platePattern });
    sys.lastOk = nowS();
    res.vehicles.forEach(v => { if (!v.routeId && !v.routeCode && sys.mode === "bus") inferRoute(sys, v); });
    const seen = new Set();
    res.vehicles.forEach(v => {
      seen.add(v.id);
      if (sys.static && sys.static.schedule && v.tripId) {
        const info = C.tripUpcoming(sys.static, v.tripId, { delay: sys.trip.delays.get(v.tripId) });
        if (info) { v.headsign = info.headsign; v.upcoming = info.upcoming; }
        v.delay = sys.trip.delays.has(v.tripId) ? sys.trip.delays.get(v.tripId) : null;
      }
      sys.live.set(v.id, v);
    });
    [...sys.live.keys()].forEach(id => { if (!seen.has(id)) sys.live.delete(id); });
    const st = res.stats, age = res.headerTs ? nowS() - res.headerTs : null;
    const parts = [plural(res.vehicles.length, sys) + " with live GPS"];
    if (st.total) parts.push(st.total + " records in feed" + (st.stale ? ", " + st.stale + " expired" : "") + (st.foreign ? ", " + st.foreign + " other services" : "") + (st.duplicate ? ", " + st.duplicate + " duplicates" : ""));
    if (age != null) parts.push("feed generated " + C.ago(age));
    if (via === "json") parts.push("via JSON fallback");
    const empty = res.vehicles.length === 0;
    setFeed(sys, "vehicles", (age != null && age > 300) || (empty && sys.mode === "bus") ? "warn" : "ok", parts.join(" · "));
    if (sys.gpsEmpty && !empty) toast("✓ Live " + sys.one + " GPS is back");
    sys.gpsEmpty = empty;
    if (sys.mode === "bus") {
      const kind = $("#banner").dataset.kind;
      let dismissed = false; try { dismissed = sessionStorage.getItem("lmt-empty-dismissed") === "1"; } catch (e) { /* ignore */ }
      if (empty && kind !== "empty" && !dismissed) {
        banner("empty", "<b>Live bus GPS is offline</b> — showing ⏱ scheduled buses. " +
          '<details><summary>Why?</summary>LMT\'s live feed is online but no buses are reporting, so buses are placed where the LMT timetable says they should be. ' +
          "Real GPS buses replace them automatically as soon as the provider publishes positions again.</details>");
      } else if (!empty && (kind === "net" || kind === "empty")) banner();
    }
    if (sys.schedule) updateEstimates(sys, true);
    reconcile();
  }
  /**
   * Work out a GPS bus's route from where it drives: routes whose line is within 120 m, narrowed
   * down across updates (a bus on a stretch shared by CM01 and CM03 resolves once it turns off it).
   */
  const routeGuess = new Map();
  function inferRoute(sys, v) {
    if (!sys.static) return;
    const cands = new Set(C.routeCandidates(sys.static, v.lat, v.lon, 120).map(c => c.routeId));
    const key = sys.id + ":" + v.id, prev = routeGuess.get(key);
    let set = cands;
    if (prev && prev.size) { const inter = new Set([...cands].filter(r => prev.has(r))); set = inter.size ? inter : cands.size ? cands : prev; }
    routeGuess.set(key, set);
    const codes = [...set].map(r => (sys.idx.byId.get(r) || {}).short).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (set.size === 1) { v.routeId = [...set][0]; v.routeCode = codes[0]; v.inferred = true; }
    else if (set.size > 1) { v.routeCode = codes.length > 2 ? codes.slice(0, 2).join("/") + "…" : codes.join("/"); v.routeOptions = codes; v.inferred = true; }
    else v.routeCode = "LMT";
  }
  function vehicleFailure(sys, e) {
    if (sys.mode === "train") {
      // Trains keep running from the timetable; only report it.
      setFeed(sys, "vehicles", "err", (e.kind === "http" && e.status < 500 ? "no live train positions published" : e.message) + " — showing timetable positions");
      sys.live.clear(); if (sys.schedule) updateEstimates(sys, true); reconcile();
      return;
    }
    setFeed(sys, "vehicles", "err", e.message);
    if (e.kind === "network") {
      banner("net", "<b>Can't reach the live bus feed.</b> Either you're offline or the feed server isn't allowing this site to read it (CORS). " +
        "Retrying automatically. Site owners: deploy <code>proxy/cloudflare-worker.js</code> and open this page with <code>?api=&lt;worker-url&gt;/api/v1</code>.");
    } else banner("net", "<b>Live bus feed error:</b> " + esc(e.message) + ". Retrying automatically.");
    renderVehicles();
  }
  /** Timetable positions for trips without live GPS. */
  function updateEstimates(sys, quiet) {
    if (!sys.static || !sys.static.schedule) { sys.est = []; return; }
    const live = [...sys.live.values()].filter(v => !v.stale);
    const skip = new Set(live.map(v => v.tripId).filter(Boolean));
    // Bus trip ids in the GPS feed are synthetic, so a route with live buses shows only those.
    const skipRoutes = sys.mode === "bus" ? new Set(live.map(v => v.routeId).filter(Boolean)) : null;
    // With real GPS buses on the map, timetable positions would only mix in guesses: show the real ones only.
    if (sys.mode === "bus" && live.length >= 3) { sys.est = []; if (!quiet) reconcile(); return; }
    sys.est = C.scheduledVehicles(sys.static, { delays: sys.trip.delays, cancelled: sys.trip.cancelled, skip, skipRoutes,
      preDepartSec: (sys.preDepartMin || 0) * 60 });
    if (!quiet) reconcile();
  }

  /** Merge every system's vehicles, then add/move/remove markers. */
  function reconcile() {
    const next = new Map();
    S.systems.forEach(sys => {
      sys.live.forEach(v => { v.sys = sys; v.key = sys.id + ":" + v.id; next.set(v.key, v); });
      sys.est.forEach(v => { v.sys = sys; v.key = sys.id + ":" + v.id; if (!next.has(v.key)) next.set(v.key, v); });
    });
    // Vehicles waiting at the same station would sit on top of each other: give each a slot in a small ring.
    const groups = new Map();
    next.forEach(v => { const k = v.sys.id + "|" + (v.atStop || (v.lat.toFixed(4) + "," + v.lon.toFixed(4))); (groups.get(k) || groups.set(k, []).get(k)).push(v); });
    groups.forEach(list => list.sort((a, b) => (a.departsAt || 0) - (b.departsAt || 0) || a.key.localeCompare(b.key))
      .forEach((v, i) => { v.slot = list.length > 1 ? [i, list.length] : null; }));
    next.forEach(v => {
      const prev = S.prevPos.get(v.key);
      if (v.bearing == null && prev) {
        v.bearing = C.distanceM(prev.lat, prev.lon, v.lat, v.lon) > 15 ? C.bearingDeg(prev.lat, prev.lon, v.lat, v.lon) : prev.bearing;
      }
      S.prevPos.set(v.key, { lat: v.lat, lon: v.lon, bearing: v.bearing });
      if (!v.scheduled) v.near = C.nearestStop(v.sys.idx, v.lat, v.lon);
      upsertMarker(v);
    });
    S.all.forEach((v, key) => {
      if (next.has(key)) return;
      const m = S.markers.get(key); if (m) { map.removeLayer(m); S.markers.delete(key); }
      S.prevPos.delete(key);
      if (S.following === key) S.following = null;
    });
    S.all = next;
    renderCounts(); renderVehicles(); if (S.tab === "routes") renderRoutes();
    refreshOpenPopup(); updateStatus();
    if (S.following && S.all.has(S.following)) { const v = S.all.get(S.following); map.panTo([v.lat, v.lon], { animate: true }); }
  }

  /* ---------------- 3D vehicle markers ---------------- */
  // Side-on, three-quarter view vehicles drawn in the route colour. Facing right by default;
  // mirrored when heading west so they always face their direction of travel.
  function busSvg(flip) {
    return '<svg class="g" viewBox="0 0 60 40" aria-hidden="true"><ellipse cx="30" cy="36.4" rx="25" ry="2.8" class="gs"/>' +
      '<g' + (flip ? ' transform="matrix(-1 0 0 1 60 0)"' : "") + ">" +
      '<path d="M7 7 L48 7 L53 3.8 L12 3.8 Z" fill="var(--c)"/><path d="M7 7 L48 7 L53 3.8 L12 3.8 Z" fill="#fff" opacity=".5"/>' +
      '<rect x="5" y="6.6" width="44" height="25.4" rx="3.4" fill="var(--c)"/>' +
      '<path d="M48.6 6.8 L53 3.8 Q57.2 4.3 57.2 9 L57.2 29.2 Q57.2 31.2 55 31.5 L48.6 32 Z" fill="var(--c)"/>' +
      '<path d="M48.6 6.8 L53 3.8 Q57.2 4.3 57.2 9 L57.2 29.2 Q57.2 31.2 55 31.5 L48.6 32 Z" fill="#000" opacity=".24"/>' +
      '<path d="M50.2 9.2 L55.6 6.6 L55.6 18.4 L50.2 19.6 Z" fill="#17222d"/><path d="M50.8 18.6 L55 12 L55.6 12 L55.6 13.6 L52.4 18.3Z" fill="#fff" opacity=".25"/>' +
      '<rect x="8" y="9.8" width="38.4" height="9.4" rx="1.6" fill="#17222d"/>' +
      '<path d="M17.6 9.8v9.4M27.2 9.8v9.4M36.8 9.8v9.4" stroke="var(--c)" stroke-width="1.6"/>' +
      '<path d="M9 19 L15 9.8 L18.6 9.8 L12.6 19Z M28 19 L34 9.8 L36 9.8 L30 19Z" fill="#fff" opacity=".2"/>' +
      '<rect x="5" y="22.6" width="44" height="2.6" fill="#fff" opacity=".88"/>' +
      '<rect x="40.6" y="20.4" width="5.6" height="11" rx="1" fill="#17222d" opacity=".88"/>' +
      '<rect x="5" y="6.6" width="44" height="13" rx="3.4" fill="url(#lmtShine)"/>' +
      '<circle cx="55.2" cy="27.4" r="1.4" fill="#ffe08a"/><rect x="49.4" y="28.6" width="7" height="1.6" rx=".8" fill="#000" opacity=".35"/>' +
      '<g class="wh"><circle cx="15" cy="32" r="4.7" fill="#1b1b1b"/><circle cx="15" cy="32" r="2.1" fill="#c9ccd1"/><rect x="14.5" y="29.9" width="1" height="4.2" fill="#555"/></g>' +
      '<g class="wh"><circle cx="41" cy="32" r="4.7" fill="#1b1b1b"/><circle cx="41" cy="32" r="2.1" fill="#c9ccd1"/><rect x="40.5" y="29.9" width="1" height="4.2" fill="#555"/></g>' +
      "</g></svg>";
  }
  function trainSvg(flip) {
    const win = [7, 15, 23, 31, 39, 47].map(x => '<rect x="' + x + '" y="9" width="6.4" height="6.6" rx="1" fill="#17222d"/>').join("");
    return '<svg class="g" viewBox="0 0 74 36" aria-hidden="true"><ellipse cx="37" cy="33" rx="33" ry="2.4" class="gs"/>' +
      '<g' + (flip ? ' transform="matrix(-1 0 0 1 74 0)"' : "") + ">" +
      '<path d="M4 6 L57 6 L61 3.4 L8 3.4 Z" fill="var(--c)"/><path d="M4 6 L57 6 L61 3.4 L8 3.4 Z" fill="#fff" opacity=".5"/>' +
      '<rect x="3" y="5.8" width="55" height="21.4" rx="2.6" fill="var(--c)"/>' +
      '<path d="M57.6 5.9 L61 3.4 Q69 4.8 71 15 L71 25 Q71 27.2 68.6 27.2 L57.6 27.2 Z" fill="var(--c)"/>' +
      '<path d="M57.6 5.9 L61 3.4 Q69 4.8 71 15 L71 25 Q71 27.2 68.6 27.2 L57.6 27.2 Z" fill="#000" opacity=".22"/>' +
      '<path d="M60 7.6 L62.4 5.8 Q67.4 7.4 69.2 14.4 L60 14.8 Z" fill="#17222d"/><path d="M61 14 L64 7 L65.4 7.6 L62.6 14Z" fill="#fff" opacity=".25"/>' +
      win + '<path d="M8 15.6 L11 9 L12.6 9 L9.6 15.6Z M32 15.6 L35 9 L36.6 9 L33.6 15.6Z" fill="#fff" opacity=".2"/>' +
      '<rect x="3" y="19.4" width="68" height="2.6" fill="#ffcc33"/>' +
      '<rect x="3" y="5.8" width="55" height="10" rx="2.6" fill="url(#lmtShine)"/>' +
      '<circle cx="69.4" cy="23.6" r="1.3" fill="#ffe08a"/>' +
      '<rect x="8" y="27" width="16" height="3.2" rx="1.2" fill="#2a2a2a"/><rect x="46" y="27" width="16" height="3.2" rx="1.2" fill="#2a2a2a"/>' +
      [11.5, 20.5, 49.5, 58.5].map(x => '<g class="wh"><circle cx="' + x + '" cy="30.4" r="2.6" fill="#1b1b1b"/><circle cx="' + x + '" cy="30.4" r="1" fill="#aaa"/></g>').join("") +
      "</g></svg>";
  }
  function markerHtml(v) {
    const r = routeOf(v); const train = v.sys.mode === "train";
    const color = r ? r.color : "#46505a", text = r ? r.text : "#fff";
    const code = r ? r.short : (v.routeCode || (train ? "Train" : "Bus"));
    const flip = v.bearing != null && v.bearing > 190 && v.bearing < 350;
    const moving = !v.stale && !v.waiting && (v.scheduled ? !v.atStop : (v.speedKmh == null ? false : v.speedKmh > 3));
    const late = v.delay != null && v.delay >= 300;
    const wait = v.waiting ? Math.max(0, Math.round((v.departsAt - nowS()) / 60)) : null;
    const cls = "veh " + (train ? "train" : "bus") + (v.scheduled ? " est" : " gps") + (v.stale ? " stale" : "") + (moving ? " moving" : "") +
      (v.waiting ? " wait" : "") + (S.openKey === "veh:" + v.key ? " sel" : "") + (S.following === v.key ? " fol" : "") + (inFocus(v) ? "" : " dim");
    return '<div class="' + cls + '" style="--c:' + color + ";--t:" + text + '"><span class="ring"></span><span class="bob">' + (train ? trainSvg(flip) : busSvg(flip)) + "</span>" +
      '<span class="tag">' + (v.scheduled ? '<i class="clk" title="Estimated from timetable"></i>' : '<i class="live" title="Live GPS"></i>') + esc(code) +
      (wait != null ? '<b class="dp">' + (wait < 1 ? "now" : wait + "′") + "</b>" : late ? '<b class="lt">+' + Math.round(v.delay / 60) + "</b>" : "") + "</span></div>";
  }
  function iconFor(v) {
    const train = v.sys.mode === "train";
    const size = train ? [66, 50] : [54, 54], anchor = train ? [33, 30] : [27, 34];
    // Fan out vehicles sharing a station on a small ring (pixels, so it works at every zoom).
    if (v.slot) { const [i, n] = v.slot, a = Math.PI + (2 * Math.PI * i) / n, rx = (train ? 36 : 30) + 3 * Math.min(n, 6), ry = 24 + 3 * Math.min(n, 6);
      anchor[0] -= Math.round(Math.cos(a) * rx); anchor[1] -= Math.round(Math.sin(a) * ry); }
    return L.divIcon({ className: "veh-wrap", html: markerHtml(v), iconSize: size, iconAnchor: anchor, popupAnchor: [size[0] / 2 - anchor[0], 4 - anchor[1]] });
  }
  function upsertMarker(v) {
    const hide = !shown(v.sys) || (v.routeId && S.hiddenRoutes.has(v.sys.id + ":" + v.routeId)) || (S.focus && !inFocus(v));
    let m = S.markers.get(v.key);
    if (hide) { if (m) { map.removeLayer(m); S.markers.delete(v.key); } return; }
    const html = markerHtml(v) + (v.slot ? v.slot.join("/") : "");
    if (!m) {
      const key = v.key;
      m = L.marker([v.lat, v.lon], { pane: "vehicles", icon: iconFor(v), keyboard: true, riseOnHover: true,
        title: (v.sys.mode === "train" ? "Train " : "Bus ") + (v.headsign || v.label) });
      m._html = html;
      m.bindPopup(() => vehiclePopup(S.all.get(key) || v), popOpts(240));
      m.on("popupopen", () => { S.openKey = "veh:" + key; setHash(v.sys.mode, v.id); restyle(key); });
      m.on("popupclose", () => { if (S.openKey === "veh:" + key) { S.openKey = null; setHash(); } restyle(key); });
      m.addTo(map); S.markers.set(key, m);
    } else {
      if (m._html !== html) { m.setIcon(iconFor(v)); m._html = html; }
      glide(m, [v.lat, v.lon]);
    }
  }
  function restyle(key) { const v = S.all.get(key), m = S.markers.get(key); if (v && m) { m._html = markerHtml(v) + (v.slot ? v.slot.join("/") : ""); m.setIcon(iconFor(v)); } }
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function glide(m, to) {
    const from = m.getLatLng(); if (from.lat === to[0] && from.lng === to[1]) return;
    if (reduceMotion || document.hidden || C.distanceM(from.lat, from.lng, to[0], to[1]) > 3000) { m.setLatLng(to); return; }
    const t0 = performance.now(), dur = 1200; cancelAnimationFrame(m._raf);
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]); if (k < 1) m._raf = requestAnimationFrame(step); };
    m._raf = requestAnimationFrame(step);
  }

  /* ---------------- popups ---------------- */
  const shareBtn = (hash, title) => '<button class="ib" data-share="' + esc(hash) + '" data-title="' + esc(title) + '" title="Share" aria-label="Share link">' + ICON.share + "</button>";
  const favBtn = key => '<button class="ib fav' + (S.favs.has(key) ? " on" : "") + '" data-fav="' + esc(key) + '" title="' + (S.favs.has(key) ? "Remove from saved" : "Save this stop") + '" aria-pressed="' + S.favs.has(key) + '">' + (S.favs.has(key) ? "★" : "☆") + "</button>";
  const ICON = { share: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
  function relTime(t) { const m = Math.round((t - nowS()) / 60); return m <= 0 ? "now" : m < 60 ? "in " + m + " min" : "at " + clock(t); }
  /** Origin → destination bar with the share of the trip done. */
  function progressBar(sys, v) {
    if (v.progress == null || !v.origin || !v.dest) return "";
    return '<div class="prog"><div class="pe"><span>' + esc(stopName(sys, v.origin)) + "</span><span>" + esc(stopName(sys, v.dest)) + "</span></div>" +
      '<div class="pb"><i style="width:' + Math.round(v.progress * 100) + '%"></i><b style="left:' + Math.round(v.progress * 100) + '%"></b></div></div>';
  }
  /** Stop-by-stop timeline: passed stops greyed, the current/next one highlighted. Long trips collapse their middle. */
  function timeline(sys, v) {
    const tl = v.timeline; if (!tl || tl.length < 2) return "";
    const cur = tl.findIndex(x => !x.passed);
    const rows = tl.map((x, i) => ({ x, i, cls: x.passed ? "past" : i === cur ? (v.atStop === x.stopId ? "here" : "next") : "" }));
    let show = rows;
    if (rows.length > 9) { const keep = new Set([0, rows.length - 1]); for (let i = Math.max(0, cur - 1); i <= Math.min(rows.length - 1, cur + 4); i++) keep.add(i); show = rows.filter(r => keep.has(r.i)); }
    let prevI = -1;
    return '<ol class="tl">' + show.map(r => { const gap = r.i - prevI > 1 ? '<li class="gap">⋮ ' + (r.i - prevI - 1) + " stops</li>" : ""; prevI = r.i;
      return gap + '<li class="' + r.cls + '"><time>' + esc(clock(r.x.time)) + "</time><span>" + esc(stopName(sys, r.x.stopId)) + "</span></li>"; }).join("") + "</ol>";
  }
  function vehiclePopup(v) {
    const sys = v.sys, r = routeOf(v), train = sys.mode === "train";
    const age = v.ts ? nowS() - v.ts : null;
    const title = train || v.scheduled ? (v.headsign || v.label) : v.label;
    let h = '<div class="pop vp"><div class="ph">' + badge(r, v.routeCode) + '<div class="pt2"><b>' + esc(title) + "</b>" + (r && r.long ? "<small>" + esc(r.long) + "</small>" : "") + "</div></div>";
    h += '<div class="src ' + (v.scheduled ? "est" : "gps") + '">' + (v.scheduled ? (train ? "⏱ Timetable position" : "⏱ Scheduled position — no live GPS") + (v.delay != null ? " · live delay applied" : "") : "● Live GPS") + "</div>";
    const facts = [];
    if (v.waiting) facts.push(["Departs", "<b>" + esc(relTime(v.departsAt)) + "</b> · " + esc(clock(v.departsAt)) + " from " + esc(stopName(sys, v.atStop))]);
    else if (v.atStop) facts.push(["Now at", esc(stopName(sys, v.atStop))]);
    else if (v.stopId && sys.idx.stops[v.stopId]) facts.push(["Status", esc((C.STOP_STATUS[v.status] || "Next stop") + " " + stopName(sys, v.stopId))]);
    else if (v.near && v.near.distance < 1500) facts.push(["Near", esc(v.near.stop.name) + " (" + dist(v.near.distance) + ")"]);
    const nx = !v.waiting && (v.upcoming || [])[0];
    if (nx) facts.push(["Next stop", esc(stopName(sys, nx.stopId)) + " · <b>" + esc(relTime(nx.time)) + "</b> (" + esc(clock(nx.time)) + ")"]);
    if ((train || v.scheduled) && v.dest) facts.push(["To", esc(stopName(sys, v.dest))]);
    if (train && v.delay != null) facts.push(["Running", delayChip(v.delay) + " " + esc(delayText(v.delay))]);
    if (!train && !v.scheduled) facts.push(["Bus", "<b>" + esc(v.label) + "</b>"]);
    if (v.inferred) facts.push(["Route", v.routeOptions ? "one of " + esc(v.routeOptions.join(", ")) + ' <em class="st">shared road — narrows as it moves</em>' : esc(v.routeCode) + ' <em class="st">worked out from its position</em>']);
    else if (!v.routeId && !v.scheduled && !train) facts.push(["Route", '<span class="muted">not reported by the feed</span>']);
    if (v.speedKmh != null) facts.push(["Speed", Math.round(v.speedKmh) + " km/h"]);
    const occ = v.occupancy && C.OCCUPANCY[v.occupancy];
    if (occ) facts.push(["Crowding", occ[1] + (v.occupancyPct != null ? " (" + v.occupancyPct + "%)" : "")]);
    if (!v.scheduled) facts.push(["Updated", age != null ? C.ago(age) + (v.stale ? ' <em class="st">signal delayed</em>' : "") : "—"]);
    h += '<dl class="facts">' + facts.map(f => "<dt>" + f[0] + "</dt><dd>" + f[1] + "</dd>").join("") + "</dl>";
    h += progressBar(sys, v);
    if (v.timeline) h += '<details class="tlw"' + (S.tlOpen ? " open" : "") + '><summary>Stops &amp; times' + (v.scheduled && v.delay == null ? " (timetable)" : "") + "</summary>" + timeline(sys, v) + "</details>";
    else {
      const next = (v.upcoming || (sys.trip.byVehicle.get(v.id) || []).filter(x => !x.skipped).map(x => ({ stopId: x.stopId, time: x.time }))).filter(x => x.time >= nowS() - 30).slice(0, 4);
      if (next.length) h += '<div class="nx"><div class="nh">Next stops</div>' + next.map(x => '<div class="kv"><span>' + esc(clock(x.time)) + "</span>" + esc(stopName(sys, x.stopId)) + "</div>").join("") + "</div>";
    }
    if (v.scheduled && !train) h += '<div class="muted xs">No live GPS for this route right now — this is where the timetable says the bus should be.</div>';
    h += '<div class="acts"><button class="btn" data-follow="' + esc(v.key) + '">' + (S.following === v.key ? "✓ Following" : "Follow " + sys.one) + "</button>" +
      (r ? '<button class="btn ghost" data-focus="' + esc(sys.id + ":" + r.id) + '">Only ' + esc(r.short) + "</button>" : "") + shareBtn(sys.mode + "=" + v.id, title) + "</div></div>";
    return h;
  }
  function stopPopup(sys, s) {
    const arr = (sys.trip.byStop.get(s.id) || []).filter(x => x.time >= nowS() - 30 && !S.hiddenRoutes.has(sys.id + ":" + x.routeId)).slice(0, 6);
    let h = '<div class="pop"><div class="ph"><span class="stopi lg" aria-hidden="true"></span><div class="pt2"><b>' + esc(s.name) + "</b><small>Bus stop" + (s.code ? " · " + esc(s.code) : "") + "</small></div>" + favBtn(sys.id + ":" + s.id) + "</div>";
    if (arr.length) {
      h += '<div class="arr">' + arr.map(x => {
        const m = C.minutesUntil(x.time); const r = sys.idx.byId.get(x.routeId);
        const when = x.cancelled ? "Cancelled" : x.skipped ? "Skips stop" : m <= 0 ? "Due" : m + " min";
        return '<div class="ar' + (x.cancelled || x.skipped ? " off" : "") + '">' + badge(r, x.routeCode) + '<span class="w">' + esc(x.vehicleId || "") + "</span><b>" + when + '</b><span class="tm">' + clock(x.time) + "</span></div>";
      }).join("") + "</div>";
    } else {
      const deps = sys.static && sys.static.schedule ? C.departures(sys.static, s.id, { limit: 4, horizonSec: 2 * 3600 }) : [];
      if (deps.length) h += '<div class="nh">Scheduled (no live predictions)</div><div class="arr">' + deps.map(d => '<div class="ar">' + badge(sys.idx.byId.get(d.routeId)) + '<span class="w">' + esc(d.headsign) + "</span><b>" + esc(relTime(d.time)) + '</b><span class="tm">' + clock(d.time) + "</span></div>").join("") + "</div>";
      else h += '<div class="muted sm">No live arrival predictions for this stop right now.</div>';
      const near = [...S.all.values()].filter(v => v.sys === sys).map(v => ({ v, d: C.distanceM(v.lat, v.lon, s.lat, s.lon) })).filter(x => x.d < 3000).sort((a, b) => a.d - b.d).slice(0, 3);
      if (near.length) h += '<div class="nx"><div class="nh">Buses nearby</div>' + near.map(x => '<div class="kv">' + badge(routeOf(x.v), x.v.routeCode) + " " + esc(x.v.headsign || x.v.label) + " · " + dist(x.d) + "</div>").join("") + "</div>";
    }
    return h + '<div class="acts">' + shareBtn("stop=" + s.id, s.name) + "</div></div>";
  }
  function stationPopup(sys, s) {
    const deps = C.departures(sys.static, s.id, { delays: sys.trip.delays, cancelled: sys.trip.cancelled, limit: 8 })
      .filter(d => !S.hiddenRoutes.has(sys.id + ":" + d.routeId));
    let h = '<div class="pop"><div class="ph"><span class="stopi rail lg" aria-hidden="true"></span><div class="pt2"><b>' + esc(s.name) + "</b><small>Railway station</small></div>" + favBtn(sys.id + ":" + s.id) + "</div>";
    if (!deps.length) return h + '<div class="muted sm">No trains due in the next 3 hours.</div><div class="acts">' + shareBtn("station=" + s.id, s.name) + "</div></div>";
    h += '<div class="board"><div class="bh"><span>Time</span><span>Train</span><span>Status</span></div>' + deps.map(d => {
      const r = sys.idx.byId.get(d.routeId); const m = C.minutesUntil(d.time);
      const status = d.cancelled ? '<b class="bad">Cancelled</b>' : d.delay != null ? delayChip(d.delay) : '<span class="muted">Scheduled</span>';
      return '<div class="br' + (d.cancelled ? " off" : "") + '"><span class="tm"><b>' + esc(clock(d.planned)) + "</b>" + (d.delay != null && Math.abs(d.delay) >= 60 && !d.cancelled ? "<i>" + esc(clock(d.time)) + "</i>" : "") +
        '</span><span class="hd">' + badge(r) + " " + esc(d.arrivalOnly ? "Arrival from " + d.headsign.split("→")[0].trim() : d.headsign) + '</span><span class="stt">' + status +
        '<i class="in">' + (m <= 0 ? "now" : m < 60 ? m + " min" : "") + "</i></span></div>";
    }).join("") + "</div>";
    h += '<div class="muted xs">Times from the SLR timetable' + (sys.trip.delays.size ? "; delays are live where reported." : ". No live delay data is published right now.") + "</div>";
    return h + '<div class="acts">' + shareBtn("station=" + s.id, s.name) + "</div></div>";
  }
  function refreshOpenPopup() {
    if (!S.openKey) return;
    const parts = S.openKey.split(":"), kind = parts[0];
    if (kind === "veh") {
      const key = parts.slice(1).join(":"); const m = S.markers.get(key); const v = S.all.get(key);
      if (m && v && m.isPopupOpen()) m.setPopupContent(vehiclePopup(v));
      return;
    }
    const sys = sysById(parts[1]); const id = parts.slice(2).join(":"); if (!sys) return;
    const m = sys.stopMarkers.get(id); if (!m || !m.isPopupOpen()) return;
    m.setPopupContent(kind === "station" ? stationPopup(sys, sys.idx.stops[id]) : stopPopup(sys, sys.idx.stops[id]));
  }
  document.addEventListener("click", e => {
    const fav = e.target.closest("[data-fav]");
    if (fav) { const k = fav.dataset.fav; if (S.favs.has(k)) S.favs.delete(k); else S.favs.add(k); store.set("lmt-favs", [...S.favs]);
      toast(S.favs.has(k) ? "★ Saved — find it at the top of Stops" : "Removed from saved"); refreshOpenPopup(); renderStops(); return; }
    const sh = e.target.closest("[data-share]");
    if (sh) { share(sh.dataset.share, sh.dataset.title); return; }
    const fo = e.target.closest("[data-focus]");
    if (fo) { const k = fo.dataset.focus, i = k.indexOf(":"); setFocus(k); showRoute(sysById(k.slice(0, i)), k.slice(i + 1)); return; }
    if (e.target.closest("[data-unfocus]")) { setFocus(null); return; }
    if (e.target.closest("[data-showall]")) {
      S.hiddenRoutes.clear(); store.set("lmt-hidden-routes-v2", []);
      S.systems.forEach(syncRouteVisibility); setMode("all", false); toast("Showing every route"); return;
    }
    const b = e.target.closest("[data-follow]"); if (!b) return;
    const key = b.dataset.follow; const prev = S.following; S.following = S.following === key ? null : key;
    const v = S.all.get(key); if (S.following && v) map.setView([v.lat, v.lon], Math.max(map.getZoom(), v.sys.mode === "train" ? 13 : 15));
    toast(S.following ? "Following " + (v ? (v.headsign || v.label) : "") : "Stopped following");
    if (prev) restyle(prev); restyle(key); refreshOpenPopup();
  });

  document.addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("tlw")) S.tlOpen = e.target.open; }, true);
  async function share(hash, title) {
    const url = location.origin + location.pathname + location.search + "#" + hash;
    try {
      if (navigator.share) { await navigator.share({ title: (title || "LMT Live") + " — LMT Live", url }); return; }
      await navigator.clipboard.writeText(url); toast("Link copied");
    } catch (e) { if (e && e.name !== "AbortError") prompt("Copy this link:", url); }
  }
  /** Single out one route: other routes' vehicles hide, their lines fade, lists filter. */
  function setFocus(key) {
    S.focus = key || null;
    S.systems.forEach(sys => sys.routeLayers.forEach((g, id) => g.setStyle({ opacity: !S.focus || S.focus === sys.id + ":" + id ? (sys.mode === "train" ? 0.7 : 0.8) : 0.12 })));
    S.all.forEach(upsertMarker); refreshAll();
    if (key) { const i = key.indexOf(":"), r = sysById(key.slice(0, i)).idx.byId.get(key.slice(i + 1)); toast("Showing only " + (r ? r.short : "this route") + " · Esc to show all"); }
  }

  /* ---------------- realtime: predictions + alerts ---------------- */
  async function loadTripUpdates(sys) {
    try {
      const feed = decode(await (await apiFetch(rt(sys, "trip-updates"))).arrayBuffer());
      sys.trip = C.processTripUpdates(feed, sys.idx, { agency: sys.id });
      const n = sys.trip.count;
      setFeed(sys, "tripUpdates", "ok", n ? n + " trips with live predictions" + (sys.trip.delays.size ? ", " + sys.trip.delays.size + " with delays" : "") : "no predictions published right now");
      if (sys.schedule) updateEstimates(sys);
      refreshOpenPopup(); if (S.tab === "stops") renderStops();
    } catch (e) {
      setFeed(sys, "tripUpdates", "err", e.kind === "http" && e.status < 500 ? "not published" : e.message);
      throw e;
    }
  }
  async function loadAlerts(sys) {
    try {
      const feed = decode(await (await apiFetch(rt(sys, "alerts"))).arrayBuffer());
      sys.alerts = C.processAlerts(feed, sys.idx, { agency: sys.id, languages: [(navigator.language || "en").split("-")[0], "en"] });
      sys.alerts.forEach(a => { a.sys = sys; });
      setFeed(sys, "alerts", "ok", sys.alerts.length ? sys.alerts.length + " active" : "no active alerts");
      renderCounts(); renderAlerts();
    } catch (e) {
      setFeed(sys, "alerts", "err", e.kind === "http" && e.status < 500 ? "not published" : e.message);
      throw e;
    }
  }

  /* ---------------- panel rendering ---------------- */
  /** Replace a container's HTML only when it changed, so hover, focus and scroll survive the frequent refreshes. */
  function setHTML(el, html) { if (el._html !== html) { el._html = html; const top = el.parentNode ? el.parentNode.scrollTop : 0; el.innerHTML = html; if (el.parentNode) el.parentNode.scrollTop = top; } }
  const inFocus = v => !S.focus || S.focus === v.sys.id + ":" + v.routeId;
  const match = (q, ...fields) => !q || fields.some(f => String(f || "").toLowerCase().includes(q));
  const visibleSystems = () => S.systems.filter(shown);
  const visibleVehicles = () => [...S.all.values()].filter(v => shown(v.sys));
  // The realtime endpoints ignore ?agency=, so the same alert can reach both systems: de-duplicate.
  const allAlerts = () => { const seen = new Set(); return visibleSystems().flatMap(s => s.alerts).filter(a => { const k = a.id + "|" + a.header; if (seen.has(k)) return false; seen.add(k); return true; }); };
  function refreshAll() { renderCounts(); renderVehicles(); renderRoutes(); renderStops(); renderAlerts(); }
  function renderCounts() {
    const vs = visibleSystems();
    $("#c-vehicles").textContent = visibleVehicles().length;
    $("#c-routes").textContent = vs.reduce((n, s) => n + (s.static ? s.static.routes.length : 0), 0);
    $("#c-stops").textContent = vs.reduce((n, s) => n + s.idx.platforms.length, 0);
    const na = allAlerts().length; $("#c-alerts").textContent = na; $("#c-alerts").classList.toggle("hot", na > 0);
  }

  function vehicleRow(v) {
    const sys = v.sys, r = routeOf(v), train = sys.mode === "train";
    const age = v.ts ? nowS() - v.ts : null;
    const nx = (v.upcoming || [])[0];
    let where;
    if (v.waiting) where = "Departs " + clock(v.departsAt) + " · " + relTime(v.departsAt) + " · " + stopName(sys, v.atStop);
    else if (train || v.scheduled) where = v.atStop ? "At " + stopName(sys, v.atStop) + (nx ? " · next " + stopName(sys, nx.stopId) : "") : nx ? "Next: " + stopName(sys, nx.stopId) + " · " + relTime(nx.time) : "";
    else where = v.stopId && sys.idx.stops[v.stopId] ? (C.STOP_STATUS[v.status] || "Next") + " " + stopName(sys, v.stopId) : v.near && v.near.distance < 1500 ? "Near " + v.near.stop.name : (r && r.long) || "";
    const meta = v.waiting ? '<span class="src wt">⏳ waiting to depart</span>' : v.scheduled ? '<span class="src est">⏱ timetable</span>' : '<span class="src gps">● GPS</span>' + (v.speedKmh != null ? Math.round(v.speedKmh) + " km/h · " : " ") + (age != null ? C.ago(age) : "");
    const occ = v.occupancy && C.OCCUPANCY[v.occupancy];
    const bar = v.progress != null && !v.waiting ? '<span class="mini"><i style="width:' + Math.round(v.progress * 100) + '%"></i></span>' : "";
    return '<button class="row' + (v.stale ? " stale" : "") + (v.waiting ? " waiting" : "") + (S.openKey === "veh:" + v.key ? " cur" : "") + '" data-veh="' + esc(v.key) + '"><span class="vi ' + (train ? "train" : "bus") + '" style="--c:' + (r ? r.color : "#46505a") + '"></span>' + badge(r, v.routeCode) +
      '<span class="main"><span class="t">' + esc(train || v.scheduled ? (v.headsign || v.label) : v.label) + "</span>" +
      '<span class="s">' + esc(where) + "</span>" + bar + '<span class="m">' + meta + "</span></span>" +
      (train ? delayChip(v.delay) : occ ? '<span class="chip ' + occ[0] + '">' + occ[1] + "</span>" : "") + "</button>";
  }
  /** Saved filters (hidden routes, Buses/Trains only) persist between visits — say so, so nothing looks "missing". */
  function filterNotice() {
    const parts = [];
    const hidden = [...S.hiddenRoutes].filter(k => { const i = k.indexOf(":"), sys = sysById(k.slice(0, i)); return sys && shown(sys) && sys.idx.byId.has(k.slice(i + 1)); });
    const hiddenVeh = [...S.all.values()].filter(v => shown(v.sys) && v.routeId && S.hiddenRoutes.has(v.sys.id + ":" + v.routeId)).length;
    if (hidden.length) parts.push(hidden.length + " route" + (hidden.length > 1 ? "s" : "") + " hidden" + (hiddenVeh ? " (" + hiddenVeh + " vehicle" + (hiddenVeh > 1 ? "s" : "") + ")" : ""));
    if (S.mode !== "all") parts.push("showing " + (S.mode === "bus" ? "buses" : "trains") + " only");
    if (!parts.length) return "";
    return '<div class="focus note">⚠ ' + esc(parts.join(" · ")) + '<button class="btn ghost sm" data-showall>Show all</button></div>';
  }
  function focusChip() {
    if (!S.focus) return filterNotice();
    const i = S.focus.indexOf(":"), sys = sysById(S.focus.slice(0, i)), r = sys && sys.idx.byId.get(S.focus.slice(i + 1));
    return '<div class="focus">Showing only ' + badge(r) + " " + esc(r ? r.long || r.short : "") + '<button class="ib" data-unfocus title="Show all (Esc)" aria-label="Show all routes">✕</button></div>';
  }
  function renderVehicles() {
    const el = $("#pane-vehicles"); const q = S.query;
    const html = visibleSystems().map(sys => {
      const all = [...S.all.values()].filter(v => v.sys === sys && inFocus(v) && !(v.routeId && S.hiddenRoutes.has(sys.id + ":" + v.routeId)));
      if (S.focus && !all.length && !S.focus.startsWith(sys.id + ":")) return "";
      const list = all.filter(v => match(q, v.label, v.headsign, v.routeCode, routeOf(v) && routeOf(v).long, routeOf(v) && routeOf(v).short, v.near && v.near.stop.name))
        .sort((a, b) => (!!a.scheduled - !!b.scheduled) || codeOf(a).localeCompare(codeOf(b), undefined, { numeric: true }) ||
          String(a.headsign || a.label).localeCompare(String(b.headsign || b.label)));
      const moving = list.filter(v => !v.waiting), waiting = list.filter(v => v.waiting).sort((a, b) => a.departsAt - b.departsAt);
      const live = all.filter(v => !v.scheduled).length, est = all.length - live - all.filter(v => v.waiting).length;
      const head = '<div class="grp">' + (sys.mode === "train" ? "🚆 Trains" : "🚌 Buses") + '<span title="live GPS · timetable · departing soon">● ' + live + " live" + (est ? " · ⏱ " + est : "") + (waiting.length ? " · ⏳ " + waiting.length : "") + "</span></div>";
      if (!list.length) return head + '<div class="empty">' + emptyVehicles(sys, all.length) + "</div>";
      return head + moving.map(vehicleRow).join("") +
        (waiting.length ? '<div class="sub">⏳ Departing in the next ' + (sys.preDepartMin || 30) + " min</div>" + waiting.map(vehicleRow).join("") : "");
    }).join("");
    setHTML(el, focusChip() + (html || '<div class="empty">Nothing to show.</div>'));
  }
  function emptyVehicles(sys, total) {
    const f = sys.feeds.vehicles;
    if (S.query && total) return "No " + sys.many + " match “" + esc(S.query) + "”.";
    if (sys.mode === "bus" && f && f.status === "err") return "Live bus positions are unavailable right now.<br><span class='sm'>" + esc(f.detail) + "</span>";
    if (sys.mode === "train" && !sys.static) return sys.feeds.static && sys.feeds.static.status === "err" ? "Train timetable unavailable right now.<br><span class='sm'>" + esc(sys.feeds.static.detail) + "</span>" : "Loading the train timetable…";
    if (!f && sys.mode === "bus") return "Connecting to live buses…";
    if (sys.mode === "train" && sys.preDepartMin) return "No trains running or leaving in the next " + sys.preDepartMin + " min.";
    const mins = C.localMinutes(tz()); const [a, b] = sys.serviceHours;
    const off = mins < a || mins >= b;
    return "No " + sys.many + " running right now." + (off ? "<br><span class='sm'>" + (sys.mode === "bus" ? "Buses usually run " : "Most trains run ") + fmtMin(a) + "–" + fmtMin(b % 1440) + " (Colombo time).</span>" : "");
  }
  const fmtMin = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

  function renderRoutes() {
    const el = $("#pane-routes"); const q = S.query;
    const counts = new Map(); S.all.forEach(v => { const k = v.sys.id + ":" + v.routeId; counts.set(k, (counts.get(k) || 0) + 1); });
    const html = visibleSystems().map(sys => {
      const routes = (sys.static ? sys.static.routes : []).filter(r => match(q, r.short, r.long, r.desc));
      const head = '<div class="grp">' + (sys.mode === "train" ? "🚆 " : "🚌 ") + esc(sys.title) + "</div>";
      if (!routes.length) return head + '<div class="empty">' + (sys.static ? "No routes match." : sys.feeds.static && sys.feeds.static.status === "err" ? "Route data unavailable." : "Loading routes…") + "</div>";
      return head + routes.map(r => {
        const n = counts.get(sys.id + ":" + r.id) || 0; const hasLine = (sys.static.routeShapes[r.id] || []).length > 0; const key = sys.id + ":" + r.id;
        return '<div class="row rrow' + (S.focus === key ? " cur" : "") + '" data-route="' + esc(key) + '">' + badge(r) +
          '<span class="main"><span class="t">' + esc(r.long || r.short) + "</span>" +
          '<span class="m">' + (n ? '<b class="live">' + plural(n, sys) + " running</b>" : "none running now") + (hasLine ? "" : " · no line shape in feed") + "</span></span>" +
          '<label class="toggle" title="Show on map"><input type="checkbox" data-toggle="' + esc(key) + '" ' + (S.hiddenRoutes.has(key) ? "" : "checked") + ' aria-label="Show ' + esc(r.short) + ' on map"><span></span></label></div>';
      }).join("");
    }).join("");
    setHTML(el, html || '<div class="empty">Nothing to show.</div>');
  }

  function stopRow({ s, sys, d }, now, withNext) {
    const train = sys.mode === "train", key = sys.id + ":" + s.id;
    let nxt = "";
    if (withNext && train) {
      const dep = C.departures(sys.static, s.id, { delays: sys.trip.delays, cancelled: sys.trip.cancelled, limit: 1, now })[0];
      if (dep) nxt = '<span class="nxt">' + badge(sys.idx.byId.get(dep.routeId)) + "<b>" + esc(clock(dep.time)) + "</b></span>";
    } else if (!train) {
      const n = (sys.trip.byStop.get(s.id) || []).find(x => x.time >= now - 30 && !x.skipped && !x.cancelled);
      if (n) nxt = '<span class="nxt">' + badge(sys.idx.byId.get(n.routeId), n.routeCode) + "<b>" + (C.minutesUntil(n.time) <= 0 ? "Due" : C.minutesUntil(n.time) + "′") + "</b></span>";
    }
    return '<button class="row" data-stop="' + esc(key) + '"><span class="stopi' + (train ? " rail" : "") + '" aria-hidden="true"></span>' +
      '<span class="main"><span class="t">' + (S.favs.has(key) ? '<i class="star">★</i> ' : "") + esc(s.name) + "</span>" +
      '<span class="m">' + (train ? "Railway station" : "Bus stop" + (s.code ? " · " + esc(s.code) : "")) + (d != null ? " · " + dist(d) : "") + "</span></span>" + nxt + "</button>";
  }
  function renderStops() {
    const el = $("#pane-stops"); const q = S.query; const now = nowS();
    let list = [];
    visibleSystems().forEach(sys => sys.idx.platforms.forEach(s => { if (match(q, s.name, s.code)) list.push({ s, sys }); }));
    if (!list.length) {
      const loading = visibleSystems().some(s => !s.static && !(s.feeds.static && s.feeds.static.status === "err"));
      setHTML(el, loading && !q ? skeleton(6) : '<div class="empty">' + (q ? "No stops or stations match “" + esc(q) + "”." : "Stop data unavailable.") + "</div>"); return;
    }
    if (S.userLoc) list.forEach(x => { x.d = C.distanceM(S.userLoc[0], S.userLoc[1], x.s.lat, x.s.lon); });
    list.sort((a, b) => S.userLoc ? a.d - b.d : (a.sys.mode === b.sys.mode ? a.s.name.localeCompare(b.s.name) : a.sys.mode === "bus" ? -1 : 1));
    const favs = list.filter(x => S.favs.has(x.sys.id + ":" + x.s.id));
    const shownList = list.slice(0, 200);
    const withNext = !!(q || S.userLoc || shownList.length <= 60);
    setHTML(el, (favs.length ? '<div class="grp">★ Saved<span>' + favs.length + "</span></div>" + favs.map(x => stopRow(x, now, true)).join("") + '<div class="grp">All stops &amp; stations</div>' : "") +
      (S.userLoc ? '<div class="hint">Sorted by distance from you</div>' : "") + shownList.map(x => stopRow(x, now, withNext)).join("") +
      (list.length > shownList.length ? '<div class="hint">Showing 200 of ' + list.length + " — search to narrow down.</div>" : "") +
      (!favs.length && !q ? '<div class="hint">Tip: open a stop and tap ☆ to save it here.</div>' : ""));
  }
  const skeleton = n => '<div class="skel">' + Array.from({ length: n }, () => '<div class="sk"><i></i><span><b></b><b></b></span></div>').join("") + "</div>";

  function renderAlerts() {
    const el = $("#pane-alerts"); const q = S.query;
    const list = allAlerts().filter(a => match(q, a.header, a.description, a.routes.map(r => r.short).join(" ")));
    if (!list.length) {
      const fs = visibleSystems().map(s => s.feeds.alerts);
      setHTML(el, '<div class="empty">' + (fs.every(f => f && f.status === "err") ? "Service alerts are unavailable right now." : fs.some(f => !f) ? "Checking for service alerts…" : q ? "No alerts match." : '<span class="big">✓</span>No active service alerts.<br><span class="sm">Good service reported on every route.</span>') + "</div>");
      return;
    }
    setHTML(el, list.map(a => '<article class="alert ' + a.severity + '">' +
      '<div class="meta">' + (a.sys.mode === "train" ? "🚆 Rail · " : "🚌 Bus · ") + esc(a.effect) + (a.cause ? " · " + esc(a.cause) : "") + (a.until ? " · until " + esc(clock(a.until)) : "") + "</div>" +
      '<h3 class="hd">' + esc(a.header) + "</h3>" +
      (a.routes.length ? '<div class="rts">' + a.routes.map(r => badge(r)).join("") + "</div>" : "") +
      (a.description ? '<p class="ds">' + esc(a.description).replace(/\n/g, "<br>") + "</p>" : "") +
      (a.stops.length ? '<div class="m">Stops: ' + a.stops.map(s => esc(s.name)).join(", ") + "</div>" : "") +
      (a.url && /^https?:\/\//i.test(a.url) ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">More information ↗</a>' : "") +
      "</article>").join(""));
  }

  /* ---------------- panel interactions ---------------- */
  $("#pane-vehicles").addEventListener("click", e => { const n = e.target.closest("[data-veh]"); if (n) focusVehicle(n.dataset.veh); });
  $("#pane-stops").addEventListener("click", e => {
    const n = e.target.closest("[data-stop]"); if (!n) return;
    const i = n.dataset.stop.indexOf(":"); focusStop(sysById(n.dataset.stop.slice(0, i)), n.dataset.stop.slice(i + 1));
  });
  $("#pane-routes").addEventListener("click", e => {
    if (e.target.closest(".toggle")) return;
    const n = e.target.closest("[data-route]"); if (!n) return;
    const k = n.dataset.route, i = k.indexOf(":");
    setFocus(S.focus === k ? null : k); if (S.focus) { showRoute(sysById(k.slice(0, i)), k.slice(i + 1)); selectTab("vehicles"); }
  });
  $("#pane-routes").addEventListener("change", e => {
    const key = e.target.dataset.toggle; if (!key) return;
    if (e.target.checked) S.hiddenRoutes.delete(key); else S.hiddenRoutes.add(key);
    store.set("lmt-hidden-routes-v2", [...S.hiddenRoutes]);
    const sys = sysById(key.slice(0, key.indexOf(":"))); syncRouteVisibility(sys);
    S.all.forEach(v => { if (v.sys === sys) upsertMarker(v); });
    renderVehicles();
  });

  function collapseSheetOnMobile() { if (matchMedia("(max-width: 720px)").matches) $("#panel").classList.add("min"); }
  function focusVehicle(key) {
    const v = S.all.get(key); const m = S.markers.get(key); if (!v) return;
    if (!m) { toast("This route is hidden — turn it on in Routes"); return; }
    collapseSheetOnMobile();
    // Jump without animation: the popup's auto-pan would otherwise cancel a running pan halfway.
    map.setView([v.lat, v.lon], Math.max(map.getZoom(), v.sys.mode === "train" ? 13 : 15), { animate: false }); m.openPopup();
  }
  function focusStop(sys, id) {
    const s = sys && sys.idx.stops[id]; if (!s) return; collapseSheetOnMobile();
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), sys.mode === "train" ? 14 : 16), { animate: false });
    syncStopVisibility(sys); const m = sys.stopMarkers.get(id); if (m) setTimeout(() => m.openPopup(), 50);
  }
  function showRoute(sys, id) {
    if (!sys) return;
    const g = sys.routeLayers.get(id); const pts = [];
    if (g) { const b = g.getBounds(); if (b.isValid()) pts.push(b.getSouthWest(), b.getNorthEast()); }
    S.all.forEach(v => { if (v.sys === sys && v.routeId === id) pts.push(L.latLng(v.lat, v.lon)); });
    if (!pts.length) { toast("No route line or vehicles to show for this route"); return; }
    collapseSheetOnMobile(); setHash("route", (sys.idx.byId.get(id) || {}).short || id);
    map.fitBounds(L.latLngBounds(pts), fitOpts(15, 40));
    if (g) { g.setStyle({ weight: 8, opacity: 1 }); g.bringToFront(); setTimeout(() => g.setStyle({ weight: sys.mode === "train" ? 4 : 5, opacity: !S.focus || S.focus === sys.id + ":" + id ? (sys.mode === "train" ? 0.7 : 0.8) : 0.12 }), 1800); }
  }

  /* mode filter: All · Buses · Trains */
  function setMode(mode, fit) {
    S.mode = mode; store.set("lmt-mode", mode);
    document.querySelectorAll(".modes button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    S.systems.forEach(sys => { syncRouteVisibility(sys); syncStopVisibility(sys); });
    S.all.forEach(upsertMarker);
    refreshAll();
    if (fit && mode !== "all") fitTo(mode);
  }
  if (!TRAIN) $(".modes").hidden = true;
  document.querySelectorAll(".modes button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode, true)));

  /* tabs */
  document.querySelectorAll(".tabs [role=tab]").forEach(b => b.addEventListener("click", () => selectTab(b.dataset.pane)));
  function selectTab(name) {
    S.tab = name;
    document.querySelectorAll(".tabs [role=tab]").forEach(x => { const on = x.dataset.pane === name; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; });
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("show", p.id === "pane-" + name));
    $("#q").placeholder = { vehicles: "Search buses, trains, plates…", routes: "Search routes & lines…", stops: "Search stops & stations…", alerts: "Search alerts…" }[name];
    $("#panel").classList.remove("min");
    refreshAll();
  }
  $(".tabs").addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...document.querySelectorAll(".tabs [role=tab]")]; const i = tabs.findIndex(t => t.dataset.pane === S.tab);
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; selectTab(n.dataset.pane); n.focus();
  });
  let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { S.query = e.target.value.trim().toLowerCase(); refreshAll(); }, 120); });
  /* Bottom sheet (phones): drag the handle between peek, half and full; tap to cycle. */
  (function sheet() {
    const panel = $("#panel"), grab = $(".grab"); let y0 = null, h0 = 0, moved = false;
    const snaps = () => [118, Math.round(innerHeight * 0.46), Math.round(innerHeight - $(".topbar").offsetHeight - 8)];
    const setSnap = i => { panel.classList.toggle("min", i === 0); panel.classList.toggle("max", i === 2); panel.style.height = ""; };
    grab.addEventListener("pointerdown", e => { if (!matchMedia("(max-width: 720px)").matches) return; y0 = e.clientY; h0 = panel.getBoundingClientRect().height; moved = false; grab.setPointerCapture(e.pointerId); panel.classList.add("drag"); });
    grab.addEventListener("pointermove", e => { if (y0 == null) return; const dy = y0 - e.clientY; if (Math.abs(dy) > 4) moved = true; const sn = snaps(); panel.style.height = Math.max(sn[0], Math.min(sn[2], h0 + dy)) + "px"; });
    grab.addEventListener("pointerup", () => {
      if (y0 == null) return; panel.classList.remove("drag"); const h = panel.getBoundingClientRect().height, sn = snaps(); y0 = null;
      if (!moved) { const cur = panel.classList.contains("min") ? 0 : panel.classList.contains("max") ? 2 : 1; setSnap(cur === 0 ? 1 : cur === 1 ? 2 : 0); return; }
      let best = 0; sn.forEach((v, i) => { if (Math.abs(v - h) < Math.abs(sn[best] - h)) best = i; }); setSnap(best);
    });
    grab.addEventListener("click", e => { if (!matchMedia("(max-width: 720px)").matches) return; e.preventDefault(); });
    grab.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const cur = panel.classList.contains("min") ? 0 : panel.classList.contains("max") ? 2 : 1; setSnap((cur + 1) % 3); } });
  })();

  /* Keyboard: "/" search, Esc closes popup → clears route focus → clears search, 1–4 switch tabs. */
  document.addEventListener("keydown", e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || "")) || e.target.isContentEditable;
    if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); $("#panel").classList.remove("min"); return; }
    if (e.key === "Escape") {
      if (map._popup && map.hasLayer(map._popup)) { map.closePopup(); return; }
      if (S.focus) { setFocus(null); return; }
      if (S.query || typing) { $("#q").value = ""; S.query = ""; refreshAll(); $("#q").blur(); }
      return;
    }
    if (!typing && /^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) selectTab(["vehicles", "routes", "stops", "alerts"][+e.key - 1]);
  });
  $("#q").addEventListener("keydown", e => { if (e.key === "Enter") { const first = $(".pane.show [data-veh], .pane.show [data-stop], .pane.show [data-route]"); if (first) first.click(); } });

  /* Show everything: fit all visible systems. */
  $("#fit").addEventListener("click", () => {
    const b = L.latLngBounds([]); visibleSystems().forEach(sys => { const sb = systemBounds(sys); if (sb) b.extend(sb); });
    S.all.forEach(v => { if (shown(v.sys) && inFocus(v)) b.extend([v.lat, v.lon]); });
    if (b.isValid()) map.fitBounds(b, fitOpts(14));
  });

  /* locate */
  $("#locate").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Location isn't available in this browser"); return; }
    toast("Finding your location…");
    navigator.geolocation.getCurrentPosition(p => {
      S.userLoc = [p.coords.latitude, p.coords.longitude];
      if (!S.userMarker) S.userMarker = L.circleMarker(S.userLoc, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, pane: "vehicles" }).bindTooltip("You are here").addTo(map);
      else S.userMarker.setLatLng(S.userLoc);
      let best = null;
      visibleSystems().forEach(sys => { const n = C.nearestStop(sys.idx, S.userLoc[0], S.userLoc[1]); if (n && (!best || n.distance < best.distance)) best = n; });
      if (best && best.distance < 30000) { map.fitBounds(L.latLngBounds([S.userLoc, [best.stop.lat, best.stop.lon]]), fitOpts(16, 60)); toast("Nearest: " + best.stop.name + " (" + dist(best.distance) + ")"); }
      else { map.setView(S.userLoc, 15); toast("No stops or stations near you"); }
      selectTab("stops");
    }, () => toast("Couldn't get your location"), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });

  /* theme */
  (function themeInit() {
    const t = store.get("lmt-theme-v2", null);
    if (t) document.documentElement.setAttribute("data-theme", t);
    $("#theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; const next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next); store.set("lmt-theme-v2", next);
    });
  })();

  /* deep links: #bus=<id> #train=<trip or vehicle id> #stop=<id> #station=<id> #route=<code> */
  function setHash(kind, id) { try { history.replaceState(null, "", kind ? "#" + kind + "=" + encodeURIComponent(id) : location.pathname + location.search); } catch (e) { /* ignore */ } }
  let hashDone = false;
  function applyHash() {
    if (hashDone) return; const m = location.hash.match(/^#(bus|train|stop|station|route)=(.+)$/); if (!m) { hashDone = true; return; }
    const id = decodeURIComponent(m[2]);
    if (m[1] === "stop" && BUS && BUS.idx.stops[id]) { hashDone = true; focusStop(BUS, id); }
    else if (m[1] === "station" && TRAIN && TRAIN.idx.stops[id]) { hashDone = true; if (!shown(TRAIN)) setMode("all"); focusStop(TRAIN, id); }
    else if (m[1] === "route") { for (const sys of S.systems) { const r = sys.idx.byShort.get(id.toUpperCase()) || sys.idx.byId.get(id); if (r) { hashDone = true; showRoute(sys, r.id); break; } } }
    else if (m[1] === "bus" && BUS && S.all.has(BUS.id + ":" + id)) { hashDone = true; focusVehicle(BUS.id + ":" + id); }
    else if (m[1] === "train" && TRAIN && S.all.has(TRAIN.id + ":" + id)) { hashDone = true; if (!shown(TRAIN)) setMode("all"); focusVehicle(TRAIN.id + ":" + id); }
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
  const pollers = [];
  S.systems.forEach(sys => {
    // Trains without a live feed are re-checked less often (their positions come from the timetable).
    pollers.push(poller(sys.id + " vehicles", () => loadVehicles(sys), sys.mode === "train" ? CFG.refreshMs.vehicles * 2 : CFG.refreshMs.vehicles));
    pollers.push(poller(sys.id + " tripUpdates", () => loadTripUpdates(sys), CFG.refreshMs.tripUpdates));
    pollers.push(poller(sys.id + " alerts", () => loadAlerts(sys), CFG.refreshMs.alerts));
  });
  function runAll() { return Promise.all(pollers.map(p => p.run())); }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pollers.forEach(p => p.stop());
    else { runAll(); S.systems.forEach(s => s.schedule && updateEstimates(s)); }
  });
  window.addEventListener("online", runAll);
  $("#refresh").addEventListener("click", async () => {
    const b = $("#refresh"); b.classList.add("spin"); await runAll(); b.classList.remove("spin"); toast("Updated");
  });
  // Timetable positions move every few seconds without any network traffic.
  setInterval(() => { if (!document.hidden) S.systems.forEach(s => s.schedule && updateEstimates(s)); }, CFG.refreshMs.estimates);

  /* status line */
  setInterval(updateStatus, 1000);
  function updateStatus() {
    const s = $("#status");
    const parts = visibleSystems().map(sys => {
      const mine = [...S.all.values()].filter(v => v.sys === sys), l = liveCount(sys), w = mine.filter(v => v.waiting).length, e = mine.length - l - w;
      return (e || w ? plural(l, sys).replace(/^(\d+) /, "$1 live ") : plural(l, sys)) + (e ? " + " + e + " ⏱ scheduled" : "") + (w ? " + " + w + " ⏳ departing" : ""); });
    const busErr = BUS && shown(BUS) && BUS.feeds.vehicles && BUS.feeds.vehicles.status === "err";
    const lastOk = Math.max(0, ...S.systems.map(x => x.lastOk));
    if (!lastOk && !S.all.size) { s.textContent = busErr ? "Live feed unavailable" : "Connecting…"; s.className = "status" + (busErr ? " err" : ""); return; }
    const age = lastOk ? nowS() - lastOk : null;
    s.className = "status " + (busErr ? "err" : age != null && age > 60 ? "warn" : "live");
    s.innerHTML = (busErr ? "Reconnecting · " : '<i class="pulse"></i>Live · ') + parts.join(" · ") + (age != null ? " · " + C.ago(age) : "");
  }
  setInterval(() => { refreshOpenPopup(); if (S.tab === "vehicles") renderVehicles(); if (S.tab === "stops") renderStops(); }, 15000);

  /* ---------------- boot ---------------- */
  async function boot() {
    setMode(S.mode, false); renderHealth();
    try { S.FeedMessage = protobuf.parse(C.GTFS_RT_PROTO, { keepCase: true }).root.lookupType("transit_realtime.FeedMessage"); }
    catch (e) { console.error("GTFS-RT schema failed to load", e); }
    const statics = S.systems.map(loadStatic);
    const busStatic = BUS ? statics[S.systems.indexOf(BUS)] : statics[0];
    await Promise.race([busStatic, new Promise(r => setTimeout(r, 8000))]);
    if (location.hash.length <= 1) fitTo(S.mode === "train" ? "train" : "bus");
    $("#loader").classList.add("hide");
    await runAll().catch(() => { /* handled per feed */ });
    await Promise.all(statics);
    // Re-resolve vehicles against fresh static data if it arrived after the first poll.
    pollers.filter((p, i) => i % 3 === 0).forEach(p => p.run());
    applyHash(); setTimeout(applyHash, 1500);
  }
  /* Installable + works offline (app shell only; live feeds are never cached). */
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });

  window.LMTApp = { state: S, config: CFG, refresh: runAll };
  boot();
})();
