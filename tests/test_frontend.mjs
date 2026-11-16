// Tests for the offline browser logic (rain parser, on-device model, routing)
// and the browser-side city map builder (js/packlib.js + js/cityengine.js).
// Run:  node tests/test_frontend.mjs      (Node 18+; start the server once first so the demo pack exists)
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRain } from "../frontend/js/rain.js";
import { predictPack, createPredictor, pAtLeast } from "../frontend/js/model.js";
import { buildSearchIndex, search } from "../frontend/js/places.js";
import { buildGraph, nearestNode, route, directions } from "../frontend/js/router.js";
import {
  Grid, LocalProjection, STATIC_FEATURES, clipPackToPolygon, decodeTerrariumRGBA, parseOSM,
  parseOpenMeteo, pointInPolygon, priorityFlood, sampleDEM, tileXY, verifyPack, analyse,
} from "../frontend/js/packlib.js";
import { buildCityPack, defaultOverpass, estimatePack, fetchT, OVERPASS_MIRRORS, probeMirrors, proxyOverpass, resetMirrorProbe, resolveBoundary } from "../frontend/js/cityengine.js";
import { CITIES, cityPackId, cityRadiusKm, citiesInState, nearestCities, searchCities, slug } from "../frontend/js/india_cities.js";

const QUEUE = [];
const test = (name, fn) => QUEUE.push([name, fn]);
const atest = test;   // async tests run in the same order, awaited, at the bottom

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

// ==================================================== browser city builder
// These mirror the backend's tests (tests/test_core.py) test by test, so the
// pack built in the browser stays byte-compatible with `python packs.py build`.

test("priority flood fills a pit (JS port)", () => {
  const z = new Float64Array(9 * 9).fill(5.0);
  z[4 * 9 + 4] = 3.0;                     // 2 m deep pit
  const filled = priorityFlood(z, 9, 9);
  assert.ok(Math.abs(filled[4 * 9 + 4] - 5.0) < 0.01);
  assert.ok(Math.abs((filled[0] - z[0])) < 1e-6);
});

test("flow goes downhill and accumulates (JS port)", () => {
  const ny = 20, nx = 20, z = new Float64Array(ny * nx);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) z[i * nx + j] = j * 0.1;
  const t = analyse(z, ny, nx, 10, new Uint8Array(ny * nx));
  assert.ok(t.logAcc[10 * nx + 0] > t.logAcc[10 * nx + 19]);
  assert.ok(t.hand[10 * nx + 0] <= t.hand[10 * nx + 19]);
});

test("terrarium decoding (JS port)", () => {
  // elevation 10 m -> value 32778 -> R=128, G=10, B=0
  const px = new Uint8ClampedArray([128, 10, 0, 255]);
  assert.ok(Math.abs(decodeTerrariumRGBA(px, 1, 1)[0] - 10.0) < 1e-9);
});

atest("sampleDEM with fake tiles (JS port)", async () => {
  const proj = new LocalProjection(13.0, 80.2), grid = Grid.around(500, 50);
  const calls = [];
  const dem = await sampleDEM(proj, grid, 14, async (x, y) => {
    calls.push([x, y]);
    const t = new Float32Array(256 * 256);                 // elevation rises to the east inside every tile
    for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) t[i * 256 + j] = (j / 255) * 25.5;
    return t;
  });
  assert.equal(dem.length, grid.ny * grid.nx);
  assert.ok(dem.every((v) => Number.isFinite(v)));
  assert.ok(calls.length >= 1);
  const [tx, ty] = tileXY(13.0, 80.2, 14);
  assert.ok(tx > 0 && tx < 2 ** 14 && ty > 0 && ty < 2 ** 14);
});

