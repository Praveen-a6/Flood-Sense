// Flood-aware routing: A* over the pack's road graph.
// The AI predicts depth per road; this decides the path. Fully offline.
import { pAtLeast } from "./model.js";

export const MODES = {
  walk_child: { label: "Walking with child / elderly", blockAt: 2, fixedKmh: 4, oneway: false,
    note: "avoids water deeper than ~15 cm" },
  two_wheeler: { label: "Two-wheeler", blockAt: 2, maxKmh: 35, oneway: true,
    note: "avoids water deeper than ~15 cm" },
  car: { label: "Car / ambulance", blockAt: 3, maxKmh: 50, oneway: true,
    note: "avoids water deeper than ~30 cm" },
};
const ROAD_KMH = [50, 40, 30, 25, 15];
const BLOCK_PROB = 0.4;           // block a road if P(too deep) >= 40% (safety first)
const ALPHA = 2, BETA = 8;        // penalties for P(>=5 cm) and P(>=15 cm)

const R = 6371000;
export function haversine(a, b) {
  const toR = Math.PI / 180;
  const dp = (b[0] - a[0]) * toR, dl = (b[1] - a[1]) * toR;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function buildGraph(pack) {
  const adj = Array.from({ length: pack.nodes.length }, () => []);
  for (const s of pack.segments) {
    adj[s.a].push({ seg: s.id, to: s.b, forward: true });
    adj[s.b].push({ seg: s.id, to: s.a, forward: false });
  }
  // connected parts of the network: pins are snapped onto the main network, never onto
  // a small cut-off fragment (that would give "no route" for no visible reason)
  const comp = new Int32Array(adj.length).fill(-1), size = [];
  for (let i = 0; i < adj.length; i++) {
    if (comp[i] >= 0 || !adj[i].length) continue;
    const c = size.length; let n = 0; const stack = [i]; comp[i] = c;
    while (stack.length) { const u = stack.pop(); n++; for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); } }
    size.push(n);
  }
  adj.comp = comp; adj.compSize = size;
  adj.mainMin = Math.min(50, Math.max(...size, 0));
  return adj;
}

export function nearestNode(pack, adj, latlon) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < pack.nodes.length; i++) {
    if (!adj[i].length) continue;
    if (adj.compSize && adj.compSize[adj.comp[i]] < adj.mainMin) continue;
    const d = haversine(pack.nodes[i], latlon);
    if (d < bd) { bd = d; best = i; }
  }
  return { node: best, dist: bd };
}

function speedMs(mode, seg) {
  const m = MODES[mode];
  const kmh = m.fixedKmh || Math.min(m.maxKmh, ROAD_KMH[seg.rc] ?? 25);
  return kmh / 3.6;
}

/** Is this segment unsafe for the travel mode? */
export function isBlocked(pred, segId, mode) {
  return pAtLeast(pred, segId, MODES[mode].blockAt) >= BLOCK_PROB;
}

/** Edge cost in seconds (Infinity if blocked). kind = "safe" | "shortest" */
function edgeCost(pack, pred, e, mode, kind) {
  const seg = pack.segments[e.seg];
  if (MODES[mode].oneway && seg.oneway && !e.forward) return Infinity;
  const t = seg.len / speedMs(mode, seg);
  if (kind === "shortest") return t;
  if (isBlocked(pred, e.seg, mode)) return Infinity;
  return t * (1 + ALPHA * pAtLeast(pred, e.seg, 1) + BETA * pAtLeast(pred, e.seg, 2));
}

class MinHeap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/** A* search. Returns null if unreachable. */
export function route(pack, adj, pred, start, goal, mode, kind = "safe") {
  const n = pack.nodes.length;
  const g = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1), prevSeg = new Int32Array(n).fill(-1);
  const maxMs = (MODES[mode].fixedKmh || MODES[mode].maxKmh) / 3.6;
  const goalLL = pack.nodes[goal];
  const h = (i) => haversine(pack.nodes[i], goalLL) / maxMs;
  const heap = new MinHeap();
  g[start] = 0; heap.push(h(start), start);
  const done = new Uint8Array(n);
  while (heap.size) {
    const [, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === goal) break;
    for (const e of adj[u]) {
      const c = edgeCost(pack, pred, e, mode, kind);
      if (c === Infinity) continue;
      const nd = g[u] + c;
      if (nd < g[e.to]) { g[e.to] = nd; prevNode[e.to] = u; prevSeg[e.to] = e.seg; heap.push(nd + h(e.to), e.to); }
    }
  }
  if (g[goal] === Infinity) return null;
  const segs = [], nodes = [goal];
  for (let v = goal; v !== start; v = prevNode[v]) { segs.push(prevSeg[v]); nodes.push(prevNode[v]); }
  segs.reverse(); nodes.reverse();
  return summarise(pack, pred, segs, nodes, mode);
}

