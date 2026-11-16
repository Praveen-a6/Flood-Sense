// FloodSense client-side city map engine: downloads OpenStreetMap + elevation + weather
// for a whole city IN THE BROWSER and assembles the offline pack with js/packlib.js.
//
// This is the browser twin of backend/pack_builder.py:
//   roads, water, hospitals, shelters  <- OpenStreetMap via the Overpass API (5 mirrors,
//                                          probed for the fastest reachable one, 3x3 km chunks;
//                                          last resort: relayed through the FloodSense server)
//   city boundary                      <- Nominatim (admin polygon; graceful fallback to a sized box)
//   elevation                          <- AWS Terrain Tiles (Terrarium PNG, zoom 14, parallel)
//   rain, wind, temperature            <- Open-Meteo (direct; falls back to this server's /api/weather)
//
// No DOM, no server-side pack preparation: every fetch has retries, a timeout and an
// AbortSignal. Chunks and elevation tiles are cached in IndexedDB, so an interrupted
// download resumes where it stopped. All fetchers are injectable - tests/test_frontend.mjs
// runs the whole engine against fakes, exactly like tests/test_core.py does for Python.

import {
  Grid, LocalProjection, OPEN_METEO_PARAMS, clipPackToPolygon, decodeTerrariumRGBA, fillHoles,
  haversineM, overpassQuery, parseOSM, parseOpenMeteo, sampleDEM, verifyPack, buildPack,
} from "./packlib.js";
import { apiUrl, hasServer, isNative } from "./mobile.js";

export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

export const MAX_HALF_KM = { city: 15, state: 30, area: 30 };    // hard caps, like the backend's 10 km city cap
const CHUNK_KM = 3.0;

// ------------------------------------------------------------------ helpers
export class BuildError extends Error {
  constructor(message, { stage = "", retryable = true } = {}) {
    super(message); this.name = "BuildError"; this.stage = stage; this.retryable = retryable;
  }
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(abortError()); }, { once: true });
});
const abortError = () => { const e = new Error("cancelled"); e.name = "AbortError"; return e; };

function checkSignal(signal) { if (signal?.aborted) throw abortError(); }

/** fetch with a per-request timeout, combined with an outer abort signal.
 *  A request's own timeout is NOT a user cancellation: it rejects with a TimeoutError,
 *  so callers retry / fall back to the next server instead of aborting the whole
 *  build. A cancelled signal stays an AbortError and stops everything immediately. */
