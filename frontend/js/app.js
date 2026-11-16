// FloodSense web app: offline maps, flood view, labels, places, routing and live navigation.
import * as db from "./db.js";
import * as packs from "./packs.js";
import { createPredictor, explain, CLASS_LABELS } from "./model.js";
import { parseRain, zeroFeatures } from "./rain.js";
import { MODES, buildGraph, nearestNode, route, routeToNearest, directions, fmtDist, isBlocked } from "./router.js";
import { speak, setVoice, stop as stopVoice } from "./voice.js";
import { RoadLayer, COLORS } from "./roads.js";
import { LabelLayer } from "./labels.js";
import { buildSearchIndex, search, PLACE_ICON } from "./places.js";
import { Navigator } from "./nav.js";
import { renderMetrics } from "./metrics.js";
<<<<<<< HEAD
import { initMapsBuilder, renderCacheBox, runOnboarding } from "./citybuild.js";
import { fetchFreshWeather } from "./cityengine.js";
import * as mobile from "./mobile.js";
=======
>>>>>>> origin/main

const $ = (id) => document.getElementById(id);
const state = {
  pack: null, adj: null, pred: null, roads: null, labels: null, index: [], places: [],
  mode: "walk_child", rainSource: "weather", manual: null,
  from: null, to: null, pickMode: null, forceOffline: false,
  safe: null, shortest: null, steps: [], focus: "both", destName: null,
  viewRadius: 1, viewCenter: null, catalog: null, devicePacks: [], updates: [], downloading: new Map(),
  basemap: "light", saveKind: "fav", saveTarget: null,
};

<<<<<<< HEAD
// Android app: native geolocation + keep-awake shims, safe-area padding class
mobile.installNativeCompat();
if (mobile.isNative()) document.body.classList.add("native-app");

=======
>>>>>>> origin/main
// ================================================================== map
const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([12.98, 80.22], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
const canvas = L.canvas({ padding: 0.5, tolerance: 6 });
const BASEMAPS = {
  // "Clean": light map without its own labels, so FloodSense's names and flood colours stay readable
  light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
    { maxZoom: 19, subdomains: "abcd", attribution: "&copy; OpenStreetMap contributors &copy; CARTO" }),
  osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
};
const layers = {
  green: L.layerGroup().addTo(map), water: L.layerGroup().addTo(map), hot: L.layerGroup().addTo(map),
  shortest: L.layerGroup().addTo(map), safe: L.layerGroup().addTo(map), tags: L.layerGroup().addTo(map),
  pois: L.layerGroup().addTo(map), pins: L.layerGroup().addTo(map), saved: L.layerGroup().addTo(map),
};

const nav = new Navigator({
  map, getPack: () => state.pack, getPred: () => state.pred, getMode: () => state.mode,
  speak: (t) => { if ($("voiceOn").checked) speak(t); },
  onUpdate: renderNav, onReroute: rerouteFrom, onArrive: (d) => { endNavUI(); toast(`Arrived at ${d.name}`); }, onStop: endNavUI,
});

const online = () => navigator.onLine && !state.forceOffline;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v == null ? "–" : Math.round(v));
const pct = (a, n) => `${Math.round((100 * a) / Math.max(1, n))}%`;
const setSeg = (id, val, key) => document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset[key] === String(val)));

function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
function busy(text) { $("busy").hidden = !text; if (text) $("busy").querySelector("span").textContent = text; }

// ============================================================ layout
function showTab(name) {
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "maps") renderMaps();
  if (name === "model") renderMetrics($("metricsBox"), state.pack || {}, state.pred);
  if (window.innerWidth <= 800 && $("panel").classList.contains("sheet-min")) setSheet("mid");
}
function setSheet(s) { $("panel").className = `sheet-${s}`; setTimeout(() => map.invalidateSize(), 260); }
function cycleSheet() {
  const c = $("panel").className;
  setSheet(c === "sheet-min" ? "mid" : c === "sheet-mid" ? "max" : "min");
}

function updateNetUI() {
  const on = online();
  document.body.classList.toggle("offline", !on);
  $("netPill").textContent = on ? "● Online" : "● Offline";
  $("netPill").classList.toggle("off", !on);
  applyBasemap();
  $("refreshWeather").disabled = !state.pack || state.pack.synthetic;
  if (on) refreshCatalog();
}

function applyBasemap() {
  const want = online() && state.pack && !state.pack.synthetic ? state.basemap : "none";
  for (const [k, l] of Object.entries(BASEMAPS)) {
    if (k === want && !map.hasLayer(l)) l.addTo(map).bringToBack();
    if (k !== want && map.hasLayer(l)) map.removeLayer(l);
  }
  map.getContainer().style.background = want === "none" ? "#edf1ee" : "#f2f2ef";
  state.labels?.setOwnLabels(want !== "osm");       // OSM tiles already print street names
}

// ====================================================== map packs
async function refreshCatalog() {
  try { state.catalog = await packs.fetchCatalog(); } catch { return; }
  try { if (await packs.syncModel(state.catalog) && state.pack) { await attachModel(state.pack); recompute(); toast("AI model updated"); } } catch { /* offline */ }
  state.devicePacks = await db.listPacks();
  state.updates = packs.compare(state.devicePacks, state.catalog).updates;
  $("mapsBadge").hidden = !state.updates.length;
  if ($("tab-maps").classList.contains("active")) renderMaps();
}

async function attachModel(pack) {
  if (!pack.model) pack.model = await db.getSetting("model");
  if (!pack.model_metrics) pack.model_metrics = await db.getSetting("metrics");
  pack.feature_names = pack.static_features.concat(pack.rain_features);
}

<<<<<<< HEAD
/** First start: pick any city in India (or near your GPS) -> the browser downloads
 *  OpenStreetMap + elevation + weather for the whole city and builds the offline map. */
function onboarding() {
  return runOnboarding();
=======
/** First start: build and cache a nearby map directly in the browser. */
async function onboarding() {
  $("onboard").hidden = false;
  $("obChoose").hidden = false;
  $("obRetry").hidden = true;
  $("obStatus").textContent = "Your location is used only to fetch nearby map data and centre the offline map.";
}

async function syncFirstRunModel() {
  const response = await fetch("/api/model", { cache: "no-store" });
  if (!response.ok) throw new Error(`AI model unavailable (${response.status})`);
  const model = await response.json();
  await db.setSetting("model", model);
  await db.setSetting("modelVersion", model.trained_at || "unknown");
  const metrics = await fetch("/api/metrics", { cache: "no-store" });
  if (metrics.ok) await db.setSetting("metrics", await metrics.json());
}

function buildNearbyPackInWorker(lat, lon, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./live_pack_worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.message);
      else if (data.type === "complete") { worker.terminate(); resolve(data.pack); }
      else if (data.type === "error") { worker.terminate(); reject(new Error(data.message)); }
    };
    worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message || "Map worker failed.")); };
    worker.postMessage({ lat, lon });
  });
}

