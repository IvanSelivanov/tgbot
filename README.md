# tgbot

Личный Telegram-бот: пересылаешь голосовое — получаешь текст, а для длинных
ещё и суть в двух строках. Node.js на Vercel, расшифровка через Gemini free tier.

## Архитектура: мгновенный ack + фон

Вебхук отвечает Telegram `200` за миллисекунды, а расшифровка уезжает в
`waitUntil` из `@vercel/functions`. Это не оптимизация, а то, ради чего выбран
Node.js — три ограничения исчезают разом:

- **Нет порога длины от таймаута.** Telegram не ждёт ответа, значит длина
  голосовухи упирается только в `maxDuration` (300 с) и лимиты Gemini.
- **Нет дублей.** Telegram ретраит, когда не дождался ответа. Он дождался.
- **Нечего ронять.** Ждать внутри запроса больше не нужно.

### Почему не Ruby

Изначально это было написано на Ruby. Замер на живом деплое показал: Ruby-билдер
Vercel (`vc__handler__ruby.rb`) поднимает внутри лямбды WEBrick на `127.0.0.1:3000`
и сам себе шлёт HTTP-запрос через `Net::HTTP.send_request`, не выставив
`read_timeout`. Значит наследуется дефолт Ruby — **60 секунд**, и `maxDuration: 300`
за этой границей ничего не значит.

Хуже другое: при превышении WEBrick остаётся жить на порту 3000, а
лямбда-контейнер переиспользуется. Каждый следующий запрос падает с
`Errno::EADDRINUSE`. Одна медленная голосовуха ломала бы бота для всех
последующих.

Замеры: `sleep=50` → 200, `sleep=58` → 200, `sleep=90` → `Net::ReadTimeout`,
дальше все запросы → `FUNCTION_INVOCATION_FAILED`.

Node.js и Python — единственные рантаймы Vercel на Fluid Compute (300 с,
Active CPU, `waitUntil`). Ruby и Go туда не входят.

## Что ещё не проверено

Два допущения, обозначенные в коде комментариями:

1. **`GEMINI_MODEL`.** `gemini-2.5-flash` устарел, `2.0-flash` выключен.
   Сверь актуальное имя в AI Studio.
2. **`audio/ogg`.** Telegram шлёт OGG/**Opus**, а Gemini документирует
   `audio/ogg` как OGG **Vorbis**. Примет ли он Opus — не документировано.
   Если прилетит 400 на формате, это `lib/transcribe.js`.

Проверяется одним запросом:

```bash
node -e '
  const fs = require("fs");
  const audio = fs.readFileSync(process.argv[1]).toString("base64");
  fs.writeFileSync("/tmp/req.json", JSON.stringify({
    contents: [{ parts: [
      { text: "Расшифруй это голосовое дословно по-русски." },
      { inline_data: { mime_type: "audio/ogg", data: audio } }
    ]}]
  }));
' voice.ogg

curl -s "https://generativelanguage.googleapis.com/v1beta/models/$GEMINI_MODEL:generateContent" \
  -H "Content-Type: application/json" -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d @/tmp/req.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).candidates?.[0]?.content?.parts?.[0]?.text))'
```

Если Gemini не подойдёт — замена на Groq с `whisper-large-v3-turbo` меняет
только `lib/transcribe.js`: интерфейс `transcribe(bytes) -> {summary, transcript}`
специально узкий.

## Запуск локально

```bash
cp .env.example .env    # заполнить
npm install
node --env-file=.env bot.js
```

Полинг, работает пока открыт терминал. Логика ровно та же, что в проде —
отличается только то, что здесь `handleUpdate` ждут, а на Vercel он уезжает
в `waitUntil`.

## Деплой

```bash
vercel env add BOT_TOKEN
vercel env add GEMINI_API_KEY
vercel env add ALLOWED_USER_IDS
vercel env add WEBHOOK_SECRET
vercel --prod
```

Вебхук — **строго на продовый домен**. На Hobby Deployment Protection закрывает
URL деплоев: проверено, `tgbot-<hash>-<team>.vercel.app` отдаёт 302 на SSO,
а продовый домен — 200. Направишь вебхук туда — Telegram будет молча получать
редирект, а логи на Hobby живут час.

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<project>.vercel.app/api/index",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message"]
  }'
```

В BotFather выключить возможность добавлять бота в группы.

## Структура

```
api/index.js       вебхук: проверка секрета, ack, waitUntil — ~20 строк
bot.js             локальный полинг — ~20 строк
lib/handle.js      ЯДРО: whitelist, пороги, индикатор, форматирование, ошибки
lib/transcribe.js  Gemini — единственный файл, который меняется на Groq
lib/telegram.js    Bot API на глобальном fetch
```

Обе точки входа зовут `handleUpdate` — логика не продублирована. `lib/handle.js`
намеренно **не** импортирует `waitUntil`: фоновый запуск это забота точки входа,
поэтому ядро одинаково в обоих режимах и переживёт смену хостинга.

## Зависимости

Одна: `@vercel/functions` ради `waitUntil`. Всё остальное — глобальный `fetch`,
`FormData`, `Buffer` из Node 18+.

## Известные ограничения

- Только голосовые. Аудиофайлы часто больше 20 МБ (`getFile` их не отдаёт),
  видеокружки у Gemini примерно в восемь раз дороже (~258 токенов/с против 32).
- Файлы больше ~14-15 МБ не пройдут инлайном в Gemini: лимит 20 МБ считается
  на весь запрос, а base64 раздувает на треть.
- Логи на Hobby живут час.
- Hobby только для личного, некоммерческого использования.
- Free tier Gemini обучается на твоих данных, живые ревьюеры могут их видеть.
  Через бота поедут чужие голосовые, и их авторов никто не спрашивал.
