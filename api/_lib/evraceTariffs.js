// EVRace tariffs: scrape https://evrace.by/tariffs, with a Redis-backed last-known-good
// snapshot so a temporary scrape failure (site down, layout change, timeout, rate limit)
// never blanks out pricing for users — it falls back to the last successful snapshot and
// flags the response as `stale` instead of erroring.
//
// Same stack as evrace.js — plain ESM + @upstash/redis.

import { Redis } from '@upstash/redis';

const TARIFFS_URL = 'https://evrace.by/tariffs';
const SNAPSHOT_KEY = 'vigo:evrace:tariffs:snapshot';
// Generous horizon: pricing rarely changes day to day, so keep serving the last known
// snapshot for a while even if evrace.by stays unreachable for an extended period.
const SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 30;

let memorySnapshot = null;

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (error) {
    console.error('[evrace/tariffs] Redis init failed:', error);
    return null;
  }
}

function parseNum(s) {
  if (s == null) return null;
  const m = String(s)
    .replace(/\s/g, '')
    .replace(',', '.')
    .match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Typical network tariff cards on /tariffs:
 * <span class="tariffs-op …"><span class="d-dot …"></span>BatteryFly</span>
 * … DC day/night tbl__num values, optional AC.
 */
function parseTariffsHtml(html) {
  const operators = [];
  const seen = new Set();
  const re =
    /<span class="tariffs-op[^"]*"[^>]*>\s*<span class="d-dot[^"]*"[^>]*><\/span>([^<]+)<\/span>[\s\S]{0,200}?tariffs-card-date[^>]*>([^<]+)<\/span>[\s\S]{0,400}?tariffs-card-axis--dc([\s\S]{0,500}?)(?=tariffs-card-axis--ac|tariffs-card-floor)/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = String(m[1] || '').trim();
    if (!name || name.length > 48) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const asOf = String(m[2] || '').trim() || null;
    const dcBlock = m[3] || '';
    const day = dcBlock.match(/tariffs-period__day[\s\S]*?tbl__num[^>]*>([^<]+)/i);
    const night = dcBlock.match(/tariffs-period__n[^>]*>([^<]+)/i);

    const after = html.slice(m.index, m.index + 1400);
    const acBlock = after.match(
      /tariffs-card-axis--ac([\s\S]{0,400}?)(?=tariffs-card-floor|<\/a>)/i,
    );
    const acDay = acBlock ? acBlock[1].match(/tbl__num[^>]*>([^<]+)/i) : null;
    const floorMatch = after.match(/tariffs-card-floor[^>]*>([\s\S]*?)<\/p>/i);
    const metaMatch = after.match(/tariffs-card-meta[^>]*>([\s\S]*?)<\/p>/i);

    const before = html.slice(Math.max(0, m.index - 240), m.index);
    const href = before.match(/\/operators\/([a-z0-9-]+)/i);

    const dcDay = parseNum(day && day[1]);
    const dcNight = parseNum(night && night[1]);
    const acDayVal = parseNum(acDay && acDay[1]);
    if (dcDay == null && dcNight == null && acDayVal == null) continue;

    operators.push({
      id: href ? href[1].toLowerCase() : key.replace(/\s+/g, ''),
      name,
      asOf,
      dcDay,
      dcNight,
      acDay: acDayVal,
      floor: floorMatch
        ? String(floorMatch[1])
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : null,
      meta: metaMatch
        ? String(metaMatch[1])
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : null,
    });
  }
  return operators;
}

async function fetchLiveTariffs() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(TARIFFS_URL, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (compatible; VigoEVCalculator/1.0; +https://vercel.app)',
        'Accept-Language': 'ru,en;q=0.8',
        Referer: 'https://evrace.by/',
      },
      signal: controller.signal,
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`EVRace tariffs HTTP ${response.status}: ${html.slice(0, 180)}`);
    }
    const operators = parseTariffsHtml(html);
    if (!operators.length) {
      throw new Error('EVRace tariffs: parsed 0 operators (page layout may have changed)');
    }
    return operators;
  } finally {
    clearTimeout(timer);
  }
}

async function readSnapshot(redis) {
  if (memorySnapshot) return memorySnapshot;
  if (!redis) return null;
  try {
    const snap = await redis.get(SNAPSHOT_KEY);
    if (snap && Array.isArray(snap.operators) && snap.operators.length && snap.fetchedAt) {
      memorySnapshot = snap;
      return snap;
    }
  } catch (error) {
    console.error('[evrace/tariffs] Redis read failed:', error);
  }
  return null;
}

async function writeSnapshot(redis, operators) {
  const snap = { operators, fetchedAt: Date.now() };
  memorySnapshot = snap;
  if (!redis) return;
  try {
    await redis.set(SNAPSHOT_KEY, snap, { ex: SNAPSHOT_TTL_SECONDS });
  } catch (error) {
    console.error('[evrace/tariffs] Redis write failed:', error);
  }
}

/**
 * Used by the /api/evrace/tariffs route: tries a live scrape first (freshest data), and on
 * any failure falls back to the last successful snapshot (Redis, or in-memory for a warm
 * instance), marking the result `stale`. Returns null only when there is truly nothing to
 * serve yet (e.g. first ever deploy, before any successful scrape).
 */
export async function getTariffsWithFallback() {
  const redis = getRedis();
  try {
    const operators = await fetchLiveTariffs();
    await writeSnapshot(redis, operators);
    return { operators, fetchedAt: Date.now(), stale: false };
  } catch (error) {
    console.error('[evrace/tariffs] live scrape failed, falling back to snapshot:', error);
    const snap = await readSnapshot(redis);
    if (snap) return { operators: snap.operators, fetchedAt: snap.fetchedAt, stale: true };
    return null;
  }
}

/** Used by the daily cron job to keep the Redis snapshot warm independent of user traffic. */
export async function refreshTariffsSnapshot() {
  const redis = getRedis();
  const operators = await fetchLiveTariffs();
  await writeSnapshot(redis, operators);
  return { operators, fetchedAt: Date.now() };
}
