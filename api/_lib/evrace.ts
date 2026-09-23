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

let inflightLive: Promise<CachedRegistry> | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchPage = async (offset: number): Promise<{ groups: any[]; totalGroups?: number }> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
      if (attempt < PAGE_RETRIES) await sleep(300);
    } finally {
      clearTimeout(timer);
    }
  }
  console.error(`[evrace] page offset=${offset} failed after ${PAGE_RETRIES + 1} attempt(s):`, lastError);
  throw lastError;
};

// Live paginated fetch of the whole registry. Only hit directly when there is no usable cache
// at all (first-ever run) or from the dedicated refresh endpoint/cron.
const fetchAllGroupsLive = async (): Promise<CachedRegistry> => {
  const first = await fetchPage(0);
  const totalGroups = first.totalGroups ?? first.groups.length;
  if (!first.groups.length) throw new Error('EVRACE returned no station groups');

  const offsets: number[] = [];
  for (let offset = PAGE_SIZE; offset < totalGroups; offset += PAGE_SIZE) offsets.push(offset);

  const pages: any[][] = [];
  let failedPages = 0;
  for (let i = 0; i < offsets.length; i += MAX_CONCURRENCY) {
    const batch = offsets.slice(i, i + MAX_CONCURRENCY);
    const result = await Promise.all(batch.map(async offset => {
      try {
        return (await fetchPage(offset)).groups;
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
    console.error(`[evrace] live fetch finished with ${failedPages} failed page(s) out of ${offsets.length + 1}`);
  }

  return { groups: Array.from(unique.values()), totalGroups, fetchedAt: Date.now(), failedPages };
};

const readRedisCache = async (): Promise<CachedRegistry | null> => {
  try {
    const cached = await redis.get<CachedRegistry>(CACHE_KEY);
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
// the cache is stale at the same time don't all hammer evrace.by in parallel.
const refreshInBackground = () => {
  (async () => {
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
  })();
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

  // Nothing cached anywhere yet (first-ever call). This is the one path that still has to wait
  // on a live fetch; dedupe concurrent callers within this instance so they share one fetch.
  if (!inflightLive) {
    inflightLive = fetchAllGroupsLive()
      .then(async fresh => { await writeRedisCache(fresh); memoryCache = fresh; memoryCachedAt = Date.now(); return fresh; })
      .finally(() => { inflightLive = null; });
  }
  return inflightLive;
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
