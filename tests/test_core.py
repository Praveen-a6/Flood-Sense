"""Run:  python -m pytest -q"""
import json
import math
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from backend import physics, terrain
from backend.demo_city import build_demo_pack, demo_weather
from backend.features import FEATURE_NAMES, STATIC_FEATURES
from backend.geo import Grid, LocalProjection
from backend.pack_builder import _tile_xy, build_live_pack, decode_terrarium, parse_osm, sample_dem
from backend.weather import parse_open_meteo

ROOT = Path(__file__).resolve().parent.parent


# ------------------------------------------------------------- terrain
def test_priority_flood_fills_a_pit():
    z = np.full((9, 9), 5.0)
    z[4, 4] = 3.0                       # 2 m deep pit
    filled = terrain.priority_flood(z)
    assert filled[4, 4] == pytest.approx(5.0, abs=0.01)
    assert (filled - z)[0, 0] == pytest.approx(0.0, abs=1e-6)


def test_flow_goes_downhill_and_accumulates():
    y, x = np.mgrid[0:20, 0:20]
    z = x * 0.1 + 0.0                   # slopes down to the west (column 0)
    t = terrain.analyse(z.astype(float), 10.0, np.zeros(z.shape, bool), stream_cells=15)
    assert t["log_acc"][10, 0] > t["log_acc"][10, 19]
    assert t["hand"][10, 0] <= t["hand"][10, 19]


# ------------------------------------------------------------- physics
def _features(**over):
    base = {n: 0.0 for n in FEATURE_NAMES}
    base.update(elev_m=5, hand_m=0.5, log_flow_acc=2, impervious=0.7, dist_water_m=500, road_code=3)
    base.update(over)
    return base


def test_more_rain_never_less_water():
    depths = [physics.depth_cm(_features(rain_1h=r / 3, rain_3h=r, rain_24h=r, rain_72h=r)) for r in (0, 20, 60, 120)]
    assert all(b >= a for a, b in zip(depths, depths[1:]))
    assert depths[0] == 0


def test_underpass_floods_more_and_bridge_stays_dry():
    rain = dict(rain_1h=20, rain_3h=60, rain_24h=60, rain_72h=60)
    flat = physics.depth_cm(_features(**rain))
    under = physics.depth_cm(_features(underpass=1, **rain))
    bridge = physics.depth_cm(_features(bridge=1, **rain))
    assert under > flat > 0 and bridge == 0


# ---------------------------------------------------------- demo pack
def test_demo_pack_is_valid():
    pack = build_demo_pack(progress=lambda *_: None)
    assert pack["static_features"] == STATIC_FEATURES
    assert len(pack["segments"]) > 1000
    n = len(pack["nodes"])
    for s in pack["segments"][:200]:
        assert 0 <= s["a"] < n and 0 <= s["b"] < n
        assert len(s["f"]) == len(STATIC_FEATURES)
        assert s["len"] > 0
    assert any(s["f"][STATIC_FEATURES.index("underpass")] for s in pack["segments"])
    assert {p["type"] for p in pack["pois"]} >= {"hospital", "shelter"}
    assert pack["demo_trip"]["to_poi"] in {p["name"] for p in pack["pois"]}
    # v2: city pack split into 1 km flood-view tiles, with offline map labels
    assert pack["kind"] == "city" and pack["tiles"]["nx"] * pack["tiles"]["ny"] == 36
    assert all(0 <= s["t"] < 36 for s in pack["segments"])
    assert len(pack["tiles"]["bounds"]) == 36
    assert len(pack["places"]) >= 9 and len(pack["shops"]) >= 100
    assert all(s["name"] and s["cat"] for s in pack["shops"])
    json.dumps(pack)


def test_training_towns_unchanged_by_city_features():
    """The demo city got bigger and gained shops/area names; training towns must not change."""
    import hashlib
    from ml.synth_labels import town_static
    h = hashlib.md5()
    for s in (100, 105, 7):
        h.update(np.ascontiguousarray(town_static(s)).tobytes())
    assert h.hexdigest() == "50a011a024ba9421345f118513b95b9c"


def test_demo_weather_features_are_consistent():
    w = demo_weather()
    r = w["rain"]
    assert r["rain_1h"] <= r["rain_3h"] <= r["rain_24h"] <= r["rain_72h"]
    assert sum(w["hourly_past"][-3:]) == pytest.approx(r["rain_3h"], abs=0.1)


