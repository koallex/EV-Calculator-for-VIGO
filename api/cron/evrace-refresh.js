import { forceRefreshEvraceCache } from '../_lib/evrace.js';
import { refreshTariffsSnapshot } from '../_lib/evraceTariffs.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${expected}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Stations and tariffs are independent snapshots — one failing (e.g. tariffs page layout
  // changed) should not stop the other from refreshing, and both keep serving their last
  // good snapshot to users regardless of what happens here.
  const [stationsResult, tariffsResult] = await Promise.allSettled([
    forceRefreshEvraceCache(),
    refreshTariffsSnapshot(),
  ]);

  if (stationsResult.status === 'rejected') {
    console.error('[evrace] cron stations refresh failed:', stationsResult.reason);
  }
  if (tariffsResult.status === 'rejected') {
    console.error('[evrace] cron tariffs refresh failed:', tariffsResult.reason);
  }

  const ok = stationsResult.status === 'fulfilled' || tariffsResult.status === 'fulfilled';
  return res.status(ok ? 200 : 502).json({
    ok,
    stations:
      stationsResult.status === 'fulfilled'
        ? {
            ok: true,
            totalGroups: stationsResult.value.totalGroups,
            groupsFetched: stationsResult.value.groups.length,
            failedPages: stationsResult.value.failedPages,
            fetchedAt: stationsResult.value.fetchedAt,
          }
        : { ok: false, error: String(stationsResult.reason?.message || stationsResult.reason) },
    tariffs:
      tariffsResult.status === 'fulfilled'
        ? {
            ok: true,
            operatorsFetched: tariffsResult.value.operators.length,
            fetchedAt: tariffsResult.value.fetchedAt,
          }
        : { ok: false, error: String(tariffsResult.reason?.message || tariffsResult.reason) },
  });
}