const OSM_FIXTURE = { elements: [
  { type: "way", tags: { highway: "primary", name: "Main Road" },
    geometry: [{ lat: 13.0, lon: 80.195 }, { lat: 13.0, lon: 80.200 }, { lat: 13.0, lon: 80.205 }] },
  { type: "way", tags: { highway: "residential", name: "Cross St" },
    geometry: [{ lat: 12.996, lon: 80.200 }, { lat: 13.0, lon: 80.200 }, { lat: 13.004, lon: 80.200 }] },
  { type: "way", tags: { highway: "secondary", name: "Subway", tunnel: "yes", layer: "-1" },
    geometry: [{ lat: 13.0, lon: 80.195 }, { lat: 13.002, lon: 80.195 }] },
  { type: "way", tags: { highway: "service", name: "Island Lane" },
    geometry: [{ lat: 12.998, lon: 80.204 }, { lat: 12.9982, lon: 80.2043 }] },
  { type: "way", tags: { highway: "residential", name: "One Way St", oneway: "-1" },
    geometry: [{ lat: 13.004, lon: 80.200 }, { lat: 13.004, lon: 80.203 }] },
  { type: "way", tags: { waterway: "canal" },
    geometry: [{ lat: 12.995, lon: 80.203 }, { lat: 13.005, lon: 80.203 }] },
  { type: "node", lat: 13.003, lon: 80.201, tags: { amenity: "hospital", name: "Test Hospital" } },
  { type: "way", tags: { amenity: "school", name: "Test School" },
    geometry: [{ lat: 12.997, lon: 80.198 }, { lat: 12.997, lon: 80.1985 }, { lat: 12.9975, lon: 80.1985 }] },
  { type: "node", lat: 13.001, lon: 80.199, tags: { place: "suburb", name: "Test Nagar" } },
  { type: "node", lat: 13.0005, lon: 80.2005, tags: { shop: "bakery", name: "Test Bakery" } },
  { type: "node", lat: 12.9995, lon: 80.2015, tags: { amenity: "pharmacy", name: "Test Medicals" } },
] };

test("parse_osm fixture (JS port)", () => {
  const out = parseOSM(OSM_FIXTURE, new LocalProjection(13.0, 80.2));
  assert.equal(out.ways.length, 5);
  assert.ok(out.ways.some((w) => w.tunnel));
  const ow = out.ways.find((w) => w.name === "One Way St");
  assert.ok(ow.oneway && ow.xy[0][0] > ow.xy[out.ways.find((w) => w.name === "One Way St").xy.length - 1][0]);
  assert.deepEqual([...new Set(out.pois.map((p) => p.type))].sort(), ["hospital", "shelter"]);
  assert.equal(out.waterLines.length, 1);
  assert.deepEqual(out.places.map((p) => p.name), ["Test Nagar"]);
  const shopNames = new Set(out.shops.map((p) => p.name));
  for (const n of ["Test Bakery", "Test Medicals", "Test Hospital"]) assert.ok(shopNames.has(n));
});

test("open-meteo parsing (JS port)", () => {
  const js = { current: { time: "2026-11-14T05:15" },
    hourly: { time: Array.from({ length: 24 }, (_, h) => `2026-11-14T${String(h).padStart(2, "0")}:00`), precipitation: Array.from({ length: 24 }, (_, h) => h) } };
  const w = parseOpenMeteo(js);
  assert.equal(w.rain.rain_1h, 5);
  assert.equal(w.rain.rain_3h, 3 + 4 + 5);
  assert.equal(w.rain.rain_fc_3h, 6 + 7 + 8);
});

test("point in polygon", () => {
  const poly = { type: "Polygon", coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]] };
  assert.ok(pointInPolygon(0, 0, poly));
  assert.ok(!pointInPolygon(2, 0, poly));
  const multi = { type: "MultiPolygon", coordinates: [[[[5, 5], [7, 5], [7, 7], [5, 7], [5, 5]]]] };
  assert.ok(pointInPolygon(6, 6, multi) && !pointInPolygon(0, 0, multi));
});

const meteo = { current: { time: "2026-11-14T10:00", temperature_2m: 25, wind_speed_10m: 20,
  wind_gusts_10m: 40, relative_humidity_2m: 90, precipitation: 3 },
  hourly: { time: Array.from({ length: 96 }, (_, h) => `2026-11-${11 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00`),
    precipitation: Array.from({ length: 96 }, () => 1.0) } };

const fakeTile = (x, y) => {                       // deterministic terrain, different per tile
  const t = new Float32Array(256 * 256);
  for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++)
    t[i * 256 + j] = 8 + 0.5 * Math.sin(i / 32 + x) + 0.5 * Math.cos(j / 32 + y);
  return t;
};

