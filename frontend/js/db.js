// IndexedDB on the device:
//   packs    full map packs (big)            meta     one small record per pack (fast listing)
//   places   saved places                    settings model, metrics, last pack, basemap ...
const DB_NAME = "floodsense", VERSION = 3;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of [["packs", { keyPath: "id" }], ["meta", { keyPath: "id" }], ["places", { keyPath: "id" }], ["settings", undefined]])
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
