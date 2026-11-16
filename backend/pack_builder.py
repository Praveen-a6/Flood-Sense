"""Live Area Pack builder for any location (needs internet).

  roads, water, hospitals, shelters  <- OpenStreetMap via the Overpass API
  elevation                          <- AWS Terrain Tiles (Terrarium PNG, free, no key)
  rain, wind, temperature            <- Open-Meteo
  known waterlogging hotspots        <- your own GeoJSON files in data/hotspots/

Everything then goes through pack_core.build_pack, the same code the demo
town uses.
"""
import hashlib
import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from .geo import Grid, LocalProjection
from .pack_core import build_pack
from .weather import fetch_weather

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
HOTSPOT_DIR = ROOT / "data" / "hotspots"

OVERPASS_URLS = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"]
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
HEADERS = {"User-Agent": "FloodSense-hackathon/1.0 (student project)"}

# named places shown as labels on the offline map (not used by the model)
LABEL_AMENITIES = ("restaurant|cafe|fast_food|pharmacy|bank|atm|fuel|police|place_of_worship|marketplace|"
                   "bus_station|post_office|cinema|college|university|library|townhall|clinic|doctors|"
                   "hospital|school|community_centre|fire_station")

HIGHWAYS = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|"
            "tertiary|tertiary_link|unclassified|residential|living_street|road")
CHUNK_KM = 3.0          # big cities are downloaded from Overpass in 3 x 3 km pieces


# ----------------------------------------------------------------- OSM ----
def overpass_query(s, w, n, e) -> str:
    bb = f"{s},{w},{n},{e}"
    return f"""[out:json][timeout:200][maxsize:536870912];
(
  way["highway"~"^({HIGHWAYS})$"]({bb});
  way["highway"="service"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["access"!~"^(private|no)$"]({bb});
  way["waterway"~"^(river|canal|stream|drain|ditch)$"]({bb});
  way["natural"="water"]({bb});
  way["railway"="rail"]({bb});
  way["leisure"~"^(park|garden|playground|pitch)$"]({bb});
  way["landuse"~"^(grass|recreation_ground|forest|meadow|village_green|cemetery)$"]({bb});
  nwr["amenity"~"^(hospital|clinic)$"]({bb});
  nwr["amenity"~"^(shelter|community_centre|school)$"]({bb});
  nwr["emergency"="assembly_point"]({bb});
  nwr["amenity"="fire_station"]({bb});
  node["place"~"^(city|town|suburb|quarter|neighbourhood|village|hamlet|locality)$"]({bb});
  nwr["shop"]["name"]({bb});
  nwr["amenity"~"^({LABEL_AMENITIES})$"]["name"]({bb});
);
out tags geom;"""


def fetch_osm(s, w, n, e, timeout=240, retries=3) -> dict:
    """One Overpass request, cached on disk, retried across mirrors with back-off."""
    q = overpass_query(s, w, n, e)
    path = CACHE / "osm" / f"{hashlib.sha1(q.encode()).hexdigest()[:16]}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    last = None
    for attempt in range(retries):
        for url in OVERPASS_URLS:
            try:
                r = requests.post(url, data={"data": q}, headers=HEADERS, timeout=timeout)
                if r.status_code in (429, 504):        # busy server: wait and try the next one
                    raise RuntimeError(f"HTTP {r.status_code} from {url}")
                r.raise_for_status()
                data = r.json()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data), encoding="utf-8")
                return data
            except Exception as ex:
                last = ex
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass API failed after {retries} rounds: {last}")


def fetch_osm_chunked(s, w, n, e, chunk_km=CHUNK_KM, fetch=fetch_osm, progress=print) -> dict:
    """Split a city bbox into ~3 km chunks so no single Overpass query times out.
    Each chunk is cached, so an interrupted build resumes where it stopped."""
    lat_step = chunk_km / 111.0
    lon_step = chunk_km / (111.32 * math.cos(math.radians((s + n) / 2)))
    ny, nx = max(1, math.ceil((n - s) / lat_step)), max(1, math.ceil((e - w) / lon_step))
    elements, seen, k = [], set(), 0
    for i in range(ny):
        for j in range(nx):
            k += 1
            cs, cw = s + i * (n - s) / ny, w + j * (e - w) / nx
            cn, ce = s + (i + 1) * (n - s) / ny, w + (j + 1) * (e - w) / nx
            progress(f"  OpenStreetMap chunk {k}/{nx * ny} ...")
            for el in fetch(cs, cw, cn, ce).get("elements", []):
                key = (el.get("type"), el.get("id", id(el)))
                if key not in seen:            # ways crossing chunk borders come back twice
                    seen.add(key)
                    elements.append(el)
    return {"elements": elements}


def _centre(el):
    if "lat" in el:
        return el["lat"], el["lon"]
    g = el.get("geometry")
    if g:
        return float(np.mean([p["lat"] for p in g])), float(np.mean([p["lon"] for p in g]))
    if "bounds" in el:
        b = el["bounds"]
        return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
    return None