async function prepareNearbyMap() {
  if (!online()) {
    $("obStatus").textContent = "Connect to the internet to download map data, then try again.";
    $("obRetry").hidden = false;
    return;
  }
  $("obDownload").disabled = true;
  $("obRetry").hidden = true;
  $("obPackName").textContent = "Nearby map";
  $("obBar").style.width = "0%";
  const step = (id, txt, done) => { $(id).querySelector("em").textContent = txt; $(id).classList.toggle("done", !!done); };
  try {
    $("obStatus").textContent = "Requesting your location…";
    const [lat, lon] = await getGps(15000);
    step("obStep1", "loading…");
    let modelReady = false, modelError = null;
    try { await syncFirstRunModel(); modelReady = true; }
    catch (error) { modelError = error; }
    step("obStep1", modelReady ? "✓ ready" : "physics fallback", modelReady);
    step("obStep2", "building…");
    const pack = await buildNearbyPackInWorker(lat, lon, (text) => {
      $("obStatus").textContent = text;
      const chunks = text.match(/\((\d+)\/(\d+)\)/);
      const terrain = text.match(/\((\d+)%\)/);
      if (text.startsWith("Downloading OpenStreetMap") && chunks)
        $("obBar").style.width = `${5 + 25 * Number(chunks[1]) / Number(chunks[2])}%`;
      else if (text.startsWith("Downloading elevation") && chunks)
        $("obBar").style.width = `${30 + 20 * Number(chunks[1]) / Number(chunks[2])}%`;
      else if (text.startsWith("Analysing terrain") && terrain)
        $("obBar").style.width = `${50 + 40 * Number(terrain[1]) / 100}%`;
      else if (text.startsWith("Preparing roads"))
        $("obBar").style.width = "92%";
    });
    pack.model = await db.getSetting("model");
    if (!pack.model) delete pack.model;
    if (pack.model) pack.feature_names = pack.static_features.concat(pack.rain_features);
    $("obStatus").textContent = "Saving the nearby map on this device…";
    await db.savePack(pack);
    step("obStep2", "✓ saved", true);
    await db.setSetting("lastPack", pack.id);
    const kept = await packs.requestPersist();
    $("obStatus").textContent = modelError
      ? `Map saved. The AI model could not be loaded (${modelError.message}); the built-in flood estimate will be used.`
      : kept ? "Done. Your map is saved permanently and works offline." : "Done. FloodSense now works offline.";
    $("obBar").style.width = "100%";
    await new Promise((r) => setTimeout(r, modelError ? 1600 : 700));
    $("onboard").hidden = true;
    await start();
  } catch (e) {
    const message = e?.name === "QuotaExceededError"
      ? "Not enough storage on this device. Free some space, then try again."
      : "Could not prepare the nearby map: " + e.message;
    $("obStatus").textContent = message;
    $("obRetry").hidden = false;
  } finally {
    $("obDownload").disabled = false;
  }
>>>>>>> origin/main
}

async function downloadFromServer(id) {
  if (state.downloading.has(id)) return;
  state.downloading.set(id, { f: 0, txt: "starting…" });
  renderMaps();
  try {
    await packs.downloadPack(id, (f, txt) => {
      state.downloading.set(id, { f, txt });
      const el = document.querySelector(`[data-prog="${id}"]`);
      if (el) { el.querySelector("i").style.width = `${(f * 100).toFixed(0)}%`; el.nextElementSibling.textContent = txt; }
    });
    toast("Map saved. It works offline now.");
    packs.requestPersist();
    state.downloading.delete(id);
    await refreshCatalog();
    if (!state.pack || state.pack.id === id) await loadPack(id);
  } catch (e) {
    state.downloading.delete(id);
    toast("Download failed: " + e.message, 6000);
  }
  renderMaps();
}

