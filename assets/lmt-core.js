/* ============================================================
   LMT Live — data layer (no DOM, no Leaflet).
   Turns the static GTFS zip and the GTFS-Realtime feeds published at
   api.transit.seyone.dev into clean, LMT-only records for the UI.

   Facts about the producer this code relies on (from the feed producer,
   github.com/seyone22/lmt-transit-bridge, and the Transitland validation):
   - The server is multi-agency (it also carries Sri Lanka Railways), so
     every request is scoped with ?agency=LMT and results are filtered again.
   - Static routes use UUID route_ids with route_short_name "CM01".., but
     vehicle positions usually carry route_id = "CM01" (the route code).
   - LMT has no trips/stop_times; trip_ids in realtime are synthetic
     ("LMT_CM01_0_WP-NE-1234"). Shapes are named "SHAPE_CM01_D0".
   - stops.txt contains parent "Hub" stations (location_type=1) next to
     the platform stops.
   - The vehicle feed keeps expiring records, so stale positions must be
     dropped and duplicates collapsed.
   - The producer computes speed in km/h.

   Works in the browser (window.LMTCore) and in Node (module.exports).
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LMTCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* GTFS-Realtime 2.0 schema. Every field is declared optional on purpose:
     with proto2 "required" fields, protobuf.js throws on the whole feed if a
     producer leaves out a single required value. */
  const GTFS_RT_PROTO = `
syntax = "proto2"; package transit_realtime;
message FeedMessage { optional FeedHeader header=1; repeated FeedEntity entity=2; }
message FeedHeader { optional string gtfs_realtime_version=1; optional Incrementality incrementality=2; optional uint64 timestamp=3; optional string feed_version=4;
  enum Incrementality { FULL_DATASET=0; DIFFERENTIAL=1; } }
message FeedEntity { optional string id=1; optional bool is_deleted=2; optional TripUpdate trip_update=3; optional VehiclePosition vehicle=4; optional Alert alert=5; }
message TripUpdate { optional TripDescriptor trip=1; optional VehicleDescriptor vehicle=3; repeated StopTimeUpdate stop_time_update=2; optional uint64 timestamp=4; optional int32 delay=5;
  message StopTimeEvent { optional int32 delay=1; optional int64 time=2; optional int32 uncertainty=3; optional int64 scheduled_time=4; }
  message StopTimeUpdate { optional uint32 stop_sequence=1; optional string stop_id=4; optional StopTimeEvent arrival=2; optional StopTimeEvent departure=3; optional ScheduleRelationship schedule_relationship=5;
    enum ScheduleRelationship { SCHEDULED=0; SKIPPED=1; NO_DATA=2; UNSCHEDULED=3; } } }
message VehiclePosition { optional TripDescriptor trip=1; optional VehicleDescriptor vehicle=8; optional Position position=2; optional uint32 current_stop_sequence=3; optional string stop_id=7;
  optional VehicleStopStatus current_status=4; optional uint64 timestamp=5; optional CongestionLevel congestion_level=6; optional OccupancyStatus occupancy_status=9; optional uint32 occupancy_percentage=10;
  enum VehicleStopStatus { INCOMING_AT=0; STOPPED_AT=1; IN_TRANSIT_TO=2; }
  enum CongestionLevel { UNKNOWN_CONGESTION_LEVEL=0; RUNNING_SMOOTHLY=1; STOP_AND_GO=2; CONGESTION=3; SEVERE_CONGESTION=4; }
  enum OccupancyStatus { EMPTY=0; MANY_SEATS_AVAILABLE=1; FEW_SEATS_AVAILABLE=2; STANDING_ROOM_ONLY=3; CRUSHED_STANDING_ROOM_ONLY=4; FULL=5; NOT_ACCEPTING_PASSENGERS=6; NO_DATA_AVAILABLE=7; NOT_BOARDABLE=8; } }
message Position { optional float latitude=1; optional float longitude=2; optional float bearing=3; optional double odometer=4; optional float speed=5; }
message TripDescriptor { optional string trip_id=1; optional string route_id=5; optional uint32 direction_id=6; optional string start_time=2; optional string start_date=3; optional ScheduleRelationship schedule_relationship=4;
  enum ScheduleRelationship { SCHEDULED=0; ADDED=1; UNSCHEDULED=2; CANCELED=3; REPLACEMENT=5; DUPLICATED=6; DELETED=7; } }
message VehicleDescriptor { optional string id=1; optional string label=2; optional string license_plate=3; }
message Alert { repeated TimeRange active_period=1; repeated EntitySelector informed_entity=5; optional Cause cause=6; optional Effect effect=7; optional TranslatedString url=8;
  optional TranslatedString header_text=10; optional TranslatedString description_text=11; optional SeverityLevel severity_level=14;
  enum Cause { UNKNOWN_CAUSE=1; OTHER_CAUSE=2; TECHNICAL_PROBLEM=3; STRIKE=4; DEMONSTRATION=5; ACCIDENT=6; HOLIDAY=7; WEATHER=8; MAINTENANCE=9; CONSTRUCTION=10; POLICE_ACTIVITY=11; MEDICAL_EMERGENCY=12; }
  enum Effect { NO_SERVICE=1; REDUCED_SERVICE=2; SIGNIFICANT_DELAYS=3; DETOUR=4; ADDITIONAL_SERVICE=5; MODIFIED_SERVICE=6; OTHER_EFFECT=7; UNKNOWN_EFFECT=8; STOP_MOVED=9; NO_EFFECT=10; ACCESSIBILITY_ISSUE=11; }
  enum SeverityLevel { UNKNOWN_SEVERITY=1; INFO=2; WARNING=3; SEVERE=4; } }
message TimeRange { optional uint64 start=1; optional uint64 end=2; }
message EntitySelector { optional string agency_id=1; optional string route_id=2; optional int32 route_type=3; optional TripDescriptor trip=4; optional string stop_id=5; optional uint32 direction_id=6; }
message TranslatedString { repeated Translation translation=1; message Translation { optional string text=1; optional string language=2; } }
`;

  /* Colombo metropolitan operating area. Mirrors the producer's own geofence,
     padded slightly. Used to drop positions that can't be an LMT bus. */
  const SERVICE_AREA = { minLat: 6.6, maxLat: 7.3, minLon: 79.78, maxLon: 80.25 };
  /* Whole island, for Sri Lanka Railways. */
  const SRI_LANKA = { minLat: 5.85, maxLat: 9.9, minLon: 79.45, maxLon: 81.95 };

  const OCCUPANCY = {
    EMPTY: ["good", "Empty"], MANY_SEATS_AVAILABLE: ["good", "Many seats"], FEW_SEATS_AVAILABLE: ["warn", "Few seats"],
    STANDING_ROOM_ONLY: ["bad", "Standing only"], CRUSHED_STANDING_ROOM_ONLY: ["bad", "Very crowded"], FULL: ["bad", "Full"],
    NOT_ACCEPTING_PASSENGERS: ["muted", "Not boarding"], NOT_BOARDABLE: ["muted", "Not boardable"]
  };
  const STOP_STATUS = { INCOMING_AT: "Arriving at", STOPPED_AT: "Stopped at", IN_TRANSIT_TO: "Heading to" };
  const CAUSE = { UNKNOWN_CAUSE: "", OTHER_CAUSE: "", TECHNICAL_PROBLEM: "Technical problem", STRIKE: "Strike", DEMONSTRATION: "Demonstration",
    ACCIDENT: "Accident", HOLIDAY: "Holiday", WEATHER: "Weather", MAINTENANCE: "Maintenance", CONSTRUCTION: "Construction",
    POLICE_ACTIVITY: "Police activity", MEDICAL_EMERGENCY: "Medical emergency" };
  const EFFECT = { NO_SERVICE: "No service", REDUCED_SERVICE: "Reduced service", SIGNIFICANT_DELAYS: "Significant delays", DETOUR: "Detour",
    ADDITIONAL_SERVICE: "Additional service", MODIFIED_SERVICE: "Modified service", OTHER_EFFECT: "Service notice", UNKNOWN_EFFECT: "Service notice",
    STOP_MOVED: "Stop moved", NO_EFFECT: "Information", ACCESSIBILITY_ISSUE: "Accessibility issue" };
  const SEVERITY = { UNKNOWN_SEVERITY: "info", INFO: "info", WARNING: "warn", SEVERE: "bad" };

  /* ---------------- small utilities ---------------- */
  function toRad(d) { return d * Math.PI / 180; }
  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function inArea(lat, lon, a) { a = a || SERVICE_AREA; return lat >= a.minLat && lat <= a.maxLat && lon >= a.minLon && lon <= a.maxLon; }
  function num(v) { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  /** GTFS-RT timestamps are POSIX seconds; tolerate producers that send milliseconds. */
  function toSeconds(v) { const n = num(v); if (n == null || n <= 0) return null; return n > 1e11 ? Math.round(n / 1000) : n; }
  function norm(s) { return String(s == null ? "" : s).trim(); }
  function upper(s) { return norm(s).toUpperCase(); }
  function validHex(c) { return /^[0-9a-f]{6}$/i.test(norm(c)) ? "#" + norm(c).toLowerCase() : null; }
  function fallbackColor(key) {
    const pal = ["#c8102e", "#0072ce", "#009a44", "#b26b00", "#6a4c93", "#d63384", "#00838f", "#7a5230"];
    let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return pal[h % pal.length];
  }
  /** Pick readable text (#fff / #111) for a background colour when the feed gives none. */
  function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; return lum > 0.6 ? "#111111" : "#ffffff";
  }
  function translate(ts, langs) {
    const list = (ts && ts.translation) || []; if (!list.length) return "";
    const prefs = (langs || ["en"]).map(l => l.toLowerCase());
    for (const p of prefs) { const hit = list.find(t => (t.language || "").toLowerCase().split("-")[0] === p); if (hit && hit.text) return hit.text; }
    const neutral = list.find(t => !t.language && t.text); return (neutral || list.find(t => t.text) || {}).text || "";
  }

  /* ---------------- CSV ---------------- */
  /** RFC-4180 CSV → array of objects. Handles quotes, CRLF and a UTF-8 BOM. */
  function parseCsv(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = []; let row = [], field = "", i = 0, q = false; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r]; if (cells.length === 1 && cells[0].trim() === "") continue;
      const o = {}; for (let k = 0; k < head.length; k++) o[head[k]] = cells[k] == null ? "" : cells[k].trim();
      out.push(o);
    }
    return out;
  }

  /* ---------------- static GTFS ---------------- */
  /**
   * Build the static model from the GTFS text files.
   * @param files {routes, stops, trips, shapes, agency, stop_times, feed_info} → CSV text ("" if missing)
   * @param opts  {agency:"LMT"}
   */
  function buildStatic(files, opts) {
    opts = opts || {};
    const agencyId = upper(opts.agency || "LMT");
    const agencies = parseCsv(files.agency || "");
    const tz = (agencies.find(a => upper(a.agency_id) === agencyId) || agencies[0] || {}).agency_timezone || "Asia/Colombo";

    // Routes — only this agency's when the feed is multi-agency.
    let routes = parseCsv(files.routes || "");
    const multiAgency = agencies.length > 1 || routes.some(r => r.agency_id && upper(r.agency_id) !== agencyId);
    if (multiAgency) routes = routes.filter(r => !r.agency_id || upper(r.agency_id) === agencyId);
    const routeList = routes.filter(r => r.route_id).map(r => {
      const color = validHex(r.route_color) || validHex(((opts.colors || {})[r.route_short_name] || "").replace("#", "")) || fallbackColor(r.route_short_name || r.route_id);
      return {
        id: r.route_id,
        short: r.route_short_name || r.route_long_name || r.route_id,
        long: r.route_long_name || "",
        desc: r.route_desc || "",
        type: num(r.route_type),
        color,
        text: validHex(r.route_text_color) || contrastText(color),
        url: r.route_url || ""
      };
    }).sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
    const routeIds = new Set(routeList.map(r => r.id));

    // Trips (may be absent for LMT). Other agencies' trip ids are kept only to spot their stops.
    const trips = {}, foreignTrips = new Set();
    parseCsv(files.trips || "").forEach(t => {
      if (!routeIds.has(t.route_id)) { foreignTrips.add(t.trip_id); return; }
      trips[t.trip_id] = { route: t.route_id, shape: t.shape_id || "", head: t.trip_headsign || "", dir: num(t.direction_id) };
    });

    // Stops. With stop_times we keep only stops served by this agency's trips (plus their parents).
    // Otherwise (LMT publishes no stop_times) a multi-agency feed keeps stops inside the service
    // area that no other agency's trips use.
    const allStops = parseCsv(files.stops || "");
    let usedStops = null; const foreignStops = new Set();
    const stopTimes = files.stop_times ? parseCsv(files.stop_times) : [];
    // Only a multi-agency feed needs stops narrowed to this agency's trips; a single-agency feed keeps
    // every stop (LMT's timetable doesn't cover every route, e.g. CM06).
    if (stopTimes.length && multiAgency) {
      const mine = new Set();
      stopTimes.forEach(st => {
        if (trips[st.trip_id]) mine.add(st.stop_id); else if (foreignTrips.has(st.trip_id)) foreignStops.add(st.stop_id);
      });
      if (mine.size) usedStops = mine;
    }
    const stopsById = {};
    allStops.forEach(s => {
      const lat = num(s.stop_lat), lon = num(s.stop_lon);
      if (lat == null || lon == null || !s.stop_id) return;
      stopsById[s.stop_id] = { id: s.stop_id, code: s.stop_code || "", name: s.stop_name || s.stop_id, lat, lon,
        type: num(s.location_type) || 0, parent: s.parent_station || "", desc: s.stop_desc || "" };
    });
    let keep = Object.values(stopsById);
    if (usedStops) {
      const parents = new Set(); keep = keep.filter(s => usedStops.has(s.id));
      keep.forEach(s => s.parent && parents.add(s.parent));
      keep = keep.concat([...parents].map(id => stopsById[id]).filter(Boolean));
    } else if (multiAgency) {
      keep = keep.filter(s => inArea(s.lat, s.lon) && !foreignStops.has(s.id));
      const childOf = new Set(keep.map(s => s.parent).filter(Boolean));
      keep = keep.filter(s => s.type === 0 || childOf.has(s.id) || !foreignStops.size);
    }
    const stops = {}; keep.forEach(s => { stops[s.id] = s; });

    // Shapes: linked through trips when present, otherwise matched by name (SHAPE_CM01_D0 → CM01).
    const shapePts = {};
    parseCsv(files.shapes || "").forEach(p => {
      const lat = num(p.shape_pt_lat), lon = num(p.shape_pt_lon); if (lat == null || lon == null) return;
      (shapePts[p.shape_id] = shapePts[p.shape_id] || []).push([num(p.shape_pt_sequence) || 0, lat, lon]);
    });
    const shapeIds = Object.keys(shapePts);
    const routeShapes = {};
    routeList.forEach(r => {
      const ids = new Set();
      Object.values(trips).forEach(t => { if (t.route === r.id && t.shape && shapePts[t.shape]) ids.add(t.shape); });
      if (!ids.size) {
        const keys = [r.short, r.id].filter(Boolean).map(k => upper(k).replace(/[^A-Z0-9]/g, ""));
        shapeIds.forEach(sid => {
          const tokens = upper(sid).split(/[^A-Z0-9]+/);
          if (keys.some(k => k && tokens.includes(k))) ids.add(sid);
        });
      }
      routeShapes[r.id] = [...ids].map(sid => shapePts[sid].sort((a, b) => a[0] - b[0])
        .map(p => [Math.round(p[1] * 1e5) / 1e5, Math.round(p[2] * 1e5) / 1e5]));
    });

    const feedInfo = parseCsv(files.feed_info || "")[0] || null;
    const out = { agency: agencyId, timezone: tz, routes: routeList, trips, stops, routeShapes,
      feedVersion: feedInfo && (feedInfo.feed_version || feedInfo.feed_end_date) || "" };
    if (opts.schedule && stopTimes.length) out.schedule = buildSchedule(stopTimes, trips, stops, shapePts, files);
    return out;
  }

  /* ---------------- timetable (trains) ---------------- */
  /** "25:10:00" → seconds after the service day's noon-minus-12h. */
  function gtfsTime(t) {
    const m = /^\s*(\d+):(\d{2})(?::(\d{2}))?\s*$/.exec(t || ""); return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) : null;
  }
  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  /**
   * Compact timetable: trips with [stopId, arr, dep] rows, service calendars and the shapes they run on.
   * Kept JSON-serialisable so it can be cached.
   */
  function buildSchedule(stopTimes, trips, stops, shapePts, files) {
    const rows = {};
    stopTimes.forEach(r => {
      if (!trips[r.trip_id] || !stops[r.stop_id]) return;
      const arr = gtfsTime(r.arrival_time), dep = gtfsTime(r.departure_time);
      if (arr == null && dep == null) return;
      (rows[r.trip_id] = rows[r.trip_id] || []).push([num(r.stop_sequence) || 0, r.stop_id, arr == null ? dep : arr, dep == null ? arr : dep]);
    });
    const serviceOf = {};
    parseCsv(files.trips || "").forEach(t => { if (trips[t.trip_id]) serviceOf[t.trip_id] = t.service_id; });
    const schedTrips = [];
    Object.keys(rows).forEach(id => {
      const r = rows[id].sort((a, b) => a[0] - b[0]).map(x => [x[1], x[2], x[3]]);
      if (r.length < 2) return;
      const t = trips[id];
      schedTrips.push({ id, route: t.route, head: t.head || stops[r[r.length - 1][0]].name, shape: t.shape || "", svc: serviceOf[id] || "", stops: r });
    });
    const services = {};
    parseCsv(files.calendar || "").forEach(c => {
      services[c.service_id] = { days: DAYS.map(d => c[d] === "1"), start: c.start_date || "", end: c.end_date || "" };
    });
    const exceptions = {};
    parseCsv(files.calendar_dates || "").forEach(c => { (exceptions[c.date] = exceptions[c.date] || {})[c.service_id] = num(c.exception_type); });
    const shapes = {};
    new Set(schedTrips.map(t => t.shape)).forEach(sid => {
      if (sid && shapePts[sid]) shapes[sid] = shapePts[sid].slice().sort((a, b) => a[0] - b[0]).map(p => [Math.round(p[1] * 1e5) / 1e5, Math.round(p[2] * 1e5) / 1e5]);
    });
    return { trips: schedTrips, services, exceptions, shapes };
  }

  /** Date/time in the agency timezone: {ymd:"20261011", dow:0..6 (Mon=0), sec: seconds since midnight}. */
  function localParts(tz, date) {
    const d = date || new Date();
    try {
      const p = {}; new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
      return { ymd: p.year + p.month + p.day, dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), sec: +p.hour * 3600 + +p.minute * 60 + +p.second };
    } catch (e) {
      return { ymd: "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0"), dow: (d.getDay() + 6) % 7, sec: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
    }
  }
  function serviceRuns(sched, svc, ymd, dow) {
    const ex = sched.exceptions[ymd] && sched.exceptions[ymd][svc];
    if (ex === 1) return true; if (ex === 2) return false;
    const c = sched.services[svc]; if (!c) return !Object.keys(sched.services).length; // no calendar → assume daily
    return !!c.days[dow] && (!c.start || ymd >= c.start) && (!c.end || ymd <= c.end);
  }
  /** Service days to consider: today, and yesterday for trips running past midnight (times ≥ 24:00). */
  function serviceDays(tz, nowSec) {
    const today = localParts(tz, new Date(nowSec * 1000));
    const y = localParts(tz, new Date((nowSec - 86400) * 1000));
    const tm = localParts(tz, new Date((nowSec + 86400) * 1000));
    return [{ ymd: today.ymd, dow: today.dow, t: today.sec }, { ymd: y.ymd, dow: y.dow, t: today.sec + 86400 },
      { ymd: tm.ymd, dow: tm.dow, t: today.sec - 86400 }];
  }

  /* Shape geometry: cumulative distances and where each stop sits along the line. */
  const shapeCache = new WeakMap();
  function shapeGeo(sched, sid) {
    const pts = sched.shapes[sid]; if (!pts || pts.length < 2) return null;
    let g = shapeCache.get(pts); if (g) return g;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    g = { pts, cum, at: {} }; shapeCache.set(pts, g); return g;
  }
  function stopOnShape(g, stop) {
    if (g.at[stop.id] !== undefined) return g.at[stop.id];
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.pts.length; i++) { const d = distanceM(stop.lat, stop.lon, g.pts[i][0], g.pts[i][1]); if (d < bd) { bd = d; best = i; } }
    return (g.at[stop.id] = bd < 2500 ? g.cum[best] : null);
  }
  function pointAt(g, dist) {
    const c = g.cum; dist = Math.max(0, Math.min(c[c.length - 1], dist));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= dist) lo = mid; else hi = mid; }
    const seg = c[hi] - c[lo] || 1, k = (dist - c[lo]) / seg;
    return [g.pts[lo][0] + (g.pts[hi][0] - g.pts[lo][0]) * k, g.pts[lo][1] + (g.pts[hi][1] - g.pts[lo][1]) * k];
  }
  /** Position between two stops at fraction k, following the track shape when it fits. */
  function between(sched, trip, stops, a, b, k) {
    const A = stops[a[0]], B = stops[b[0]];
    const g = trip.shape && shapeGeo(sched, trip.shape);
    if (g) {
      const da = stopOnShape(g, A), db = stopOnShape(g, B);
      if (da != null && db != null && da !== db) {
        const p = pointAt(g, da + (db - da) * k), q = pointAt(g, da + (db - da) * Math.min(1, k + 0.02));
        const brg = distanceM(p[0], p[1], q[0], q[1]) > 1 ? bearingDeg(p[0], p[1], q[0], q[1]) : bearingDeg(A.lat, A.lon, B.lat, B.lon);
        return { lat: p[0], lon: p[1], bearing: brg };
      }
    }
    return { lat: A.lat + (B.lat - A.lat) * k, lon: A.lon + (B.lon - A.lon) * k, bearing: bearingDeg(A.lat, A.lon, B.lat, B.lon) };
  }

  /**
   * Where a scheduled trip is at `now`, shifted by `delay` seconds.
   * Returns null if the trip isn't running — or, with `preDepartSec`, isn't waiting at its origin
   * to leave within that many seconds (state.waiting). Includes upcoming stops, a full stop
   * timeline and the share of the journey done (`progress`, by time).
   */
  function tripState(sched, trip, stops, t, now, delay, preDepartSec) {
    const st = trip.stops; const s = t - (delay || 0);
    const first = st[0][2], last = st[st.length - 1][1];
    const timeline = () => st.map((r, i) => ({ stopId: r[0], time: now + ((i ? r[1] : r[2]) - s), passed: r[2] < s && i < st.length - 1 }));
    if (s < first && preDepartSec && first - s <= preDepartSec) {
      const O = stops[st[0][0]], n = stops[st[1][0]];
      return { lat: O.lat, lon: O.lon, bearing: n ? bearingDeg(O.lat, O.lon, n.lat, n.lon) : null, atStop: st[0][0], waiting: true,
        departsAt: now + (first - s), upcoming: st.slice(1).map(r => ({ stopId: r[0], time: now + (r[1] - s) })),
        timeline: timeline(), progress: 0, origin: st[0][0], dest: st[st.length - 1][0], startTime: now + (first - s) };
    }
    if (s < first || s > last) return null;
    let pos = null, nextIdx = st.length - 1, atStop = null;
    for (let i = 0; i < st.length; i++) {
      if (s >= st[i][1] && s <= st[i][2]) { const S = stops[st[i][0]]; atStop = st[i][0]; nextIdx = Math.min(i + 1, st.length - 1);
        const n = stops[st[nextIdx][0]]; pos = { lat: S.lat, lon: S.lon, bearing: n && n !== S ? bearingDeg(S.lat, S.lon, n.lat, n.lon) : null }; break; }
      if (i < st.length - 1 && s > st[i][2] && s < st[i + 1][1]) {
        const k = (s - st[i][2]) / ((st[i + 1][1] - st[i][2]) || 1);
        pos = between(sched, trip, stops, st[i], st[i + 1], k); nextIdx = i + 1; break;
      }
    }
    if (!pos) return null;
    const upcoming = [];
    for (let i = nextIdx; i < st.length; i++) {
      if (st[i][0] === atStop) continue;
      upcoming.push({ stopId: st[i][0], time: now + (st[i][1] - s) });
    }
    return Object.assign(pos, { atStop, upcoming, origin: st[0][0], dest: st[st.length - 1][0],
      startTime: now + (first - s), timeline: timeline(), progress: Math.max(0, Math.min(1, (s - first) / ((last - first) || 1))) });
  }

  /**
   * Trains (or any scheduled vehicles) that should be on the line right now according to the timetable.
   * opts: {now, tz, delays: Map tripId→sec, cancelled: Set tripIds, skip: Set tripIds (have live GPS),
   *        skipRoutes: Set routeIds (a route with live GPS shows only its real vehicles),
   *        preDepartSec: also include trips waiting at their origin that leave within this many seconds}
   */
  function scheduledVehicles(st, opts) {
    const sched = st && st.schedule; if (!sched) return [];
    opts = opts || {};
    const now = opts.now || Date.now() / 1000;
    const days = serviceDays(opts.tz || st.timezone, now);
    const out = [];
    for (const trip of sched.trips) {
      if (opts.skip && opts.skip.has(trip.id)) continue;
      if (opts.skipRoutes && opts.skipRoutes.has(trip.route)) continue;
      if (opts.cancelled && opts.cancelled.has(trip.id)) continue;
      const delay = opts.delays && opts.delays.has(trip.id) ? opts.delays.get(trip.id) : null;
      for (const d of days) {
        if (!serviceRuns(sched, trip.svc, d.ymd, d.dow)) continue;
        const state = tripState(sched, trip, st.stops, d.t, now, delay, opts.preDepartSec);
        if (!state) continue;
        out.push(Object.assign({ id: trip.id, label: trip.head, routeId: trip.route, tripId: trip.id, headsign: trip.head,
          scheduled: true, delay, ts: null, stale: false, speedKmh: null }, state));
        break;
      }
    }
    return out;
  }
  /** Upcoming stops for a trip (used to enrich live GPS trains with timetable info). */
  function tripUpcoming(st, tripId, opts) {
    const sched = st && st.schedule; if (!sched) return null;
    const trip = sched.trips.find(t => t.id === tripId); if (!trip) return null;
    opts = opts || {}; const now = opts.now || Date.now() / 1000;
    for (const d of serviceDays(opts.tz || st.timezone, now)) {
      const s = tripState(sched, trip, st.stops, d.t, now, opts.delay);
      if (s) return Object.assign(s, { headsign: trip.head });
    }
    return { headsign: trip.head, upcoming: [] };
  }

  /**
   * Departure board for a station from the timetable, with live delays/cancellations applied.
   * Returns [{tripId, routeId, headsign, time (expected epoch), planned (epoch), delay, cancelled, arrivalOnly}]
   */
  function departures(st, stopId, opts) {
    const sched = st && st.schedule; if (!sched) return [];
    opts = opts || {};
    const now = opts.now || Date.now() / 1000, horizon = opts.horizonSec || 3 * 3600;
    const days = serviceDays(opts.tz || st.timezone, now).concat([]);
    const out = [];
    for (const trip of sched.trips) {
      const i = trip.stops.findIndex(r => r[0] === stopId); if (i < 0) continue;
      const row = trip.stops[i]; const last = i === trip.stops.length - 1;
      const delay = opts.delays && opts.delays.has(trip.id) ? opts.delays.get(trip.id) : null;
      for (const d of days) {
        if (!serviceRuns(sched, trip.svc, d.ymd, d.dow)) continue;
        const planned = now + ((last ? row[1] : row[2]) - d.t);
        const time = planned + (delay || 0);
        if (time < now - 60 || planned > now + horizon) continue;
        out.push({ tripId: trip.id, routeId: trip.route, headsign: trip.head, time, planned, delay,
          cancelled: !!(opts.cancelled && opts.cancelled.has(trip.id)), arrivalOnly: last });
      }
    }
    return out.sort((a, b) => a.time - b.time).slice(0, opts.limit || 8);
  }

  /** Lookup indexes for resolving realtime references against the static model. */
  function indexStatic(st) {
    const byId = new Map(), byShort = new Map();
    (st.routes || []).forEach(r => { byId.set(r.id, r); byShort.set(upper(r.short), r); byShort.set(upper(r.id), r); });
    const platforms = Object.values(st.stops || {}).filter(s => s.type === 0);
    return { byId, byShort, platforms, stops: st.stops || {}, trips: st.trips || {} };
  }

  /**
   * Resolve a realtime (route_id, trip_id) pair to a static route.
   * Tries the exact id, the route code (CM01), the trip table, then a route code
   * embedded in the synthetic trip id (LMT_CM01_0_WP-NE-1234).
   */
  function resolveRoute(idx, routeId, tripId) {
    if (routeId) {
      const r = idx.byId.get(routeId) || idx.byShort.get(upper(routeId)); if (r) return r;
    }
    if (tripId) {
      const t = idx.trips[tripId]; if (t && idx.byId.get(t.route)) return idx.byId.get(t.route);
      const tokens = upper(tripId).split(/[^A-Z0-9]+/);
      for (const tok of tokens) { const r = idx.byShort.get(tok); if (r) return r; }
    }
    return null;
  }
  /** Best-effort route code when the route isn't in the static feed (e.g. a brand-new route). */
  function guessRouteCode(routeId, tripId) {
    const src = upper(routeId) + " " + upper(tripId);
    const m = src.match(/\b(CM\d{1,3}[A-Z]?)\b/) || src.match(/LMT_([A-Z]{1,3}\d{1,3})/);
    return m ? m[1] : (routeId && routeId.length <= 8 ? routeId : "");
  }

  function looksLikeAgency(trip, agency) {
    const a = upper(agency || "LMT");
    return upper(trip.trip_id).startsWith(a + "_") || (a === "LMT" && /^CM\d{1,3}[A-Z]?$/.test(upper(trip.route_id)));
  }

  function nearestStop(idx, lat, lon) {
    let best = null, bd = Infinity;
    for (const s of idx.platforms) { const d = distanceM(lat, lon, s.lat, s.lon); if (d < bd) { bd = d; best = s; } }
    return best ? { stop: best, distance: bd } : null;
  }

  /* ---------------- realtime: vehicle positions ---------------- */
  /**
   * Turn a decoded FeedMessage (protobuf.js toObject with enums:String, longs:Number)
   * into fresh, de-duplicated LMT bus records.
   * opts: {now (s), maxAgeSec, staleSec, speedUnit:"kmh"|"ms", requireKnownRoute, area}
   */
  function processVehicles(feed, idx, opts) {
    opts = opts || {};
    const now = opts.now || Date.now() / 1000;
    const maxAge = opts.maxAgeSec || 900, staleSec = opts.staleSec || 180;
    const headerTs = toSeconds(feed && feed.header && feed.header.timestamp);
    const hasRoutes = idx.byId.size > 0;
    const requireKnown = opts.requireKnownRoute !== false && hasRoutes;
    const stats = { total: 0, kept: 0, stale: 0, outside: 0, foreign: 0, invalid: 0, duplicate: 0 };
    const out = new Map();
    for (const e of (feed && feed.entity) || []) {
      const v = e && e.vehicle; if (!v) continue;
      stats.total++;
      if (e.is_deleted) continue;
      const p = v.position || {}; const lat = num(p.latitude), lon = num(p.longitude);
      if (lat == null || lon == null || (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01)) { stats.invalid++; continue; }
      if (!inArea(lat, lon, opts.area)) { stats.outside++; continue; }
      const ts = toSeconds(v.timestamp) || headerTs;
      if (ts && now - ts > maxAge) { stats.stale++; continue; }
      const trip = v.trip || {}; const vd = v.vehicle || {};
      const route = resolveRoute(idx, trip.route_id, trip.trip_id);
      // Routes the producer runs but hasn't put in the schedule yet still count as LMT
      // when they carry an LMT route code (CM03) or an LMT synthetic trip id.
      if (!route && requireKnown && !looksLikeAgency(trip, opts.agency)) { stats.foreign++; continue; }
      const id = norm(vd.id) || norm(vd.license_plate) || norm(vd.label) || norm(e.id);
      if (!id) { stats.invalid++; continue; }
      const prev = out.get(id);
      if (prev) { stats.duplicate++; if ((prev.ts || 0) >= (ts || 0)) continue; }
      const rawSpeed = num(p.speed);
      const kmh = rawSpeed == null ? null : (opts.speedUnit === "ms" ? rawSpeed * 3.6 : rawSpeed);
      out.set(id, {
        id,
        label: norm(vd.label) || norm(vd.license_plate) || id,
        plate: norm(vd.license_plate),
        routeId: route ? route.id : "",
        routeCode: route ? route.short : guessRouteCode(trip.route_id, trip.trip_id),
        tripId: norm(trip.trip_id),
        direction: num(trip.direction_id),
        lat, lon,
        bearing: num(p.bearing),
        speedKmh: kmh != null && kmh >= 0 && kmh < 150 ? kmh : null,
        status: v.current_status || "",
        stopId: norm(v.stop_id),
        occupancy: v.occupancy_status || "",
        occupancyPct: num(v.occupancy_percentage),
        congestion: v.congestion_level || "",
        ts: ts || null,
        stale: !!(ts && now - ts > staleSec)
      });
    }
    stats.kept = out.size;
    return { vehicles: [...out.values()], headerTs, stats };
  }

  /**
   * Same output as processVehicles, from the producer's JSON endpoint
   * (/realtime/vehicle-positions/list) — used when the protobuf feed fails.
   * Each item: {trip_id, route_id, vehicle_id, latitude, longitude, speed (km/h), bearing, timestamp, updated_at}
   */
  function jsonListToFeed(list) {
    const entity = (Array.isArray(list) ? list : (list && (list.data || list.items)) || []).map((x, i) => {
      const t = Date.parse(x.timestamp || x.updated_at || "");
      return { id: String(x.id || x.vehicle_id || i), vehicle: {
        trip: { trip_id: x.trip_id, route_id: x.route_id, direction_id: x.direction_id },
        vehicle: { id: x.vehicle_id, label: x.vehicle_label || x.vehicle_id, license_plate: x.license_plate },
        position: { latitude: x.latitude, longitude: x.longitude, bearing: x.bearing, speed: x.speed },
        occupancy_status: typeof x.occupancy_status === "string" ? x.occupancy_status : undefined,
        timestamp: Number.isFinite(t) ? Math.round(t / 1000) : undefined } };
    });
    return { header: {}, entity };
  }

  /* ---------------- realtime: trip updates ---------------- */
  /**
   * Index trip updates by stop and by vehicle.
   * Returns {byStop: Map<stopId,[{routeId,routeCode,vehicleId,time,delay,skipped,cancelled}]>, byVehicle: Map<vehicleId,[...]> , count}
   */
  function processTripUpdates(feed, idx, opts) {
    opts = opts || {};
    const now = opts.now || Date.now() / 1000;
    const hasRoutes = idx.byId.size > 0;
    const byStop = new Map(), byVehicle = new Map(), delays = new Map(), cancelledTrips = new Set(); let count = 0, stale = 0;
    for (const e of (feed && feed.entity) || []) {
      const tu = e && e.trip_update; if (!tu || e.is_deleted) continue;
      // The producer keeps months-old updates in the feed; an old prediction is worse than none.
      const tuTs = toSeconds(tu.timestamp);
      if (tuTs && now - tuTs > (opts.maxAgeSec || 2 * 3600)) { stale++; continue; }
      const trip = tu.trip || {};
      const route = resolveRoute(idx, trip.route_id, trip.trip_id);
      if (!route && hasRoutes && !looksLikeAgency(trip, opts.agency)) continue;
      count++;
      const cancelled = trip.schedule_relationship === "CANCELED" || trip.schedule_relationship === "DELETED";
      const vid = norm(tu.vehicle && (tu.vehicle.id || tu.vehicle.license_plate || tu.vehicle.label));
      if (trip.trip_id && cancelled) cancelledTrips.add(trip.trip_id);
      // Current delay of the trip: first upcoming stop that reports one, else the trip-level delay.
      let tripDelay = null;
      for (const su of tu.stop_time_update || []) {
        const ev = su.arrival || su.departure || {}; const t = toSeconds(ev.time);
        if (ev.delay != null && (!t || t >= now - 60)) { tripDelay = ev.delay; break; }
      }
      if (tripDelay == null && tu.delay != null) tripDelay = tu.delay;
      if (trip.trip_id && tripDelay != null) delays.set(trip.trip_id, tripDelay);
      const list = [];
      for (const su of tu.stop_time_update || []) {
        const ev = su.arrival || su.departure || {};
        let time = toSeconds(ev.time);
        if (!time && ev.scheduled_time && ev.delay != null) time = toSeconds(ev.scheduled_time) + ev.delay;
        if (!su.stop_id || !time) continue;
        if (time < now - 60) continue; // already passed
        const item = { routeId: route ? route.id : "", routeCode: route ? route.short : guessRouteCode(trip.route_id, trip.trip_id),
          tripId: norm(trip.trip_id), vehicleId: vid, stopId: su.stop_id, time,
          delay: ev.delay != null ? ev.delay : (tu.delay != null ? tu.delay : null),
          skipped: su.schedule_relationship === "SKIPPED", cancelled };
        list.push(item);
        if (!byStop.has(su.stop_id)) byStop.set(su.stop_id, []);
        byStop.get(su.stop_id).push(item);
      }
      if (vid && list.length) byVehicle.set(vid, (byVehicle.get(vid) || []).concat(list));
    }
    byStop.forEach(a => a.sort((x, y) => x.time - y.time));
    byVehicle.forEach(a => a.sort((x, y) => x.time - y.time));
    return { byStop, byVehicle, delays, cancelled: cancelledTrips, count, stale, headerTs: toSeconds(feed && feed.header && feed.header.timestamp) };
  }

  /* ---------------- realtime: alerts ---------------- */
  function processAlerts(feed, idx, opts) {
    opts = opts || {};
    const now = opts.now || Date.now() / 1000;
    const agency = upper(opts.agency || "LMT");
    const hasStatic = idx.byId.size > 0;
    const out = [];
    for (const e of (feed && feed.entity) || []) {
      const a = e && e.alert; if (!a || e.is_deleted) continue;
      const periods = a.active_period || [];
      const active = !periods.length || periods.some(p => (toSeconds(p.start) || 0) <= now && (!toSeconds(p.end) || now <= toSeconds(p.end)));
      if (!active) continue;
      const ents = a.informed_entity || [];
      const routes = new Map(), stops = new Map(); let relevant = !ents.length || !hasStatic;
      ents.forEach(ie => {
        const r = resolveRoute(idx, ie.route_id, ie.trip && ie.trip.trip_id);
        if (r) { routes.set(r.id, r); relevant = true; }
        if (ie.stop_id && idx.stops[ie.stop_id]) { stops.set(ie.stop_id, idx.stops[ie.stop_id]); relevant = true; }
        if (ie.agency_id && upper(ie.agency_id) === agency) relevant = true;
        if (!ie.agency_id && !ie.route_id && !ie.stop_id && !ie.trip) relevant = true;
      });
      if (!relevant) continue;
      const langs = opts.languages || ["en"];
      const ends = periods.map(p => toSeconds(p.end)).filter(Boolean);
      out.push({
        id: norm(e.id),
        header: translate(a.header_text, langs) || "Service notice",
        description: translate(a.description_text, langs),
        url: translate(a.url, langs),
        cause: CAUSE[a.cause] || "",
        effect: EFFECT[a.effect] || "Service notice",
        severity: SEVERITY[a.severity_level] || (["NO_SERVICE", "SIGNIFICANT_DELAYS", "DETOUR"].includes(a.effect) ? "bad" : "warn"),
        routes: [...routes.values()], stops: [...stops.values()],
        until: ends.length ? Math.max(...ends) : null
      });
    }
    return out;
  }

  /* ---------------- time helpers ---------------- */
  function minutesUntil(t, now) { return Math.round((t - (now || Date.now() / 1000)) / 60); }
  function ago(sec) {
    if (sec == null || !Number.isFinite(sec)) return "—";
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + " s ago";
    if (sec < 3600) return Math.floor(sec / 60) + " min ago";
    return Math.floor(sec / 3600) + " h " + Math.floor(sec % 3600 / 60) + " min ago";
  }
  /** Minutes since midnight in the agency timezone. */
  function localMinutes(tz, d) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Colombo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d || new Date());
      const h = +parts.find(p => p.type === "hour").value, m = +parts.find(p => p.type === "minute").value; return h * 60 + m;
    } catch (e) { const x = d || new Date(); return x.getHours() * 60 + x.getMinutes(); }
  }

  return { GTFS_RT_PROTO, SERVICE_AREA, SRI_LANKA, OCCUPANCY, STOP_STATUS, CAUSE, EFFECT,
    parseCsv, buildStatic, indexStatic, gtfsTime, localParts, scheduledVehicles, tripUpcoming, departures, resolveRoute, guessRouteCode, nearestStop,
    processVehicles, jsonListToFeed, processTripUpdates, processAlerts,
    distanceM, bearingDeg, inArea, toSeconds, translate, contrastText, minutesUntil, ago, localMinutes };
});
