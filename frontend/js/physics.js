// JavaScript twin of backend/physics.py. Used only if the AI model is missing.
const DRAIN_MM = [32, 26, 20, 14, 12];
const EDGES = [5, 15, 30];

export function physicsDepthCm(names, x) {
  const g = Object.fromEntries(names.map((n, i) => [n, x[i]]));
  const r1 = g.rain_1h, r3 = Math.max(g.rain_3h, r1), r24 = Math.max(g.rain_24h, r3), r72 = Math.max(g.rain_72h, r24);
  const eff = r1 + 0.85 * (r3 - r1) + 0.4 * (r24 - r3) + 0.12 * (r72 - r24) + 0.5 * g.rain_fc_3h;
  const imp = Math.min(1, Math.max(0, g.impervious));
  const runoff = 0.35 + 0.55 * imp;
  const drain = DRAIN_MM[Math.min(4, Math.max(0, Math.round(g.road_code)))] * (1 - 0.3 * imp);
  const excess = Math.max(0, eff * runoff - drain);
  const convergence = 1 + 0.45 * Math.min(6, Math.max(0, g.log_flow_acc));
  const lowness = (1 / (1 + Math.max(g.hand_m, 0) / 1.2)) * (1 + Math.min(6, Math.max(0, -g.rel_elev_300m)) / 2);
  let d = excess * convergence * lowness * 1.3;
  d += Math.min(g.depression_m * 1000, excess * 5);
  if (g.underpass > 0.5) d = d * 2.2 + excess * 2;
  const near = Math.min(1, Math.max(0, (150 - g.dist_water_m) / 150));
  d += near * Math.max(0, Math.max(g.rain_24h, g.rain_3h) - 70) * 1.5;
  const nearRes = Math.min(1, Math.max(0, (300 - g.dist_water_m) / 300));
  d += g.reservoir_release * nearRes * 250 / (1 + Math.max(g.hand_m, 0));
  if (g.hotspot_100m > 0.5) d = d * 1.5 + excess * 0.5;
  if (g.bridge > 0.5) d = 0;
  return d / 10;
}

export function depthClass(cm) {
  let c = 0;
  for (const e of EDGES) if (cm >= e) c++;
  return c;
}
