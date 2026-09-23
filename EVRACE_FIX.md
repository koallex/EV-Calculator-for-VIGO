# EVRACE integration fix v1.04

- EVRACE `/api/stations-page` returns `groups`; station coordinates and connector types are stored inside each group's `poles`.
- Route bbox filtering now derives coordinates from poles, so groups are no longer discarded as coordinate-less.
- EVRACE normalization now reads `gun1_type..gun4_type`, `dc_power` and `ac_power` from poles.
- CCS/GBT/Type2 detection works with the actual EVRACE pole schema.
- Route query buffer increased to 10 km before final route-line filtering at 3 km.
- Proxy page concurrency increased and request timeout reduced to make the initial registry warm-up faster.
- EVRACE proxy has a 60-second Vercel function budget for the initial registry load.
- OSM fallback remains available.

# EVRACE integration fix v1.05 — timeouts on route calculation

**Symptom:** stations not found when calculating a route; EVRACE requests failing/timing out.

**Root cause:** the full registry (~1200 stations) was paginated 20/page and cached only in a
module-level variable in `api/_lib/evrace.ts`. On Vercel that in-memory cache doesn't survive
between cold starts, so most requests re-did the entire paginated fetch inline while the user
waited on `/api/evrace/stations`. That easily took 5-10s+, which exceeds the **10-second hard
execution limit on Vercel's Hobby plan** — the `maxDuration: 60` in `api/evrace/stations.ts`
only takes effect on Pro/Enterprise, so on Hobby it was silently capped at 10s and the request
was killed mid-fetch.

**Fix:**
- The registry is now cached in Upstash Redis (same Redis already used for auth, see
  `api/_lib/auth.js`), not just in memory. Warm requests read Redis (a few ms) instead of
  hitting evrace.by at all.
- Stale-while-revalidate: once the cached copy is older than 6h, requests still get an instant
  answer from the stale copy while a refresh runs in the background (`refreshInBackground` in
  `api/_lib/evrace.ts`), guarded by a short Redis lock so parallel warm instances don't all
  refresh at once.
- Page size raised from 20 to 100 and fetch concurrency raised, so even the first-ever
  (cache-empty) fetch is ~12 requests instead of ~60 and usually completes in one round trip.
- Failed pages are retried once instead of being silently dropped (previously a single flaky
  page request quietly lost ~20, now ~100, stations from the result with no visibility into it).
- New `api/cron/evrace-refresh.ts`, wired into `vercel.json` as a daily cron (Vercel Hobby only
  allows daily cron schedules), forces a fresh registry pull independent of user traffic — mainly
  a safety net so the cache is never fully cold, e.g. right after a fresh deploy. Can also be
  triggered manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/evrace-refresh`.
  Set the `CRON_SECRET` env var to protect it; without it the endpoint is open (fine for local dev
  via `server.ts`, not recommended for production).
- `chargingStations.ts` and `CalculatorTab.tsx` now `console.error` the real failure reason
  instead of silently swallowing it, so future issues are visible in the browser console.
- Requires `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to be set (already required for
  auth) — without them the Redis cache silently fails to read/write and the code falls back to
  live-fetching on every cold start, i.e. the old behavior.

## Open question: Cloudflare (v1.05, same day)

A captured browser request to `evrace.by/api/stations-page` carries a `cf_clearance` cookie —
issued only after a browser passes Cloudflare's JS/Turnstile challenge. A plain server-side
`fetch()` from a Vercel function cannot solve that challenge. This may be the actual root cause
(or a second, compounding one) rather than pure timeouts:

- `fetchPage` now uses a realistic browser `User-Agent` instead of `VIGO-EV-Calculator/1.0` —
  the old value was an easy signal for Cloudflare's bot management to flag outright, independent
  of any timeout.
- Added explicit detection: a non-JSON `content-type` on a 200 response, or a 403/503 status, is
  now logged as a likely Cloudflare-challenge block rather than surfacing as an opaque JSON-parse
  error.
- **Still needs verification against the live API** (not reachable from this environment) that
  `/api/stations-page` doesn't actually require `cf_clearance` — Cloudflare protection is often
  scoped to specific paths/zones, so the API endpoint may not be gated even though the site
  itself is behind Cloudflare. Deploy this and check the `/api/cron/evrace-refresh` response /
  Vercel function logs; the error message will now say explicitly whether it looks like a
  Cloudflare block. If it is genuinely blocked, the realistic options are: a headless-browser
  proxy (e.g. FlareSolverr or a scraping API) that solves the challenge and supplies a fresh
  `cf_clearance` periodically, or asking EVRACE for documented API access — a plain server fetch
  cannot solve an active JS challenge on its own.

# EVRACE integration fix v1.06 — bare 500 from /api/evrace/stations

**Symptom:** browser console showed `EVRACE proxy 500` (a raw HTTP 500 with no JSON body) plus,
separately, `overpass-api.de` failing with a CORS error and the second Overpass mirror timing
out — so both station sources came back empty at once.

**Root cause of the 500:** a bug introduced by the v1.05 retry logic. `fetchPage` retried once
on failure with its own 4.5s timeout each try — for the very first page of a cold cache that's
up to ~9.3s *before even starting the rest of the registry*, which on Vercel Hobby's 10-second
hard execution limit gets the function killed mid-request. A killed function returns a bare
platform 500 (`FUNCTION_INVOCATION_FAILED`) with no body — not the `502` our own `catch` block
returns — which is exactly what showed up in the browser as `EVRACE proxy 500`.

**Fix:**
- Every live fetch (`fetchAllGroupsLive`) is now bounded by a hard wall-clock deadline
  (`LIVE_FETCH_DEADLINE_MS`, 8s): individual page timeouts shrink to whatever time is left, and
  once the deadline passes the function stops and returns whatever pages it already has instead
  of risking getting killed. Comfortably under the 10s Hobby limit either way.
- More importantly, **the common request path (`/api/evrace/stations`) no longer blocks on a
  live fetch at all.** If nothing is cached yet (fresh deploy, empty Redis), it now answers
  immediately with an empty, explicitly-uncached result and kicks off a lock-guarded background
  refresh — the same pattern already used for stale-cache refreshes. Only the dedicated
  `/api/cron/evrace-refresh` endpoint (and the daily cron) still does a live fetch inline, and
  that one is now deadline-bounded too.
- Net effect: a user-facing request can no longer crash the function, no matter how slow or
  blocked evrace.by is. Worst case it just returns an empty EVRACE result (OSM fallback still
  applies) until the cache warms up — which is why hitting `/api/cron/evrace-refresh` once
  right after deploying still matters, otherwise the first real users hit the empty-cache path.

**Separate, not-yet-fixed issue:** the OSM/Overpass fallback (`fetchOsmStationsAlongRoute` in
`src/services/chargingStations.ts`) calls `overpass-api.de` and `overpass.kumi.systems` directly
from the browser. `overpass-api.de` is currently failing with a CORS error (no
`Access-Control-Allow-Origin` header on its response) and the `kumi.systems` mirror is timing
out — this looks like temporary trouble with those public mirrors rather than something in this
codebase, but it means the OSM fallback can't currently cover for EVRACE being cold/blocked.
Worth adding more mirrors and/or proxying Overpass through our own backend (same CORS-avoidance
reasoning as the EVRACE proxy) if this keeps happening.
