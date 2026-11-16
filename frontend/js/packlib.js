// FloodSense client-side map builder - the pure algorithms (no fetch, no DOM, no IndexedDB).
// This is a faithful JavaScript port of the Python backend (backend/geo.py, terrain.py,
// pack_core.py, the parsing half of pack_builder.py, weather.py and packs.py verify),
// so a pack built in the browser has EXACTLY the same format as one built by
// `python packs.py build`: version 2, tiles, 12 static features, the same physics.
//
// Used from a Web Worker (js/cityworker.js) or, as a fallback, the main thread.
// Everything here also runs in Node, which is where tests/ keeps it honest.

export const MAX_SEG_M = 40.0;
export const PACK_VERSION = 2;
export const TILE_M = 1000.0;               // 1 km flood-view tiles

export const STATIC_FEATURES = [
  "elev_m", "rel_elev_300m", "depression_m", "hand_m", "log_flow_acc", "slope_deg",
  "impervious", "dist_water_m", "underpass", "bridge", "road_code", "hotspot_100m",
];
export const RAIN_FEATURES = ["rain_1h", "rain_3h", "rain_24h", "rain_72h", "rain_fc_3h", "reservoir_release"];

const ROAD_CODE = {
  motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1,
  secondary: 1, secondary_link: 1, tertiary: 2, tertiary_link: 2, road: 2,
  unclassified: 3, residential: 3, living_street: 3, service: 4,
};
const roadCode = (hw) => ROAD_CODE[hw || ""] ?? 3;

const EARTH_R = 6371000.0;
const D2R = Math.PI / 180;

// ============================================================== projection
export class LocalProjection {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.ky = EARTH_R * D2R;
    this.kx = this.ky * Math.cos(lat0 * D2R);
  }
  toXY(lat, lon) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  toLatLon(x, y) { return [this.lat0 + y / this.ky, this.lon0 + x / this.kx]; }
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** Raster grid in local metres. Row i is at y = ymin + (i + 0.5) * res. */
export class Grid {
  constructor(xmin, ymin, res, ny, nx) { Object.assign(this, { xmin, ymin, res, ny, nx }); }
  static around(halfSizeM, res = 10) { const n = Math.round((2 * halfSizeM) / res); return new Grid(-halfSizeM, -halfSizeM, res, n, n); }
  /** Grid covering a local bbox, snapped outward to the resolution. */
  static covering(x0, x1, y0, y1, res) {
    const xmin = Math.floor(x0 / res) * res, ymin = Math.floor(y0 / res) * res;
    const nx = Math.max(1, Math.ceil((x1 - xmin) / res)), ny = Math.max(1, Math.ceil((y1 - ymin) / res));
    return new Grid(xmin, ymin, res, ny, nx);
  }
  get xmax() { return this.xmin + this.nx * this.res; }
  get ymax() { return this.ymin + this.ny * this.res; }
  index(x, y) {
    return [
      Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.ymin) / this.res))),
      Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.xmin) / this.res))),
    ];
  }
  indexFlat(x, y) { const [i, j] = this.index(x, y); return i * this.nx + j; }
  rasterizeLines(lines, widthM = 0) {
    const { nx, ny, res } = this;
    const mask = new Uint8Array(nx * ny);
    const step = res / 2;
    for (const line of lines) {
      for (let k = 0; k + 1 < line.length; k++) {
        const [x1, y1] = line[k], [x2, y2] = line[k + 1];
        const n = Math.max(2, Math.floor(Math.hypot(x2 - x1, y2 - y1) / step) + 1);
        for (let t = 0; t < n; t++) {
          const x = x1 + ((x2 - x1) * t) / (n - 1), y = y1 + ((y2 - y1) * t) / (n - 1);
          mask[this.indexFlat(x, y)] = 1;
        }
      }
    }
    if (widthM > res) dilate3x3(mask, ny, nx, Math.floor(widthM / res / 2));
    return mask;
  }
}

/** Iterated 3x3 dilation (scipy.ndimage.binary_dilation default element). */
function dilate3x3(mask, ny, nx, times) {
  let cur = mask;
  for (let t = 0; t < times; t++) {
    const next = cur.slice();
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      if (cur[i * nx + j]) continue;
      outer: for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && a < ny && b >= 0 && b < nx && cur[a * nx + b]) { next[i * nx + j] = 1; break outer; }
      }
    }
    cur = next;
  }
  if (cur !== mask) mask.set(cur);
}

