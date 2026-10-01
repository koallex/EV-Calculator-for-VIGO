import React, { useState, useEffect, useRef } from 'react';
import {
  Settings,
  Battery,
  Zap,
  Fuel,
  Coins,
  Download,
  Upload,
  RefreshCw,
  Check,
  Sparkles,
  MapPin,
  Moon,
  Sun,
  Info,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import { UserSettings, TripSession } from '../types';
import {
  DEFAULT_SETTINGS,
  REGION_PRESETS,
  getOperatorLabel,
  exportBackupJSON,
  exportSessionsCSV,
} from '../utils/storage';
import {
  VEHICLE_PROFILES,
  getVehicleProfile,
  getVehicleVariant,
  applyVehicleVariantToSettings,
  applyCustomVehicleFields,
  resolveEffectiveConnectors,
  formatConnectorsLabel,
  BODY_TYPE_LABELS,
  type BodyType,
  type ConnectorOverride,
} from '../data/vehicleProfiles';
import { DecimalInput } from './DecimalInput';
import { triggerHaptic } from '../utils/haptics';
import { useBackupImport, type ImportMode } from '../hooks/useBackupImport';
import { useFeedback } from './ui/Feedback';
import { pluralTrips } from '../utils/backup';
import { APP_VERSION } from '../appInfo';

interface SettingsTabProps {
  settings: UserSettings;
  sessions: TripSession[];
  onUpdateSettings: (newSettings: UserSettings) => void;
  onResetData: () => void;
  onImportBackup: (sessions: TripSession[], newSettings: UserSettings | undefined, mode: ImportMode) => void;
  currentUser?: { login: string; role: 'admin' | 'user' };
  onOpenAdmin?: () => void;
  onLogout?: () => void;
  onOpenAbout?: () => void;
  cloudSyncStatus?: 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
  cloudSyncedAt?: string | null;
  cloudSyncDetail?: string;
  onCloudSyncNow?: () => void | Promise<void>;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  settings,
  sessions,
  onUpdateSettings,
  onResetData,
  onImportBackup,
  currentUser,
  onOpenAdmin,
  onLogout,
  onOpenAbout,
  cloudSyncStatus = 'idle',
  cloudSyncedAt = null,
  cloudSyncDetail = '',
  onCloudSyncNow,
}) => {
  const { ask } = useFeedback();
  const [form, setForm] = useState<UserSettings>(settings);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const autoSaveTimer = useRef<number | null>(null);
  const formRef = useRef(form);
  formRef.current = form;

  // Keep form in sync when parent resets/imports settings.
  useEffect(() => {
    setForm(settings);
  }, [settings]);

  // Autosave ~800ms after last change (App already writes localStorage on settings change).
  useEffect(() => {
    if (JSON.stringify(form) === JSON.stringify(settings)) return;
    if (autoSaveTimer.current != null) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      onUpdateSettings(formRef.current);
      setAutoSaved(true);
      window.setTimeout(() => setAutoSaved(false), 1800);
    }, 800);
    return () => {
      if (autoSaveTimer.current != null) window.clearTimeout(autoSaveTimer.current);
    };
  }, [form]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDark = form.theme !== 'light';

  // Public ЭЗС tariffs for Belarus are no longer manually edited here — they're kept in sync
  // automatically in the background (see App.tsx) from live pricing data, so this list is
  // hidden entirely for Belarus. Russia has no such automatic feed, so those fields stay
  // manually editable there. Home charging is always editable — it's the user's own meter.
  const isAutoTariff = (form.regionPreset ?? 'belarus') !== 'russia';

  const handleSave = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    onUpdateSettings(form);
    triggerHaptic('success', form.hapticFeedback);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const applyRegionPreset = (regionKey: 'belarus' | 'russia') => {
    triggerHaptic('medium', form.hapticFeedback);
    const preset = REGION_PRESETS[regionKey];
    if (preset) {
      setForm((prev) => ({
        ...prev,
        ...preset,
        regionPreset: regionKey,
      }));
    }
  };

  // Validation + replace/merge choice live in useBackupImport (shared with History).
  const handleFileChange = useBackupImport(onImportBackup, sessions.length, settings.hapticFeedback);

  const handleResetClick = async () => {
    const choice = await ask({
      title: 'Сбросить все данные?',
      message: (
        <div className="space-y-1.5">
          <div>Будут удалены <b>{pluralTrips(sessions.length)}</b> и все настройки — вернутся значения по умолчанию.</div>
          <div className="opacity-80">Сразу после сброса будет доступна кнопка «Вернуть» (10 секунд).</div>
        </div>
      ),
      actions: [
        { id: 'backup', label: 'Скачать бэкап и сбросить', tone: 'primary' },
        { id: 'reset', label: 'Сбросить без бэкапа', tone: 'danger' },
        { id: 'cancel', label: 'Отмена', tone: 'neutral' },
      ],
    });
    if (choice !== 'backup' && choice !== 'reset') return;
    if (choice === 'backup') exportBackupJSON(settings, sessions);
    onResetData();
    setForm(DEFAULT_SETTINGS);
  };

  return (
    <div id="settings-tab-container" className="space-y-4 pb-12 w-full max-w-2xl mx-auto">
      {/* Top Banner */}
      <div
        className={`border rounded-2xl p-4 transition-colors ${
          isDark
            ? 'bg-slate-900/60 border-slate-800/80'
            : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <div
            className={`p-1.5 rounded-lg ${
              isDark ? 'bg-cyan-500/15 text-cyan-400' : 'bg-cyan-50 text-cyan-600'
            }`}
          >
            <Settings className="w-4 h-4" />
          </div>
          <h2 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Настройки и тарифы ЭЗС
          </h2>
        </div>
        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Регион, тарифы ЭЗС и параметры автомобиля. Валюта подставляется из региона.
        </p>
      </div>

      {/* Account / actions previously in the header — available in landscape via «Ещё» */}
      <div
        className={`border rounded-2xl p-3 space-y-2 ${
          isDark ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Аккаунт и интерфейс
          </p>
          {currentUser?.login && (
            <span className={`text-[11px] font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-700'}`}>
              {currentUser.login}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', form.hapticFeedback);
              const next = form.theme === 'dark' ? 'light' : 'dark';
              setForm({ ...form, theme: next });
            }}
            className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold min-h-[44px] ${
              isDark
                ? 'bg-slate-950 border-slate-800 text-amber-400'
                : 'bg-slate-50 border-slate-200 text-amber-600'
            }`}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {isDark ? 'Светлая' : 'Тёмная'}
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', form.hapticFeedback);
              onOpenAbout?.();
            }}
            className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold min-h-[44px] ${
              isDark
                ? 'bg-slate-950 border-slate-800 text-slate-300'
                : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}
          >
            <Info className="w-4 h-4" />
            О проекте
          </button>
          {currentUser?.role === 'admin' && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', form.hapticFeedback);
                onOpenAdmin?.();
              }}
              className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold min-h-[44px] ${
                isDark
                  ? 'bg-slate-950 border-slate-800 text-cyan-400'
                  : 'bg-slate-50 border-slate-200 text-cyan-700'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              Админ
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('medium', form.hapticFeedback);
              onLogout?.();
            }}
            className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold min-h-[44px] ${
              isDark
                ? 'bg-slate-950 border-slate-800 text-rose-300'
                : 'bg-rose-50 border-rose-200 text-rose-700'
            }`}
          >
            <LogOut className="w-4 h-4" />
            Выйти
          </button>
        </div>
        {(autoSaved || savedSuccess) && (
          <p className={`text-[11px] text-center ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
            {savedSuccess ? 'Сохранено' : 'Автосохранение…'}
          </p>
        )}

        {/* Account history sync (Redis) — localStorage remains the offline cache */}
        {currentUser?.login && (
          <div
            className={`mt-2 rounded-xl border px-3 py-2.5 space-y-2 ${
              isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                История в аккаунте
              </p>
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                  cloudSyncStatus === 'synced'
                    ? isDark
                      ? 'bg-emerald-950/60 text-emerald-400'
                      : 'bg-emerald-50 text-emerald-700'
                    : cloudSyncStatus === 'syncing'
                      ? isDark
                        ? 'bg-cyan-950/60 text-cyan-400'
                        : 'bg-cyan-50 text-cyan-700'
                      : cloudSyncStatus === 'offline'
                        ? isDark
                          ? 'bg-amber-950/50 text-amber-400'
                          : 'bg-amber-50 text-amber-700'
                        : cloudSyncStatus === 'error'
                          ? isDark
                            ? 'bg-rose-950/50 text-rose-400'
                            : 'bg-rose-50 text-rose-700'
                          : isDark
                            ? 'bg-slate-800 text-slate-400'
                            : 'bg-slate-200 text-slate-600'
                }`}
              >
                {cloudSyncStatus === 'synced'
                  ? 'Синхронизировано'
                  : cloudSyncStatus === 'syncing'
                    ? 'Синхронизация…'
                    : cloudSyncStatus === 'offline'
                      ? 'Нет сети'
                      : cloudSyncStatus === 'error'
                        ? 'Ошибка'
                        : 'Ожидание'}
              </span>
            </div>
            <p className={`text-[11px] leading-snug ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {cloudSyncDetail ||
                (cloudSyncedAt
                  ? `Обновлено ${new Date(cloudSyncedAt).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}`
                  : 'Поездки хранятся на устройстве и дублируются в аккаунт после входа.')}
            </p>
            <button
              type="button"
              disabled={cloudSyncStatus === 'syncing' || !onCloudSyncNow}
              onClick={() => {
                triggerHaptic('light', form.hapticFeedback);
                void onCloudSyncNow?.();
              }}
              className={`w-full py-2 rounded-lg text-[12px] font-bold min-h-[40px] border active:scale-[0.99] disabled:opacity-50 ${
                isDark
                  ? 'bg-slate-900 border-slate-700 text-cyan-400 hover:bg-slate-800'
                  : 'bg-white border-slate-200 text-cyan-700 hover:bg-cyan-50'
              }`}
            >
              {cloudSyncStatus === 'syncing' ? 'Синхронизация…' : 'Синхронизировать сейчас'}
            </button>
          </div>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {/* 0. Region preset */}
        <div
          className={`border rounded-2xl p-4 space-y-3 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <div className="flex items-center gap-2">
            <MapPin className={`w-4 h-4 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
            <h3
              className={`text-xs font-bold uppercase tracking-wider ${
                isDark ? 'text-slate-300' : 'text-slate-700'
              }`}
            >
              Регион
            </h3>
          </div>
          <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            При смене региона автоматически подставляются валюта, тарифы и названия операторов ЭЗС.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: 'belarus' as const, label: '🇧🇾 Беларусь', sub: 'Br · Маланка, Evika…' },
              { key: 'russia' as const, label: '🇷🇺 Россия', sub: '₽ · Punkt E, Россети…' },
            ]).map((r) => {
              const active = (form.regionPreset ?? 'belarus') === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => applyRegionPreset(r.key)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
                    active
                      ? isDark
                        ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                        : 'bg-cyan-50 border-cyan-400 text-cyan-800'
                      : isDark
                      ? 'bg-slate-950/50 border-slate-800 text-slate-300 hover:border-slate-600'
                      : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <span className="block text-sm font-bold">{r.label}</span>
                  <span className={`block text-[10px] mt-0.5 ${active ? '' : isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {r.sub}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. Electricity Tariffs Breakdown */}
        <div
          className={`border rounded-2xl p-4 space-y-3 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <div className="flex items-center justify-between">
            <h3
              className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${
                isDark ? 'text-slate-300' : 'text-slate-700'
              }`}
            >
              <Zap className="w-4 h-4 text-amber-500" />
              {isAutoTariff ? 'Тариф зарядки' : `Тарифы операторов (${form.currency}/кВт⋅ч)`}
            </h3>
            {!isAutoTariff && (
              <span className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Нажмите для изменения цены
              </span>
            )}
          </div>
          {isAutoTariff && (
            <p className={`text-[11px] -mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Стоимость зарядки на публичных ЭЗС определяется автоматически и не редактируется
              вручную. Здесь можно настроить только тариф домашней зарядки.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {!isAutoTariff && (
              <>
                {/* Malanka DC / Punkt E */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      ⚡ {getOperatorLabel('malanka_dc', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">DC 50-160 кВт</span>
                  </div>
                  <DecimalInput
                    value={form.malankaDcTariff ?? form.fastDayTariff ?? 0.56}
                    onChange={(val) =>
                      setForm({ ...form, malankaDcTariff: val, fastDayTariff: val })
                    }
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-amber-400 focus:border-amber-400'
                        : 'bg-white border-slate-200 text-amber-700 focus:border-amber-500'
                    }`}
                  />
                </div>

                {/* Malanka AC */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                      🔌 {getOperatorLabel('malanka_ac', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">AC до 22 кВт</span>
                  </div>
                  <DecimalInput
                    value={form.malankaAcTariff ?? form.slowPublicTariff ?? 0.43}
                    onChange={(val) =>
                      setForm({ ...form, malankaAcTariff: val, slowPublicTariff: val })
                    }
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-cyan-400 focus:border-cyan-400'
                        : 'bg-white border-slate-200 text-cyan-700 focus:border-cyan-500'
                    }`}
                  />
                </div>

                {/* Evika (Белтелеком) */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                      🔌 {getOperatorLabel('evika', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">AC станция</span>
                  </div>
                  <DecimalInput
                    value={form.evikaTariff ?? 0.43}
                    onChange={(val) => setForm({ ...form, evikaTariff: val })}
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-cyan-400 focus:border-cyan-400'
                        : 'bg-white border-slate-200 text-cyan-700 focus:border-cyan-500'
                    }`}
                  />
                </div>

                {/* BatteryFly / Forpost */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                      🔋 {getOperatorLabel('batteryfly', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">Коммерческая</span>
                  </div>
                  <DecimalInput
                    value={form.batteryFlyTariff ?? 0.60}
                    onChange={(val) => setForm({ ...form, batteryFlyTariff: val })}
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-cyan-400 focus:border-cyan-400'
                        : 'bg-white border-slate-200 text-cyan-700 focus:border-cyan-500'
                    }`}
                  />
                </div>

                {/* Zaryadka (Зарядка) Day Tariff */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-orange-300' : 'text-orange-700'}`}>
                      ☀️ {getOperatorLabel('zaryadka_day', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">Дневной тариф</span>
                  </div>
                  <DecimalInput
                    value={form.zaryadkaDayTariff ?? form.zaryadkaTariff ?? 0.56}
                    onChange={(val) => setForm({ ...form, zaryadkaDayTariff: val, zaryadkaTariff: val, zaryadkaDcTariff: val })}
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-orange-400 focus:border-orange-400'
                        : 'bg-white border-slate-200 text-orange-700 focus:border-orange-500'
                    }`}
                  />
                </div>

                {/* Zaryadka (Зарядка) Night Tariff */}
                <div
                  className={`space-y-1 p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label className={`text-xs font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      🌙 {getOperatorLabel('zaryadka_night', form.regionPreset)}
                    </label>
                    <span className="text-[10px] text-slate-400">Ночной льготный</span>
                  </div>
                  <DecimalInput
                    value={form.zaryadkaNightTariff ?? 0.43}
                    onChange={(val) => setForm({ ...form, zaryadkaNightTariff: val })}
                    suffix={form.currency}
                    className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-900 border-slate-700 text-amber-400 focus:border-amber-400'
                        : 'bg-white border-slate-200 text-amber-700 focus:border-amber-500'
                    }`}
                  />
                </div>
              </>
            )}

            {/* Home Night Tariff */}
            <div
              className={`space-y-1 p-2.5 rounded-xl border ${
                isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <label className={`text-xs font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                  🌙 Домашняя ночная
                </label>
                <span className="text-[10px] text-slate-400">Ночной тариф</span>
              </div>
              <DecimalInput
                value={form.homeNightTariff ?? 0.16}
                onChange={(val) => setForm({ ...form, homeNightTariff: val })}
                suffix={form.currency}
                className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-900 border-slate-700 text-cyan-400 focus:border-cyan-400'
                    : 'bg-white border-slate-200 text-cyan-700 focus:border-cyan-500'
                }`}
              />
            </div>

            {/* Home Day / Standard */}
            <div
              className={`space-y-1 p-2.5 rounded-xl border sm:col-span-2 ${
                isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <label className={`text-xs font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                  🏠 Домашняя стандартная / дневная
                </label>
                <span className="text-[10px] text-slate-400">Одноставочный тариф</span>
              </div>
              <DecimalInput
                value={form.homeTariff}
                onChange={(val) => setForm({ ...form, homeTariff: val })}
                suffix={form.currency}
                className={`w-full border px-3 py-1.5 rounded-lg text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-900 border-slate-700 text-cyan-400 focus:border-cyan-400'
                    : 'bg-white border-slate-200 text-cyan-700 focus:border-cyan-500'
                }`}
              />
            </div>
          </div>
        </div>

        {/* 2. Battery Specs */}
        <div
          className={`border rounded-2xl p-4 space-y-3 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <h3
            className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${
              isDark ? 'text-slate-300' : 'text-slate-700'
            }`}
          >
            <Battery className={`w-4 h-4 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`} />
            Автомобиль и батарея
          </h3>

          <div className="space-y-3">
            <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Выберите профиль — параметры массы, аэродинамики и батареи подставятся автоматически.
              Или откройте «Свой автомобиль» и задайте всё вручную.
            </p>

            {/* Visual profile grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {VEHICLE_PROFILES.map((p) => {
                const active = (form.vehicleProfileId || 'dongfeng-vigo') === p.id;
                const def = p.variants.find((v) => v.default) || p.variants[0];
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      const variant = p.variants.find((v) => v.default) || p.variants[0];
                      setForm(applyVehicleVariantToSettings(form, p.id, variant.id));
                      triggerHaptic('light', form.hapticFeedback);
                    }}
                    className={`text-left rounded-xl border px-2.5 py-2.5 transition-all active:scale-[0.98] ${
                      active
                        ? isDark
                          ? 'bg-cyan-950/50 border-cyan-500/70 ring-1 ring-cyan-500/40'
                          : 'bg-cyan-50 border-cyan-400 ring-1 ring-cyan-300'
                        : isDark
                        ? 'bg-slate-950 border-slate-800 hover:border-slate-600'
                        : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div
                      className={`text-[11px] font-bold leading-tight truncate ${
                        active
                          ? isDark
                            ? 'text-cyan-300'
                            : 'text-cyan-800'
                          : isDark
                          ? 'text-white'
                          : 'text-slate-900'
                      }`}
                    >
                      {p.displayName}
                    </div>
                    <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      {p.isCustom
                        ? 'ручные параметры'
                        : `${def.batteryCapacityKwh} кВт⋅ч · ${BODY_TYPE_LABELS[p.body]}`}
                    </div>
                    {!p.isCustom && (
                      <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                        {def.hasHeatPump ? 'ТН' : 'ТЭН'} · ~{def.curbWeightKg} кг
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {(() => {
              const profile = getVehicleProfile(form.vehicleProfileId);
              if (profile.isCustom || profile.variants.length <= 1) return null;
              return (
                <div className="space-y-1.5">
                  <label className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Модификация батареи
                  </label>
                  <select
                    value={form.vehicleVariantId || getVehicleVariant(form.vehicleProfileId).id}
                    onChange={(e) => {
                      setForm(
                        applyVehicleVariantToSettings(
                          form,
                          form.vehicleProfileId || profile.id,
                          e.target.value,
                        ),
                      );
                      triggerHaptic('light', form.hapticFeedback);
                    }}
                    className={`w-full border px-3 py-2 rounded-xl text-sm font-semibold focus:outline-none transition-colors ${
                      isDark
                        ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                        : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                    }`}
                  >
                    {profile.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {v.hasHeatPump ? ' · ТН' : ''} · ~{v.curbWeightKg} кг
                      </option>
                    ))}
                  </select>
                </div>
              );
            })()}

            {/* Custom vehicle fields */}
            {getVehicleProfile(form.vehicleProfileId).isCustom && (
              <div
                className={`rounded-xl border p-3 space-y-3 ${
                  isDark ? 'bg-slate-950/80 border-cyan-800/40' : 'bg-cyan-50/50 border-cyan-200'
                }`}
              >
                <p className={`text-[11px] font-semibold ${isDark ? 'text-cyan-300' : 'text-cyan-800'}`}>
                  Параметры своего авто (влияют на физмодель расхода)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      Масса снаряжённая (кг)
                    </label>
                    <DecimalInput
                      value={form.curbWeightKg ?? 1600}
                      onChange={(val) =>
                        setForm(
                          applyCustomVehicleFields(form, {
                            curbWeightKg: val || 1600,
                          }),
                        )
                      }
                      suffix="кг"
                      className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                        isDark
                          ? 'bg-slate-900 border-slate-700 text-white focus:border-cyan-500'
                          : 'bg-white border-slate-200 text-slate-900 focus:border-cyan-500'
                      }`}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      Ёмкость батареи (кВт⋅ч)
                    </label>
                    <DecimalInput
                      value={form.batteryCapacityKwh}
                      onChange={(val) =>
                        setForm(
                          applyCustomVehicleFields(form, {
                            batteryCapacityKwh: val || 50,
                          }),
                        )
                      }
                      suffix="кВт⋅ч"
                      className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                        isDark
                          ? 'bg-slate-900 border-slate-700 text-white focus:border-cyan-500'
                          : 'bg-white border-slate-200 text-slate-900 focus:border-cyan-500'
                      }`}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Тип кузова (аэродинамическая модель)
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(BODY_TYPE_LABELS) as BodyType[]).map((bt) => {
                      const active = (form.vehicleBodyType || 'crossover') === bt;
                      return (
                        <button
                          key={bt}
                          type="button"
                          onClick={() => {
                            setForm(applyCustomVehicleFields(form, { vehicleBodyType: bt }));
                            triggerHaptic('light', form.hapticFeedback);
                          }}
                          className={`py-2 rounded-lg text-xs font-bold border transition-all ${
                            active
                              ? 'bg-cyan-600 text-white border-cyan-500'
                              : isDark
                              ? 'bg-slate-900 text-slate-300 border-slate-700'
                              : 'bg-white text-slate-700 border-slate-200'
                          }`}
                        >
                          {BODY_TYPE_LABELS[bt]}
                        </button>
                      );
                    })}
                  </div>
                  <p className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    Хэтчбек/седан — ниже сопротивление на трассе; SUV — выше доля аэродинамики.
                  </p>
                </div>
                <div
                  className={`flex items-center justify-between p-2.5 rounded-xl border ${
                    isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                  }`}
                >
                  <div>
                    <div className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      Тепловой насос
                    </div>
                    <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      Снижает расход климат-контроля зимой
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setForm(
                        applyCustomVehicleFields(form, {
                          hasHeatPump: !(form.hasHeatPump ?? false),
                        }),
                      );
                      triggerHaptic('light', form.hapticFeedback);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                      form.hasHeatPump
                        ? 'bg-emerald-600 text-white border-emerald-500'
                        : isDark
                        ? 'bg-slate-800 text-slate-400 border-slate-600'
                        : 'bg-slate-100 text-slate-600 border-slate-300'
                    }`}
                  >
                    {form.hasHeatPump ? 'Есть' : 'Нет (ТЭН)'}
                  </button>
                </div>
              </div>
            )}

            {/* Capacity tweak for non-custom profiles */}
            {!getVehicleProfile(form.vehicleProfileId).isCustom && (
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <label className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Ёмкость батареи (можно уточнить):
                  </label>
                  <span className={`font-mono font-bold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                    {form.batteryCapacityKwh} кВт⋅ч
                  </span>
                </div>
                <DecimalInput
                  value={form.batteryCapacityKwh}
                  onChange={(val) => setForm({ ...form, batteryCapacityKwh: val || 51.87 })}
                  suffix="кВт⋅ч"
                  className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                    isDark
                      ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                      : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                  }`}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs">
                <label className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Макс. скорость зарядки (DC):
                </label>
                <span className={`font-mono font-bold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                  {Math.round(form.dcMaxKw || getVehicleVariant(form.vehicleProfileId, form.vehicleVariantId).dcMaxKw)} кВт
                </span>
              </div>
              <DecimalInput
                value={form.dcMaxKw ?? getVehicleVariant(form.vehicleProfileId, form.vehicleVariantId).dcMaxKw}
                onChange={(val) => setForm({ ...form, dcMaxKw: val > 0 ? val : undefined })}
                min={10}
                max={400}
                suffix="кВт"
                className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                }`}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs">
                <label className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Макс. мощность AC (бортовое):
                </label>
                <span className={`font-mono font-bold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                  {form.acMaxKw || getVehicleVariant(form.vehicleProfileId, form.vehicleVariantId).acMaxKw} кВт
                </span>
              </div>
              <DecimalInput
                value={form.acMaxKw ?? getVehicleVariant(form.vehicleProfileId, form.vehicleVariantId).acMaxKw}
                onChange={(val) => setForm({ ...form, acMaxKw: val > 0 ? val : undefined })}
                min={1}
                max={50}
                suffix="кВт"
                className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                }`}
              />
            </div>

            <div className="space-y-1.5">
              <label className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                Порт зарядки
              </label>
              <select
                value={form.connectorOverride || 'auto'}
                onChange={(e) => {
                  setForm({
                    ...form,
                    connectorOverride: e.target.value as ConnectorOverride,
                  });
                  triggerHaptic('light', form.hapticFeedback);
                }}
                className={`w-full border px-3 py-2 rounded-xl text-sm font-semibold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                }`}
              >
                <option value="auto">
                  Авто (профиль:{' '}
                  {formatConnectorsLabel(getVehicleProfile(form.vehicleProfileId).connectors)})
                </option>
                <option value="ccs2">CCS2</option>
                <option value="gbt">GB/T</option>
                <option value="type2">Type2 (только AC)</option>
                <option value="ccs2_type2">CCS2 + Type2</option>
                <option value="ccs2_gbt">CCS2 + GB/T</option>
              </select>
              <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                Влияет на фильтр станций по маршруту и автопоиск ближайшей свободной зарядки.
              </p>
            </div>

            {(() => {
              const variant = getVehicleVariant(form.vehicleProfileId, form.vehicleVariantId);
              const effective = resolveEffectiveConnectors(
                form.vehicleProfileId,
                form.connectorOverride,
              );
              const body = form.vehicleBodyType || getVehicleProfile(form.vehicleProfileId).body;
              return (
                <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {getVehicleProfile(form.vehicleProfileId).notes || ''}
                  {' · '}
                  {BODY_TYPE_LABELS[body]}
                  {' · '}Масса ~{Math.round(form.curbWeightKg || variant.curbWeightKg)} кг
                  {' · '}
                  {form.hasHeatPump ?? variant.hasHeatPump ? 'тепловой насос' : 'без ТН (ТЭН)'}
                  {' · '}DC до {Math.round(form.dcMaxKw || variant.dcMaxKw)} кВт
                  {' · '}порты: {formatConnectorsLabel(effective)}
                  {form.connectorOverride && form.connectorOverride !== 'auto' ? ' (вручную)' : ''}
                </p>
              );
            })()}
          </div>
        </div>

        {/* 3. ICE Comparison for Savings */}
        <div
          className={`border rounded-2xl p-4 space-y-3 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <h3
            className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${
              isDark ? 'text-slate-300' : 'text-slate-700'
            }`}
          >
            <Fuel className={`w-4 h-4 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`} />
            Аналог с ДВС (для расчета экономии)
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Расход топлива ДВС (л / 100 км):
              </label>
              <DecimalInput
                value={form.gasEquivalentL100km}
                onChange={(val) => setForm({ ...form, gasEquivalentL100km: val || 8.0 })}
                suffix="л"
                className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                }`}
              />
            </div>

            <div className="space-y-1">
              <label className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Цена за литр топлива ({form.currency}):
              </label>
              <DecimalInput
                value={form.gasPricePerLiter}
                onChange={(val) => setForm({ ...form, gasPricePerLiter: val || 2.46 })}
                suffix={form.currency}
                className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-cyan-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-cyan-500'
                }`}
              />
            </div>
          </div>
        </div>

        {/* Save Button */}
        <button
          type="submit"
          className="w-full py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-sm shadow-sm shadow-cyan-600/20 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
        >
          <Check className="w-4 h-4" />
          <span>{savedSuccess ? 'Настройки успешно сохранены!' : 'Сохранить настройки'}</span>
        </button>
      </form>

      <div className={`text-center text-[9px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Версия {APP_VERSION}</div>

      {/* 5. Backup & Data Management */}
      <div
        className={`border rounded-2xl p-4 space-y-3 transition-colors ${
          isDark
            ? 'bg-slate-900/60 border-slate-800/80'
            : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <h3
          className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${
            isDark ? 'text-slate-300' : 'text-slate-700'
          }`}
        >
          <Download className="w-4 h-4 text-cyan-500" />
          Резервное копирование и экспорт
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => exportBackupJSON(settings, sessions)}
            className={`p-3 rounded-xl border flex items-center justify-between text-xs font-semibold active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
            }`}
          >
            <span className="flex items-center gap-2">
              <Download className="w-4 h-4 text-cyan-500" /> JSON бэкап данных
            </span>
          </button>

          <button
            type="button"
            onClick={() => exportSessionsCSV(sessions, settings.currency)}
            className={`p-3 rounded-xl border flex items-center justify-between text-xs font-semibold active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
            }`}
          >
            <span className="flex items-center gap-2">
              <Download className="w-4 h-4 text-cyan-500" /> Экспорт поездок в CSV
            </span>
          </button>
        </div>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".json"
          className="hidden"
        />

        <div className={`flex gap-2 pt-2 border-t ${isDark ? 'border-slate-800/80' : 'border-slate-100'}`}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Восстановить из файла</span>
          </button>

          <button
            type="button"
            onClick={handleResetClick}
            className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 active:scale-95 transition-all ${
              isDark
                ? 'bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border-rose-900/60'
                : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200'
            }`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Сброс</span>
          </button>
        </div>
      </div>
    </div>
  );
};
