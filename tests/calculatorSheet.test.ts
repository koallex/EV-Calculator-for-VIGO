import {
  stepSheetMode,
  tapSheetMode,
  resolveHandleGesture,
  computeMapInsets,
  insetsKey,
  sheetMaxHeightPx,
  shortPlaceLabel,
  SWIPE_THRESHOLD_PX,
  TAP_SLOP_PX,
  type Rect,
} from '../src/utils/calculatorSheet';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const R = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

// 1) Режимы панели
ok(stepSheetMode('peek', 'up') === 'half' && stepSheetMode('half', 'up') === 'full', 'свайп вверх: peek → half → full');
ok(stepSheetMode('full', 'up') === 'full', 'свайп вверх на краю остаётся full');
ok(stepSheetMode('full', 'down') === 'half' && stepSheetMode('half', 'down') === 'peek', 'свайп вниз: full → half → peek');
ok(stepSheetMode('peek', 'down') === 'peek', 'свайп вниз на краю остаётся peek');
ok(tapSheetMode('peek') === 'half' && tapSheetMode('half') === 'peek' && tapSheetMode('full') === 'half', 'тап: peek→half, half→peek, full→half');

// 2) Жесты по ручке
ok(resolveHandleGesture('peek', 0) === 'half', 'тап без смещения раскрывает панель');
ok(resolveHandleGesture('peek', TAP_SLOP_PX) === 'half' && resolveHandleGesture('peek', -TAP_SLOP_PX) === 'half', 'дрожание пальца в пределах допуска = тап');
ok(resolveHandleGesture('peek', -SWIPE_THRESHOLD_PX) === 'half', 'свайп вверх ровно на пороге срабатывает');
ok(resolveHandleGesture('half', -120) === 'full', 'длинный свайп вверх: half → full (на одну ступень, не сразу до края)');
ok(resolveHandleGesture('full', 120) === 'half', 'свайп вниз: full → half');
ok(resolveHandleGesture('half', 200) === 'peek', 'свайп вниз: half → peek');
ok(resolveHandleGesture('half', -(TAP_SLOP_PX + 5)) === 'half' && resolveHandleGesture('half', SWIPE_THRESHOLD_PX - 1) === 'half', 'неопределённое смещение между допуском и порогом ничего не меняет');

// 3) Отступы карты — портрет 390×~600 (карта в оболочке), верхняя карточка-«пилюля» и свёрнутая панель
{
  const shell = R(0, 100, 390, 700); // 600 px высотой
  const top = R(8, 108, 382, 160);    // пилюля до y=160 → 60 от верха оболочки
  const sheetPeek = R(8, 540, 382, 662); // панель: 122 px, низ 38 px над краем (pb-7)
  const i = computeMapInsets({ shell, topPanel: top, bottomPanel: sheetPeek, landscape: false });
  ok(i.top === 72, `портрет/peek: верхний отступ = низ карточки + запас (${i.top})`);
  ok(i.bottom === 172, `портрет/peek: нижний отступ = высота от панели до низа оболочки + запас (${i.bottom})`);
  ok(i.left === 12 && i.right === 12, 'портрет: боковые отступы только запас');
  const free = 600 - i.top - i.bottom;
  ok(free / 600 >= 0.55, `в свёрнутом виде маршруту доступно ≥55% высоты карты (${Math.round((free / 600) * 100)}%)`);

  // Раскрытая панель занимает много места → окно не схлопывается меньше 28% высоты
  const sheetFull = R(8, 180, 382, 662);
  const f = computeMapInsets({ shell, topPanel: top, bottomPanel: sheetFull, landscape: false });
  const freeFull = 600 - f.top - f.bottom;
  ok(freeFull >= Math.floor(600 * 0.28) - 2, `раскрытая панель: свободное окно не меньше 28% (${freeFull}px)`);
  ok(f.top > 0 && f.bottom > f.top, 'раскрытая панель: сжатие пропорционально, нижний отступ остаётся больше верхнего');

  // Верхняя карточка с двумя полями (~110px) закрывает больше, чем «пилюля»
  const topFields = R(8, 108, 382, 222);
  const e = computeMapInsets({ shell, topPanel: topFields, bottomPanel: sheetPeek, landscape: false });
  ok(e.top > i.top, 'поля А/Б в развёрнутом виде дают больший верхний отступ, чем пилюля');
}

// 4) Ландшафт: панели слева, закрыта левая часть карты
{
  const shell = R(0, 0, 844, 260);
  const top = R(8, 8, 392, 100);
  const bottom = R(8, 120, 392, 240);
  const l = computeMapInsets({ shell, topPanel: top, bottomPanel: bottom, landscape: true });
  ok(l.left === 404 && l.top === 12 && l.bottom === 12 && l.right === 12, `ландшафт: закрыта левая колонка (left=${l.left})`);
  const tooWide = computeMapInsets({ shell, topPanel: R(0, 0, 800, 50), bottomPanel: null, landscape: true });
  ok(tooWide.left <= Math.round(844 * 0.6), 'ландшафт: левый отступ ограничен 60% ширины');
}

// 5) Нет панелей / нулевая оболочка — безопасные значения
{
  const shell = R(0, 0, 390, 600);
  const n = computeMapInsets({ shell, topPanel: null, bottomPanel: null, landscape: false });
  ok(n.top === 12 && n.bottom === 12, 'без панелей остаётся только запас');
  const z = computeMapInsets({ shell: R(0, 0, 0, 0), topPanel: R(0, 0, 10, 10), bottomPanel: R(0, 0, 10, 10), landscape: false });
  ok(Object.values(z).every((v) => Number.isFinite(v) && v >= 0), 'вырожденная оболочка не даёт NaN/отрицательных значений');
}

// 6) Ключ отступов: мелкий дрейф не считается изменением, заметный — считается
{
  const a = { top: 72, right: 12, bottom: 172, left: 12 };
  ok(insetsKey(a) === insetsKey({ ...a, top: 74, bottom: 170 }), 'дрейф на пару пикселей не перезапускает вписывание');
  ok(insetsKey(a) !== insetsKey({ ...a, bottom: 172 + 60 }), 'заметное изменение панели меняет ключ');
}

// 7) Высоты панели
{
  ok(sheetMaxHeightPx('half', 560, 60) === 336, 'half = 60% высоты оболочки');
  ok(sheetMaxHeightPx('full', 560, 60) === 560 - 60 - 36 - 8, 'full = высота оболочки минус верхняя карточка и запас');
  ok(sheetMaxHeightPx('half', 200, 60) === 180, 'half не меньше 180px');
  ok(sheetMaxHeightPx('full', 300, 250) === 220, 'full не меньше 220px');
}

// 8) Подпись точки
ok(shortPlaceLabel('Брест, Брестская область, Беларусь', 'Точка Б') === 'Брест', 'берётся первая часть адреса');
ok(shortPlaceLabel('  ', 'Точка Б') === 'Точка Б' && shortPlaceLabel('', 'Точка А') === 'Точка А', 'пустой адрес → запасная подпись');
ok(shortPlaceLabel(', Минск', 'Точка Б') === 'Точка Б', 'адрес, начинающийся с запятой → запасная подпись');
ok(shortPlaceLabel('улица Ленина 5', 'Точка Б') === 'улица Ленина 5', 'адрес без запятых остаётся целиком');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
