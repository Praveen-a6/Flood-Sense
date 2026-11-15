"""Synthetic 'Demo Town' so the app works with zero internet.

A 3 km x 3 km town with a river, a lake, a railway underpass, a low-lying
colony, hills, hospitals and relief shelters. The terrain is made up, but it
goes through exactly the same pipeline as a real OpenStreetMap area.

The same generator (different seeds) also produces training towns for
ml/synth_labels.py.
"""
import math
import time

import numpy as np

from .geo import Grid, LocalProjection
from .pack_core import build_pack

ROW_NAMES = ["Kamarajar Street", "Bharathi Nagar 1st St", "Bharathi Nagar 2nd St", "Pillaiyar Koil St",
             "Thiruvalluvar St", "Market Road", "Lake Main Road", "Nehru Street", "Mariamman Koil St",
             "Station Road", "Anna Street", "Periyar Street", "Ganga Nagar St", "Railway Feeder Road",
             "Vivekananda St", "Kaveri Street", "Teachers Colony St", "Rajaji Street", "Bazaar Street",
             "Cross Street", "Indira Nagar St", "Annai Theresa St"]
COL_NAMES = ["Bay View Road", "Velan Street", "Muthu Street", "Temple Road", "Gandhi Salai",
             "Ambedkar Street", "Sathya Nagar St", "Senthil Street", "Kalaignar St", "Thendral St",
             "Mullai Street", "Valluvar Avenue", "Hospital Road", "Ponni Street", "Sundar Street",
             "Lotus Street", "Arasu Street", "Nethaji Street", "Coastal Road", "Kurinji Street",
             "Maruthi Street", "Selvam Street"]


def _street_name(names, i):
    # names are labels only (never model features); extra rows in big cities get a suffix
    base = names[i % len(names)]
    return base if i < len(names) else f"{base} {['Extension', 'East', 'West', 'North'][(i // len(names)) % 4]}"


def _river_x(y, seed_shift=0.0):
    return -500 + 220 * np.sin(y / 400.0 + seed_shift)


