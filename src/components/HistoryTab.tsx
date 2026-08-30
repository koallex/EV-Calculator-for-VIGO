import React, { useState, useMemo } from 'react';
import {
  History,
  TrendingUp,
  TrendingDown,
  Trash2,
  Download,
  FileSpreadsheet,
  Upload,
  Plus,
  Search,
  Filter,
  Car,
  Calendar,
  Zap,
  Sparkles,
  ShieldCheck,
  Fuel,
  ChevronDown,
  Info,
  LineChart as LineChartIcon,
  Gauge,
  Activity,
  Award,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { TripSession, UserSettings, RoadType } from '../types';
import { exportBackupJSON, exportSessionsCSV, calculateHistoricalDriverStyle, deriveDrivingStyleFactor, getDrivingStyleLabel } from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';

interface HistoryTabProps {
  sessions: TripSession[];
  settings: UserSettings;
  onDeleteSession: (id: string) => void;
  onUpdateSessionEndSoc: (id: string, endSoc: number) => void;
  onOpenAddModal: () => void;
  onImportBackup: (importedSessions: TripSession[], importedSettings?: UserSettings) => void;
}

export const HistoryTab: React.FC<HistoryTabProps> = ({
  sessions,
  settings,
  onDeleteSession,
  onUpdateSessionEndSoc,
  onOpenAddModal,
  onImportBackup,
}) => {
  const [filterRoad, setFilterRoad] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingSocId, setEditingSocId] = useState<string | null>(null);
  const [editingSoc, setEditingSoc] = useState<number>(0);

  const isDark = settings.theme !== 'light';

  // File input ref for import
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Computed stats across all sessions
  const stats = useMemo(() => {
    if (!sessions.length) {
      return {
        totalKm: 0,
        totalKwh: 0,
        totalCost: 0,
        totalSaved: 0,
        avgConsumption: 0,
        recentAvg: 0,
        bestTripConsumption: 0,
        worstTripConsumption: 0,
        cityAvg: 0,
        highwayAvg: 0,
      };
    }

    const totalKm = sessions.reduce((acc, s) => acc + s.distanceKm, 0);
    const totalKwh = sessions.reduce((acc, s) => acc + s.energyUsedKwh, 0);
    const totalCost = sessions.reduce((acc, s) => acc + s.totalCost, 0);
    const totalSaved = sessions.reduce((acc, s) => acc + s.moneySaved, 0);
    const avgConsumption = totalKm > 0 ? (totalKwh / totalKm) * 100 : 0;

    // Recent 5 trips
    const recentTrips = sessions.slice(0, 5);
    const recentKm = recentTrips.reduce((acc, s) => acc + s.distanceKm, 0);
    const recentKwh = recentTrips.reduce((acc, s) => acc + s.energyUsedKwh, 0);
    const recentAvg = recentKm > 0 ? (recentKwh / recentKm) * 100 : 0;

    const consumptions = sessions.map((s) => s.consumptionPer100Km).filter((c) => c > 5 && c < 40);
    const bestTripConsumption = consumptions.length ? Math.min(...consumptions) : 0;
    const worstTripConsumption = consumptions.length ? Math.max(...consumptions) : 0;

    // City vs Highway
    const cityTrips = sessions.filter((s) => s.roadType === 'city');
    const cityKm = cityTrips.reduce((acc, s) => acc + s.distanceKm, 0);
    const cityKwh = cityTrips.reduce((acc, s) => acc + s.energyUsedKwh, 0);
    const cityAvg = cityKm > 0 ? (cityKwh / cityKm) * 100 : 0;

    const hwyTrips = sessions.filter((s) => s.roadType === 'highway');
    const hwyKm = hwyTrips.reduce((acc, s) => acc + s.distanceKm, 0);
    const hwyKwh = hwyTrips.reduce((acc, s) => acc + s.energyUsedKwh, 0);
    const highwayAvg = hwyKm > 0 ? (hwyKwh / hwyKm) * 100 : 0;

    return {
      totalKm,
      totalKwh,
      totalCost,
      totalSaved,
      avgConsumption,
      recentAvg,
      bestTripConsumption,
      worstTripConsumption,
      cityAvg,
      highwayAvg,
    };
  }, [sessions]);

  // Historical Driving Style calculation across all recorded sessions
  const driverStyle = useMemo(() => {
    return calculateHistoricalDriverStyle(sessions);
  }, [sessions]);

  // Chart data (chronological: oldest to newest for trend)
  const chartData = useMemo(() => {
    return [...sessions]
      .reverse()
      .map((s, idx) => {
        const shortDate = s.date ? s.date.slice(5) : `#${idx + 1}`;
        const label = s.title || shortDate;
        return {
          id: s.id,
          name: label.length > 12 ? label.slice(0, 10) + '..' : label,
          fullDate: s.date,
          title: s.title || `Поездка ${s.date}`,
          consumption: Number(s.consumptionPer100Km.toFixed(1)),
          distance: s.distanceKm,
          cost: s.totalCost,
          roadType: s.roadType,
          climateOn: s.climateOn,
        };
      });
  }, [sessions]);

  // Filtered list
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (filterRoad !== 'all' && session.roadType !== filterRoad) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchNote = session.note?.toLowerCase().includes(q);
        const matchDate = session.date.includes(q);
        const matchTitle = session.title?.toLowerCase().includes(q);
        if (!matchNote && !matchDate && !matchTitle) return false;
      }
      return true;
    });
  }, [sessions, filterRoad, searchQuery]);

  // Handle Import
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);
        if (parsed.sessions && Array.isArray(parsed.sessions)) {
          onImportBackup(parsed.sessions, parsed.settings);
          triggerHaptic('success', settings.hapticFeedback);
        } else if (Array.isArray(parsed)) {
          onImportBackup(parsed);
          triggerHaptic('success', settings.hapticFeedback);
        }
      } catch {
        alert('Ошибка при чтении файла бэкапа. Убедитесь, что это JSON файл.');
      }
    };
    reader.readAsText(file);
  };

  const getChargingTypeLabel = (type: TripSession['chargingType']) => {
    switch (type) {
      case 'malanka_dc':
        return '⚡ Маланка DC';
      case 'malanka_ac':
        return '🔌 Маланка AC';
      case 'evika':
        return '🔌 Evika AC';
      case 'batteryfly':
        return '🔋 BatteryFly';
      case 'zaryadka':
      case 'zaryadka_dc':
        return '⚡ Зарядка DC';
      case 'zaryadka_ac':
        return '🔌 Зарядка AC';
      case 'fast_day':
      case 'fast_dc':
        return '☀️ Быстрая (День)';
      case 'fast_night':
        return '🌙 Быстрая (Ночь)';
      case 'home_night':
        return '🌙 Дом (Ночь)';
      case 'slow_public':
        return '⚡ Медленная ЭЗС';
      case 'home':
      case 'home_day':
        return '🏠 Домашняя';
      case 'free':
        return '🎁 Бесплатно';
      case 'custom':
        return '✏️ Свой тариф';
      default:
        return '⚡ ЭЗС';
    }
  };

  const getConsumptionBadge = (cons: number) => {
    if (cons < 14) {
      return isDark
        ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80'
        : 'bg-emerald-50 text-emerald-700 border-emerald-300';
    }
    if (cons < 17) {
      return isDark
        ? 'bg-teal-950/80 text-teal-300 border-teal-800/80'
        : 'bg-teal-50 text-teal-700 border-teal-300';
    }
    if (cons < 20) {
      return isDark
        ? 'bg-amber-950/80 text-amber-300 border-amber-800/80'
        : 'bg-amber-50 text-amber-700 border-amber-300';
    }
    return isDark
      ? 'bg-rose-950/80 text-rose-300 border-rose-800/80'
      : 'bg-rose-50 text-rose-700 border-rose-300';
  };

  return (
    <div id="history-tab-container" className="space-y-4 pb-12">
      {/* Top Statistics Overview Banner */}
      <div className={`border rounded-2xl p-4 shadow-xl transition-colors ${
        isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <div className={`flex items-center justify-between mb-3 border-b pb-2.5 ${
          isDark ? 'border-slate-800/80' : 'border-slate-100'
        }`}>
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg ${isDark ? 'bg-teal-500/10 text-teal-400' : 'bg-teal-50 text-teal-600'}`}>
              <History className="w-4 h-4" />
            </div>
            <div>
              <h2 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Аналитика расхода (от зарядки до зарядки)
              </h2>
              <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Всего записей: <span className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{sessions.length}</span>
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              triggerHaptic('medium', settings.hapticFeedback);
              onOpenAddModal();
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold active:scale-95 transition-all shadow-md shadow-emerald-500/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Добавить</span>
          </button>
        </div>

        {/* 4 Main KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* 1. Avg consumption */}
          <div className={`p-3 rounded-xl border flex flex-col justify-between transition-colors ${
            isDark ? 'bg-slate-950/80 border-slate-800/80' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Средний расход</span>
            <div className="mt-1">
              <span className={`text-2xl font-mono font-extrabold ${isDark ? 'text-teal-400' : 'text-teal-600'}`}>
                {stats.avgConsumption > 0 ? stats.avgConsumption.toFixed(1) : '—'}
              </span>
              <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>кВт⋅ч / 100 км</span>
            </div>
            {stats.recentAvg > 0 && (
              <span className={`text-[10px] mt-1 border-t pt-1 ${
                isDark ? 'text-slate-400 border-slate-800/60' : 'text-slate-600 border-slate-200'
              }`}>
                Посл. 5: <b className={isDark ? 'text-slate-200' : 'text-slate-800'}>{stats.recentAvg.toFixed(1)}</b>
              </span>
            )}
          </div>

          {/* 2. Total Distance */}
          <div className={`p-3 rounded-xl border flex flex-col justify-between transition-colors ${
            isDark ? 'bg-slate-950/80 border-slate-800/80' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Общий пробег</span>
            <div className="mt-1">
              <span className={`text-2xl font-mono font-extrabold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                {Math.round(stats.totalKm)}
              </span>
              <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>км зафиксировано</span>
            </div>
            <span className={`text-[10px] mt-1 border-t pt-1 ${
              isDark ? 'text-slate-400 border-slate-800/60' : 'text-slate-600 border-slate-200'
            }`}>
              Энергия: <b className={isDark ? 'text-slate-200' : 'text-slate-800'}>{stats.totalKwh.toFixed(0)} кВт⋅ч</b>
            </span>
          </div>

          {/* 3. Total Cost */}
          <div className={`p-3 rounded-xl border flex flex-col justify-between transition-colors ${
            isDark ? 'bg-slate-950/80 border-slate-800/80' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Затраты на свет</span>
            <div className="mt-1">
              <span className={`text-2xl font-mono font-extrabold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                {stats.totalCost.toFixed(0)}
              </span>
              <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{settings.currency}</span>
            </div>
            <span className={`text-[10px] mt-1 border-t pt-1 ${
              isDark ? 'text-slate-400 border-slate-800/60' : 'text-slate-600 border-slate-200'
            }`}>
              1 км = <b className={isDark ? 'text-slate-200' : 'text-slate-800'}>{stats.totalKm > 0 ? (stats.totalCost / stats.totalKm).toFixed(2) : 0} {settings.currency}</b>
            </span>
          </div>

          {/* 4. Money saved */}
          <div className={`p-3 rounded-xl border flex flex-col justify-between transition-colors ${
            isDark ? 'bg-slate-950/80 border-slate-800/80' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Экономия vs ДВС</span>
            <div className="mt-1">
              <span className={`text-2xl font-mono font-extrabold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                +{stats.totalSaved.toFixed(0)}
              </span>
              <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{settings.currency} в кармане</span>
            </div>
            <span className={`text-[10px] mt-1 border-t pt-1 ${
              isDark ? 'text-emerald-400/80 border-slate-800/60' : 'text-emerald-700 border-slate-200'
            }`}>
              ДВС: {((stats.totalKm / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter).toFixed(0)} {settings.currency}
            </span>
          </div>
        </div>

        {/* City vs Highway comparison tags */}
        {(stats.cityAvg > 0 || stats.highwayAvg > 0) && (
          <div className={`mt-3 pt-2.5 border-t flex flex-wrap items-center justify-between gap-2 text-xs ${
            isDark ? 'border-slate-800/80' : 'border-slate-100'
          }`}>
            <div className="flex items-center gap-3">
              {stats.cityAvg > 0 && (
                <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>
                  🏙️ Город средний: <b className={`font-mono ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>{stats.cityAvg.toFixed(1)}</b> кВт⋅ч
                </span>
              )}
              {stats.highwayAvg > 0 && (
                <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>
                  🛣️ Трасса средний: <b className={`font-mono ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>{stats.highwayAvg.toFixed(1)}</b> кВт⋅ч
                </span>
              )}
            </div>
            {stats.bestTripConsumption > 0 && (
              <span className={`text-[11px] font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                🏆 Рекорд: {stats.bestTripConsumption.toFixed(1)} кВт⋅ч/100км
              </span>
            )}
          </div>
        )}

        {/* Historical Driving Style Coefficient Card */}
        <div className={`mt-3 p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
          isDark
            ? 'bg-slate-950/90 border-slate-800'
            : 'bg-slate-50/90 border-slate-200'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-xl border shrink-0 ${
              driverStyle.factor > 1.05
                ? isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600'
                : driverStyle.factor < 0.95
                ? isDark ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-600'
                : isDark ? 'bg-teal-500/10 border-teal-500/30 text-teal-400' : 'bg-teal-50 border-teal-200 text-teal-600'
            }`}>
              <Gauge className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  Коэффициент стиля вождения (по истории)
                </h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                  driverStyle.factor > 1.05
                    ? isDark ? 'bg-amber-950/80 text-amber-300 border-amber-800' : 'bg-amber-50 text-amber-700 border-amber-200'
                    : driverStyle.factor < 0.95
                    ? isDark ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : isDark ? 'bg-teal-950/80 text-teal-300 border-teal-800' : 'bg-teal-50 text-teal-700 border-teal-200'
                }`}>
                  {driverStyle.label}
                </span>
              </div>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {driverStyle.subLabel}
              </p>
              <div className={`flex flex-wrap items-center gap-3 pt-0.5 text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Анализ по <b className={isDark ? 'text-slate-200' : 'text-slate-800'}>{driverStyle.validTripsCount}</b> поездкам</span>
                <span>•</span>
                <span>Ср. расход: <b className={`font-mono ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>{driverStyle.avgConsumption.toFixed(1)} кВт⋅ч/100км</b></span>
                <span>•</span>
                <span>
                  К эталону (14.5):{' '}
                  <b className={`font-mono ${
                    driverStyle.diffPct < 0 ? 'text-emerald-500' : driverStyle.diffPct > 0 ? 'text-amber-500' : isDark ? 'text-slate-200' : 'text-slate-800'
                  }`}>
                    {driverStyle.diffPct <= 0 ? `${driverStyle.diffPct}%` : `+${driverStyle.diffPct}%`}
                  </b>
                </span>
              </div>
            </div>
          </div>

          <div className="flex sm:flex-col items-center sm:items-end justify-between border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-800/40 shrink-0">
            <span className={`text-[10px] uppercase font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Индекс стиля
            </span>
            <span className={`text-2xl font-mono font-extrabold ${
              driverStyle.factor > 1.05
                ? 'text-amber-400'
                : driverStyle.factor < 0.95
                ? 'text-emerald-400'
                : isDark ? 'text-teal-300' : 'text-teal-600'
            }`}>
              x{driverStyle.factor.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Smooth Consumption Chart (Recharts) */}
      {sessions.length > 0 && (
        <div className={`border rounded-2xl p-4 shadow-xl space-y-3 transition-colors ${
          isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
              isDark ? 'text-slate-300' : 'text-slate-700'
            }`}>
              <TrendingUp className={`w-3.5 h-3.5 ${isDark ? 'text-teal-400' : 'text-teal-600'}`} />
              Плавный график расхода (кВт⋅ч/100 км)
            </span>
            <div className="flex items-center gap-2">
              <span className={`text-[11px] px-2 py-0.5 rounded-md border font-mono ${
                isDark ? 'bg-slate-950 text-slate-400 border-slate-800' : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}>
                Эталон: 14.5 кВт⋅ч
              </span>
            </div>
          </div>

          <div className="h-56 sm:h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="consumptionGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={isDark ? '#10b981' : '#059669'} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={isDark ? '#10b981' : '#059669'} stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? '#334155' : '#e2e8f0'}
                  opacity={0.6}
                  vertical={false}
                />
                <XAxis
                  dataKey="name"
                  stroke={isDark ? '#94a3b8' : '#64748b'}
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#334155' : '#e2e8f0' }}
                />
                <YAxis
                  stroke={isDark ? '#94a3b8' : '#64748b'}
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#334155' : '#e2e8f0' }}
                  domain={['auto', 'auto']}
                  unit=" кВт"
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className={`p-3 rounded-xl border shadow-lg text-xs space-y-1 ${
                          isDark
                            ? 'bg-slate-950/95 border-slate-800 text-slate-100'
                            : 'bg-white border-slate-200 text-slate-900'
                        }`}>
                          <p className="font-bold text-[13px]">{data.title}</p>
                          <p className="text-[11px] text-slate-400">{data.fullDate}</p>
                          <div className="pt-1 space-y-0.5">
                            <p className="flex justify-between gap-3 font-semibold">
                              <span>Расход:</span>
                              <span className="font-mono text-emerald-500">{data.consumption} кВт⋅ч/100км</span>
                            </p>
                            <p className="flex justify-between gap-3">
                              <span className="text-slate-400">Пробег:</span>
                              <span className="font-mono">{data.distance} км</span>
                            </p>
                            <p className="flex justify-between gap-3">
                              <span className="text-slate-400">Стоимость:</span>
                              <span className="font-mono font-medium text-amber-500">{data.cost} {settings.currency}</span>
                            </p>
                            <p className="flex justify-between gap-3 text-[10px] text-slate-400 pt-0.5">
                              <span>Режим:</span>
                              <span>{data.roadType === 'city' ? '🏙️ Город' : data.roadType === 'highway' ? '🛣️ Трасса' : '🔀 Смешанный'} {data.climateOn ? '• ❄️ Климат' : ''}</span>
                            </p>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <ReferenceLine
                  y={14.5}
                  stroke="#10b981"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: '14.5 эталон',
                    position: 'insideTopRight',
                    fill: isDark ? '#10b981' : '#059669',
                    fontSize: 10,
                  }}
                />
                {stats.avgConsumption > 0 && (
                  <ReferenceLine
                    y={Number(stats.avgConsumption.toFixed(1))}
                    stroke="#06b6d4"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    label={{
                      value: `Ср. ${stats.avgConsumption.toFixed(1)}`,
                      position: 'insideBottomRight',
                      fill: isDark ? '#06b6d4' : '#0891b2',
                      fontSize: 10,
                    }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="consumption"
                  stroke={isDark ? '#10b981' : '#059669'}
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#consumptionGradient)"
                  dot={{ r: 3.5, fill: isDark ? '#10b981' : '#059669', strokeWidth: 1 }}
                  activeDot={{ r: 6, fill: '#34d399', stroke: isDark ? '#064e3b' : '#a7f3d0', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Search, Filter & Export Action Bar */}
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Поиск по заметкам, дате..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={`w-full border pl-9 pr-3 py-2 rounded-xl text-xs focus:outline-none transition-colors ${
              isDark
                ? 'bg-slate-900 border-slate-800 text-slate-200 placeholder-slate-500 focus:border-teal-500'
                : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-teal-500 shadow-xs'
            }`}
          />
        </div>

        {/* Road Type Filter Buttons */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          <button
            onClick={() => setFilterRoad('all')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
              filterRoad === 'all'
                ? isDark
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-emerald-500 text-white font-bold'
                : isDark
                ? 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200'
            }`}
          >
            Все ({sessions.length})
          </button>
          <button
            onClick={() => setFilterRoad('city')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
              filterRoad === 'city'
                ? isDark
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-emerald-500 text-white font-bold'
                : isDark
                ? 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200'
            }`}
          >
            Город
          </button>
          <button
            onClick={() => setFilterRoad('highway')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
              filterRoad === 'highway'
                ? isDark
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-emerald-500 text-white font-bold'
                : isDark
                ? 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200'
            }`}
          >
            Трасса
          </button>
        </div>

        {/* Export / Import Data Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              exportSessionsCSV(sessions, settings.currency);
            }}
            title="Экспорт в Excel / CSV"
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-900 hover:bg-slate-800 text-emerald-400 border-slate-800'
                : 'bg-white hover:bg-slate-100 text-emerald-700 border-slate-200 shadow-xs'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          <button
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              exportBackupJSON(settings, sessions);
            }}
            title="Скачать JSON бэкап"
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-900 hover:bg-slate-800 text-teal-400 border-slate-800'
                : 'bg-white hover:bg-slate-100 text-teal-700 border-slate-200 shadow-xs'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Бэкап</span>
          </button>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".json"
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            title="Восстановить из JSON бэкапа"
            className={`p-1.5 rounded-lg border active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border-slate-800'
                : 'bg-white hover:bg-slate-100 text-slate-600 hover:text-slate-900 border-slate-200 shadow-xs'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Trips Session List */}
      <div className="space-y-2.5">
        {filteredSessions.length === 0 ? (
          <div className={`border rounded-2xl p-8 text-center space-y-2 ${
            isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
          }`}>
            <Car className={`w-8 h-8 mx-auto ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
            <p className={`text-sm font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Записей не найдено</p>
            <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Рассчитайте поездку в калькуляторе или нажмите «Добавить» для внесения замера от зарядки до зарядки.
            </p>
          </div>
        ) : (
          filteredSessions.map((trip) => {
            const isExpanded = expandedId === trip.id;

            return (
              <div
                key={trip.id}
                className={`border rounded-2xl p-3.5 transition-all shadow-sm ${
                  isDark
                    ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700/80'
                    : 'bg-white border-slate-200 hover:border-slate-300'
                }`}
              >
                <div
                  className="flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setExpandedId(isExpanded ? null : trip.id)}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {trip.title || `Поездка ${trip.date}`}
                      </span>
                      <span className={`text-[10px] flex items-center gap-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        <Calendar className="w-2.5 h-2.5" /> {trip.date}
                      </span>
                    </div>

                    <div className={`flex items-center gap-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <span className={`font-mono font-semibold ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>
                        {trip.startSoc}% → {trip.endSoc}%
                      </span>
                      <span>•</span>
                      <span className={`font-mono font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                        {trip.distanceKm} км
                      </span>
                      <span>•</span>
                      <span>
                        -{trip.energyUsedKwh.toFixed(1)} кВт⋅ч
                      </span>
                    </div>
                  </div>

                  {/* Consumption Badge & Expand Icon */}
                  <div className="flex items-center gap-2">
                    <div className={`px-2.5 py-1 rounded-xl border font-mono font-bold text-xs ${getConsumptionBadge(trip.consumptionPer100Km)}`}>
                      {trip.consumptionPer100Km.toFixed(1)} <span className="text-[10px] font-normal">кВт⋅ч/100</span>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${isDark ? 'text-slate-400' : 'text-slate-500'} ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className={`mt-3 pt-3 border-t space-y-2.5 text-xs animate-in fade-in duration-200 ${
                    isDark ? 'border-slate-800/80' : 'border-slate-100'
                  }`}>
                    <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 p-2.5 rounded-xl border ${
                      isDark ? 'bg-slate-950/70 border-slate-800/60' : 'bg-slate-50 border-slate-200'
                    }`}>
                      <div>
                        <span className={`text-[10px] block ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Стоимость поездки</span>
                        <span className={`font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                          {trip.totalCost.toFixed(1)} {settings.currency}
                        </span>
                      </div>
                      <div>
                        <span className={`text-[10px] block ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Сэкономлено vs ДВС</span>
                        <span className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                          +{trip.moneySaved.toFixed(1)} {settings.currency}
                        </span>
                      </div>
                      <div>
                        <span className={`text-[10px] block ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Эффективность</span>
                        <span className={`font-bold ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>
                          {trip.kmPerKwh.toFixed(2)} км / кВт⋅ч
                        </span>
                      </div>
                    </div>

                    {/* Meta Tags */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {/* Trip specific style factor relative to baseline */}
                      {(trip.drivingStyleFactor !== undefined || trip.avgSpeedKmH !== undefined) && (() => {
                        const factor = trip.drivingStyleFactor ?? deriveDrivingStyleFactor(trip.avgSpeedKmH, trip.maxSpeedKmH);
                        return <span className={`px-2 py-0.5 rounded-md border font-semibold ${
                          factor < 0.95 ? isDark ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800' : 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                          factor <= 1.05 ? isDark ? 'bg-slate-900 text-slate-300 border-slate-700' : 'bg-slate-50 text-slate-700 border-slate-200' :
                          factor <= 1.15 ? isDark ? 'bg-amber-950/70 text-amber-300 border-amber-800' : 'bg-amber-50 text-amber-700 border-amber-200' :
                          isDark ? 'bg-rose-950/70 text-rose-300 border-rose-800' : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}>🎯 {getDrivingStyleLabel(factor)} · x{factor.toFixed(2)}</span>;
                      })()}
                      {trip.passengers !== undefined && (
                        <span className={`px-2 py-0.5 rounded-md border ${isDark ? 'bg-slate-900 text-slate-300 border-slate-700' : 'bg-slate-50 text-slate-700 border-slate-200'}`}>👥 {trip.passengers} чел.</span>
                      )}
                      {trip.avgSpeedKmH && trip.avgSpeedKmH > 0 && (
                        <span className={`px-2 py-0.5 rounded-md border font-mono font-semibold ${
                          isDark ? 'bg-indigo-950/70 text-indigo-300 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                        }`}>
                          🏎️ Ср. {trip.avgSpeedKmH.toFixed(0)} км/ч
                        </span>
                      )}
                      {trip.temperature !== undefined && (
                        <span className={`px-2 py-0.5 rounded-md border ${
                          isDark ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}>
                          🌡️ {trip.temperature > 0 ? `+${trip.temperature}` : trip.temperature}°C
                        </span>
                      )}
                      <span className={`px-2 py-0.5 rounded-md border ${
                        isDark ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {trip.roadType === 'city' ? '🏙️ Город' : trip.roadType === 'highway' ? '🛣️ Трасса' : '🔀 Смешанный'}
                      </span>
                      <span className={`px-2 py-0.5 rounded-md border ${
                        isDark ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {trip.climateOn ? '❄️ Климат Вкл' : '🍃 Климат Выкл'}
                      </span>
                      <span className={`px-2 py-0.5 rounded-md border ${
                        isDark ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}>
                        {getChargingTypeLabel(trip.chargingType)}
                      </span>
                    </div>

                    {trip.note && (
                      <p className={`text-xs italic p-2 rounded-lg border ${
                        isDark ? 'text-slate-400 bg-slate-950/40 border-slate-800/50' : 'text-slate-600 bg-slate-50 border-slate-200'
                      }`}>
                        «{trip.note}»
                      </p>
                    )}

                    {/* Finish SOC correction */}
                    <div className={`rounded-xl border p-2.5 ${
                      isDark ? 'bg-slate-950/50 border-slate-800/70' : 'bg-slate-50 border-slate-200'
                    }`}>
                      {editingSocId === trip.id ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-[10px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              Корректировка SOC на финише
                            </span>
                            <span className={`font-mono text-sm font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                              {editingSoc}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={trip.startSoc}
                            step={1}
                            value={editingSoc}
                            onChange={(e) => setEditingSoc(Number(e.target.value))}
                            className="w-full accent-emerald-500"
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingSoc((v) => Math.max(0, v - 10))}
                              className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                                isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
                              }`}
                            >−10</button>
                            <button
                              type="button"
                              onClick={() => setEditingSoc((v) => Math.min(trip.startSoc, v + 10))}
                              className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                                isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
                              }`}
                            >+10</button>
                            <div className="flex-1" />
                            <button
                              type="button"
                              onClick={() => setEditingSocId(null)}
                              className={`p-1.5 rounded-lg border ${
                                isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'
                              }`}
                              title="Отменить"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                triggerHaptic('success', settings.hapticFeedback);
                                onUpdateSessionEndSoc(trip.id, editingSoc);
                                setEditingSocId(null);
                              }}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold"
                            >
                              <Check className="w-3.5 h-3.5" /> Сохранить
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className={`text-[10px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>SOC на финише</div>
                            <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                              {trip.endSoc}%
                              {trip.endSocAdjustedManually && (
                                <span className={`ml-1.5 text-[9px] ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>· изменено вручную</span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingSoc(trip.endSoc);
                              setEditingSocId(trip.id);
                            }}
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs font-semibold ${
                              isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-white'
                            }`}
                          >
                            <Pencil className="w-3.5 h-3.5" /> Изменить
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Delete action */}
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('Удалить эту запись из истории?')) {
                            triggerHaptic('medium', settings.hapticFeedback);
                            onDeleteSession(trip.id);
                          }
                        }}
                        className="flex items-center gap-1 text-rose-500 hover:text-rose-600 text-xs font-semibold py-1 px-2 rounded-lg hover:bg-rose-500/10 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Удалить запись</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

