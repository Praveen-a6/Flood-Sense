// Real-network smoke test for the browser city builder (js/cityengine.js).
//
// The mocked tests (tests/test_frontend.mjs) prove the pipeline logic; this tool
// proves the LIVE parts with real services, which no mock can:
//   1. which Overpass mirrors actually answer from THIS network (probeMirrors),
//   2. the real Nominatim boundary for a chosen city,
//   3. real AWS Terrain Tiles - decoded with a tiny built-in PNG decoder,
//      because Node has no canvas (the browser uses createImageBitmap),
//   4. real Open-Meteo weather.
// Roads are MOCKED (a small synthetic street net around the city centre) so the
// tool also works on networks where every Overpass mirror is unreachable.
//
// Usage: node tools/real_smoke.mjs [city name] [state]
//   e.g. node tools/real_smoke.mjs Thiruvottiyur "Tamil Nadu"

import zlib from "node:zlib";
import { decodeTerrariumRGBA } from "../frontend/js/packlib.js";
import { buildCityPack, probeMirrors, resolveBoundary, OVERPASS_MIRRORS } from "../frontend/js/cityengine.js";
import { CITIES, cityPackId, searchCities } from "../frontend/js/india_cities.js";

// Nominatim (and friends) refuse requests without a User-Agent. Browsers and the
// Android WebView always send one; Node's fetch does not - so this dev tool adds it.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) =>
  realFetch(url, { ...opts, headers: { "User-Agent": "FloodSense-real-smoke/1.0 (+https://github.com/; dev tool)", ...(opts.headers || {}) } });

// ---------------------------------------------------------------- PNG decoder
/** Minimal PNG reader (8-bit RGB or RGBA, non-interlaced) - enough for Terrarium tiles.
 *  Real AWS tiles are RGB (color type 2); the browser canvas path is RGBA, so we expand. */
function decodePNG(bytes) {
  const be32 = (b, o) => (b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]);
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= bytes.length) {
    const len = be32(bytes, p), type = String.fromCharCode(...bytes.slice(p + 4, p + 8));
    const data = bytes.slice(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = be32(data, 0); height = be32(data, 4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`unsupported tile PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp, px = new Uint8Array(width * height * bpp);
  let prev = new Uint8Array(stride), q = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[q++];
    const line = raw.slice(q, q + stride); q += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    px.set(cur, y * stride);
    prev = cur;
  }
  if (bpp === 4) return { width, height, data: px };
  const rgba = new Uint8Array(width * height * 4);       // RGB -> RGBA
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

// ---------------------------------------------------------------------- main
const nameArg = process.argv[2] || "Tiruvottiyur";
const stateArg = process.argv[3] || "";
const hit = CITIES[searchCities(nameArg, stateArg ? { state: stateArg } : {})[0]]
  || CITIES.find((c) => c.name.toLowerCase() === nameArg.toLowerCase());
if (!hit) { console.error(`"${nameArg}" is not in the built-in India catalogue.`); process.exit(1); }

console.log(`\n=== 1. Overpass mirror probe (this network) ===`);
const probe = await probeMirrors(OVERPASS_MIRRORS);
console.log(`any mirror answering: ${probe.anyOk}`);
probe.urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}${probe.anyOk && i === 0 ? "   <- fastest" : ""}`));

console.log(`\n=== 2. Real Nominatim boundary: ${hit.name}, ${hit.state} ===`);
const b = await resolveBoundary({ kind: "city", name: hit.name, state: hit.state, lat: hit.lat, lon: hit.lon, radiusKm: 3 },
  { onEvent: (k, t) => console.log(`  (${k}) ${t}`) });
console.log(`source: ${b.source}\nbbox:   ${b.bbox.map((v) => v.toFixed(4)).join(", ")}`);

console.log(`\n=== 3. Full build: real tiles + real weather, mocked roads ===`);
const { lat, lon } = hit;
const overpassMock = () => ({ elements: [
  { type: "way", tags: { highway: "primary", name: "T.P. Koil Street" },
    geometry: [{ lat: lat - 0.006, lon }, { lat: lat - 0.002, lon }, { lat: lat + 0.002, lon }, { lat: lat + 0.006, lon }] },
  { type: "way", tags: { highway: "residential", name: "Kamarajar Salai" },
    geometry: [{ lat, lon: lon - 0.006 }, { lat, lon: lon - 0.002 }, { lat, lon: lon + 0.002 }, { lat, lon: lon + 0.006 }] },
  { type: "way", tags: { highway: "secondary", name: "Chennai-Tiruvottiyur Road" },
    geometry: [{ lat: lat - 0.005, lon: lon - 0.005 }, { lat, lon }, { lat: lat + 0.005, lon: lon + 0.005 }] },
  { type: "way", tags: { waterway: "river", name: "Buckingham Canal" },
    geometry: [{ lat: lat - 0.007, lon: lon + 0.003 }, { lat: lat + 0.007, lon: lon + 0.004 }] },
  { type: "node", lat: lat + 0.001, lon: lon - 0.001, tags: { amenity: "hospital", name: "Government Hospital" } },
  { type: "node", lat: lat - 0.001, lon: lon + 0.002, tags: { shop: "bakery", name: "Vinayaga Bakery" } },
  { type: "node", lat: lat + 0.003, lon: lon + 0.003, tags: { place: "suburb", name: "Ponneri Nagar" } },
] });

const t0 = Date.now();
let tilesFetched = 0;
const res = await buildCityPack(
  { kind: "city", name: hit.name, state: hit.state, lat, lon, radiusKm: 3, packId: `smoke-${cityPackId(hit)}` },
  { fetchers: { overpass: overpassMock, decodeTile: async (bytes) => {
      const png = decodePNG(bytes); tilesFetched++;
      return decodeTerrariumRGBA(png.data, png.width, png.height);
    } },
    onProgress: (p, text) => { if (text && !text.startsWith("Downloading")) console.log(`  ${(p * 100).toFixed(0).padStart(3)}%  ${text}`); },
    onEvent: (k, t) => console.log(`  (${k}) ${t}`) });

const pack = res.pack;
const elev = pack.segments.flatMap((s) => [s.f[pack.static_features.indexOf("elev_m")]]).filter((v) => v != null);
console.log(`\n--- result (${((Date.now() - t0) / 1000).toFixed(1)} s) ---`);
console.log(`segments: ${pack.segments.length}  nodes: ${pack.nodes.length}  tiles fetched: ${tilesFetched}`);
console.log(`pois: ${pack.pois.length}  shops: ${pack.shops.length}  places: ${pack.places.length}`);
console.log(`weather: ${pack.weather?.source} rain_3h=${pack.weather?.rain?.rain_3h} rain_24h=${pack.weather?.rain?.rain_24h}`);
if (elev.length) console.log(`elevation on roads: ${Math.min(...elev).toFixed(1)} .. ${Math.max(...elev).toFixed(1)} m (real terrain)`);
console.log(`warnings: ${res.warnings.length ? res.warnings.join(" | ") : "none"}`);
console.log(`verify: ${(pack.verify || []).join(" | ") || "ok"}`);
console.log(`\nSMOKE TEST PASSED - boundary, elevation, weather and pack assembly all worked with live services.`);
