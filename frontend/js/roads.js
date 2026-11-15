// Road drawing for whole-city packs + the flood-view window (3x3 km, 5x5 km or full city).
// Only tiles on screen are drawn; below zoom 14 only main roads are drawn.
export const COLORS = ["#2e9d4f", "#f2b01e", "#e2482d", "#4b1663"];
export const OUTSIDE = "#c3ccd0";      // roads outside the flood view (not analysed yet)
const WEIGHT_BY_RC = [6, 5, 4, 3, 2.5];
// thinner lines when zoomed out, so a whole city doesn't turn into a solid blob
const zoomScale = (z) => (z >= 17 ? 1.35 : z >= 16 ? 1.15 : z >= 15 ? 1 : z >= 14 ? 0.8 : 0.6);

export class RoadLayer {
  constructor(map, pack, renderer, onClick) {
    this.map = map; this.pack = pack; this.renderer = renderer; this.onClick = onClick;
    this.group = L.layerGroup().addTo(map);
    const nt = pack.tiles ? pack.tiles.nx * pack.tiles.ny : 1;
    this.byTile = Array.from({ length: nt }, () => ({ major: [], minor: [] }));
    for (const s of pack.segments) {
      const t = this.byTile[s.t ?? 0] || this.byTile[0];
      (s.rc <= 2 ? t.major : t.minor).push(s.id);
    }
    this.drawn = new Map();       // key "tile:major|minor" -> layerGroup
    this.lines = new Map();       // segId -> polyline
    this.window = null;           // Set of tile indices in the flood view (null = all)
    this.pred = null;
    this.windowRect = L.layerGroup().addTo(map);
    this._h = () => this.update();
    map.on("moveend zoomend", this._h);
  }

  tileBounds(t) {
    const b = this.pack.tiles ? this.pack.tiles.bounds[t] : this.pack.bbox;
    return L.latLngBounds([b[0], b[1]], [b[2], b[3]]);
  }

  segsInTiles(tiles) {
    const out = [];
    for (const t of tiles) { const g = this.byTile[t]; if (g) out.push(...g.major, ...g.minor); }
    return out;
  }

  /** Tiles within `radius` tiles of the tile that contains latlng (radius 1 = 3x3, 2 = 5x5, Infinity = all). */
  windowAround(latlng, radius) {
    const tl = this.pack.tiles;
    if (!tl || radius === Infinity) return null;
    let center = 0, best = Infinity;
    tl.bounds.forEach((b, i) => {
      const cy = (b[0] + b[2]) / 2, cx = (b[1] + b[3]) / 2;
      const d = (cy - latlng[0]) ** 2 + (cx - latlng[1]) ** 2;
      if (d < best) { best = d; center = i; }
    });
    const cx = center % tl.nx, cy = Math.floor(center / tl.nx);
    const set = new Set();
    for (let y = cy - radius; y <= cy + radius; y++)
      for (let x = cx - radius; x <= cx + radius; x++)
        if (x >= 0 && y >= 0 && x < tl.nx && y < tl.ny) set.add(y * tl.nx + x);
    return set;
  }

  visibleTiles() {
    const view = this.map.getBounds();
    const out = [];
    for (let t = 0; t < this.byTile.length; t++) if (view.intersects(this.tileBounds(t))) out.push(t);
    return out;
  }

  visibleSegIds() { return this.segsInTiles(this.visibleTiles()); }

  setWindow(set) {
    this.window = set;
    this.windowRect.clearLayers();
    if (set) {
      let b = null;
      for (const t of set) b = b ? b.extend(this.tileBounds(t)) : this.tileBounds(t);
      L.rectangle(b, { color: "#0f7aa3", weight: 2, dashArray: "8 6", fill: false, interactive: false }).addTo(this.windowRect);
    }
  }

  windowSegIds() {
    if (!this.window) return this.pack.segments.map((s) => s.id);
    return this.segsInTiles(this.window);
  }

  inWindow(segId) {
    return !this.window || this.window.has(this.pack.segments[segId].t ?? 0);
  }

  colorOf(segId) {
    if (!this.pred || !this.inWindow(segId) || !this.pred.done[segId]) return OUTSIDE;
    return COLORS[this.pred.cls[segId]];
  }

  setPredictor(pred) { this.pred = pred; this.repaint(); }

  repaint() {
    for (const [id, line] of this.lines) line.setStyle({ color: this.colorOf(id) });
  }

  update() {
    const view = this.map.getBounds().pad(0.15);
    const zoom = this.map.getZoom();
    if (zoom !== this.lastZoom) {
      this.lastZoom = zoom;
      const k = zoomScale(zoom);
      for (const [id, line] of this.lines) line.setStyle({ weight: (WEIGHT_BY_RC[this.pack.segments[id].rc] ?? 3) * k });
    }
    const want = new Set();
    const nt = this.byTile.length;
    for (let t = 0; t < nt; t++) {
      if (!view.intersects(this.tileBounds(t))) continue;
      want.add(`${t}:major`);
      if (zoom >= 14) want.add(`${t}:minor`);
    }
    for (const [k, g] of this.drawn) if (!want.has(k)) { this.group.removeLayer(g); }
    for (const k of want) {
      let g = this.drawn.get(k);
      if (!g) { g = this.build(k); this.drawn.set(k, g); }
      if (!this.group.hasLayer(g)) this.group.addLayer(g);
    }
  }

  build(key) {
    const [t, kind] = key.split(":");
    const g = L.layerGroup();
    for (const id of this.byTile[+t][kind]) {
      const s = this.pack.segments[id];
      const line = L.polyline(s.geom, { renderer: this.renderer, color: this.colorOf(id),
        weight: (WEIGHT_BY_RC[s.rc] ?? 3) * zoomScale(this.map.getZoom()), opacity: 0.95, lineCap: "round" });
      line.on("click", (ev) => this.onClick(s, ev));
      this.lines.set(id, line);
      g.addLayer(line);
    }
    return g;
  }

  destroy() {
    this.map.off("moveend zoomend", this._h);
    this.map.removeLayer(this.group); this.map.removeLayer(this.windowRect);
  }
}
