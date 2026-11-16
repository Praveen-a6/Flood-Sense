# FloodSense 🌧️🧭

### *Google Maps tells you the fastest route. FloodSense tells you the safest one, even with no internet.*

**An offline-first AI navigator that predicts how deep the water is on every street, then routes you around it: on foot, on a two-wheeler, or in an ambulance.**

> 🏆 Built in 10 hours · Problem statement: **Smart Cities & Sustainability** · Free data only, no API keys, no GPU, no server needed at the moment of the flood

![FloodSense demo: the shortest path to the hospital (purple) crosses 14 flooded stretches; the safe route (blue) goes around](docs/screenshot-demo-route.png)

| Live navigation (simulated drive) | On a phone |
|---|---|
| ![Turn-by-turn navigation with GPS arrow](docs/screenshot-navigation.png) | ![Mobile navigation](docs/screenshot-mobile.png) |

---

## ⚡ The pitch

When it floods, the **shortest road is often the deadliest one**: it dips through an underpass or a low-lying colony. Navigation apps show traffic, not water depth. And **mobile data is the first thing to fail** in heavy rain.

FloodSense fixes both:

1. **Download once.** On first start it uses your GPS to build a 10 × 10 km map of your surroundings (roads, street names, shops, terrain, weather) directly in your browser and saves it on the device.
2. **Predict depth on every road.** A tiny AI model (220 KB) runs on the phone and estimates water depth for each road segment in about 100 ms.
3. **Navigate safely.** Flood-aware A\* avoids water that is too deep *for how you travel*, then guides you turn by turn with a GPS arrow, voice prompts and automatic re-routing.
4. **No internet needed.** Map, AI, routing and voice all run on the device.

---

## 🆚 Why not just use Google Maps?

| | Google Maps | **FloodSense** |
|---|---|---|
| Fastest route | ✅ | ✅ |
| Predicts **water depth** per street | ❌ | ✅ 4 depth classes, every road |
| Route depends on **who is travelling** (child on foot, bike, ambulance) | ❌ | ✅ 15 cm vs 30 cm limits |
| Works with **no mobile data** | Partly (downloaded maps, no flood info) | ✅ Fully: map, AI, routing, voice |
| Understands "**it poured for 3 hours**" or **கனமழை 3 மணி நேரம்** | ❌ | ✅ English, Tamil, Tanglish |
| **Explains** why a road is risky | ❌ | ✅ Tap any road for probabilities and reasons |
| Nearest hospital you can **actually reach** | Nearest by time | ✅ Fastest *safe* hospital |

---

## Contents