/** scipy.binary_fill_holes: keep zero-cells reachable from the border, fill the rest. */
export function fillHoles(mask, ny, nx) {
  const out = mask.slice();
  const seen = new Uint8Array(ny * nx);
  const stack = [];
  for (let j = 0; j < nx; j++) { stack.push(j, (ny - 1) * nx + j); }
  for (let i = 0; i < ny; i++) { stack.push(i * nx, i * nx + nx - 1); }
  while (stack.length) {                       // flood the background from the border
    const c = stack.pop();
    if (seen[c] || mask[c]) continue;
    seen[c] = 1;
    const i = (c / nx) | 0, j = c % nx;
    if (i > 0) stack.push(c - nx);
    if (i < ny - 1) stack.push(c + nx);
    if (j > 0) stack.push(c - 1);
    if (j < nx - 1) stack.push(c + 1);
  }
  for (let c = 0; c < out.length; c++) if (!mask[c] && !seen[c]) out[c] = 1;   // enclosed background = hole
  return out;
}

// ================================================================= terrain
const _NB = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const _ND = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** Min-heap over (Float64 key, Int32 payload) - fast enough for 1M cells. */
class MinHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(k, v) {
    const K = this.keys, V = this.vals;
    let i = K.length; K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= K[i]) break;
      [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p;
    }
  }
  pop() {
    const K = this.keys, V = this.vals, top = V[0];
    const lastK = K.pop(), lastV = V.pop();
    if (K.length) {
      K[0] = lastK; V[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < K.length && K[l] < K[m]) m = l;
        if (r < K.length && K[r] < K[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m;
      }
    }
    return top;
  }
}

/** Priority-flood + epsilon (Barnes et al. 2014). filled - z = ponding depth. */
export function priorityFlood(z, ny, nx, eps = 1e-4) {
  const filled = Float64Array.from(z);
  const closed = new Uint8Array(ny * nx);
  const heap = new MinHeap();
  const push = (i, j) => { const c = i * nx + j; if (!closed[c]) { closed[c] = 1; heap.push(filled[c], c); } };
  for (let i = 0; i < ny; i++) { push(i, 0); push(i, nx - 1); }
  for (let j = 1; j < nx - 1; j++) { push(0, j); push(ny - 1, j); }
  while (heap.size) {
    const c = heap.pop(), e = filled[c], i = (c / nx) | 0, j = c % nx;
    for (let k = 0; k < 8; k++) {
      const a = i + _NB[k][0], b = j + _NB[k][1];
      if (a < 0 || a >= ny || b < 0 || b >= nx) continue;
      const cc = a * nx + b;
      if (closed[cc]) continue;
      closed[cc] = 1;
      filled[cc] = Math.max(z[cc], e + eps);
      heap.push(filled[cc], cc);
    }
  }
  return filled;
}

/** Steepest-descent neighbour (flat index) for every cell, -1 = outlet. */
export function d8Directions(filled, ny, nx, res) {
  const n = ny * nx;
  const down = new Int32Array(n).fill(-1);
  const best = new Float64Array(n);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const c = i * nx + j, zc = filled[c];
    let bk = -1, bd = 0;
    for (let k = 0; k < 8; k++) {
      const a = i + _NB[k][0], b = j + _NB[k][1];
      if (a < 0 || a >= ny || b < 0 || b >= nx) continue;
      const drop = (zc - filled[a * nx + b]) / (_ND[k] * res);
      if (drop > bd) { bd = drop; bk = a * nx + b; }
    }
    down[c] = bk; best[c] = bd;
  }
  return down;
}

