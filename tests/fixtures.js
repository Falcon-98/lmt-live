/* Test fixtures that mirror what api.transit.seyone.dev actually publishes for LMT
   (see the notes at the top of assets/lmt-core.js). */
"use strict";
const protobuf = require("protobufjs");
const JSZip = require("jszip");
const { GTFS_RT_PROTO } = require("../assets/lmt-core.js");

const CM01 = "8bc594e3-8ad6-4a0d-9138-bf8b4247e2f5";
const CM02 = "f3eaf277-a6fa-4f5b-8a61-3b1758d9a4b8";

const files = {
  agency: "agency_id,agency_name,agency_url,agency_timezone,agency_lang\nLMT,LANKA METRO TRANSIT PVT LTD,https://lankametro.lk,Asia/Colombo,en\n",
  routes: "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n" +
    CM01 + ",LMT,CM01,\"Makumbura – Maharagama – Nugegoda – Borella – Kadawatha Corridor\",,3,,008080,FFFFFF\n" +
    CM02 + ",LMT,CM02,Pettah – Fort – Rajagiriya – Battaramulla – Kottawa Express,,3,,FF4500,FFFFFF\n",
  stops: "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n" +
    "STATION_MAKUMBURA,STN_MAKUMBUR,Makumbura Hub,6.8395,79.9620,1,\n" +
    "101,STP_101,Makumbura 01,6.8396,79.9621,0,STATION_MAKUMBURA\n" +
    "102,STP_102,Maharagama,6.8480,79.9265,0,STATION_MAHARAGAMA\n" +
    "103,STP_103,Nugegoda,6.8720,79.8890,0,STATION_NUGEGODA\n" +
    "104,STP_104,Borella,6.9145,79.8770,0,STATION_BORELLA\n" +
    "105,STP_105,Kadawatha,7.0010,79.9530,0,STATION_KADAWATHA\n" +
    "201,STP_201,Pettah,6.9360,79.8520,0,STATION_PETTAH\n" +
    "202,STP_202,Rajagiriya,6.9090,79.8940,0,STATION_RAJAGIRIYA\n" +
    "203,STP_203,Battaramulla,6.9000,79.9180,0,STATION_BATTARAMULLA\n" +
    "204,STP_204,Kottawa,6.8410,79.9650,0,STATION_KOTTAWA\n",
  shapes: "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    [[6.8396, 79.9621], [6.8480, 79.9265], [6.8720, 79.8890], [6.9145, 79.8770], [7.0010, 79.9530]]
      .map((p, i) => "SHAPE_CM01_D0," + p[0] + "," + p[1] + "," + (i + 1)).join("\n") + "\n" +
    [[7.0010, 79.9530], [6.9145, 79.8770], [6.8720, 79.8890], [6.8480, 79.9265], [6.8396, 79.9621]]
      .map((p, i) => "SHAPE_CM01_D1," + p[0] + "," + p[1] + "," + (i + 1)).join("\n") + "\n",
  calendar: "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nLMT_ALL,1,1,1,1,1,1,1,20260101,20261231\n",
  fare_attributes: "fare_id,price,currency_type,payment_method,transfers\nFARE_STAGE_1_LOCAL,65,LKR,0,0\n",
  fare_rules: "fare_id,route_id\nFARE_STAGE_1_LOCAL," + CM01 + "\n",
  feed_info: ""
};

async function staticZip() {
  const zip = new JSZip();
  for (const [k, v] of Object.entries(files)) if (v) zip.file(k + ".txt", v);
  return zip.generateAsync({ type: "nodebuffer" });
}

const root = protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
function encode(obj) { return Buffer.from(FeedMessage.encode(FeedMessage.fromObject(obj)).finish()); }

