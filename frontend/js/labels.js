// Offline map labels drawn from the pack itself (no internet, no tile server):
//   area names (zoom 12-16), street names along the road (zoom 15+), shops / amenities (zoom 16+).
const CAT_ICON = {
  pharmacy: "+", chemist: "+", hospital: "H", clinic: "+", doctors: "+", fuel: "⛽", atm: "₹", bank: "₹",
  restaurant: "🍴", fast_food: "🍴", cafe: "☕", bakery: "🍞", supermarket: "🛒", convenience: "🛒",
  greengrocer: "🛒", variety_store: "🛒", place_of_worship: "⛪", school: "🏫", college: "🏫",
  university: "🏫", police: "👮", bus_station: "🚌", post_office: "✉", clothes: "👕", mobile_phone: "📱",
  hardware: "🔧", electrical: "🔌", hairdresser: "✂", marketplace: "🛒", cinema: "🎬", library: "📚",
};
const MAX_STREET_LABELS = 140, MAX_SHOPS = 220;

export class LabelLayer {
  constructor(map, pack, segsInView) {
    this.map = map; this.pack = pack; this.segsInView = segsInView;
    this.areas = L.layerGroup(); this.streets = L.layerGroup().addTo(map); this.shops = L.layerGroup().addTo(map);
    for (const p of pack.places || []) {
      const big = ["city", "town", "suburb"].includes(p.kind);
      L.marker([p.lat, p.lon], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", html: `<div class="lbl-area ${big ? "big" : ""}">${esc(p.name)}</div>`, iconSize: [0, 0] }) })
        .addTo(this.areas);
    }
    this.shopIdx = (pack.shops || []).map((s, i) => i);
    this.own = true;                 // false when the online basemap already prints names
    this._h = () => this.update();
    map.on("moveend zoomend", this._h);
  }

  setOwnLabels(on) { this.own = on; this.update(); }

  update() {
    const z = this.map.getZoom();
    const view = this.map.getBounds();
    // area names
    const showAreas = this.own && z >= 12 && z <= 16;
    if (showAreas && !this.map.hasLayer(this.areas)) this.areas.addTo(this.map);
    if (!showAreas && this.map.hasLayer(this.areas)) this.map.removeLayer(this.areas);

    // street names: one label per street every ~350 m, no overlaps on screen
    this.streets.clearLayers();
    if (this.own && z >= 15) {
      const segs = this.segsInView().map((id) => this.pack.segments[id])
        .filter((s) => s.name && (z >= 16 || s.rc <= 3) && view.contains(s.geom[0]))
        .sort((a, b) => a.rc - b.rc || b.len - a.len);
      const placed = [], perName = new Map();
      const minSameM = z >= 17 ? 220 : 380;
      for (const s of segs) {
        if (placed.length >= MAX_STREET_LABELS) break;
        const mid = s.geom[Math.floor(s.geom.length / 2)];
        const pt = this.map.latLngToContainerPoint(mid);
        const w = s.name.length * 6.2;
        if (placed.some((p) => Math.abs(p.x - pt.x) < (p.w + w) / 2 + 6 && Math.abs(p.y - pt.y) < 16)) continue;
        const prev = perName.get(s.name) || [];
        if (prev.some((q) => this.map.distance(q, mid) < minSameM)) continue;
        const a = this.map.latLngToContainerPoint(s.geom[0]), b = this.map.latLngToContainerPoint(s.geom[s.geom.length - 1]);
        let ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        L.marker(mid, { interactive: false, keyboard: false,
          icon: L.divIcon({ className: "", iconSize: [0, 0],
            html: `<div class="lbl-street rc${s.rc}" style="transform:translate(-50%,-50%) rotate(${ang.toFixed(1)}deg)">${esc(s.name)}</div>` }) })
          .addTo(this.streets);
        placed.push({ x: pt.x, y: pt.y, w }); prev.push(mid); perName.set(s.name, prev);
      }
    }

    // shops & amenities
    this.shops.clearLayers();
    if (z >= 16) {
      let n = 0;
      for (const i of this.shopIdx) {
        const s = this.pack.shops[i];
        if (!view.contains([s.lat, s.lon])) continue;
        if (++n > MAX_SHOPS) break;
        const icon = CAT_ICON[s.cat] || "•";
        L.marker([s.lat, s.lon], { keyboard: false, title: s.name,
          icon: L.divIcon({ className: "", iconSize: [0, 0],
            html: `<div class="lbl-shop"><span class="dot">${icon}</span>${z >= 17 ? `<span class="nm">${esc(s.name)}</span>` : ""}</div>` }) })
          .bindTooltip(`${esc(s.name)} <span class="muted">(${esc(String(s.cat || "").replace(/_/g, " "))})</span>`)
          .addTo(this.shops);
      }
    }
  }

  destroy() {
    this.map.off("moveend zoomend", this._h);
    [this.areas, this.streets, this.shops].forEach((g) => this.map.removeLayer(g));
  }
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
