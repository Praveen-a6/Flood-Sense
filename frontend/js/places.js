// Offline search over streets, areas, shops, hospitals/shelters and your saved places.
const KIND_LABEL = { home: "Home", work: "Work", fav: "Saved" };

export function buildSearchIndex(pack) {
  const entries = [];
  // streets: one entry per name, placed at the middle of its longest piece
  const best = new Map();
  for (const s of pack.segments) {
    if (!s.name) continue;
    const b = best.get(s.name);
    if (!b || s.len > b.len) best.set(s.name, s);
  }
  for (const [name, s] of best) {
    const m = s.geom[Math.floor(s.geom.length / 2)];
    entries.push({ name, type: "Street", lat: m[0], lon: m[1] });
  }
  for (const p of pack.places || []) entries.push({ name: p.name, type: "Area", lat: p.lat, lon: p.lon });
  for (const p of pack.pois || []) entries.push({ name: p.name, type: p.type === "hospital" ? "Hospital" : p.type === "shelter" ? "Shelter" : "Emergency", lat: p.lat, lon: p.lon });
  for (const p of pack.shops || []) entries.push({ name: p.name, type: (p.cat || "place").replace(/_/g, " "), lat: p.lat, lon: p.lon });
  for (const e of entries) e.key = e.name.toLowerCase();
  return entries;
}

/** Saved places first, then best text matches. */
export function search(index, saved, q, limit = 8) {
  q = q.trim().toLowerCase();
  if (!q) return saved.slice(0, limit).map(asResult);
  const score = (key) => (key === q ? 3 : key.startsWith(q) ? 2 : key.includes(" " + q) ? 1.5 : key.includes(q) ? 1 : 0);
  const out = [];
  for (const p of saved) {
    const sc = Math.max(score(p.name.toLowerCase()), score(KIND_LABEL[p.kind].toLowerCase()));
    if (sc) out.push({ ...asResult(p), sc: sc + 2 });
  }
  for (const e of index) {
    const sc = score(e.key);
    if (sc) out.push({ ...e, sc: sc + (e.type === "Hospital" ? 0.3 : 0) });
  }
  out.sort((a, b) => b.sc - a.sc || a.name.length - b.name.length);
  const seen = new Set();
  return out.filter((r) => { const k = r.name + r.type; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

function asResult(p) { return { name: p.name, type: KIND_LABEL[p.kind] || "Saved", lat: p.lat, lon: p.lon, saved: p }; }

export const PLACE_ICON = { home: "🏠", work: "💼", fav: "★" };
