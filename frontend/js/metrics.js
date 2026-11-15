// "Model performance" card: hold-out test scores that ship inside the pack (works offline).
const CLS = ["Dry", "5-15 cm", "15-30 cm", ">30 cm"];
const COLORS = ["#2e9d4f", "#f2b01e", "#e2482d", "#4b1663"];
const NICE = {
  rain_24h: "Rain last 24 h", hand_m: "Height above drain", rain_72h: "Rain last 72 h", rain_3h: "Rain last 3 h",
  dist_water_m: "Distance to water", depression_m: "Dip depth", impervious: "Concrete share", bridge: "Bridge",
  rain_1h: "Rain last 1 h", log_flow_acc: "Water flowing in", rel_elev_300m: "Lower than area", underpass: "Underpass",
  road_code: "Road type", elev_m: "Elevation", slope_deg: "Slope", hotspot_100m: "Known hotspot",
  rain_fc_3h: "Forecast 3 h", reservoir_release: "Dam release",
};

export function renderMetrics(el, pack, pred) {
  const m = pack.model_metrics;
  const model = pack.model;
  if (!model) { el.innerHTML = `<p class="muted small">No AI model in this pack: using the physics rule.</p>`; return; }
  const mm = m || model.metrics || {};
  const pct = (v) => (v == null ? "–" : `${(+v * (v <= 1 ? 100 : 1)).toFixed(1)}%`);
  const kpis = [
    ["Accuracy", pct(mm.accuracy), "all 4 depth classes"],
    ["Macro F1", mm.macro_f1 != null ? (+mm.macro_f1).toFixed(2) : "–", "balanced over classes"],
    ["Deep roads missed", mm.missed_at_routing_threshold_pct != null ? `${mm.missed_at_routing_threshold_pct}%` : "–", "at the routing threshold"],
    ["Dry roads blocked", mm.dry_roads_wrongly_blocked_pct != null ? `${mm.dry_roads_wrongly_blocked_pct}%` : "–", "false alarms"],
  ];
  let cmHtml = "";
  const cm = m?.confusion_matrix?.matrix;
  if (cm) {
    const rows = cm.map((r, i) => {
      const tot = r.reduce((a, b) => a + b, 0) || 1;
      return `<tr><th>${CLS[i]}</th>${r.map((v, j) => {
        const f = v / tot;
        return `<td style="background:${j === i ? `rgba(46,157,79,${(0.12 + f * 0.6).toFixed(2)})` : `rgba(226,72,45,${(f * 0.9).toFixed(2)})`}" title="${v.toLocaleString()} cases">${(f * 100).toFixed(0)}%</td>`;
      }).join("")}</tr>`;
    }).join("");
    cmHtml = `<p class="small" style="margin:10px 0 4px"><b>Confusion matrix</b> <span class="muted">(rows = true depth, columns = predicted, % of row)</span></p>
      <table class="cm"><tr><th></th>${CLS.map((c, j) => `<th style="color:${COLORS[j]}">${c}</th>`).join("")}</tr>${rows}</table>`;
  }
  let fiHtml = "";
  const fi = m?.feature_importance;
  if (fi) {
    const top = Object.entries(fi).slice(0, 8);
    const max = top[0][1] || 1;
    fiHtml = `<p class="small" style="margin:10px 0 4px"><b>What the model relies on</b> <span class="muted">(gain)</span></p>` +
      top.map(([k, v]) => `<div class="fi"><span>${NICE[k] || k}</span><i style="width:${(100 * v / max).toFixed(0)}%"></i></div>`).join("");
  }
  const live = pred ? `<p class="small muted" style="margin-top:8px">Live on this device: ${pred.computed.toLocaleString()} roads predicted in ${pred.ms.toFixed(0)} ms · ${model.trees.length} trees · trained ${model.trained_at || "–"}</p>` : "";
  el.innerHTML = `<div class="kpis">${kpis.map(([k, v, s]) => `<div><b>${v}</b><span>${k}</span><em>${s}</em></div>`).join("")}</div>
    <p class="small muted" style="margin:8px 0 0">${m?.holdout ? `${m.holdout} · ${Number(m.rows).toLocaleString()} road × rain cases.` : ""}
    Trained on synthetic towns with physics-based labels, not yet on real floods (see README).</p>
    ${cmHtml}${fiHtml}${live}`;
}
