"""Rule-based street flooding estimate.

Used for two things:
  1. generating synthetic training labels (ml/synth_labels.py), and
  2. a transparent fallback if the ML model is unavailable.

Simple water balance per road segment:
  effective rain (recent rain counts more)  x  runoff share (sealed surface)
  - what the street drains can take away     = excess water
  excess x how much water converges here x how low the spot is = depth,
  + ponding in depressions, + extra for underpasses, river overflow, dam release.

The numbers are deliberately simple and tunable. Real labels (see README)
should replace them as soon as they exist.
"""
import numpy as np

from .features import CLASS_EDGES_CM

# mm of rain the street drainage can absorb per event, by road code
DRAIN_MM = np.array([32.0, 26.0, 20.0, 14.0, 12.0])


def effective_rain(r1, r3, r24, r72, fc3):
    r1, r3, r24, r72, fc3 = (np.asarray(v, dtype=float) for v in (r1, r3, r24, r72, fc3))
    r3 = np.maximum(r3, r1)
    r24 = np.maximum(r24, r3)
    r72 = np.maximum(r72, r24)
    return r1 + 0.85 * (r3 - r1) + 0.40 * (r24 - r3) + 0.12 * (r72 - r24) + 0.5 * fc3


def depth_cm(f: dict) -> np.ndarray:
    """f maps feature name -> scalar or array. Returns estimated depth in cm."""
    g = {k: np.asarray(v, dtype=float) for k, v in f.items()}
    eff = effective_rain(g["rain_1h"], g["rain_3h"], g["rain_24h"], g["rain_72h"], g["rain_fc_3h"])
    imp = np.clip(g["impervious"], 0, 1)
    runoff = 0.35 + 0.55 * imp
    drain = DRAIN_MM[np.clip(g["road_code"], 0, 4).astype(int)] * (1 - 0.3 * imp)
    excess = np.maximum(0.0, eff * runoff - drain)                    # mm

    convergence = 1 + 0.45 * np.clip(g["log_flow_acc"], 0, 6)
    lowness = (1 / (1 + np.maximum(g["hand_m"], 0) / 1.2)) * (1 + np.clip(-g["rel_elev_300m"], 0, 6) / 2.0)
    depth_mm = excess * convergence * lowness * 1.3
    # depressions fill up with the excess until they spill
    depth_mm += np.minimum(g["depression_m"] * 1000.0, excess * 5.0)
    # underpasses collect water from the ramps on both sides
    depth_mm = np.where(g["underpass"] > 0.5, depth_mm * 2.2 + excess * 2.0, depth_mm)
    # river / canal overflows after a wet day
    r24 = np.maximum(g["rain_24h"], g["rain_3h"])
    near = np.clip((150 - g["dist_water_m"]) / 150, 0, 1)
    depth_mm += near * np.maximum(0, r24 - 70) * 1.5
    # upstream dam / lake release floods low ground near water
    near_res = np.clip((300 - g["dist_water_m"]) / 300, 0, 1)
    depth_mm += g["reservoir_release"] * near_res * 250 / (1 + np.maximum(g["hand_m"], 0))
    # known hotspots flood more than terrain alone suggests (blocked drains etc.)
    depth_mm = np.where(g["hotspot_100m"] > 0.5, depth_mm * 1.5 + excess * 0.5, depth_mm)
    # bridges stay dry unless the river tops them
    depth_mm = np.where(g["bridge"] > 0.5, 0.0, depth_mm)
    return depth_mm / 10.0


def depth_class(cm) -> np.ndarray:
    return np.digitize(np.asarray(cm, dtype=float), CLASS_EDGES_CM)
