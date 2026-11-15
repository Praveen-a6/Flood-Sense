// Tests for the offline browser logic (rain parser, on-device model, routing).
// Run:  node tests/test_frontend.mjs      (Node 18+; start the server once first so the demo pack exists)
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRain } from "../frontend/js/rain.js";
import { predictPack, createPredictor, pAtLeast } from "../frontend/js/model.js";
import { buildSearchIndex, search } from "../frontend/js/places.js";
import { buildGraph, nearestNode, route, directions } from "../frontend/js/router.js";
import { buildNearbyPack } from "../frontend/js/live_pack.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };

test("rain words -> mm", () => {
  const r = parseRain("poured heavily for 3 hours, then drizzled 2 hours");
  assert.equal(r.events.length, 2);
  assert.equal(r.features.rain_24h, 62);
  assert.equal(r.features.rain_1h, 1);           // most recent hour was drizzle
});
test("units: cm, mm, inches", () => {
  assert.equal(parseRain("12 cm in 2 days").features.rain_72h, 120);
  assert.equal(parseRain("40 mm in 2 hours").features.rain_3h, 40);
  assert.equal(Math.round(parseRain("2 inches in 4 hours").features.rain_24h), 51);
});
test("Tamil and Tanglish", () => {
  assert.equal(parseRain("கனமழை 3 மணி நேரம்").features.rain_3h, 60);
  assert.equal(parseRain("romba mazhai 2 mani neram").features.rain_3h, 40);
});
test("dry spell and reservoir", () => {
  const r = parseRain("heavy rain for 4 hours, stopped 2 hours ago");
  assert.equal(r.features.rain_1h, 0);
  assert.equal(parseRain("dam gates opened, heavy rain 2 hrs").features.reservoir_release, 1);
});
test("garbage is rejected", () => assert.equal(parseRain("hello").ok, false));

const packPath = new URL("../data/packs/demo-city.json", import.meta.url);
const modelPath = new URL("../models/flood_model.json", import.meta.url);
if (fs.existsSync(packPath) && fs.existsSync(modelPath)) {
  const pack = JSON.parse(fs.readFileSync(packPath));
  pack.model = JSON.parse(fs.readFileSync(modelPath));
  pack.feature_names = pack.static_features.concat(pack.rain_features);
  const adj = buildGraph(pack);
  const heavy = predictPack(pack, parseRain(pack.demo_trip.rain).features);
  const dry = predictPack(pack, parseRain("drizzle for 1 hour").features);
  const start = nearestNode(pack, adj, pack.demo_trip.from).node;
  const poi = pack.pois.find((p) => p.name === pack.demo_trip.to_poi);
  const goal = nearestNode(pack, adj, [poi.lat, poi.lon]).node;

  test("heavy rain floods more roads than drizzle", () => {
    const count = (p) => p.cls.filter((c) => c >= 2).length;
    assert.ok(count(heavy) > count(dry));
    assert.equal(count(dry), 0);
  });
  test("demo trip: safe route avoids what the shortest route crosses", () => {
    const shortest = route(pack, adj, heavy, start, goal, "walk_child", "shortest");
    const safe = route(pack, adj, heavy, start, goal, "walk_child", "safe");
    assert.ok(shortest.flooded.length > 0);
    assert.equal(safe.flooded.length, 0);
    assert.ok(safe.lengthM > shortest.lengthM);
  });
  test("no rain: safe route == shortest", () => {
    const a = route(pack, adj, dry, start, goal, "car", "safe");
    const b = route(pack, adj, dry, start, goal, "car", "shortest");
    assert.equal(Math.round(a.lengthM), Math.round(b.lengthM));
  });
  test("directions end at the destination, with turn types for the nav banner", () => {
    const safe = route(pack, adj, heavy, start, goal, "walk_child", "safe");
    const steps = directions(pack, heavy, safe, poi.name);
    assert.match(steps.at(-1).text, /Arrive at Government General Hospital/);
    assert.match(steps[0].text, /^Head (north|south|east|west)/);
    assert.equal(steps.at(-1).turn, "arrive");
    assert.ok(steps.slice(1, -1).every((s) => ["left", "right", "sharp-left", "sharp-right", "straight", "uturn"].includes(s.turn)));
  });
  test("lazy predictor: routing only predicts the roads it explores", () => {
    const lazy = createPredictor(pack, parseRain(pack.demo_trip.rain).features);
    const r = route(pack, adj, lazy, start, goal, "walk_child", "safe");
    assert.ok(r && lazy.computed > 0 && lazy.computed < pack.segments.length / 2);
    for (const s of r.segs) assert.equal(lazy.cls[s], heavy.cls[s]);       // same answers as eager
    assert.equal(pAtLeast(lazy, r.segs[0], 0).toFixed(4), "1.0000");
  });
  test("offline search: streets, shops, areas, hospitals and saved places", () => {
    const idx = buildSearchIndex(pack);
    assert.ok(idx.some((e) => e.type === "Street") && idx.some((e) => e.type === "Area"));
    assert.equal(search(idx, [], "general hosp")[0].name, "Government General Hospital");
    assert.ok(search(idx, [], "medicals").length >= 3);
    const saved = [{ id: "home", name: "Amma's house", kind: "home", lat: 12.98, lon: 80.22 }];
    assert.equal(search(idx, saved, "home")[0].name, "Amma's house");
    assert.equal(search(idx, saved, "")[0].type, "Home");
  });
} else {
  console.log("  (skipping model/routing tests: run `python run.py` once to build the demo pack)");
}

