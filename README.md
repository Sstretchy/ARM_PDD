# ARM PDD Bot

Telegram-бот-репетитор по ПДД Армении с квизом, объяснениями, повторами ошибок и карточками по знакам, терминам и разметке.

## Локальный запуск

1. Создайте бота через BotFather и получите токен.
2. Скопируйте `.env.example` в `.env`.
3. Заполните `BOT_TOKEN`.
4. Запустите:

```bash
npm install
npm run dev
```

Локально бот работает через polling и сам запускает расписание.

## Деплой на Vercel

Репозиторий подготовлен под serverless-режим:

- `api/telegram.ts` принимает Telegram webhook
- `api/cron/[slot].ts` запускает дневные касания по слотам
- `.github/workflows/scheduled-touches.yml` запускает эти касания через GitHub Actions

### Что добавить в переменные окружения Vercel

- `BOT_TOKEN`
- `TIMEZONE=Asia/Yerevan`
- `LESSON_SIZE=3`
- `TOUCH_CRONS=30 9 * * *,30 11 * * *,30 13 * * *,30 15 * * *,30 17 * * *,0 20 * * *,0 22 * * *`
- `TELEGRAM_WEBHOOK_SECRET=<любой длинный секрет>`
- `SCHEDULER_SECRET=<отдельный секрет для GitHub Actions>`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

### Что добавить в GitHub Secrets

- `VERCEL_BASE_URL=https://<your-vercel-domain>`
- `SCHEDULER_SECRET=<тот же секрет, что и в Vercel>`

### После деплоя

Нужно один раз выставить webhook у Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"https://<your-vercel-domain>/api/telegram\",\"secret_token\":\"<TELEGRAM_WEBHOOK_SECRET>\"}"
```

Проверить можно так:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

### Бесплатная схема расписания

На `Vercel Hobby` нельзя нормально держать `7` cron в день. Поэтому в этом репозитории расписание для бесплатной схемы вынесено в `GitHub Actions`, а Vercel только принимает webhook и защищённые вызовы `/api/cron/[slot]`.

GitHub Actions ходит в endpoint:

- `POST /api/cron/0`
- `POST /api/cron/1`
- `POST /api/cron/2`
- `POST /api/cron/3`
- `POST /api/cron/4`
- `POST /api/cron/5`
- `POST /api/cron/6`

с заголовком:

- `x-scheduler-secret: <SCHEDULER_SECRET>`

Без этого секрета endpoint вернёт `401`.

## База данных

Пользовательское состояние теперь хранится в `libSQL`:

- локально по умолчанию используется `file:data/app.db`
- на Vercel нужно задать `TURSO_DATABASE_URL` и `TURSO_AUTH_TOKEN`

В БД лежат:

- пользователи
- ответы
- прогресс по вопросам
- quiz sessions
- репорты ошибок

Учебный контент по-прежнему читается из JSON:

- `data/drv-topics/**`
- `data/signs.json`
- `data/terms.json`
- `data/marking.json`

При первом запуске бот автоматически импортирует старые данные из:

- `data/users.json`
- `data/answers.json`
- `data/question-progress.json`
- `data/quiz-sessions.json`
- `data/error-reports.json`

## Сборка

```bash
npm run check
npm run build
```

## Структура

- `src/` — логика бота
- `api/` — Vercel serverless endpoints
- `data/` — учебные данные и текущее JSON-хранилище
- `assets/` — изображения знаков и разметки
