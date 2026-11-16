"""Train the flood-depth classifier and export it for the phone.

Run:  python -m ml.train            (runs ml.synth_labels first if needed)

Outputs
  models/flood_model.txt    LightGBM native model
  models/flood_model.json   compact tree arrays, evaluated in the browser (offline)
  models/metrics.json       hold-out scores on the demo town
"""
import json
import warnings
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score

from backend.features import CLASS_LABELS, FEATURE_NAMES

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "ml" / "data" / "train.npz"
MODELS = ROOT / "models"
warnings.filterwarnings("ignore", message="X does not have valid feature names")


def compact_trees(booster: lgb.Booster) -> dict:
    """LightGBM dump -> flat arrays per tree (small, trivial to evaluate in JS).

    Node arrays: f (feature), t (threshold), l/r (child: >=0 node, <0 leaf -(k+1)).
    Leaf values: v.  Tree k belongs to class k % num_class.
    """
    dump = booster.dump_model()
    trees = []
    for info in dump["tree_info"]:
        f, t, l, r, v = [], [], [], [], []

        def walk(node):
            if "leaf_value" in node:
                v.append(round(node["leaf_value"], 6))
                return -len(v)
            assert node["decision_type"] == "<=", node["decision_type"]
            k = len(f)
            f.append(node["split_feature"]); t.append(round(float(node["threshold"]), 6)); l.append(0); r.append(0)
            l[k] = walk(node["left_child"]); r[k] = walk(node["right_child"])
            return k

        root = walk(info["tree_structure"])
        trees.append({"f": f, "t": t, "l": l, "r": r, "v": v, "root": root})
    return {"format": "floodsense-gbdt-v1", "num_class": dump["num_class"],
            "feature_names": dump["feature_names"], "trees": trees}


def predict_compact(model: dict, X: np.ndarray) -> np.ndarray:
    """Python twin of frontend/js/model.js (used to verify the export)."""
    K = model["num_class"]
    raw = np.zeros((len(X), K))
    for k, tr in enumerate(model["trees"]):
        for n, x in enumerate(X):
            node = tr["root"]
            while node >= 0:
                node = tr["l"][node] if x[tr["f"][node]] <= tr["t"][node] else tr["r"][node]
            raw[n, k % K] += tr["v"][-node - 1]
    e = np.exp(raw - raw.max(1, keepdims=True))
    return e / e.sum(1, keepdims=True)


def main():
    if not DATA.exists():
        from ml import synth_labels
        synth_labels.main()
    d = np.load(DATA)
    X, y, w, Xt, yt = d["X"], d["y"], d["w"], d["Xt"], d["yt"]
    print(f"training on {len(y)} rows ...")
    t0 = time.time()
    clf = lgb.LGBMClassifier(objective="multiclass", n_estimators=140, learning_rate=0.1, num_leaves=15,
                             min_child_samples=40, subsample=0.8, subsample_freq=1, colsample_bytree=0.9,
                             verbose=-1)
    clf.fit(X, y, sample_weight=w, feature_name=FEATURE_NAMES)
    print(f"trained in {time.time() - t0:.1f}s")

    p = clf.predict_proba(Xt)
    pred = p.argmax(1)
    cm = confusion_matrix(yt, pred, labels=[0, 1, 2, 3])
    danger_true = yt >= 2
    missed = int(((pred <= 1) & danger_true).sum())
    metrics = {
        "holdout": "Demo Town (seed 7), never used in training, 40 rain scenarios",
        "rows": int(len(yt)),
        "accuracy": round(float(accuracy_score(yt, pred)), 4),
        "macro_f1": round(float(f1_score(yt, pred, average="macro")), 4),
        "dangerous_roads_missed_pct": round(100 * missed / max(1, int(danger_true.sum())), 2),
        # what routing actually uses: block a road if P(depth >= 15 cm) >= 0.4
        "missed_at_routing_threshold_pct": round(100 * int(((p[:, 2:].sum(1) < 0.4) & danger_true).sum())
                                                 / max(1, int(danger_true.sum())), 2),
        "dry_roads_wrongly_blocked_pct": round(100 * int(((p[:, 2:].sum(1) >= 0.4) & (yt == 0)).sum())
                                               / max(1, int((yt == 0).sum())), 2),
        "confusion_matrix": {"rows=true, cols=pred": CLASS_LABELS, "matrix": cm.tolist()},
        "feature_importance": dict(sorted(zip(FEATURE_NAMES, clf.booster_.feature_importance("gain").round(1).tolist()),
                                          key=lambda kv: -kv[1])),
    }
    print(json.dumps({k: v for k, v in metrics.items() if k != "feature_importance"}, indent=2))

    MODELS.mkdir(exist_ok=True)
    clf.booster_.save_model(str(MODELS / "flood_model.txt"))
    compact = compact_trees(clf.booster_)
    compact["trained_at"] = time.strftime("%Y-%m-%d %H:%M")
    compact["metrics"] = {k: metrics[k] for k in ("accuracy", "macro_f1", "dangerous_roads_missed_pct",
                                                    "missed_at_routing_threshold_pct", "dry_roads_wrongly_blocked_pct")}
    # verify the export matches LightGBM exactly
    sample = Xt[:: max(1, len(Xt) // 300)]
    diff = np.abs(predict_compact(compact, sample) - clf.predict_proba(sample)).max()
    assert diff < 1e-4, f"export mismatch {diff}"
    (MODELS / "flood_model.json").write_text(json.dumps(compact, separators=(",", ":")))
    (MODELS / "metrics.json").write_text(json.dumps(metrics, indent=2))
    size = (MODELS / "flood_model.json").stat().st_size / 1024
    print(f"saved models/flood_model.json ({size:.0f} KB, {len(compact['trees'])} trees, export check diff={diff:.1e})")


if __name__ == "__main__":
    main()
