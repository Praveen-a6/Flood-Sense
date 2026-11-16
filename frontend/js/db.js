// IndexedDB on the device:
//   packs    full map packs (big)            meta     one small record per pack (fast listing)
//   places   saved places                    settings model, metrics, last pack, basemap ...
//   chunks   cached OpenStreetMap downloads (so an interrupted city build resumes)
//   tiles    cached elevation tiles (the same)
// Works on the main thread and inside Web Workers (no DOM use).
const DB_NAME = "floodsense", VERSION = 4;
const STORES = [["packs", { keyPath: "id" }], ["meta", { keyPath: "id" }], ["places", { keyPath: "id" }],
  ["settings", undefined], ["chunks", { keyPath: "k" }], ["tiles", { keyPath: "k" }]];
// cache budgets: keep the device friendly even on a full phone
export const CACHE_BUDGET = { chunksBytes: 200e6, tilesBytes: 60e6, tilesCount: 800 };

export function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of STORES)
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("storage transaction aborted"));
  });
}

export function metaOf(pack, extra = {}) {
  return { id: pack.id, name: pack.name, kind: pack.kind || "area", version: pack.version || 1,
    synthetic: !!pack.synthetic, created_at: pack.created_at, data_as_of: pack.data_as_of,
    segments: pack.segments.length, shops: (pack.shops || []).length, bbox: pack.bbox, center: pack.center,
    downloaded_at: new Date().toISOString(), ...extra };
}

// packs (pack + its meta written in one transaction)
export const savePack = (pack, extra = {}) => tx(["packs", "meta"], "readwrite", (t) => {
  t.objectStore("packs").put(pack);
  return t.objectStore("meta").put(metaOf(pack, extra));
});
export const getPack = (id) => tx(["packs"], "readonly", (t) => t.objectStore("packs").get(id));
export const deletePack = (id) => tx(["packs", "meta"], "readwrite", (t) => { t.objectStore("packs").delete(id); return t.objectStore("meta").delete(id); });
export const getMeta = (id) => tx(["meta"], "readonly", (t) => t.objectStore("meta").get(id));

export async function listPacks() {
  let metas = (await tx(["meta"], "readonly", (t) => t.objectStore("meta").getAll())) || [];
  if (!metas.length) {                     // packs saved by an older app version: build their meta once
    const keys = (await tx(["packs"], "readonly", (t) => t.objectStore("packs").getAllKeys())) || [];
    for (const k of keys) {
      const p = await getPack(k);
      await tx(["meta"], "readwrite", (t) => t.objectStore("meta").put(metaOf(p)));
    }
    if (keys.length) metas = await tx(["meta"], "readonly", (t) => t.objectStore("meta").getAll());
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name));
}

// saved places: { id, name, kind: "home" | "work" | "fav", lat, lon, created }
export const savePlace = (p) => tx(["places"], "readwrite", (t) => t.objectStore("places").put(p));
export const deletePlace = (id) => tx(["places"], "readwrite", (t) => t.objectStore("places").delete(id));
export async function listPlaces() {
  const all = (await tx(["places"], "readonly", (t) => t.objectStore("places").getAll())) || [];
  const order = { home: 0, work: 1, fav: 2 };
  return all.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
}

// settings
export const setSetting = (k, v) => tx(["settings"], "readwrite", (t) => t.objectStore("settings").put(v, k));
export const getSetting = (k) => tx(["settings"], "readonly", (t) => t.objectStore("settings").get(k));

// ---------------------------------------------- download cache (chunks/tiles)
// One small record per cached download: { k, v, bytes, used }.
// Used by the Web Worker that builds city maps; eviction keeps budgets below.
const bytesOf = (v) => (typeof v === "string" ? v.length : v?.byteLength ?? v?.length ?? 1024);

export const cacheGet = (store, k) => tx([store], "readonly", (t) => {
  const req = t.objectStore(store).get(k);
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result?.v ?? null); req.onerror = () => rej(req.error); });
}).catch(() => null);

export const cachePut = (store, k, v) => tx([store], "readwrite", (t) =>
  t.objectStore(store).put({ k, v, bytes: bytesOf(v), used: Date.now() })).catch(() => {});

/** Evict oldest cache entries until both budgets hold. Returns freed bytes (0 if nothing to do). */
export async function maintainCaches() {
  const freed = { chunks: 0, tiles: 0 };
  for (const [store, budget] of [["chunks", CACHE_BUDGET.chunksBytes], ["tiles", CACHE_BUDGET.tilesBytes]]) {
    const all = (await tx([store], "readonly", (t) => {
      const req = t.objectStore(store).getAll();
      return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    }).catch(() => [])) || [];
    let total = all.reduce((a, e) => a + (e.bytes || 0), 0);
    let count = all.length;
    if (total <= budget && (store !== "tiles" || count <= CACHE_BUDGET.tilesCount)) continue;
    all.sort((a, b) => (a.used || 0) - (b.used || 0));           // oldest first
    const victims = [];
    for (const e of all) {
      if (total <= budget && (store !== "tiles" || count <= CACHE_BUDGET.tilesCount)) break;
      total -= e.bytes || 0; count--; victims.push(e.k);
    }
    for (const k of victims) await tx([store], "readwrite", (t) => t.objectStore(store).delete(k)).catch(() => {});
    freed[store] = victims.length;
  }
  return freed;
}

/** Drop all cached downloads (kept maps and saved places are untouched). */
export async function clearCaches() {
  await tx(["chunks"], "readwrite", (t) => t.objectStore("chunks").clear()).catch(() => {});
  await tx(["tiles"], "readwrite", (t) => t.objectStore("tiles").clear()).catch(() => {});
}

/** Cache size info for the Maps tab. */
export async function cacheInfo() {
  const out = { chunks: 0, chunkBytes: 0, tiles: 0, tileBytes: 0 };
  for (const store of ["chunks", "tiles"]) {
    const all = (await tx([store], "readonly", (t) => {
      const req = t.objectStore(store).getAll();
      return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    }).catch(() => [])) || [];
    for (const e of all) {
      if (store === "chunks") { out.chunks++; out.chunkBytes += e.bytes || 0; }
      else { out.tiles++; out.tileBytes += e.bytes || 0; }
    }
  }
  return out;
}
