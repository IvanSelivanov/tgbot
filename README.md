# tgbot

Личный Telegram-бот: пересылаешь голосовое — получаешь текст. Для сообщений
длиннее минуты сверху добавляется суть в двух-трёх строках.

Node.js на Vercel, расшифровка через Gemini. Одна зависимость,
`@vercel/functions`; всё остальное — стандартные `fetch`, `FormData`, `Buffer`.

## Как работает

Вебхук отвечает Telegram сразу, расшифровка идёт в фоне через `waitUntil`.
Короткий транскрипт приходит одним сообщением с раскрывающейся блок-цитатой,
длинный (больше 3500 знаков) — отдельным `.txt`-файлом.

Доступ ограничен списком `ALLOWED_USER_IDS`. Остальные не получают ответа.

## Быстрый старт

```bash
npm install
cp .env.example .env      # заполнить BOT_TOKEN и ALLOWED_USER_IDS
node --env-file=.env bot.js
```

Локально бот работает на long polling, пока открыт терминал. Логика та же,
что в проде.

## Переменные окружения

| Переменная | Обязательна | Описание |
|---|---|---|
| `BOT_TOKEN` | да | Токен от [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USER_IDS` | да | Кому можно. Числовой id (у [@userinfobot](https://t.me/userinfobot)) или `@username`, можно вперемешку |
| `GEMINI_API_KEY` | да | Ключ из [AI Studio](https://aistudio.google.com/apikey) |
| `WEBHOOK_SECRET` | в проде | Произвольная строка, передаётся в `setWebhook` |
| `GEMINI_MODEL` | нет | По умолчанию `gemini-3.1-flash-lite` |
| `MAX_VOICE_SECONDS` | нет | Порог длины, по умолчанию `600` |
| `SUMMARY_THRESHOLD_SECONDS` | нет | Короче — саммари не добавляется, по умолчанию `60` |
| `BUDGET_MS` | нет | Общий лимит на обработку, по умолчанию `270000` |

**Несколько значений — в кавычках:** `ALLOWED_USER_IDS="123456789, @username"`.
Без них пробел после запятой ломает разбор в шелле.

## Деплой

```bash
vercel env add BOT_TOKEN
vercel env add ALLOWED_USER_IDS
vercel env add GEMINI_API_KEY
vercel env add WEBHOOK_SECRET
vercel --prod
```

Изменение переменной применяется только после нового деплоя.

Затем вебхук — **на продовый домен**, не на URL деплоя: последний закрыт
Deployment Protection и отдаёт редирект.

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<project>.vercel.app/api/index",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message"]
  }'
```

В BotFather: `/setjoingroups` → `Disable`, чтобы бота нельзя было добавить
в чужую группу.

## Проверка

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/getMe"
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
vercel logs https://<project>.vercel.app
```

`getWebhookInfo` показывает `last_error_message`, если Telegram не может
достучаться. Логи на Hobby хранятся час.

## Структура

```
api/index.js       вебхук: проверка секрета, ответ, waitUntil
bot.js             локальный полинг
lib/handle.js      ядро: доступ, пороги, форматирование, ошибки
lib/transcribe.js  Gemini
lib/telegram.js    Bot API
```

Обе точки входа зовут `handleUpdate` из `lib/handle.js` — логика не
продублирована. `lib/handle.js` не импортирует `waitUntil`: фоновый запуск
задаёт точка входа.

Смена движка расшифровки затрагивает только `lib/transcribe.js` — интерфейс
`transcribe(bytes) -> {summary, transcript}`.

## Надёжность

Сетевые вызовы к Telegram повторяются до 4 раз с экспоненциальной задержкой.
Запрос к Gemini — до 2 раз, на сетевых сбоях и 5xx; на 429 и 4xx повторов нет.

Сверху всё ограничено общим бюджетом `BUDGET_MS` (270 с при `maxDuration`
300 с). По его исчерпании пользователь получает сообщение, а не тишину.

## Ограничения

- Только голосовые сообщения. Аудиофайлы и видеокружки не обрабатываются.
- Telegram не отдаёт ботам файлы больше 20 МБ.
- Инлайн-лимит Gemini — 20 МБ на запрос с учётом base64, то есть примерно
  14-15 МБ аудио.
- Vercel Hobby — только личное, некоммерческое использование.
- На бесплатном тарифе Gemini данные могут использоваться для улучшения
  моделей и просматриваться людьми. Через бота проходят чужие голосовые.
