# Real flood labels (optional, recommended)

Create `real_labels.csv` in this folder. Each row = one road segment during one
rain situation. Columns:

* all 18 feature names, in any order:
  `elev_m, rel_elev_300m, depression_m, hand_m, log_flow_acc, slope_deg, impervious,
  dist_water_m, underpass, bridge, road_code, hotspot_100m,
  rain_1h, rain_3h, rain_24h, rain_72h, rain_fc_3h, reservoir_release`
* plus **either** `depth_cm` (measured / reported depth) **or** `depth_class`
  (0 = <5 cm, 1 = 5-15 cm, 2 = 15-30 cm, 3 = >30 cm)

How to get them: build an Area Pack for a city that had a documented flood,
take the segment features (`segments[i].f`) for roads that were reported
flooded (news, SAR flood map, hotspot list) and the rain from that day (IMD /
Open-Meteo historical), and write one row each. Add dry roads from the same
day as negatives.

Then:

```bash
python -m ml.synth_labels   # real rows are mixed in with 3x weight
python -m ml.train
```
