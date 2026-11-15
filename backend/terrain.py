"""Terrain analysis on a DEM grid: sink filling, flow, HAND, low spots.

Pure numpy/scipy so it installs anywhere (no GDAL, no WhiteboxTools).
A 400 x 400 grid (4 km at 10 m) takes a few seconds.
"""
import heapq

import numpy as np
from scipy.ndimage import distance_transform_edt, uniform_filter

# 8 neighbours (di, dj) and their distances in cells
_NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
_ND = [2 ** 0.5, 1, 2 ** 0.5, 1, 1, 2 ** 0.5, 1, 2 ** 0.5]


def priority_flood(z: np.ndarray, eps: float = 1e-4) -> np.ndarray:
    """Fill depressions (Barnes et al. 2014, priority-flood + epsilon).
    filled - z = depth water can pond before spilling."""
    ny, nx = z.shape
    filled = z.astype(float).copy()
    closed = np.zeros(z.shape, dtype=bool)
    heap = []
    for i in range(ny):
        for j in (0, nx - 1):
            heap.append((filled[i, j], i, j)); closed[i, j] = True
    for j in range(1, nx - 1):
        for i in (0, ny - 1):
            heap.append((filled[i, j], i, j)); closed[i, j] = True
    heapq.heapify(heap)
    while heap:
        e, i, j = heapq.heappop(heap)
        for di, dj in _NB:
            a, b = i + di, j + dj
            if 0 <= a < ny and 0 <= b < nx and not closed[a, b]:
                closed[a, b] = True
                ne = max(z[a, b], e + eps)
                filled[a, b] = ne
                heapq.heappush(heap, (ne, a, b))
    return filled


def d8_directions(filled: np.ndarray, res: float) -> np.ndarray:
    """Flat index of the steepest-descent neighbour for every cell (-1 = outlet)."""
    ny, nx = filled.shape
    pad = np.pad(filled, 1, mode="edge")
    best = np.zeros(filled.shape)
    down = -np.ones(filled.shape, dtype=np.int64)
    ii, jj = np.mgrid[0:ny, 0:nx]
    for (di, dj), d in zip(_NB, _ND):
        nb = pad[1 + di:1 + di + ny, 1 + dj:1 + dj + nx]
        drop = (filled - nb) / (d * res)
        a, b = ii + di, jj + dj
        inside = (a >= 0) & (a < ny) & (b >= 0) & (b < nx)
        better = inside & (drop > best)
        best = np.where(better, drop, best)
        down = np.where(better, a * nx + b, down)
    return down.ravel()


def flow_accumulation(filled: np.ndarray, down: np.ndarray) -> np.ndarray:
    order = np.argsort(-filled.ravel(), kind="stable")
    acc = np.ones(filled.size)
    for idx in order:
        d = down[idx]
        if d >= 0:
            acc[d] += acc[idx]
    return acc.reshape(filled.shape)


def hand(z: np.ndarray, filled: np.ndarray, down: np.ndarray, stream: np.ndarray) -> np.ndarray:
    """Height Above Nearest Drainage, following D8 paths to a stream cell."""
    zf, st = z.ravel(), stream.ravel()
    base = np.zeros(z.size)
    for idx in np.argsort(filled.ravel(), kind="stable"):
        d = down[idx]
        base[idx] = zf[idx] if (st[idx] or d < 0) else base[d]
    return np.maximum(zf - base, 0).reshape(z.shape)


def analyse(z: np.ndarray, res: float, water_mask: np.ndarray, stream_cells: int = 400) -> dict:
    """All terrain layers the feature extractor needs, as grids."""
    filled = priority_flood(z)
    down = d8_directions(filled, res)
    acc = flow_accumulation(filled, down)
    stream = water_mask | (acc >= stream_cells)
    gy, gx = np.gradient(z, res)
    win = max(3, int(300 / res) | 1)
    if water_mask.any():
        dist_water = distance_transform_edt(~water_mask) * res
    else:
        dist_water = np.full(z.shape, 2000.0)
    return {
        "elev": z,
        "rel_elev": z - uniform_filter(z, size=win, mode="nearest"),
        "depression": np.clip(filled - z, 0, None),
        "hand": hand(z, filled, down, stream),
        "log_acc": np.log10(acc),
        "slope": np.degrees(np.arctan(np.hypot(gx, gy))),
        "dist_water": np.minimum(dist_water, 2000.0),
    }


def impervious_from_roads(road_mask: np.ndarray, res: float) -> np.ndarray:
    """Proxy for sealed surface when no land-cover raster is available:
    share of road cells within ~150 m, rescaled to 0.1-0.9."""
    density = uniform_filter(road_mask.astype(float), size=max(3, int(150 / res)), mode="nearest")
    ref = np.percentile(density, 95) or 1.0
    return np.clip(0.1 + 0.8 * density / ref, 0.1, 0.9)
