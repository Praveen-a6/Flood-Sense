// Web Worker entry for the client-side city map builder (used by js/citybuild.js).
// Keeps the whole download + terrain pipeline off the UI thread. Progress is
// posted as messages; a {type:"cancel"} message aborts the current build.
import { buildCityPack } from "./cityengine.js";
import { cacheGet, cachePut, maintainCaches } from "./db.js";

const cache = { get: cacheGet, put: cachePut };
let current = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "cancel") { current?.abort(); return; }
  if (msg.type !== "build") return;
  current = new AbortController();
  try {
    const res = await buildCityPack(msg.spec, {
      ...(msg.opts || {}),
      cache,
      signal: current.signal,
      onProgress: (p, text) => postMessage({ type: "progress", p, text }),
      onEvent: (kind, text) => postMessage({ type: "event", kind, text }),
    });
    postMessage({ type: "done", pack: res.pack, warnings: res.warnings, stats: res.stats });
  } catch (err) {
    postMessage({ type: "error", message: err?.message || String(err), aborted: err?.name === "AbortError" });
  } finally {
    maintainCaches().catch(() => {});
    current = null;
  }
};
