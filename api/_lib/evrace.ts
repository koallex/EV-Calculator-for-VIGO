// EVRACE registry loader.
//
// v1.05 change: the full ~1200-station registry used to be paginated (20/page) and cached only
// in a module-level variable. On Vercel that in-memory cache does not survive between cold
// starts, so most requests re-did the entire paginated fetch inline while the user was waiting
// for /api/evrace/stations to answer — easily 5-10s of sequential/parallel network round trips,
// which blows past the 10s hard execution limit on Vercel's Hobby plan (the `maxDuration: 60`
// config in api/evrace/stations.ts only takes effect on Pro/Enterprise). That produced exactly
// the symptom reported: EVRACE requests timing out and no stations coming back.
//
// Fix: persist the registry in Upstash Redis (already used for auth, see api/_lib/auth.js) with
// a stale-while-revalidate policy. Warm requests read Redis (a few ms) and never touch evrace.by
// at all. When the cache is older than SOFT_TTL_MS we still answer immediately from the stale
// copy and kick off a background refresh (not awaited) guarded by a short-lived Redis lock so
// concurrent invocations don't all refresh at once. Only the very first request ever (empty
// Redis) pays for a live fetch, and even that is now far cheaper: page size raised from 20 to
// 100 so ~1200 stations is ~12 pages, fetched with higher concurrency, so it usually completes
// in a single round trip. A daily cron endpoint (api/cron/evrace-refresh.ts) also forces a
// refresh so the cache should, in steady state, never need to fall back to a blocking fetch.
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const EVRACE_API = 'https://evrace.by/api/stations-page';

const PAGE_SIZE = 100; // was 20; evrace.by pagination is offset/limit-based, so a larger page
                        // just means fewer round trips — if the API caps `limit` server-side,
                        // pagination still finishes correctly, just in more pages.
const MAX_CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 4500;
const PAGE_RETRIES = 1; // one retry before a page is treated as failed, instead of silently
                         // dropping ~100 stations on a single flaky request.

// v1.06 fix: a live fetch used to have no overall time budget — with PAGE_RETRIES it could take
// up to ~9s just for a single page (2 attempts x 4.5s) before even starting the rest, which on
// Vercel Hobby's 10s hard execution limit got the function killed mid-request. That surfaces to
// the browser as a bare 500 with no body (FUNCTION_INVOCATION_FAILED), not our own 502 handler.
// Every live fetch is now bounded by a wall-clock deadline: individual request timeouts shrink
// to whatever time is left, and once the deadline passes we stop and return whatever pages we
// already have instead of risking the whole function. See loadRegistry() below for the other
// half of the fix — the common request path no longer blocks on a live fetch at all.
const LIVE_FETCH_DEADLINE_MS = 8000;

const CACHE_KEY = 'vigo:evrace:groups';
const LOCK_KEY = 'vigo:evrace:refresh-lock';
const LOCK_TTL_SECONDS = 90;

const SOFT_TTL_MS = 6 * 60 * 60 * 1000;   // serve as fresh; no refresh needed
const HARD_TTL_MS = 3 * 24 * 60 * 60 * 1000; // beyond this we still serve it (better than
                                              // nothing) but flag it as stale in stats

interface CachedRegistry { groups: any[]; totalGroups: number; fetchedAt: number; failedPages: number; }

// Per-instance memory cache in front of Redis so a warm Lambda instance handling several
// requests in a row doesn't do a Redis round trip for every single one.
let memoryCache: CachedRegistry | null = null;
const MEMORY_TTL_MS = 5 * 60 * 1000;
let memoryCachedAt = 0;

