// OSM/Overpass proxy for charging-station queries.
// Multiple public Overpass instances are tried in parallel-ish sequence. One unavailable
// mirror must not make the charging search fail if another mirror can answer.
export const config = { maxDuration: 15 };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

const REQUEST_TIMEOUT_MS = 6500;

const numberParam = (value: unknown): number | undefined => {
  if (Array.isArray(value)) value = value[0];
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const fetchOverpass = async (endpoint: string, query: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': 'EV-Calculator-for-VIGO/1.01',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const south = numberParam(req.query.south);
  const west = numberParam(req.query.west);
  const north = numberParam(req.query.north);
  const east = numberParam(req.query.east);
  if ([south, west, north, east].some(v => v === undefined)) {
    return res.status(400).json({ error: 'Missing or invalid bbox params (south, west, north, east required)' });
  }

  // Keep the query reasonably cheap. charging_station is the useful source for the app; the
  // extra fuel/charge-point variants are queried only if the first query succeeds elsewhere.
  const query = `[out:json][timeout:15];nwr["amenity"="charging_station"](${south},${west},${north},${east});out center tags;`;
  const errors: string[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchOverpass(endpoint, query, REQUEST_TIMEOUT_MS);
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
      return res.status(200).json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${new URL(endpoint).hostname}: ${message}`);
      console.error(`[osm-proxy] ${endpoint} failed:`, error);
    }
  }

  return res.status(502).json({
    error: 'OSM/Overpass unavailable',
    message: errors.join(' | '),
  });
}