# --------------------------------------------------------- live builder
def test_terrarium_decoding():
    # elevation 10 m -> value 32778 -> R=128, G=10, B=0
    img = Image.fromarray(np.full((4, 4, 3), [128, 10, 0], dtype=np.uint8))
    assert decode_terrarium(img)[0, 0] == pytest.approx(10.0)


def test_sample_dem_with_fake_tiles():
    proj, grid = LocalProjection(13.0, 80.2), Grid.around(500, 50)
    calls = []

    def fake_tile(z, x, y):          # elevation rises to the east inside every tile
        calls.append((z, x, y))
        return np.tile(np.linspace(0, 25.5, 256), (256, 1))
    dem = sample_dem(proj, grid, tile_fetch=fake_tile)
    assert dem.shape == (grid.ny, grid.nx) and np.isfinite(dem).all() and len(calls) >= 1
    x, y = _tile_xy(13.0, 80.2, 14)
    assert 0 < x < 2 ** 14 and 0 < y < 2 ** 14


OSM_FIXTURE = {"elements": [
    {"type": "way", "tags": {"highway": "primary", "name": "Main Road"},
     "geometry": [{"lat": 13.0, "lon": 80.195}, {"lat": 13.0, "lon": 80.200}, {"lat": 13.0, "lon": 80.205}]},
    {"type": "way", "tags": {"highway": "residential", "name": "Cross St"},
     "geometry": [{"lat": 12.996, "lon": 80.200}, {"lat": 13.0, "lon": 80.200}, {"lat": 13.004, "lon": 80.200}]},
    {"type": "way", "tags": {"highway": "secondary", "name": "Subway", "tunnel": "yes", "layer": "-1"},
     "geometry": [{"lat": 13.0, "lon": 80.195}, {"lat": 13.002, "lon": 80.195}]},
    {"type": "way", "tags": {"highway": "service", "name": "Island Lane"},
     "geometry": [{"lat": 12.998, "lon": 80.204}, {"lat": 12.9982, "lon": 80.2043}]},
    {"type": "way", "tags": {"highway": "residential", "name": "One Way St", "oneway": "-1"},
     "geometry": [{"lat": 13.004, "lon": 80.200}, {"lat": 13.004, "lon": 80.203}]},
    {"type": "way", "tags": {"waterway": "canal"},
     "geometry": [{"lat": 12.995, "lon": 80.203}, {"lat": 13.005, "lon": 80.203}]},
    {"type": "node", "lat": 13.003, "lon": 80.201, "tags": {"amenity": "hospital", "name": "Test Hospital"}},
    {"type": "way", "tags": {"amenity": "school", "name": "Test School"},
     "geometry": [{"lat": 12.997, "lon": 80.198}, {"lat": 12.997, "lon": 80.1985}, {"lat": 12.9975, "lon": 80.1985}]},
    {"type": "node", "lat": 13.001, "lon": 80.199, "tags": {"place": "suburb", "name": "Test Nagar"}},
    {"type": "node", "lat": 13.0005, "lon": 80.2005, "tags": {"shop": "bakery", "name": "Test Bakery"}},
    {"type": "node", "lat": 12.9995, "lon": 80.2015, "tags": {"amenity": "pharmacy", "name": "Test Medicals"}},
]}


def test_parse_osm_fixture():
    out = parse_osm(OSM_FIXTURE, LocalProjection(13.0, 80.2))
    assert len(out["ways"]) == 5 and any(w["tunnel"] for w in out["ways"])
    ow = next(w for w in out["ways"] if w["name"] == "One Way St")
    assert ow["oneway"] and ow["xy"][0][0] > ow["xy"][-1][0]        # oneway=-1 is reversed
    assert {p["type"] for p in out["pois"]} == {"hospital", "shelter"}
    assert len(out["water_lines"]) == 1
    assert [p["name"] for p in out["places"]] == ["Test Nagar"]
    assert {"Test Bakery", "Test Medicals", "Test Hospital"} <= {p["name"] for p in out["shops"]}