let inflightBackgroundRefresh: Promise<void> | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchPage = async (offset: number, deadline: number): Promise<{ groups: any[]; totalGroups?: number }> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 300) {
      lastError = lastError ?? new Error('EVRACE page fetch skipped: out of time budget');
      break;
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${EVRACE_API}?limit=${PAGE_SIZE}&offset=${offset}`, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ru,en;q=0.8',
          // A distinctive User-Agent is an easy signal for Cloudflare's bot management to flag
          // and block outright, independent of any timeout. Use a realistic browser UA instead
          // — this alone won't defeat an active JS/Turnstile challenge (see the comment above
          // fetchPage), but it avoids being trivially fingerprinted as a script.
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
          Referer: 'https://evrace.by/stations',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        // Cloudflare's interstitial challenge page is commonly served as a 403/503 HTML
        // response. Surface that distinctly from an ordinary HTTP error so it's obvious in
        // logs whether this is "evrace.by is down" or "we're being blocked by Cloudflare".
        const blocked = response.status === 403 || response.status === 503;
        throw new Error(`EVRACE ${response.status}${blocked ? ' (possible Cloudflare block — check for a JS challenge / cf_clearance requirement)' : ''}`);
      }
      if (!contentType.includes('application/json')) {
        // A 200 response that isn't JSON is very likely a Cloudflare "under attack" / managed
        // challenge page returned with a 200 status (it serves the interstitial HTML directly
        // so the browser's JS can run and solve it) — a plain server-side fetch can't solve
        // that. Fail loudly instead of letting response.json() throw an opaque parse error.
        const snippet = (await response.text()).slice(0, 200);
        throw new Error(`EVRACE returned non-JSON (content-type: ${contentType || 'none'}); likely a Cloudflare challenge page. Body starts: ${snippet}`);
      }
      const payload = await response.json();
      const groups = Array.isArray(payload?.groups) ? payload.groups : [];
      const totalGroups = Number(payload?.meta?.total_groups ?? payload?.total_groups);
      return { groups, totalGroups: Number.isFinite(totalGroups) ? totalGroups : undefined };
    } catch (e) {
      lastError = e;
      const remainingAfter = deadline - Date.now();
      if (attempt < PAGE_RETRIES && remainingAfter > 800) await sleep(Math.min(300, remainingAfter - 500));
    } finally {
      clearTimeout(timer);
    }
  }
  console.error(`[evrace] page offset=${offset} failed after ${PAGE_RETRIES + 1} attempt(s):`, lastError);
  throw lastError;
};

// Live paginated fetch of the whole registry. Bounded by LIVE_FETCH_DEADLINE_MS so a single
// invocation can never run long enough to risk the platform killing the function (see the
// comment on LIVE_FETCH_DEADLINE_MS above). If the deadline is hit, whatever pages were already
// fetched are kept and the rest are counted as failed — the caller (loadRegistry /
// refreshInBackground) will simply try again on the next refresh rather than lose the request.
const fetchAllGroupsLive = async (): Promise<CachedRegistry> => {
  const deadline = Date.now() + LIVE_FETCH_DEADLINE_MS;
  const first = await fetchPage(0, deadline);
  const totalGroups = first.totalGroups ?? first.groups.length;
  if (!first.groups.length) throw new Error('EVRACE returned no station groups');

  const offsets: number[] = [];
  for (let offset = PAGE_SIZE; offset < totalGroups; offset += PAGE_SIZE) offsets.push(offset);

  const pages: any[][] = [];
  let failedPages = 0;
  for (let i = 0; i < offsets.length; i += MAX_CONCURRENCY) {
    if (Date.now() >= deadline) {
      failedPages += offsets.length - i;
      console.error(`[evrace] live fetch hit its time budget with ${offsets.length - i} page(s) still unfetched`);
      break;
    }
    const batch = offsets.slice(i, i + MAX_CONCURRENCY);
    const result = await Promise.all(batch.map(async offset => {
      try {
        return (await fetchPage(offset, deadline)).groups;
      } catch {
        failedPages++;
        return [];
      }
    }));
    pages.push(...result);
  }

  const groups = [first.groups, ...pages].flat();
  const unique = new Map<string, any>();
  for (const group of groups) {
    const id = String(group?.location_id ?? `${group?.latitude}:${group?.longitude}:${group?.address ?? ''}`);
    if (!unique.has(id)) unique.set(id, group);
  }

  if (failedPages > 0) {
    console.error(`[evrace] live fetch finished with ${failedPages} failed/skipped page(s) out of ${offsets.length + 1}`);
  }

  return { groups: Array.from(unique.values()), totalGroups, fetchedAt: Date.now(), failedPages };
};

// v1.07 fix: this await had no timeout of its own. loadRegistry() no longer blocks on a live
// EVRACE fetch (see v1.06 above), but it still blocks on this Redis read — and if Upstash is
// slow or briefly unreachable, that single await can itself run long enough to hit Vercel
// Hobby's 10s hard execution limit, producing the exact same bodiless FUNCTION_INVOCATION_FAILED
// (bare 500, no JSON) as the bug v1.06 fixed, just from a different cause. Race it against a
// short timeout so a stalled Redis call degrades to "treat as cache miss" (which still answers
// immediately, per loadRegistry's empty-result path) instead of hanging the function.
const REDIS_READ_TIMEOUT_MS = 3000;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis read timed out after ${ms}ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });

const readRedisCache = async (): Promise<CachedRegistry | null> => {
  try {
    const cached = await withTimeout(redis.get<CachedRegistry>(CACHE_KEY), REDIS_READ_TIMEOUT_MS);
    return cached ?? null;
  } catch (e) {
    console.error('[evrace] Redis read failed:', e);
    return null;
  }
};

const writeRedisCache = async (data: CachedRegistry) => {
  try {
    await redis.set(CACHE_KEY, data);
  } catch (e) {
    // A Redis write failure shouldn't break the response — the caller already has the data
    // in hand, we just won't have persisted it for the next invocation.
    console.error('[evrace] Redis write failed:', e);
  }
};

const tryAcquireLock = async (): Promise<boolean> => {
  try {
    const ok = await redis.set(LOCK_KEY, '1', { nx: true, ex: LOCK_TTL_SECONDS });
    return ok === 'OK';
  } catch {
    return false;
  }
};

const releaseLock = async () => {
  try { await redis.del(LOCK_KEY); } catch { /* best-effort */ }
};

// Fire-and-forget refresh, guarded by a Redis lock so multiple warm instances that all decide
// the cache is stale at the same time don't all hammer evrace.by in parallel. Also deduped
// within this instance so several concurrent requests on the same warm Lambda share one attempt.
const refreshInBackground = (): Promise<void> => {
  if (inflightBackgroundRefresh) return inflightBackgroundRefresh;
  inflightBackgroundRefresh = (async () => {
    if (!(await tryAcquireLock())) return;
    try {
      const fresh = await fetchAllGroupsLive();
      await writeRedisCache(fresh);
      memoryCache = fresh;
      memoryCachedAt = Date.now();
    } catch (e) {
      console.error('[evrace] background refresh failed:', e);
    } finally {
      await releaseLock();
    }
  })().finally(() => { inflightBackgroundRefresh = null; });
  return inflightBackgroundRefresh;
};

// Used by the cron/admin refresh endpoint: always does a live fetch and persists it, regardless
// of current cache freshness.
export const forceRefreshEvraceCache = async (): Promise<CachedRegistry> => {
  const fresh = await fetchAllGroupsLive();
  await writeRedisCache(fresh);
  memoryCache = fresh;
  memoryCachedAt = Date.now();
  return fresh;
};

const loadRegistry = async (): Promise<CachedRegistry> => {
  if (memoryCache && Date.now() - memoryCachedAt < MEMORY_TTL_MS) return memoryCache;

  const cached = await readRedisCache();
  if (cached) {
    memoryCache = cached;
    memoryCachedAt = Date.now();
    const age = Date.now() - cached.fetchedAt;
    if (age > SOFT_TTL_MS) refreshInBackground(); // stale-while-revalidate: don't block on it
    return cached;
  }

  // Nothing cached anywhere yet (first request since a fresh deploy / empty Redis). Do NOT
  // block this request on a live fetch — even the deadline-bounded version can take several
  // seconds, and doing that inline on every request until the cache fills would repeatedly eat
  // into the platform's execution budget for no reason once one of them succeeds. Kick off a
  // single lock-guarded background refresh and answer immediately with an explicitly-empty,
  // labelled-as-uncached result. In steady state this is essentially never hit, because the
  // cache is kept warm by stale-while-revalidate refreshes plus the daily cron — it's mainly
  // reachable right after a fresh deploy, which is exactly why EVRACE_FIX.md recommends hitting
  // /api/cron/evrace-refresh once manually right after deploying.
  refreshInBackground();
  // v1.07: also seed the per-instance memory cache with this empty stub (previously only the
  // hit path did this). Without it, getEvraceStats()'s own readRedisCache() call — made right
  // after this one, in the same request — paid a second full Redis round trip (and a second
  // REDIS_READ_TIMEOUT_MS in the worst case) for a call this request already just made.
  const empty: CachedRegistry = { groups: [], totalGroups: 0, fetchedAt: 0, failedPages: 0 };
  memoryCache = empty;
  memoryCachedAt = Date.now();
  return empty;
};

const groupCoordinates = (group: any): { lat: number; lon: number } | null => {
  const directLat = Number(group?.latitude ?? group?.lat);
  const directLon = Number(group?.longitude ?? group?.lng ?? group?.lon);
  if (Number.isFinite(directLat) && Number.isFinite(directLon)) return { lat: directLat, lon: directLon };

  const poles = Array.isArray(group?.poles) ? group.poles : [];
  const coords = poles.map((pole: any) => ({
    lat: Number(pole?.lat ?? pole?.latitude),
    lon: Number(pole?.lng ?? pole?.lon ?? pole?.longitude),
  })).filter((p: { lat: number; lon: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!coords.length) return null;
  return {
    lat: coords.reduce((sum: number, p: { lat: number }) => sum + p.lat, 0) / coords.length,
    lon: coords.reduce((sum: number, p: { lon: number }) => sum + p.lon, 0) / coords.length,
  };
};

export const getEvraceGroups = async (bbox?: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}) => {
  const registry = await loadRegistry();
  if (!bbox) return registry.groups;
  return registry.groups.filter(group => {
    const point = groupCoordinates(group);
    return !!point
      && point.lat >= bbox.minLat && point.lat <= bbox.maxLat
      && point.lon >= bbox.minLon && point.lon <= bbox.maxLon;
  });
};

export const getEvraceStats = async () => {
  const registry = memoryCache ?? await readRedisCache();
  if (!registry) return { cached: false, expiresAt: null, totalGroups: null, stale: null, failedPages: null };
  const age = Date.now() - registry.fetchedAt;
  return {
    cached: true,
    expiresAt: registry.fetchedAt + SOFT_TTL_MS,
    totalGroups: registry.totalGroups,
    stale: age > HARD_TTL_MS,
    failedPages: registry.failedPages,
    ageMs: age,
  };
};