function summarise(pack, pred, segs, nodes, mode) {
  let len = 0, time = 0, worst = 0;
  const flooded = [], wet = [];
  for (const s of segs) {
    const seg = pack.segments[s];
    len += seg.len; time += seg.len / speedMs(mode, seg);
    worst = Math.max(worst, pred.clsOf(s));
    if (isBlocked(pred, s, mode)) flooded.push(s);
    else if (pAtLeast(pred, s, 1) >= 0.5) wet.push(s);
  }
  return { segs, nodes, lengthM: len, timeS: time, worstClass: worst, flooded, wet };
}

/** Route to the best reachable POI of a type (e.g. nearest hospital). */
export function routeToNearest(pack, adj, pred, start, mode, type) {
  let best = null;
  for (const p of pack.pois.filter((x) => x.type === type)) {
    const goal = nearestNode(pack, adj, [p.lat, p.lon]).node;
    const r = route(pack, adj, pred, start, goal, mode, "safe");
    if (r && (!best || r.timeS < best.route.timeS)) best = { poi: p, route: r };
  }
  return best;
}

// ---------------------------------------------------------------- directions
function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * toR) * Math.cos(b[0] * toR);
  const x = Math.cos(a[0] * toR) * Math.sin(b[0] * toR) - Math.sin(a[0] * toR) * Math.cos(b[0] * toR) * Math.cos((b[1] - a[1]) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

function orientedGeom(pack, segId, fromNode) {
  const s = pack.segments[segId];
  return s.a === fromNode ? s.geom : [...s.geom].reverse();
}

export function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`; }

/** Turn-by-turn steps with flood warnings. */
export function directions(pack, pred, r, destName = "your destination") {
  if (!r || !r.segs.length) return [{ text: `You are already at ${destName}.`, turn: "arrive", short: `You are at ${destName}` }];
  const legs = [];
  for (let i = 0; i < r.segs.length; i++) {
    const s = pack.segments[r.segs[i]];
    const geom = orientedGeom(pack, r.segs[i], r.nodes[i]);
    const name = s.name || "unnamed road";
    const last = legs[legs.length - 1];
    if (last && last.name === name) {
      last.len += s.len; last.endGeom = geom; last.segs.push(r.segs[i]);
    } else {
      legs.push({ name, len: s.len, startGeom: geom, endGeom: geom, segs: [r.segs[i]] });
    }
  }
  const steps = [];
  legs.forEach((leg, i) => {
    const wet = leg.segs.some((s) => pAtLeast(pred, s, 1) >= 0.5);
    const caution = wet ? " Caution: shallow water possible, go slowly." : "";
    if (i === 0) {
      const b = bearing(leg.startGeom[0], leg.startGeom[leg.startGeom.length - 1]);
      steps.push({ text: `Head ${COMPASS[Math.round(b / 45) % 8]} on ${leg.name} for ${fmtDist(leg.len)}.${caution}`,
        seg: leg.segs[0], turn: "start", name: leg.name, short: `Head ${COMPASS[Math.round(b / 45) % 8]} on ${leg.name}`, wet });
      return;
    }
    const prev = legs[i - 1].endGeom;
    const b1 = bearing(prev[Math.max(0, prev.length - 2)], prev[prev.length - 1]);
    const b2 = bearing(leg.startGeom[0], leg.startGeom[Math.min(1, leg.startGeom.length - 1)]);
    const turn = ((b2 - b1 + 540) % 360) - 180;
    let verb = "Continue onto", kind = "straight";
    if (turn > 150 || turn < -150) { verb = "Make a U-turn onto"; kind = "uturn"; }
    else if (turn > 30) { verb = turn > 110 ? "Turn sharp right onto" : "Turn right onto"; kind = turn > 110 ? "sharp-right" : "right"; }
    else if (turn < -30) { verb = turn < -110 ? "Turn sharp left onto" : "Turn left onto"; kind = turn < -110 ? "sharp-left" : "left"; }
    steps.push({ text: `In ${fmtDist(legs[i - 1].len)}, ${verb.toLowerCase()} ${leg.name}, then go ${fmtDist(leg.len)}.${caution}`,
      seg: leg.segs[0], turn: kind, name: leg.name, short: `${verb} ${leg.name}`, wet });
  });
  steps.push({ text: `Arrive at ${destName}.`, turn: "arrive", short: `Arrive at ${destName}`, name: destName });
  return steps;
}
