# LMT Live Transit

A live map of **Lanka Metro Transit (LMT)** buses in Colombo and **Sri Lanka Railways (SLR)** trains island-wide: real-time positions, route lines, stops, station departure boards and service alerts. It's built on the **open GTFS and GTFS-Realtime feeds** published at `api.transit.seyone.dev` ([Mobility Database mdb-3490](https://mobilitydatabase.org/feeds/gtfs/mdb-3490)).

It's a static site: no backend, no build step, no API key. Put the folder on any static host (GitHub Pages works) and it runs.

> **Unofficial.** Not made or endorsed by Lanka Metro Transit or Sri Lanka Railways. LMT data is used under CC-BY-4.0 with attribution.

---

## Features

- **3D vehicle markers**: every bus and train is a three-quarter-view vehicle in its route colour, with windows, livery stripe, headlight and spoked wheels. Each one is mirrored to face its direction of travel. Moving vehicles bob and spin their wheels. Hovering lifts a vehicle, and selected or followed vehicles pulse. A tag shows the route code, a green dot for live GPS or a ⏱ clock for timetable estimates, and a red `+N` when a train is running late. Vehicles shrink and drop their labels as you zoom out, and glide between updates.
- **Live buses**: LMT GPS positions, refreshed every 10 s. When the GPS feed is empty, buses are shown at their **⏱ scheduled positions** from LMT's timetable. A banner, an amber status light and every popup say so, and real GPS buses replace them route by route as soon as data returns.
- **Trains**: Sri Lanka Railways trains across the island (see *How trains are tracked* below). Each train shows its headsign, line, next stops with times, delay and final destination. Every station has a **departure board** listing the next 3 hours of trains, with live delays and cancellations where reported.
- **All / Buses / Trains filter** for the map, lists, counts and alerts.
- **Accurate data only**: expired positions, duplicate records, other agencies' vehicles (e.g. trains), out-of-area and `0,0` fixes are filtered out. A position 3–15 minutes old is shown faded as "signal delayed". Anything older is dropped.
- **Bus details**: the bus's plate, its route, the nearest stop, its speed, crowding (when the feed reports it), how long ago it last reported and its next stops from the trip-updates feed. You can **follow** a bus as it moves.
- **Stops**: every platform stop, shown on the map from zoom 13. A stop's popup gives live arrival countdowns, marks skipped stops and cancelled trips, and lists nearby buses when the stop has no predictions. **Near me** sorts stops by distance.
- **Routes**: lines are drawn from the GTFS shapes. Each route shows a count of its live buses, and you can turn a route on or off (the app remembers your choice).
- **Alerts**: only active alerts are shown, and only those relevant to LMT. Each one includes the effect, cause, affected routes and stops, and an end time. Text appears in your browser language when the feed provides it, otherwise in English.
- **Search** across buses, plates, routes, stops and alerts.
- **Feed health**: a status light per feed. The *Feed status* panel shows the feed's age and how many records were kept or dropped.
- **Resilient**: failed requests retry with back-off. Polling pauses while the tab is hidden. The schedule is cached so repeat visits load instantly. The app falls back to the producer's JSON endpoint if the protobuf feed fails, and to the Mobility Database mirror if the schedule download fails. It **never shows invented buses**.
- **Deep links**: `#bus=WP-NE-5234`, `#stop=104` and `#route=CM01` open the matching bus, stop or route.
- Mobile-first bottom sheet, dark/light theme (the map darkens too), keyboard-navigable tabs, honours reduced-motion.

---

## Live data status (checked 11 Oct 2026)

A diagnostic workflow ([`probe-feeds`](.github/workflows/probe-feeds.yml)) and a real-browser smoke test ([`live-smoke`](.github/workflows/live-smoke.yml)) query the live feeds from GitHub's servers. Their findings:

- **CORS works.** The feed server allows the GitHub Pages origin (`https://falcon-98.github.io`), and the static GTFS downloads fine.
- **The LMT live GPS feed is online but empty** (0 vehicles). The upstream bridge reports 38–40 buses in its registry, but its last telemetry poll was on **9 Oct 2026, 15:16 UTC**, so no positions are reaching the feed. This is a data-provider outage and can't be fixed from this app. Buses appear automatically as soon as the provider publishes positions again.
- **Trip updates are stale** (55–100 days old), so the app ignores updates older than 2 hours.
- **The LMT timetable now covers 7 routes, 185 stops and 56 trips.** While GPS is empty, the app places buses at their **⏱ scheduled positions** and labels them as such. A banner explains that live GPS is unavailable.

Run either workflow from the Actions tab to re-check at any time; `live-smoke` also runs every 6 hours.

## How trains are tracked

The feed server carries the complete SLR timetable: 9 lines, about 500 trips with stop times, and track shapes. As far as public sources show, it has **not documented a live GPS feed for trains**. So trains are shown in layers, with each train labelled by where its data comes from:

1. **Live GPS** (`● GPS`): taken from `/realtime/vehicle-positions?agency=SLR` whenever the server publishes it. The train's headsign and next stops are filled in from the timetable.
2. **Live delays and cancellations**: taken from `/realtime/trip-updates?agency=SLR` and applied to timetable positions and departure boards.
3. **Timetable estimate** (`⏱ timetable`): when there's no GPS for a train, it is placed where the official timetable says it should be. It moves along the real track shape between stations (or in a straight line where the feed has no shape), waits at stations for the scheduled dwell time, and respects the service calendar and its exceptions. These trains look visibly different: slightly transparent, with a dashed tag.

If the server doesn't publish train realtime at all, the Trains status light turns amber ("timetable only") rather than red, and buses are unaffected. Add `?trains=0` to the URL to hide trains completely.

## The open data