async function renderMaps() {
  state.devicePacks = await db.listPacks();
  const p = state.pack, cmp = packs.compare(state.devicePacks, state.catalog);
  if (p) {
    const tl = p.tiles;
    $("currentMapCard").innerHTML = `<h3>📍 ${esc(p.name)}</h3>
      <div class="kv"><div><b>${p.segments.length.toLocaleString()}</b><span>road segments</span></div>
      <div><b>${(p.shops || []).length.toLocaleString()}</b><span>shops & places</span></div>
      <div><b>${tl ? `${tl.nx} × ${tl.ny} km` : "–"}</b><span>area</span></div>
      <div><b>${p.pois.filter((x) => x.type === "hospital").length}</b><span>hospitals</span></div></div>
<<<<<<< HEAD
      <p class="small muted" style="margin:8px 0 0">${p.synthetic ? "Synthetic demo terrain · " : ""}built ${(p.created_at || "").replace("T", " ")} · weather as of ${(p.data_as_of || "–").replace("T", " ")}</p>`;
=======
      <p class="small muted" style="margin:8px 0 0">${p.synthetic ? "Synthetic demo terrain · " : ""}built ${(p.created_at || "").replace("T", " ")} · weather as of ${(p.data_as_of || "–").replace("T", " ")}</p>
      ${p.notes ? `<p class="small muted" style="margin:6px 0 0">${esc(p.notes)}</p>` : ""}`;
>>>>>>> origin/main
  }
  $("deviceMaps").innerHTML = state.devicePacks.map((m) => {
    const inUse = p && m.id === p.id, upd = cmp.updates.includes(m.id), dl = state.downloading.get(m.id);
    return `<li><span class="ico">${m.kind === "city" ? "🏙" : "📍"}</span><span class="nm"><b>${esc(m.name)}
        ${inUse ? '<span class="tag use">in use</span>' : ""}${upd ? '<span class="tag upd">update</span>' : ""}${m.version < 2 ? '<span class="tag old">old format</span>' : ""}</b>
        <span>${m.segments.toLocaleString()} roads · ${m.bytes ? packs.mb(m.bytes) : ""} · saved ${(m.downloaded_at || "").slice(0, 10)}</span>
        ${dl ? `<div class="mini-bar" data-prog="${m.id}"><i style="width:${dl.f * 100}%"></i></div><span>${esc(dl.txt)}</span>` : ""}</span>
      ${!inUse ? `<button class="go" data-open="${m.id}">Open</button>` : ""}
      ${upd && online() ? `<button data-dl="${m.id}">Update</button>` : ""}
      <button data-del="${m.id}" title="Delete from this device">✕</button></li>`;
  }).join("") || `<li class="empty">No maps on this device yet.</li>`;
<<<<<<< HEAD
  // optional server-prepared packs (advanced); every Indian city can be built in the browser instead
  $("serverPacksCard").hidden = !state.catalog && !mobile.isNative();
=======
>>>>>>> origin/main
  $("serverMaps").innerHTML = state.catalog ? (cmp.available.map((s) => {
    const dl = state.downloading.get(s.id);
    return `<li><span class="ico">${s.kind === "city" ? "🏙" : "📍"}</span><span class="nm"><b>${esc(s.name)}${s.default ? ' <span class="tag use">default</span>' : ""}</b>
      <span>${s.segments.toLocaleString()} roads · ${s.shops.toLocaleString()} shops · ${s.tiles[0]}×${s.tiles[1]} km · ${packs.mb(s.gz_bytes)} download</span>
      ${dl ? `<div class="mini-bar" data-prog="${s.id}"><i style="width:${dl.f * 100}%"></i></div><span>${esc(dl.txt)}</span>` : ""}</span>
      ${dl ? "" : `<button class="go" data-dl="${s.id}">Download</button>`}</li>`;
<<<<<<< HEAD
  }).join("") || `<li class="empty">You have every map the server offers.</li>`) : "";
=======
  }).join("") || `<li class="empty">You have every map the server offers.</li>`) : `<li class="empty">Loading the server's map list…</li>`;
>>>>>>> origin/main
  const st = await packs.storageInfo();
  $("storageBox").innerHTML = `${packs.mb(st.used)} used${st.quota ? ` of ${packs.mb(st.quota)} available to FloodSense` : ""}
    <div class="mini-bar"><i style="width:${st.quota ? Math.max(1, (100 * st.used) / st.quota) : 0}%"></i></div>
    <p class="small ${st.persisted ? "" : "muted"}" style="margin:8px 0 0">${st.persisted ? "✓ Maps are stored permanently (the browser won't clear them)." :
      `Maps could be cleared if the phone runs low on space. <button class="btn ghost sm" id="persistBtn">Keep maps safe</button>`}</p>`;
<<<<<<< HEAD
  await renderCacheBox($("cacheBox"));
=======
>>>>>>> origin/main
}

// ============================================================ packs
async function loadPack(id) {
  const pack = await db.getPack(id);
  if (!pack) return;
  busy("Opening map…");
  await new Promise((r) => setTimeout(r, 20));
  if (nav.active) nav.stop(true);
  state.roads?.destroy(); state.labels?.destroy();
  Object.values(layers).forEach((l) => l.clearLayers());
  await attachModel(pack);
  state.pack = pack;
  state.adj = buildGraph(pack);
  state.from = state.to = null; state.safe = state.shortest = null;
  $("fromInput").value = $("toInput").value = "";
  $("routeCard").hidden = true;
  state.roads = new RoadLayer(map, pack, canvas, onRoadClick);
  state.labels = new LabelLayer(map, pack, () => state.roads.visibleSegIds());
  state.index = buildSearchIndex(pack);
  await db.setSetting("lastPack", id);
  $("currentMapName").textContent = pack.name;
  $("demoTrip").hidden = !pack.demo_trip;
  drawStatic();
  renderWeather();
  renderPlaces();
  const tl = pack.tiles, big = tl && tl.nx * tl.ny > 9;
  state.viewRadius = big ? 1 : Infinity;
  setSeg("viewSeg", big ? "1" : "all", "r");
  state.viewCenter = pack.demo_trip ? pack.demo_trip.from : pack.center;
  map.setView(state.viewCenter, big ? 15 : 14);
  updateNetUI();
  recompute();
  state.roads.update(); state.labels.update();
  busy(null);
  // GPS inside this map? centre the flood view on the user
  getGps(4000).then(([lat, lon]) => { if (inPack(lat, lon)) { state.viewCenter = [lat, lon]; applyFloodView(); } }).catch(() => {});
}

// ========================================================== drawing
function drawStatic() {
  const p = state.pack;
  for (const w of p.water) {
    const o = { renderer: canvas, interactive: false };
    if (w.kind === "green") L.polygon(w.coords, { ...o, stroke: false, fillColor: "#cfe8c9", fillOpacity: 0.75 }).addTo(layers.green);
    else if (w.kind === "lake") L.polygon(w.coords, { ...o, color: "#7fb9dd", weight: 1, fillColor: "#a9d3ef", fillOpacity: 0.85 }).addTo(layers.water);
    else if (w.kind === "rail") L.polyline(w.coords, { ...o, color: "#77828a", weight: 2, dashArray: "8 6" }).addTo(layers.water);
    else L.polyline(w.coords, { ...o, color: "#86c0e3", weight: 8, opacity: 0.85 }).addTo(layers.water);
  }
  const hotIcon = L.divIcon({ className: "", html: '<div class="hot-icon">!</div>', iconSize: [14, 14] });
  for (const h of p.hotspots) L.marker(h, { icon: hotIcon, interactive: false }).addTo(layers.hot);
  for (const poi of p.pois) {
    const letter = { hospital: "H", shelter: "S", emergency: "F" }[poi.type] || "•";
    L.marker([poi.lat, poi.lon], { title: poi.name, icon: L.divIcon({ className: "", html: `<div class="poi-icon poi-${poi.type}">${letter}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindTooltip(poi.name).on("click", () => { setTo([poi.lat, poi.lon], poi.name); maybeRoute(); }).addTo(layers.pois);
  }
}

function onRoadClick(s, ev) {
  if (state.pickMode) return;
  L.DomEvent.stop(ev);
  const i = s.id, pred = state.pred;
  pred.ensure(i);
  const rows = CLASS_LABELS.map((lab, k) => {
    const v = pred.probs[i * 4 + k];
    return `<span>${lab.split(" (")[0]}</span><span class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${COLORS[k]}"></i></span><span>${(v * 100).toFixed(0)}%</span>`;
  }).join("");
  const why = explain(state.pack, s, currentRain());
  L.popup().setLatLng(ev.latlng).setContent(
    `<b>${esc(s.name || "Unnamed road")}</b> <span class="muted">(${s.hw})</span><br>
     Predicted: <b style="color:${COLORS[pred.cls[i]]}">${CLASS_LABELS[pred.cls[i]]}</b>
     <div class="probs">${rows}</div>
     ${isBlocked(pred, i, state.mode) ? `<b style="color:#c62828">Avoided for ${MODES[state.mode].label.toLowerCase()}</b><br>` : ""}
     ${why.length ? "<b>Why:</b> " + why.map(esc).join("; ") : "<span class='muted'>No major risk factors.</span>"}
     ${pointActions([ev.latlng.lat, ev.latlng.lng], s.name)}`).openOn(map);
}

function pointActions(ll, name) {
  const a = `data-ll="${ll}" data-n="${esc(name || "")}"`;
  return `<div class="pop-actions"><button data-act="to" ${a}>Directions here</button><button data-act="from" ${a}>Start here</button><button data-act="save" ${a}>★ Save</button></div>`;
}

// ======================================================= flood view
function applyFloodView() {
  if (!state.roads || !state.pred) return;
  const win = state.roads.windowAround(state.viewCenter, state.viewRadius);
  state.roads.setWindow(win);
  const ids = state.roads.windowSegIds();
  const t = performance.now();
  state.pred.ensureMany(ids);
  const ms = performance.now() - t;
  state.roads.repaint();
  const c = [0, 0, 0, 0];
  for (const i of ids) c[state.pred.cls[i]]++;
  const n = ids.length || 1;
  const size = state.viewRadius === Infinity || !win ? "Whole map" : `${2 * state.viewRadius + 1} × ${2 * state.viewRadius + 1} km`;
  $("viewStats").innerHTML = `${size}: <b>${ids.length.toLocaleString()}</b> roads analysed${ms >= 1 ? ` in ${ms.toFixed(0)} ms` : ""} · ` +
    `<b style="color:${COLORS[2]}">${pct(c[2] + c[3], n)}</b> deep or impassable · <b style="color:#b7860b">${pct(c[1], n)}</b> shallow`;
  $("viewChip").querySelector("span").textContent = state.viewRadius === Infinity || !win ? "Full map" : `${2 * state.viewRadius + 1}×${2 * state.viewRadius + 1} km`;
  if ($("tab-model").classList.contains("active")) renderMetrics($("metricsBox"), state.pack, state.pred);
}

// ============================================================= rain
function currentRain() {
  let r;
  if (state.rainSource === "manual" && state.manual) r = { ...state.manual };
  else if (state.pack?.weather) r = { ...zeroFeatures(), ...state.pack.weather.rain };
  else r = zeroFeatures();
  if ($("reservoir").checked) r.reservoir_release = 1;
  return r;
}

function rainWord(r) {
  const h3 = r.rain_3h, h24 = r.rain_24h;
  if (h3 >= 90 || h24 >= 200) return "Very heavy";
  if (h3 >= 20 || h24 >= 70) return "Heavy";
  if (h3 >= 6 || h24 >= 25) return "Moderate";
  if (h3 > 0.5 || h24 > 3) return "Light";
  return "Dry";
}

function recompute() {
  if (!state.pack) return;
  const rain = currentRain();
  state.pred = createPredictor(state.pack, rain);
  state.roads.pred = state.pred;
  applyFloodView();
  const word = rainWord(rain);
  $("rainBig").textContent = `${word} · ${rain.rain_3h} mm / 3 h`;
  $("rainBigSub").textContent = state.rainSource === "manual" ? "from your description" :
    state.pack.weather ? `${state.pack.weather.source} · ${(state.pack.weather.as_of || "").replace("T", " ")}` : "no weather in this map";
  $("rainChip").querySelector("span").textContent = `${word} · ${rain.rain_3h} mm`;
  $("weatherRainLine").innerHTML = state.pack.weather
    ? `Last 1 h <b>${rain.rain_1h} mm</b> · 3 h <b>${rain.rain_3h}</b> · 24 h <b>${rain.rain_24h}</b> · 72 h <b>${rain.rain_72h}</b>`
    : "No weather saved in this map. Use “Tell us the rain”.";
  if (nav.active && nav.lastPos) rerouteFrom(nav.lastPos, true);
  else if (state.from && state.to) computeRoute(false);
}

function setRainSource(src) {
  setSeg("rainSrc", src, "src");
  $("srcWeather").hidden = src !== "weather"; $("srcManual").hidden = src !== "manual";
  if (src === "weather") { state.rainSource = "weather"; recompute(); }
  else if (state.manual) { state.rainSource = "manual"; recompute(); }
}

function applyManual() {
  const res = parseRain($("rainText").value);
  $("rainSummary").textContent = res.summary;
  $("rainNotes").innerHTML = res.notes.map((n) => `<li>${esc(n)}</li>`).join("");
  if (!res.ok) return;
  if (res.features.reservoir_release) $("reservoir").checked = true;
  state.manual = res.features; state.rainSource = "manual";
  recompute();
}

// ============================================================= trip
function pin(latlng, kind) {
  return L.marker(latlng, { icon: L.divIcon({ className: "", html: `<div class="pin ${kind}"><span>${kind === "from" ? "A" : "B"}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }) });
}
function redrawPins() {
  layers.pins.clearLayers();
  if (state.from) pin(state.pack.nodes[state.from.node], "from").addTo(layers.pins);
  if (state.to) pin(state.pack.nodes[state.to.node], "to").addTo(layers.pins);
}
function setFrom(latlng, label) {
  const { node, dist } = nearestNode(state.pack, state.adj, latlng);
  state.from = { node, label: label || `Map point (${fmtDist(dist)} from road)` };
  $("fromInput").value = state.from.label;
  redrawPins();
}
function setTo(latlng, name) {
  const { node } = nearestNode(state.pack, state.adj, latlng);
  state.to = { node, name: name || "Dropped pin", latlng };
  $("toInput").value = state.to.name;
  redrawPins();
}
function maybeRoute() {
  if (state.from && state.to) computeRoute(true);
  else if (!state.from) toast("Now choose a start: ⌖ GPS, search, or pick on the map.");
}
const inPack = (lat, lon) => { const [s, w, n, e] = state.pack.bbox; return lat >= s && lat <= n && lon >= w && lon <= e; };

function getGps(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS not available in this browser"));
    navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.latitude, p.coords.longitude]),
      (e) => reject(new Error(e.message || "GPS permission denied")), { enableHighAccuracy: true, timeout, maximumAge: 60000 });
  });
}

function setPickMode(mode) {
  state.pickMode = mode;
  $("pickHint").hidden = !mode;
  $("pickHint").textContent = { from: "Tap the map to set your START", to: "Tap the map to set your DESTINATION", save: "Tap the map to choose the place to SAVE" }[mode] || "";
  map.getContainer().style.cursor = mode ? "crosshair" : "";
  if (mode && window.innerWidth <= 800) setSheet("min");
}

map.on("click", (e) => {
  if (!state.pack) return;
  const ll = [e.latlng.lat, e.latlng.lng];
  if (!state.pickMode) {
    if (!nav.active) L.popup().setLatLng(e.latlng).setContent(`<b>Dropped pin</b><br><span class="muted small">${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}</span>${pointActions(ll, "")}`).openOn(map);
    return;
  }
  const mode = state.pickMode; setPickMode(null);
  if (mode === "from") setFrom(ll);
  else if (mode === "to") setTo(ll, null);
  else if (mode === "save") { openSaveForm(ll, ""); return; }
  maybeRoute();
});
map.getContainer().addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const ll = b.dataset.ll.split(",").map(Number), name = b.dataset.n;
  map.closePopup();
  if (b.dataset.act === "to") { setTo(ll, name || "Dropped pin"); maybeRoute(); }
  if (b.dataset.act === "from") { setFrom(ll, name || "Map point"); if (state.to) computeRoute(true); }
  if (b.dataset.act === "save") openSaveForm(ll, name);
});

function setMode(m) {
  state.mode = m;
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("modeNote").textContent = `${MODES[m].label}: ${MODES[m].note}`;
}

// ===================================================== saved places
async function renderPlaces() {
  state.places = await db.listPlaces();
  $("placesList").innerHTML = state.places.length ? state.places.map((p) => `<li>
      <span class="ico">${PLACE_ICON[p.kind]}</span><span class="nm"><b>${esc(p.name)}</b><span>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span></span>
      <button data-pf="${p.id}">From</button><button class="go" data-pt="${p.id}">Go</button><button data-pd="${p.id}" title="Delete">✕</button></li>`).join("")
    : `<li class="empty">Nothing saved yet. Save Home, Work or favourite places for one-tap routes.</li>`;
  $("quickPlaces").innerHTML = state.places.slice(0, 5).map((p) => `<button data-qt="${p.id}" title="Route to ${esc(p.name)}">${PLACE_ICON[p.kind]} ${esc(p.name)}</button>`).join("");
  layers.saved.clearLayers();
  if (!state.pack) return;
  for (const p of state.places) {
    if (!inPack(p.lat, p.lon)) continue;
    L.marker([p.lat, p.lon], { title: p.name, icon: L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="poi-icon" style="background:#fbc02d;color:#333">${PLACE_ICON[p.kind]}</div>` }) })
      .bindTooltip(p.name).on("click", () => useSaved(p, "to")).addTo(layers.saved);
  }
}
function useSaved(p, which) {
  if (!inPack(p.lat, p.lon)) { toast(`${p.name} is outside the open map.`); return; }
  if (which === "from") { setFrom([p.lat, p.lon], p.name); if (state.to) computeRoute(true); }
  else { setTo([p.lat, p.lon], p.name); maybeRoute(); }
  showTab("route");
}
function openSaveForm(ll, name) {
  state.saveTarget = ll;
  showTab("places");
  $("saveForm").hidden = false;
  $("saveName").value = name || "";
  $("saveWhere").textContent = `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`;
  $("saveName").focus();
}
async function confirmSave() {
  const kind = state.saveKind;
  const name = $("saveName").value.trim() || { home: "Home", work: "Work", fav: "Favourite" }[kind];
  const [lat, lon] = state.saveTarget;
  await db.savePlace({ id: kind === "fav" ? `fav-${Date.now()}` : kind, name, kind, lat, lon, created: new Date().toISOString() });
  $("saveForm").hidden = true;
  toast(`Saved “${name}”`);
  renderPlaces();
}

// ============================================================ search
// One helper drives the map search box and the A / B trip inputs.
function attachSearch(input, list, onPick, { gps = false } = {}) {
  const render = () => {
    if (!state.pack) return;
    const q = input.value === state.from?.label || input.value === state.to?.name ? "" : input.value;
    const res = search(state.index, state.places, q, 8);
    const items = (gps ? [{ name: "My location (GPS)", type: "GPS", gps: true }] : []).concat(res);
    list.innerHTML = items.map((r, i) => `<li data-i="${i}"><span>${r.gps ? "⌖" : r.saved ? PLACE_ICON[r.saved.kind] : "📍"} ${esc(r.name)}</span>
      <span class="t">${esc(r.type)}</span>${list.id === "searchResults" && !r.gps ? `<button class="from" data-from="${i}">From</button>` : ""}</li>`).join("");
    list.hidden = !items.length;
    list._items = items;
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", () => { input.select(); render(); });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 180));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && list._items?.length) { e.preventDefault(); onPick(list._items[0], false); list.hidden = true; input.blur(); } });
  list.addEventListener("mousedown", (e) => {
    const items = list._items; if (!items) return;
    const f = e.target.closest("[data-from]");
    const li = e.target.closest("li"); if (!li) return;
    e.preventDefault();
    onPick(items[+(f ? f.dataset.from : li.dataset.i)], !!f);
    list.hidden = true; input.blur();
  });
}

async function pickFrom(r) {
  if (r.gps) return useGps();
  if (!inPack(r.lat, r.lon)) return toast(`${r.name} is outside this map.`);
  setFrom([r.lat, r.lon], r.name);
  if (state.to) computeRoute(true);
}
function pickTo(r) {
  if (!inPack(r.lat, r.lon)) return toast(`${r.name} is outside this map.`);
  setTo([r.lat, r.lon], r.name);
  map.setView([r.lat, r.lon], Math.max(map.getZoom(), 16));
  maybeRoute();
}
async function useGps() {
  try {
    busy("Finding your location…");
    const [lat, lon] = await getGps();
    if (!inPack(lat, lon)) { toast("Your GPS position is outside this map. Pick the start on the map instead."); setPickMode("from"); return; }
    setFrom([lat, lon], "My location (GPS)");
    if (state.to) computeRoute(true);
  } catch (e) { toast(e.message + ". Pick the start on the map instead."); setPickMode("from"); }
  finally { busy(null); }
}

// =========================================================== routing
function segLatLngs(r) {
  return r.segs.map((sid, k) => { const s = state.pack.segments[sid]; return s.a === r.nodes[k] ? s.geom : [...s.geom].reverse(); });
}
const midOf = (r) => { const ll = segLatLngs(r).flat(); return ll[Math.floor(ll.length / 2)]; };

function drawRoutes() {
  const { safe, shortest, focus } = state;
  layers.safe.clearLayers(); layers.shortest.clearLayers(); layers.tags.clearLayers();
  const fadeShort = focus === "safe", fadeSafe = focus === "shortest";
  const same = safe && shortest && Math.abs(safe.lengthM - shortest.lengthM) < 1;
  if (shortest && !same) {
    const ll = segLatLngs(shortest);
    L.polyline(ll, { color: "#fff", weight: 11, opacity: fadeShort ? 0.15 : 0.95, interactive: false }).addTo(layers.shortest);
    L.polyline(ll, { color: "#8e24aa", weight: fadeShort ? 4 : 7, opacity: fadeShort ? 0.3 : 1, dashArray: "12 8", interactive: false }).addTo(layers.shortest);
    for (const sid of shortest.flooded) L.polyline(state.pack.segments[sid].geom, { color: "#c62828", weight: 13, opacity: fadeShort ? 0.15 : 0.55, interactive: false }).addTo(layers.shortest);
    if (!fadeShort) {
      let last = -9;
      shortest.segs.forEach((sid, k) => {
        if (!shortest.flooded.includes(sid)) return;
        if (k - last > 1) {
          const s = state.pack.segments[sid];
          L.marker(s.geom[0], { icon: L.divIcon({ className: "", iconSize: [0, 0], html: '<div class="flood-pin">!</div>' }) })
            .bindTooltip(`Flooded: ${esc(s.name || "road")} · ${CLASS_LABELS[state.pred.clsOf(sid)]}`).addTo(layers.shortest);
        }
        last = k;
      });
      L.marker(midOf(shortest), { interactive: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
        html: `<span class="route-tag short">Shortest · ${fmtDist(shortest.lengthM)}${shortest.flooded.length ? ` · ${shortest.flooded.length} flooded` : ""}</span>` }) }).addTo(layers.tags);
    }
  }
  if (safe) {
    const ll = segLatLngs(safe);
    L.polyline(ll, { color: "#fff", weight: 11, opacity: fadeSafe ? 0.2 : 0.95, interactive: false }).addTo(layers.safe);
    L.polyline(ll, { color: "#1565c0", weight: fadeSafe ? 5 : 7, opacity: fadeSafe ? 0.45 : 1, interactive: false }).addTo(layers.safe);
    if (!fadeSafe) L.marker(midOf(safe), { interactive: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
      html: `<span class="route-tag safe">${same ? "Safe = shortest" : "Safe"} · ${fmtDist(safe.lengthM)}</span>` }) }).addTo(layers.tags);
  }
}