def test_build_live_pack_end_to_end_with_mocks():
    def fake_tile(z, x, y):
        return np.random.default_rng(x + y).normal(8, 0.3, (256, 256))
    meteo = {"current": {"time": "2026-11-14T10:00", "temperature_2m": 25, "wind_speed_10m": 20,
                         "wind_gusts_10m": 40, "relative_humidity_2m": 90, "precipitation": 3},
             "hourly": {"time": [f"2026-11-{11 + h // 24:02d}T{h % 24:02d}:00" for h in range(96)],
                        "precipitation": [1.0] * 96}}
    pack = build_live_pack(13.0, 80.2, 0.6, osm_fetch=lambda *bb: OSM_FIXTURE, tile_fetch=fake_tile,
                           weather_fetch=lambda la, lo: parse_open_meteo(meteo), progress=lambda *_: None)
    assert len(pack["segments"]) >= 6
    names = {s["name"] for s in pack["segments"]}
    assert {"Main Road", "Cross St", "Subway"} <= names
    assert "Island Lane" not in names            # disconnected fragment pruned
    sub = [s for s in pack["segments"] if s["name"] == "Subway"]
    assert all(s["f"][STATIC_FEATURES.index("underpass")] == 1 for s in sub)
    # Main Road and Cross St share a junction node
    main = {n for s in pack["segments"] if s["name"] == "Main Road" for n in (s["a"], s["b"])}
    cross = {n for s in pack["segments"] if s["name"] == "Cross St" for n in (s["a"], s["b"])}
    assert main & cross
    assert pack["weather"]["rain"]["rain_3h"] == pytest.approx(3.0)
    assert pack["places"][0]["name"] == "Test Nagar"
    assert any(p["name"] == "Test Bakery" for p in pack["shops"])
    assert "tiles" in pack and all("t" in s for s in pack["segments"])


def test_open_meteo_parsing():
    js = {"current": {"time": "2026-11-14T05:15"},
          "hourly": {"time": [f"2026-11-14T{h:02d}:00" for h in range(24)], "precipitation": list(range(24))}}
    w = parse_open_meteo(js)
    assert w["rain"]["rain_1h"] == 5 and w["rain"]["rain_3h"] == 3 + 4 + 5
    assert w["rain"]["rain_fc_3h"] == 6 + 7 + 8


# ---------------------------------------------------------- model export
@pytest.mark.skipif(not (ROOT / "models" / "flood_model.json").exists(), reason="model not trained")
def test_exported_model_matches_lightgbm():
    import lightgbm as lgb
    from ml.train import predict_compact
    model = json.loads((ROOT / "models" / "flood_model.json").read_text())
    booster = lgb.Booster(model_file=str(ROOT / "models" / "flood_model.txt"))
    rng = np.random.default_rng(1)
    X = np.abs(rng.normal(5, 10, (50, len(FEATURE_NAMES))))
    assert np.abs(predict_compact(model, X) - booster.predict(X)).max() < 1e-4
    assert model["feature_names"] == FEATURE_NAMES


