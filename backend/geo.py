"""Small geo helpers: a local metric projection and a regular raster grid."""
import math
from dataclasses import dataclass

import numpy as np

EARTH_R = 6371000.0


class LocalProjection:
    """Equirectangular projection around a centre point. Accurate to well
    under 1% for areas a few km across, which is all an Area Pack covers."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.ky = EARTH_R * math.pi / 180.0
        self.kx = self.ky * math.cos(math.radians(lat0))

    def to_xy(self, lat, lon):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def to_latlon(self, x, y):
        return self.lat0 + np.asarray(y) / self.ky, self.lon0 + np.asarray(x) / self.kx


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


@dataclass
class Grid:
    """Raster grid in local metres. Row i is at y = ymin + (i + 0.5) * res."""
    xmin: float
    ymin: float
    res: float
    ny: int
    nx: int

    @classmethod
    def around(cls, half_size_m: float, res: float = 10.0) -> "Grid":
        n = int(round(2 * half_size_m / res))
        return cls(-half_size_m, -half_size_m, res, n, n)

    def cell_centres(self):
        xs = self.xmin + (np.arange(self.nx) + 0.5) * self.res
        ys = self.ymin + (np.arange(self.ny) + 0.5) * self.res
        return np.meshgrid(xs, ys)

    def index(self, x, y):
        j = np.clip(((np.asarray(x) - self.xmin) / self.res).astype(int), 0, self.nx - 1)
        i = np.clip(((np.asarray(y) - self.ymin) / self.res).astype(int), 0, self.ny - 1)
        return i, j

    def rasterize_lines(self, lines, width_m: float = 0.0) -> np.ndarray:
        """Mark cells touched by polylines (list of [(x, y), ...])."""
        mask = np.zeros((self.ny, self.nx), dtype=bool)
        step = self.res / 2.0
        for line in lines:
            for (x1, y1), (x2, y2) in zip(line[:-1], line[1:]):
                n = max(2, int(math.hypot(x2 - x1, y2 - y1) / step) + 1)
                xs, ys = np.linspace(x1, x2, n), np.linspace(y1, y2, n)
                i, j = self.index(xs, ys)
                mask[i, j] = True
        if width_m > self.res:
            from scipy.ndimage import binary_dilation
            mask = binary_dilation(mask, iterations=int(width_m / self.res / 2))
        return mask
