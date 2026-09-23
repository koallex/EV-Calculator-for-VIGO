import { getEvraceGroups, getEvraceStats } from '../_lib/evrace';

// Snapshot read is fast; keep a small budget only for Redis RTT.
export const config = { maxDuration: 15 };

const numberParam = (value: unknown): number | undefined => {
  if (Array.isArray(value)) value = value[0];
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const minLat = numberParam(req.query.minLat);
    const maxLat = numberParam(req.query.maxLat);
    const minLon = numberParam(req.query.minLon);
    const maxLon = numberParam(req.query.maxLon);
    const hasBbox = [minLat, maxLat, minLon, maxLon].every((v) => v !== undefined);

    const groups = await getEvraceGroups(
      hasBbox
        ? { minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! }
        : undefined
    );
    const stats = await getEvraceStats();

    // Empty snapshot is not a platform failure — client falls back to OSM.
    // Surface a clear hint so operators know to run the cron once after deploy.
    if (!groups.length && !stats.cached) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        source: 'evrace',
        groups: [],
        meta: {
          total_groups: 0,
          returned_groups: 0,
          filtered: hasBbox,
          cache: false,
          stale: null,
          failed_pages: null,
          redis_configured: stats.redisConfigured ?? false,
          hint: stats.redisConfigured
            ? 'Snapshot empty. Run GET /api/cron/evrace-refresh once after deploy (Authorization: Bearer CRON_SECRET).'
            : 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing on this deployment.',
        },
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    return res.status(200).json({
      source: 'evrace',
      groups,
      meta: {
        total_groups: stats.totalGroups ?? groups.length,
        returned_groups: groups.length,
        filtered: hasBbox,
        cache: stats.cached,
        stale: stats.stale,
        failed_pages: stats.failedPages,
        age_ms: stats.ageMs,
        redis_configured: stats.redisConfigured ?? true,
      },
    });
  } catch (error) {
    console.error('[evrace-proxy] request failed:', error);
    return res.status(502).json({
      error: 'EVRACE unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