atest("buildCityPack end-to-end with mocks (JS port)", async () => {
  const res = await buildCityPack(
    { kind: "area", name: "Test Area", lat: 13.0, lon: 80.2, radiusKm: 0.6, packId: "area-test" },
    { fetchers: {
      overpass: async () => OSM_FIXTURE,
      tile: async () => new Uint8Array([0]),
      decodeTile: async (b, ctx) => fakeTile(0, 0),
      weather: async () => parseOpenMeteo(meteo),
    }, concurrency: 2 });
  const pack = res.pack;
  assert.ok(pack.segments.length >= 6);
  const names = new Set(pack.segments.map((s) => s.name));
  for (const n of ["Main Road", "Cross St", "Subway"]) assert.ok(names.has(n), `missing ${n}`);
  assert.ok(!names.has("Island Lane"));            // disconnected fragment pruned
  const underIdx = STATIC_FEATURES.indexOf("underpass");
  assert.ok(pack.segments.filter((s) => s.name === "Subway").every((s) => s.f[underIdx] === 1));
  const main = new Set(pack.segments.filter((s) => s.name === "Main Road").flatMap((s) => [s.a, s.b]));
  const cross = new Set(pack.segments.filter((s) => s.name === "Cross St").flatMap((s) => [s.a, s.b]));
  assert.ok([...main].some((n) => cross.has(n)));  // share a junction node
  assert.ok(Math.abs(pack.weather.rain.rain_3h - 3.0) < 1e-9);
  assert.equal(pack.places[0].name, "Test Nagar");
  assert.ok(pack.shops.some((p) => p.name === "Test Bakery"));
  assert.ok(pack.tiles && pack.segments.every((s) => "t" in s));
  assert.equal(pack.version, 2);
  assert.deepEqual(pack.static_features, STATIC_FEATURES);
  // clipping to a polygon keeps only what is inside, with valid node indices
  const half = 0.0018;
  const westHalf = { type: "Polygon", coordinates: [[[80.2 - half, 12.99], [80.2 - half, 13.01],
    [80.2 + half, 13.01], [80.2 + half, 12.99], [80.2 - half, 12.99]]] };
  const clipped = clipPackToPolygon(structuredClone(pack), westHalf);
  assert.ok(clipped.segments.length > 0 && clipped.segments.length < pack.segments.length);
  assert.ok(clipped.segments.every((s) => s.a >= 0 && s.a < clipped.nodes.length && s.b >= 0 && s.b < clipped.nodes.length));
  assert.ok(clipped.pois.every((p) => pointInPolygon(p.lon, p.lat, westHalf)));
});

atest("boundary resolution: polygon, node fallback, box fallback, taluk clipping", async () => {
  const box = { name: "Test", state: "Tamil Nadu", lat: 13.0, lon: 80.2, radiusKm: 3, kind: "city" };
  const b1 = await resolveBoundary(box, { fetchNominatim: async () => ({
    osm_type: "relation", boundingbox: ["12.99", "13.01", "80.19", "80.21"],
    geojson: { type: "Polygon", coordinates: [[[80.19, 12.99], [80.21, 12.99], [80.21, 13.01], [80.19, 13.01], [80.19, 12.99]]] } }) });
  assert.equal(b1.source, "admin boundary");                    // a town-sized boundary is kept as-is
  assert.deepEqual(b1.bbox, [12.99, 80.19, 13.01, 80.21]);
  assert.ok(b1.polygon);                                       // with its outline
  const b2 = await resolveBoundary(box, { fetchNominatim: async () => ({ osm_type: "node", lat: 13.0, lon: 80.2, boundingbox: ["13", "13", "80.2", "80.2"] }) });
  assert.equal(b2.source, "approximate box");
  const b3 = await resolveBoundary(box, { fetchNominatim: async () => { throw new Error("down"); } });
  assert.equal(b3.source, "approximate box");
  assert.ok(b3.bbox[2] > b3.bbox[0] && b3.bbox[3] > b3.bbox[1]);
  // Nominatim's first areal hit for a small town is often its TALUK (measured:
  // "Ponneri" -> a 48 km county): the map must stay at the promised town scale,
  // and the taluk outline must be dropped (it would cut neighbouring villages).
  let warned = "";
  const b4 = await resolveBoundary(box, { fetchNominatim: async () => ({
      osm_type: "relation", boundingbox: ["12.9", "13.1", "80.1", "80.3"],
      geojson: { type: "Polygon", coordinates: [[[80.1, 12.9], [80.3, 12.9], [80.3, 13.1], [80.1, 13.1], [80.1, 12.9]]] } }),
    onEvent: (k, t) => { warned = t; } });
  assert.equal(b4.source, "admin boundary (clipped)");
  assert.ok(b4.bbox[2] - b4.bbox[0] < 0.085 && b4.bbox[3] - b4.bbox[1] < 0.085);   // ~<= 7.5 x 7.5 km (1.25 x 3 km radius)
  assert.equal(b4.polygon, null);                              // the taluk outline is the wrong feature's shape
  assert.match(warned, /much larger area/);
  // a state-sized boundary is clipped around the anchor with a warning
  let warned2 = "";
  const b5 = await resolveBoundary({ name: "Big Region", lat: 13.0, lon: 80.2, radiusKm: 10, kind: "state", maxHalfKm: 15 },
    { fetchNominatim: async () => ({ osm_type: "relation", boundingbox: ["8", "20", "75", "88"], geojson: { type: "Polygon", coordinates: [[[75, 8], [88, 8], [88, 20], [75, 20], [75, 8]]] } }),
      onEvent: (k, t) => { warned2 = t; } });
  assert.ok(b5.bbox[2] - b5.bbox[0] < 0.3 && b5.bbox[3] - b5.bbox[1] < 0.35);   // ~30 x 30 km max
  assert.ok(warned2.includes("much larger area") || warned2.includes("very large"));
});

