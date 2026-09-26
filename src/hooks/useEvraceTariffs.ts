import { useEffect, useState } from 'react';
import type { UserSettings } from '../types';
import { loadCachedEvraceTariffs, saveCachedEvraceTariffs } from '../utils/storage';

export type EvraceTariff = {
  id: string;
  name: string;
  dcDay: number | null;
  dcNight: number | null;
  acDay: number | null;
  asOf?: string | null;
  floor?: string | null;
};

/**
 * Finds the EVRace tariff card matching a station/operator name (or one of our internal
 * canonical operator keys: 'malanka' | 'zaryadka' | 'evika' | 'batteryfly' | 'forevo' | 'united').
 */
export function matchEvraceTariff(operator: string, tariffs: EvraceTariff[]): EvraceTariff | null {
  if (!tariffs.length) return null;
  const o = operator.toLowerCase().replace(/\s+/g, '');
  const aliases: Record<string, string[]> = {
    zaryadka: ['zaryadka', 'зарядка', 'zaryad'],
    malanka: ['malanka', 'маланка', 'csms', 'цсмс'],
    batteryfly: ['batteryfly', 'battery'],
    forevo: ['forevo'],
    evika: ['evika', 'белтелеком'],
    united: ['united', 'unitedcompany'],
  };
  for (const t of tariffs) {
    const id = t.id.toLowerCase();
    const name = t.name.toLowerCase().replace(/\s+/g, '');
    if (o.includes(id) || o.includes(name) || (o && name.includes(o))) return t;
    if ((aliases[id] || []).some((a) => o.includes(a))) return t;
  }
  return null;
}

type TariffsState = {
  tariffs: EvraceTariff[];
  /** ms timestamp of the last data we're showing (fresh or cached). */
  updatedAt: number | null;
  /** true when the displayed data is not from the latest successful live fetch
   *  (came from cache / a previous fetch, because the most recent attempt failed). */
  stale: boolean;
  loading: boolean;
};

let sharedState: TariffsState = { tariffs: [], updatedAt: null, stale: false, loading: true };
const listeners = new Set<(s: TariffsState) => void>();
let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let retryDelayMs = 20_000;

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

function notify() {
  listeners.forEach((l) => l(sharedState));
}

function setSharedState(patch: Partial<TariffsState>) {
  sharedState = { ...sharedState, ...patch };
  notify();
}

async function fetchTariffs() {
  try {
    const r = await fetch('/api/evrace/tariffs', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    const list = Array.isArray(data?.operators) ? data.operators : [];
    if (!list.length) throw new Error('empty operators list');

    const parsed: EvraceTariff[] = list.map((o: any) => ({
      id: String(o.id || ''),
      name: String(o.name || o.id || ''),
      dcDay: o.dcDay ?? null,
      dcNight: o.dcNight ?? null,
      acDay: o.acDay ?? null,
      asOf: o.asOf ?? null,
      floor: o.floor ?? null,
    }));
    const updatedAt = Date.now();
    // The server itself may be serving its own last-known-good snapshot (data.stale) if
    // evrace.by was unreachable when it refreshed — still valid data, just flagged as such.
    const stale = !!data?.stale;
    setSharedState({ tariffs: parsed, updatedAt, stale, loading: false });
    saveCachedEvraceTariffs({ operators: parsed, updatedAt });
    retryDelayMs = 20_000;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  } catch {
    // Network/parse failure: never wipe what we already have — keep showing the last known
    // prices (from an earlier fetch, or from localStorage) and just mark them stale, then
    // retry sooner than the normal poll interval with backoff.
    setSharedState({ loading: false, stale: sharedState.tariffs.length > 0 ? true : sharedState.stale });
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        fetchTariffs();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function ensureStarted() {
  if (started) return;
  started = true;

  const cached = loadCachedEvraceTariffs();
  if (cached?.operators?.length) {
    sharedState = {
      tariffs: cached.operators as EvraceTariff[],
      updatedAt: cached.updatedAt ?? null,
      stale: true,
      loading: true,
    };
  }

  fetchTariffs();
  pollTimer = setInterval(fetchTariffs, POLL_INTERVAL_MS);
}

/**
 * Shared EVRace tariffs feed: fetched once per app session (not once per component), cached to
 * localStorage so prices show instantly on next load, and never cleared by a failed refresh —
 * a temporary evrace.by outage keeps showing the last known prices (marked `stale`) instead of
 * blanking out the map/settings.
 */
export function useEvraceTariffs(): TariffsState {
  const [state, setState] = useState<TariffsState>(sharedState);
  useEffect(() => {
    ensureStarted();
    listeners.add(setState);
    setState(sharedState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/**
 * Maps live EVRace operator tariffs onto our own settings fields, for regions (Belarus) where
 * public ЭЗС pricing should be taken automatically from EVRace rather than typed in manually.
 * Only returns fields for operators EVRace actually reports a price for, so a temporary gap in
 * one operator's data never overwrites a previously-known price with `undefined`.
 */
export function deriveOperatorSettingsFromEvrace(tariffs: EvraceTariff[]): Partial<UserSettings> {
  const out: Partial<UserSettings> = {};

  const malanka = matchEvraceTariff('malanka', tariffs);
  if (malanka) {
    if (malanka.dcDay != null) {
      out.malankaDcTariff = malanka.dcDay;
      out.fastDayTariff = malanka.dcDay;
    }
    if (malanka.dcNight != null) out.fastNightTariff = malanka.dcNight;
    if (malanka.acDay != null) {
      out.malankaAcTariff = malanka.acDay;
      out.slowPublicTariff = malanka.acDay;
    }
  }

  const evika = matchEvraceTariff('evika', tariffs);
  if (evika) {
    const rate = evika.acDay ?? evika.dcDay;
    if (rate != null) out.evikaTariff = rate;
  }

  const batteryfly = matchEvraceTariff('batteryfly', tariffs);
  if (batteryfly) {
    const rate = batteryfly.dcDay ?? batteryfly.acDay;
    if (rate != null) out.batteryFlyTariff = rate;
  }

  const zaryadka = matchEvraceTariff('zaryadka', tariffs);
  if (zaryadka) {
    if (zaryadka.dcDay != null) {
      out.zaryadkaDayTariff = zaryadka.dcDay;
      out.zaryadkaTariff = zaryadka.dcDay;
      out.zaryadkaDcTariff = zaryadka.dcDay;
    }
    if (zaryadka.dcNight != null) out.zaryadkaNightTariff = zaryadka.dcNight;
    if (zaryadka.acDay != null) out.zaryadkaAcTariff = zaryadka.acDay;
  }

  return out;
}
