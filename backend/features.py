"""Shared definitions: feature order, road classes, travel modes.

The SAME feature order is used by the trainer (Python) and by the
in-browser model (JavaScript). The pack carries `feature_names` so the
frontend never has to guess.
"""

# Static features: computed once per road segment while building an Area Pack.
STATIC_FEATURES = [
    "elev_m",            # ground elevation (m)
    "rel_elev_300m",     # elevation minus the 300 m neighbourhood mean (negative = low spot)
    "depression_m",      # how deep water can pond here before it spills (m)
    "hand_m",            # height above nearest drainage (m)
    "log_flow_acc",      # log10 of upstream cells draining through this point
    "slope_deg",         # terrain slope (degrees)
    "impervious",        # 0..1 share of sealed surface around the road
    "dist_water_m",      # distance to river / canal / lake (m)
    "underpass",         # 1 if tunnel / road below grade
    "bridge",            # 1 if on a bridge
    "road_code",         # 0 = major arterial ... 4 = minor / service
    "hotspot_100m",      # 1 if a known waterlogging hotspot is within 100 m
]

# Dynamic features: refreshed from live weather OR the user's manual rain input.
RAIN_FEATURES = [
    "rain_1h",           # mm in the last hour
    "rain_3h",           # mm in the last 3 hours
    "rain_24h",          # mm in the last 24 hours
    "rain_72h",          # mm in the last 72 hours
    "rain_fc_3h",        # mm forecast for the next 3 hours
    "reservoir_release", # 1 if an upstream reservoir is releasing water
]

FEATURE_NAMES = STATIC_FEATURES + RAIN_FEATURES

# Depth classes the model predicts.
CLASS_EDGES_CM = [5.0, 15.0, 30.0]
CLASS_LABELS = ["Dry (<5 cm)", "Shallow (5-15 cm)", "Deep (15-30 cm)", "Impassable (>30 cm)"]

# OSM highway tag -> road code (0 = biggest road).
ROAD_CODE = {
    "motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0,
    "primary": 1, "primary_link": 1,
    "secondary": 1, "secondary_link": 1,
    "tertiary": 2, "tertiary_link": 2, "road": 2,
    "unclassified": 3, "residential": 3, "living_street": 3,
    "service": 4,
}

# Typical urban speeds per road code (km/h) used for travel-time costs.
SPEED_KMH = {0: 50, 1: 40, 2: 30, 3: 25, 4: 15}


def road_code(highway: str) -> int:
    return ROAD_CODE.get(highway or "", 3)
