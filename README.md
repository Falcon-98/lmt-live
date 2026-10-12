# LMT Live Transit

A live map of **Lanka Metro Transit (LMT)** buses in Colombo and **Sri Lanka Railways (SLR)** trains island-wide: real-time positions, route lines, stops, station departure boards and service alerts. It's built on the **open GTFS and GTFS-Realtime feeds** published at `api.transit.seyone.dev` ([Mobility Database mdb-3490](https://mobilitydatabase.org/feeds/gtfs/mdb-3490)).

It's a static site: no backend, no build step, no API key. Put the folder on any static host (GitHub Pages works) and it runs.

> **Unofficial.** Not made or endorsed by Lanka Metro Transit or Sri Lanka Railways. LMT data is used under CC-BY-4.0 with attribution.

---

## Features

- **3D vehicle markers**: every bus and train is a three-quarter-view vehicle in its route colour, with windows, livery stripe, headlight and spoked wheels. Each one is mirrored to face its direction of travel. Moving vehicles bob and spin their wheels. Hovering lifts a vehicle, and selected or followed vehicles pulse. A tag shows the route code, a green dot for live GPS or a ⏱ clock for timetable estimates, and a red `+N` when a train is running late. Vehicles shrink and drop their labels as you zoom out, and glide between updates.
- **Live buses**: LMT GPS positions, refreshed every 10 s. When the GPS feed is empty, buses are shown at their **⏱ scheduled positions** from LMT's timetable. A banner, an amber status light and every popup say so, and real GPS buses replace them route by route as soon as data returns.
- **Trains**: Sri Lanka Railways trains across the island (see *How trains are tracked* below). Each train shows its headsign, line, next stops with times, delay and final destination. Every station has a **departure board** listing the next 3 hours of trains, with live delays and cancellations where reported.
- **Only relevant trains**: the map shows trains that are **running now**, plus trains **waiting at their first station that leave within the next 30 minutes**. Waiting trains show an amber countdown (`12′`), are listed under *Departing in the next 30 min*, and fan out side by side when several wait at the same station. The window is `preDepartMin` in the config.
- **All / Buses / Trains filter** for the map, lists, counts and alerts.
- **Better popups**:
  - A journey progress bar from origin to destination.
  - A collapsible stop-by-stop timeline, with passed stops dimmed and the next stop highlighted.
  - The next stop with a countdown.
  - **Follow**, **Only this route** and **Share** buttons.
- **Route focus**: tap a route (or *Only CM01* in a popup) to see just that route's vehicles, with other lines faded. `Esc` or ✕ shows everything again.
- **Saved stops**: tap ☆ in any stop or station popup. Saved stops stay at the top of the Stops tab.
- **Faster to use**:
  - `/` focuses search, `Enter` opens the first result, `Esc` goes back, and `1`–`4` switch tabs.
  - A *Show everything* button and a map legend.
  - On phones, a draggable bottom sheet with three positions (peek, half, full).
- **Smoother**:
  - Lists only re-render when something changed, so scroll position and hover survive the live updates.
  - Skeleton placeholders appear while loading.
  - A compact outage banner, remembered once dismissed.
  - A toast when live GPS comes back.
- **Installable and offline**: a web app manifest and icons let you add it to your home screen. A network-first service worker keeps the app shell working offline; live feeds are never cached, and new deploys load immediately.
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

## Live data status (checked 12 Oct 2026)

A diagnostic workflow ([`probe-feeds`](.github/workflows/probe-feeds.yml)) and a real-browser smoke test ([`live-smoke`](.github/workflows/live-smoke.yml)) query the live feeds from GitHub's servers. Their findings:

- **CORS works.** The feed server allows the GitHub Pages origin (`https://falcon-98.github.io`), and the static GTFS downloads fine.
- **LMT live GPS is back** (about 60 buses on 12 Oct 2026), but the producer changed its format: positions no longer carry a `route_id`, and `trip_id`s are random UUIDs that don't match the timetable. The app used to drop these as "not LMT", which is why it sometimes showed only a handful of buses. Now:
  - a vehicle with a real registration plate (e.g. `WP-NE-6506`) is accepted even without a route; simulator/test IDs (`SIM-…`, `TEST-…`) are still rejected;
  - its route is **worked out from its position**: the route lines within 120 m of the bus, kept sticky between refreshes. Where several routes share a road, the popup says "one of …";
  - a position is kept for up to 30 minutes after its last report, so buses that report infrequently don't flicker away;
  - if a route or mode filter is hiding buses, a notice says so with a **Show all** button.