/** Order cells by elevation descending (stable), then pour each cell into its downhill. */
function orderDesc(filled) {
  const idx = new Int32Array(filled.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return Array.from(idx).sort((a, b) => filled[b] - filled[a] || a - b);
}

export function flowAccumulation(filled, down) {
  const acc = new Float64Array(filled.length).fill(1);
  for (const idx of orderDesc(filled)) {
    const d = down[idx];
    if (d >= 0) acc[d] += acc[idx];
  }
  return acc;
}

/** Height Above Nearest Drainage: follow D8 downhill to a stream cell. */
export function hand(z, filled, down, stream) {
  const n = filled.length;
  const order = Array.from(orderDesc(filled)).reverse();      // ascending, stable
  const base = new Float64Array(n);
  for (const idx of order) {
    const d = down[idx];
    base[idx] = stream[idx] || d < 0 ? z[idx] : base[d];
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(z[i] - base[i], 0);
  return out;
}

/** Separable box mean with clamped (mode "nearest") edges. */
export function boxMean(src, ny, nx, win) {
  const r = Math.max(1, win >> 1);
  const tmp = new Float64Array(ny * nx), out = new Float64Array(ny * nx);
  for (let i = 0; i < ny; i++) {                 // horizontal pass
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[i * nx + Math.min(nx - 1, Math.max(0, k))];
    for (let j = 0; j < nx; j++) {
      tmp[i * nx + j] = s / (2 * r + 1);
      s += src[i * nx + Math.min(nx - 1, j + r + 1)] - src[i * nx + Math.max(0, j - r)];
    }
  }
  for (let j = 0; j < nx; j++) {                 // vertical pass
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(ny - 1, Math.max(0, k)) * nx + j];
    for (let i = 0; i < ny; i++) {
      out[i * nx + j] = s / (2 * r + 1);
      s += tmp[Math.min(ny - 1, i + r + 1) * nx + j] - tmp[Math.max(0, i - r) * nx + j];
    }
  }
  return out;
}

/** Exact Euclidean distance (in metres) from every cell to the nearest TRUE cell. */
const INF = 1e12;
export function distanceToTrue(mask, ny, nx, res) {
  const f = new Float64Array(ny * nx);
  for (let c = 0; c < f.length; c++) f[c] = mask[c] ? 0 : INF;
  const dt = new Float64Array(ny * nx);
  // Felzenszwalb 1D squared distance transform, rows then columns.
  for (let i = 0; i < ny; i++) dt1d(f, dt, i * nx, nx, 1);
  const tmp = new Float64Array(ny * nx);
  for (let j = 0; j < nx; j++) dt1d(dt, tmp, j, ny, nx);
  const out = new Float64Array(ny * nx);
  for (let c = 0; c < out.length; c++) out[c] = Math.sqrt(tmp[c]) * res;
  return out;
}
function dt1d(src, dst, off, n, stride) {
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((src[off + q * stride] + q * q) - (src[off + v[k] * stride] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((src[off + q * stride] + q * q) - (src[off + v[k] * stride] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    dst[off + q * stride] = d * d + src[off + v[k] * stride];
  }
}

function percentile95(src) {
  const arr = Float64Array.from(src).sort();
  const pos = 0.95 * (arr.length - 1), lo = Math.floor(pos);
  return lo + 1 < arr.length ? arr[lo] + (arr[lo + 1] - arr[lo]) * (pos - lo) : arr[lo];
}

/** All terrain layers the feature extractor needs. waterMask: Uint8Array (rivers + lakes). */
export function analyse(z, ny, nx, res, waterMask, onPhase = () => {}) {
  onPhase("sink fill");
  const filled = priorityFlood(z, ny, nx);
  onPhase("flow directions");
  const down = d8Directions(filled, ny, nx, res);
  onPhase("flow accumulation");
  const acc = flowAccumulation(filled, down);
  const stream = new Uint8Array(ny * nx);
  let anyWater = false;
  for (let c = 0; c < stream.length; c++) { stream[c] = waterMask[c] | 0 || acc[c] >= 400 ? 1 : 0; if (waterMask[c]) anyWater = true; }
  onPhase("drainage height");
  const handG = hand(z, filled, down, stream);
  onPhase("neighbourhood");
  const win = Math.max(3, Math.floor(300 / res) | 1);
  const relElev = new Float64Array(ny * nx);
  const mean300 = boxMean(z, ny, nx, win);
  for (let c = 0; c < relElev.length; c++) relElev[c] = z[c] - mean300[c];
  const depression = new Float64Array(ny * nx);
  for (let c = 0; c < depression.length; c++) depression[c] = Math.max(filled[c] - z[c], 0);
  const logAcc = new Float64Array(ny * nx);
  for (let c = 0; c < logAcc.length; c++) logAcc[c] = Math.log10(acc[c]);
  onPhase("slope and distance to water");
  const slope = new Float64Array(ny * nx);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const c = i * nx + j;
    const gxv = (z[i * nx + Math.min(nx - 1, j + 1)] - z[i * nx + Math.max(0, j - 1)]) / ((Math.min(nx - 1, j + 1) - Math.max(0, j - 1)) * res);
    const gyv = (z[Math.min(ny - 1, i + 1) * nx + j] - z[Math.max(0, i - 1) * nx + j]) / ((Math.min(ny - 1, i + 1) - Math.max(0, i - 1)) * res);
    slope[c] = Math.atan(Math.hypot(gxv, gyv)) / D2R;
  }
  let distWater;
  if (anyWater) {
    distWater = distanceToTrue(waterMask, ny, nx, res);
    for (let c = 0; c < distWater.length; c++) if (distWater[c] > 2000) distWater[c] = 2000;
  } else {
    distWater = new Float64Array(ny * nx).fill(2000);
  }
  onPhase("done");
  return { elev: z, relElev, depression, hand: handG, logAcc, slope, distWater };
}

/** Sealed-surface proxy from road density, rescaled to 0.1-0.9. */
export function imperviousFromRoads(roadMask, ny, nx, res) {
  const density = boxMean(Float64Array.from(roadMask), ny, nx, Math.max(3, Math.floor(150 / res)));
  const ref = percentile95(density) || 1.0;
  const out = new Float64Array(density.length);
  for (let c = 0; c < out.length; c++) out[c] = Math.min(0.9, Math.max(0.1, 0.1 + (0.8 * density[c]) / ref));
  return out;
}

// ============================================================= OSM parsing
export const HIGHWAYS = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|" +
  "tertiary|tertiary_link|unclassified|residential|living_street|road");
const LABEL_AMENITIES = ("restaurant|cafe|fast_food|pharmacy|bank|atm|fuel|police|place_of_worship|marketplace|" +
  "bus_station|post_office|cinema|college|university|library|townhall|clinic|doctors|" +
  "hospital|school|community_centre|fire_station");

/** The exact Overpass query the backend uses (backend/pack_builder.py). */
export function overpassQuery(s, w, n, e) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:200][maxsize:536870912];
(
  way["highway"~"^(${HIGHWAYS})$"](${bb});
  way["highway"="service"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["access"!~"^(private|no)$"](${bb});
  way["waterway"~"^(river|canal|stream|drain|ditch)$"](${bb});
  way["natural"="water"](${bb});
  way["railway"="rail"](${bb});
  way["leisure"~"^(park|garden|playground|pitch)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|forest|meadow|village_green|cemetery)$"](${bb});
  nwr["amenity"~"^(hospital|clinic)$"](${bb});
  nwr["amenity"~"^(shelter|community_centre|school)$"](${bb});
  nwr["emergency"="assembly_point"](${bb});
  nwr["amenity"="fire_station"](${bb});
  node["place"~"^(city|town|suburb|quarter|neighbourhood|village|hamlet|locality)$"](${bb});
  nwr["shop"]["name"](${bb});
  nwr["amenity"~"^(${LABEL_AMENITIES})$"]["name"](${bb});
);
out tags geom;`;
}

function centreOf(el) {
  if ("lat" in el) return [el.lat, el.lon];
  const g = el.geometry;
  if (g && g.length) {
    let la = 0, lo = 0;
    for (const p of g) { la += p.lat; lo += p.lon; }
    return [la / g.length, lo / g.length];
  }
  if (el.bounds) return [(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2];
  return null;
}

/** Port of backend parse_osm: raw Overpass elements -> ways / water / POIs / labels. */
export function parseOSM(osm, proj) {
  const ways = [], waterGeoms = [], waterLines = [], lakePolys = [], pois = [], places = [], shops = [];
  const seen = new Set();
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    const geom = el.geometry;
    if (el.type === "way" && geom && geom.length) {
      const xy = geom.map((g) => proj.toXY(g.lat, g.lon));
      if ("highway" in tags && xy.length > 1) {
        const layer = parseInt(String(tags.layer ?? "0").split(";")[0], 10) || 0;
        const oneway = tags.oneway;
        if (oneway === "-1") xy.reverse();                      // one-way against the drawing direction
        ways.push({
          name: tags["name:en"] || tags.name || tags.ref || "",
          highway: tags.highway,
          xy,
          tunnel: ["yes", "building_passage"].includes(tags.tunnel) || tags.covered === "yes",
          bridge: tags.bridge != null && tags.bridge !== "no",
          layer,
          oneway: ["yes", "1", "-1", "true"].includes(oneway)
            || (["motorway", "motorway_link"].includes(tags.highway) && oneway !== "no"),
        });
        continue;
      }
      if ("waterway" in tags || tags.natural === "water") {
        const kind = tags.natural === "water" ? "lake" : "river";
        waterGeoms.push({ kind, xy });
        (kind === "lake" ? lakePolys : waterLines).push(xy);
        continue;
      }
      if (tags.railway === "rail") { waterGeoms.push({ kind: "rail", xy }); continue; }
      if (tags.leisure || tags.landuse) {
        if (xy.length > 3) waterGeoms.push({ kind: "green", xy });
        continue;
      }
    }
    const name = tags["name:en"] || tags.name;
    if (name && (tags.place || tags.shop || tags.amenity)) {
      const c = centreOf(el);
      if (c) {
        if (tags.place && el.type === "node") {
          places.push({ name, kind: tags.place, x: proj.toXY(c[0], c[1])[0], y: proj.toXY(c[0], c[1])[1] });
        } else {
          const key = `${name}|${c[0].toFixed(4)}|${c[1].toFixed(4)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const [x, y] = proj.toXY(c[0], c[1]);
            shops.push({ name, cat: tags.shop || tags.amenity, x, y });
          }
        }
      }
    }
    let poiType = null;
    if (["hospital", "clinic"].includes(tags.amenity)) poiType = "hospital";
    else if (["shelter", "community_centre", "school"].includes(tags.amenity) || tags.emergency === "assembly_point") poiType = "shelter";
    else if (tags.amenity === "fire_station") poiType = "emergency";
    if (poiType) {
      const c = centreOf(el);
      if (c) {
        const [x, y] = proj.toXY(c[0], c[1]);
        pois.push({ name: tags.name || poiType[0].toUpperCase() + poiType.slice(1), type: poiType, x, y });
      }
    }
  }
  return { ways, waterGeoms, waterLines: waterLines.concat(lakePolys), rivers: waterLines, lakes: lakePolys, pois, places, shops };
}

