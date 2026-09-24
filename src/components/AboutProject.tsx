import React from 'react';
import { Info, X, Route, CloudSun, Mountain, Gauge, BatteryCharging } from 'lucide-react';

interface AboutProjectProps {
  isOpen: boolean;
  onClose: () => void;
  isDark: boolean;
}

export const AboutProject: React.FC<AboutProjectProps> = ({ isOpen, onClose, isDark }) => {
  if (!isOpen) return null;

  const items = [
    { icon: Route, title: 'Маршрут', text: 'Расстояние, профиль дороги и характер маршрута влияют на итоговый расход.' },
    { icon: Gauge, title: 'Скорость', text: 'Расход меняется в зависимости от заданной скорости и условий движения.' },
    { icon: CloudSun, title: 'Погода', text: 'Учитываются температура, ветер и осадки — то, что реально влияет на расход энергии.' },
    { icon: Mountain, title: 'Рельеф', text: 'Подъёмы увеличивают расход, а спуски могут частично вернуть энергию за счёт рекуперации.' },
    { icon: BatteryCharging, title: 'Заряд батареи', text: 'Расчёт учитывает исходный заряд, доступную ёмкость и ожидаемый остаток в конце поездки.' },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className={`relative w-full sm:max-w-lg max-h-[88vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border shadow-2xl ${isDark ? 'bg-slate-950 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
        <div className={`sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b backdrop-blur-xl ${isDark ? 'bg-slate-950/90 border-slate-800' : 'bg-white/90 border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isDark ? 'bg-cyan-500/15 text-cyan-400' : 'bg-cyan-50 text-cyan-600'}`}>
              <Info className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold">О проекте</h2>
              <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Как работает расчёт запаса хода</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Закрыть" className={`w-9 h-9 rounded-xl flex items-center justify-center border ${isDark ? 'bg-slate-900 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <h3 className="text-lg font-bold mb-2">Не просто расчёт по километрам</h3>
            <p className={`text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              Запас хода электромобиля зависит не только от ёмкости батареи и расстояния. Поэтому калькулятор старается оценивать поездку в целом — с учётом условий, в которых она действительно будет проходить.
            </p>
          </div>

          <div className="space-y-3">
            {items.map(({ icon: Icon, title, text }) => (
              <div key={title} className={`flex gap-3 rounded-2xl p-3.5 border ${isDark ? 'bg-slate-900/60 border-slate-800/80' : 'bg-slate-50 border-slate-200/80'}`}>
                <div className={`w-9 h-9 rounded-xl shrink-0 flex items-center justify-center ${isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-50 text-cyan-600'}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-bold mb-0.5">{title}</div>
                  <p className={`text-xs leading-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{text}</p>
                </div>
              </div>
            ))}
          </div>

          <div className={`rounded-2xl p-4 border ${isDark ? 'bg-cyan-950/20 border-cyan-900/50' : 'bg-cyan-50 border-cyan-100'}`}>
            <p className={`text-xs leading-5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              <span className="font-bold">Главная идея:</span> чем больше факторов известно о поездке, тем реалистичнее получается прогноз. Расчёт является оценкой, а не гарантией — фактический расход всё равно зависит от дорожной ситуации и поведения автомобиля.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