test("pack verification catches broken packs (JS port)", () => {
  assert.deepEqual(verifyPack({ version: 2, segments: [], nodes: [] }).filter((p) => p.includes("no road")), ["no road segments"]);
  const broken = { version: 1, segments: [{ id: 0, a: 0, b: 5, f: [1.0], name: "" }], nodes: [[0, 0]], pois: [] };
  const probs = verifyPack(broken);
  assert.ok(probs.some((p) => p.includes("old pack format")));
  assert.ok(probs.some((p) => p.includes("missing junctions")));
});

test("pre-download estimate is sane", () => {
  const est = estimatePack(12.9, 80.1, 13.1, 80.3);          // ~22 x 22 km
  assert.ok(est.areaKm2 > 300 && est.areaKm2 < 700);
  assert.ok(est.chunks >= 25 && est.tiles > 50);
  assert.ok(est.packMB > 5 && est.minutes >= 1);
});

// ================================================== India city catalogue
test("catalogue: every Indian city and town, with states", () => {
  assert.ok(CITIES.length >= 1200);
  assert.ok(CITIES.every((c) => c.name && c.state && Number.isFinite(c.lat) && Number.isFinite(c.lon)));
  assert.ok(CITIES.every((c) => c.lat > 6 && c.lat < 36 && c.lon > 68 && c.lon < 98));
  assert.ok(CITIES[0].pop >= CITIES[CITIES.length - 1].pop);   // sorted, biggest first
  assert.ok(citiesInState("Kerala", 50).length >= 5);
});

test("catalogue: search and GPS nearest cities", () => {
  assert.equal(CITIES[searchCities("chennai")[0]].state, "Tamil Nadu");
  assert.ok(CITIES[searchCities("mumbai")[0]].pop > 1e7);
  const near = nearestCities(13.08, 80.27, 3);                 // somewhere in Chennai
  assert.ok(CITIES[near[0]].name === "Chennai" || CITIES[near[0]]._d < 30000);
  assert.ok(CITIES[near[0]]._d < CITIES[near[2]]._d);          // sorted by distance
  const delhi = nearestCities(28.61, 77.21, 1);
  assert.ok(CITIES[delhi[0]].name.includes("Delhi"));
});

test("catalogue: map radius by city size, url-safe ids", () => {
  assert.equal(cityRadiusKm(12691836), 10);
  assert.equal(cityRadiusKm(15000), 3);
  assert.ok(cityRadiusKm(900000) > cityRadiusKm(90000));
  assert.equal(slug("T. Nagar, Chennai!"), "t-nagar-chennai");
});

test("saved-map ids never collide between same-name cities", () => {
  const ids = new Set(CITIES.map((c) => cityPackId(c)));
  assert.equal(ids.size, CITIES.length);                  // every city gets its own map slot
  const dup = CITIES.find((c) => CITIES.some((d) => d !== c && d.name === c.name));
  assert.ok(dup, "catalogue is expected to contain same-name cities");
  assert.equal(cityPackId(dup), `city-${slug(dup.name)}-${slug(dup.state)}`);   // state disambiguates
  const uni = CITIES.find((c) => !CITIES.some((d) => d !== c && d.name === c.name));
  assert.equal(cityPackId(uni), `city-${slug(uni.name)}`);                      // unique name stays short
});