// ============================================================ elevation
export function tileXY(lat, lon, z) {
  const n = 2 ** z;
  return [(lon + 180.0) / 360.0 * n, (1.0 - Math.asinh(Math.tan(lat * D2R)) / Math.PI) / 2.0 * n];
}

/** Terrarium PNG pixels (RGBA) -> elevation grid (m). */
export function decodeTerrariumRGBA(data, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return out;
}

/**
 * Sample a DEM for the whole grid from Terrarium tiles.
 * getTile(tx, ty) -> Promise<Float32Array 256x256>. Missing tiles are fatal (the caller retries).
 */
export async function sampleDEM(proj, grid, zoom, getTile) {
  const { ny, nx, res } = grid;
  const px = new Float64Array(ny * nx), py = new Float64Array(ny * nx);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const x = grid.xmin + (j + 0.5) * res, y = grid.ymin + (i + 0.5) * res;
    const [lat, lon] = proj.toLatLon(x, y);
    const [tx, ty] = tileXY(lat, lon, zoom);
    px[i * nx + j] = tx * 256 - 0.5;
    py[i * nx + j] = ty * 256 - 0.5;
  }
  const x0 = Math.floor(min(px)) - 1, y0 = Math.floor(min(py)) - 1;
  const x1 = Math.ceil(max(px)) + 2, y1 = Math.ceil(max(py)) + 2;
  const mosaic = new Float64Array((y1 - y0) * (x1 - x0));
  const tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x1 - 1) / 256);
  const ty0 = Math.floor(y0 / 256), ty1 = Math.floor((y1 - 1) / 256);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const tile = await getTile(tx, ty);
    const gx0 = tx * 256, gy0 = ty * 256;
    const sx0 = Math.max(gx0, x0), sy0 = Math.max(gy0, y0);
    const sx1 = Math.min(gx0 + 256, x1), sy1 = Math.min(gy0 + 256, y1);
    for (let sy = sy0; sy < sy1; sy++) {
      const dstOff = (sy - y0) * (x1 - x0) + (sx0 - x0), srcOff = (sy - gy0) * 256 + (sx0 - gx0);
      mosaic.set(tile.subarray(srcOff, srcOff + (sx1 - sx0)), dstOff);
    }
  }
  const z = new Float64Array(ny * nx);                       // bilinear interpolation
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const fx = px[i * nx + j] - x0, fy = py[i * nx + j] - y0;
    const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
    const w0 = x1 - x0, base = iy * w0 + ix;
    const a = mosaic[base], b = mosaic[base + 1], c = mosaic[base + w0], d = mosaic[base + w0 + 1];
    z[i * nx + j] = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
  }
  return z;
}
const min = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const max = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

