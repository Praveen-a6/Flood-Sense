<<<<<<< HEAD
// Map-pack manager on the device: catalogue, downloads with progress + integrity check,
// model sync, updates, storage. Phones only DOWNLOAD packs; they are built on the server
// with `python packs.py build ...`.
import * as db from "./db.js";
import { apiUrl, hasServer, isNative } from "./mobile.js";
=======
// Manager for optional server packs: catalogue, downloads, model sync, updates, and storage.
// The first-run GPS map is built separately in the browser by live_pack.js.
import * as db from "./db.js";
>>>>>>> origin/main

export class DownloadError extends Error {}

async function fetchWithProgress(url, onProgress, timeoutMs = 600000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new DownloadError((await r.json().catch(() => ({}))).detail || `${r.status} ${r.statusText}`);
    const total = +(r.headers.get("X-Pack-Bytes") || r.headers.get("Content-Length") || 0);
    const sha = r.headers.get("X-Pack-Sha");
    if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); onProgress?.(b.length, total); return { bytes: b, sha }; }
    const reader = r.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress?.(got, total);
    }
    const bytes = new Uint8Array(got);
    let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    return { bytes, sha };
  } catch (e) {
    if (e.name === "AbortError") throw new DownloadError("download timed out");
    if (e instanceof DownloadError) throw e;
    throw new DownloadError("network error: " + e.message);
  } finally { clearTimeout(timer); }
}

async function sha16(bytes) {
  if (!globalThis.crypto?.subtle) return null;          // only on https / localhost
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchCatalog(timeoutMs = 10000) {
<<<<<<< HEAD
  if (isNative() && !hasServer()) return null;   // the app runs standalone; no admin server configured
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(apiUrl("/api/catalog"), { signal: ctl.signal, cache: "no-store" });
=======
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch("/api/catalog", { signal: ctl.signal, cache: "no-store" });
>>>>>>> origin/main
    if (!r.ok) throw new Error(r.statusText);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Download, verify and store one pack. onProgress(fraction 0..1, text). */
export async function downloadPack(id, onProgress) {
<<<<<<< HEAD
  const { bytes, sha } = await fetchWithProgress(apiUrl(`/api/packs/${encodeURIComponent(id)}`), (got, total) =>
=======
  const { bytes, sha } = await fetchWithProgress(`/api/packs/${encodeURIComponent(id)}`, (got, total) =>
>>>>>>> origin/main
    onProgress?.(total ? Math.min(1, got / total) : 0, `${mb(got)}${total ? ` of ${mb(total)}` : ""}`));
  onProgress?.(1, "checking…");
  if (sha) {
    const mine = await sha16(bytes);
    if (mine && mine !== sha) throw new DownloadError("file damaged during download (checksum mismatch), please retry");
  }
  let pack;
  try { pack = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DownloadError("received an invalid map file"); }
  if (!Array.isArray(pack.segments) || !Array.isArray(pack.nodes) || !pack.segments.length) throw new DownloadError("map file has no roads");
  onProgress?.(1, "saving on this device…");
  try {
    await db.savePack(pack, { sha: sha || null, bytes: bytes.length });
  } catch (e) {
    if (e?.name === "QuotaExceededError") throw new DownloadError("not enough storage on this device: delete a map or free some space");
    throw e;
  }
  return pack;
}

/** Keep the on-device AI model in sync with the server (if online). Returns true if updated. */
export async function syncModel(catalog) {
  const want = catalog?.model?.version;
  const have = await db.getSetting("modelVersion");
  if (!want || want === have) return false;
  const [m, metrics] = await Promise.all([
<<<<<<< HEAD
    fetch(apiUrl("/api/model"), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    fetch(apiUrl("/api/metrics"), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
=======
    fetch("/api/model", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    fetch("/api/metrics", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
>>>>>>> origin/main
  ]);
  if (!m) return false;
  await db.setSetting("model", m);
  await db.setSetting("metrics", metrics);
  await db.setSetting("modelVersion", want);
  return true;
}

/** Device packs vs server catalogue -> which ones have updates / are not downloaded. */
export function compare(devicePacks, catalog) {
  const server = new Map((catalog?.packs || []).map((p) => [p.id, p]));
  const updates = devicePacks.filter((d) => server.has(d.id) && d.sha && server.get(d.id).sha256 !== d.sha).map((d) => d.id);
  const mine = new Set(devicePacks.map((d) => d.id));
  return { updates, available: (catalog?.packs || []).filter((p) => !mine.has(p.id)), server };
}

export async function storageInfo() {
  const est = (await navigator.storage?.estimate?.()) || {};
  const persisted = (await navigator.storage?.persisted?.()) || false;
  return { used: est.usage || 0, quota: est.quota || 0, persisted };
}

/** Ask the browser not to evict our maps when the phone runs low on space. */
export async function requestPersist() {
  try { return (await navigator.storage?.persist?.()) || false; } catch { return false; }
}

export function packContaining(metas, lat, lon) {
  const inside = metas.filter((m) => m.bbox && lat >= m.bbox[0] && lat <= m.bbox[2] && lon >= m.bbox[1] && lon <= m.bbox[3]);
  // prefer the smallest pack that contains the point (most detailed)
  return inside.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0] || null;
}

export const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
