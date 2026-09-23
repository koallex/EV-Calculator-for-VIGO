# EVRACE integration

## v1.06 — snapshot-first (fixes FUNCTION_INVOCATION_FAILED)

**Symptom:** `/api/evrace/stations` → Vercel `500 FUNCTION_INVOCATION_FAILED` (fra1). OSM still worked.

**Cause:** Each request live-scraped the full BY registry (~13 pages) from `evrace.by`. Hobby time limit + Cloudflare 429 on parallel fetches killed the function.

**Fix:**
- User path only **reads** a Redis snapshot (same Upstash as login).
- Live fetch only in `/api/cron/evrace-refresh`, **sequential** with delays.
- Registry stored in chunked keys `vigo:evrace:meta` + `vigo:evrace:chunk:N`.

See **EVRACE_SETUP.md** for Vercel env, cron, and post-deploy warm-up.

## Earlier notes

- EVRACE `/api/stations-page` returns `groups`; coordinates and connectors live in each group's `poles` (`gun1_type`…, `dc_power`, `ac_power`).
- Client merges EVRACE + OSM; EVRACE failure must not block OSM.
