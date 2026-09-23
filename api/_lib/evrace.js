// EVRACE registry: Redis snapshot + gentle sequential refresh.
// Same stack as auth.js — plain ESM + @upstash/redis.
//
// GET /api/evrace/stations  → read Redis only (never scrapes evrace.by)
// GET /api/cron/evrace-refresh → sequential fetch → write Redis

import { Redis } from '@upstash/redis';

const EVRACE_API = 'https://evrace.by/api/stations-page';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1200;
const REQUEST_TIMEOUT_MS = 12000;
const REFRESH_DEADLINE_MS = 55000;

const META_KEY = 'vigo:evrace:meta';
const CHUNK_KEY_PREFIX = 'vigo:evrace:chunk:';
const GROUPS_PER_CHUNK = 350;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

let memoryCache = null;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (error) {
    console.error('[evrace] Redis init failed:', error);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(offset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${EVRACE_API}?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ru,en;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Referer: 'https://evrace.by/',
        Origin: 'https://evrace.by',
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    if (response.status === 429) {
      throw new Error('EVRACE rate-limited (429). Retry later.');
    }
    if (!response.ok) {
      throw new Error(`EVRACE HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }
    if (!contentType.includes('json') || body.trimStart().startsWith('<')) {
      throw new Error(`EVRACE non-JSON (${contentType || 'none'}): ${body.slice(0, 180)}`);
    }

    const payload = JSON.parse(body);
    const groups = Array.isArray(payload?.groups)
      ? payload.groups
      : Array.isArray(payload?.stations)
        ? payload.stations
        : [];
    const total = Number(payload?.meta?.total_groups ?? payload?.total_groups ?? payload?.meta?.total);
    return { groups, totalGroups: Number.isFinite(total) ? total : undefined };
  } finally {
    clearTimeout(timer);
  }
}

function groupId(group) {
  return String(
    group?.location_id ?? group?.id ?? `${group?.latitude}:${group?.longitude}:${group?.address ?? ''}`
  );
}

async function fetchAllGroupsLive() {
  const deadline = Date.now() + REFRESH_DEADLINE_MS;
  const first = await fetchPage(0);
  if (!first.groups.length) throw new Error('EVRACE returned no station groups');

  const totalGroups = Math.max(first.groups.length, first.totalGroups ?? first.groups.length);
  const unique = new Map();
  for (const group of first.groups) {
    const id = groupId(group);
    if (!unique.has(id)) unique.set(id, group);
  }

  let failedPages = 0;
  for (let offset = PAGE_SIZE; offset < totalGroups; offset += PAGE_SIZE) {
    if (Date.now() >= deadline) {
      failedPages += Math.ceil((totalGroups - offset) / PAGE_SIZE);
      console.warn(`[evrace] refresh deadline at offset=${offset}`);
      break;
    }
    await sleep(PAGE_DELAY_MS);
    try {
      const page = await fetchPage(offset);
      for (const group of page.groups) {
        const id = groupId(group);
        if (!unique.has(id)) unique.set(id, group);
      }
    } catch (error) {
      failedPages++;
      console.error(`[evrace] page offset=${offset} failed:`, error);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('429')) await sleep(8000);
      else await sleep(2000);
    }
  }

  return {
    groups: Array.from(unique.values()),
    totalGroups,
    fetchedAt: Date.now(),
    failedPages,
  };
}

async function writeRegistryToRedis(redis, registry) {
  const chunks = [];
  for (let i = 0; i < registry.groups.length; i += GROUPS_PER_CHUNK) {
    chunks.push(registry.groups.slice(i, i + GROUPS_PER_CHUNK));
  }

  const meta = {
    fetchedAt: registry.fetchedAt,
    totalGroups: registry.totalGroups,
    groupsStored: registry.groups.length,
    failedPages: registry.failedPages,
    chunkCount: chunks.length,
  };

  for (let i = 0; i < chunks.length; i++) {
    await redis.set(`${CHUNK_KEY_PREFIX}${i}`, chunks[i], { ex: CACHE_TTL_SECONDS });
  }
  await redis.set(META_KEY, meta, { ex: CACHE_TTL_SECONDS });

  for (let i = chunks.length; i < chunks.length + 8; i++) {
    try {
      await redis.del(`${CHUNK_KEY_PREFIX}${i}`);
    } catch {
      /* ignore */
    }
  }
}

async function readRegistryFromRedis(redis) {
  const meta = await redis.get(META_KEY);
  if (!meta || !meta.chunkCount || !meta.fetchedAt) return null;

  const groups = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const chunk = await redis.get(`${CHUNK_KEY_PREFIX}${i}`);
    if (Array.isArray(chunk)) groups.push(...chunk);
  }
  if (!groups.length) return null;

  return {
    groups,
    totalGroups: meta.totalGroups || groups.length,
    fetchedAt: meta.fetchedAt,
    failedPages: meta.failedPages || 0,
  };
}

async function loadRegistry() {
  if (memoryCache) return memoryCache;

  const redis = getRedis();
  if (!redis) {
    console.warn('[evrace] Redis env missing');
    return null;
  }

  try {
    const fromRedis = await readRegistryFromRedis(redis);
    if (fromRedis) {
      memoryCache = fromRedis;
      return fromRedis;
    }
  } catch (error) {
    console.error('[evrace] Redis read failed:', error);
  }
  return null;
}

function groupCoordinates(group) {
  const poles = Array.isArray(group?.poles) ? group.poles : [];
  for (const pole of poles) {
    const lat = Number(pole?.lat ?? pole?.latitude);
    const lon = Number(pole?.lng ?? pole?.lon ?? pole?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  const lat = Number(group?.lat ?? group?.latitude);
  const lon = Number(group?.lng ?? group?.lon ?? group?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return null;
}

export async function getEvraceGroups(bbox) {
  const registry = await loadRegistry();
  if (!registry?.groups?.length) return [];

  if (!bbox) return registry.groups;

  return registry.groups.filter((group) => {
    const point = groupCoordinates(group);
    return (
      !!point &&
      point.lat >= bbox.minLat &&
      point.lat <= bbox.maxLat &&
      point.lon >= bbox.minLon &&
      point.lon <= bbox.maxLon
    );
  });
}

export async function getEvraceStats() {
  const registry = memoryCache ?? (await loadRegistry());
  if (!registry) {
    return {
      cached: false,
      expiresAt: null,
      totalGroups: null,
      stale: null,
      failedPages: null,
      ageMs: null,
      redisConfigured: !!getRedis(),
    };
  }
  const age = Date.now() - registry.fetchedAt;
  return {
    cached: true,
    expiresAt: registry.fetchedAt + CACHE_TTL_SECONDS * 1000,
    totalGroups: registry.totalGroups,
    groupsStored: registry.groups.length,
    stale: age >= 24 * 60 * 60 * 1000,
    failedPages: registry.failedPages,
    ageMs: age,
    redisConfigured: true,
  };
}

export async function forceRefreshEvraceCache() {
  const fresh = await fetchAllGroupsLive();
  memoryCache = fresh;

  const redis = getRedis();
  if (!redis) {
    console.warn('[evrace] refresh in memory only — Redis env not set');
    return fresh;
  }

  try {
    await writeRegistryToRedis(redis, fresh);
  } catch (error) {
    console.error('[evrace] Redis write failed:', error);
  }

  return fresh;
}
