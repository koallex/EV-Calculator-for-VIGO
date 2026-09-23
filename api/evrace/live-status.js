// Proxy to EVRace operator live-status endpoints (browser CORS blocks direct calls).
// GET /api/evrace/live-status?operator=forevo&ids=id1,id2

const LIVE_APIS = {
  zaryadka: 'https://evrace.by/api/live-zaryadka-status',
  evika: 'https://evrace.by/api/live-evika-status',
  malanka: 'https://evrace.by/api/live-malanka-status',
  batteryfly: 'https://evrace.by/api/live-batteryfly-status',
  forevo: 'https://evrace.by/api/live-forevo-status',
};

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const operator = String(req.query?.operator || '').toLowerCase().trim();
  const idsRaw = String(req.query?.ids || '').trim();
  const base = LIVE_APIS[operator];
  if (!base) {
    return res.status(400).json({
      error: 'Unknown operator',
      allowed: Object.keys(LIVE_APIS),
    });
  }
  if (!idsRaw) {
    return res.status(200).json({ updated_at: null, poles: [] });
  }

  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  try {
    const url = `${base}?ids=${encodeURIComponent(ids.join(','))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (compatible; VigoEVCalculator/1.0; +https://vercel.app)',
        Referer: 'https://evrace.by/map',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) {
      return res.status(502).json({
        error: `EVRace live ${response.status}`,
        message: text.slice(0, 200),
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'Invalid JSON from EVRace' });
    }
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).json({
      operator,
      updated_at: data.updated_at ?? null,
      poles: Array.isArray(data.poles) ? data.poles : [],
    });
  } catch (error) {
    console.error('[live-status]', operator, error);
    return res.status(502).json({
      error: 'Live status unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
