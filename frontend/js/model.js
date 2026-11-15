// On-device flood model: evaluates the exported LightGBM trees (models/flood_model.json)
// right in the browser. No server, no GPU, no internet. ~220 KB.
import { physicsDepthCm, depthClass } from "./physics.js";

export const CLASS_LABELS = ["Dry (<5 cm)", "Shallow (5-15 cm)", "Deep (15-30 cm)", "Impassable (>30 cm)"];

/** Probabilities for one feature vector. */
export function predictProbs(model, x) {
  const K = model.num_class;
  const raw = new Float64Array(K);
  const trees = model.trees;
  for (let k = 0; k < trees.length; k++) {
    const tr = trees[k];
    let node = tr.root;
    while (node >= 0) node = x[tr.f[node]] <= tr.t[node] ? tr.l[node] : tr.r[node];
    raw[k % K] += tr.v[-node - 1];
  }
  let m = -Infinity;
  for (const r of raw) m = Math.max(m, r);
  let s = 0;
  const p = Array.from(raw, (r) => { const e = Math.exp(r - m); s += e; return e; });
  return p.map((e) => e / s);
}

/** Rain feature vector in the order the pack expects. */
export function rainVector(pack, rain) {
  return pack.rain_features.map((n) => Number(rain[n] || 0));
}

/**
 * Lazy predictor: a road is only run through the model when something needs it
 * (the visible flood-view window, or A* exploring it). This keeps a whole-city
 * pack fast: the 3x3 km view predicts ~3k roads, routing predicts what it touches.
 */
export function createPredictor(pack, rain) {
  const n = pack.segments.length;
  const probs = new Float32Array(n * 4);
  const cls = new Uint8Array(n);
  const done = new Uint8Array(n);
  const rv = rainVector(pack, rain);
  const useModel = !!(pack.model && pack.model.trees && pack.model.trees.length);
  const names = pack.feature_names || pack.static_features.concat(pack.rain_features);
  let computed = 0, ms = 0;
  function ensure(i) {
    if (done[i]) return;
    const t = performance.now();
    const x = pack.segments[i].f.concat(rv);
    let p;
    if (useModel) p = predictProbs(pack.model, x);
    else { const c = depthClass(physicsDepthCm(names, x)); p = [0, 0, 0, 0]; p[c] = 1; }
    let best = 0;
    for (let k = 0; k < 4; k++) { probs[i * 4 + k] = p[k]; if (p[k] > p[best]) best = k; }
    cls[i] = best; done[i] = 1; computed++;
    ms += performance.now() - t;
  }
  return {
    probs, cls, done, rain, engine: useModel ? "AI model (on-device)" : "Physics rule (fallback)",
    ensure,
    clsOf(i) { ensure(i); return cls[i]; },
    ensureMany(ids) { for (const i of ids) ensure(i); },
    get computed() { return computed; },
    get ms() { return ms; },
  };
}

/** Predict every segment of a pack (eager). */
export function predictPack(pack, rain) {
  const p = createPredictor(pack, rain);
  for (let i = 0; i < pack.segments.length; i++) p.ensure(i);
  return p;
}

/** P(depth class >= c) for segment i. */
export function pAtLeast(pred, i, c) {
  pred.ensure(i);
  let s = 0;
  for (let k = c; k < 4; k++) s += pred.probs[i * 4 + k];
  return s;
}

/** Plain-language reasons a road is risky (for the popup). */
export function explain(pack, seg, rain) {
  const f = Object.fromEntries(pack.static_features.map((n, i) => [n, seg.f[i]]));
  const why = [];
  if (f.underpass) why.push("underpass / road below grade");
  if (f.hotspot_100m) why.push("known waterlogging hotspot nearby");
  if (f.depression_m > 0.15) why.push(`sits in a dip about ${(f.depression_m * 100).toFixed(0)} cm deep`);
  if (f.rel_elev_300m < -0.5) why.push(`${(-f.rel_elev_300m).toFixed(1)} m lower than the area around it`);
  if (f.hand_m < 0.5) why.push("almost level with the nearest drain/river");
  if (f.log_flow_acc > 2.5) why.push("a lot of water drains through here");
  if (f.dist_water_m < 150) why.push(`${Math.round(f.dist_water_m)} m from a river/lake`);
  if (f.impervious > 0.7) why.push("mostly concrete around it (little soaks in)");
  if (f.bridge) why.push("on a bridge (stays dry)");
  const r3 = Number(rain.rain_3h || 0), r24 = Number(rain.rain_24h || 0);
  if (r3 >= 30) why.push(`${r3.toFixed(0)} mm rain in the last 3 h`);
  else if (r24 >= 60) why.push(`${r24.toFixed(0)} mm rain in the last 24 h`);
  if (rain.reservoir_release) why.push("upstream reservoir releasing water");
  return why;
}
