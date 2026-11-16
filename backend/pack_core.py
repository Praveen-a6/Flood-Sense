"""Turns terrain + roads into an Area Pack (the file the phone keeps offline).

Shared by the synthetic demo town and the live OpenStreetMap builder, so
both produce exactly the same format.
"""
import math
import time
from collections import Counter

import numpy as np

from . import terrain as T
from .features import RAIN_FEATURES, STATIC_FEATURES, road_code
from .geo import Grid, LocalProjection

MAX_SEG_M = 40.0
PACK_VERSION = 2
TILE_M = 1000.0   # flood-view tiles (3x3 / 5x5 km windows are built from these)


def _key(x, y):
    return (round(float(x), 1), round(float(y), 1))


def _densify(pts, max_len):
    out = [pts[0]]
    for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
        n = max(1, math.ceil(math.hypot(x2 - x1, y2 - y1) / max_len))
        for k in range(1, n + 1):
            out.append((x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n))
    return out


def _split_way(pts, breaks):
    """Cut a polyline into pieces of <= MAX_SEG_M, always cutting at junctions."""
    pts = _densify(pts, MAX_SEG_M)
    pieces, cur, length = [], [pts[0]], 0.0
    for p, q in zip(pts[:-1], pts[1:]):
        length += math.hypot(q[0] - p[0], q[1] - p[1])
        cur.append(q)
        if _key(*q) in breaks or length >= MAX_SEG_M * 0.75:
            pieces.append((cur, length))
            cur, length = [q], 0.0
    if len(cur) > 1:
        pieces.append((cur, length))
    return pieces


