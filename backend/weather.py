"""Live weather from Open-Meteo (free, no API key).

Returns the same structure as demo_city.demo_weather() so the frontend and
the model treat live and demo data the same way.
"""
import json
import time
from pathlib import Path

import requests

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
CACHE = Path(__file__).resolve().parent.parent / "data" / "cache"


def rain_features(past: list, nxt: list) -> dict:
    """past = hourly mm, oldest first, ending with the current hour."""
    def last(h):
        return round(float(sum(past[-h:])), 1) if past else 0.0
    return {"rain_1h": last(1), "rain_3h": last(3), "rain_24h": last(24), "rain_72h": last(72),
            "rain_fc_3h": round(float(sum(nxt[:3])), 1)}


def parse_open_meteo(js: dict) -> dict:
    times, precip = js["hourly"]["time"], js["hourly"]["precipitation"]
    precip = [p or 0.0 for p in precip]
    now = js.get("current", {}).get("time", time.strftime("%Y-%m-%dT%H:00"))
    now_hour = now[:13] + ":00"
    idx = max((i for i, t in enumerate(times) if t <= now_hour), default=len(times) - 1)
    past, nxt = precip[max(0, idx - 71): idx + 1], precip[idx + 1: idx + 25]
    cur = js.get("current", {})
    return {
        "source": "Open-Meteo (live)",
        "as_of": now,
        "current": {
            "temp_c": cur.get("temperature_2m"),
            "wind_kmh": cur.get("wind_speed_10m"),
            "gust_kmh": cur.get("wind_gusts_10m"),
            "humidity": cur.get("relative_humidity_2m"),
            "precip_mm": cur.get("precipitation"),
        },
        "rain": rain_features(past, nxt),
        "hourly_past": [round(p, 2) for p in past],
        "hourly_next": [round(p, 2) for p in nxt],
    }


def fetch_weather(lat: float, lon: float, timeout: float = 12.0) -> dict:
    params = {
        "latitude": round(lat, 4), "longitude": round(lon, 4),
        "hourly": "precipitation",
        "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m",
        "past_days": 3, "forecast_days": 2, "timezone": "auto",
    }
    r = requests.get(OPEN_METEO, params=params, timeout=timeout)
    r.raise_for_status()
    data = parse_open_meteo(r.json())
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"weather_{lat:.3f}_{lon:.3f}.json").write_text(json.dumps(data))
    return data
