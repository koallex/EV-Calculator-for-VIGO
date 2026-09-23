# EVRACE integration fix

- EVRACE response is parsed from `groups` (not `stations/items/...`).
- Pagination metadata uses `meta.total_groups`.
- Browser no longer calls `evrace.by` directly.
- Vercel/local server proxy: `/api/evrace/stations`.
- Proxy caches EVRACE station groups in memory and filters them by route bounding box before returning them to the app.
- Existing OSM fallback remains unchanged.

Deployment: Vercel will deploy `api/evrace/stations.ts` automatically as a serverless function.
