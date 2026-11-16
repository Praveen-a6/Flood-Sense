"""Optional: export the trained model to ONNX (+ 8-bit friendly), e.g. for a
native Android app with ONNX Runtime Mobile. The web app does NOT need this;
it runs models/flood_model.json directly.

Run:  pip install onnxmltools onnx onnxruntime
      python -m ml.export_onnx
"""
from pathlib import Path

import lightgbm as lgb
import numpy as np

from backend.features import FEATURE_NAMES

ROOT = Path(__file__).resolve().parent.parent


def main():
    from onnxmltools import convert_lightgbm
    from onnxmltools.convert.common.data_types import FloatTensorType

    booster = lgb.Booster(model_file=str(ROOT / "models" / "flood_model.txt"))
    onx = convert_lightgbm(booster, initial_types=[("features", FloatTensorType([None, len(FEATURE_NAMES)]))],
                           target_opset=15, zipmap=False)
    out = ROOT / "models" / "flood_model.onnx"
    out.write_bytes(onx.SerializeToString())
    print(f"saved {out} ({out.stat().st_size / 1024:.0f} KB)")

    try:
        import onnxruntime as ort
        d = np.load(ROOT / "ml" / "data" / "train.npz")
        X = d["Xt"][:200].astype(np.float32)
        sess = ort.InferenceSession(str(out))
        probs = sess.run(None, {"features": X})[1]
        ref = booster.predict(X)
        print("max diff vs LightGBM:", float(np.abs(probs - ref).max()))
    except Exception as ex:
        print("verification skipped:", ex)


if __name__ == "__main__":
    main()
