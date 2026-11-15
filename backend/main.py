"""FloodSense API + static web app.

Run with:  python run.py      (or: uvicorn backend.main:app --reload)

Optional server-hosted map packs are built with `python packs.py ...`.
The first-run GPS map is fetched and built directly in the browser.
"""
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import pack_store
from .demo_city import build_demo_pack

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = ROOT / "models" / "flood_model.json"
METRICS_PATH = ROOT / "models" / "metrics.json"
FRONTEND = ROOT / "frontend"
DEMO_ID = "demo-city"

log = logging.getLogger("floodsense")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")


def ensure_demo_pack():
    if DEMO_ID not in pack_store.load_index().get("packs", {}):
        log.info("building Demo City pack (first run, ~3 s) ...")
        pack_store.save_pack(build_demo_pack(progress=log.info))


@asynccontextmanager
async def lifespan(_app):
    ensure_demo_pack()
    if not MODEL_PATH.exists():
        log.warning("models/flood_model.json missing -> phones will use the physics fallback. Run: python -m ml.train")
    yield


app = FastAPI(title="FloodSense API", version="3.0", lifespan=lifespan,
              description="Serves offline map packs and the on-device flood model. Build packs with `python packs.py`.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def model_info() -> dict | None:
    m = load_json(MODEL_PATH)
    if not m:
        return None
    return {"version": m.get("trained_at", "unknown"), "trees": len(m["trees"]), "bytes": MODEL_PATH.stat().st_size}


def catalogue() -> list:
    default = pack_store.get_default(DEMO_ID)
    packs = [dict(e, default=(pid == default)) for pid, e in pack_store.load_index().get("packs", {}).items()]
    packs.sort(key=lambda d: (not d["default"], d["kind"] != "city", d["name"]))
    return packs


@app.get("/api/health")
def health():
    return {"status": "ok", "model": model_info(), "default_pack": pack_store.get_default(DEMO_ID),
            "packs": [p["id"] for p in catalogue()]}


@app.get("/api/catalog")
def catalog():
    """Everything a phone needs to decide what to download: packs (default first) + model version."""
    return {"default": pack_store.get_default(DEMO_ID), "model": model_info(), "packs": catalogue()}


@app.get("/api/packs")
def list_packs():
    return catalogue()


@app.get("/api/packs/{pack_id}")
def get_pack(pack_id: str, request: Request):
    """Streams the pre-compressed pack file. X-Pack-Bytes = uncompressed size (for progress bars)."""
    if pack_id == "default":
        pack_id = pack_store.get_default(DEMO_ID)
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", pack_id):
        raise HTTPException(400, "bad pack id")
    entry = pack_store.load_index().get("packs", {}).get(pack_id)
    if not entry:
        raise HTTPException(404, "pack not found")
    headers = {"X-Pack-Bytes": str(entry["bytes"]), "X-Pack-Sha": entry["sha256"], "Cache-Control": "no-cache"}
    gz, raw = pack_store.pack_path(pack_id, gz=True), pack_store.pack_path(pack_id, gz=False)
    if not raw.exists():                       # file removed while the server was running
        pack_store.rebuild_index()
        raise HTTPException(404, "pack file missing on the server")
    if "gzip" in request.headers.get("accept-encoding", "") and gz.exists():
        return FileResponse(gz, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return FileResponse(raw, media_type="application/json", headers=headers)


@app.get("/api/model")
def model():
    if not MODEL_PATH.exists():
        raise HTTPException(404, "model not trained yet")
    return FileResponse(MODEL_PATH, media_type="application/json", headers={"Cache-Control": "no-cache"})


@app.get("/api/metrics")
def metrics():
    """Hold-out test scores of the current model (models/metrics.json)."""
    m = load_json(METRICS_PATH)
    if not m:
        raise HTTPException(404, "no metrics yet - run: python -m ml.train")
    return JSONResponse(m)


@app.get("/api/weather")
def weather(lat: float, lon: float):
    from .weather import fetch_weather
    try:
        return fetch_weather(lat, lon)
    except Exception as ex:
        raise HTTPException(502, f"Weather unavailable: {ex}")


@app.get("/sw.js")
def service_worker():
    return FileResponse(FRONTEND / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
