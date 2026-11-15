"""Build the training table.

Real street-level flood-depth labels barely exist, so the hackathon model is
trained on:
  * synthetic towns (different random terrain + street layouts),
  * hundreds of rain scenarios each,
  * labels from the physics rule (backend/physics.py) with realistic noise,
  * PLUS any real labels you put in ml/labels/real_labels.csv (weighted x3).

The demo town (seed 7) is NOT used for training; it is the hold-out test.

Run:  python -m ml.synth_labels        -> ml/data/train.npz
"""
import argparse
from pathlib import Path

import numpy as np

from backend import physics
from backend.demo_city import make_town
from backend.features import CLASS_EDGES_CM, FEATURE_NAMES, RAIN_FEATURES, STATIC_FEATURES
from backend.geo import LocalProjection
from backend.pack_core import build_pack

HERE = Path(__file__).resolve().parent
OUT = HERE / "data"
REAL = HERE / "labels" / "real_labels.csv"


def town_static(seed: int) -> np.ndarray:
    t = make_town(seed=seed)
    pack = build_pack(pack_id=f"t{seed}", name="train", proj=LocalProjection(13.0, 80.2), grid=t["grid"],
                      z=t["z"], water_mask=t["water_mask"], ways=t["ways"], hotspots=t["hotspots"],
                      impervious=t["impervious"], progress=lambda *_: None)
    return np.array([s["f"] for s in pack["segments"]], dtype=float)


def rain_scenarios(n: int, rng) -> np.ndarray:
    """Random but physically ordered rain histories (mm)."""
    kind = rng.choice(["dry", "light", "moderate", "heavy", "extreme"], size=n, p=[.12, .2, .25, .28, .15])
    rate = {"dry": (0, 1), "light": (0.5, 4), "moderate": (3, 10), "heavy": (8, 30), "extreme": (25, 70)}
    out = np.zeros((n, len(RAIN_FEATURES)))
    for k in range(n):
        lo, hi = rate[kind[k]]
        r1 = rng.uniform(lo, hi) * rng.choice([0.2, 1, 1, 1])
        r3 = r1 + rng.uniform(0, 2.2) * rng.uniform(lo, hi)
        r24 = r3 + rng.uniform(0, 12) * rng.uniform(lo, hi) * 0.6
        r72 = r24 + rng.uniform(0, 80) * (kind[k] != "dry")
        fc3 = rng.uniform(0, 2) * rng.uniform(lo, hi) * rng.choice([0, 1])
        res = float(rng.random() < 0.06)
        out[k] = [r1, r3, r24, r72, fc3, res]
    return out


def labelled_rows(static: np.ndarray, rain: np.ndarray, rng, noise: float = 0.3):
    X, y = [], []
    for r in rain:
        F = np.hstack([static, np.tile(r, (len(static), 1))])
        d = {n: F[:, i] for i, n in enumerate(FEATURE_NAMES)}
        depth = physics.depth_cm(d) * rng.lognormal(0.0, noise, len(F))   # real streets are messier
        X.append(F); y.append(np.digitize(depth, CLASS_EDGES_CM))
    return np.vstack(X), np.concatenate(y)


def load_real_labels():
    """CSV with all FEATURE_NAMES columns + either depth_cm or depth_class."""
    if not REAL.exists():
        return None
    import csv
    X, y = [], []
    with REAL.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            X.append([float(row[n]) for n in FEATURE_NAMES])
            y.append(int(row["depth_class"]) if row.get("depth_class") not in (None, "")
                     else int(np.digitize(float(row["depth_cm"]), CLASS_EDGES_CM)))
    return np.array(X), np.array(y)


def main(towns: int = 10, scenarios: int = 60, seed: int = 0, keep: float = 0.35):
    rng = np.random.default_rng(seed)
    Xs, ys, ws = [], [], []
    for t in range(towns):
        s = town_static(100 + t)
        X, y = labelled_rows(s, rain_scenarios(scenarios, rng), rng)
        idx = rng.random(len(X)) < keep
        Xs.append(X[idx]); ys.append(y[idx]); ws.append(np.ones(idx.sum()))
        print(f"town {t + 1}/{towns}: {len(s)} segments -> {idx.sum()} rows")
    real = load_real_labels()
    if real is not None:
        Xs.append(real[0]); ys.append(real[1]); ws.append(np.full(len(real[1]), 3.0))
        print(f"+ {len(real[1])} real labelled rows from {REAL.name}")

    # hold-out: the demo town, never seen in training
    s7 = town_static(7)
    Xt, yt = labelled_rows(s7, rain_scenarios(40, np.random.default_rng(99)), np.random.default_rng(98))

    OUT.mkdir(exist_ok=True)
    X, y, w = np.vstack(Xs), np.concatenate(ys), np.concatenate(ws)
    np.savez_compressed(OUT / "train.npz", X=X, y=y, w=w, Xt=Xt, yt=yt,
                        names=np.array(FEATURE_NAMES), static=np.array(STATIC_FEATURES))
    print(f"saved {len(y)} train rows, {len(yt)} test rows; class counts {np.bincount(y, minlength=4)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--towns", type=int, default=10)
    ap.add_argument("--scenarios", type=int, default=60)
    a = ap.parse_args()
    main(a.towns, a.scenarios)