def make_town(seed: int = 7, half: float = 1500.0, res: float = 10.0):
    rng = np.random.default_rng(seed)
    grid = Grid.around(half, res)
    X, Y = grid.cell_centres()
    shift = rng.uniform(-1, 1) if seed != 7 else 0.0
    xr = _river_x(Y, shift)

    lake_c = (450.0, -650.0) if seed == 7 else (rng.uniform(-800, 800), rng.uniform(-1000, 1000))
    colony_c = (450.0, 200.0) if seed == 7 else (rng.uniform(-900, 900), rng.uniform(-900, 900))
    hill_c = (-900.0, 800.0) if seed == 7 else (rng.uniform(-1200, 1200), rng.uniform(-1200, 1200))
    tilt = 0.0015 if seed == 7 else rng.uniform(0.0005, 0.003)

    z = 8.0 - tilt * X
    z += (7 if seed == 7 else rng.uniform(2, 9)) * np.exp(-((X - hill_c[0]) ** 2 + (Y - hill_c[1]) ** 2) / (2 * 450 ** 2))
    z += -3.0 * np.exp(-((X - xr) ** 2) / (2 * 40 ** 2)) - 1.2 * np.exp(-((X - xr) ** 2) / (2 * 200 ** 2))
    z += -4.5 * np.exp(-((X - lake_c[0]) ** 2 + (Y - lake_c[1]) ** 2) / (2 * 230 ** 2))
    z += -(1.6 if seed == 7 else rng.uniform(0.8, 2.2)) * np.exp(-((X - colony_c[0]) ** 2 + (Y - colony_c[1]) ** 2) / (2 * 180 ** 2))
    for _ in range(8):
        cx, cy = rng.uniform(-half, half, 2)
        z += -rng.uniform(0.4, 1.0) * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * rng.uniform(45, 85) ** 2))
    for _ in range(3):
        a, b, p = rng.uniform(150, 600), rng.uniform(150, 600), rng.uniform(0, 6.28)
        z += 0.3 * np.sin(X / a + p) * np.cos(Y / b)

    river_mask = np.abs(X - xr) < 15
    lake_r = np.hypot(X - lake_c[0], Y - lake_c[1])
    lake_mask = lake_r < 200
    water_mask = river_mask | lake_mask

    urban = 0.85 * np.exp(-(X ** 2 + Y ** 2) / (2 * 1100 ** 2)) + 0.1
    hill = np.exp(-((X - hill_c[0]) ** 2 + (Y - hill_c[1]) ** 2) / (2 * 400 ** 2))
    imperv = np.clip(urban - 0.45 * hill, 0.08, 0.92)
    imperv[water_mask] = 0.0

    # ---------------- roads on a jittered lattice ----------------
    step = 155.0
    coords = np.arange(-half + 100, half - 99, step)
    n = len(coords)
    P = np.zeros((n, n, 2))
    for r in range(n):
        for c in range(n):
            P[r, c] = (coords[c] + rng.uniform(-25, 25), coords[r] + rng.uniform(-25, 25))
    rail_x = 300.0 if seed == 7 else rng.uniform(-600, 900)
    if half == 1500:   # training towns + original layout (unchanged)
        art_rows = {6: "primary", 13: "primary", 9: "tertiary"}
        art_cols = {4: "secondary", 12: "secondary"}
    else:              # bigger demo city: an arterial every ~7 blocks
        art_rows = {r: ("primary" if (r // 7) % 2 == 0 else "tertiary") for r in range(6, n, 7)}
        art_cols = {c: "secondary" for c in range(4, n, 8)}

    def crosses_river(p, q):
        return (p[0] - _river_x(p[1], shift)) * (q[0] - _river_x(q[1], shift)) < 0

    def in_lake(p, q):
        m = (p + q) / 2
        return math.hypot(m[0] - lake_c[0], m[1] - lake_c[1]) < 215

    ways = []

    def add_line(points_idx, name, hw, horizontal):
        cur = []
        flags = {}
        for (r1, c1), (r2, c2) in zip(points_idx[:-1], points_idx[1:]):
            p, q = P[r1, c1], P[r2, c2]
            major = hw in ("primary", "secondary", "tertiary")
            drop = in_lake(p, q) or (not major and rng.random() < 0.10)
            bridge = crosses_river(p, q)
            if bridge and not major and rng.random() < 0.6:
                drop = True
            rail = horizontal and (p[0] - rail_x) * (q[0] - rail_x) < 0
            if rail and not major:
                drop = True
            if drop:
                if len(cur) > 1:
                    ways.append({"name": name, "highway": hw, "xy": cur, **flags})
                cur, flags = [], {}
                continue
            if bridge or rail:
                if len(cur) > 1:
                    ways.append({"name": name, "highway": hw, "xy": cur})
                if rail:   # split the link so only ~70 m around the tracks is the underpass
                    t = (rail_x - p[0]) / (q[0] - p[0])
                    a = p + (q - p) * max(0.0, t - 35 / step)
                    b = p + (q - p) * min(1.0, t + 35 / step)
                    ways.append({"name": name, "highway": hw, "xy": [tuple(p), tuple(a)]})
                    ways.append({"name": name, "highway": hw, "xy": [tuple(a), tuple(b)], "tunnel": True})
                    ways.append({"name": name, "highway": hw, "xy": [tuple(b), tuple(q)]})
                else:
                    ways.append({"name": name, "highway": hw, "xy": [tuple(p), tuple(q)], "bridge": True})
                cur, flags = [tuple(q)], {}
                continue
            if not cur:
                cur = [tuple(p)]
            cur.append(tuple(q))
        if len(cur) > 1:
            ways.append({"name": name, "highway": hw, "xy": cur, **flags})

    for r in range(n):
        add_line([(r, c) for c in range(n)], _street_name(ROW_NAMES, r), art_rows.get(r, "residential"), True)
    for c in range(n):
        add_line([(r, c) for r in range(n)], _street_name(COL_NAMES, c), art_cols.get(c, "residential"), False)

    ys = np.linspace(-half, half, 120)
    river_xy = [(float(_river_x(y, shift)), float(y)) for y in ys]
    ang = np.linspace(0, 2 * np.pi, 40)
    lake_xy = [(lake_c[0] + 200 * math.cos(a) * (1 + 0.06 * math.sin(3 * a)),
                lake_c[1] + 200 * math.sin(a) * (1 + 0.06 * math.cos(2 * a))) for a in ang]
    rail_xy = [(rail_x, -half), (rail_x, half)]
    water_geoms = [{"kind": "river", "xy": river_xy}, {"kind": "lake", "xy": lake_xy},
                   {"kind": "rail", "xy": rail_xy}]

    hotspots = [tuple(np.mean(w["xy"], axis=0)) for w in ways if w.get("tunnel")]
    hotspots += [colony_c, (lake_c[0], lake_c[1] + 270)]
    pois = [
        {"name": "Government General Hospital", "type": "hospital", "x": hill_c[0] + 200, "y": hill_c[1] - 200},
        {"name": "Lakeview Multispeciality Hospital", "type": "hospital", "x": lake_c[0] - 50, "y": lake_c[1] + 290},
        {"name": "Sri Ramana Clinic", "type": "hospital", "x": colony_c[0] - 60, "y": colony_c[1] + 40},
        {"name": "Corporation School (Relief Camp)", "type": "shelter", "x": -300.0, "y": -200.0},
        {"name": "Community Hall Shelter", "type": "shelter", "x": 900.0, "y": 800.0},
        {"name": "Fire & Rescue Station", "type": "emergency", "x": -1000.0, "y": -900.0},
    ]
    return dict(grid=grid, z=z, water_mask=water_mask, impervious=imperv, ways=ways,
                water_geoms=water_geoms, hotspots=hotspots, pois=pois)


def demo_weather(as_of: str | None = None) -> dict:
    """A canned monsoon-storm weather snapshot for the demo (clearly labelled)."""
    hourly = [0.0] * 72
    for h in range(0, 24):        # 3 days ago .. 2 days ago: 20 mm
        hourly[h] = 20 / 24
    for h in range(24, 48):       # 2 days ago .. yesterday: 45 mm
        hourly[h] = 45 / 24
    for h in range(48, 69):       # last 24 h, excluding last 3 h: 62 mm
        hourly[h] = 62 / 21
    hourly[69], hourly[70], hourly[71] = 14.0, 16.0, 18.0   # last 3 h: 48 mm
    as_of = as_of or time.strftime("%Y-%m-%dT%H:00")
    return {
        "source": "Sample monsoon storm (demo data, not live)",
        "as_of": as_of,
        "current": {"temp_c": 24.1, "wind_kmh": 34.0, "gust_kmh": 58.0, "humidity": 96, "precip_mm": 18.0},
        "rain": {"rain_1h": 18.0, "rain_3h": 48.0, "rain_24h": 110.0, "rain_72h": 175.0, "rain_fc_3h": 12.0},
        "hourly_past": [round(v, 2) for v in hourly],
        "hourly_next": [5.0, 4.0, 3.0] + [1.0] * 21,
    }


AREA_NAMES = ["Gandhi Nagar", "Lake View Nagar", "Station Colony", "Anna Nagar West", "Periyar Nagar",
              "Kaveri Colony", "Bharathi Puram", "Thiruvalluvar Nagar", "Indira Nagar", "Teachers Colony",
              "Rajaji Puram", "Velan Nagar", "Ponni Garden", "Kurinji Nagar", "Mullai Colony", "Marutham Nagar"]
SHOP_PREFIX = ["Sri Ganesh", "Lakshmi", "Annai", "Murugan", "Kumaran", "Selvi", "Raja", "Vel", "Balaji",
               "Saravana", "Meenakshi", "Karpagam", "Arul", "Thangam", "Senthil", "Kavitha", "Jothi", "Sakthi"]
SHOP_KINDS = [("Stores", "supermarket"), ("Medicals", "pharmacy"), ("Bakery", "bakery"), ("Hotel", "restaurant"),
              ("Tea Stall", "cafe"), ("Textiles", "clothes"), ("Hardware", "hardware"), ("Mobiles", "mobile_phone"),
              ("Fancy Store", "variety_store"), ("Petrol Bunk", "fuel"), ("Bank ATM", "atm"), ("Temple", "place_of_worship"),
              ("Vegetables", "greengrocer"), ("Saloon", "hairdresser"), ("Electricals", "electrical")]


def city_extras(town: dict, half: float, seed: int = 7) -> dict:
    """Area names, named shops and extra hospitals/shelters for the demo city.
    Uses its own random generator, so it never changes the training towns."""
    rng = np.random.default_rng(seed + 1000)
    places, k = [], 0
    blocks = max(1, int(round(2 * half / 1500)))
    step = 2 * half / blocks
    for bi in range(blocks):
        for bj in range(blocks):
            places.append({"name": AREA_NAMES[k % len(AREA_NAMES)], "kind": "suburb",
                           "x": -half + (bj + 0.5) * step + rng.uniform(-120, 120),
                           "y": -half + (bi + 0.5) * step + rng.uniform(-120, 120)})
            k += 1
    shops = []
    res_ways = [w for w in town["ways"] if not w.get("tunnel") and not w.get("bridge")]
    for _ in range(int(60 * (half / 1500) ** 2)):
        w = res_ways[rng.integers(len(res_ways))]
        a = rng.integers(len(w["xy"]) - 1)
        (x1, y1), (x2, y2) = w["xy"][a], w["xy"][a + 1]
        t = rng.uniform(0.2, 0.8)
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1
        side = rng.choice([-1, 1]) * 14
        label, cat = SHOP_KINDS[rng.integers(len(SHOP_KINDS))]
        shops.append({"name": f"{SHOP_PREFIX[rng.integers(len(SHOP_PREFIX))]} {label}", "cat": cat,
                      "x": x1 + dx * t - dy / L * side, "y": y1 + dy * t + dx / L * side})
    pois = list(town["pois"])
    if half > 1500:
        pois += [
            {"name": "Coastal Road Government Hospital", "type": "hospital", "x": 2200.0, "y": -1700.0},
            {"name": "North Zone Primary Health Centre", "type": "hospital", "x": -1900.0, "y": 2300.0},
            {"name": "Annai Children's Hospital", "type": "hospital", "x": 1600.0, "y": 2100.0},
            {"name": "Panchayat Union School (Relief Camp)", "type": "shelter", "x": -2300.0, "y": -2200.0},
            {"name": "Kalyana Mandapam Relief Centre", "type": "shelter", "x": 2400.0, "y": 600.0},
        ]
    return {"places": places, "shops": shops, "pois": pois}


DEMO_HALF = 3000.0   # 6 km x 6 km demo city = 36 flood-view tiles of 1 km


def build_demo_pack(progress=print) -> dict:
    town = make_town(seed=7, half=DEMO_HALF)
    extra = city_extras(town, DEMO_HALF)
    proj = LocalProjection(12.9800, 80.2200)
    pack = build_pack(
        pack_id="demo-city", name="Demo City (synthetic terrain)", proj=proj,
        grid=town["grid"], z=town["z"], water_mask=town["water_mask"], ways=town["ways"],
        pois=extra["pois"], hotspots=town["hotspots"], water_geoms=town["water_geoms"],
        impervious=town["impervious"], weather=demo_weather(), synthetic=True, kind="city",
        places=extra["places"], shops=extra["shops"],
        notes="Made-up terrain, streets and shops placed near Chennai for demo purposes. "
              "Build a real city pack (README) for real OpenStreetMap data.",
        progress=progress,
    )
    pack["demo_trip"] = DEMO_TRIP
    return pack


# one-click presentation scenario (set after inspecting the generated city):
# the shortest way to the hospital runs through flooded streets; the safe route goes around
DEMO_TRIP = {"from": [12.983631, 80.223278], "from_label": "Home (Station Road area)",
             "to_poi": "Government General Hospital", "rain": "poured heavily for 3 hours",
             "mode": "walk_child"}
