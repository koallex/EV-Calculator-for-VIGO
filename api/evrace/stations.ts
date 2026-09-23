import { getEvraceGroups, getEvraceStats } from '../_lib/evrace';

export const config = { maxDuration: 60 };

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
    const hasBbox = [minLat, maxLat, minLon, maxLon].every(v => v !== undefined);

    const groups = await getEvraceGroups(hasBbox ? { minLat: minLat!, maxLat: maxLat!, minLon: minLon!, maxLon: maxLon! } : undefined);
    const stats = await getEvraceStats();

    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.setHeader('X-EVRACE-Cache', stats.cached ? (stats.stale ? 'stale' : 'warm') : 'cold');
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
      },
    });
  } catch (error) {
    return res.status(502).json({
      error: 'EVRACE unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