- **Trip updates are stale** (55–100 days old), so the app ignores updates older than 2 hours.
- **The LMT timetable covers 7 routes, 185 stops and 56 trips.** When there is little or no GPS, the app places buses at their **⏱ scheduled positions** and labels them as such. Route CM06 has no line or trips in the feed, so it can't be drawn.

Run either workflow from the Actions tab to re-check at any time; `live-smoke` also runs every 6 hours.

## Railway station positions (corrected)

The SLR `stops.txt` published by the feed server places many stations in the wrong place. In the most extreme case, Sankathanai and Eliphant Pass shared one coordinate about **300 km** from where they are. Medagama, Patagamgoda, Galboda, Parakumpura, Noor Nagar, Hathamuna and others were also **50–130 km** off. Before the fix, 85 consecutive-station segments implied impossible train speeds of 700–9,000 km/h.

[`tools/fix-stations.mjs`](tools/fix-stations.mjs) fixes this against **OpenStreetMap**. The [`osm-stations`](.github/workflows/osm-stations.yml) workflow keeps a snapshot of OSM's 921 Sri Lankan railway station entries in `data/osm-stations-lk.json`. The tool then does three things:
- **Matches** every SLR station to OSM. Matching is by name, and tolerates transliteration differences such as *Sankathanai/Sangathanai*, *Hatamuna/Hathamuna* and *Panaleeya/Panaliya*. A candidate is rejected if it would put the station far from its neighbours on the line, so similarly named stations on different lines (*Parakumpura* and *Perakumpura*) aren't confused.
- **Corrects** 38 stations that were more than 300 m from their OSM position.
- **Estimates** positions for 3 misplaced stations that OSM doesn't have (Medagama, Buthgamuwa, Ranamuggamuwa). Each is placed on the track between its neighbours, in proportion to the timetable, and marked approximate.

The result is written to [`assets/station-fixes.js`](assets/station-fixes.js) and applied before anything uses the coordinates, so train positions are corrected too. The full list is in [`data/station-fixes-report.json`](data/station-fixes-report.json). After the fix:
- **Impossible segments:** 15 remain, down from 85. Each lies between two stations confirmed by OSM, so they are **timetable** errors in the feed, not location errors.
- **Confirmed:** 280 stations were already within 300 m of OSM.
- **Unverified:** 20 small halts that aren't in OSM, kept as published because they sit plausibly between their neighbours.

To re-check after the feed changes: run the `osm-stations` workflow, then `node tools/fix-stations.mjs <unzipped SLR GTFS dir>`.

### Real track geometry

The feed's own train shapes are coarse, so trains used to cut across fields between stations. [`tools/build-rail.mjs`](tools/build-rail.mjs) now routes every consecutive station pair on all 9 lines (650 pairs, 0 failures) over the **OpenStreetMap railway network** and writes the result to [`assets/rail-geometry.js`](assets/rail-geometry.js). Trains and route lines follow the real track, including the hill-country Main line. 8 stations that sat off the track (Udhamulla, Yapahuwa, Piladuwa, Murunkan, Buthgamuwa, Yatirawana, Pathanpha, Yatawara) were moved onto it. An audit is in [`data/rail-audit.json`](data/rail-audit.json).

To rebuild: run the [`data-snapshots`](.github/workflows/data-snapshots.yml) workflow (it saves OSM track and the GTFS zips to the `data-snapshots` branch), check that branch out, then `node tools/build-rail.mjs <snapshot dir>`.

## How trains are tracked

The feed server carries the complete SLR timetable: 9 lines, about 500 trips with stop times, and track shapes. As far as public sources show, it has **not documented a live GPS feed for trains**. So trains are shown in layers, with each train labelled by where its data comes from:

1. **Live GPS** (`● GPS`): taken from `/realtime/vehicle-positions?agency=SLR` whenever the server publishes it. The train's headsign and next stops are filled in from the timetable.
2. **Live delays and cancellations**: taken from `/realtime/trip-updates?agency=SLR` and applied to timetable positions and departure boards.
3. **Timetable estimate** (`⏱ timetable`): when there's no GPS for a train, it is placed where the official timetable says it should be. It moves along the real OpenStreetMap track between stations, waits at stations for the scheduled dwell time, and respects the service calendar and its exceptions. These trains look visibly different: slightly transparent, with a dashed tag.

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
manifest.webmanifest, sw.js   installable app + offline shell (network-first)
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
- **Station corrections:** © OpenStreetMap contributors, ODbL.
