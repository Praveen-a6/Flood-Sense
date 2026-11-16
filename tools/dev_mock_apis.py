#!/usr/bin/env python3
"""Mock public-data APIs for testing the browser-side city builder end-to-end.

The FloodSense app can build a whole-city offline map from:
  OpenStreetMap (Overpass), Nominatim (city boundary), AWS Terrain Tiles
  (elevation) and Open-Meteo (weather).  Overpass in particular is slow and
  rate-limited, so this server serves a small DETERMINISTIC fake city around
  13.00 N, 80.20 E for offline testing of the whole pipeline.

Run it next to the real server:
    python run.py --port 8000 --no-browser      # the app
    python tools/dev_mock_apis.py               # mocks on http://localhost:8001

Then open the app with the mocks:
    http://localhost:8000/?nominatim-url=http://localhost:8001/nominatim/search&overpass-url=http://localhost:8001/overpass&tiles-url=http://localhost:8001/tiles/{z}/{x}/{y}.png&meteo-url=http://localhost:8001/meteo

and build any city (the mock ignores which one and always returns Mock City).
"""
import io
import math
import re

import numpy as np
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

app = FastAPI(title="FloodSense mock data APIs")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

LAT, LON = 13.00, 80.20          # Mock City centre (same anchor as the pytest fixtures)


# ------------------------------------------------------------------ boundary
@app.get("/nominatim/search")
def nominatim(q: str, format: str = "json"):
    half = 0.012                                   # ~2.6 x 2.7 km square "city"
    ring = [[LON - half, LAT - half], [LON + half, LAT - half], [LON + half, LAT + half],
            [LON - half, LAT + half], [LON - half, LAT - half]]
    return [{
        "osm_type": "relation", "osm_id": 1000001, "lat": str(LAT), "lon": str(LON),
        "display_name": f"Mock City ({q})", "type": "administrative",
        "boundingbox": [str(LAT - half), str(LAT + half), str(LON - half), str(LON + half)],
        "geojson": {"type": "Polygon", "coordinates": [ring]},
    }]


# --------------------------------------------------------------------- OSM
def _streets(s, w, n, e):
    """A deterministic street grid + water + POIs inside the requested bbox.
    Streets share vertices at every crossing (like real OSM shared nodes),
    so the routing graph is one connected network."""
    els, wid = [], 1000
    lats = [round(float(la), 7) for la in np.arange(s, n, 0.0022)]
    lons = [round(float(lo), 7) for lo in np.arange(w, e, 0.0023)]

    def way(tags, geom):
        nonlocal wid
        wid += 2
        els.append({"type": "way", "id": wid, "tags": tags, "geometry": [{"lat": la, "lon": lo} for la, lo in geom]})

    def node(lat, lon, tags):
        els.append({"type": "node", "id": 500000 + len(els), "tags": tags, "lat": lat, "lon": lon})

    for k, la in enumerate(lats):                                  # east-west streets
        name = "Mock Main Road" if k == 5 else f"Grid Street {k}"
        hw = "primary" if k == 5 else "residential"
        way({"highway": hw, "name": name}, [(la, lo) for lo in lons])
    for k, lo in enumerate(lons):                                  # north-south streets
        name = "Mock Grand Avenue" if k == 4 else f"Grid Avenue {k}"
        hw = "secondary" if k == 4 else "residential"
        way({"highway": hw, "name": name}, [(la, lo) for la in lats])
    way({"highway": "service", "name": "Depot Lane", "service": "driveway"},   # skipped: driveway
        [(s + 0.0003, w + 0.0003), (s + 0.0006, w + 0.0006)])
    way({"railway": "rail"}, [(lats[0], w + 0.0045), (lats[-1], w + 0.0045)])  # railway
    way({"waterway": "river", "name": "Mock River"}, [(lats[0], LON), (lats[-1], LON)])   # river through the middle
    lake = [(LAT - 0.0004, LON + 0.008), (LAT - 0.0004, LON + 0.0088),
            (LAT + 0.0004, LON + 0.0088), (LAT + 0.0004, LON + 0.008)]
    way({"natural": "water", "name": "Mock Lake"}, lake + [lake[0]])
    way({"leisure": "park"}, [(LAT + 0.002, LON - 0.008), (LAT + 0.002, LON - 0.006),
                              (LAT + 0.003, LON - 0.006), (LAT + 0.003, LON - 0.008),
                              (LAT + 0.002, LON - 0.008)])                       # park
    node(LAT + 0.0015, LON + 0.0015, {"amenity": "hospital", "name": "Mock General Hospital"})
    node(LAT - 0.0015, LON - 0.0015, {"amenity": "school", "name": "Mock School"})
    node(LAT - 0.001, LON + 0.002, {"amenity": "fire_station", "name": "Mock Fire Station"})
    node(LAT, LON, {"place": "suburb", "name": "Mock Nagar"})
    node(LAT + 0.0005, LON + 0.0005, {"shop": "bakery", "name": "Mock Bakery"})
    node(LAT - 0.0005, LON + 0.0006, {"amenity": "pharmacy", "name": "Mock Medicals"})
    node(LAT + 0.0008, LON - 0.0007, {"amenity": "cafe", "name": "Mock Cafe"})
    return els


BBOX_RE = re.compile(r"\((\d+\.\d+),(\d+\.\d+),(\d+\.\d+),(\d+\.\d+)\)")


@app.post("/overpass")
async def overpass(request: Request):
    form = await request.form()
    q = str(form.get("data", ""))
    m = BBOX_RE.search(q)
    if not m:
        return {"elements": []}
    s, w, n, e = (float(v) for v in m.groups())
    return {"elements": _streets(s, w, n, e)}


# ---------------------------------------------------------------- elevation
def _elev(lon, lat):
    """Smooth terrain: rises to the east, shallow valley along the river (LAT)."""
    valley = 4.0 * np.exp(-((lat - LAT) ** 2) / (2 * 0.0015 ** 2))
    return 10.0 + (lon - (LON - 0.012)) * 300.0 - valley


@app.get("/tiles/{z}/{x}/{y}.png")
def tile(z: int, x: int, y: int):
    n = 2 ** z
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (np.arange(256)[:, None] + y * 256) / (256 * n)))))
    lons = (x * 256 + np.arange(256))[None, :] / (256 * n) * 360.0 - 180.0
    elev = _elev(lons, lats)
    enc = np.clip(elev + 32768.0, 0, 65535)
    rgb = np.stack([np.floor(enc / 256), np.floor(enc) % 256, np.round((enc % 1) * 256)], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buf, format="PNG", optimize=False)
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"})


# ------------------------------------------------------------------ weather
@app.get("/meteo")
def meteo(latitude: float, longitude: float):
    times = [f"2026-11-1{d}T{h:02d}:00" for d in (3, 4, 5) for h in range(24)]
    precip = [0.0] * 48 + [5.0, 10.0, 20.0] + [0.0] * 21      # heavy rain 3 h ago, then dry
    return {
        "current": {"time": "2026-11-15T12:00", "temperature_2m": 27.5, "relative_humidity_2m": 88,
                    "precipitation": 0.0, "wind_speed_10m": 14.2, "wind_gusts_10m": 33.8},
        "hourly": {"time": times, "precipitation": precip},
    }


if __name__ == "__main__":
    import uvicorn
    print("  mock APIs on http://localhost:8001  (see tools/dev_mock_apis.py docstring for the app URL)")
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")