1. [The problem](#the-problem)
2. [What FloodSense does](#what-floodsense-does)
3. [Architecture](#architecture)
4. [How the AI works](#how-the-ai-works)
5. [City packs, flood view, places and navigation](#city-packs-flood-view-places-and-navigation)
6. [Data sources](#data-sources)
7. [Tech stack](#tech-stack)
8. [Run it locally](#run-it-locally)
9. [3-minute demo script](#3-minute-demo-script)
10. [Using a real city, a phone, and your own data](#using-a-real-city-a-phone-and-your-own-data)
11. [API](#api)
12. [Project structure](#project-structure)
13. [How we built it in 10 hours](#how-we-built-it-in-10-hours)
14. [Limitations, safety and what's next](#limitations-safety-and-whats-next)

---

## The problem

It's pouring outside. Someone at home needs a hospital *now*, or you have to carry a child to safety.

- You don't know **which streets are under water** right now. Navigation apps show traffic, not flood depth.
- The **shortest road is often the worst one**: it can dip through an underpass or a low-lying colony.
- During heavy rain and floods, **mobile data is the first thing to fail**.
- Ordinary people can't say "62 mm of rain". They say *"it poured for 3 hours"* or *"romba mazhai"*.

Cities like Chennai have lived this repeatedly (Dec 2015, Nov 2021, Dec 2023). People need a tool that works **at the moment of the flood**, on the phone already in their pocket.

---

## What FloodSense does

| | Feature |
|---|---|
| ⬇️ | **Nearby map built once in the browser** from GPS (10 × 10 km), then cached on-device. Published city packs remain optional downloads |
| 🗺️ | **Flood map:** every road coloured by predicted depth: dry, 5–15 cm, 15–30 cm, over 30 cm. **Flood view** covers **3×3 km**, **5×5 km**, or the full downloaded area |
| 🏷️ | **Street, shop and area names offline**, drawn from the pack itself with no tile server |
| 🔎 | **Offline search** over streets, shops, areas, hospitals and your saved places |
| 🏠 | **Saved places:** Home, Work and named favourites ("Amma's house") for one-tap routes |
| 🧭 | **Safe route vs shortest path:** the shortest path is **purple** with ⚠ pins on every flooded stretch. Switch focus between Both, Safe and Shortest |
| ▶️ | **Real navigation:** GPS arrow, follow camera, next-turn banner, voice at 200 m and at the turn, "shallow water ahead" warnings, **automatic re-route**, arrival. **Simulate** mode lets you demo it on a laptop |
| 🚶 🛵 🚑 | **Travel modes:** walking with a child or elderly person and two-wheelers avoid water over ~15 cm; cars and ambulances avoid water over ~30 cm |
| 🏥 | **Nearest hospital** button: picks the hospital that is *fastest to reach safely*, not the closest |
| ✍️ | **Rain in your own words:** "12 cm in 2 days", "poured heavily for 3 hours, then drizzled", **கனமழை 3 மணி நேரம்**, "romba mazhai 2 mani neram" |
| 📴 | **Fully offline** after one download: map, AI model, routing and voice run on the device |
| 🌦️ | **Live weather** while online: rain for the past 72 h + next 24 h, wind, gusts, temperature, humidity |
| ❓ | **Explainable:** tap any road to see depth probabilities and *why* (e.g. "underpass · 1.8 m lower than surroundings · 60 mm in last 3 h") |
| 🏞️ | **Dam/lake release** switch: adds risk to low ground near rivers and lakes |
| 📊 | **Model performance card:** accuracy, F1, missed deep roads, confusion matrix and feature importance, shipped inside the pack so it works offline |

---

## Architecture

![FloodSense architecture](docs/architecture.png)

*(Editable source: [`docs/architecture.svg`](docs/architecture.svg))*

**Key design decision:** the AI **predicts flood depth per road segment**, and a normal **A\* search** picks the route. An LLM is *not* used for routing: it would be slow, impossible to verify, and could invent roads. The tree model is small (220 KB), runs in the browser in under 100 ms for ~2,500 roads, and every result can be explained.

**Flow**

1. **Phone, first online start:** after the user grants GPS permission, a browser worker downloads OpenStreetMap roads and elevation tiles directly from their public providers, computes terrain and flood features, fetches weather, and stores the resulting **10 × 10 km** map in **IndexedDB**. No prebuilt city pack is needed.
2. **Optional server packs:** `python packs.py build …` can still prepare additional maps for the Maps tab. The FastAPI backend also serves the app and AI model; the service worker caches the app shell.
3. **Phone, offline, every time:** rain comes from cached weather or the user's own words. The on-device model predicts the depth class for every road in the **flood view**. Roads outside it are predicted **lazily**, only when A\* explores them. Then flood-aware A\* → map → live turn-by-turn navigation.

---

## How the AI works

### 1. Features (per road segment, ≤ 40 m)

| Static: computed once, while building the map | Dynamic: from weather or user input |
|---|---|
| `elev_m`: ground elevation | `rain_1h`, `rain_3h`, `rain_24h`, `rain_72h` |
| `rel_elev_300m`: height vs the 300 m neighbourhood (negative = low spot) | `rain_fc_3h`: forecast for the next 3 h |
| `depression_m`: how deep water ponds before it spills (priority-flood sink fill) | `reservoir_release`: upstream dam/lake release |
| `hand_m`: Height Above Nearest Drainage | |
| `log_flow_acc`: how much upstream area drains through here (D8) | |
| `slope_deg`, `impervious` (sealed-surface share), `dist_water_m` | |
| `underpass`, `bridge`, `road_code` (major → minor), `hotspot_100m` | |

### 2. Model

- **LightGBM multiclass classifier**, 4 depth classes, 140 rounds × 4 classes = 560 small trees.
- Exported to compact JSON (`models/flood_model.json`, **220 KB**) and run **in plain JavaScript** (`frontend/js/model.js`). No GPU, no ONNX runtime, no internet. `ml/train.py` checks the export against LightGBM itself (max difference ~2e-6).
- Optional ONNX export for a future native app: `python -m ml.export_onnx`.
- If the model file is missing, the app falls back to the **physics rule** below (same inputs, same colours).

### 3. Training labels (honest version)

Almost no city publishes "water depth on this street at this time". So for the hackathon:

1. **10 synthetic towns** with random terrain, rivers, lakes, low colonies, railway underpasses and street grids
2. × **60 rain scenarios** each (dry → extreme, plus dam releases)
3. labelled by a **transparent water-balance rule** (`backend/physics.py`): effective rain × runoff − drain capacity, × water convergence × lowness, + depression ponding, + extra for underpasses, river overflow, dam release and known hotspots
4. with **±30% random noise**, because real streets are messier than any rule

Any **real labels** you add (`ml/labels/real_labels.csv`) are mixed in with 3× weight. That's the path from demo to production.

**Hold-out results** on the original 3×3 km Demo Town (seed 7), never seen in training (102,680 road × scenario rows, `models/metrics.json`):

| Metric | Value |
|---|---|
| Accuracy | **92.4%** |
| Macro F1 (4 classes) | **0.79** |
| Deep/impassable roads missed **at the routing threshold** (block if P(≥15 cm) ≥ 40%) | **10.0%** |
| Dry roads wrongly blocked | **0.0%** |
| Most important features | rain 24 h, HAND, rain 72 h, rain 3 h, distance to water, depression depth |

> These scores measure how well the model learned the physics rule plus noise. They do **not** measure real-world accuracy. Real labels are needed for that (see [Limitations](#limitations-safety-and-whats-next)).

### 4. Routing

Each travel mode has a depth it must not cross, plus penalties for water below that limit:

| Mode | Blocked when P(depth ≥ limit) ≥ 40% | Speed |
|---|---|---|
| Walking with child / elderly | ≥ 15 cm | 4 km/h |
| Two-wheeler | ≥ 15 cm | road speed, max 35 km/h |
| Car / ambulance | ≥ 30 cm | road speed, max 50 km/h |

```
cost(road) = travel_time × (1 + 2 · P(≥5 cm) + 8 · P(≥15 cm))      (∞ if blocked)
```

Commonly cited flood-safety guidance says ~15 cm of moving water can knock an adult over and ~30 cm can float many cars. The thresholds are deliberately cautious. If no safe route exists, FloodSense sends you to the **nearest reachable shelter or hospital**, or tells you to stay on high ground and call 112.

### 5. Rain parser (offline, `frontend/js/rain.js`)

| You type | FloodSense understands |
|---|---|
| `poured heavily for 3 hours, then drizzled 2 hours` | 60 mm + 2 mm, the drizzle most recent |
| `12 cm in 2 days` · `40 mm in 2 hours` · `2 inches` | unit conversion |
| `கனமழை 3 மணி நேரம்` · `romba mazhai 2 mani neram` | Tamil / Tanglish → heavy, 3 h / 2 h |
| `heavy rain for 4 hours, stopped 2 hours ago` | dry gap, so the last hour = 0 mm |
| `very heavy 6 hours and still raining` | adds a 3-hour forecast |
| `dam gates opened` | turns on reservoir release |

Approximate rates: drizzle 1 · light 2.5 · moderate 6.5 · heavy 20 · very heavy 40 · cloudburst 100 mm/h. FloodSense always shows the parsed mm back to the user so they can correct it.

---

## City packs, flood view, places and navigation

### City pack format (v2)

One JSON file per city or area (`data/packs/<id>.json`):

| Key | What it holds |
|---|---|
| `segments[]` | road pieces ≤ 40 m: geometry, street name, road type, one-way, **12 model features**, **tile `t`** |
| `nodes[]` | junctions (routing graph) |
| `tiles` | 1 km grid: `nx`, `ny`, bounds of each tile, used for the 3×3 / 5×5 km flood view |
| `places[]` | area names (suburb, neighbourhood, locality) → map labels + search |
| `shops[]` | named shops and amenities (pharmacy, bakery, ATM, fuel, temple…) → map labels + search |
| `pois[]` | hospitals, shelters, fire stations for "Nearest hospital" and fallback routing |
| `water[]`, `hotspots[]` | rivers, lakes, railway, known flood spots |
| `weather` | last 72 h + next 24 h rain, wind, temperature |
| `model`, `model_metrics` | the 220 KB on-device model and its hold-out scores (added when served) |

The bundled **Demo City** (`demo-city`) is 6 × 6 km = 36 tiles: ~11,000 road segments, 16 area names, 240 shops, 6 hospitals and 4 shelters.

### Flood view (3×3 km, 5×5 km, full city)

- Centred on your **GPS** (or the map centre). During navigation it **follows you** tile by tile.
- Only roads in the view are predicted and coloured: ~2,800 roads in about 100 ms for 3×3 km. Roads outside it are drawn grey ("not analysed").
- **Routing never ignores flooding outside the view.** The predictor is *lazy*: when A\* reaches a road, that road is predicted on the spot (`createPredictor()` in `js/model.js`). Results are identical to predicting everything (checked in the tests).
- **Full city** predicts all ~11,000 Demo City roads in ~0.25 s.

### Offline map labels (`js/labels.js`)

Everything comes from the pack, so it works with no tile server:
- **Area names:** zoom 12–16
- **Street names:** rotated along the road, one per street every ~350 m, no overlaps, from zoom 15
- **Shops and amenities:** icon dots from zoom 16, names from zoom 17

When online, OpenStreetMap background tiles are added under real (non-synthetic) packs.

### Saved places and search (`js/places.js`, IndexedDB `places` store)

- **Home** and **Work** (one each) plus any number of **favourites** with your own names.
- Save from **GPS**, a **point on the map**, a **map popup** ("★ Save"), or **★ Save destination**.
- Saved places appear as quick chips in the Trip card (one tap = route there), as map markers, and at the top of search.
- **Search** covers streets, area names, shops, hospitals/shelters and saved places, fully offline. *Enter* = go to the first result; **From** = start from it.

### Live navigation (`js/nav.js`)

| Feature | How |
|---|---|
| GPS arrow + follow camera | `watchPosition` (high accuracy), arrow rotated by GPS heading or road direction, accuracy circle |
| Next-turn banner | distance to next turn, turn arrow, street name, "Then: …". Turns **orange when the stretch has shallow water** |
| Voice | "In 200 m, turn left onto …" and again at ~35 m. "Caution: shallow water ahead on …" |
| Off route | more than 40 m off the route for 2 fixes → **re-route from where you are** (safe route) |
| Rain changes mid-trip | map re-predicted and route recomputed from the current position |
| Arrival | within 20 m → "You have arrived". Screen stays awake (Wake Lock) while navigating |
| Simulate | drives along the route at 4× speed so you can demo it on a laptop |

### Shortest path highlight

The shortest path is drawn **purple with a white casing**. Its flooded stretches glow red with pulsing ⚠ pins and tooltips ("Flooded: Indira Nagar St · Deep (15-30 cm)"), and a map tag shows "Shortest · 2.0 km · 14 flooded". The **Both / Safe route / Shortest path** switch brings one route forward, fades the other and zooms to it.

---

## Data sources

### For training (collected once)

| Need | Used in this build | Production upgrade |
|---|---|---|
| Flood labels | Synthetic towns + physics rule + noise | Sentinel-1 SAR flood maps of past events (Copernicus EMS, Global Flood Database), city waterlogging hotspot lists, geotagged news reports (Chennai: Dec 2015, Nov 2021, Dec 2023) → `ml/labels/real_labels.csv` |
| Rain on event days | Generated scenarios | IMD gridded rainfall (`imdlib`), GPM IMERG, Open-Meteo historical API |
| Elevation | Synthetic DEM | Copernicus GLO-30 / SRTM / **FABDEM** (buildings removed), CartoDEM (Bhuvan) |
| Drainage / HAND | Computed (`backend/terrain.py`) | MERIT Hydro |
| Land cover | Synthetic urban gradient | ESA WorldCover 10 m |
| Water bodies | Synthetic river + lake | JRC Global Surface Water, OSM |

### For prediction (live, cached on the device)

| Need | Source | When |
|---|---|---|
| Location | Browser Geolocation API | on demand |
| Roads, underpasses, bridges, rivers, hospitals, shelters | **OpenStreetMap** via the Overpass API | map build |
| Street names, area names (`place=*`), named shops and amenities | **OpenStreetMap** via Overpass (map labels + search only, not model features) | map build |
| Elevation | **AWS Terrain Tiles** (Terrarium, zoom 14, free, no key) | map build |
| Rain past 72 h + next 24 h, wind, gusts, temperature, humidity | **Open-Meteo** (free, no key) | map build + Refresh |
| Known waterlogging hotspots | Your GeoJSON files in `data/hotspots/` | server pack build |
| Sealed surface | Proxy from road density (`terrain.impervious_from_roads`) | map build |
| Dam release | User switch / words ("dam gates opened") | offline |
| Rain when offline | **User's own words** or last cached weather | offline |

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | **Python 3.10+**, FastAPI, Uvicorn |
| Geo + terrain | NumPy, SciPy (no GDAL needed): priority-flood sink fill, D8 flow, HAND, written from scratch |
| ML | LightGBM, scikit-learn; optional onnxmltools |
| Data APIs | Overpass (OSM), AWS Terrain Tiles, Open-Meteo, all free with no API key |
| Frontend | Vanilla JS ES modules (no build step), **Leaflet** (bundled, works offline) |
| Map packs | `packs.py` CLI: chunked + cached Overpass downloads, parallel elevation tiles, island pruning, checks; pre-gzipped files + `index.json` catalogue |
| Offline | Service worker (app shell), IndexedDB (packs + meta + saved places), persistent storage request, lazy tile-based drawing and prediction |
| Navigation | Geolocation `watchPosition`, Screen Wake Lock, route snapping + re-routing (`js/nav.js`) |
| On-device AI | Tree-ensemble evaluator in JS (~40 lines) |
| Voice | Web Speech API (`speechSynthesis`) |
| Tests | pytest (16 tests: live builder end-to-end with mocked APIs, Overpass chunking, pack store, API, pack verification, training-data fingerprint) + Node test script (11 tests) |

---

## Run it locally

You need **Python 3.10–3.13**. Node.js is optional (only for the JS tests). The trained model and the Demo City are already included, so the **demo scenario runs without building a map**.

### Windows (PowerShell)

```powershell
cd floodsense
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
python run.py
```

### macOS / Linux

```bash
cd floodsense
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

The browser opens **http://localhost:8000**. On first start, the **Welcome** screen asks you to use GPS. FloodSense then builds a 10 × 10 km map around that location in the browser and saves it on-device. Keep the app open and online until the progress finishes.

### Useful commands

```bash
python run.py --port 8080 --no-browser   # different port, don't open a browser
python -m ml.synth_labels                # regenerate training data (~10 s)
python -m ml.train                       # retrain + export the model (~15 s) -> models/
python -m ml.export_onnx                 # optional ONNX export
python packs.py presets                  # ready-made city presets (Chennai areas, Coimbatore, Madurai, ...)
python packs.py build --preset chennai-velachery --default
                                         # build an optional server pack; --default marks it in the catalogue
python packs.py list                     # packs this server offers
python -m pytest -q                      # backend tests
node tests/test_frontend.mjs             # parser / model / routing tests (Node 18+)
```

After retraining, reload the page and pick the pack again (or delete it with ✕ and reload) to pick up the new model.

---

## 3-minute demo script

1. **Open** `http://localhost:8000` in a fresh browser (or incognito). Allow GPS and choose **Use my location and prepare nearby map**. FloodSense fetches map data and terrain, computes flood features in a browser worker, and caches the result.
2. **Go offline:** tick **Offline** (top right of the panel), or switch off Wi-Fi. *"No internet from here on."*
3. Point at the **dashed blue square** and the **▦ 3×3 km** chip: *"This is the flood view around me: 2,800 roads analysed on the phone in about 0.1 s."* Zoom in to show **street, shop and area names**, all offline.
4. **Route tab → ▶ Load demo scenario.** Rain = *"poured heavily for 3 hours"*, mode = 🚶 *walking with child*, Home → Government General Hospital.
   - **Purple:** the **shortest path, 2.0 km, crosses 14 flooded stretches** (red glow + ⚠ pins).
   - **Blue:** the **safe route, 2.8 km / 41 min**, going around.
   - Click **Shortest path** to spotlight it, then **Both** again.
5. **Tap a red road:** probability bars + *why* it floods (underpass, low spot, rain).
6. Press **Simulate:** the GPS arrow drives the route, with the turn banner ("In 200 m, turn right onto …"), voice, and an orange banner on shallow stretches. Press **Stop**.
7. Type "medic" in the **B** box: offline search finds the shops. Press **★ Save destination**. *"One-tap routes next time."*
8. **Rain tab → Drizzle 2 h:** the map turns green and the route becomes the shortest path. *"Same AI, it reacts to the rain."*
9. **Heavy 3 h**, then **Route tab → 🏥 Nearest hospital.** Walking with a child, it's Government General (2.8 km). Tap 🚑 **Car / ambulance** and press it again: **Sri Ramana Clinic, 1.3 km**, because a car can handle water a walker can't.
10. **Maps tab:** maps on the device, optional downloads, storage. *"Cities are prepared on the server with one command, `python packs.py build --preset …`."*
11. **Model tab:** 92.4% accuracy on a town never seen in training, confusion matrix, and what the model relies on. *"Honest note: trained on synthetic towns with physics labels; real flood records are the next step."*

**Closing line:** *"Downloads your city once, works offline, explains every red road, and navigates you around the water."*

---

## Using a real city, a phone, and your own data

**First-run nearby maps are built in the browser from public data** (OpenStreetMap, AWS Terrain Tiles, Open-Meteo) and cached on the device. This is a fixed 10 × 10 km area centred on GPS, not an administrative boundary. Browser access depends on the public providers' availability and CORS policy; GPS requires HTTPS or localhost. Separately, `packs.py` can build and manage optional server-hosted City Packs.

```bash
python packs.py presets                                    # list ready-made cities
python packs.py build --preset chennai-velachery --default # optional server pack, marked as catalogue default
python packs.py build --place "Anna Nagar, Chennai" --radius-km 3
python packs.py build --name "My Street" --lat 13.04 --lon 80.23 --radius-km 1.5 --kind area
python packs.py list                                       # what phones can download (* = default)
python packs.py verify --all                               # check every pack (corrupt, fragmented, no hospitals, ...)
python packs.py refresh-weather --all                      # update the weather snapshot inside packs
python packs.py set-default <id> · delete <id> · demo · reindex
```

What the optional server-side `packs.py build` does:

| Step | Detail |
|---|---|
| OpenStreetMap | Roads, names, shops, area names, hospitals, rivers, parks, fetched in **3 × 3 km chunks**. Each chunk is **cached on disk**, so an interrupted build **resumes**. Requests are **retried across two mirrors** with back-off. Parking aisles, driveways and private service roads are skipped. `oneway=-1` is handled |
| Elevation | AWS Terrain Tiles, **downloaded in parallel** (8 at a time), retried, cached |
| Terrain | Sink filling, flow, HAND, low spots. Lakes are **filled polygons**. Above 5 km radius the grid coarsens to stay around 1000 × 1000 cells |
| Clean-up | **Disconnected road fragments are removed**, so a pin can't snap onto a cut-off private lane and give "no route" |
| Checks | `verify` runs automatically: broken junctions, invalid features, fragmented network, missing hospitals, missing weather, too many unnamed roads |
| Output | `data/packs/<id>.json` + **pre-compressed `.json.gz`** (about 5× smaller) + `index.json` catalogue with a checksum per pack |

**In the app (Maps tab):** *On this device* lists every saved map with **Open** and **Delete**. Optional published packs can be downloaded or updated. *Storage* shows space used and offers **Keep maps safe**, which asks the browser for persistent storage so maps aren't cleared on a full phone. On start, the app opens the map that contains your GPS position.

**Background map (online, real packs):** *Clean* (CARTO light, no labels, so flood colours and FloodSense's own names stay readable; default), *OpenStreetMap* (FloodSense hides its own street and area labels to avoid doubles), or *None*. The synthetic Demo City never shows a background, because its roads are made up.

**On a phone:** browsers only allow GPS, offline caching and Wake Lock on `https://` or `localhost`.
- Easiest: `ngrok http 8000` and open the `https://…` link on the phone, then *Add to Home screen*.
- Or open `http://<laptop-ip>:8000` (printed by `run.py`). Maps work, but GPS and offline caching won't.
- To test navigation without walking: **Simulate**, or Chrome DevTools → *Sensors* → set a location.

**Known hotspots:** drop GeoJSON Point files into `data/hotspots/` (format in `data/hotspots/README.md`). Packs built afterwards flag roads within 100 m.

**Real flood labels:** add rows to `ml/labels/real_labels.csv` (format in `ml/labels/README.md`), then run `python -m ml.synth_labels && python -m ml.train`.

---

## API

Interactive docs: **http://localhost:8000/docs**

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/health` | status, model version, default pack, pack ids |
| GET | `/api/catalog` | everything a phone needs: default pack id, model version, all packs (size, checksum, bbox, counts) |
| GET | `/api/packs` | catalogue of city/area packs (default first): name, kind, size, segments, shops |
| GET | `/api/packs/{id}` · `/api/packs/default` | the pre-compressed pack file (`X-Pack-Bytes` = real size for progress, `X-Pack-Sha` = checksum) |
| GET | `/api/weather?lat=&lon=` | current + past 72 h + next 24 h |
| GET | `/api/model` · `/api/metrics` | the exported model · its hold-out test scores |

Prediction and routing **never** call the server.

---

## Project structure

```
floodsense/
├─ run.py                     # one-command launcher
├─ packs.py                   # map-pack program: build / list / verify / update / delete packs
├─ requirements.txt
├─ backend/
│  ├─ main.py                 # FastAPI app + serves the web app
│  ├─ features.py             # feature order, road classes, depth classes (shared with JS)
│  ├─ geo.py                  # local projection + raster grid
│  ├─ terrain.py              # sink fill, D8 flow, accumulation, HAND, low spots
│  ├─ physics.py              # transparent water-balance rule (labels + fallback)
│  ├─ pack_core.py            # roads + terrain -> pack v2 (tiles, names, shops)
│  ├─ pack_builder.py         # live builder: Overpass + Terrain Tiles + Open-Meteo
│  ├─ pack_store.py           # pack files, .gz copies, index.json catalogue, default pack
│  ├─ weather.py              # Open-Meteo client
│  └─ demo_city.py            # synthetic 6x6 km Demo City (+ shops, areas) and training towns
├─ ml/
│  ├─ synth_labels.py         # training table (synthetic + real labels)
│  ├─ train.py                # LightGBM -> models/flood_model.json + metrics
│  ├─ export_onnx.py          # optional ONNX export
│  └─ labels/README.md        # format for real labels
├─ models/                    # flood_model.json (browser), .txt (LightGBM), metrics.json
├─ data/
│  ├─ packs/                  # <id>.json + .json.gz + index.json (+ default.txt)
│  ├─ hotspots/               # optional known waterlogging points (GeoJSON)
│  └─ cache/                  # downloaded tiles / weather
├─ frontend/                  # offline PWA (no build step)
│  ├─ index.html, css/style.css, sw.js, manifest.webmanifest
│  ├─ js/app.js               # UI, GPS onboarding, trip, route focus, wiring
│  ├─ js/live_pack.js         # browser-side OSM/elevation download and terrain pack generation
│  ├─ js/live_pack_worker.js  # keeps map building off the UI thread
│  ├─ js/roads.js             # tile-based road drawing + 3x3 / 5x5 / full flood view
│  ├─ js/labels.js            # offline street / shop / area names
│  ├─ js/places.js            # offline search + saved-place helpers
│  ├─ js/packs.js             # downloads (progress, checksum), updates, model sync, storage
│  ├─ js/nav.js               # live turn-by-turn navigation (GPS arrow, re-route)
│  ├─ js/metrics.js           # model performance card
│  ├─ js/model.js             # on-device model (lazy predictor) + explanations
│  ├─ js/physics.js           # JS twin of the physics rule
│  ├─ js/router.js            # flood-aware A*, nearest hospital, directions
│  ├─ js/rain.js              # rain words / Tamil / units -> mm
│  ├─ js/db.js, js/voice.js   # IndexedDB (packs, places, settings) · speech
│  └─ vendor/leaflet/         # bundled so maps work offline
├─ docs/                      # architecture.svg/.png, screenshots
└─ tests/                     # test_core.py (pytest), test_frontend.mjs (node)
```

---

## How we built it in 10 hours

| Hours | Work |
|---|---|
| 0:00–0:45 | Scope freeze, Area Pack format, repo skeleton |
| 0:45–2:30 | Terrain analysis (sink fill, D8, HAND), road segmentation, demo town generator |
| 2:30–4:30 | Physics rule, synthetic labels, LightGBM training, JSON export + parity check |
| 4:30–6:00 | Browser model, flood-aware A\*, map colouring, live OSM / DEM / weather builder |
| 6:00–8:00 | Offline (service worker + IndexedDB), rain parser (EN / Tamil / Tanglish), voice, nearest hospital, explanations |
| 8:00–9:00 | Tests, offline airplane-mode run-through, demo scenario |
| 9:00–10:00 | README, architecture diagram, pitch rehearsal |

---

## Limitations, safety and what's next

**Safety:** FloodSense gives *risk estimates*, not guarantees. Always follow official warnings (IMD, district administration). Never walk or drive into water when you can't see the road.

**Honest limitations**
- The model is trained on **synthetic towns + a physics rule**. Its scores show that it learned the rule, not that it is accurate on real streets. Real labels are the #1 next step.
- 30 m elevation data (SRTM-class) is coarse for city streets. FABDEM or city LiDAR would help a lot.
- Storm-drain capacity is rarely public, so it is approximated from road class + sealed surface.
- The live builder was tested against **mocked** Overpass / Terrain Tiles / Open-Meteo responses (`tests/test_core.py`). Do a real run with internet before judging, and keep the demo pack as a backup.
- Offline, the map is drawn from the pack: roads, water, names and shops. No building footprints or satellite imagery. OpenStreetMap background tiles appear only for real packs while online.
- Shop and area names come from OpenStreetMap, so coverage depends on how well your city is mapped.
- Navigation is north-up (the arrow rotates, the map doesn't). Phone GPS in dense areas can be ±20 m off, so the off-route threshold is 40 m.
- A whole-city pack for a big metro (10 km radius) can be 20+ MB. Use 4–6 km city packs for the hackathon.

**Next**
- 🛰️ Train on real labels: Sentinel-1 flood extents + Greater Chennai Corporation hotspot lists + crowd reports
- 📣 In-app "this road is flooded" reports that sync when online and override the model
- 💧 Reservoir levels feed (Chennai Metrowater lake levels, CWC bulletins)
- 📱 Native Android build with ONNX Runtime Mobile and offline Tamil voice

---

## Credits & licences

Road data © OpenStreetMap contributors (ODbL) · Elevation: AWS Terrain Tiles (Mapzen/Tilezen, sources incl. SRTM) · Weather: Open-Meteo (CC BY 4.0) · Map library: Leaflet (BSD-2-Clause).
