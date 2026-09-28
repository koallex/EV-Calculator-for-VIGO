/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { UserSettings, TripSession } from './types';
import {
  DEFAULT_SETTINGS,
  INITIAL_SESSIONS,
  loadSettings,
  saveSettings,
  loadSessions,
  saveSessions,
} from './utils/storage';
import { Header } from './components/Header';
import { Navigation, TabType } from './components/Navigation';
import { CalculatorTab } from './components/CalculatorTab';
import { HudTab } from './components/HudTab';
import { HistoryTab } from './components/HistoryTab';
import { ChargingTab } from './components/ChargingTab';
import { SettingsTab } from './components/SettingsTab';
import { AddTripModal } from './components/AddTripModal';
import { LoginScreen, AuthUser } from './components/LoginScreen';
import { AdminPanel } from './components/AdminPanel';
import { AboutProject } from './components/AboutProject';
import { useEvraceTariffs, deriveOperatorSettingsFromEvrace } from './hooks/useEvraceTariffs';
import { FeedbackProvider, useFeedback } from './components/ui/Feedback';
import { mergeSessions, pluralTrips } from './utils/backup';
import type { ImportMode } from './hooks/useBackupImport';

// Last successfully verified user. Used ONLY to let the app open when the server can't be reached
// (no signal on the road). It holds no credentials; every API call is still checked by the server.
const LAST_USER_KEY = 'vigo_last_user_v1';
const readCachedUser = (): AuthUser | null => {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u.login === 'string' && (u.role === 'admin' || u.role === 'user') ? u : null;
  } catch { return null; }
};
const writeCachedUser = (u: AuthUser) => { try { localStorage.setItem(LAST_USER_KEY, JSON.stringify(u)); } catch { /* ignore */ } };
const clearCachedUser = () => { try { localStorage.removeItem(LAST_USER_KEY); } catch { /* ignore */ } };
const AUTH_CHECK_TIMEOUT_MS = 8000;