function vehiclesFeed(now) {
  const t = Math.round(now);
  const ve = (id, o) => ({ id, vehicle: o });
  return encode({ header: { gtfs_realtime_version: "2.0", timestamp: t }, entity: [
    // Real producer shape: route_id is the route code, trip_id synthetic, speed in km/h.
    ve("e1", { trip: { trip_id: "LMT_CM01_0_WP-NE-5234", route_id: "CM01", direction_id: 0 }, vehicle: { id: "WP-NE-5234", label: "WP-NE-5234", license_plate: "WP-NE-5234" },
      position: { latitude: 6.8710, longitude: 79.8895, bearing: 300, speed: 32 }, timestamp: t - 20 }),
    // Older duplicate record of the same bus — must be collapsed.
    ve("e1-old", { trip: { route_id: "CM01" }, vehicle: { id: "WP-NE-5234" }, position: { latitude: 6.8480, longitude: 79.9265 }, timestamp: t - 400 }),
    // Route known only through the synthetic trip id; no bearing.
    ve("e2", { trip: { trip_id: "LMT_CM02_1_NB-1234" }, vehicle: { id: "NB-1234" }, position: { latitude: 6.9085, longitude: 79.8945, speed: 0 }, timestamp: t - 240 }),
    // Route referenced by its UUID.
    ve("e3", { trip: { route_id: CM02 }, vehicle: { id: "ND-7788", label: "ND-7788" }, position: { latitude: 6.9000, longitude: 79.9180, speed: 18 }, timestamp: t - 5,
      occupancy_status: "FEW_SEATS_AVAILABLE" }),
    // Expired record (2 h old) — dropped.
    ve("e4", { trip: { route_id: "CM01" }, vehicle: { id: "WP-NA-1111" }, position: { latitude: 6.9, longitude: 79.9 }, timestamp: t - 7200 }),
    // Another agency's vehicle (Sri Lanka Railways) inside Colombo — dropped.
    ve("e5", { trip: { trip_id: "TR_25", route_id: "COAST_LINE" }, vehicle: { id: "TRAIN-8325" }, position: { latitude: 6.93, longitude: 79.85 }, timestamp: t - 10 }),
    // Outside the service area (Kandy) — dropped.
    ve("e6", { trip: { route_id: "CM01" }, vehicle: { id: "CP-1234" }, position: { latitude: 7.29, longitude: 80.63 }, timestamp: t - 10 }),
    // CM05 runs but isn't in routes.txt yet — kept with its route code.
    ve("e8", { trip: { trip_id: "LMT_CM05_0_NC-4455", route_id: "CM05" }, vehicle: { id: "NC-4455" }, position: { latitude: 6.95, longitude: 79.90, speed: 12 }, timestamp: t - 15 }),
    // Zero position — dropped.
    ve("e7", { trip: { route_id: "CM01" }, vehicle: { id: "WP-0" }, position: { latitude: 0, longitude: 0 }, timestamp: t - 10 })
  ] });
}

function tripUpdatesFeed(now) {
  const t = Math.round(now);
  return encode({ header: { gtfs_realtime_version: "2.0", timestamp: t }, entity: [
    { id: "tu1", trip_update: { trip: { trip_id: "LMT_CM01_0_WP-NE-5234", route_id: "CM01" }, vehicle: { id: "WP-NE-5234" }, stop_time_update: [
      { stop_id: "102", arrival: { time: t - 600 } },          // already passed
      { stop_id: "104", arrival: { time: t + 300, delay: 60 } },
      { stop_id: "105", arrival: { time: t + 1500 } }
    ] } },
    { id: "tu2", trip_update: { trip: { route_id: CM02 }, vehicle: { id: "ND-7788" }, stop_time_update: [
      { stop_id: "104", departure: { time: t + 120 } },
      { stop_id: "203", schedule_relationship: "SKIPPED", arrival: { time: t + 60 } }
    ] } },
    { id: "tu3", trip_update: { trip: { trip_id: "TR_25", route_id: "COAST_LINE" }, stop_time_update: [{ stop_id: "ST_FORT", arrival: { time: t + 100 } }] } }
  ] });
}

function alertsFeed(now) {
  const t = Math.round(now);
  const ts = (s, lang) => ({ translation: [{ text: s, language: lang || "en" }] });
  return encode({ header: { gtfs_realtime_version: "2.0", timestamp: t }, entity: [
    { id: "a1", alert: { active_period: [{ start: t - 3600, end: t + 7200 }], informed_entity: [{ route_id: CM01 }],
      cause: "CONSTRUCTION", effect: "DETOUR", header_text: { translation: [{ text: "සංවර්ධන කටයුතු", language: "si" }, { text: "CM01 diverted at Borella", language: "en" }] },
      description_text: ts("Buses run via Baseline Road due to road works.") } },
    { id: "a2", alert: { active_period: [{ start: t - 7200, end: t - 3600 }], informed_entity: [{ route_id: "CM01" }], header_text: ts("Expired notice") } },
    { id: "a3", alert: { informed_entity: [{ route_id: "COAST_LINE", agency_id: "SLR" }], header_text: ts("Coast line delays") } },
    { id: "a4", alert: { cause: "OTHER_CAUSE", effect: "MODIFIED_SERVICE", header_text: ts("New Smart Card top-up points") } }
  ] });
}

module.exports = { CM01, CM02, files, staticZip, vehiclesFeed, tripUpdatesFeed, alertsFeed, FeedMessage };