def _prune_islands(nodes, segments, progress=print, min_share=0.01, min_segs=30):
    """Drop road fragments not connected to the main network (private compounds, mapping
    gaps). A start or destination snapped onto one of them would otherwise give
    'no route'. Keeps every component with >= 1% of the segments (or >= 30)."""
    parent = list(range(len(nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for s in segments:
        ra, rb = find(s["a"]), find(s["b"])
        if ra != rb:
            parent[ra] = rb
    size = Counter(find(s["a"]) for s in segments)
    keep_min = max(min_segs, int(min_share * len(segments)))
    keep = {r for r, c in size.items() if c >= keep_min} or {size.most_common(1)[0][0]}
    kept = [s for s in segments if find(s["a"]) in keep]
    remap, new_nodes = {}, []
    for s in kept:
        for k in ("a", "b"):
            if s[k] not in remap:
                remap[s[k]] = len(new_nodes)
                new_nodes.append(nodes[s[k]])
            s[k] = remap[s[k]]
    for i, s in enumerate(kept):
        s["id"] = i
    dropped = len(segments) - len(kept)
    if dropped:
        progress(f"removed {dropped} road pieces in {len(size) - len(keep)} disconnected fragments")
    return new_nodes, kept


def build_pack(*, pack_id, name, proj: LocalProjection, grid: Grid, z, water_mask,
               ways, pois=(), hotspots=(), water_geoms=(), impervious=None,
               weather=None, synthetic=False, notes="", progress=print,
               places=(), shops=(), kind="area", tile_m=TILE_M, prune_islands=False) -> dict:
    """places: [{name, kind, x, y}] area names (suburb, neighbourhood ...)
    shops:  [{name, cat, x, y}] named shops / amenities shown on the offline map.
    Neither changes any model feature."""
    t0 = time.time()
    progress("terrain analysis ...")
    terr = T.analyse(z, grid.res, water_mask)
    if impervious is None:
        road_mask = grid.rasterize_lines([w["xy"] for w in ways])
        impervious = T.impervious_from_roads(road_mask, grid.res)
    terr["imperv"] = impervious

    # junctions: any point used by more than one way, plus all way ends
    use = Counter()
    for w in ways:
        keys = {_key(*p) for p in w["xy"]}
        use.update(keys)
    breaks = {k for k, c in use.items() if c > 1}
    for w in ways:
        breaks.add(_key(*w["xy"][0])); breaks.add(_key(*w["xy"][-1]))

    hot = np.array(hotspots, dtype=float).reshape(-1, 2)
    xmax, ymax = grid.xmin + grid.nx * grid.res, grid.ymin + grid.ny * grid.res

    node_ids, nodes, segments = {}, [], []
    tnx = max(1, math.ceil((xmax - grid.xmin) / tile_m))
    tny = max(1, math.ceil((ymax - grid.ymin) / tile_m))

    def tile_of(x, y):
        tx = min(tnx - 1, max(0, int((x - grid.xmin) // tile_m)))
        ty = min(tny - 1, max(0, int((y - grid.ymin) // tile_m)))
        return ty * tnx + tx

    def node(p):
        k = _key(*p)
        if k not in node_ids:
            node_ids[k] = len(nodes)
            lat, lon = proj.to_latlon(p[0], p[1])
            nodes.append([round(float(lat), 6), round(float(lon), 6)])
        return node_ids[k]

    progress(f"segmenting {len(ways)} roads ...")
    for w in ways:
        rc = road_code(w.get("highway"))
        under = 1.0 if (w.get("tunnel") or (w.get("layer") or 0) < 0) else 0.0
        bridge = 1.0 if w.get("bridge") else 0.0
        for pts, length in _split_way(w["xy"], breaks):
            if length < 1.0:
                continue
            mx, my = pts[len(pts) // 2]
            if not (grid.xmin <= mx <= xmax and grid.ymin <= my <= ymax):
                continue
            dense = np.array(_densify(pts, grid.res))
            i, j = grid.index(dense[:, 0], dense[:, 1])
            hs = 0.0
            if len(hot):
                d = np.hypot(hot[:, None, 0] - dense[None, :, 0], hot[:, None, 1] - dense[None, :, 1])
                hs = 1.0 if d.min() <= 100 else 0.0
            f = [
                terr["elev"][i, j].min(),
                terr["rel_elev"][i, j].min(),
                terr["depression"][i, j].max(),
                terr["hand"][i, j].min(),
                terr["log_acc"][i, j].max(),
                terr["slope"][i, j].mean(),
                terr["imperv"][i, j].mean(),
                terr["dist_water"][i, j].min(),
                under, bridge, float(rc), hs,
            ]
            lat, lon = proj.to_latlon(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
            segments.append({
                "id": len(segments),
                "a": node(pts[0]), "b": node(pts[-1]),
                "len": round(length, 1),
                "name": w.get("name") or "",
                "hw": w.get("highway") or "road",
                "rc": rc,
                "oneway": bool(w.get("oneway")),
                "t": tile_of(mx, my),
                "geom": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lat, lon)],
                "f": [round(float(v), 3) for v in f],
            })

    if prune_islands:
        nodes, segments = _prune_islands(nodes, segments, progress)

    def ll(p):
        lat, lon = proj.to_latlon(p[0], p[1])
        return [round(float(lat), 6), round(float(lon), 6)]

    tile_bounds = []
    for ty in range(tny):
        for tx in range(tnx):
            x0, y0 = grid.xmin + tx * tile_m, grid.ymin + ty * tile_m
            a, b = ll((x0, y0)), ll((min(x0 + tile_m, xmax), min(y0 + tile_m, ymax)))
            tile_bounds.append([a[0], a[1], b[0], b[1]])

    def inside(p):
        return grid.xmin <= p["x"] <= xmax and grid.ymin <= p["y"] <= ymax

    s, w_ = proj.to_latlon(grid.xmin, grid.ymin)
    n, e = proj.to_latlon(xmax, ymax)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    progress(f"pack ready: {len(segments)} segments, {len(nodes)} nodes in {time.time() - t0:.1f}s")
    return {
        "version": PACK_VERSION,
        "id": pack_id,
        "name": name,
        "kind": kind,
        "synthetic": synthetic,
        "notes": notes,
        "created_at": now,
        "data_as_of": (weather or {}).get("as_of", now),
        "center": [proj.lat0, proj.lon0],
        "bbox": [round(float(s), 6), round(float(w_), 6), round(float(n), 6), round(float(e), 6)],
        "static_features": STATIC_FEATURES,
        "rain_features": RAIN_FEATURES,
        "nodes": nodes,
        "segments": segments,
        "pois": [{"name": p["name"], "type": p["type"], "lat": ll((p["x"], p["y"]))[0],
                  "lon": ll((p["x"], p["y"]))[1]} for p in pois],
        "water": [{"kind": g["kind"], "coords": [ll(p) for p in g["xy"]]} for g in water_geoms],
        "hotspots": [ll(p) for p in hotspots],
        "weather": weather,
        "tiles": {"size_m": tile_m, "nx": tnx, "ny": tny, "bounds": tile_bounds},
        "places": [{"name": p["name"], "kind": p.get("kind", "area"), "lat": ll((p["x"], p["y"]))[0],
                    "lon": ll((p["x"], p["y"]))[1]} for p in places if inside(p)],
        "shops": [{"name": p["name"], "cat": p.get("cat", "shop"), "lat": ll((p["x"], p["y"]))[0],
                   "lon": ll((p["x"], p["y"]))[1]} for p in shops if inside(p)],
    }
