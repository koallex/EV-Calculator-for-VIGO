# EVRACE integration fix v1.04

- EVRACE `/api/stations-page` returns `groups`; station coordinates and connector types are stored inside each group's `poles`.
- Route bbox filtering now derives coordinates from poles, so groups are no longer discarded as coordinate-less.
- EVRACE normalization now reads `gun1_type..gun4_type`, `dc_power` and `ac_power` from poles.
- CCS/GBT/Type2 detection works with the actual EVRACE pole schema.
- Route query buffer increased to 10 km before final route-line filtering at 3 km.
- Proxy page concurrency increased and request timeout reduced to make the initial registry warm-up faster.
- EVRACE proxy has a 60-second Vercel function budget for the initial registry load.
- OSM fallback remains available.
