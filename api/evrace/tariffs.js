// Proxy + parse EVRace public tariffs page (https://evrace.by/tariffs).
// GET /api/evrace/tariffs → { source, updated_at, operators: [...] }

export const config = { maxDuration: 15 };

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://evrace.by/tariffs', {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (compatible; VigoEVCalculator/1.0; +https://vercel.app)',
        'Accept-Language': 'ru,en;q=0.8',
        Referer: 'https://evrace.by/',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const html = await response.text();
    if (!response.ok) {
      return res.status(502).json({
        error: `EVRace tariffs ${response.status}`,
        message: html.slice(0, 200),
      });
    }
    const operators = parseTariffsHtml(html);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      source: 'https://evrace.by/tariffs',
      updated_at: new Date().toISOString(),
      operators,
    });
  } catch (error) {
    console.error('[evrace/tariffs]', error);
    return res.status(502).json({
      error: 'Tariffs unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
