# LMT Live Transit

A single-file web app that shows **Lanka Metro Transit (LMT)** CM buses on a live map — vehicle positions, routes, stops and service alerts — built entirely on LMT's **open GTFS and GTFS-Realtime feeds**. No backend, no build step, no API key. Drop `index.html` on any static host (GitHub Pages works well) and it runs.

> **Unofficial.** Not made or endorsed by Lanka Metro Transit. Data is used under CC-BY-4.0 with attribution.

---

## The open data (what powers this)

LMT's data is published as a **community feed** on the [Mobility Database](https://mobilitydatabase.org), served from `https://api.transit.seyone.dev`. There are four feeds, all licensed **[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)**:

| # | Feed | Type | Endpoint | Catalog |
|---|------|------|----------|---------|
| 1 | GTFS Schedule | Static (routes, stops, trips, shapes, timetable) | `https://api.transit.seyone.dev/api/v1/gtfs/download?agency=LMT` | [mdb-3490](https://mobilitydatabase.org/feeds/gtfs/mdb-3490) |
| 2 | Vehicle Positions | GTFS-Realtime (live bus locations) | `https://api.transit.seyone.dev/api/v1/realtime/vehicle-positions` | [mdb-3489](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3489) |
| 3 | Trip Updates | GTFS-Realtime (arrival predictions) | `https://api.transit.seyone.dev/api/v1/realtime/trip-updates` | [mdb-3488](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3488) |
| 4 | Service Alerts | GTFS-Realtime (disruptions) | `https://api.transit.seyone.dev/api/v1/realtime/alerts` | [mdb-3487](https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3487) |

Static snapshot mirror (fallback if the producer URL is down):
`https://files.mobilitydatabase.org/mdb-3490/mdb-3490-202610110023/mdb-3490-202610110023.zip`

**How the pieces fit:** the realtime feeds only carry IDs (`trip_id`, `route_id`, `stop_id`). The **static GTFS Schedule** is what turns those IDs into real route names, stop names and coordinates, and the route line shapes. You need both to draw buses moving along lines.

**Formats:**
- Static GTFS = a `.zip` of CSV files (`routes.txt`, `stops.txt`, `trips.txt`, `shapes.txt`, …). [Spec →](https://gtfs.org/schedule/)
- Realtime = Protocol Buffers (`FeedMessage`), not JSON. Must be decoded with the GTFS-Realtime schema. [Spec →](https://gtfs.org/realtime/)

---

## Features

- **Live map** (Leaflet + OpenStreetMap tiles) with a tabbed panel: **Buses · Routes · Stops · Alerts**.
- **Buses** — markers coloured per route, pointing in the direction of travel; tap for route, vehicle ID, speed, occupancy and last-seen time. Auto-refreshes every 15 s.
- **Routes** — drawn in their real GTFS colours; toggle each route's line and buses on/off.
- **Stops** — every stop plotted (shown from zoom 13+) and listed with its stop code; stop popups show the next arrivals from the trip-updates feed.
- **Alerts** — active service alerts with cause/effect and affected routes.
- **Resilient by design** — if a feed can't be reached (see CORS below), the app shows clearly-labelled **sample data** and a banner instead of a blank screen.
- Dark/light theme, mobile-first (bottom-sheet panel on phones), no tracking.

---

## Run it

### GitHub Pages
1. Create a repo (e.g. `lmt-live`) and add `index.html` (and this `README.md`).
2. **Settings → Pages → Deploy from a branch → `main` / root.**
3. Visit `https://<username>.github.io/lmt-live/`.

### Locally
Open `index.html` in a browser, or serve the folder:
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

---

## The one thing to watch: CORS

The realtime fetch happens **in the browser**. It will only succeed if `api.transit.seyone.dev` returns an
`Access-Control-Allow-Origin` header that permits your site's origin.

- **If it does:** real buses appear. Done.
- **If it doesn't:** the browser blocks the response, the app switches to **sample mode** with an explanatory banner.

**Fix if blocked** — route the feed through a tiny proxy that adds the CORS header. A Cloudflare Worker example:

```js
export default {
  async fetch(request) {
    const target = "https://api.transit.seyone.dev/api/v1/realtime/vehicle-positions";
    const r = await fetch(target, { cf: { cacheTtl: 5 } });
    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": "application/x-protobuf",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    });
  }
};
```

Then point the endpoint(s) in `index.html` at your worker URL.

---

## How it works (for the next developer)

All logic is in `index.html`. Libraries are loaded from CDN:

| Library | Purpose |
|---------|---------|
| [Leaflet 1.9.4](https://leafletjs.com) | Map + markers |
| [protobuf.js 7.2.6](https://github.com/protobufjs/protobuf.js) | Decode GTFS-Realtime protobuf in the browser |
| [JSZip 3.10.1](https://stuk.github.io/jszip/) | Unzip the static GTFS `.zip` |
| [PapaParse 5.4.1](https://www.papaparse.com) | Parse the GTFS CSV files |

Flow:
1. **Boot** — parse an embedded GTFS-Realtime `.proto` definition with protobuf.js.
2. **Static** — download the GTFS zip, parse `routes/stops/trips/shapes`, draw route lines and stops, fit the map.
3. **Realtime** — poll `vehicle-positions` every 15 s, decode the `FeedMessage`, upsert bus markers. Poll `alerts` (60 s) and `trip-updates` (30 s).
4. **Fallback** — any fetch error flips `state.sample = true` and renders built-in demo routes/buses.

Config lives at the top of the script (`FEEDS`, `REFRESH`) — change endpoints or refresh intervals there.

---

## Related

This app is the live-tracking companion to the **unofficial LMT CM-routes-on-Google-Maps** project (saved My Maps for CM01–CM08 and a commuter helper page). Official real-time tracking also exists inside LMT's own **LMT Go** app (built by EIMSKY Business Solutions under the Ministry of Transport).

### Routes (per the GTFS schedule / official listing)
`CM01, CM02, CM03, CM04, CM05, CM06, CM08` — note there is **no CM07** in the current route set.

---

## License & attribution

- **Code:** free to reuse. Add a license of your choice (MIT suggested).
- **Transit data:** © Lanka Metro Transit, licensed **CC-BY-4.0** — attribution is **required** wherever the data is shown. Verify the producer's current terms before any public deployment.
- **Map tiles:** © OpenStreetMap contributors.

---

*Compiled from research on 11 Oct 2026. Feeds and endpoints can change — re-check the Mobility Database catalog links above if something stops working.*
