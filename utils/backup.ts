import { TripSession, UserSettings } from '../types';

export interface ParsedBackup {
  sessions: TripSession[];
  settings?: Partial<UserSettings>;
  /** Trips in the file that were skipped because they were malformed. */
  skipped: number;
  dateRange: { from: string; to: string } | null;
}

export type BackupParseResult =
  | { ok: true; backup: ParsedBackup }
  | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, fallback = 0) => (isNum(v) ? v : fallback);

/**
 * Validates one imported trip. Only fills in *missing* fields so that data produced by this app
 * passes through untouched, while hand-edited / foreign files can't crash the History screen
 * (which calls .toFixed() etc. on these numbers).
 */
function normalizeSession(raw: unknown, index: number): TripSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isNum(s.startSoc) || !isNum(s.endSoc) || !isNum(s.distanceKm)) return null;
  if (typeof s.date !== 'string' || !s.date) return null;

  const createdAtFromDate = Date.parse(s.date);
  return {
    ...(s as unknown as TripSession),
    id: typeof s.id === 'string' && s.id ? s.id : `import-${Date.now()}-${index}`,
    createdAt: isNum(s.createdAt) ? s.createdAt : Number.isFinite(createdAtFromDate) ? createdAtFromDate : Date.now(),
    energyUsedKwh: num(s.energyUsedKwh),
    consumptionPer100Km: num(s.consumptionPer100Km),
    kmPerKwh: num(s.kmPerKwh),
    totalCost: num(s.totalCost),
    gasCostEquivalent: num(s.gasCostEquivalent),
    moneySaved: num(s.moneySaved),
    chargingType: (typeof s.chargingType === 'string' ? s.chargingType : 'custom') as TripSession['chargingType'],
    roadType: (s.roadType === 'city' || s.roadType === 'highway' || s.roadType === 'mixed' ? s.roadType : 'mixed'),
    climateOn: typeof s.climateOn === 'boolean' ? s.climateOn : false,
  };
}

export function parseBackup(text: string): BackupParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Файл не похож на JSON-бэкап. Выберите файл, скачанный из этого приложения.' };
  }

  const rawSessions: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).sessions)
      ? (parsed as any).sessions
      : null;
  if (!rawSessions) {
    return { ok: false, error: 'В файле не найден список поездок.' };
  }

  const sessions: TripSession[] = [];
  rawSessions.forEach((r, i) => {
    const n = normalizeSession(r, i);
    if (n) sessions.push(n);
  });
  const skipped = rawSessions.length - sessions.length;

  if (sessions.length === 0 && rawSessions.length > 0) {
    return { ok: false, error: 'Ни одна запись в файле не прошла проверку — файл повреждён или из другого приложения.' };
  }

  const settingsRaw = !Array.isArray(parsed) ? (parsed as any).settings : undefined;
  const settings = settingsRaw && typeof settingsRaw === 'object' ? (settingsRaw as Partial<UserSettings>) : undefined;

  const dates = sessions.map((s) => s.date).sort();
  return {
    ok: true,
    backup: {
      sessions,
      settings,
      skipped,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    },
  };
}

const fingerprint = (s: TripSession) => `${s.date}|${s.distanceKm}|${s.startSoc}|${s.endSoc}`;

/**
 * Merge imported trips into the current list: a trip is considered a duplicate if it has the same id
 * OR the same date/distance/SOC fingerprint (covers backups re-imported after ids were regenerated).
 * The result is newest-first, matching how the app prepends new trips.
 */
export function mergeSessions(current: TripSession[], imported: TripSession[]): { merged: TripSession[]; added: number } {
  const ids = new Set(current.map((s) => s.id));
  const prints = new Set(current.map(fingerprint));
  const fresh = imported.filter((s) => !ids.has(s.id) && !prints.has(fingerprint(s)));
  const merged = [...current, ...fresh].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { merged, added: fresh.length };
}

export function pluralTrips(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} поездка`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} поездки`;
  return `${n} поездок`;
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
};
export const formatDateRange = (r: { from: string; to: string } | null) =>
  r ? (r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} — ${fmtDate(r.to)}`) : '';
