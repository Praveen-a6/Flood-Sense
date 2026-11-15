// Live turn-by-turn navigation: GPS arrow, follow camera, next-turn banner, voice prompts,
// flood-ahead warnings, automatic re-routing and arrival. Works fully offline.
// "Simulate" drives along the route so the feature can be demoed on a laptop.
import { pAtLeast } from "./model.js";
import { haversine, fmtDist, MODES } from "./router.js";

const OFF_ROUTE_M = 40, ARRIVE_M = 20, FAR_PROMPT_M = 200, NEAR_PROMPT_M = 35;
const SIM_SPEEDUP = 4;

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/** Closest point on segment ab to p, all in a local metric frame around p. */
function projectOnSeg(p, a, b) {
  const kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, dist: Math.hypot(qx, qy), point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

export class Navigator {
  constructor({ map, getPack, getPred, getMode, speak, onUpdate, onReroute, onArrive, onStop }) {
    Object.assign(this, { map, getPack, getPred, getMode, speak, onUpdate, onReroute, onArrive, onStop });
    this.active = false; this.follow = true;
    this.arrow = L.marker([0, 0], { interactive: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: "", iconSize: [44, 44], iconAnchor: [22, 22],
        html: '<div class="nav-arrow"><svg viewBox="0 0 44 44" width="44" height="44"><circle cx="22" cy="22" r="20" fill="#1565c0" fill-opacity=".18"/><path d="M22 6 L33 34 L22 28 L11 34 Z" fill="#1565c0" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg></div>' }) });
    this.accuracy = L.circle([0, 0], { radius: 10, color: "#1565c0", weight: 1, fillOpacity: 0.08, interactive: false });
    map.on("dragstart", () => { if (this.active) { this.follow = false; this.onUpdate?.(this.status()); } });
  }

  /** route: router result, steps: directions(), dest: {name, node} */
  start(route, steps, dest, { simulate = false } = {}) {
    this.stop(true, false);
    const pack = this.getPack();
    this.route = route; this.steps = steps; this.dest = dest; this.simulate = simulate;
    // flatten the route into one polyline with cumulative distances
    this.pts = []; this.cum = []; this.segAt = []; const segStart = new Map();
    let d = 0;
    route.segs.forEach((sid, k) => {
      const s = pack.segments[sid];
      const g = s.a === route.nodes[k] ? s.geom : [...s.geom].reverse();
      segStart.set(sid, d);
      g.forEach((p, i) => {
        if (this.pts.length && i === 0) return;
        if (this.pts.length) d += haversine(this.pts[this.pts.length - 1], p);
        this.pts.push(p); this.cum.push(d); this.segAt.push(sid);
      });
    });
    this.total = d;
    this.stepStart = steps.map((st, i) => (st.seg != null ? segStart.get(st.seg) ?? 0 : (i === steps.length - 1 ? d : 0)));
    this.announced = steps.map(() => ({ far: false, near: false }));
    this.warned = new Set();
    this.idx = 0; this.along = 0; this.offCount = 0; this.follow = true; this.active = true;
    this.arrow.setLatLng(this.pts[0]).addTo(this.map);
    this.map.setView(this.pts[0], Math.max(this.map.getZoom(), 17));
    this.speak(steps[0]?.short ? `Starting navigation. ${steps[0].short}.` : "Starting navigation.");
    this.announced[0].far = this.announced[0].near = true;
    this.requestWakeLock();
    if (simulate) this.startSim(); else this.startGps();
    this.onUpdate?.(this.status());
  }

  startGps() {
    if (!navigator.geolocation) { this.onUpdate?.({ error: "GPS not available. Use Simulate." }); return; }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition([p.coords.latitude, p.coords.longitude], p.coords.heading, p.coords.speed, p.coords.accuracy),
      (e) => this.onUpdate?.({ error: `GPS: ${e.message}. Try Simulate.` }),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }

  startSim() {
    const m = MODES[this.getMode()];
    const ms = ((m.fixedKmh || Math.min(m.maxKmh, 30)) / 3.6) * SIM_SPEEDUP;
    let along = 0, last = performance.now();
    this.simTimer = setInterval(() => {
      const now = performance.now(); along += ms * (now - last) / 1000; last = now;
      const p = this.pointAt(Math.min(along, this.total));
      this.onPosition(p.point, p.heading, ms, 5);
    }, 250);
  }

  pointAt(dist) {
    let k = 1;
    while (k < this.cum.length - 1 && this.cum[k] < dist) k++;
    const a = this.pts[k - 1], b = this.pts[k];
    const span = this.cum[k] - this.cum[k - 1] || 1;
    const t = Math.max(0, Math.min(1, (dist - this.cum[k - 1]) / span));
    return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) };
  }

  onPosition(pos, heading, speed, accuracy) {
    if (!this.active) return;
    // snap to the route (search a window ahead of the last known position, then everywhere)
    let best = null;
    const scan = (from, to) => {
      for (let k = Math.max(1, from); k < Math.min(this.pts.length, to); k++) {
        const pr = projectOnSeg(pos, this.pts[k - 1], this.pts[k]);
        if (!best || pr.dist < best.dist) best = { ...pr, k };
      }
    };
    scan(this.idx - 3, this.idx + 60);
    if (!best || best.dist > OFF_ROUTE_M) scan(1, this.pts.length);
    const k = best.k;
    this.idx = k;
    this.along = this.cum[k - 1] + (this.cum[k] - this.cum[k - 1]) * best.t;
    const remaining = Math.max(0, this.total - this.along);

    // arrow + camera
    const routeHeading = bearing(this.pts[k - 1], this.pts[k]);
    const h = heading != null && !Number.isNaN(heading) && speed > 0.7 ? heading : routeHeading;
    const shown = best.dist < OFF_ROUTE_M ? best.point : pos;
    this.arrow.setLatLng(shown);
    const el = this.arrow.getElement()?.querySelector(".nav-arrow");
    if (el) el.style.transform = `rotate(${h}deg)`;
    if (accuracy && !this.simulate) { this.accuracy.setLatLng(pos).setRadius(accuracy); if (!this.map.hasLayer(this.accuracy)) this.accuracy.addTo(this.map); }
    if (this.follow) this.map.panTo(shown, { animate: true, duration: 0.25 });
    this.lastPos = pos;

    // off route -> re-route from here (real GPS only)
    if (best.dist > OFF_ROUTE_M && !this.simulate) {
      if (++this.offCount >= 2) { this.offCount = 0; this.speak("Re-routing."); this.onReroute?.(pos); return; }
    } else this.offCount = 0;

    // arrived
    if (remaining < ARRIVE_M) { this.speak(`You have arrived at ${this.dest.name}.`); const d = this.dest; this.stop(true, false); this.onArrive?.(d); return; }

    // current / next step and voice prompts
    let cur = 0;
    for (let i = 0; i < this.stepStart.length; i++) if (this.stepStart[i] <= this.along + 3) cur = i;
    const next = Math.min(cur + 1, this.steps.length - 1);
    const toNext = Math.max(0, this.stepStart[next] - this.along);
    const st = this.steps[next], flag = this.announced[next];
    if (st && next > 0) {
      if (!flag.far && toNext <= FAR_PROMPT_M && toNext > NEAR_PROMPT_M + 20) { flag.far = true; this.speak(`In ${fmtDist(toNext)}, ${st.short}.`); }
      if (!flag.near && toNext <= NEAR_PROMPT_M) { flag.near = flag.far = true; this.speak(`${st.short}.`); }
    }
    // flood ahead: shallow water in the next 150 m
    const pred = this.getPred();
    for (let j = k; j < this.pts.length && this.cum[j] - this.along < 150; j++) {
      const sid = this.segAt[j];
      if (!this.warned.has(sid) && pAtLeast(pred, sid, 1) >= 0.5) {
        this.warned.add(sid);
        const name = this.getPack().segments[sid].name || "this road";
        this.speak(`Caution: shallow water ahead on ${name}. Go slowly.`);
        break;
      }
    }
    this.cur = cur; this.next = next; this.toNext = toNext; this.remaining = remaining;
    this.onUpdate?.(this.status());
  }

  status() {
    if (!this.active) return { active: false };
    const m = MODES[this.getMode()];
    const kmh = m.fixedKmh || Math.min(m.maxKmh, 30);
    const remaining = this.remaining ?? this.total;
    const next = this.steps[this.next ?? 1] || this.steps[this.steps.length - 1];
    return { active: true, follow: this.follow, simulate: this.simulate, step: next,
      toNext: this.toNext ?? (this.stepStart[1] || this.total), remaining,
      etaS: remaining / (kmh / 3.6), after: this.steps[(this.next ?? 1) + 1] };
  }

  recenter() { this.follow = true; if (this.lastPos) this.map.setView(this.arrow.getLatLng(), Math.max(this.map.getZoom(), 17)); this.onUpdate?.(this.status()); }

  async requestWakeLock() {
    try { this.wake = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
  }

  stop(silent = false, notify = true) {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.simTimer);
    this.watchId = null; this.simTimer = null;
    if (this.active && !silent) this.speak("Navigation stopped.");
    this.active = false;
    this.map.removeLayer(this.arrow); this.map.removeLayer(this.accuracy);
    try { this.wake?.release(); } catch { /* ignore */ }
    if (notify) this.onStop?.();
  }
}
