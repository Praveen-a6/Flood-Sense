#!/usr/bin/env python3
"""Regenerate frontend/js/india_cities.js - the built-in catalogue of Indian cities.

The catalogue lets the app offer EVERY city and town in India on first start
(and the ones nearest to your GPS), with no server round-trip: the browser
builds the offline flood map itself (see js/cityengine.js).

Source: GeoNames cities5000 dump (https://download.geonames.org/export/dump/),
licence CC BY 4.0.  Kept: every place in India with population >= 20,000,
plus every district / division headquarters with population >= 5,000.

Run (downloads the dump once into tools/.cache, ~3 MB):
    python tools/make_city_catalog.py
"""
import datetime
import json
import pathlib
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "js" / "india_cities.js"
CACHE = ROOT / "tools" / ".cache"
URL = "https://download.geonames.org/export/dump/cities5000.zip"
ADMIN_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"

MIN_POP = 20_000            # keep every town with >= 20k people ...
ADMIN_MIN_POP = 5_000       # ... and every admin centre with >= 5k
ADMIN_CODES = {"PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLG", "PPLC"}


def clean_state(name: str) -> str:
    for prefix in ("State of ", "Union Territory of ", "National Capital Territory of "):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def fetch(url: str, path: pathlib.Path) -> pathlib.Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {url} ...")
        urllib.request.urlretrieve(url, path)          # noqa: S310 (public data dump)
    return path


def main() -> int:
    zf = fetch(URL, CACHE / "cities5000.zip")
    admin = fetch(ADMIN_URL, CACHE / "admin1CodesASCII.txt")
    states = {}
    for line in admin.read_text(encoding="utf-8").splitlines():
        code, name = line.split("\t")[:2]
        if code.startswith("IN."):
            states[code[3:]] = clean_state(name)

    with zipfile.ZipFile(zf) as z:
        rows = z.read("cities5000.txt").decode("utf-8").splitlines()

    seen = {}                       # (name, state) -> [name, state, lat, lon, pop]
    for line in rows:
        f = line.split("\t")
        country, admin1 = f[8], f[10]              # 8 = country code, 10 = admin1 code
        if country != "IN" or admin1 not in states:
            continue
        pop = int(f[14] or 0)
        is_admin = f[7] in ADMIN_CODES
        if not (pop >= MIN_POP or (is_admin and pop >= ADMIN_MIN_POP)):
            continue
        key = (f[2], states[admin1])              # same town mapped twice -> keep the bigger entry
        if key in seen and seen[key][4] >= pop:
            continue
        seen[key] = [f[2], states[admin1], float(f[4]), float(f[5]), pop]

    items = sorted(seen.values(), key=lambda e: (-e[4], e[0], e[1]))
    state_names = sorted({e[1] for e in items})
    sidx = {s: i for i, s in enumerate(state_names)}

    packed = ";".join(
        f"{name}|{sidx[state]}|{round(lat * 10000)}|{round(lon * 10000)}|{pop}"
        for name, state, lat, lon, pop in items)

    js = f"""// FloodSense built-in catalogue: every city and town in India.
// Pick any of these on first start and the app builds your whole-city offline
// flood map in the browser (OpenStreetMap + elevation + weather; js/cityengine.js).
//
// Source: GeoNames cities5000 dump, India subset (https://download.geonames.org),
// licence CC BY 4.0. Every place with population >= {MIN_POP:,}, plus every
// district/division HQ with >= {ADMIN_MIN_POP:,}. Regenerate: python tools/make_city_catalog.py
// {len(items):,} places · {len(state_names)} states/UTs · generated {datetime.date.today().isoformat()}

export const CATALOG = Object.freeze({{
  generated: "{datetime.date.today().isoformat()}",
  count: {len(items)},
  states: {json.dumps(state_names)},
  // "name|stateIndex|lat x 1e4|lon x 1e4|population", biggest city first
  data: {json.dumps(packed)},
}});

const _cities = CATALOG.data.split(";").map((row) => {{
  const [name, st, lat, lon, pop] = row.split("|");
  return {{ name, state: CATALOG.states[+st], lat: +lat / 10000, lon: +lon / 10000, pop: +pop }};
}});

export const CITIES = Object.freeze(_cities);
export const stateNames = CATALOG.states;

/** Cities of one state, biggest first (indices into CITIES). */
export function citiesInState(state, limit = 40) {{
  const out = [];
  for (let i = 0; i < CITIES.length && out.length < limit; i++) if (CITIES[i].state === state) out.push(i);
  return out;
}}

/** Free-text search over every city and town in India (name or state), indices into CITIES. */
export function searchCities(q, {{ limit = 12, state = null }} = {{}}) {{
  q = q.trim().toLowerCase();
  if (!q) return state ? citiesInState(state, limit) : CITIES.slice(0, limit).map((_, i) => i);
  const scored = [];
  for (let i = 0; i < CITIES.length; i++) {{
    const c = CITIES[i];
    if (state && c.state !== state) continue;
    const n = c.name.toLowerCase(), s = c.state.toLowerCase();
    const sc = n === q || s === q ? 4 : n.startsWith(q) || s.startsWith(q) ? 3 : n.includes(q) || s.includes(q) ? 2 : 0;
    if (sc) scored.push([sc, i]);
  }}
  scored.sort((a, b) => b[0] - a[0] || CITIES[b[1]].pop - CITIES[a[1]].pop);
  return scored.slice(0, limit).map(([, i]) => i);
}}

/** The k cities nearest to a lat/lon (indices into CITIES; adds a _d distance field). */
export function nearestCities(lat, lon, k = 8) {{
  const toR = Math.PI / 180, p1 = lat * toR;
  const scored = [];
  for (let i = 0; i < CITIES.length; i++) {{
    const c = CITIES[i], p2 = c.lat * toR, dl = (c.lon - lon) * toR, dp = p2 - p1;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    scored.push([2 * 6371000 * Math.asin(Math.sqrt(a)), i]);
  }}
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, k).map(([d, i]) => {{ CITIES[i]._d = d; return i; }});
}}

/** Map radius (km) suggested for a city of this size - the fallback when the admin
 * boundary can't be resolved; the real boundary wins whenever it can. */
export function cityRadiusKm(pop) {{
  return pop >= 5e6 ? 10 : pop >= 2e6 ? 8 : pop >= 1e6 ? 7 : pop >= 5e5 ? 6
    : pop >= 2e5 ? 5 : pop >= 1e5 ? 4.5 : pop >= 4e4 ? 4 : pop >= 2e4 ? 3.5 : 3;
}}

/** Index of the largest city of each state (anchor for state-region maps). */
export const STATE_ANCHORS = Object.freeze(CATALOG.states.map((s) => CITIES.findIndex((c) => c.state === s)));

/** URL-friendly pack id suffix, same rule as packs.py slug(). */
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pack";
"""
    OUT.write_text(js, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(items):,} places, {len(state_names)} states/UTs, "
          f"{OUT.stat().st_size / 1024:.0f} KB")
    print(f"  biggest: {items[0][0]} ({items[0][4]:,}) · smallest: {items[-1][0]} ({items[-1][4]:,})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
