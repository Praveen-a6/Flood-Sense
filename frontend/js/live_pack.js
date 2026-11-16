// Build a local FloodSense city-area pack directly from public map and elevation data.
const EARTH_M = 6371000;
const DEM_ZOOM = 14;
const GRID_RES = 20;
const RADIUS_KM = 5;
const CHUNK_KM = 3;
const HIGHWAYS = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road";
const AMENITIES = "restaurant|cafe|fast_food|pharmacy|bank|atm|fuel|police|place_of_worship|marketplace|bus_station|post_office|cinema|college|university|library|townhall|clinic|doctors|hospital|school|community_centre|fire_station";
const STATIC_FEATURES = ["elev_m", "rel_elev_300m", "depression_m", "hand_m", "log_flow_acc", "slope_deg",
  "impervious", "dist_water_m", "underpass", "bridge", "road_code", "hotspot_100m"];
const RAIN_FEATURES = ["rain_1h", "rain_3h", "rain_24h", "rain_72h", "rain_fc_3h", "reservoir_release"];
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

function progress(onProgress, text) { onProgress?.(text); }

async function fetchResponse(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} from map data provider`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function projection(lat0, lon0) {
  const ky = EARTH_M * Math.PI / 180;
  const kx = ky * Math.cos(lat0 * Math.PI / 180);
  return {
    xy(lat, lon) { return [(lon - lon0) * kx, (lat - lat0) * ky]; },
    ll(x, y) { return [lat0 + y / ky, lon0 + x / kx]; },
  };
}

function bboxFor(lat, lon, radiusM, proj) {
  const a = proj.ll(-radiusM, -radiusM), b = proj.ll(radiusM, radiusM);
  return [a[0], a[1], b[0], b[1]];
}

function queryFor(s, w, n, e) {
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90][maxsize:268435456];(
    way["highway"~"^(${HIGHWAYS})$"](${box});
    way["highway"="service"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["access"!~"^(private|no)$"](${box});
    way["waterway"~"^(river|canal|stream|drain|ditch)$"](${box});
    way["natural"="water"](${box});
    way["railway"="rail"](${box});
    way["leisure"~"^(park|garden|playground|pitch)$"](${box});
    way["landuse"~"^(grass|recreation_ground|forest|meadow|village_green|cemetery)$"](${box});
    nwr["amenity"~"^(hospital|clinic|shelter|community_centre|school|fire_station)$"](${box});
    nwr["emergency"="assembly_point"](${box});
    node["place"~"^(city|town|suburb|quarter|neighbourhood|village|hamlet|locality)$"](${box});
    nwr["shop"]["name"](${box});
    nwr["amenity"~"^(${AMENITIES})$"]["name"](${box});
  );out tags geom;`;
}

async function fetchOsmChunk(s, w, n, e) {
  const query = queryFor(s, w, n, e);
  let lastError;
  for (const endpoint of OVERPASS) {
    try {
      const response = await fetchResponse(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
      }, 120000);
      const data = await response.json();
      if (!Array.isArray(data.elements)) throw new Error(data.remark || "OpenStreetMap returned no map elements.");
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`OpenStreetMap download failed: ${lastError?.message || "no Overpass server responded"}`);
}

async function fetchOsm(bbox, onProgress) {
  const [s, w, n, e] = bbox;
  const latStep = CHUNK_KM / 111;
  const lonStep = CHUNK_KM / (111.32 * Math.cos((s + n) / 2 * Math.PI / 180));
  const ny = Math.max(1, Math.ceil((n - s) / latStep));
  const nx = Math.max(1, Math.ceil((e - w) / lonStep));
  const elements = new Map();
  let done = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      done++;
      progress(onProgress, `Downloading OpenStreetMap data (${done}/${nx * ny})…`);
      const cs = s + iy * (n - s) / ny, cn = s + (iy + 1) * (n - s) / ny;
      const cw = w + ix * (e - w) / nx, ce = w + (ix + 1) * (e - w) / nx;
      const data = await fetchOsmChunk(cs, cw, cn, ce);
      for (const item of data.elements || []) elements.set(`${item.type}/${item.id}`, item);
    }
  }
  return [...elements.values()];
}