def parse_osm(osm: dict, proj: LocalProjection) -> dict:
    ways, water_geoms, water_lines, lake_polys, pois = [], [], [], [], []
    places, shops, seen = [], [], set()
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        geom = el.get("geometry")
        if el["type"] == "way" and geom:
            x, y = proj.to_xy([g["lat"] for g in geom], [g["lon"] for g in geom])
            xy = list(zip(x.tolist(), y.tolist()))
            if "highway" in tags and len(xy) > 1:
                try:
                    layer = int(str(tags.get("layer", "0")).split(";")[0])
                except ValueError:
                    layer = 0
                oneway = tags.get("oneway")
                if oneway == "-1":                    # one-way against the drawing direction
                    xy = xy[::-1]
                ways.append({
                    "name": tags.get("name:en") or tags.get("name") or tags.get("ref") or "",
                    "highway": tags["highway"],
                    "xy": xy,
                    "tunnel": tags.get("tunnel") in ("yes", "building_passage") or tags.get("covered") == "yes",
                    "bridge": tags.get("bridge") not in (None, "no"),
                    "layer": layer,
                    "oneway": oneway in ("yes", "1", "-1", "true")
                              or (tags["highway"] in ("motorway", "motorway_link") and oneway != "no"),
                })
                continue
            if "waterway" in tags or tags.get("natural") == "water":
                kind = "lake" if tags.get("natural") == "water" else "river"
                water_geoms.append({"kind": kind, "xy": xy})
                (lake_polys if kind == "lake" else water_lines).append(xy)
                continue
            if tags.get("railway") == "rail":
                water_geoms.append({"kind": "rail", "xy": xy})
                continue
            if tags.get("leisure") or tags.get("landuse"):
                if len(xy) > 3:
                    water_geoms.append({"kind": "green", "xy": xy})
                continue
        # map labels: area names and named shops / amenities
        name = tags.get("name:en") or tags.get("name")
        if name and (tags.get("place") or tags.get("shop") or tags.get("amenity")):
            c = _centre(el)
            if c:
                x, y = proj.to_xy(*c)
                if tags.get("place") and el["type"] == "node":
                    places.append({"name": name, "kind": tags["place"], "x": float(x), "y": float(y)})
                elif (name, round(c[0], 4), round(c[1], 4)) not in seen:
                    seen.add((name, round(c[0], 4), round(c[1], 4)))
                    shops.append({"name": name, "cat": tags.get("shop") or tags.get("amenity"),
                                  "x": float(x), "y": float(y)})
        # POIs used for routing (nodes, or the centre of a way/relation outline)
        poi_type = None
        if tags.get("amenity") in ("hospital", "clinic"):
            poi_type = "hospital"
        elif tags.get("amenity") in ("shelter", "community_centre", "school") or tags.get("emergency") == "assembly_point":
            poi_type = "shelter"
        elif tags.get("amenity") == "fire_station":
            poi_type = "emergency"
        if poi_type:
            if "lat" in el:
                lat, lon = el["lat"], el["lon"]
            elif geom:
                lat = float(np.mean([g["lat"] for g in geom])); lon = float(np.mean([g["lon"] for g in geom]))
            elif "bounds" in el:
                b = el["bounds"]; lat = (b["minlat"] + b["maxlat"]) / 2; lon = (b["minlon"] + b["maxlon"]) / 2
            else:
                continue
            x, y = proj.to_xy(lat, lon)
            pois.append({"name": tags.get("name") or poi_type.title(), "type": poi_type, "x": float(x), "y": float(y)})
    return {"ways": ways, "water_geoms": water_geoms, "water_lines": water_lines + lake_polys,
            "rivers": water_lines, "lakes": lake_polys, "pois": pois, "places": places, "shops": shops}


# ----------------------------------------------------------- elevation ----
def _tile_xy(lat, lon, z):
    n = 2 ** z
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2.0 * n
    return x, y


def decode_terrarium(img: Image.Image) -> np.ndarray:
    a = np.asarray(img.convert("RGB"), dtype=float)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def fetch_tile(z, x, y, timeout=20, retries=3) -> np.ndarray:
    path = CACHE / "terrarium" / f"{z}_{x}_{y}.png"
    if path.exists():
        return decode_terrarium(Image.open(path))
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(TERRARIUM.format(z=z, x=x, y=y), headers=HEADERS, timeout=timeout)
            r.raise_for_status()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            return decode_terrarium(Image.open(io.BytesIO(r.content)))
        except Exception as ex:
            last = ex
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"elevation tile {z}/{x}/{y} failed: {last}")