// ================================================================ weather
/** Port of backend weather.rain_features. */
export function rainFeaturesFromHourly(past, next) {
  const last = (h) => (past.length ? Math.round(past.slice(-h).reduce((a, b) => a + b, 0) * 10) / 10 : 0);
  return {
    rain_1h: last(1), rain_3h: last(3), rain_24h: last(24), rain_72h: last(72),
    rain_fc_3h: Math.round(next.slice(0, 3).reduce((a, b) => a + b, 0) * 10) / 10,
  };
}

export function nowLocalISO() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Port of backend weather.parse_open_meteo. */
export function parseOpenMeteo(js) {
  const times = js.hourly.time, precip0 = js.hourly.precipitation;
  const precip = precip0.map((p) => p || 0);
  const now = (js.current && js.current.time) || `${nowLocalISO().slice(0, 13)}:00`;
  const nowHour = `${now.slice(0, 13)}:00`;
  let idx = times.length - 1;
  for (let i = 0; i < times.length; i++) if (times[i] <= nowHour) idx = i;
  const past = precip.slice(Math.max(0, idx - 71), idx + 1), next = precip.slice(idx + 1, idx + 25);
  const cur = js.current || {};
  return {
    source: "Open-Meteo (live)",
    as_of: now,
    current: {
      temp_c: cur.temperature_2m ?? null, wind_kmh: cur.wind_speed_10m ?? null,
      gust_kmh: cur.wind_gusts_10m ?? null, humidity: cur.relative_humidity_2m ?? null,
      precip_mm: cur.precipitation ?? null,
    },
    rain: rainFeaturesFromHourly(past, next),
    hourly_past: past.map((p) => Math.round(p * 100) / 100),
    hourly_next: next.map((p) => Math.round(p * 100) / 100),
  };
}

