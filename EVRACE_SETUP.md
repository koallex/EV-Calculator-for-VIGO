# EVRACE + Vercel (snapshot в Redis)

## В чём была ошибка

`500 FUNCTION_INVOCATION_FAILED` на `/api/evrace/stations` — это падение **Vercel-функции**, не «EVRace выключен».

Старый путь на каждый запрос пользователя качал **весь** реестр BY (~1200 групп, ~13 страниц) с `evrace.by`. На Hobby лимит ~10 с, Cloudflare режет параллельные запросы (429). OSM при этом работал, потому что ходит только по bbox.

## Как сейчас

| Путь | Что делает |
|------|------------|
| `GET /api/evrace/stations` | Только **читает** снимок из Upstash Redis (те же ключи, что логин) |
| `GET /api/cron/evrace-refresh` | Медленно и по одной странице качает EVRace → пишет Redis |

Клиент по-прежнему: EVRace → если пусто/ошибка → OSM.

---

## Проверка Redis в Vercel (у тебя уже для логина)

1. Открой [Vercel Dashboard](https://vercel.com) → свой проект → **Settings** → **Environment Variables**.
2. Должны быть (Production):

| Переменная | Откуда |
|------------|--------|
| `UPSTASH_REDIS_REST_URL` | Upstash → база → REST API → `UPSTASH_REDIS_REST_URL` |
| `UPSTASH_REDIS_REST_TOKEN` | там же, `UPSTASH_REDIS_REST_TOKEN` |
| `AUTH_SECRET` | для сессий логина |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | админ |
| `CRON_SECRET` | **добавь**, если ещё нет — случайная строка ≥ 24 символов |

3. Убедиться, что переменные привязаны к **Production** (и при необходимости Preview).
4. После изменения env — **Redeploy** (Deployments → ⋮ → Redeploy). Env подхватывается только новым деплоем.

### Быстрая проверка, что Redis жив

Если логин в приложение уже работает — Redis настроен правильно. Отдельно EVRace можно проверить так:

```bash
# 1) Пустой снимок сразу после деплоя патча (ещё не прогревали):
curl -s "https://<твой-домен>/api/evrace/stations?minLat=53&maxLat=54&minLon=27&maxLon=28" | head

# Ожидаемо: "groups":[], "cache":false, hint про cron

# 2) Прогрев (один раз после деплоя), 30–60 секунд:
curl -s -H "Authorization: Bearer <CRON_SECRET>" \
  "https://<твой-домен>/api/cron/evrace-refresh"

# Ожидаемо: {"ok":true,"groupsFetched":1000+,...}

# 3) Снова станции:
curl -s "https://<твой-домен>/api/evrace/stations?minLat=53.8&maxLat=53.95&minLon=27.4&maxLon=27.7" | head
# groups уже не пустые, meta.cache: true
```

В Upstash Console → Data Browser появятся ключи:

- `vigo:evrace:meta`
- `vigo:evrace:chunk:0`, `chunk:1`, …

(рядом с `vigo:users`, `vigo:session:…`)

---

## Настройка Cron в Vercel

В репозитории уже есть `vercel.json`:

```json
{
  "crons": [{ "path": "/api/cron/evrace-refresh", "schedule": "0 3 * * *" }]
}
```

1. Задеплой этот патч.
2. **Settings → Cron Jobs** — должен появиться job раз в сутки (03:00 UTC).
3. Обязательно задай **`CRON_SECRET`** в Environment Variables. Vercel сам шлёт `Authorization: Bearer $CRON_SECRET` на cron.

Hobby: только **daily** cron — этого достаточно для реестра станций.

---

## После деплоя — чеклист

1. Env: `UPSTASH_*` + `CRON_SECRET` на Production, Redeploy.
2. Один раз вручную: `curl …/api/cron/evrace-refresh` с Bearer.
3. Проверить `/api/evrace/stations?minLat=…` — есть `groups`.
4. В приложении построить маршрут по РБ — станции EVRace + OSM.

Если cron не успел за 60 с (Cloudflare тормозил), в ответе будет `failedPages > 0` и частичный снимок. Запусти refresh ещё раз через пару минут — доберёт/перезапишет.

---

## Локально

Те же `UPSTASH_*` в `.env`. Затем:

```bash
curl http://localhost:3000/api/cron/evrace-refresh
curl "http://localhost:3000/api/evrace/stations?minLat=53.8&maxLat=53.95&minLon=27.4&maxLon=27.7"
```