function AppInner() {
  const { toast } = useFeedback();
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  // Bumped when settings are replaced from outside the Settings form (reset / import / undo),
  // so the form remounts with fresh values instead of showing — and later re-saving — stale ones.
  const [settingsFormKey, setSettingsFormKey] = useState(0);
  const offlineNotifiedRef = useRef(false);
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [sessions, setSessions] = useState<TripSession[]>(loadSessions);
  const [activeTab, setActiveTab] = useState<TabType>('calculator');
  const [isHudTracking, setIsHudTracking] = useState(false);
  // Route plan transferred from Calculator → HUD (destination + start SoC + optional charge stops)
  const [hudPlan, setHudPlan] = useState<import('./components/HudTab').HudRoutePlan | null>(null);

  // Modals
  const [isAddTripOpen, setIsAddTripOpen] = useState(false);
  const [addTripInitialData, setAddTripInitialData] = useState<Partial<TripSession> | undefined>(undefined);
  /**
   * Adaptive layout flags — breakpoints aligned with index.css tokens:
   *   xs 360 · sm 480 · md 640 · lg 900 · xl 1100
   *   landscape / landscape-short (h≤430) / landscape-comfortable (h≥500)
   */
  const [isLandscape, setIsLandscape] = useState(false);
  /** Bottom nav auto-hide on scroll down / show on scroll up */
  const [navVisible, setNavVisible] = useState(true);
  const lastScrollYRef = useRef(0);
  const scrollTickingRef = useRef(false);

  useEffect(() => {
    const mqLandscape = window.matchMedia('(orientation: landscape)');
    const mqShort = window.matchMedia('(max-height: 430px)');
    const mqComfort = window.matchMedia('(min-height: 500px)');
    const mqSm = window.matchMedia('(min-width: 480px)');
    const mqMd = window.matchMedia('(min-width: 640px)');
    const mqLg = window.matchMedia('(min-width: 900px)');
    const mqXl = window.matchMedia('(min-width: 1100px)');

    const update = () => {
      const landscape =
        mqLandscape.matches || window.innerWidth > window.innerHeight * 1.05;
      setIsLandscape(landscape);

      const root = document.documentElement;
      root.dataset.orientation = landscape ? 'landscape' : 'portrait';
      root.dataset.bp =
        mqXl.matches ? 'xl' :
        mqLg.matches ? 'lg' :
        mqMd.matches ? 'md' :
        mqSm.matches ? 'sm' : 'xs';
      if (landscape && mqShort.matches) root.dataset.heightBand = 'short';
      else if (landscape && mqComfort.matches) root.dataset.heightBand = 'comfortable';
      else root.dataset.heightBand = 'default';
    };

    update();
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener('resize', update, opts);
    window.addEventListener('orientationchange', update, opts);
    // matchMedia change is more reliable than resize on some mobile browsers
    const mqs = [mqLandscape, mqShort, mqComfort, mqSm, mqMd, mqLg, mqXl];
    mqs.forEach((mq) => {
      try {
        mq.addEventListener('change', update);
      } catch {
        // Safari < 14
        // @ts-expect-error legacy API
        mq.addListener?.(update);
      }
    });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      mqs.forEach((mq) => {
        try {
          mq.removeEventListener('change', update);
        } catch {
          // @ts-expect-error legacy API
          mq.removeListener?.(update);
        }
      });
    };
  }, []);

  // Hide floating nav on scroll down, show on scroll up (any scrollable surface).
  useEffect(() => {
    lastScrollYRef.current =
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;

    const getScrollY = () => {
      const main = document.querySelector('main');
      const candidates = [
        window.scrollY,
        document.documentElement.scrollTop,
        document.body.scrollTop,
        main && (main as HTMLElement).scrollTop,
      ].filter((v) => typeof v === 'number') as number[];
      return Math.max(0, ...candidates);
    };

    const onScroll = () => {
      if (scrollTickingRef.current) return;
      scrollTickingRef.current = true;
      window.requestAnimationFrame(() => {
        const y = getScrollY();
        const prev = lastScrollYRef.current;
        const delta = y - prev;
        // Ignore tiny jitter
        if (Math.abs(delta) < 6) {
          scrollTickingRef.current = false;
          return;
        }
        if (y < 24) {
          setNavVisible(true);
        } else if (delta > 0) {
          setNavVisible(false);
        } else {
          setNavVisible(true);
        }
        lastScrollYRef.current = y;
        scrollTickingRef.current = false;
      });
    };

    const opts: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener('scroll', onScroll, opts);
    document.addEventListener('scroll', onScroll, opts);
    const main = document.querySelector('main');
    main?.addEventListener('scroll', onScroll, opts);

    return () => {
      window.removeEventListener('scroll', onScroll, opts);
      document.removeEventListener('scroll', onScroll, opts);
      main?.removeEventListener('scroll', onScroll, opts);
    };
  }, []);

  // Always show nav when switching tabs
  useEffect(() => {
    setNavVisible(true);
  }, [activeTab]);

  // Server-side authentication. No credentials are stored in localStorage.
  // 401/403 → really signed out. Network error / timeout / 5xx → keep working with the last known
  // user (offline mode) instead of bouncing to the login screen, where signing in is impossible anyway.
  //
  // Also polled while the tab is open: a login on another device revokes this session in Redis,
  // and we must notice without waiting for a full page reload.
  const checkAuth = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        const wasLoggedIn = !!readCachedUser();
        clearCachedUser();
        setAuthUser(null);
        setShowAdmin(false);
        if (wasLoggedIn && silent) {
          toast({
            message: 'Сессия завершена: выполнен вход на другом устройстве.',
            durationMs: 5000,
          });
        }
        return;
      }
      if (!response.ok) throw new Error('server-unavailable');
      const data = await response.json();
      setAuthUser(data.user);
      writeCachedUser(data.user);
      offlineNotifiedRef.current = false;
    } catch {
      // Silent background checks must not kick the user into offline toast spam.
      if (silent) return;
      const cached = readCachedUser();
      setAuthUser((prev) => prev ?? cached);
      if (cached && !offlineNotifiedRef.current) {
        offlineNotifiedRef.current = true;
        toast({ message: 'Нет связи с сервером. Приложение открыто без проверки входа.', durationMs: 4500 });
      }
    } finally {
      window.clearTimeout(timer);
      if (!silent) setAuthChecking(false);
    }
  }, [toast]);

  useEffect(() => {
    void checkAuth();
    const onOnline = () => { void checkAuth({ silent: true }); };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkAuth({ silent: true });
    };
    const onFocus = () => { void checkAuth({ silent: true }); };
    // Catch single-session revocation while the tab stays open (~every 20s).
    const pollId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void checkAuth({ silent: true });
    }, 20_000);

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(pollId);
    };
  }, [checkAuth]);

  // Record an app-open event for the admin statistics. Fired once per mount
  // (i.e. once per real app open), independent of auth state, and never
  // allowed to break the app if it fails.
  const recordVisit = () => {
    fetch('/api/analytics/visit', { method: 'POST', credentials: 'same-origin' }).catch(() => {
      // Statistics are best-effort; ignore network errors.
    });
  };

  useEffect(() => {
    recordVisit();
  }, []);

  // A fresh login/registration doesn't remount the app, so the mount-time visit above
  // was recorded as anonymous (no session cookie yet). Record it again now that the
  // session exists, so this open is attributed to the user in the admin stats.
  const handleLogin = (user: AuthUser) => {
    setAuthUser(user);
    writeCachedUser(user);
    recordVisit();
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      clearCachedUser();
      setAuthUser(null);
      setShowAdmin(false);
      setActiveTab('calculator');
      serverPullDoneRef.current = false;
    }
  };

  // Sync settings & sessions to localStorage
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // Account cloud sync: localStorage is the offline working copy; Redis holds the durable
  // account copy. Pull merges (never replaces). Push is debounced and can be forced from Settings.
  type CloudSyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
  const [cloudSyncStatus, setCloudSyncStatus] = useState<CloudSyncStatus>('idle');
  const [cloudSyncedAt, setCloudSyncedAt] = useState<string | null>(null);
  const [cloudSyncDetail, setCloudSyncDetail] = useState('');
  const serverPullDoneRef = useRef(false);
  const skipNextPushRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const settingsRef = useRef(settings);
  sessionsRef.current = sessions;
  settingsRef.current = settings;

  /** Drop bulky debug trails before upload — keeps Redis payloads small. */
  const sessionsForCloud = useCallback((list: TripSession[]) => {
    return list.map((s) => {
      if (!s.hudWindLog || s.hudWindLog.length < 4000) return s;
      const { hudWindLog: _drop, ...rest } = s;
      return rest as TripSession;
    });
  }, []);

  const pushToCloud = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!authUser?.login) return false;
      if (!opts?.silent) setCloudSyncStatus('syncing');
      try {
        const res = await fetch('/api/user/data', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessions: sessionsForCloud(sessionsRef.current),
            settings: settingsRef.current,
          }),
        });
        if (res.status === 401 || res.status === 403) {
          setCloudSyncStatus('error');
          setCloudSyncDetail('Нужен повторный вход');
          return false;
        }
        if (!res.ok) throw new Error('push-failed');
        const data = await res.json().catch(() => ({}));
        setCloudSyncStatus('synced');
        setCloudSyncedAt(data.updatedAt || new Date().toISOString());
        setCloudSyncDetail('');
        return true;
      } catch {
        setCloudSyncStatus(navigator.onLine === false ? 'offline' : 'error');
        setCloudSyncDetail(navigator.onLine === false ? 'Нет сети' : 'Не удалось выгрузить');
        return false;
      }
    },
    [authUser?.login, sessionsForCloud],
  );

  const pullFromCloud = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!authUser?.login) return;
      if (!opts?.silent) setCloudSyncStatus('syncing');
      try {
        const res = await fetch('/api/user/data', { credentials: 'same-origin' });
        if (res.status === 401 || res.status === 403) {
          setCloudSyncStatus('error');
          setCloudSyncDetail('Нужен повторный вход');
          return;
        }
        if (!res.ok) throw new Error('pull-failed');
        const data = await res.json();
        const serverSessions: TripSession[] = Array.isArray(data.sessions) ? data.sessions : [];
        const local = sessionsRef.current;
        // Union by id/fingerprint — never wipe local trips with a partial server copy.
        const { merged, added } = mergeSessions(local, serverSessions);
        // Also pick up trips that only exist locally is already in `merged`.
        // If server was empty and local has data, still push so the account is seeded.
        skipNextPushRef.current = true;
        if (added > 0 || (serverSessions.length > 0 && merged.length !== local.length)) {
          setSessions(merged);
        } else if (serverSessions.length > 0 && local.length === 0) {
          setSessions(serverSessions);
        }
        // Settings: fill only keys the local copy is still on defaults for? Prefer local for
        // interactive prefs; take server battery/vehicle when local looks untouched is complex.
        // Practical rule: merge server under local so current device wins on conflict.
        if (data.settings && typeof data.settings === 'object') {
          setSettings((prev) => ({ ...data.settings, ...prev }));
        }
        setCloudSyncedAt(data.updatedAt || new Date().toISOString());
        setCloudSyncStatus('synced');
        setCloudSyncDetail(
          added > 0 ? `Подтянуто ещё ${pluralTrips(added)} с аккаунта` : '',
        );
        // After merge, ensure server has the full union (device B trips + device A trips).
        skipNextPushRef.current = false;
        await pushToCloud({ silent: true });
      } catch {
        setCloudSyncStatus(navigator.onLine === false ? 'offline' : 'error');
        setCloudSyncDetail(navigator.onLine === false ? 'Нет сети' : 'Не удалось загрузить');
      }
    },
    [authUser?.login, pushToCloud],
  );

  useEffect(() => {
    if (!authUser?.login || serverPullDoneRef.current) return;
    serverPullDoneRef.current = true;
    void pullFromCloud({ silent: true });
  }, [authUser?.login, pullFromCloud]);

  // Debounced auto-push after local edits (skipped right after a pull-driven setState).
  useEffect(() => {
    if (!authUser?.login) return;
    if (skipNextPushRef.current) {
      skipNextPushRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void pushToCloud({ silent: true });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [sessions, settings, authUser?.login, pushToCloud]);

  const handleCloudSyncNow = useCallback(async () => {
    setCloudSyncStatus('syncing');
    setCloudSyncDetail('');
    await pullFromCloud();
    toast({ message: 'Синхронизация с аккаунтом завершена', durationMs: 2500 });
  }, [pullFromCloud, toast]);

  // For Belarus, public ЭЗС tariffs (Malanka, Evika, BatteryFly, Zaryadka) are no longer
  // manually edited in Settings — they're taken automatically from the EVRace tariffs feed
  // and kept in sync here, in one place, so every screen that reads settings.*Tariff (Charging
  // tab, Calculator, Add Trip) always uses the latest known price. Home charging tariffs are
  // untouched — those stay user-editable in every region.
  const { tariffs: evraceTariffs } = useEvraceTariffs();
  useEffect(() => {
    if (settings.regionPreset !== 'belarus') return;
    if (!evraceTariffs.length) return;
    const derived = deriveOperatorSettingsFromEvrace(evraceTariffs);
    setSettings((prev) => {
      if (prev.regionPreset !== 'belarus') return prev;
      let changed = false;
      const next: UserSettings = { ...prev };
      (Object.keys(derived) as Array<keyof UserSettings>).forEach((key) => {
        if (prev[key] !== derived[key]) {
          (next as any)[key] = derived[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [evraceTariffs, settings.regionPreset]);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  // Apply dark / light theme class to root
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, [settings.theme]);

  // Handlers
  const handleSaveTrip = (tripData: Omit<TripSession, 'id' | 'createdAt'>) => {
    const newSession: TripSession = {
      ...tripData,
      id: `trip-${Date.now()}`,
      createdAt: Date.now(),
    };

    setSessions((prev) => [newSession, ...prev]);

    // Celebrate milestone
    try {
      confetti({
        particleCount: 40,
        spread: 60,
        origin: { y: 0.85 },
        colors: ['#06b6d4', '#22d3ee', '#f59e0b'],
      });
    } catch {
      // Ignore
    }
  };

  const handleDeleteSession = (id: string) => {
    const index = sessions.findIndex((s) => s.id === id);
    if (index < 0) return;
    const removed = sessions[index];
    setSessions((prev) => prev.filter((s) => s.id !== id));
    toast({
      message: 'Запись удалена',
      actionLabel: 'Отменить',
      onAction: () =>
        setSessions((prev) =>
          prev.some((s) => s.id === removed.id)
            ? prev
            : [...prev.slice(0, index), removed, ...prev.slice(index)],
        ),
    });
  };

  const handleUpdateSessionEndSoc = (id: string, endSoc: number) => {
    setSessions((prev) => prev.map((session) => {
      if (session.id !== id) return session;

      const safeEndSoc = Math.max(0, Math.min(session.startSoc, Math.round(endSoc)));
      const batteryCap = settings.batteryCapacityKwh || 51.87;
      const socUsed = Math.max(0, session.startSoc - safeEndSoc);
      const energyUsedKwh = (socUsed / 100) * batteryCap;
      const safeDistance = Math.max(0.1, session.distanceKm);
      const consumptionPer100Km = (energyUsedKwh / safeDistance) * 100;
      const kmPerKwh = energyUsedKwh > 0 ? safeDistance / energyUsedKwh : 0;
      const tariff = session.chargingType === 'free'
        ? 0
        : session.chargingType === 'custom'
          ? (session.customTariff ?? 0)
          : session.totalCost > 0 && session.energyUsedKwh > 0
            ? session.totalCost / session.energyUsedKwh
            : 0;
      const totalCost = energyUsedKwh * tariff;
      const gasCostEquivalent = (safeDistance / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter;
      const moneySaved = Math.max(0, gasCostEquivalent - totalCost);

      return {
        ...session,
        endSoc: safeEndSoc,
        endSocAdjustedManually: true,
        energyUsedKwh: Number(energyUsedKwh.toFixed(2)),
        consumptionPer100Km: Number(consumptionPer100Km.toFixed(2)),
        kmPerKwh: Number(kmPerKwh.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        gasCostEquivalent: Number(gasCostEquivalent.toFixed(2)),
        moneySaved: Number(moneySaved.toFixed(2)),
      };
    }));
  };

  const handleResetData = () => {
    const prevSettings = settings;
    const prevSessions = sessions;
    setSettings(DEFAULT_SETTINGS);
    setSessions(INITIAL_SESSIONS);
    setSettingsFormKey((k) => k + 1);
    toast({
      message: 'Данные сброшены',
      actionLabel: 'Вернуть',
      durationMs: 10000,
      onAction: () => {
        setSettings(prevSettings);
        setSessions(prevSessions);
        setSettingsFormKey((k) => k + 1);
      },
    });
  };

  const handleImportBackup = (
    importedSessions: TripSession[],
    importedSettings?: UserSettings,
    mode: ImportMode = 'replace'
  ) => {
    if (!Array.isArray(importedSessions)) return;
    const prevSessions = sessions;
    const prevSettings = settings;
    let message: string;

    if (mode === 'merge') {
      const { merged, added } = mergeSessions(sessions, importedSessions);
      if (added === 0) {
        toast({ message: 'Новых записей нет — всё из файла уже есть в истории.' });
        return;
      }
      setSessions(merged);
      message = `Добавлено: ${pluralTrips(added)}`;
    } else {
      setSessions(importedSessions);
      // Fill anything missing in older backups from defaults so no setting ends up undefined.
      if (importedSettings) setSettings({ ...DEFAULT_SETTINGS, ...importedSettings });
      message = `Загружено: ${pluralTrips(importedSessions.length)}`;
    }

    setSettingsFormKey((k) => k + 1);
    toast({
      message,
      actionLabel: 'Отменить',
      durationMs: 10000,
      onAction: () => {
        setSessions(prevSessions);
        setSettings(prevSettings);
        setSettingsFormKey((k) => k + 1);
      },
    });
  };

  const openAddModalWithData = (data: Partial<TripSession>) => {
    setAddTripInitialData(data);
    setIsAddTripOpen(true);
  };

  if (authChecking) {
    return <div className="min-h-screen bg-[#0b1220] text-slate-100 flex items-center justify-center text-xs text-slate-400">Проверка авторизации…</div>;
  }

  if (!authUser) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  const headerHidden = isLandscape;

  return (
    <div className={`min-h-screen transition-colors duration-200 flex flex-col font-sans ${
      settings.theme === 'light' 
        ? 'bg-[#f0f6fb] text-slate-900 selection:bg-cyan-400 selection:text-slate-950' 
        : 'bg-[#0b1220] text-slate-100 selection:bg-cyan-500 selection:text-slate-950'
    }`}>
      {/* Top Header — hidden in landscape for full-screen content */}
      {!headerHidden && (
        <Header
          settings={settings}
          onUpdateSettings={setSettings}
          onOpenAddTrip={() => {
            setAddTripInitialData(undefined);
            setIsAddTripOpen(true);
          }}
          currentUser={authUser}
          onOpenAdmin={() => setShowAdmin(true)}
          onLogout={handleLogout}
          onOpenAbout={() => setShowAbout(true)}
        />
      )}

      {/* Main Content Area — landscape: full-bleed only for map-like tabs; forms stay centered */}
      <main
        className={
          isLandscape
            ? `flex-1 w-full h-[100dvh] max-h-[100dvh] overflow-auto m-0 ${
                activeTab === 'hud' || activeTab === 'charging'
                  ? 'p-0'
                  : 'px-4 py-3 pb-24'
              }`
            : 'flex-1 max-w-4xl w-full mx-auto p-3 sm:p-4 pb-28'
        }
      >
        {showAdmin ? (
          <AdminPanel
            currentLogin={authUser.login}
            onClose={() => setShowAdmin(false)}
            onLogout={handleLogout}
          />
        ) : null}

        {!showAdmin && (
        <>
        {/* HUD Tab: Kept mounted permanently so GPS tracking, distance, timer and SoC never reset on tab switch */}
        <div
          data-tab-panel="hud"
          className={isLandscape ? 'h-full' : undefined}
          style={{ display: activeTab === 'hud' ? 'block' : 'none' }}
        >
          <HudTab
            settings={settings}
            sessions={sessions}
            onSaveToHistory={handleSaveTrip}
            onOpenAddModalWithData={openAddModalWithData}
            onTrackingChange={setIsHudTracking}
            hudPlan={hudPlan}
            onHudPlanConsumed={() => setHudPlan(null)}
          />
        </div>

        {/* All main tabs stay mounted and toggle via CSS — avoids Android WebView black screen after login / tab switch */}
        <div
          data-tab-panel="calculator"
          className={isLandscape ? 'max-w-3xl mx-auto w-full' : undefined}
          style={{ display: activeTab === 'calculator' ? 'block' : 'none' }}
        >
          <CalculatorTab
            settings={settings}
            sessions={sessions}
            onSaveToHistory={handleSaveTrip}
            onOpenAddModalWithData={openAddModalWithData}
            onSendToHud={(plan) => {
              setHudPlan(plan);
              setActiveTab('hud');
            }}
          />
        </div>

        <div
          data-tab-panel="history"
          className={isLandscape ? 'max-w-3xl mx-auto w-full' : undefined}
          style={{ display: activeTab === 'history' ? 'block' : 'none' }}
        >
          <HistoryTab
            sessions={sessions}
            settings={settings}
            onDeleteSession={handleDeleteSession}
            onUpdateSessionEndSoc={handleUpdateSessionEndSoc}
            onOpenAddModal={() => {
              setAddTripInitialData(undefined);
              setIsAddTripOpen(true);
            }}
            onImportBackup={handleImportBackup}
          />
        </div>

        <div
          data-tab-panel="charging"
          className={isLandscape ? 'h-full' : undefined}
          style={{ display: activeTab === 'charging' ? 'block' : 'none' }}
        >
          <ChargingTab settings={settings} sessions={sessions} />
        </div>

        <div
          data-tab-panel="settings"
          className={isLandscape ? 'max-w-3xl mx-auto w-full' : undefined}
          style={{ display: activeTab === 'settings' ? 'block' : 'none' }}
        >
          <SettingsTab
            key={settingsFormKey}
            settings={settings}
            sessions={sessions}
            onUpdateSettings={setSettings}
            onResetData={handleResetData}
            onImportBackup={handleImportBackup}
            currentUser={authUser ?? undefined}
            onOpenAdmin={() => setShowAdmin(true)}
            onLogout={handleLogout}
            onOpenAbout={() => setShowAbout(true)}
            cloudSyncStatus={cloudSyncStatus}
            cloudSyncedAt={cloudSyncedAt}
            cloudSyncDetail={cloudSyncDetail}
            onCloudSyncNow={handleCloudSyncNow}
          />
        </div>
        </>
        )}
      </main>

      {/* Floating pill nav — auto-hide on scroll down, show on scroll up */}
      {!showAdmin && (
        <Navigation
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          hapticFeedback={settings.hapticFeedback}
          historyCount={sessions.length}
          theme={settings.theme}
          isHudTracking={isHudTracking}
          floating
          visible={navVisible}
        />
      )}

      <AboutProject
        isOpen={showAbout}
        onClose={() => setShowAbout(false)}
        isDark={settings.theme !== 'light'}
      />

      {/* Add Trip Modal */}
      <AddTripModal
        isOpen={isAddTripOpen}
        onClose={() => setIsAddTripOpen(false)}
        settings={settings}
        onSave={handleSaveTrip}
        initialData={addTripInitialData}
      />
    </div>
  );
}

export default function App() {
  return (
    <FeedbackProvider>
      <AppInner />
    </FeedbackProvider>
  );
}