test("city search survives Indian transliteration variants", () => {
  assert.ok(CITIES[searchCities("chennai")[0]].name === "Chennai");            // exact spelling still wins
  const th = searchCities("Thiruvottiyur");                                    // h-spelling of Tiruvottiyur
  assert.ok(th.length >= 1 && CITIES[th[0]].name === "Tiruvottiyur");
  const thr = searchCities("thiruvananthapuram");                              // official: Thiruvananthapuram
  assert.ok(thr.length >= 1);
  assert.ok(searchCities("zzzznotacity").length === 0);                        // nonsense stays empty
});

test("a request timeout is a TimeoutError, not a cancellation", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => new Promise((_, rej) => {   // a server that never answers,
    opts?.signal?.addEventListener("abort", () => {                  // but the connection still breaks
      const e = new Error("aborted"); e.name = "AbortError"; rej(e); // exactly like a real fetch abort
    });
  });
  try {
    let e;
    try { await fetchT("https://mirror.test/api", { timeoutMs: 40 }); assert.fail("should reject"); }
    catch (err) { e = err; }
    assert.equal(e?.name, "TimeoutError");                 // -> the retry loop goes to the next mirror
    const ctl = new AbortController(); ctl.abort();
    try { await fetchT("https://mirror.test/api", { timeoutMs: 40, signal: ctl.signal }); assert.fail("should reject"); }
    catch (err) { e = err; }
    assert.equal(e?.name, "AbortError");                   // -> only a real cancel stops the build
  } finally { globalThis.fetch = real; }
});

test("mirror probe puts responsive servers first", async () => {
  const urls = ["https://a.test/", "https://b.test/", "https://c.test/"];
  const { urls: ordered, anyOk } = await probeMirrors(urls, { timeoutMs: 500, fetcher: async (u) => {
    if (u === "https://c.test/") throw new Error("refused");
    if (u === "https://a.test/") await new Promise((r) => setTimeout(r, 25));
    return { ok: true, json: async () => ({}) };
  } });
  assert.equal(anyOk, true);
  assert.equal(ordered[0], "https://b.test/");            // fastest answer comes first
  assert.equal(ordered.length, 3);                        // the dead mirror stays in the list as a fallback
  const dead = await probeMirrors(urls, { timeoutMs: 100, fetcher: async () => { throw new Error("refused"); } });
  assert.equal(dead.anyOk, false);
  assert.deepEqual(dead.urls, urls);                      // nothing answered: keep the original order
});

// ---- the Overpass fetch ladder (mirrors -> server relay -> patient retry) ----
const TINY = "[out:json][timeout:5];node(0,0,0.01,0.01);out count;";
const restore = (real, realCap) => { globalThis.fetch = real; if (realCap === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = realCap; };

test("mirrors alive -> direct answer, the server relay is never touched", async () => {
  resetMirrorProbe();
  const real = globalThis.fetch;
  let relayCalls = 0;
  globalThis.fetch = async (url) => {                       // every Overpass POST just works
    if (String(url).endsWith("/api/overpass")) relayCalls++;
    return { ok: true, status: 200, json: async () => ({ elements: [{ type: "node", id: 1 }] }) };
  };
  try {
    const data = await defaultOverpass(TINY, {});
    assert.equal(data.elements[0].id, 1);
    assert.equal(relayCalls, 0);                            // healthy mirrors never touch the relay
  } finally { restore(real, globalThis.Capacitor); }
});

test("every mirror dead -> the server relay saves the chunk", async () => {
  resetMirrorProbe();
  const real = globalThis.fetch, realCap = globalThis.Capacitor;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(String(url));
    if (String(url).endsWith("/api/overpass"))
      return { ok: true, status: 200, json: async () => ({ elements: [{ type: "node", id: 7 }] }) };
    throw new TypeError("network blocked");                 // not even the mirror probe gets an answer
  };
  try {
    const events = [];
    const data = await defaultOverpass(TINY, { onEvent: (k, t) => events.push([k, t]) });
    assert.equal(data.elements[0].id, 7);                   // the chunk came through the relay
    // 5 probe POSTs + 5 quick direct attempts all happened BEFORE the relay call
    assert.equal(seen.filter((u) => u !== "/api/overpass").length, OVERPASS_MIRRORS.length * 2);
    assert.equal(seen.at(-1), "/api/overpass");
    assert.ok(events.some(([k, t]) => k === "retry" && /FloodSense server/.test(t)));
    assert.ok(events.some(([k]) => k === "warn"));          // the probe warned that nothing answered
  } finally { restore(real, realCap); }
});