function setFocus(f, fit = true) {
  state.focus = f;
  setSeg("focusSeg", f, "f");
  drawRoutes();
  const r = f === "shortest" ? state.shortest : state.safe;
  if (fit && r && !nav.active) {
    let b = L.latLngBounds(segLatLngs(r).flat());
    if (f === "both" && state.shortest) b = b.extend(L.latLngBounds(segLatLngs(state.shortest).flat()));
    const left = window.innerWidth > 800 ? 20 : 20, bottom = window.innerWidth > 800 ? 20 : window.innerHeight * 0.5;
    map.fitBounds(b, { paddingTopLeft: [left, 70], paddingBottomRight: [20, bottom] });
  }
}

function computeRoute(announce) {
  const { pack, adj, pred } = state;
  const start = state.from.node, goal = state.to.node;
  let safe = route(pack, adj, pred, start, goal, state.mode, "safe");
  const shortest = route(pack, adj, pred, start, goal, state.mode, "shortest");
  let destName = state.to.name, note = "";
  if (!safe) {
    const alt = routeToNearest(pack, adj, pred, start, state.mode, "shelter") || routeToNearest(pack, adj, pred, start, state.mode, "hospital");
    if (alt) { safe = alt.route; destName = alt.poi.name; note = `No safe way to ${esc(state.to.name)} right now. Nearest reachable safe place: <b>${esc(alt.poi.name)}</b>.`; }
  }
  Object.assign(state, { safe, shortest, destName });
  state.steps = safe ? directions(pack, pred, safe, destName) : [];
  renderRoute(note);
  showTab("route");
  setFocus(state.focus, true);
  if (window.innerWidth <= 800) $("routeCard").scrollIntoView({ behavior: "smooth", block: "start" });
  if (announce !== false && safe && $("voiceOn").checked) speak(spokenSummary());
}