Producer: `https://api.transit.seyone.dev` (generated by [lmt-transit-bridge](https://github.com/seyone22/lmt-transit-bridge)), all **CC-BY-4.0**.

| Feed | Endpoint (scoped with `?agency=LMT`, and `?agency=SLR` for trains) | Catalog |
|------|------------------------------------------|---------|
| GTFS Schedule | `/api/v1/gtfs/download?agency=LMT` | [mdb-3490](https://mobilitydatabase.org/feeds/gtfs/mdb-3490) |
| SLR timetable | `/api/v1/gtfs/download?agency=SLR` (falls back to the full download, filtered to SLR) | — |
| Vehicle Positions | `/api/v1/realtime/vehicle-positions?agency=LMT` (JSON twin: `/realtime/vehicle-positions/list`) | [mdb-3489](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3489) |
| Trip Updates | `/api/v1/realtime/trip-updates?agency=LMT` | [mdb-3488](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3488) |
| Service Alerts | `/api/v1/realtime/alerts?agency=LMT` | [mdb-3487](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3487) |

### Quirks of this feed that the app handles

These came from reading the producer's source code and the [Transitland validation report](https://github.com/transitland/transitland-atlas/pull/2123):

1. **The server is multi-agency.** It also publishes Sri Lanka Railways, so every request carries `?agency=LMT`, and the results are filtered again on the client.
2. **The vehicle feed keeps expiring records.** The validator saw 6,529 vehicle entities for a fleet of a few dozen buses. The app keeps only each bus's newest position and drops anything older than 15 minutes.
3. **Route IDs don't match between feeds.** `routes.txt` uses UUIDs (`8bc594e3-…`), while vehicle positions usually send the route code (`CM01`) as `route_id`. Routes are matched by ID, then by short name, then by the code embedded in the synthetic trip ID (`LMT_CM01_0_WP-NE-5234`).
4. **There are no trips or stop_times for LMT**, so route lines come from shapes matched by name (`SHAPE_CM01_D0` → CM01).
5. **`stops.txt` has parent "Hub" stations** (`location_type=1`) next to the platform stops. Only the platform stops are shown.
6. **Speed is in km/h.** The producer computes km/h, not the m/s the GTFS-RT spec asks for. If the feed is ever fixed, open the app with `?speed=ms`.
7. **Some GTFS-RT fields may be missing.** The embedded schema marks every field optional, so one missing "required" field can't break decoding of the whole feed.

---

## Run it

**GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / root. Then visit `https://<user>.github.io/lmt-live/`.

**Locally:** serve the folder (opening `index.html` as a file blocks the feed requests):
```bash
python3 -m http.server 8000   # http://localhost:8000
```

### If the browser can't reach the feeds (CORS)

The feeds are fetched directly from the browser. If `api.transit.seyone.dev` stops sending CORS headers, the app shows a red **Can't reach the live bus feed** banner and retries. The fix is a tiny proxy:

1. Deploy [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js) as a Cloudflare Worker (free tier). It only forwards the read-only LMT feed paths.
2. Either open the app with `?api=https://<worker>.workers.dev/api/v1`, or set it permanently in `index.html`:
   ```html
   <script>window.LMT_CONFIG = { fallbackApi: "https://<worker>.workers.dev/api/v1" };</script>
   ```
   With `fallbackApi` set, the app tries the producer first and uses the proxy only when the producer fails.

### Configuration

Set any of these in `window.LMT_CONFIG`. The defaults are at the top of [`assets/app.js`](assets/app.js).

| Key | Default | Purpose |
|-----|---------|---------|
| `api` | `https://api.transit.seyone.dev/api/v1` | Feed base URL (also `?api=`) |
| `fallbackApi` | `""` | Second base URL, e.g. your proxy (also `?fallbackApi=`) |
| `trains` | `true` | Show Sri Lanka Railways (also `?trains=0`) |
| `systems` | LMT buses + SLR trains | Per-system endpoints, service area, colours (SLR lines have no colours in the feed, so these are set here) |
| `refreshMs` | vehicles 10 s (trains 20 s), trip updates 30 s, alerts 60 s, timetable positions 5 s | Poll intervals |
| `maxVehicleAgeSec` / `staleVehicleSec` | 900 / 180 | Drop positions older than the first value; fade those older than the second |
| `speedUnit` | `kmh` | `ms` if the feed switches to standard m/s (also `?speed=`) |

---

## Project layout

```
index.html               page shell
assets/lmt-core.js       data layer: GTFS + GTFS-RT parsing, filtering, route matching (no DOM; runs in Node too)
assets/app.js            map, panel, polling, popups
assets/app.css           styles (light/dark, desktop dock / mobile sheet)
proxy/cloudflare-worker.js  optional CORS proxy
tests/                   unit tests, fixtures modelled on the real feed, Playwright end-to-end test
```

Libraries come from cdnjs: Leaflet 1.9.4 for the map, protobuf.js 7.2.6 for GTFS-RT decoding and JSZip 3.10.1 for the GTFS zip.

### Tests

```bash
npm install
npm test           # data-layer unit tests (also run in CI)
npm run test:e2e   # serves the app + fixture feeds, drives headless Chromium, saves screenshots to tests/screenshots/
```

The fixtures in `tests/fixtures.js` reproduce the real feed's quirks: UUID routes, `CM01` in realtime, synthetic trip IDs, stale and duplicate records, train entities, parent hubs, and multilingual and expired alerts.

---

## License & attribution

- **Code:** free to reuse (MIT suggested).
- **Transit data:** © Lanka Metro Transit, **CC-BY-4.0**. Attribution is required wherever the data is shown (the panel footer does this).
- **Map tiles:** © OpenStreetMap contributors.
- **Rail timetable:** Sri Lanka Railways schedule as republished by transit.seyone.dev.