export async function fetchT(url, { method = "GET", body, headers, timeoutMs = 30000, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    return await fetch(url, { method, body, headers, signal: ctl.signal, cache: "no-store", mode: "cors" });
  } catch (e) {
    if (timedOut && !signal?.aborted) {
      const err = new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Dev/test overrides: ?overpass-url= &tiles-url= &nominatim-url= &meteo-url= (http/https only).
 *  Read on the main thread and passed into the worker (a worker has no page query string). */
export function devOverrides() {
  if (typeof location === "undefined" || !location.search) return {};
  const ok = (u) => (/^https?:\/\//i.test(u) ? u : undefined);
  const p = new URLSearchParams(location.search);
  return {
    overpass: ok(p.get("overpass-url")), tiles: ok(p.get("tiles-url")),
    nominatim: ok(p.get("nominatim-url")), meteo: ok(p.get("meteo-url")),
  };
}

// Active overrides for the current build (set at the start of buildCityPack).
let OV = {};
const setOverrides = (o) => { OV = { ...devOverrides(), ...(o || {}) }; };
const cacheTag = () => ((OV.overpass || OV.tiles || OV.nominatim || OV.meteo) ? "dev:" : "");

// ------------------------------------------------------------- estimation
/** Rough, honest pre-download estimate for the confirm dialog (no network). */
export function estimatePack(south, west, north, east) {
  const hkm = haversineM((south + north) / 2, west, (south + north) / 2, east) / 1000;
  const vkm = haversineM(south, (west + east) / 2, north, (west + east) / 2) / 1000;
  const area = hkm * vkm;
  const chunks = Math.max(1, Math.ceil(hkm / CHUNK_KM)) * Math.max(1, Math.ceil(vkm / CHUNK_KM));
  return {
    areaKm2: Math.round(area), chunks, tiles: Math.ceil(area / 1.3) + 6,
    packMB: Math.max(0.3, Math.round(area * 0.12 * 10) / 10),
    minutes: Math.max(1, Math.round((chunks * 8) / 60 + area / 400)),
  };
}

// --------------------------------------------------------------- boundary
/** Resolve the city's administrative boundary (Nominatim), with graceful fallbacks. */
export async function resolveBoundary(spec, { fetchNominatim = defaultNominatim, signal, onEvent = () => {} } = {}) {
  // The map must stay at the scale the picker promised: Nominatim's first areal hit
  // for a small town is often its TALUK or district (measured: "Ponneri" -> a 48 km
  // sub-district), which would quietly turn a promised 8 x 8 km town into a 30 x 30
  // km, 100-chunk download. So the cap scales with the promised radius (1.25x, at
  // least 4 km) and never exceeds the hard per-kind maximum.
  const kindCap = MAX_HALF_KM[spec.kind] ?? 15;
  const maxHalf = (spec.maxHalfKm ?? (spec.kind === "city"
    ? Math.min(kindCap, Math.max(1.25 * (spec.radiusKm || 5), 4)) : kindCap)) * 1000;
  const boxAround = (lat, lon, halfM) => {
    const proj = new LocalProjection(lat, lon);
    const [s, w] = proj.toLatLon(-halfM, -halfM), [n, e] = proj.toLatLon(halfM, halfM);
    return [s, w, n, e];
  };
  const fallback = () => {
    const half = Math.min(maxHalf, spec.radiusKm * 1000 || 3000);
    onEvent("warn", `Couldn't resolve the official city boundary - using a ${Math.round((2 * half) / 1000)} x ${Math.round((2 * half) / 1000)} km box around the centre instead.`);
    return { bbox: boxAround(spec.lat, spec.lon, half), polygon: null, source: "approximate box" };
  };
  if (spec.kind === "area") return { bbox: boxAround(spec.lat, spec.lon, Math.min(maxHalf, spec.radiusKm * 1000)), polygon: null, source: "area" };

  let hit = null;
  try {
    hit = await fetchNominatim(`${spec.name}${spec.state ? `, ${spec.state}` : ""}, India`, { signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return fallback();
  }
  if (!hit || hit.osm_type === "node" || !hit.boundingbox) return fallback();
  const bb = hit.boundingbox.map(Number);                    // Nominatim: [south, north, west, east]
  let bbox = [bb[0], bb[2], bb[1], bb[3]];
  if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1]) || bbox[2] - bbox[0] < 1e-4) return fallback();
  let polygon = hit.geojson && (hit.geojson.type === "Polygon" || hit.geojson.type === "MultiPolygon") ? hit.geojson : null;
  let clipped = false;
  const halfS = haversineM(bbox[0], (bbox[1] + bbox[3]) / 2, bbox[2], (bbox[1] + bbox[3]) / 2) / 2;
  const halfW = haversineM((bbox[0] + bbox[2]) / 2, bbox[1], (bbox[0] + bbox[2]) / 2, bbox[3]) / 2;
  if (halfS > maxHalf || halfW > maxHalf) {                  // feature far bigger than the promised map (taluk, district, metro region): clip around the anchor
    clipped = true;
    // When only a small core of the feature is kept (cap under half its own extent),
    // the feature is the WRONG ONE for this place (town inside a taluk): its outline
    // would cut neighbouring villages out of the map - keep the box instead.
    if (maxHalf < 0.5 * Math.max(halfS, halfW)) polygon = null;
    const [s2, w2] = new LocalProjection(spec.lat, spec.lon).toLatLon(-maxHalf, -maxHalf);
    const [n2, e2] = new LocalProjection(spec.lat, spec.lon).toLatLon(maxHalf, maxHalf);
    const cut = [Math.max(bbox[0], s2), Math.max(bbox[1], w2), Math.min(bbox[2], n2), Math.min(bbox[3], e2)];
    bbox = cut[2] > cut[0] && cut[3] > cut[1] ? cut : boxAround(spec.lat, spec.lon, maxHalf);
    onEvent("warn", `${spec.name} here covers a much larger area (${Math.round((2 * halfS) / 1000)} x ${Math.round((2 * halfW) / 1000)} km) than the map you picked: the offline map covers the ${Math.round((2 * maxHalf) / 1000)} x ${Math.round((2 * maxHalf) / 1000)} km around the centre instead.`);
  }
  const polyPoints = polygon ? polygon.coordinates.flat(2).length : 0;
  if (polygon && polyPoints > 30000) {
    polygon = null;
    onEvent("warn", "Boundary outline too detailed to clip street-by-street - keeping the bounding box.");
  }
  return { bbox, polygon, source: clipped ? "admin boundary (clipped)" : "admin boundary" };
}

async function defaultNominatim(q, { signal } = {}) {
  const url = OV.nominatim || NOMINATIM_URL;
  const r = await fetchT(`${url}?q=${encodeURIComponent(q)}&format=json&limit=5&polygon_geojson=1&addressdetails=0`,
    { signal, timeoutMs: 20000 });
  if (!r.ok) throw new BuildError(`Nominatim HTTP ${r.status}`, { stage: "boundary" });
  const hits = await r.json();
  if (!Array.isArray(hits) || !hits.length) return null;
  // The first hit is often a station or suburb NODE; the city boundary is a
  // relation. Ask for a few and prefer the first hit that actually has an area.
  return hits.find((h) => h && (h.osm_type === "relation" || h.osm_type === "way") && Array.isArray(h.boundingbox)) || hits[0];
}

// ------------------------------------------------------------------- OSM
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

/** Ask every mirror a tiny query and order them by who answers. Some networks
 *  (several Indian ISPs among them) cannot reach every Overpass mirror, so ~18 s
 *  of probing up front saves minutes of waiting on servers that will never answer.
 *  The timeout must stay patient: a mirror that answers a trivial query in 14-17 s
 *  (measured, maps.mail.ru over a slow path) is SLOW, not dead - writing it off
 *  would leave the user with no server at all.
 *  Mirrors that stay silent keep their place at the back: the retry loop still tries
 *  them if the network recovers. Never rejects. */
export async function probeMirrors(urls, { fetcher = fetchT, signal, timeoutMs = 18000 } = {}) {
  const probed = await Promise.all(urls.map(async (url) => {
    const t0 = performance.now();
    try {
      const r = await fetcher(url, {
        method: "POST", body: new URLSearchParams({ data: "[out:json][timeout:5];node(0,0,0.01,0.01);out count;" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeoutMs, signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.json();
      return { url, ok: true, ms: performance.now() - t0 };
    } catch { return { url, ok: false, ms: Infinity }; }
  }));
  const sorted = probed.slice().sort((a, b) => (b.ok - a.ok) || (a.ms - b.ms));
  return { urls: sorted.map((p) => p.url), anyOk: sorted.some((p) => p.ok) };
}

let MIRROR_PROBE = null;    // probe-ordered mirror list, remembered for the session once one answers
let DEAD_PROBE_AT = 0;      // when every mirror last stayed silent (re-probe at most once a minute)
let RELAY_WON_AT = 0;       // when the server relay last delivered a chunk (sticky: see defaultOverpass)

/** Forget the cached probe and relay win (tests). */
export function resetMirrorProbe() { MIRROR_PROBE = null; DEAD_PROBE_AT = 0; RELAY_WON_AT = 0; }

/** Which mirrors to use: the dev override as-is, otherwise the probe-ordered list. */
async function orderedMirrors(onEvent) {
  if (OV.overpass) return { urls: [OV.overpass], anyOk: true };
  if (!MIRROR_PROBE && Date.now() - DEAD_PROBE_AT < 60000)
    return { urls: OVERPASS_MIRRORS.slice(), anyOk: false };    // inside the quiet minute: don't re-probe on every chunk
  if (!MIRROR_PROBE) {
    MIRROR_PROBE = probeMirrors(OVERPASS_MIRRORS).then((r) => {
      if (r.anyOk) return r;
      MIRROR_PROBE = null;   // nothing answered: probe again later, the network may come back
      DEAD_PROBE_AT = Date.now();
      onEvent?.("warn", "No OpenStreetMap server answered a quick check - they may be blocked or busy on this network. Still trying every server and the FloodSense server relay; if it keeps failing, switch network (for example mobile data) and press Try again.");
      return r;
    }).catch(() => { DEAD_PROBE_AT = Date.now(); return { urls: OVERPASS_MIRRORS.slice(), anyOk: false }; });
  }
  return MIRROR_PROBE;
}

/** One lap over every mirror, rotating the starting point so consecutive chunks
 *  spread the load. Throws the last error with .hangs = how many mirrors stayed
 *  silent until the timeout (never throws an AbortError - that propagates). */
async function mirrorRound(query, mirrors, mirrorStart, timeoutMs, { signal, onEvent, deadlineMs = 360000 } = {}) {
  let lastErr = null, hangs = 0;
  const t0 = Date.now();
  for (let m = 0; m < mirrors.length; m++) {
    if (Date.now() - t0 > deadlineMs) break;               // a round of hanging mirrors must not eat the day
    const url = mirrors[(mirrorStart + m) % mirrors.length];
    try {
      const r = await fetchT(url, {
        method: "POST", body: new URLSearchParams({ data: query }), signal, timeoutMs,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (r.status === 429 || r.status === 504) throw new Error(`mirror busy (HTTP ${r.status})`);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const data = await r.json();
      if (!data.elements?.length && data.remark) throw new Error(`server remark: ${data.remark}`);
      return data;
    } catch (e) {
      if (e?.name === "AbortError") throw e;      // only a real cancellation stops the build
      if (e?.name === "TimeoutError") hangs++;
      lastErr = e;
      onEvent?.("retry", `OpenStreetMap server problem (${host(url)}: ${e.message}) - trying the next server…`);
    }
  }
  const err = lastErr || new Error("no server reachable");
  err.hangs = hangs;
  throw err;
}

/** Last-resort leg: relay the query through the FloodSense server (backend
 *  POST /api/overpass). On locked-down networks (college or office Wi-Fi, some
 *  ISPs) the browser cannot reach any foreign OpenStreetMap host, while the
 *  server that delivered the app in the first place IS reachable - asking it to
 *  fetch the same query on its own uplink is what turns "impossible" into "works".
 *  Needs no server in the installed app unless one is configured. */
export async function proxyOverpass(query, { signal, timeoutMs = 300000, onEvent } = {}) {
  if (isNative() && !hasServer()) throw new Error("no FloodSense server configured in the app");
  onEvent?.("retry", "Direct download failed - asking the FloodSense server to fetch the OpenStreetMap data for you…");
  const r = await fetchT(apiUrl("/api/overpass"), {
    method: "POST", body: JSON.stringify({ query }), signal, timeoutMs,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    let why = "";
    try { why = `: ${String((await r.json())?.detail || "").slice(0, 160)}`; } catch { /* non-JSON error body */ }
    throw new Error(`the server relay could not fetch it either (HTTP ${r.status}${why})`);
  }
  const data = await r.json();
  if (!data || !Array.isArray(data.elements)) throw new Error("the server relay returned an unexpected response");
  return data;
}

/** Fetch one Overpass query with the full ladder:
 *  mirrors answered the probe  ->  3 patient mirror rounds, then the server relay;
 *  nothing answered the probe  ->  1 quick mirror round (30 s each - a silent probe
 *  is often just a busy moment), then the server relay, then 1 patient mirror
 *  round, then an honest error.
 *  STICKY RELAY: while the server relay delivered a chunk within the last 5 minutes,
 *  every next chunk tries the relay FIRST - mirror mood is sticky, and re-grinding
 *  five dead mirrors for every chunk of a 30-chunk city would take an hour. A relay
 *  failure simply falls through to the normal ladder, and the win expires after
 *  5 minutes so recovered mirrors are used directly again.
 *  Every leg keeps the chunk cache in mind: nothing that succeeded is ever downloaded twice. */
export async function defaultOverpass(query, { signal, onEvent, mirrorStart = 0 } = {}) {
  if (OV.overpass) {                                   // dev override pins one server: no ladders
    try { return await mirrorRound(query, [OV.overpass], 0, 240000, { signal, onEvent }); }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new BuildError(`Overpass (${host(OV.overpass)}) failed: ${e.message}.`, { stage: "osm" });
    }
  }
  const { urls: mirrors, anyOk } = await orderedMirrors(onEvent);
  const relayPossible = !(isNative() && !hasServer());
  const relayFirst = relayPossible && Date.now() - RELAY_WON_AT < 5 * 60_000;
  const schedule = !relayPossible ? (anyOk
      ? [{ t: "mirrors", ms: 120000 }, { t: "mirrors", ms: 120000 }, { t: "mirrors", ms: 120000 }]
      : [{ t: "mirrors", ms: 30000 }, { t: "mirrors", ms: 120000 }])
    : relayFirst ? [{ t: "proxy" }, { t: "mirrors", ms: 120000 }, { t: "mirrors", ms: 120000 }]
    : anyOk
      ? [{ t: "mirrors", ms: 120000 }, { t: "mirrors", ms: 120000 }, { t: "proxy" }, { t: "mirrors", ms: 120000 }]
      : [{ t: "mirrors", ms: 30000 }, { t: "proxy" }, { t: "mirrors", ms: 120000 }];
  let lastErr = null, relayTried = false, prevMirror = false;
  while (schedule.length) {
    const leg = schedule.shift();
    if (leg.t === "proxy") {
      if (!relayPossible) continue;
      relayTried = true;
      try {
        const data = await proxyOverpass(query, { signal, onEvent });
        RELAY_WON_AT = Date.now();                     // sticky: next chunk starts with the relay
        return data;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        lastErr = e;
      }
    } else {
      if (prevMirror) await sleep(4000, signal);       // small breath between two mirror rounds
      prevMirror = true;
      try { return await mirrorRound(query, mirrors, mirrorStart, leg.ms, { signal, onEvent }); }
      catch (e) {
        if (e?.name === "AbortError") throw e;
        lastErr = e;
        // A round where several mirrors stayed SILENT until the timeout (not fast-failed)
        // means the direct path is hanging, not blocked - the relay is the better next
        // leg, don't grind another identical round first: pull it forward.
        if (relayPossible && (e.hangs || 0) >= 2) {
          const pi = schedule.findIndex((l) => l.t === "proxy");
          if (pi > 0) schedule.unshift(schedule.splice(pi, 1)[0]);
          else if (pi === -1) schedule.unshift({ t: "proxy" });
        }
      }
    }
  }
  throw new BuildError(`OpenStreetMap (Overpass) failed on ${mirrors.length} servers${relayTried ? " and through the FloodSense server relay" : ""}: ${lastErr?.message || "no server reachable"}. Some networks (college or office Wi-Fi, some ISPs) block these servers - switch network (for example mobile data) and press Try again. Finished parts are kept, nothing is downloaded twice.`, { stage: "osm" });
}

function chunkBboxes(s, w, n, e, chunkKm = CHUNK_KM) {
  const mid = (s + n) / 2;
  const latStep = chunkKm / 111.0;
  const lonStep = chunkKm / (111.32 * Math.cos(mid * Math.PI / 180));
  const ny = Math.max(1, Math.ceil((n - s) / latStep)), nx = Math.max(1, Math.ceil((e - w) / lonStep));
  const out = [];
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    out.push([s + (i * (n - s)) / ny, w + (j * (e - w)) / nx, s + ((i + 1) * (n - s)) / ny, w + ((j + 1) * (e - w)) / nx]);
  }
  return out;
}

async function fetchOSMChunked(bbox, { cache, fetcher, signal, onProgress, onEvent }) {
  const chunks = chunkBboxes(...bbox);
  const elements = [], seen = new Set();
  const localIds = new WeakMap();                 // elements without an id (rare): identify by object
  let nextLocal = 0;
  const keyOf = (el) => {
    if (el.id != null) return `${el.type}:${el.id}`;
    if (!localIds.has(el)) localIds.set(el, nextLocal++);
    return `${el.type}:local${localIds.get(el)}`;
  };
  let osmBytes = 0, cached = 0;
  for (let k = 0; k < chunks.length; k++) {
    checkSignal(signal);
    const [cs, cw, cn, ce] = chunks[k];
    const key = `${cacheTag()}osm2:${cs.toFixed(5)},${cw.toFixed(5)},${cn.toFixed(5)},${ce.toFixed(5)}`;
    let text = null;
    try {
      const hit = await cache?.get("chunks", key);
      if (hit && typeof hit === "string" && hit.includes("\"elements\"")) text = hit;   // ignore anything that isn't an Overpass response
    } catch { /* cache read failure is not fatal */ }
    if (text == null) {
      const data = await fetcher(overpassQuery(cs, cw, cn, ce), { signal, onEvent, mirrorStart: k % 2 });
      text = JSON.stringify(data);
      try { await cache?.put("chunks", key, text); } catch { /* full cache: keep going without it */ }
    } else cached++;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BuildError("OpenStreetMap returned a damaged response. Press Try again.", { stage: "osm" });
    }
    if (!data || !Array.isArray(data.elements)) {
      throw new BuildError("OpenStreetMap returned an unexpected response (no elements). Press Try again.", { stage: "osm" });
    }
    osmBytes += text.length;
    for (const el of data.elements || []) {
      const key2 = keyOf(el);
      if (!seen.has(key2)) { seen.add(key2); elements.push(el); }
    }
    onProgress((k + 1) / chunks.length,
      `OpenStreetMap ${k + 1}/${chunks.length} chunks${cached ? ` (${cached} cached)` : ""}`);
  }
  return { elements, chunks: chunks.length, osmBytes };
}

// -------------------------------------------------------------- elevation
/** PNG magic - an error page (HTML) or truncated response must never be treated as a tile. */
const isPNG = (b) => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

async function defaultTile(z, x, y, { signal } = {}) {
  const url = (OV.tiles || TERRARIUM_URL).replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const r = await fetchT(url, { signal, timeoutMs: 30000 });
  if (r.status === 404 || r.status === 410) return null;              // tile doesn't exist (open ocean)
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!isPNG(bytes)) throw new Error("the server did not return an elevation tile (proxy or network interference)");
  return bytes;
}

/** Decode a Terrarium PNG into a 256x256 elevation grid (browser path). */
export async function decodeTilePNG(bytes) {
  let bmp = null;
  try {
    const blob = new Blob([bytes], { type: "image/png" });
    bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  } catch (e) {
    const head = Array.from(bytes?.slice?.(0, 16) || []).join(",");
    throw new Error(`elevation tile is not a readable image (${bytes?.length} bytes, starts with ${head}; ${e.message})`);
  }
  const w = bmp.width, h = bmp.height;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  bmp.close();
  return decodeTerrariumRGBA(data, w, h);
}

async function fetchTiles(tiles, { cache, fetcher, decode, signal, onProgress, onEvent, concurrency = 6 }) {
  const grids = new Map();
  let done = 0, missing = 0, cached = 0;
  const failures = [];
  const queue = [...tiles];
  const workerFn = async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const [tx, ty] = t;
      checkSignal(signal);
      const key = `${cacheTag()}t14:${tx}_${ty}`;
      let bytes = null;
      try {
        const hit = await cache?.get("tiles", key);
        if (isPNG(hit)) bytes = hit;                    // ignore anything that isn't a tile (stale/corrupt cache)
      } catch { /* not fatal */ }
      if (bytes) cached++;
      if (bytes == null) {
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const got = await fetcher(14, tx, ty, { signal });
            if (got == null) { missing++; bytes = null; break; }
            bytes = got;
            try { await cache?.put("tiles", key, bytes); } catch { /* cache full */ }
            break;
          } catch (e) {
            if (e?.name === "AbortError") throw e;
            lastErr = e;
            await sleep(1200 * (attempt + 1), signal);
          }
        }
        if (bytes == null && lastErr) { failures.push([tx, ty, lastErr]); bytes = null; }
      }
      if (bytes != null) grids.set(`${tx}/${ty}`, await decode(bytes));
      done++;
      onProgress(0.55 + (0.20 * done) / tiles.length, `Elevation tiles ${done}/${tiles.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, workerFn));
  if (failures.length) {
    throw new BuildError(`${failures.length} elevation tile(s) failed to download (${failures[0][2].message}). ` +
      "Check your connection and press Retry - finished tiles are kept.", { stage: "elevation" });
  }
  return { grids, cached, missing };
}

function tileRangeFor(proj, grid, zoom = 14) {
  const corners = [[grid.xmin, grid.ymin], [grid.xmax, grid.ymin], [grid.xmin, grid.ymax], [grid.xmax, grid.ymax]];
  let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
  const n = 2 ** zoom;
  for (const [x, y] of corners) {
    const [lat, lon] = proj.toLatLon(x, y);
    const px = ((lon + 180) / 360) * n;
    const py = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    tx0 = Math.min(tx0, Math.floor(px)); tx1 = Math.max(tx1, Math.floor(px));
    ty0 = Math.min(ty0, Math.floor(py)); ty1 = Math.max(ty1, Math.floor(py));
  }
  const tiles = [];
  for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) tiles.push([tx, ty]);
  return tiles;
}

// ---------------------------------------------------------------- weather
async function defaultWeather(lat, lon, { signal } = {}) {
  const params = new URLSearchParams({ latitude: String(Math.round(lat * 10000) / 10000), longitude: String(Math.round(lon * 10000) / 10000), ...OPEN_METEO_PARAMS });
  const url = OV.meteo || OPEN_METEO_URL;
  const r = await fetchT(`${url}?${params}`, { signal, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseOpenMeteo(await r.json());
}

async function fetchWeather(lat, lon, { fetcher, signal, onEvent } = {}) {
  const tries = [
    ["Open-Meteo", async () => {                    // fetcher parses (or returns parsed weather)
      const w = await fetcher(lat, lon, { signal });
      return w.hourly && w.hourly.time ? parseOpenMeteo(w) : w;   // accept raw or parsed
    }],
    ["this server's weather proxy", async () => {
      if (isNative() && !hasServer()) throw new Error("no server configured in the app");
      if (typeof location === "undefined") throw new Error("no server");
      const r = await fetchT(`${apiUrl("/api/weather")}?lat=${lat}&lon=${lon}`, { signal, timeoutMs: 20000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }],
  ];
  for (const [src, fn] of tries) {
    try { return await fn(); } catch (e) {
      if (e?.name === "AbortError") throw e;
      onEvent?.("warn", `Weather from ${src} unavailable (${e.message})${src.startsWith("Open") ? " - trying the server proxy…" : " - building the map without it. You can type the rain in your own words."}`);
    }
  }
  return null;
}

/** Fresh weather for the open map (the app's ↻ Refresh button): Open-Meteo first,
 *  the FloodSense server's weather proxy second. Returns null if both fail. */
export function fetchFreshWeather(lat, lon, { signal, onEvent } = {}) {
  return fetchWeather(lat, lon, { fetcher: defaultWeather, signal, onEvent });
}

// ------------------------------------------------------------------ build
/**
 * Build a whole-city offline pack in the browser. spec:
 *   { kind: "city"|"state"|"area", name, state?, lat, lon, radiusKm?, packId?, maxHalfKm? }
 * opts: { onProgress(fraction 0..1, text), onEvent("warn"|"retry", text), signal, cache,
 *         fetchers: { overpass, tile, weather, nominatim, decodeTile }, concurrency }
 */
export async function buildCityPack(spec, opts = {}) {
  const t0 = Date.now();
  setOverrides(opts.overrides);
  const { onProgress = () => {}, onEvent = () => {}, signal, cache = null, concurrency = 6 } = opts;
  const F = {
    overpass: opts.fetchers?.overpass || defaultOverpass,
    tile: opts.fetchers?.tile || defaultTile,
    weather: opts.fetchers?.weather || defaultWeather,
    nominatim: opts.fetchers?.nominatim || defaultNominatim,
    decodeTile: opts.fetchers?.decodeTile || decodeTilePNG,
  };
  checkSignal(signal);
  if (!opts.fetchers?.overpass && !OV.overpass) orderedMirrors(onEvent).catch(() => {});   // probe mirrors while the boundary resolves

  // 1. boundary
  onProgress(0.005, "Finding the city boundary…");
  const b = await resolveBoundary(spec, { fetchNominatim: F.nominatim, signal, onEvent });
  const [south, west, north, east] = b.bbox;
  if (!(north > south && east > west)) throw new BuildError("Could not work out the area to download.", { stage: "boundary", retryable: false });

  // 2. grid
  const proj = new LocalProjection(spec.lat, spec.lon);
  const corners = [[south, west], [south, east], [north, west], [north, east]].map(([la, lo]) => proj.toXY(la, lo));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const widthM = Math.max(...xs) - Math.min(...xs), heightM = Math.max(...ys) - Math.min(...ys);
  const res = Math.max(10, Math.ceil(Math.max(widthM, heightM) / 1000));       // keep the grid ~<= 1000 x 1000 cells
  const grid = Grid.covering(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), res);

  // 3. OSM
  onProgress(0.02, "Downloading OpenStreetMap roads, names, shops…");
  const osm = await fetchOSMChunked(b.bbox, {
    cache, fetcher: F.overpass, signal, onEvent,
    onProgress: (p, text) => onProgress(0.02 + 0.53 * p, text),
  });
  const parsed = parseOSM({ elements: osm.elements }, proj);
  if (!parsed.ways.length) {
    throw new BuildError("OpenStreetMap has no roads inside this area. Pick a nearby city, or try again later.",
      { stage: "osm", retryable: false });
  }

  // 4. elevation
  onProgress(0.55, "Downloading elevation tiles…");
  const tiles = tileRangeFor(proj, grid);
  const { grids, cached, missing } = await fetchTiles(tiles, {
    cache, fetcher: F.tile, decode: F.decodeTile, signal, onProgress, onEvent, concurrency,
  });
  if (missing) onEvent("warn", `${missing} elevation tile(s) don't exist for this area (open water?) - assumed flat there.`);
  const getTile = async (tx, ty) => {
    const g = grids.get(`${tx}/${ty}`);
    if (g) return g;
    const avg = new Float32Array(256 * 256);                     // unknown tile: flat at the local mean
    let s = 0, n = 0;
    for (const g2 of grids.values()) { s += g2[0]; n++; }
    avg.fill(n ? s / n : 0);
    return avg;
  };
  const z = await sampleDEM(proj, grid, 14, getTile);

  // 5. water mask (rivers as lines, lakes as filled polygons)
  const waterMask = grid.rasterizeLines(parsed.rivers, 20);
  if (parsed.lakes.length) {
    const lakes = grid.rasterizeLines(parsed.lakes.map((p) => p.concat([p[0]])));
    waterMask.set(fillHoles(lakes, grid.ny, grid.nx));
  }

  // 6. weather
  onProgress(0.75, "Fetching live weather…");
  const weather = await fetchWeather(spec.lat, spec.lon, { fetcher: F.weather, signal, onEvent });

  // 7. terrain + segments (packlib, with progress mapped into 0.78 .. 0.99)
  const phases = [];
  const pack = buildPack({
    packId: spec.packId, name: spec.name, proj, grid, z, waterMask,
    ways: parsed.ways, pois: parsed.pois, waterGeoms: parsed.waterGeoms,
    weather, synthetic: false, places: parsed.places, shops: parsed.shops,
    kind: spec.kind === "area" ? "area" : "city", doPruneIslands: true,
    notes: "Built on this device from OpenStreetMap (ODbL) roads, AWS Terrain Tiles elevation and Open-Meteo weather.",
    onPhase: (p) => {
      phases.push(p);
      const t = p.replace(/^terrain: /, "");
      const frac = p.startsWith("terrain:") ? 0.78 + (0.14 * Math.min(1, phases.length / 8))
        : p.startsWith("segmenting") ? 0.92 + 0.06 * Math.min(1, (phases.length - 8) / 2)
        : 0.985;
      onProgress(Math.min(0.99, frac), `Flood terrain: ${t}…`);
    },
  });
  if (!pack.segments.length) throw new BuildError("No usable road segments in this area.", { stage: "build", retryable: false });

  // 8. clip to the admin boundary, re-prune, verify
  onProgress(0.99, "Trimming to the city boundary…");
  const clipped = clipPackToPolygon(pack, b.polygon);
  if (!clipped.segments.length) throw new BuildError("The city boundary contains no roads - pick the city again.", { stage: "build", retryable: false });
  clipped.center = [(clipped.bbox[0] + clipped.bbox[2]) / 2, (clipped.bbox[1] + clipped.bbox[3]) / 2];   // where the map actually opens
  const warnings = verifyPack(clipped);
  if (clipped.segments.length < 300) warnings.push(`Only ${clipped.segments.length} road segments - this place is barely mapped in OpenStreetMap.`);

  onProgress(1, `Map ready: ${clipped.segments.length.toLocaleString()} roads`);
  return {
    pack: clipped, warnings,
    stats: {
      chunks: osm.chunks, osmBytes: osm.osmBytes, tiles: tiles.length, tilesCached: cached,
      elements: osm.elements.length, segments: clipped.segments.length, nodes: clipped.nodes.length,
      boundary: b.source, gridRes: res, elapsedMs: Date.now() - t0,
    },
  };
}