function spokenSummary() {
  const { safe, shortest, destName } = state;
  let s = `Safe route to ${destName}: ${fmtDist(safe.lengthM)}, about ${Math.max(1, Math.round(safe.timeS / 60))} minutes.`;
  if (shortest && shortest.flooded.length) s += ` Avoiding ${shortest.flooded.length} flooded stretches on the shortest path.`;
  return s;
}

function renderRoute(note) {
  const { safe, shortest } = state;
  $("routeCard").hidden = false;
  $("startNav").disabled = $("simNav").disabled = !safe;
  if (!safe) {
    $("routeSummary").innerHTML = `<div class="summary bad"><b>No safe route found</b> for ${MODES[state.mode].label.toLowerCase()}.<br>
      Every way there crosses water that is too deep. Stay on higher ground, call 112, and wait for the water to drop.</div>`;
    $("steps").innerHTML = "";
    if ($("voiceOn").checked) speak("No safe route found. Stay on higher ground and call 112.");
    return;
  }
  const mins = Math.max(1, Math.round(safe.timeS / 60));
  const extra = shortest ? safe.lengthM - shortest.lengthM : 0;
  const sh = shortest ? `<div><b class="short">Shortest path</b><br>${fmtDist(shortest.lengthM)} · ${Math.max(1, Math.round(shortest.timeS / 60))} min<br>
      ${shortest.flooded.length ? `<span class="flag">crosses ${shortest.flooded.length} flooded stretch${shortest.flooded.length > 1 ? "es" : ""}</span>` : "no flooding"}</div>` : "";
  $("routeSummary").innerHTML = `<div class="summary ${note ? "bad" : "ok"}">${note ? note + "<br>" : ""}
      <b class="big">${mins} min</b> · ${fmtDist(safe.lengthM)} to <b>${esc(state.destName)}</b><br>
      ${extra > 20 ? `${fmtDist(extra)} longer than the shortest path, but avoids deep water.<br>` : ""}
      ${safe.wet.length ? `${safe.wet.length} stretches may have shallow water. Go slowly.` : "No standing water expected on this route."}</div>
    <div class="compare"><div><b style="color:var(--safe)">Safe route</b><br>${fmtDist(safe.lengthM)} · ${mins} min<br>worst: ${CLASS_LABELS[safe.worstClass]}</div>${sh}</div>`;
  $("steps").innerHTML = state.steps.map((s, k) => `<li data-k="${k}">${esc(s.text)}</li>`).join("");
}