function elementCenter(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return [el.lat, el.lon];
  if (el.geometry?.length) {
    const sum = el.geometry.reduce((a, p) => [a[0] + p.lat, a[1] + p.lon], [0, 0]);
    return [sum[0] / el.geometry.length, sum[1] / el.geometry.length];
  }
  if (el.bounds) return [(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2];
  return null;
}

function parseOsm(elements, proj) {
  const ways = [], waterGeoms = [], waterLines = [], lakes = [], pois = [], places = [], shops = [];
  const seenShops = new Set();
  for (const el of elements) {
    const tags = el.tags || {}, geom = el.geometry;
    if (el.type === "way" && geom?.length) {
      const xy = geom.map((p) => proj.xy(p.lat, p.lon));
      if (tags.highway && xy.length > 1) {
        let layer = Number.parseInt(String(tags.layer || "0").split(";")[0], 10);
        if (!Number.isFinite(layer)) layer = 0;
        if (tags.oneway === "-1") xy.reverse();
        ways.push({
          name: tags["name:en"] || tags.name || tags.ref || "",
          highway: tags.highway, xy,
          tunnel: ["yes", "building_passage"].includes(tags.tunnel) || tags.covered === "yes",
          bridge: tags.bridge != null && tags.bridge !== "no", layer,
          oneway: ["yes", "1", "-1", "true"].includes(tags.oneway) ||
            (["motorway", "motorway_link"].includes(tags.highway) && tags.oneway !== "no"),
        });
        continue;
      }
      if (tags.waterway || tags.natural === "water") {
        const kind = tags.natural === "water" ? "lake" : "river";
        waterGeoms.push({ kind, xy });
        (kind === "lake" ? lakes : waterLines).push(xy);
        continue;
      }
      if (tags.railway === "rail") { waterGeoms.push({ kind: "rail", xy }); continue; }
      if (tags.leisure || tags.landuse) {
        if (xy.length > 3) waterGeoms.push({ kind: "green", xy });
        continue;
      }
    }
    const center = elementCenter(el);
    const name = tags["name:en"] || tags.name;
    if (name && center && (tags.place || tags.shop || tags.amenity)) {
      const [x, y] = proj.xy(...center);
      if (tags.place && el.type === "node") places.push({ name, kind: tags.place, x, y, lat: center[0], lon: center[1] });
      else {
        const key = `${name}/${center[0].toFixed(4)}/${center[1].toFixed(4)}`;
        if (!seenShops.has(key)) {
          seenShops.add(key);
          shops.push({ name, cat: tags.shop || tags.amenity, lat: center[0], lon: center[1] });
        }
      }
    }
    let type = null;
    if (["hospital", "clinic"].includes(tags.amenity)) type = "hospital";
    else if (["shelter", "community_centre", "school"].includes(tags.amenity) || tags.emergency === "assembly_point") type = "shelter";
    else if (tags.amenity === "fire_station") type = "emergency";
    if (type && center) {
      const [x, y] = proj.xy(...center);
      pois.push({ name: tags.name || type[0].toUpperCase() + type.slice(1), type, x, y });
    }
  }
  return { ways, waterGeoms, waterLines, lakes, pois, places, shops };
}

function tileXY(lat, lon) {
  const n = 2 ** DEM_ZOOM;
  return [(lon + 180) / 360 * n * 256,
    (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n * 256];
}

async function fetchElevationTiles(lat0, lon0, xmin, ymin, nx, ny, res, onProgress) {
  const xs = new Float64Array(nx), ys = new Float64Array(ny);
  for (let x = 0; x < nx; x++) xs[x] = xmin + (x + 0.5) * res;
  for (let y = 0; y < ny; y++) ys[y] = ymin + (y + 0.5) * res;
  const proj = projection(lat0, lon0);
  const first = tileXY(...proj.ll(xs[0], ys[0]));
  const last = tileXY(...proj.ll(xs[nx - 1], ys[ny - 1]));
  const x0 = Math.floor(Math.min(first[0], last[0]) / 256) - 1;
  const y0 = Math.floor(Math.min(first[1], last[1]) / 256) - 1;
  const x1 = Math.floor(Math.max(first[0], last[0]) / 256) + 1;
  const y1 = Math.floor(Math.max(first[1], last[1]) / 256) + 1;
  const tiles = new Map();
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  let count = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      count++;
      progress(onProgress, `Downloading elevation data (${count}/${total})…`);
      const response = await fetchResponse(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${tx}/${ty}.png`, {}, 45000);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(256, 256);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgb = context.getImageData(0, 0, 256, 256).data;
      const heights = new Float32Array(256 * 256);
      for (let i = 0, p = 0; i < heights.length; i++, p += 4)
        heights[i] = rgb[p] * 256 + rgb[p + 1] + rgb[p + 2] / 256 - 32768;
      tiles.set(`${tx}/${ty}`, heights);
    }
  }
  const getPixel = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) throw new Error("Elevation tiles did not cover the requested map area.");
    return tile[(py - ty * 256) * 256 + (px - tx * 256)];
  };
  const elev = new Float32Array(nx * ny);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const [px0, py0] = tileXY(...proj.ll(xs[j], ys[i]));
      const px = px0 - 0.5, py = py0 - 0.5, ix = Math.floor(px), iy = Math.floor(py);
      const dx = px - ix, dy = py - iy;
      const a = getPixel(ix, iy) * (1 - dx) + getPixel(ix + 1, iy) * dx;
      const b = getPixel(ix, iy + 1) * (1 - dx) + getPixel(ix + 1, iy + 1) * dx;
      elev[i * nx + j] = a * (1 - dy) + b * dy;
    }
  }
  return elev;
}

class MinHeap {
  constructor(capacity, values) { this.data = new Uint32Array(capacity); this.size = 0; this.values = values; }
  push(value) {
    let i = this.size++;
    while (i) {
      const p = (i - 1) >> 1, parent = this.data[p];
      if (this.values[parent] <= this.values[value]) break;
      this.data[i] = parent; i = p;
    }
    this.data[i] = value;
  }
  pop() {
    const result = this.data[0], tail = this.data[--this.size];
    if (this.size) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        if (l >= this.size) break;
        let c = r < this.size && this.values[this.data[r]] < this.values[this.data[l]] ? r : l;
        if (this.values[tail] <= this.values[this.data[c]]) break;
        this.data[i] = this.data[c]; i = c;
      }
      this.data[i] = tail;
    }
    return result;
  }
}

function cellIndex(x, y, xmin, ymin, res, nx, ny) {
  const j = Math.max(0, Math.min(nx - 1, Math.floor((x - xmin) / res)));
  const i = Math.max(0, Math.min(ny - 1, Math.floor((y - ymin) / res)));
  return i * nx + j;
}

function rasterLines(lines, mask, nx, ny, xmin, ymin, res, width = 0) {
  const radius = Math.max(0, Math.floor(width / res / 2));
  for (const line of lines) for (let k = 1; k < line.length; k++) {
    const [x1, y1] = line[k - 1], [x2, y2] = line[k];
    const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (res / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, j = Math.floor((x1 + (x2 - x1) * t - xmin) / res);
      const i = Math.floor((y1 + (y2 - y1) * t - ymin) / res);
      for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && a < ny && b >= 0 && b < nx && di * di + dj * dj <= radius * radius + 1)
          mask[a * nx + b] = 1;
      }
    }
  }
}

function rasterizeLake(poly, mask, nx, ny, xmin, ymin, res) {
  if (poly.length < 4) return;
  let lowX = Infinity, highX = -Infinity, lowY = Infinity, highY = -Infinity;
  for (const [x, y] of poly) {
    lowX = Math.min(lowX, x); highX = Math.max(highX, x);
    lowY = Math.min(lowY, y); highY = Math.max(highY, y);
  }
  const minX = Math.max(0, Math.floor((lowX - xmin) / res));
  const maxX = Math.min(nx - 1, Math.floor((highX - xmin) / res));
  const minY = Math.max(0, Math.floor((lowY - ymin) / res));
  const maxY = Math.min(ny - 1, Math.floor((highY - ymin) / res));
  for (let i = minY; i <= maxY; i++) for (let j = minX; j <= maxX; j++) {
    const x = xmin + (j + 0.5) * res, y = ymin + (i + 0.5) * res;
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [ax, ay] = poly[a], [bx, by] = poly[b];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    if (inside) mask[i * nx + j] = 1;
  }
}

function boxMean(src, nx, ny, radius) {
  const stride = nx + 1, integral = new Float64Array((nx + 1) * (ny + 1));
  for (let i = 0; i < ny; i++) {
    let row = 0;
    for (let j = 0; j < nx; j++) {
      row += src[i * nx + j];
      integral[(i + 1) * stride + j + 1] = integral[i * stride + j + 1] + row;
    }
  }
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const y0 = Math.max(0, i - radius), y1 = Math.min(ny, i + radius + 1);
    const x0 = Math.max(0, j - radius), x1 = Math.min(nx, j + radius + 1);
    const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
    out[i * nx + j] = sum / ((y1 - y0) * (x1 - x0));
  }
  return out;
}

function terrainFeatures(elev, water, roadMask, nx, ny, res, onProgress) {
  const n = nx * ny, filled = new Float32Array(elev), seen = new Uint8Array(n);
  const heap = new MinHeap(n, filled);
  for (let i = 0; i < ny; i++) for (const j of [0, nx - 1]) {
    const p = i * nx + j;
    if (!seen[p]) { seen[p] = 1; heap.push(p); }
  }
  for (let j = 1; j < nx - 1; j++) for (const i of [0, ny - 1]) {
    const p = i * nx + j;
    if (!seen[p]) { seen[p] = 1; heap.push(p); }
  }
  const d8 = [[-1,-1,Math.SQRT2],[-1,0,1],[-1,1,Math.SQRT2],[0,-1,1],[0,1,1],[1,-1,Math.SQRT2],[1,0,1],[1,1,Math.SQRT2]];
  let visited = 0;
  while (heap.size) {
    const p = heap.pop(), i = Math.floor(p / nx), j = p % nx, h = filled[p];
    for (const [di, dj] of d8) {
      const a = i + di, b = j + dj;
      if (a < 0 || a >= ny || b < 0 || b >= nx) continue;
      const q = a * nx + b;
      if (seen[q]) continue;
      seen[q] = 1;
      filled[q] = Math.max(elev[q], h + 1e-4);
      heap.push(q);
    }
    if (++visited % 100000 === 0) progress(onProgress, `Analysing terrain (${Math.round(visited * 100 / n)}%)…`);
  }
  progress(onProgress, "Calculating drainage and flood features…");
  const down = new Int32Array(n); down.fill(-1);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const p = i * nx + j; let best = 0, dest = -1;
    for (const [di, dj, dist] of d8) {
      const a = i + di, b = j + dj;
      if (a < 0 || a >= ny || b < 0 || b >= nx) continue;
      const q = a * nx + b, drop = (filled[p] - filled[q]) / (dist * res);
      if (drop > best) { best = drop; dest = q; }
    }
    down[p] = dest;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => filled[a] - filled[b]);
  const acc = new Float32Array(n); acc.fill(1);
  for (let k = n - 1; k >= 0; k--) {
    const p = order[k], q = down[p];
    if (q >= 0) acc[q] += acc[p];
  }
  const hand = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = order[k], q = down[p];
    hand[p] = water[p] || q < 0 ? elev[p] : Math.max(0, elev[p] - hand[q]);
  }
  const rel = new Float32Array(n), slope = new Float32Array(n), depression = new Float32Array(n);
  const win = Math.max(3, Math.floor(300 / res) | 1);
  const mean = boxMean(elev, nx, ny, (win - 1) >> 1);
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const p = i * nx + j;
    const gx = (elev[i * nx + Math.min(nx - 1, j + 1)] - elev[i * nx + Math.max(0, j - 1)]) / (2 * res);
    const gy = (elev[Math.min(ny - 1, i + 1) * nx + j] - elev[Math.max(0, i - 1) * nx + j]) / (2 * res);
    rel[p] = elev[p] - mean[p];
    slope[p] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    depression[p] = Math.max(0, filled[p] - elev[p]);
  }
  const impervious = boxMean(roadMask, nx, ny, Math.max(1, Math.floor(150 / res) >> 1));
  let ref = 0;
  const sortedDensity = impervious.slice();
  sortedDensity.sort();
  ref = sortedDensity[Math.floor(sortedDensity.length * 0.95)] || 1;
  for (let i = 0; i < n; i++) impervious[i] = Math.max(0.1, Math.min(0.9, 0.1 + 0.8 * impervious[i] / ref));
  const distWater = new Float32Array(n); distWater.fill(2000);
  for (let p = 0; p < n; p++) if (water[p]) distWater[p] = 0;
  const diag = res * Math.SQRT2;
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const p = i * nx + j;
    if (i) distWater[p] = Math.min(distWater[p], distWater[p - nx] + res);
    if (j) distWater[p] = Math.min(distWater[p], distWater[p - 1] + res);
    if (i && j) distWater[p] = Math.min(distWater[p], distWater[p - nx - 1] + diag);
    if (i && j + 1 < nx) distWater[p] = Math.min(distWater[p], distWater[p - nx + 1] + diag);
  }
  for (let i = ny - 1; i >= 0; i--) for (let j = nx - 1; j >= 0; j--) {
    const p = i * nx + j;
    if (i + 1 < ny) distWater[p] = Math.min(distWater[p], distWater[p + nx] + res);
    if (j + 1 < nx) distWater[p] = Math.min(distWater[p], distWater[p + 1] + res);
    if (i + 1 < ny && j + 1 < nx) distWater[p] = Math.min(distWater[p], distWater[p + nx + 1] + diag);
    if (i + 1 < ny && j) distWater[p] = Math.min(distWater[p], distWater[p + nx - 1] + diag);
  }
  for (let p = 0; p < n; p++) {
    distWater[p] = Math.min(distWater[p], 2000);
    acc[p] = Math.log10(acc[p]);
  }
  return { elev, rel, depression, hand, logAcc: acc, slope, impervious, distWater };
}

function roadCode(highway) {
  if (["motorway", "motorway_link", "trunk", "trunk_link"].includes(highway)) return 0;
  if (["primary", "primary_link", "secondary", "secondary_link"].includes(highway)) return 1;
  if (["tertiary", "tertiary_link", "road"].includes(highway)) return 2;
  if (["unclassified", "residential", "living_street"].includes(highway)) return 3;
  if (highway === "service") return 4;
  return 3;
}

function pruneIslands(nodes, segments) {
  const parent = nodes.map((_, i) => i);
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) { const next = parent[x]; parent[x] = root; x = next; }
    return root;
  };
  for (const segment of segments) {
    const a = find(segment.a), b = find(segment.b);
    if (a !== b) parent[a] = b;
  }
  const sizes = new Map();
  for (const segment of segments) {
    const root = find(segment.a);
    sizes.set(root, (sizes.get(root) || 0) + 1);
  }
  let largest = null;
  for (const [root, size] of sizes) if (!largest || size > sizes.get(largest)) largest = root;
  const minimum = Math.max(30, Math.floor(segments.length * 0.01));
  const keptRoots = new Set([...sizes].filter(([, size]) => size >= minimum).map(([root]) => root));
  if (!keptRoots.size && largest != null) keptRoots.add(largest);
  const remap = new Map(), compactNodes = [], compactSegments = [];
  for (const segment of segments) {
    if (!keptRoots.has(find(segment.a))) continue;
    const copy = { ...segment };
    for (const key of ["a", "b"]) {
      if (!remap.has(copy[key])) {
        remap.set(copy[key], compactNodes.length);
        compactNodes.push(nodes[copy[key]]);
      }
      copy[key] = remap.get(copy[key]);
    }
    copy.id = compactSegments.length;
    compactSegments.push(copy);
  }
  return { nodes: compactNodes, segments: compactSegments };
}

function buildPack(parsed, terrain, lat, lon, proj, xmin, ymin, nx, ny, res, radiusKm, onProgress) {
  const ways = parsed.ways, usage = new Map();
  const keyOf = (p) => `${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`;
  for (const way of ways) for (const p of new Set(way.xy.map(keyOf))) usage.set(p, (usage.get(p) || 0) + 1);
  const breaks = new Set([...usage].filter(([, count]) => count > 1).map(([key]) => key));
  const nodes = [], nodeIds = new Map(), segments = [];
  const tnx = Math.ceil(2 * radiusKm), tny = tnx;
  const tileBounds = [];
  for (let ty = 0; ty < tny; ty++) for (let tx = 0; tx < tnx; tx++) {
    const [aLat, aLon] = proj.ll(xmin + tx * 1000, ymin + ty * 1000);
    const [bLat, bLon] = proj.ll(Math.min(xmin + (tx + 1) * 1000, -xmin), Math.min(ymin + (ty + 1) * 1000, -ymin));
    tileBounds.push([aLat, aLon, bLat, bLon]);
  }
  const node = (p) => {
    const k = keyOf(p);
    if (!nodeIds.has(k)) { nodeIds.set(k, nodes.length); nodes.push(proj.ll(p[0], p[1]).map((v) => +v.toFixed(6))); }
    return nodeIds.get(k);
  };
  const sampleSegment = (points) => {
    const vals = [[], [], [], [], [], [], [], []];
    for (let i = 0; i < points.length; i++) {
      const p = cellIndex(points[i][0], points[i][1], xmin, ymin, res, nx, ny);
      vals[0].push(terrain.elev[p]); vals[1].push(terrain.rel[p]); vals[2].push(terrain.depression[p]);
      vals[3].push(terrain.hand[p]); vals[4].push(terrain.logAcc[p]); vals[5].push(terrain.slope[p]);
      vals[6].push(terrain.impervious[p]); vals[7].push(terrain.distWater[p]);
    }
    return [Math.min(...vals[0]), Math.min(...vals[1]), Math.max(...vals[2]), Math.min(...vals[3]),
      Math.max(...vals[4]), vals[5].reduce((a, b) => a + b, 0) / vals[5].length,
      vals[6].reduce((a, b) => a + b, 0) / vals[6].length, Math.min(...vals[7])];
  };
  const densify = (points, maxLen) => {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.ceil(distance / maxLen));
      for (let k = 1; k <= count; k++) out.push([a[0] + (b[0] - a[0]) * k / count, a[1] + (b[1] - a[1]) * k / count]);
    }
    return out;
  };
  progress(onProgress, `Preparing roads from ${ways.length.toLocaleString()} mapped roadways…`);
  for (const way of ways) {
    const points = densify(way.xy, 40);
    let piece = [points[0]], length = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      length += d; piece.push(b);
      if (breaks.has(keyOf(b)) || length >= 30 || i === points.length - 1) {
        if (length >= 1) {
          const middle = piece[Math.floor(piece.length / 2)];
          if (middle[0] >= xmin && middle[0] <= -xmin && middle[1] >= ymin && middle[1] <= -ymin) {
            const rc = roadCode(way.highway), feature = sampleSegment(densify(piece, res));
            const geom = piece.map((p) => proj.ll(p[0], p[1]).map((v) => +v.toFixed(6)));
            const mx = middle[0], my = middle[1];
            const tile = Math.min(tny - 1, Math.max(0, Math.floor((my - ymin) / 1000))) * tnx +
              Math.min(tnx - 1, Math.max(0, Math.floor((mx - xmin) / 1000)));
            segments.push({
              id: segments.length, a: node(piece[0]), b: node(piece[piece.length - 1]), len: +length.toFixed(1),
              name: way.name, hw: way.highway, rc, oneway: way.oneway, t: tile, geom,
              f: [...feature, way.tunnel || way.layer < 0 ? 1 : 0, way.bridge ? 1 : 0, rc, 0].map((v) => +v.toFixed(3)),
            });
          }
        }
        piece = [b]; length = 0;
      }
    }
  }
  const pruned = pruneIslands(nodes, segments);
  const keptNodes = pruned.nodes, keptSegments = pruned.segments;
  if (!keptSegments.length) throw new Error("No usable connected road network was found near your location.");
  const [s, w] = proj.ll(xmin, ymin), [n, e] = proj.ll(-xmin, -ymin);
  const closestPlace = parsed.places.sort((a, b) =>
    Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
  const placeName = closestPlace?.name || "Nearby area";
  const id = `gps-city-${Math.round(lat * 10000)}-${Math.round(lon * 10000)}`;
  return {
    version: 2, id, name: `${placeName} (nearby map)`, kind: "city", synthetic: false,
    notes: "Roads and places: © OpenStreetMap contributors. Elevation: AWS Terrain Tiles. Terrain resolution: 20 m.",
    created_at: new Date().toISOString(), data_as_of: new Date().toISOString(), center: [lat, lon],
    bbox: [s, w, n, e], static_features: STATIC_FEATURES, rain_features: RAIN_FEATURES,
    nodes: keptNodes, segments: keptSegments,
    pois: parsed.pois.map((p) => {
      const [poiLat, poiLon] = proj.ll(p.x, p.y);
      return { name: p.name, type: p.type, lat: +poiLat.toFixed(6), lon: +poiLon.toFixed(6) };
    }),
    water: parsed.waterGeoms.map((g) => ({ kind: g.kind, coords: g.xy.map((p) => proj.ll(p[0], p[1])) })),
    hotspots: [], weather: null,
    tiles: { size_m: 1000, nx: tnx, ny: tny, bounds: tileBounds },
    places: parsed.places.map((p) => ({ name: p.name, kind: p.kind, lat: p.lat, lon: p.lon })),
    shops: parsed.shops,
  };
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: "precipitation",
    current: "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m",
    past_days: "3", forecast_days: "2", timezone: "auto",
  });
  const data = await (await fetchResponse(`https://api.open-meteo.com/v1/forecast?${params}`, {}, 20000)).json();
  const times = data.hourly?.time || [], values = (data.hourly?.precipitation || []).map((v) => v || 0);
  const now = data.current?.time || new Date().toISOString().slice(0, 13) + ":00";
  const idx = Math.max(0, times.findLastIndex((t) => t <= now.slice(0, 13) + ":00"));
  const past = values.slice(Math.max(0, idx - 71), idx + 1), next = values.slice(idx + 1, idx + 25);
  const sum = (arr) => +arr.reduce((a, b) => a + b, 0).toFixed(1);
  return {
    source: "Open-Meteo (live)", as_of: now,
    current: {
      temp_c: data.current?.temperature_2m, wind_kmh: data.current?.wind_speed_10m,
      gust_kmh: data.current?.wind_gusts_10m, humidity: data.current?.relative_humidity_2m,
      precip_mm: data.current?.precipitation,
    },
    rain: { rain_1h: sum(past.slice(-1)), rain_3h: sum(past.slice(-3)), rain_24h: sum(past.slice(-24)),
      rain_72h: sum(past.slice(-72)), rain_fc_3h: sum(next.slice(0, 3)), reservoir_release: 0 },
    hourly_past: past.map((v) => +v.toFixed(2)), hourly_next: next.map((v) => +v.toFixed(2)),
  };
}

export async function buildNearbyPack(lat, lon, onProgress) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180)
    throw new Error("The location returned by your device is invalid.");
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined")
    throw new Error("This browser cannot process elevation tiles. Use a current version of Chrome, Edge, or Firefox.");
  const proj = projection(lat, lon), half = RADIUS_KM * 1000, res = GRID_RES;
  const nx = Math.round(2 * half / res), ny = nx, xmin = -half, ymin = -half;
  const bbox = bboxFor(lat, lon, half, proj);
  progress(onProgress, "Getting road, place, and water data…");
  const elements = await fetchOsm(bbox, onProgress);
  const parsed = parseOsm(elements, proj);
  if (!parsed.ways.length) throw new Error("No mapped roads were found within 5 km of your location.");
  const roads = new Uint8Array(nx * ny);
  rasterLines(parsed.ways.map((w) => w.xy), roads, nx, ny, xmin, ymin, res);
  const water = new Uint8Array(nx * ny);
  rasterLines(parsed.waterLines, water, nx, ny, xmin, ymin, res, 20);
  for (const lake of parsed.lakes) rasterizeLake(lake, water, nx, ny, xmin, ymin, res);
  progress(onProgress, "Downloading elevation tiles…");
  const elev = await fetchElevationTiles(lat, lon, xmin, ymin, nx, ny, res, onProgress);
  const terrain = terrainFeatures(elev, water, roads, nx, ny, res, onProgress);
  const pack = buildPack(parsed, terrain, lat, lon, proj, xmin, ymin, nx, ny, res, RADIUS_KM, onProgress);
  progress(onProgress, "Fetching current weather…");
  try { pack.weather = await fetchWeather(lat, lon); }
  catch { progress(onProgress, "Weather unavailable; map generation is continuing."); }
  pack.data_as_of = pack.weather?.as_of || pack.created_at;
  return pack;
}