def sample_dem(proj: LocalProjection, grid: Grid, zoom: int = 14, tile_fetch=fetch_tile) -> np.ndarray:
    X, Y = grid.cell_centres()
    lat, lon = proj.to_latlon(X, Y)
    tx, ty = _tile_xy(lat, lon, zoom)
    px, py = tx * 256 - 0.5, ty * 256 - 0.5            # global pixel coordinates
    x0, y0 = int(np.floor(px.min())) - 1, int(np.floor(py.min())) - 1
    x1, y1 = int(np.ceil(px.max())) + 2, int(np.ceil(py.max())) + 2
    mosaic = np.zeros((y1 - y0, x1 - x0))
    keys = [(tx_, ty_) for ty_ in range(y0 // 256, (y1 - 1) // 256 + 1) for tx_ in range(x0 // 256, (x1 - 1) // 256 + 1)]
    with ThreadPoolExecutor(max_workers=8) as pool:      # download tiles in parallel
        tiles = dict(zip(keys, pool.map(lambda k: tile_fetch(zoom, k[0], k[1]), keys)))
    for tx_, ty_ in keys:
        tile = tiles[(tx_, ty_)]
        gx0, gy0 = tx_ * 256, ty_ * 256
        sx0, sy0 = max(gx0, x0), max(gy0, y0)
        sx1, sy1 = min(gx0 + 256, x1), min(gy0 + 256, y1)
        mosaic[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = tile[sy0 - gy0:sy1 - gy0, sx0 - gx0:sx1 - gx0]
    fx, fy = px - x0, py - y0                            # bilinear interpolation
    ix, iy = np.floor(fx).astype(int), np.floor(fy).astype(int)
    dx, dy = fx - ix, fy - iy
    m = mosaic
    return ((m[iy, ix] * (1 - dx) + m[iy, ix + 1] * dx) * (1 - dy)
            + (m[iy + 1, ix] * (1 - dx) + m[iy + 1, ix + 1] * dx) * dy)


# ------------------------------------------------------------ hotspots ----
def load_hotspots(proj: LocalProjection, bbox) -> list:
    s, w, n, e = bbox
    pts = []
    for f in HOTSPOT_DIR.glob("*.geojson"):
        try:
            gj = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for feat in gj.get("features", []):
            g = feat.get("geometry") or {}
            if g.get("type") == "Point":
                lon, lat = g["coordinates"][:2]
                if s <= lat <= n and w <= lon <= e:
                    x, y = proj.to_xy(lat, lon)
                    pts.append((float(x), float(y)))
    return pts


# --------------------------------------------------------------- build ----
def build_live_pack(lat: float, lon: float, radius_km: float = 1.5, name: str | None = None,
                    progress=print, osm_fetch=fetch_osm, tile_fetch=fetch_tile, weather_fetch=fetch_weather,
                    kind: str = "area", pack_id: str | None = None) -> dict:
    """kind="area": up to 3 km radius.  kind="city": up to 10 km radius (a whole city, built once)."""
    radius_km = float(min(max(radius_km, 0.5), 10.0 if kind == "city" else 3.0))
    half = radius_km * 1000.0
    proj = LocalProjection(lat, lon)
    res = max(10.0, round(2 * half / 1000.0))      # keep the terrain grid around 1000 x 1000 cells
    grid = Grid.around(half, res)
    s, w = proj.to_latlon(-half, -half)
    n, e = proj.to_latlon(half, half)
    bbox = (float(s), float(w), float(n), float(e))

    progress("downloading OpenStreetMap roads, names and shops ...")
    osm = parse_osm(fetch_osm_chunked(*bbox, fetch=osm_fetch, progress=progress), proj)
    if not osm["ways"]:
        raise RuntimeError("No roads found in this area.")
    progress("downloading elevation tiles ...")
    z = sample_dem(proj, grid, tile_fetch=tile_fetch)
    water_mask = np.zeros(z.shape, bool)
    if osm["rivers"]:
        water_mask |= grid.rasterize_lines(osm["rivers"], width_m=20)
    if osm["lakes"]:                                 # lakes are polygons: fill their insides too
        from scipy.ndimage import binary_fill_holes
        water_mask |= binary_fill_holes(grid.rasterize_lines([p + [p[0]] for p in osm["lakes"]]))
    progress("fetching weather ...")
    try:
        weather = weather_fetch(lat, lon)
    except Exception as ex:
        progress(f"weather unavailable ({ex}); continuing without it")
        weather = None
    pack_id = pack_id or f"{kind}-{lat:.4f}-{lon:.4f}-{radius_km:g}km".replace(".", "_")
    return build_pack(
        pack_id=pack_id, name=name or f"Area around {lat:.4f}, {lon:.4f}", proj=proj, grid=grid, z=z,
        water_mask=water_mask, ways=osm["ways"], pois=osm["pois"], hotspots=load_hotspots(proj, bbox),
        water_geoms=osm["water_geoms"], weather=weather, synthetic=False, kind=kind,
        places=osm["places"], shops=osm["shops"], prune_islands=True,
        notes="Roads (c) OpenStreetMap contributors. Elevation: AWS Terrain Tiles. Weather: Open-Meteo.",
        progress=progress,
    )