// ========================================================= navigation
function startNav(simulate) {
  if (!state.safe) return;
  if (!simulate && state.from?.label !== "My location (GPS)") toast("Navigation follows your GPS. On a laptop, use Simulate.", 4500);
  setFocus("safe", false);
  document.body.classList.add("navigating");
  $("navBanner").hidden = $("navBar").hidden = false;
  nav.start(state.safe, state.steps, { name: state.destName, node: state.to.node }, { simulate });
}

let lastViewMove = 0;
function renderNav(st) {
  if (st.error) { toast(st.error, 5000); return; }
  if (!st.active) return;
  const s = st.step || {};
  $("navTurn").innerHTML = turnIcon(s.turn);
  $("navDist").textContent = s.turn === "arrive" ? fmtDist(st.remaining) : fmtDist(st.toNext);
  $("navInstr").textContent = s.short || "";
  $("navThen").textContent = st.after && st.after.turn !== "arrive" ? `Then: ${st.after.short}` : "";
  $("navBanner").classList.toggle("wet", !!s.wet);
  $("navEta").textContent = `${Math.max(1, Math.round(st.etaS / 60))} min`;
  $("navRemain").textContent = `${fmtDist(st.remaining)} · arrive ${new Date(Date.now() + st.etaS * 1000).toTimeString().slice(0, 5)}${st.simulate ? " · simulated" : ""}`;
  $("navRecenter").hidden = st.follow;
  const now = Date.now();
  if (state.viewRadius !== Infinity && nav.lastPos && now - lastViewMove > 4000) {
    lastViewMove = now;
    const win = state.roads.windowAround(nav.lastPos, state.viewRadius), cur = state.roads.window;
    if (win && cur && [...win].some((t) => !cur.has(t))) { state.viewCenter = nav.lastPos; applyFloodView(); }
  }
}