const originalFetch = globalThis.fetch;
const originalCanvas = globalThis.OffscreenCanvas;
const originalImageBitmap = globalThis.createImageBitmap;
const centre = { lat: 13, lon: 80.2 };
const osmFixture = { elements: [
  { type: "way", id: 1, tags: { highway: "primary", name: "Cross Road" },
    geometry: [{ lat: 13, lon: 80.1995 }, centre, { lat: 13, lon: 80.2005 }] },
  { type: "way", id: 2, tags: { highway: "residential", name: "North Road" },
    geometry: [{ lat: 12.9995, lon: 80.2 }, centre, { lat: 13.0005, lon: 80.2 }] },
  { type: "node", id: 3, lat: 13, lon: 80.2001, tags: { place: "town", name: "Test Town" } },
  { type: "node", id: 4, lat: 13, lon: 80.2002, tags: { amenity: "hospital", name: "Test Hospital" } },
] };
try {
  const rgba = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 128; rgba[i + 1] = 128; }
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {}, getImageData() { return { data: rgba }; } }; }
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("overpass-api.de") || url.includes("overpass.kumi.systems"))
      return new Response(JSON.stringify(osmFixture), { status: 200 });
    if (url.includes("elevation-tiles-prod"))
      return new Response(new Blob(["mock elevation"]), { status: 200 });
    if (url.includes("open-meteo.com"))
      return new Response(JSON.stringify({ current: { time: "2026-01-01T10:00" }, hourly: { time: [], precipitation: [] } }), { status: 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const livePack = await buildNearbyPack(centre.lat, centre.lon);
  assert.equal(livePack.kind, "city");
  assert.equal(livePack.name, "Test Town (nearby map)");
  assert.ok(livePack.segments.length >= 2);
  assert.ok(livePack.segments.every((s) => s.f.length === 12 && s.f.every(Number.isFinite)));
  assert.equal(livePack.pois[0].name, "Test Hospital");
  assert.equal(livePack.pois[0].lat, centre.lat);
  passed++;
  console.log("  ok - build and package a GPS-centred map from direct OSM/elevation data");
} finally {
  globalThis.fetch = originalFetch;
  if (originalCanvas === undefined) delete globalThis.OffscreenCanvas;
  else globalThis.OffscreenCanvas = originalCanvas;
  if (originalImageBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = originalImageBitmap;
}
console.log(`\n${passed} passed`);