test("relay is skipped in the installed app without a configured server", async () => {
  const real = globalThis.fetch, realCap = globalThis.Capacitor;
  let calls = 0;
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: {} };   // pretend we're the APK
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  try {
    let err; try { await proxyOverpass(TINY, {}); assert.fail("should reject"); } catch (e) { err = e; }
    assert.match(err.message, /no FloodSense server configured/);
    assert.equal(calls, 0);                                 // rejected before any network use
  } finally { restore(real, realCap); }
});

test("everything fails -> honest BuildError naming both legs", async () => {
  resetMirrorProbe();
  const real = globalThis.fetch, realCap = globalThis.Capacitor;
  globalThis.fetch = async () => { throw new TypeError("network blocked"); };  // mirrors AND relay dead
  try {
    let err; try { await defaultOverpass(TINY, {}); assert.fail("should reject"); } catch (e) { err = e; }
    assert.equal(err.name, "BuildError");
    assert.equal(err.stage, "osm");
    assert.match(err.message, /and through the FloodSense server relay/);
    assert.match(err.message, /Finished parts are kept/);  // resume promise is stated
  } finally { restore(real, realCap); }
});

test("relay won a chunk -> the next chunk goes through it first (sticky)", async () => {
  resetMirrorProbe();
  const real = globalThis.fetch, realCap = globalThis.Capacitor;
  let seen = [];                                             // urls per fetch, one list per chunk
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/api/overpass"))
      return { ok: true, status: 200, json: async () => ({ elements: [{ type: "node", id: 9 }] }) };
    throw new TypeError("network blocked");                  // mirrors never answer, not even the probe
  };
  try {
    // chunk 1: everything direct is dead -> quick round, then the relay
    const p1 = await defaultOverpass(TINY, {});
    assert.equal(p1.elements[0].id, 9);
    assert.ok(seen.some((u) => u === "/api/overpass"));
    const relayAt = seen.indexOf("/api/overpass");
    assert.ok(seen.slice(0, relayAt).filter((u) => u !== "/api/overpass").length >= OVERPASS_MIRRORS.length);
    // chunk 2: the relay just delivered -> it is tried FIRST, no dead-mirror grinding
    seen = [];
    const p2 = await defaultOverpass(TINY, {});
    assert.equal(p2.elements[0].id, 9);
    assert.equal(seen[0], "/api/overpass");                  // first fetch of the chunk is the relay
  } finally { restore(real, realCap); }
});

test("hanging mirrors fast-forward to the relay after one round", async () => {
  resetMirrorProbe();
  const real = globalThis.fetch, realCap = globalThis.Capacitor;
  let mirrorQueries = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/api/overpass"))
      return { ok: true, status: 200, json: async () => ({ elements: [{ type: "node", id: 11 }] }) };
    const body = opts?.body?.toString() || "";
    if (body.includes("out+count"))
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };   // probe: alive
    if (u.includes("overpass") && opts?.method === "POST") {
      mirrorQueries++;                                       // real chunk query: silence until timeout
      const e = new Error("no answer within 120 s"); e.name = "TimeoutError"; throw e;
    }
    return { ok: true, status: 200, json: async () => ({ elements: [] }) };
  };
  const CHUNK = "[out:json][timeout:200];way(0,0,0.01,0.01);out tags geom;";
  try {
    const data = await defaultOverpass(CHUNK, {});
    assert.equal(data.elements[0].id, 11);
    // exactly ONE mirror round (5 mirrors) ran before the relay - not the scheduled two
    assert.equal(mirrorQueries, OVERPASS_MIRRORS.length);
  } finally { restore(real, realCap); }
});

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

// ---- run everything in order, stop at the first failure ----
let passed = 0;
for (const [name, fn] of QUEUE) {
  try {
    await fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    console.error(`\n  FAIL - ${name}`);
    console.error(e);
    process.exit(1);
  }
}
console.log(`\n${passed} passed`);
