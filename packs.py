"""FloodSense map-pack manager: build and manage city / area packs from the command line.

Phones never build maps. They download ready packs from the server (first start =
the default city, more packs optional). Packs are made here, once, with internet.

  python packs.py presets                                   list ready-made city presets
  python packs.py build --preset chennai-velachery --default
  python packs.py build --place "T. Nagar, Chennai" --radius-km 3
  python packs.py build --name "My Area" --lat 13.04 --lon 80.23 --radius-km 2 --kind area
  python packs.py list                                      packs on this server
  python packs.py info  <id>                                details of one pack
  python packs.py verify <id> | --all                       sanity-check packs
  python packs.py refresh-weather <id> | --all              update the weather snapshot
  python packs.py set-default <id>                          pack new devices download first
  python packs.py delete <id>
  python packs.py demo                                      rebuild the synthetic Demo City
  python packs.py reindex                                   rescan data/packs/ after copying files in

Building is resumable: OpenStreetMap chunks and elevation tiles are cached in data/cache/.
"""
import argparse
import math
import re
import sys
import time

import numpy as np

from backend import pack_store
from backend.features import STATIC_FEATURES

# Approximate centres; radius chosen to cover the dense core. Adjust freely.
PRESETS = {
    "chennai-central":   ("Chennai Central",   13.0827, 80.2707, 6.0),
    "chennai-velachery": ("Velachery, Chennai", 12.9791, 80.2209, 4.0),
    "chennai-tnagar":    ("T. Nagar, Chennai",  13.0418, 80.2341, 3.0),
    "chennai-tambaram":  ("Tambaram, Chennai",  12.9249, 80.1000, 4.0),
    "chennai-adyar":     ("Adyar, Chennai",     13.0012, 80.2565, 3.0),
    "coimbatore":        ("Coimbatore",         11.0168, 76.9558, 6.0),
    "madurai":           ("Madurai",             9.9252, 78.1198, 5.0),
    "bengaluru-central": ("Bengaluru Central",  12.9716, 77.5946, 6.0),
    "hyderabad-central": ("Hyderabad Central",  17.3850, 78.4867, 6.0),
    "mumbai-sion":       ("Sion, Mumbai",       19.0390, 72.8619, 4.0),
    "kochi":             ("Kochi",               9.9312, 76.2673, 5.0),
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "pack"


def geocode(place: str):
    import requests
    r = requests.get("https://nominatim.openstreetmap.org/search", timeout=20,
                     params={"q": place, "format": "json", "limit": 1},
                     headers={"User-Agent": "FloodSense-hackathon/1.0 (student project)"})
    r.raise_for_status()
    hits = r.json()
    if not hits:
        sys.exit(f"Place not found: {place!r}. Try --lat/--lon instead.")
    return float(hits[0]["lat"]), float(hits[0]["lon"]), hits[0].get("display_name", place)


# ------------------------------------------------------------------ commands
def cmd_presets(_):
    print(f"{'preset':20} {'name':22} {'lat':>9} {'lon':>9} {'radius':>7}")
    for k, (name, lat, lon, r) in PRESETS.items():
        print(f"{k:20} {name:22} {lat:9.4f} {lon:9.4f} {r:5.1f} km")
    print("\nBuild one:  python packs.py build --preset chennai-velachery --default")


def cmd_build(a):
    from backend.pack_builder import build_live_pack
    if a.preset:
        if a.preset not in PRESETS:
            sys.exit(f"Unknown preset {a.preset!r}. Run: python packs.py presets")
        name, lat, lon, radius = PRESETS[a.preset]
        radius = a.radius_km or radius
        pack_id = f"{a.kind}-{a.preset}"
    elif a.place:
        lat, lon, full = geocode(a.place)
        log(f"found {full} at {lat:.5f}, {lon:.5f}")
        name, radius, pack_id = a.name or a.place, a.radius_km or 3.0, f"{a.kind}-{slug(a.name or a.place)}"
    elif a.lat is not None and a.lon is not None:
        name, lat, lon, radius = a.name or f"Area {a.lat:.3f}, {a.lon:.3f}", a.lat, a.lon, a.radius_km or 3.0
        pack_id = f"{a.kind}-{slug(name)}"
    else:
        sys.exit("Give --preset, --place, or --lat and --lon (see: python packs.py presets)")
    name = a.name or name
    t0 = time.time()
    log(f"building {a.kind} pack '{name}' ({radius:g} km radius) -> {pack_id}")
    pack = build_live_pack(lat, lon, radius, name=name, kind=a.kind, pack_id=pack_id, progress=log,
                           **({"weather_fetch": lambda *_: None} if a.no_weather else {}))
    problems = verify(pack)
    entry = pack_store.save_pack(pack)
    if a.default:
        pack_store.set_default(pack_id)
    log(f"saved {pack_id}: {entry['segments']:,} road segments, {entry['shops']:,} shops, {entry['places']} area names, "
        f"{entry['hospitals']} hospitals, {entry['bytes'] / 1e6:.1f} MB ({entry['gz_bytes'] / 1e6:.1f} MB download) "
        f"in {time.time() - t0:.0f}s{'  [default]' if a.default else ''}")
    for p in problems:
        log(f"warning: {p}")


def cmd_demo(_):
    from backend.demo_city import build_demo_pack
    entry = pack_store.save_pack(build_demo_pack(progress=log))
    log(f"saved {entry['id']} ({entry['bytes'] / 1e6:.1f} MB)")


def cmd_list(_):
    idx = pack_store.load_index().get("packs", {})
    default = pack_store.get_default()
    if not idx:
        print("No packs yet. Run: python packs.py demo   or   python packs.py build --preset ...")
        return
    print(f"  {'id':30} {'kind':5} {'roads':>8} {'shops':>6} {'download':>9}  built")
    for pid, e in sorted(idx.items(), key=lambda kv: kv[1]["name"]):
        mark = "*" if pid == default else " "
        print(f"{mark} {pid:30} {e['kind']:5} {e['segments']:>8,} {e['shops']:>6,} {e['gz_bytes'] / 1e6:>7.1f}MB  {e['created_at']}")
    print("\n* = default (downloaded automatically on first start)")


def load(pid):
    import json
    p = pack_store.pack_path(pid, gz=False)
    if not p.exists():
        sys.exit(f"No pack {pid!r}. See: python packs.py list")
    return json.loads(p.read_text(encoding="utf-8"))


def cmd_info(a):
    e = pack_store.load_index()["packs"].get(a.id)
    if not e:
        sys.exit(f"No pack {a.id!r}")
    for k, v in e.items():
        print(f"{k:12} {v}")


def verify(pack) -> list:
    """Returns a list of problems (empty = good)."""
    probs = []
    segs, nodes = pack.get("segments", []), pack.get("nodes", [])
    if pack.get("version", 1) < 2:
        probs.append("old pack format (v1): rebuild for tiles, names and shops")
    if not segs:
        return probs + ["no road segments"]
    nf = len(STATIC_FEATURES)
    bad = [s["id"] for s in segs if len(s["f"]) != nf or not all(map(math.isfinite, s["f"]))]
    if bad:
        probs.append(f"{len(bad)} segments with missing/invalid features")
    if any(not (0 <= s["a"] < len(nodes) and 0 <= s["b"] < len(nodes)) for s in segs):
        return probs + ["segments point at missing junctions (pack is corrupt: rebuild it)"]
    tl = pack.get("tiles")
    if tl and (len(tl["bounds"]) != tl["nx"] * tl["ny"] or any(not 0 <= s.get("t", 0) < tl["nx"] * tl["ny"] for s in segs)):
        probs.append("tile index out of range")
    # connectivity: share of segments in the biggest connected network
    parent = list(range(len(nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for s in segs:
        parent[find(s["a"])] = find(s["b"])
    from collections import Counter
    comp = Counter(find(s["a"]) for s in segs)
    share = comp.most_common(1)[0][1] / len(segs)
    if share < 0.8:
        probs.append(f"road network is fragmented: biggest connected part has only {share:.0%} of roads")
    if not any(p["type"] == "hospital" for p in pack.get("pois", [])):
        probs.append("no hospitals found (the 'Nearest hospital' button won't work)")
    if not pack.get("weather"):
        probs.append("no weather snapshot (run: python packs.py refresh-weather <id>)")
    unnamed = np.mean([not s["name"] for s in segs])
    if unnamed > 0.6:
        probs.append(f"{unnamed:.0%} of roads have no name: directions will say 'unnamed road'")
    return probs


def cmd_verify(a):
    ids = list(pack_store.load_index().get("packs", {})) if a.all else [a.id]
    bad = 0
    for pid in ids:
        probs = verify(load(pid))
        print(f"{'OK  ' if not probs else 'WARN'} {pid}")
        for p in probs:
            print(f"     - {p}")
        bad += bool(probs)
    sys.exit(1 if bad and not a.all else 0)


def cmd_refresh_weather(a):
    from backend.weather import fetch_weather
    ids = [pid for pid, e in pack_store.load_index().get("packs", {}).items() if not e["synthetic"]] if a.all else [a.id]
    for pid in ids:
        pack = load(pid)
        try:
            pack["weather"] = fetch_weather(*pack["center"])
            pack["data_as_of"] = pack["weather"]["as_of"]
            pack_store.save_pack(pack)
            r = pack["weather"]["rain"]
            log(f"{pid}: rain last 3 h {r['rain_3h']} mm, 24 h {r['rain_24h']} mm")
        except Exception as ex:
            log(f"{pid}: weather failed ({ex})")


def cmd_set_default(a):
    try:
        pack_store.set_default(a.id)
    except KeyError:
        sys.exit(f"No pack {a.id!r}")
    log(f"default pack is now {a.id}")


def cmd_delete(a):
    log(("deleted " if pack_store.delete_pack(a.id) else "no such pack ") + a.id)


def cmd_reindex(_):
    idx = pack_store.rebuild_index()
    log(f"index rebuilt: {len(idx['packs'])} packs")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("presets").set_defaults(fn=cmd_presets)
    b = sub.add_parser("build", help="build a pack from OpenStreetMap + elevation + weather")
    b.add_argument("--preset"); b.add_argument("--place"); b.add_argument("--name")
    b.add_argument("--lat", type=float); b.add_argument("--lon", type=float)
    b.add_argument("--radius-km", type=float)
    b.add_argument("--kind", choices=["city", "area"], default="city")
    b.add_argument("--default", action="store_true", help="download this pack automatically on first start")
    b.add_argument("--no-weather", action="store_true")
    b.set_defaults(fn=cmd_build)
    sub.add_parser("demo").set_defaults(fn=cmd_demo)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    sub.add_parser("reindex").set_defaults(fn=cmd_reindex)
    for name, fn in (("info", cmd_info), ("set-default", cmd_set_default), ("delete", cmd_delete)):
        c = sub.add_parser(name); c.add_argument("id"); c.set_defaults(fn=fn)
    for name, fn in (("verify", cmd_verify), ("refresh-weather", cmd_refresh_weather)):
        c = sub.add_parser(name); c.add_argument("id", nargs="?"); c.add_argument("--all", action="store_true"); c.set_defaults(fn=fn)
    a = ap.parse_args()
    if a.cmd in ("verify", "refresh-weather") and not a.all and not a.id:
        ap.error(f"{a.cmd}: give a pack id or --all")
    a.fn(a)


if __name__ == "__main__":
    main()
