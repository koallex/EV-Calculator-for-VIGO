// Proxy for EVRace public tariffs (https://evrace.by/tariffs), backed by a Redis snapshot.
// GET /api/evrace/tariffs → { source, updated_at, operators: [...], stale }
//
// If evrace.by is temporarily unreachable (or its page layout breaks parsing), this serves
// the last successful snapshot instead of erroring, marked `stale: true`, so clients never
// see prices disappear because of a transient upstream hiccup.

import { getTariffsWithFallback } from '../_lib/evraceTariffs.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await getTariffsWithFallback();
    if (!result) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        error: 'Tariffs unavailable',
        message: 'EVRace unreachable and no cached snapshot exists yet.',
      });
    }

    res.setHeader(
      'Cache-Control',
      result.stale
        ? 'public, s-maxage=60, stale-while-revalidate=300'
        : 'public, s-maxage=3600, stale-while-revalidate=7200',
    );
    return res.status(200).json({
      source: result.stale ? 'cache' : 'https://evrace.by/tariffs',
      updated_at: new Date(result.fetchedAt).toISOString(),
      stale: result.stale,
      operators: result.operators,
    });
  } catch (error) {
    console.error('[evrace/tariffs] unexpected failure:', error);
    return res.status(502).json({
      error: 'Tariffs unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
