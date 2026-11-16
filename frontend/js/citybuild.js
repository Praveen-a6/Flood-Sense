// UI layer for building offline city maps ON THE DEVICE (first start + Maps tab).
//
//  - every city and town in India is pickable (built-in catalogue, js/india_cities.js)
//  - "near me" ranks the catalogue by GPS distance
//  - states can be browsed; a whole state is honestly offered as a capped region map
//  - the chosen city downloads in a Web Worker (js/cityworker.js): OpenStreetMap +
//    elevation + weather -> the same pack format the server produced (js/cityengine.js)
//  - clear progress, cancellable, resumable (chunks/tiles cached), every failure
//    shows what happened and what to do
import {
  CITIES, STATE_ANCHORS, citiesInState, cityPackId, cityRadiusKm, nearestCities, searchCities, slug, stateNames,
} from "./india_cities.js";
import { devOverrides, estimatePack, MAX_HALF_KM } from "./cityengine.js";
import * as db from "./db.js";
import * as packs from "./packs.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtPop = (p) => (p >= 1e6 ? `${(p / 1e6).toFixed(1)}M` : p >= 1e3 ? `${Math.round(p / 1e3)}k` : `${p}`);
const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km` : `${Math.round(m)} m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ specs
export function citySpec(i) {
  const c = CITIES[i];
  return { kind: "city", name: c.name, state: c.state, lat: c.lat, lon: c.lon, radiusKm: cityRadiusKm(c.pop), packId: cityPackId(c) };
}
export function stateRegionSpec(state) {
  const anchor = CITIES[STATE_ANCHORS[stateNames.indexOf(state)]];
  return {
    kind: "state", name: `${state} (region)`, state, lat: anchor.lat, lon: anchor.lon,
    radiusKm: MAX_HALF_KM.state, packId: `state-${slug(state)}`, maxHalfKm: MAX_HALF_KM.state,
  };
}
export function areaSpec({ name, lat, lon, radiusKm }) {
  return { kind: "area", name: name || `Area ${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, radiusKm, packId: `area-${slug(name || `${lat.toFixed(3)}-${lon.toFixed(3)}`)}` };
}

function specBox(spec) {                 // the box the estimate is based on (real one comes from the boundary)
  const half = Math.min((spec.maxHalfKm ?? MAX_HALF_KM[spec.kind] ?? 15) * 1000, (spec.radiusKm || 3) * 1000);
  const dLat = half / 111320, dLon = half / (111320 * Math.cos(spec.lat * Math.PI / 180));
  return [spec.lat - dLat, spec.lon - dLon, spec.lat + dLat, spec.lon + dLon];
}

export function planInfo(spec) {
  const est = estimatePack(...specBox(spec));
  return {
    est,
    line: `About ${est.areaKm2.toLocaleString()} km² · ${est.chunks} OpenStreetMap chunks · ${est.tiles} elevation tiles · estimated ${est.packMB} MB map · ${est.minutes}–${est.minutes * 3} min`,
    big: est.areaKm2 > 500,
  };
}

// ------------------------------------------------------------ build runner
let worker = null, running = false, mainCtl = null;

/** Run the city build in a Web Worker (falls back to the main thread). Resolves
 *  { pack, warnings, stats }; rejects with Error(.aborted = cancelled). */
export function runBuild(spec, { onProgress = () => {}, onEvent = () => {} } = {}) {
  if (running) return Promise.reject(new Error("a map download is already running"));
  running = true;
  return new Promise((resolve, reject) => {
    let w = null;
    try { w = new Worker("/js/cityworker.js", { type: "module" }); } catch { w = null; }
    if (!w) return mainThread(spec, resolve, reject);
    worker = w;
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; running = false; worker?.terminate(); worker = null; fn(arg); } };
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "progress") onProgress(m.p, m.text);
      else if (m.type === "event") onEvent(m.kind, m.text);
      else if (m.type === "done") finish(resolve, { pack: m.pack, warnings: m.warnings, stats: m.stats });
      else if (m.type === "error") { const err = new Error(m.message); err.aborted = !!m.aborted; finish(reject, err); }
    };
    w.onerror = (ev) => { finish(reject, new Error(`map builder failed to start (${ev.message || "worker error"})`)); };
    w.postMessage({ type: "build", spec, opts: { overrides: devOverrides() } });
  });

  function mainThread(spec, resolve, reject) {              // old browsers: same engine, main thread
    const ctl = (mainCtl = new AbortController());
    import("./cityengine.js").then((eng) =>
      eng.buildCityPack(spec, { onProgress, onEvent, signal: ctl.signal, overrides: devOverrides(), cache: { get: db.cacheGet, put: db.cachePut } })
    ).then((res) => { running = false; mainCtl = null; resolve(res); },
      (err) => { running = false; mainCtl = null; err.aborted = err?.name === "AbortError"; reject(err); });
  }
}

export const isBuilding = () => running;
/** Cancel the running build: tell the worker, or abort the main-thread fallback. */
export function cancelBuild() {
  if (worker) {
    try { worker.postMessage({ type: "cancel" }); return; } catch { worker.terminate(); worker = null; running = false; }
  }
  mainCtl?.abort();
}

/** Save a freshly built pack + bookkeeping. Returns saved byte count. */
export async function saveBuiltPack(res) {
  const bytes = JSON.stringify(res.pack).length;
  await db.savePack(res.pack, { sha: null, bytes });
  await db.setSetting("lastPack", res.pack.id);
  await db.maintainCaches().catch(() => {});
  return bytes;
}

// ------------------------------------------------------------- city picker
function getGps(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS not available in this browser"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      (e) => reject(new Error(e.message || "GPS permission denied")),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 });
  });
}

/**
 * Wire one city picker (used by first start AND the Maps tab).
 * els: { input, results, state, near }; handlers: { onPick(spec) }.
 */
export function mountCityPicker(els, { onPick } = {}) {
  const { input, results, state, near } = els;
  if (state && !state.options.length) {
    state.innerHTML = `<option value="">All of India</option>` + stateNames.map((s) => `<option>${esc(s)}</option>`).join("");
  }
  const rows = (indices, extra = "") => {
    results.innerHTML = indices.map((i) => {
      const c = CITIES[i];
      const est = estimatePack(...specBox(citySpec(i)));
      const d = c._d != null ? ` · ${fmtKm(c._d)} away` : "";
      return `<li data-city="${i}"><span class="ico">🏙</span><span class="nm"><b>${esc(c.name)}</b> <span class="muted">${esc(c.state)} · ${fmtPop(c.pop)}</span>
        <span>~${2 * Math.round(cityRadiusKm(c.pop))} × ${2 * Math.round(cityRadiusKm(c.pop))} km map · ~${est.packMB} MB${d}</span></span>
        <button class="go">Build map</button></li>`;
    }).join("") + extra;
  };
  const topPicks = () => {
    const s = state?.value;
    if (s) {
      const idxs = citiesInState(s, 40);
      const anchor = CITIES[STATE_ANCHORS[stateNames.indexOf(s)]];
      return rows(idxs, `<li data-state-region="${esc(s)}"><span class="ico">🗺</span><span class="nm"><b>${esc(s)} — region map</b>
        <span>the whole state is too big for one offline map: ${2 * MAX_HALF_KM.state} × ${2 * MAX_HALF_KM.state} km around ${esc(anchor.name)} instead · big download</span></span>
        <button class="go">Build region</button></li>`);
    }
    rows(CITIES.slice(0, 12).map((_, i) => i), `<li class="empty muted">…${(CITIES.length - 12).toLocaleString()} more. Type to search, or use ⌖ Near me.</li>`);
  };
  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = input.value.trim();
      if (q.length < 2) return topPicks();
      const idxs = searchCities(q, { limit: 14, state: state?.value || null });
      rows(idxs, !idxs.length ? `<li class="empty">Nothing found. Check the spelling (e.g. "Thiruvananthapuram", "Mumbai").</li>` : "");
    }, 140);
  });
  input.addEventListener("focus", () => input.select());
  state?.addEventListener("change", () => { input.value = ""; topPicks(); });
  near?.addEventListener("click", async () => {
    results.innerHTML = `<li class="empty">Finding your location…</li>`;
    try {
      const [lat, lon] = await getGps();
      rows(nearestCities(lat, lon, 10));
    } catch (e) {
      results.innerHTML = `<li class="empty">GPS unavailable (${esc(e.message)}). Search instead, or browse by state.</li>`;
    }
  });
  results.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-city], li[data-state-region]");
    if (!li) return;
    if (li.dataset.stateRegion) return onPick(stateRegionSpec(li.dataset.stateRegion));
    onPick(citySpec(+li.dataset.city));
  });
  topPicks();
}

// ================================================================ onboarding
/**
 * First start (no map on the device): choose a city -> download & build once -> saved offline.
 * Resolves with the pack id (or never resolves while the user keeps trying).
 */
export function runOnboarding() {
  return new Promise((resolve) => {
    const view = { pick: $("obPick"), plan: $("obPlan"), build: $("obBuild") };
    const show = (v) => { for (const [k, el] of Object.entries(view)) el.hidden = k !== v; $("onboard").hidden = false; };
    let spec = null;

    const setStep = (n, txt, done) => {
      const el = $(`obStep${n}`);
      el.querySelector("em").textContent = txt || "";
      el.classList.toggle("done", !!done);
    };
    const resetSteps = () => { for (let n = 1; n <= 6; n++) { setStep(n, ""); $(`obStep${n}`).classList.remove("done"); } };
    const note = (t) => { $("obNotes").innerHTML += `<li>${esc(t)}</li>`; };
    const mapProgressToSteps = (p, text) => {
      $("obBar").style.width = `${Math.round(p * 100)}%`;
      $("obStatus").textContent = text;
      if (p < 0.02) setStep(2, "resolving…");
      else if (p < 0.55) { setStep(2, "✓", true); setStep(3, text.replace(/^OpenStreetMap /, "")); }
      else if (p < 0.75) { setStep(2, "✓", true); setStep(3, "✓", true); setStep(4, text.replace(/^Elevation /, "")); }
      else { for (const n of [2, 3, 4]) setStep(n, "✓", true); setStep(5, text.replace(/^Flood terrain: /, "")); }
    };

    async function doBuild() {
      show("build");
      $("obBuildName").textContent = spec.name;
      $("obNotes").innerHTML = "";
      resetSteps();
      $("obRetry").hidden = $("obBack").hidden = true;
      $("obCancel").hidden = false;
      setStep(1, "checking…");
      try {
        try {
          const cat = await packs.fetchCatalog(8000);
          setStep(1, (await packs.syncModel(cat)) ? "✓ updated" : "✓ ready", true);
        } catch {
          setStep(1, "✗ server unreachable - using the built-in physics rule", true);
        }
        const res = await runBuild(spec, {
          onProgress: mapProgressToSteps,
          onEvent: (kind, text) => { if (kind === "warn") note(text); else $("obStatus").textContent = text; },
        });
        setStep(5, "✓", true);
        setStep(6, "saving…");
        const bytes = await saveBuiltPack(res);
        const kept = await packs.requestPersist();
        setStep(6, `✓ ${packs.mb(bytes)} saved`, true);
        $("obBar").style.width = "100%";
        $("obStatus").textContent = `${spec.name} is saved on this device and works offline.`;
        $("obCancel").hidden = true;
        if (res.warnings.length) for (const w of res.warnings) note(w);
        await sleep(900);
        $("onboard").hidden = true;
        resolve(res.pack.id);
      } catch (e) {
        $("obCancel").hidden = true;
        $("obRetry").hidden = false;
        $("obBack").hidden = false;
        if (e.aborted) {
          $("obStatus").textContent = "Cancelled. Finished pieces are kept on this device - Try again continues where it stopped.";
        } else {
          $("obStatus").textContent = `Download failed: ${e.message}`;
          note("Everything downloaded so far is cached. Try again to continue, or pick another city.");
        }
      }
    }

    function renderPlan() {
      const info = planInfo(spec);
      $("obPlanName").textContent = `${spec.kind === "state" ? "🗺" : "🏙"} ${spec.name}`;
      $("obPlanDetail").innerHTML = `${esc(info.line)}<br><span class="muted">Roads © OpenStreetMap contributors · elevation: AWS Terrain Tiles · weather: Open-Meteo. Downloaded and built on this device - nothing is prepared on the server.</span>`;
      $("obPlanWarn").hidden = !info.big;
      if (info.big) $("obPlanWarn").textContent = "This is a very large area. The download can take a long time and the map may be 40+ MB. A smaller city is usually the better choice.";
    }

    mountCityPicker({ input: $("obCitySearch"), results: $("obCityResults"), state: $("obState"), near: $("obNearMe") }, {
      onPick: (s) => { spec = s; renderPlan(); show("plan"); },
    });
    $("obNetNote").textContent = navigator.onLine ? "" : "You're offline: connect to the internet once to build your city map (the Demo City works without internet).";
    $("obPlanBack").addEventListener("click", () => show("pick"));
    $("obBuildBtn").addEventListener("click", doBuild);
    $("obRetry").addEventListener("click", doBuild);
    $("obBack").addEventListener("click", () => show("pick"));
    $("obCancel").addEventListener("click", () => cancelBuild());
    $("obDemo").addEventListener("click", async () => {
      $("obDemo").disabled = true;
      $("obStatus").textContent = "";
      try {
        const cat = await packs.fetchCatalog(10000);
        await packs.syncModel(cat).catch(() => {});
        const demo = cat.packs.find((p) => p.id === "demo-city") || cat.packs.find((p) => p.default) || cat.packs[0];
        if (!demo) throw new Error("the server has no demo map");
        const pack = await packs.downloadPack(demo.id, (f, text) => { $("obBar").style.width = `${f * 100}%`; $("obStatus").textContent = text; });
        await db.setSetting("lastPack", pack.id);
        $("onboard").hidden = true;
        resolve(pack.id);
      } catch (e) {
        $("obDemo").disabled = false;
        $("obStatus").textContent = `Demo map unavailable: ${e.message}`;
      }
    });
    show("pick");
  });
}

// ============================================================= Maps tab
/** Wire the Maps tab "Build a map for any city" card. handlers: { onBuilt(id), getMapCenter() } */
export function initMapsBuilder({ onBuilt, getMapCenter }) {
  const box = $("mapBuildBox");
  let spec = null, areaSource = "gps";

  async function doBuild() {
    $("mapBuildGo").disabled = true;
    $("mapBuildCancel").hidden = false;
    $("mapBuildStatus").textContent = "starting…";
    try {
      const res = await runBuild(spec, {
        onProgress: (p, text) => {
          $("mapBuildBar").style.width = `${Math.round(p * 100)}%`;
          $("mapBuildStatus").textContent = text;
        },
        onEvent: (kind, text) => { if (kind === "warn") $("mapBuildStatus").textContent = text; },
      });
      $("mapBuildStatus").textContent = "saving…";
      const bytes = await saveBuiltPack(res);
      await packs.requestPersist();
      $("mapBuildBar").style.width = "100%";
      $("mapBuildGo").disabled = false;
      $("mapBuildCancel").hidden = true;
      $("mapBuildStatus").textContent = `${spec.name} saved (${packs.mb(bytes)}), works offline.`;
      onBuilt(res.pack.id);
    } catch (e) {
      $("mapBuildGo").disabled = false;
      $("mapBuildCancel").hidden = true;
      $("mapBuildStatus").textContent = e.aborted
        ? "Cancelled - finished pieces are kept, Build map continues where it stopped."
        : `Failed: ${e.message}`;
    }
  }

  function startPlan(s) {
    spec = s;
    const info = planInfo(s);
    box.innerHTML = `<div class="plan-box">
      <b>${esc(s.name)}</b><span class="small muted">${esc(info.line)}</span>
      ${info.big ? `<span class="small" style="color:#b3541e">Very large area - long download, big map. A city is usually the better choice.</span>` : ""}
      <div class="progress"><i id="mapBuildBar"></i></div>
      <p id="mapBuildStatus" class="small muted">ready to download</p>
      <div class="row"><button id="mapBuildGo" class="btn primary grow">⬇ Build offline map</button><button id="mapBuildCancel" class="btn ghost" hidden>Cancel</button></div>
    </div>`;
    $("mapBuildGo").addEventListener("click", doBuild);
    $("mapBuildCancel").addEventListener("click", () => cancelBuild());
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  mountCityPicker({ input: $("mapCitySearch"), results: $("mapCityResults"), state: $("mapState"), near: $("mapNearMe") }, {
    onPick: startPlan,
  });

  // custom area (GPS or map centre + radius) for anything that isn't a whole city
  $("areaSrcGps").addEventListener("click", () => { areaSource = "gps"; $("areaSrcGps").classList.add("active"); $("areaSrcMap").classList.remove("active"); });
  $("areaSrcMap").addEventListener("click", () => { areaSource = "map"; $("areaSrcMap").classList.add("active"); $("areaSrcGps").classList.remove("active"); });
  $("areaBuild").addEventListener("click", async () => {
    const r = +$("areaRadius").value, name = $("areaName").value.trim();
    let ll;
    try {
      ll = areaSource === "gps" ? await getGps() : getMapCenter();
    } catch (e) {
      startPlan(areaSpec({ name, lat: 0, lon: 0, radiusKm: r }));
      $("mapBuildGo").disabled = true;
      $("mapBuildStatus").textContent = `GPS failed (${e.message}) - switch to "map centre" and try again.`;
      return;
    }
    startPlan(areaSpec({ name, lat: ll[0], lon: ll[1], radiusKm: r }));
  });
}

/** Storage card: cached downloads row + clear button (called by renderMaps). */
export async function renderCacheBox(el) {
  const info = await db.cacheInfo().catch(() => ({ chunks: 0, chunkBytes: 0, tiles: 0, tileBytes: 0 }));
  const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
  el.innerHTML = `
    <p class="small ${info.chunkBytes + info.tileBytes ? "muted" : "muted"}" style="margin:0 0 6px">Download cache (resumable city builds): ${info.chunks} OSM chunks (${mb(info.chunkBytes)}) · ${info.tiles} elevation tiles (${mb(info.tileBytes)})</p>
    ${info.chunkBytes + info.tileBytes ? `<button class="btn ghost sm" id="clearCacheBtn">Clear download cache</button>` : ""}`;
  const btn = $("clearCacheBtn");
  if (btn) btn.addEventListener("click", async () => {
    await db.clearCaches();
    toastMsg("Download cache cleared. Saved maps are untouched.");
    renderCacheBox(el);
  });
}
function toastMsg(t) { const el = $("toast"); if (el) { el.textContent = t; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 3200); } }
