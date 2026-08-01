# tgbot

Личный Telegram-бот: пересылаешь голосовое — получаешь текст, а для длинных
ещё и суть в двух строках. Ruby на Vercel, расшифровка через Gemini free tier.

Дизайн-док: `~/.gstack/projects/tgbot/ivanselivanov-nogit-design-20260729-231744.md`

## Статус: не проверено на живом деплое

**Перед тем как пользоваться, надо пройти Этап 0.** В проекте есть один
блокирующий вопрос без запасного плана и два с запасным.

### Проверка 1 (блокирующая): потолок длительности Ruby-функции

Лимит 300 секунд Vercel документирует для рантаймов Node.js и Python на Fluid
Compute. **Ruby в списке Fluid-рантаймов отсутствует**, а легаси-потолок Hobby —
60 секунд при дефолте 10. От ответа зависит, годится ли этот стек вообще.

```bash
npm i -g vercel
vercel --prod

curl "https://<project>.vercel.app/api/ping?sleep=5"
curl "https://<project>.vercel.app/api/ping?sleep=30"
curl "https://<project>.vercel.app/api/ping?sleep=90"
```

| Результат | Что делать |
|---|---|
| `sleep=90` вернул 200 | Всё хорошо, `MAX_VOICE_SECONDS=180` |
| таймаут около 60 с | `MAX_VOICE_SECONDS=120`, следить за задержкой |
| таймаут около 10 с | Ruby на Vercel не подходит. Менять рантайм или хост |

### Проверка 2: Gemini — гео, формат, качество

Telegram шлёт голосовые в OGG/**Opus**. Gemini документирует `audio/ogg` как
OGG **Vorbis**. Примет ли он Opus — не документировано, а ffmpeg на Vercel
взять неоткуда (потолок бандла для Ruby 250 МБ, Large Functions только для
Node.js и Python).

Скачай из Telegram реальную голосовуху и прогони:

```bash
ruby -e '
  require "json"
  audio = File.binread(ARGV[0])
  body = {
    contents: [{ parts: [
      { text: "Расшифруй это голосовое дословно по-русски." },
      { inline_data: { mime_type: "audio/ogg", data: [audio].pack("m0") } }
    ]}]
  }
  File.write("/tmp/gemini-req.json", JSON.generate(body))
' voice.ogg

curl -s "https://generativelanguage.googleapis.com/v1beta/models/$GEMINI_MODEL:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d @/tmp/gemini-req.json | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig("candidates",0,"content","parts",0,"text")'
```

Если 400 на формате, или API недоступен из твоего региона, или русский текст
плохой — переключаемся на Groq с `whisper-large-v3-turbo` (Approach C в доке,
меняется только `lib/transcribe.rb`).

## Запуск локально

```bash
cp .env.example .env    # заполнить
ruby bot.rb
```

Полинг, работает пока открыт терминал. Логика ровно та же, что в проде.

## Деплой

```bash
vercel env add BOT_TOKEN
vercel env add GEMINI_API_KEY
vercel env add ALLOWED_USER_IDS
vercel env add WEBHOOK_SECRET
vercel --prod
```

Вебхук — **строго на продовый домен**. На Hobby Deployment Protection закрывает
preview-URL, и Telegram будет молча получать 401, а логи живут час.

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
api/ping.rb        проверка потолка длительности (Этап 0)
api/index.rb       вебхук — обёртка ~20 строк
bot.rb             локальный полинг — обёртка ~20 строк
lib/handle.rb      ЯДРО: whitelist, пороги, индикатор, форматирование, ошибки
lib/transcribe.rb  Gemini. Единственный файл, который меняется на Groq
lib/telegram.rb    Bot API на net/http
lib/env.rb         загрузка .env локально
```

Обе точки входа зовут `Handle.handle_update` — логика не продублирована.

## Почему нет гемов

Нужны четыре вызова Telegram и один Gemini. Стандартная библиотека это
покрывает, а проект должен пережить полгода простоя: зависимость, которая
обновляется чаще, чем ты открываешь проект, — это обязанность, которой быть
не должно.

Граница у принципа есть: формат запроса к Gemini — тоже внешняя зависимость,
и она уже поехала. `generateContent` объявлен легаси, новые модели приземляются
в Interactions API. `net/http` не гниёт — гниёт JSON, который в него кладут.

## Известные ограничения

- **Возможен дубль ответа**, если Gemini ответит дольше, чем Telegram ждёт
  (~60 с). Защита одна — порог `MAX_VOICE_SECONDS`. Дедуп требовал бы внешнего
  хранилища. Появятся дубли — снижай порог, а не заводи базу.
- Только голосовые. Аудиофайлы часто больше 20 МБ, видеокружки у Gemini
  примерно в восемь раз дороже.
- Логи на Hobby живут час.
- Hobby только для личного, некоммерческого использования.
- Free tier Gemini обучается на твоих данных, живые ревьюеры могут их видеть.
  Через бота поедут чужие голосовые.