# ------------------------------------------------------------------ API
def test_api_catalog_streams_precompressed_pack_and_model():
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as c:
        cat = c.get("/api/catalog").json()
        assert cat["default"] == "demo-city" and cat["model"]["trees"] == 560
        assert cat["packs"][0]["default"] and cat["packs"][0]["kind"] == "city"
        r = c.get("/api/packs/default", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and r.headers["content-encoding"] == "gzip"
        assert int(r.headers["X-Pack-Bytes"]) == cat["packs"][0]["bytes"]
        pack = r.json()                                   # client decompresses transparently
        assert "model" not in pack and pack["segments"]   # model ships separately (/api/model)
        assert c.get("/api/model").json()["trees"]
        assert c.get("/api/metrics").json()["confusion_matrix"]["matrix"]
        assert c.get("/api/packs/nope").status_code == 404
        assert c.get("/api/build?lat=13&lon=80").status_code in (404, 405)   # no building from the browser


<<<<<<< HEAD
def test_api_overpass_relay(monkeypatch):
    """POST /api/overpass is the browser builder's last resort: it relays one
    Overpass QL query through this server's uplink, retries busy mirrors, and
    refuses to be anything else (not a general-purpose proxy)."""
    from fastapi.testclient import TestClient
    from backend import overpass as ov
    from backend.main import app

    calls = []

    class Response:
        def __init__(self, status_code=200, payload=None):
            self.status_code, self._payload = status_code, payload
        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")
        def json(self):
            return self._payload

    def fake_post(url, data=None, timeout=None, headers=None):
        calls.append(url)
        if "mirror-a" in url:
            return Response(504)                                     # busy -> next mirror
        if "mirror-b" in url:
            return Response(200, {"elements": [{"type": "node", "id": 5}]})
        raise RuntimeError("blocked")

    monkeypatch.setattr(ov, "MIRRORS", ["https://mirror-a.test/api", "https://mirror-b.test/api"])
    monkeypatch.setattr(ov.requests, "post", fake_post)

    with TestClient(app) as c:
        r = c.post("/api/overpass", json={"query": "[out:json][timeout:5];node(0,0,0.01,0.01);out count;"})
        assert r.status_code == 200 and r.json()["elements"][0]["id"] == 5
        assert calls == ["https://mirror-a.test/api", "https://mirror-b.test/api"]
        # not a general-purpose proxy - only Overpass QL for the fixed mirror list:
        assert c.post("/api/overpass", json={"query": "https://evil.example/"}).status_code == 400
        assert c.post("/api/overpass", json={"url": "https://evil.example/"}).status_code == 400
        assert c.post("/api/overpass", data="not json").status_code == 400
        assert c.post("/api/overpass", json={"query": "x" * 300000}).status_code == 400
        # every mirror dead -> 502 with one line per attempt
        def dead(url, **kw):
            raise RuntimeError("no route")
        monkeypatch.setattr(ov.requests, "post", dead)
        r = c.post("/api/overpass", json={"query": "[out:json];node(0);out;"})
        assert r.status_code == 502 and "mirror-a" in r.json()["detail"] and "mirror-b" in r.json()["detail"]


=======
>>>>>>> origin/main
def test_pack_store_index_default_and_delete(tmp_path, monkeypatch):
    from backend import pack_store
    monkeypatch.setattr(pack_store, "PACK_DIR", tmp_path)
    monkeypatch.setattr(pack_store, "INDEX", tmp_path / "index.json")
    monkeypatch.setattr(pack_store, "DEFAULT", tmp_path / "default.txt")
    pack = {"id": "city-x", "name": "X", "kind": "city", "version": 2, "segments": [{"id": 0}], "nodes": [],
            "pois": [{"type": "hospital"}], "center": [13, 80], "bbox": [0, 0, 1, 1], "model": {"big": 1}}
    e = pack_store.save_pack(pack)
    assert e["segments"] == 1 and e["hospitals"] == 1 and (tmp_path / "city-x.json.gz").exists()
    assert "model" not in json.loads((tmp_path / "city-x.json").read_text())       # never stored inside
    pack_store.set_default("city-x")
    assert pack_store.get_default() == "city-x"
    (tmp_path / "index.json").unlink()                                           # index lost -> rebuilt
    assert "city-x" in pack_store.load_index()["packs"]
    (tmp_path / "city-x.json").unlink()                                          # file deleted by hand
    assert "city-x" not in pack_store.load_index()["packs"]                      # stale entry dropped
    pack_store.save_pack(pack)
    assert pack_store.delete_pack("city-x") and not (tmp_path / "city-x.json.gz").exists()


def test_packs_cli_verify_demo_city():
    import packs
    from backend.demo_city import build_demo_pack
    assert packs.verify(build_demo_pack(progress=lambda *_: None)) == []
    broken = {"version": 1, "segments": [{"id": 0, "a": 0, "b": 5, "f": [1.0], "name": ""}], "nodes": [[0, 0]], "pois": []}
    probs = packs.verify(broken)
    assert any("old pack format" in p for p in probs) and any("missing junctions" in p for p in probs)
<<<<<<< HEAD


# ------------------------------------------------ browser-side city builder
def test_browser_city_builder_assets_exist_and_ship_offline():
    """First start builds any Indian city IN THE BROWSER, so these files must
    exist and be precached by the service worker (nothing is prepared server-side)."""
    js = ROOT / "frontend" / "js"
    for name in ("india_cities.js", "packlib.js", "cityengine.js", "cityworker.js", "citybuild.js"):
        assert (js / name).exists(), f"missing {name}"
        (js / name).read_text(encoding="utf-8")
    sw = (ROOT / "frontend" / "sw.js").read_text(encoding="utf-8")
    for name in ("india_cities.js", "packlib.js", "cityengine.js", "cityworker.js", "citybuild.js"):
        assert f"/js/{name}" in sw, f"service worker does not precache {name}"
    # the built-in catalogue really covers India
    import re
    cat = (js / "india_cities.js").read_text(encoding="utf-8")
    count = int(re.search(r"count: (\d+)", cat).group(1))
    assert count >= 1200, "city catalogue too small - regenerate: python tools/make_city_catalog.py"
    assert "GeoNames" in cat, "keep the GeoNames attribution (CC BY 4.0)"
=======
>>>>>>> origin/main