export const OPEN_METEO_PARAMS = {
  hourly: "precipitation",
  current: "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m",
  past_days: 3, forecast_days: 2, timezone: "auto",
};

// ============================================================ pack building
const _key = (x, y) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;

function densify(pts, maxLen) {
  const out = [pts[0]];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x1, y1] = pts[k], [x2, y2] = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / maxLen));
    for (let t = 1; t <= n; t++) out.push([x1 + ((x2 - x1) * t) / n, y1 + ((y2 - y1) * t) / n]);
  }
  return out;
}

function splitWay(pts, breaks) {
  const d = densify(pts, MAX_SEG_M);
  const pieces = [];
  let cur = [d[0]], length = 0;
  for (let k = 0; k + 1 < d.length; k++) {
    const p = d[k], q = d[k + 1];
    length += Math.hypot(q[0] - p[0], q[1] - p[1]);
    cur.push(q);
    if (breaks.has(_key(q[0], q[1])) || length >= MAX_SEG_M * 0.75) {
      pieces.push([cur, length]); cur = [q]; length = 0;
    }
  }
  if (cur.length > 1) pieces.push([cur, length]);
  return pieces;
}

/** Drop road fragments not connected to the main network (port of pack_core._prune_islands). */
export function pruneIslands(nodes, segments, onInfo) {
  const parent = new Int32Array(nodes.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const s of segments) {
    const ra = find(s.a), rb = find(s.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const size = new Map();
  for (const s of segments) { const r = find(s.a); size.set(r, (size.get(r) || 0) + 1); }
  let keepMin = Math.max(30, Math.floor(0.01 * segments.length));
  let keep = [...size.entries()].filter(([, c]) => c >= keepMin).map(([r]) => r);
  if (!keep.length) keep = [[...size.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  const kept = segments.filter((s) => keep.includes(find(s.a)));
  const remap = new Map(), newNodes = [];
  for (const s of kept) for (const k of ["a", "b"]) {
    if (!remap.has(s[k])) { remap.set(s[k], newNodes.length); newNodes.push(nodes[s[k]]); }
    s[k] = remap.get(s[k]);
  }
  for (let i = 0; i < kept.length; i++) kept[i].id = i;
  if (segments.length - kept.length) onInfo?.(`removed ${segments.length - kept.length} road pieces in ${size.size - keep.length} disconnected fragments`);
  return [newNodes, kept];
}

/**
 * Port of backend pack_core.build_pack. Everything the phone keeps offline.
 * Returns a plain-JSON-safe pack object (version 2), identical in shape to a server pack.
 */
export function buildPack({ packId, name, proj, grid, z, waterMask, ways, pois = [], hotspots = [],
  waterGeoms = [], weather = null, synthetic = false, notes = "", places = [], shops = [],
  kind = "area", tileM = TILE_M, doPruneIslands = false, onPhase = () => {} }) {
  const t0 = Date.now();
  onPhase("terrain analysis");
  const ny = grid.ny, nx = grid.nx, res = grid.res;
  const terr = analyse(z, ny, nx, res, waterMask, (p) => onPhase(`terrain: ${p}`));
  onPhase("sealed-surface proxy");
  const roadMask = grid.rasterizeLines(ways.map((w) => w.xy));
  const imperv = imperviousFromRoads(roadMask, ny, nx, res);

  // junctions: any point used by more than one way, plus all way ends
  onPhase("junctions");
  const use = new Map();
  for (const w of ways) {
    const keys = new Set(w.xy.map((p) => _key(p[0], p[1])));
    for (const k of keys) use.set(k, (use.get(k) || 0) + 1);
  }
  const breaks = new Set([...use].filter(([, c]) => c > 1).map(([k]) => k));
  for (const w of ways) { breaks.add(_key(w.xy[0][0], w.xy[0][1])); breaks.add(_key(w.xy[w.xy.length - 1][0], w.xy[w.xy.length - 1][1])); }

  const hot = hotspots;
  const xmax = grid.xmax, ymax = grid.ymax;
  const nodeIds = new Map(), nodes = [], segments = [];
  const tnx = Math.max(1, Math.ceil((xmax - grid.xmin) / tileM));
  const tny = Math.max(1, Math.ceil((ymax - grid.ymin) / tileM));
  const tileOf = (x, y) => {
    const tx = Math.min(tnx - 1, Math.max(0, Math.floor((x - grid.xmin) / tileM)));
    const ty = Math.min(tny - 1, Math.max(0, Math.floor((y - grid.ymin) / tileM)));
    return ty * tnx + tx;
  };
  const node = (p) => {
    const k = _key(p[0], p[1]);
    let id = nodeIds.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodeIds.set(k, id);
      const [lat, lon] = proj.toLatLon(p[0], p[1]);
      nodes.push([round6(lat), round6(lon)]);
    }
    return id;
  };
  const sample = (arr, cells, fn) => {
    let out = fn === "min" ? Infinity : fn === "max" ? -Infinity : 0;
    for (const c of cells) {
      const v = arr[c];
      if (fn === "min") out = Math.min(out, v);
      else if (fn === "max") out = Math.max(out, v);
      else out += v;
    }
    return fn === "mean" ? out / cells.length : out;
  };

  onPhase(`segmenting ${ways.length} roads`);
  for (const w of ways) {
    const rc = roadCode(w.highway);
    const under = w.tunnel || (w.layer || 0) < 0 ? 1 : 0;
    const bridge = w.bridge ? 1 : 0;
    for (const [pts, length] of splitWay(w.xy, breaks)) {
      if (length < 1.0) continue;
      const [mx, my] = pts[pts.length >> 1];
      if (mx < grid.xmin || mx > xmax || my < grid.ymin || my > ymax) continue;
      const dense = densify(pts, res);
      const cells = dense.map((p) => grid.indexFlat(p[0], p[1]));
      let hs = 0;
      if (hot.length) {
        outer: for (const h of hot) for (const p of dense) {
          if (Math.hypot(h[0] - p[0], h[1] - p[1]) <= 100) { hs = 1; break outer; }
        }
      }
      const f = [
        sample(terr.elev, cells, "min"), sample(terr.relElev, cells, "min"), sample(terr.depression, cells, "max"),
        sample(terr.hand, cells, "min"), sample(terr.logAcc, cells, "max"), sample(terr.slope, cells, "mean"),
        sample(imperv, cells, "mean"), sample(terr.distWater, cells, "min"),
        under, bridge, rc, hs,
      ].map((v) => Math.round(v * 1000) / 1000);
      const geom = pts.map((p) => { const [la, lo] = proj.toLatLon(p[0], p[1]); return [round6(la), round6(lo)]; });
      segments.push({
        id: segments.length, a: node(pts[0]), b: node(pts[pts.length - 1]),
        len: Math.round(length * 10) / 10, name: w.name || "", hw: w.highway || "road", rc,
        oneway: !!w.oneway, t: tileOf(mx, my), geom, f,
      });
    }
  }

  let outNodes = nodes, outSegs = segments;
  if (doPruneIslands) {
    onPhase("network clean-up");
    [outNodes, outSegs] = pruneIslands(nodes, segments, onInfo0);
  }

  const ll = (p) => { const [la, lo] = proj.toLatLon(p[0], p[1]); return [round6(la), round6(lo)]; };
  const tileBounds = [];
  for (let ty = 0; ty < tny; ty++) for (let tx = 0; tx < tnx; tx++) {
    const x0 = grid.xmin + tx * tileM, y0 = grid.ymin + ty * tileM;
    const a = ll([x0, y0]), b = ll([Math.min(x0 + tileM, xmax), Math.min(y0 + tileM, ymax)]);
    tileBounds.push([a[0], a[1], b[0], b[1]]);
  }
  const inside = (p) => p.x >= grid.xmin && p.x <= xmax && p.y >= grid.ymin && p.y <= ymax;
  const [sLat, wLon] = proj.toLatLon(grid.xmin, grid.ymin);
  const [nLat, eLon] = proj.toLatLon(xmax, ymax);
  const now = nowLocalISO();
  onPhase(`pack ready: ${outSegs.length} segments, ${outNodes.length} nodes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    version: PACK_VERSION, id: packId, name, kind, synthetic, notes,
    created_at: now, data_as_of: (weather || {}).as_of || now,
    center: [proj.lat0, proj.lon0],
    bbox: [round6(sLat), round6(wLon), round6(nLat), round6(eLon)],
    static_features: STATIC_FEATURES, rain_features: RAIN_FEATURES,
    nodes: outNodes, segments: outSegs,
    pois: pois.map((p) => { const [lat, lon] = ll([p.x, p.y]); return { name: p.name, type: p.type, lat, lon }; }),
    water: waterGeoms.map((g) => ({ kind: g.kind, coords: g.xy.map(ll) })),
    hotspots: hotspots.map(ll),
    weather,
    tiles: { size_m: tileM, nx: tnx, ny: tny, bounds: tileBounds },
    places: places.filter(inside).map((p) => { const [lat, lon] = ll([p.x, p.y]); return { name: p.name, kind: p.kind, lat, lon }; }),
    shops: shops.filter(inside).map((p) => { const [lat, lon] = ll([p.x, p.y]); return { name: p.name, cat: p.cat, lat, lon }; }),
  };
}
const onInfo0 = () => {};
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ==================================================== boundary (geojson)
/** Even-odd point-in-polygon. rings: array of [lon, lat] arrays. */
export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** polygon: GeoJSON Polygon or MultiPolygon (array of rings / array of polygons). */
export function pointInPolygon(lon, lat, polygon) {
  if (!polygon) return true;
  const polys = polygon.type === "MultiPolygon" ? polygon.coordinates : [polygon.coordinates];
  for (const rings of polys) {
    let crossings = 0;
    for (const ring of rings) if (inRing(lon, lat, ring)) crossings++;
    if (crossings % 2 === 1) return true;
  }
  return false;
}

/** Filter a built pack to the city's administrative boundary, then re-prune islands. */
export function clipPackToPolygon(pack, polygon) {
  if (!polygon) return pack;
  const segIn = (s) => { const p = s.geom[s.geom.length >> 1]; return pointInPolygon(p[1], p[0], polygon); };
  const kept = pack.segments.filter(segIn);
  if (kept.length === pack.segments.length) return pack;      // nothing outside the boundary
  const remap = new Map(), nodes = [];
  for (const s of kept) for (const k of ["a", "b"]) {
    if (!remap.has(s[k])) { remap.set(s[k], nodes.length); nodes.push(pack.nodes[s[k]]); }
    s[k] = remap.get(s[k]);
  }
  for (let i = 0; i < kept.length; i++) kept[i].id = i;
  const poiIn = (p) => pointInPolygon(p.lon, p.lat, polygon);
  const out = {
    ...pack, nodes, segments: kept,
    pois: pack.pois.filter(poiIn), places: (pack.places || []).filter(poiIn), shops: (pack.shops || []).filter(poiIn),
    water: pack.water.filter((w) => pointInPolygon(w.coords[0][1], w.coords[0][0], polygon)),
    hotspots: (pack.hotspots || []).filter((p) => pointInPolygon(p[1], p[0], polygon)),
  };
  const [nodes2, segs2] = pruneIslands(out.nodes, out.segments, null);
  out.nodes = nodes2; out.segments = segs2;
  return out;
}

// ============================================================== verify
/** Port of packs.py verify(): returns a list of problems (empty = good). */
export function verifyPack(pack) {
  const probs = [];
  const segs = pack.segments || [], nodes = pack.nodes || [];
  if ((pack.version || 1) < 2) probs.push("old pack format (v1): rebuild for tiles, names and shops");
  if (!segs.length) return probs.concat(["no road segments"]);
  const nf = STATIC_FEATURES.length;
  const bad = segs.filter((s) => s.f.length !== nf || s.f.some((v) => !Number.isFinite(v)));
  if (bad.length) probs.push(`${bad.length} segments with missing/invalid features`);
  if (segs.some((s) => !(s.a >= 0 && s.a < nodes.length && s.b >= 0 && s.b < nodes.length)))
    return probs.concat(["segments point at missing junctions (pack is corrupt: rebuild it)"]);
  const tl = pack.tiles;
  if (tl && (tl.bounds.length !== tl.nx * tl.ny || segs.some((s) => !(s.t >= 0 && s.t < tl.nx * tl.ny))))
    probs.push("tile index out of range");
  const parent = new Int32Array(nodes.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const s of segs) parent[find(s.a)] = find(s.b);
  const comp = new Map();
  for (const s of segs) { const r = find(s.a); comp.set(r, (comp.get(r) || 0) + 1); }
  const share = Math.max(...comp.values()) / segs.length;
  if (share < 0.8) probs.push(`road network is fragmented: biggest connected part has only ${(share * 100).toFixed(0)}% of roads`);
  if (!(pack.pois || []).some((p) => p.type === "hospital")) probs.push("no hospitals found (the 'Nearest hospital' button won't work)");
  if (!pack.weather) probs.push("no weather snapshot (open the app online once, or Refresh weather)");
  const unnamed = segs.filter((s) => !s.name).length / segs.length;
  if (unnamed > 0.6) probs.push(`${(unnamed * 100).toFixed(0)}% of roads have no name: directions will say 'unnamed road'`);
  return probs;
}