function rerouteFrom(pos, quiet = false) {
  const startNode = nearestNode(state.pack, state.adj, pos).node;
  const safe = route(state.pack, state.adj, state.pred, startNode, state.to.node, state.mode, "safe");
  if (!safe) { nav.speak("No safe route from here. Stay on higher ground."); return; }
  state.from = { node: startNode, label: "Current position" };
  $("fromInput").value = "Current position";
  state.safe = safe;
  state.shortest = route(state.pack, state.adj, state.pred, startNode, state.to.node, state.mode, "shortest");
  state.steps = directions(state.pack, state.pred, safe, state.destName);
  renderRoute(""); drawRoutes(); redrawPins();
  nav.start(safe, state.steps, { name: state.destName, node: state.to.node }, { simulate: nav.simulate });
  if (!quiet) toast("Re-routed");
}

function endNavUI() {
  document.body.classList.remove("navigating");
  $("navBanner").hidden = $("navBar").hidden = true;
  setTimeout(() => map.invalidateSize(), 50);
}

function turnIcon(kind) {
  const rot = { left: -90, "sharp-left": -135, right: 90, "sharp-right": 135, uturn: 180 }[kind] ?? 0;
  if (kind === "arrive") return `<svg viewBox="0 0 52 52" width="52" height="52"><circle cx="26" cy="22" r="10" fill="none" stroke="#fff" stroke-width="5"/><path d="M26 32 L26 46" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;
  return `<svg viewBox="0 0 52 52" width="52" height="52" style="transform:rotate(${rot}deg)"><path d="M26 44 L26 12 M14 24 L26 10 L38 24" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// =========================================================== weather
function renderWeather() {
  const w = state.pack?.weather;
  if (!w) { $("weatherBox").innerHTML = "No weather data in this map."; return; }
  const c = w.current || {};
  const past = (w.hourly_past || []).slice(-24), next = (w.hourly_next || []).slice(0, 6);
  const all = past.concat(next), max = Math.max(5, ...all), bw = 300 / all.length;
  const bars = all.map((v, i) => `<rect x="${(i * bw).toFixed(1)}" y="${(60 - (v / max) * 56).toFixed(1)}" width="${(bw - 1.5).toFixed(1)}" height="${((v / max) * 56).toFixed(1)}" rx="1.5" fill="${i >= past.length ? "#9fb7c4" : "#0f7aa3"}"/>`).join("");
  $("weatherBox").innerHTML = `<div class="wx"><div><b>${fmt(c.temp_c)}°</b><span>temp °C</span></div><div><b>${fmt(c.wind_kmh)}</b><span>wind km/h</span></div>
      <div><b>${fmt(c.gust_kmh)}</b><span>gusts km/h</span></div><div><b>${fmt(c.humidity)}%</b><span>humidity</span></div></div>
    <svg class="bars" viewBox="0 0 300 74" width="100%" role="img" aria-label="Rain per hour, last 24 hours and next 6">${bars}
      <line x1="${past.length * bw - 0.75}" x2="${past.length * bw - 0.75}" y1="0" y2="62" stroke="#14232b" stroke-dasharray="2 2"/>
      <text x="0" y="72" font-size="9" fill="#5d6d75">24 h ago</text><text x="${past.length * bw - 14}" y="72" font-size="9" fill="#14232b">now</text>
      <text x="300" y="72" font-size="9" fill="#5d6d75" text-anchor="end">+6 h</text><text x="300" y="9" font-size="9" fill="#5d6d75" text-anchor="end">max ${max.toFixed(0)} mm/h</text></svg>
    <div class="muted small">${esc(w.source)} · as of ${esc((w.as_of || "").replace("T", " "))}</div>`;
}

async function refreshWeather() {
  if (!online() || !state.pack) return;
  busy("Updating weather…");
  try {
<<<<<<< HEAD
    // Open-Meteo directly; the FloodSense server's weather proxy as fallback (if configured)
    const w = await fetchFreshWeather(state.pack.center[0], state.pack.center[1]);
    if (!w) throw new Error("no weather source reachable");
=======
    const r = await fetch(`/api/weather?lat=${state.pack.center[0]}&lon=${state.pack.center[1]}`, { cache: "no-store" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const w = await r.json();
>>>>>>> origin/main
    state.pack.weather = w; state.pack.data_as_of = w.as_of;
    const meta = await db.getMeta(state.pack.id);
    await db.savePack(state.pack, { sha: meta?.sha, bytes: meta?.bytes });
    renderWeather();
    if (state.rainSource === "weather") recompute();
    toast("Weather updated and saved for offline use.");
  } catch (e) { toast("Weather refresh failed: " + e.message); }
  finally { busy(null); }
}

// One click for the presentation: heavy rain + walking with a child + home -> hospital.
function runDemoTrip() {
  const d = state.pack.demo_trip;
  if (!d) return;
  setRainSource("manual");
  $("rainText").value = d.rain;
  setMode(d.mode);
  state.viewCenter = d.from;
  applyManual();
  setFrom(d.from, d.from_label);
  const poi = state.pack.pois.find((p) => p.name === d.to_poi);
  if (poi) setTo([poi.lat, poi.lon], poi.name);
  state.focus = "both";
  computeRoute(true);
}

// ============================================================ events
function wire() {
  document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("sheetHandle").addEventListener("click", cycleSheet);
  $("currentMap").addEventListener("click", () => showTab("maps"));
  $("rainChip").addEventListener("click", () => showTab("rain"));
  $("viewChip").addEventListener("click", () => showTab("rain"));
  $("forceOffline").addEventListener("change", (e) => { state.forceOffline = e.target.checked; updateNetUI(); toast(e.target.checked ? "Offline mode: nothing leaves this device." : "Back online."); });
<<<<<<< HEAD
  // Android app: optional admin-server address (the app works fully without one)
  if (mobile.isNative()) {
    $("serverRow").hidden = false;
    $("serverUrl").value = mobile.serverUrl();
    $("serverSave").addEventListener("click", () => {
      const u = mobile.setServerUrl($("serverUrl").value);
      toast(u ? `Server set to ${u} - checking for admin-prepared packs…` : "Server cleared. FloodSense works fully without one.");
      refreshCatalog();
    });
  }
=======
>>>>>>> origin/main
  window.addEventListener("online", updateNetUI); window.addEventListener("offline", updateNetUI);
  window.addEventListener("resize", () => map.invalidateSize());

  // maps tab
  $("tab-maps").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.open) { await loadPack(b.dataset.open); renderMaps(); toast(`Opened ${state.pack.name}`); }
    if (b.dataset.dl) downloadFromServer(b.dataset.dl);
    if (b.dataset.del) {
      const m = state.devicePacks.find((x) => x.id === b.dataset.del);
      if (!window.confirm(`Delete “${m?.name || b.dataset.del}” from this device?`)) return;
      await db.deletePack(b.dataset.del);
      const rest = await db.listPacks();
      if (state.pack?.id === b.dataset.del) { if (rest.length) await loadPack(rest[0].id); else return location.reload(); }
      renderMaps();
    }
    if (b.id === "persistBtn") { toast((await packs.requestPersist()) ? "Maps will be kept permanently." : "The browser declined. Install FloodSense (Add to Home screen) and try again."); renderMaps(); }
    if (b.dataset.b) { state.basemap = b.dataset.b; setSeg("baseSeg", b.dataset.b, "b"); db.setSetting("basemap", state.basemap); applyBasemap(); }
  });
<<<<<<< HEAD

  // maps tab: build any Indian city in the browser
  initMapsBuilder({
    onBuilt: async (id) => { await loadPack(id); renderMaps(); toast("Map built and saved. It works offline now."); },
    getMapCenter: () => { const c = map.getCenter(); return [c.lat, c.lng]; },
  });
=======
  $("obRetry").addEventListener("click", prepareNearbyMap);
  $("obDownload").addEventListener("click", prepareNearbyMap);
>>>>>>> origin/main

  // rain
  $("rainSrc").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setRainSource(b.dataset.src); });
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("rainText").value = c.dataset.q; applyManual(); }));
  $("applyRain").addEventListener("click", applyManual);
  $("rainText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyManual(); } });
  $("reservoir").addEventListener("change", recompute);
  $("refreshWeather").addEventListener("click", refreshWeather);

  // flood view
  $("viewSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.viewRadius = b.dataset.r === "all" ? Infinity : +b.dataset.r;
    setSeg("viewSeg", b.dataset.r, "r");
    busy("Analysing roads…"); setTimeout(() => { applyFloodView(); busy(null); }, 20);
  });
  $("viewHere").addEventListener("click", () => { const c = map.getCenter(); state.viewCenter = [c.lat, c.lng]; applyFloodView(); });
  $("viewGps").addEventListener("click", async () => {
    try { const ll = await getGps(); if (!inPack(...ll)) { toast("GPS is outside this map."); return; } state.viewCenter = ll; applyFloodView(); map.setView(ll, 15); }
    catch (e) { toast(e.message); }
  });

  // trip
  attachSearch($("fromInput"), $("fromDD"), (r) => pickFrom(r), { gps: true });
  attachSearch($("toInput"), $("toDD"), (r) => pickTo(r));
  attachSearch($("searchInput"), $("searchResults"), (r, asFrom) => { if (asFrom) { pickFrom(r); } else { pickTo(r); } showTab("route"); });
  $("useGps").addEventListener("click", useGps);
  $("pickFrom").addEventListener("click", () => setPickMode("from"));
  $("pickTo").addEventListener("click", () => setPickMode("to"));
  $("swap").addEventListener("click", () => {
    if (!state.from || !state.to) return;
    const f = state.from, t = state.to;
    setFrom(state.pack.nodes[t.node], t.name); setTo(state.pack.nodes[f.node], f.label);
    computeRoute(true);
  });
  $("modes").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (!b) return; setMode(b.dataset.mode); if (state.from && state.to) computeRoute(true); });
  $("goBtn").addEventListener("click", () => {
    if (!state.from) { toast("Choose a start first (⌖ GPS, search or pick on the map)."); $("fromInput").focus(); return; }
    if (!state.to) { toast("Choose a destination."); $("toInput").focus(); return; }
    computeRoute(true);
  });
  $("hospitalBtn").addEventListener("click", () => {
    if (!state.from) { toast("Set your start first, then press again."); $("fromInput").focus(); return; }
    const best = routeToNearest(state.pack, state.adj, state.pred, state.from.node, state.mode, "hospital");
    if (!best) { toast("No hospital reachable without crossing deep water."); return; }
    setTo([best.poi.lat, best.poi.lon], best.poi.name);
    computeRoute(true);
  });
  $("demoTrip").addEventListener("click", runDemoTrip);
  $("quickPlaces").addEventListener("click", (e) => { const b = e.target.closest("[data-qt]"); if (b) useSaved(state.places.find((p) => p.id === b.dataset.qt), "to"); });

  // places
  $("placesList").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.dataset.pf || b.dataset.pt || b.dataset.pd, p = state.places.find((x) => x.id === id);
    if (b.dataset.pf) useSaved(p, "from");
    if (b.dataset.pt) useSaved(p, "to");
    if (b.dataset.pd && window.confirm(`Delete “${p.name}”?`)) { await db.deletePlace(id); renderPlaces(); }
  });
  $("saveKind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.saveKind = b.dataset.k; setSeg("saveKind", b.dataset.k, "k"); } });
  $("saveGps").addEventListener("click", async () => { try { openSaveForm(await getGps(), ""); } catch (e) { toast(e.message); } });
  $("saveMap").addEventListener("click", () => setPickMode("save"));
  $("saveOk").addEventListener("click", confirmSave);
  $("saveName").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmSave(); });
  $("saveCancel").addEventListener("click", () => { $("saveForm").hidden = true; });
  $("saveDest").addEventListener("click", () => { if (state.to) openSaveForm(state.pack.nodes[state.to.node], state.to.name === "Dropped pin" ? "" : state.to.name); });

  // route + navigation
  $("focusSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setFocus(b.dataset.f, true); });
  $("startNav").addEventListener("click", () => startNav(false));
  $("simNav").addEventListener("click", () => startNav(true));
  $("navStop").addEventListener("click", () => nav.stop());
  $("navRecenter").addEventListener("click", () => nav.recenter());
  $("voiceOn").addEventListener("change", (e) => setVoice(e.target.checked));
  $("speakBtn").addEventListener("click", () => { if (state.steps.length) speak(state.steps.map((s) => s.text).join(" ")); });
  $("steps").addEventListener("click", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    const st = state.steps[li.dataset.k];
    speak(st.text);
    if (st.seg != null) map.setView(state.pack.segments[st.seg].geom[0], 17);
  });
  window.addEventListener("beforeunload", stopVoice);
}

// ============================================================= start
async function start() {
  let list = await db.listPacks();
  if (!list.length) {
<<<<<<< HEAD
    const id = await onboarding();
    if (!id) return;
    list = await db.listPacks();
=======
    await onboarding();
    return;
>>>>>>> origin/main
  }
  if (!(await db.getSetting("model")) && online()) { try { await packs.syncModel(await packs.fetchCatalog()); } catch { /* offline */ } }
  state.basemap = (await db.getSetting("basemap")) || "light";
  setSeg("baseSeg", state.basemap, "b");
  // open the map that contains the user (if GPS answers quickly), else the last one used
  let id = await db.getSetting("lastPack");
  if (!list.some((p) => p.id === id)) id = list[0].id;
  if (list.length > 1) {
    try { const [lat, lon] = await getGps(3000); const hit = packs.packContaining(list, lat, lon); if (hit) id = hit.id; } catch { /* no GPS */ }
  }
  await loadPack(id);
  refreshCatalog();
}

setMode("walk_child");
if (window.innerWidth <= 800) document.querySelector(".legend").open = false;
wire();
updateNetUI();
renderPlaces();
<<<<<<< HEAD
if (!mobile.isNative() && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
=======
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
>>>>>>> origin/main
start();
