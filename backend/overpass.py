"""Server-side relay for Overpass queries (backend/main.py: POST /api/overpass).

Why this exists: the browser city builder (frontend/js/cityengine.js) talks to
the public Overpass mirrors DIRECTLY - that is the fast path and works on most
home and mobile networks. But on locked-down networks (college or office Wi-Fi,
some ISPs) every foreign Overpass host is blocked, while the FloodSense server
that delivered the app in the first place stays reachable. The browser then asks
THIS server to run the same query on its own uplink: same five public mirrors,
tried with the patience a server can afford, and whatever one of them returns is
streamed back and cached on the phone like any other chunk.

The relay is deliberately NOT a general-purpose proxy: it accepts exactly one
Overpass QL query (must start with [out:json], hard size cap) for a fixed list
of public mirrors - nothing else can be fetched through it.
"""
import logging
import time

import requests

log = logging.getLogger("floodsense")

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "FloodSense/2.0 (offline city-pack builder; server-side Overpass relay)"

MAX_QUERY_CHARS = 200_000          # a 3x3 km FloodSense chunk query is ~1.5 KB
TOTAL_TIMEOUT = 260.0              # the browser gives the relay 300 s - always answer before that
READ_TIMEOUT = 120.0               # a mirror that has not sent a byte in 2 min is hanging, not busy

# Sticky mirror health (process memory): (consecutive failures, last attempt, last success),
# monotonic clocks. A mirror that just answered is tried FIRST next time; one that keeps
# failing is tried later and later. News older than 15 min stops counting, so a mirror can
# recover without a server restart. This is what makes multi-chunk builds through the relay
# viable: only the first chunk pays for walking past the hanging mirrors.
_health: dict[str, tuple[int, float, float]] = {}


def _mirror_order() -> list[str]:
    now = time.monotonic()

    def rank(u):
        fails, last, ok = _health.get(u, (0, 0.0, 0.0))
        if now - last > 900:                        # stale news does not count
            fails = 0
        return (fails, -ok)                         # healthy and recently-good mirrors first

    return sorted(MIRRORS, key=rank)


def _validate(query: str) -> str:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("missing 'query' (Overpass QL text)")
    if not query.lstrip().startswith("[out:json]"):
        raise ValueError("query must be an Overpass QL statement starting with [out:json]")
    if len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"query too long (max {MAX_QUERY_CHARS} chars)")
    return query


def relay_overpass(query: str, total_timeout: float = TOTAL_TIMEOUT) -> dict:
    """POST the query to every public mirror until one answers with an Overpass
    response (sticky order: recently healthy mirrors first). Bounded by
    total_timeout so the caller always sees an answer instead of a cut
    connection. Raises ValueError for a bad query and RuntimeError (one line
    per attempt) when nothing answered."""
    _validate(query)
    t0 = time.monotonic()
    errors: list[str] = []
    for lap in range(2):
        for url in _mirror_order():
            if time.monotonic() - t0 > total_timeout:
                break
            name = url.split("/")[2]
            attempt_t0 = time.monotonic()
            try:
                r = requests.post(url, data={"data": query}, timeout=(10, READ_TIMEOUT),
                                  headers={"User-Agent": USER_AGENT})
                if r.status_code in (429, 504):
                    raise RuntimeError(f"mirror busy (HTTP {r.status_code})")
                r.raise_for_status()
                data = r.json()
                if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
                    raise RuntimeError("not an Overpass JSON response")
                if not data["elements"] and data.get("remark"):
                    raise RuntimeError(f"server remark: {data['remark']}")
                _health[url] = (0, time.monotonic(), time.monotonic())
                log.info("overpass relay: %s answered in %.0f s", name, time.monotonic() - attempt_t0)
                return data
            except Exception as ex:               # timeout, DNS, connection, HTTP, JSON errors
                fails, _, ok = _health.get(url, (0, 0.0, 0.0))
                _health[url] = (fails + 1, time.monotonic(), ok)
                errors.append(f"{name}: {ex}")
                log.info("overpass relay: %s failed after %.0f s: %s", name, time.monotonic() - attempt_t0, ex)
        if time.monotonic() - t0 > total_timeout:
            break
    raise RuntimeError("; ".join(errors) or "no mirror reachable")
