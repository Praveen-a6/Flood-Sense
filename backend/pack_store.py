"""Pack storage on the server: data/packs/

  <id>.json       the pack (compact JSON)
  <id>.json.gz    pre-compressed copy, sent to phones as-is (fast, no CPU per request)
  index.json      catalogue: one small entry per pack (name, size, bbox, checksum ...)
  default.txt     id of the pack every new device downloads on first start

The web server only reads index.json and streams files; it never re-parses a
20 MB city pack per request.
"""
import gzip
import hashlib
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK_DIR = ROOT / "data" / "packs"
INDEX = PACK_DIR / "index.json"
DEFAULT = PACK_DIR / "default.txt"


def _entry(pack: dict, raw: bytes, gz: bytes) -> dict:
    return {
        "id": pack["id"], "name": pack["name"], "kind": pack.get("kind", "area"),
        "version": pack.get("version", 1), "synthetic": bool(pack.get("synthetic")),
        "created_at": pack.get("created_at"), "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "segments": len(pack.get("segments", [])), "shops": len(pack.get("shops", [])),
        "places": len(pack.get("places", [])), "hospitals": sum(p["type"] == "hospital" for p in pack.get("pois", [])),
        "tiles": [pack["tiles"]["nx"], pack["tiles"]["ny"]] if pack.get("tiles") else [1, 1],
        "center": pack.get("center"), "bbox": pack.get("bbox"),
        "bytes": len(raw), "gz_bytes": len(gz), "sha256": hashlib.sha256(raw).hexdigest()[:16],
    }


def load_index() -> dict:
    """The catalogue. Entries whose pack file was deleted by hand are dropped automatically."""
    if INDEX.exists():
        try:
            idx = json.loads(INDEX.read_text(encoding="utf-8"))
            stale = [pid for pid in idx.get("packs", {}) if not (PACK_DIR / f"{pid}.json").exists()]
            if stale:
                for pid in stale:
                    idx["packs"].pop(pid)
                _write_index(idx)
            return idx
        except Exception:
            pass
    return rebuild_index()


def _write_index(idx: dict):
    PACK_DIR.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    tmp.replace(INDEX)


def save_pack(pack: dict) -> dict:
    """Write pack + .gz atomically and update the index. Never stores the model inside."""
    PACK_DIR.mkdir(parents=True, exist_ok=True)
    pack = {k: v for k, v in pack.items() if k not in ("model", "model_metrics", "feature_names", "class_labels")}
    raw = json.dumps(pack, separators=(",", ":")).encode()
    gz = gzip.compress(raw, compresslevel=6)
    for suffix, data in ((".json", raw), (".json.gz", gz)):
        tmp = PACK_DIR / f"{pack['id']}{suffix}.tmp"
        tmp.write_bytes(data)
        tmp.replace(PACK_DIR / f"{pack['id']}{suffix}")
    idx = load_index()
    idx.setdefault("packs", {})[pack["id"]] = _entry(pack, raw, gz)
    _write_index(idx)
    return idx["packs"][pack["id"]]


def rebuild_index() -> dict:
    """Re-scan data/packs/*.json (e.g. after copying packs in by hand)."""
    idx = {"packs": {}}
    for p in sorted(PACK_DIR.glob("*.json")):
        if p.name == "index.json":
            continue
        try:
            raw = p.read_bytes()
            pack = json.loads(raw)
            gzp = p.with_suffix(".json.gz")
            if not gzp.exists() or gzp.stat().st_mtime < p.stat().st_mtime:
                gzp.write_bytes(gzip.compress(raw, compresslevel=6))
            idx["packs"][pack["id"]] = _entry(pack, raw, gzp.read_bytes())
        except Exception as ex:
            print(f"skipping {p.name}: {ex}")
    _write_index(idx)
    return idx


def delete_pack(pack_id: str) -> bool:
    found = False
    for suffix in (".json", ".json.gz"):
        f = PACK_DIR / f"{pack_id}{suffix}"
        if f.exists():
            f.unlink()
            found = True
    idx = load_index()
    if idx.get("packs", {}).pop(pack_id, None):
        found = True
        _write_index(idx)
    if get_default() == pack_id and DEFAULT.exists():
        DEFAULT.unlink()
    return found


def get_default(fallback: str = "demo-city") -> str:
    packs = load_index().get("packs", {})
    pid = DEFAULT.read_text().strip() if DEFAULT.exists() else fallback
    if pid in packs:
        return pid
    return fallback if fallback in packs else next(iter(packs), fallback)


def set_default(pack_id: str):
    if pack_id not in load_index().get("packs", {}):
        raise KeyError(pack_id)
    DEFAULT.write_text(pack_id)


def pack_path(pack_id: str, gz: bool) -> Path:
    return PACK_DIR / f"{pack_id}.json{'.gz' if gz else ''}"
