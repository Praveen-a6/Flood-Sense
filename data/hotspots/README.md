# Known waterlogging hotspots (optional)

Put one or more `*.geojson` files here. Every road segment within **100 m** of a
point gets `hotspot_100m = 1` the next time an Area Pack is built for that area.

Good sources: city corporation "vulnerable / waterlogging spots" lists, past
news reports of flooded subways and roads, or points your own team mapped.

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "name": "Example subway" },
      "geometry": { "type": "Point", "coordinates": [80.2210, 12.9802] } }
  ]
}
```

Coordinates are `[longitude, latitude]` (GeoJSON order).
