// Движок расшифровки. Единственный файл, который знает про Gemini.
//
// Интерфейс намеренно узкий: transcribe(bytes) -> {summary, transcript}.
// Если Gemini не подойдёт (гео, формат Opus, качество русского) — замена на
// Groq/whisper меняет только этот файл.

// Проверено на живом API 2026-08-01: расшифровка русской речи из OGG/Opus
// практически эталонная, 488 токенов на 15 секунд аудио.
// Выбран flash-lite ради квоты: 500 запросов в день против существенно
// меньшего лимита у 3.5-flash. Для личного бота это с запасом.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";

// generateContent объявлен легаси, новые модели приземляются в Interactions
// API. Стартуем здесь: форма проще, примеров больше, и модель из списка
// v1beta работает.
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const PROMPT = `Ты расшифровываешь голосовое сообщение из Telegram.

Верни JSON с двумя полями:

transcript — дословная расшифровка. Ровно то, что человек сказал.
Не приглаживай речь, не убирай повторы, не дописывай связки, которых не было.
Расставь знаки препинания и раздели на абзацы по смыслу.
Числительные записывай цифрами: «сорок две тысячи» → «42 000»,
«в три часа» → «в 15:00», если из контекста понятно время суток.
Если часть неразборчива, поставь [неразборчиво] вместо догадки.

summary — суть в двух-трёх строках. Пиши сразу по делу.
Никаких преамбул вида «в этом сообщении говорится» или «автор рассказывает».
Если в сообщении есть договорённость, дата, сумма или просьба — они должны
попасть в summary.

Отвечай по-русски, даже если в аудио есть вставки на другом языке.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    transcript: { type: "STRING" },
  },
  required: ["summary", "transcript"],
};

export class TranscribeError extends Error {}
export class RateLimited extends TranscribeError {}

function apiKey() {
  const value = process.env.GEMINI_API_KEY;
  if (!value) throw new TranscribeError("GEMINI_API_KEY не задан");
  return value;
}

/**
 * @param {Buffer} audioBytes сырые байты .ogg из Telegram
 * @param {string} mimeType Gemini документирует audio/ogg как OGG Vorbis,
 *   а Telegram шлёт Opus. Если прилетит 400 на формате — это здесь.
 */
export async function transcribe(audioBytes, { mimeType = "audio/ogg", deadline } = {}) {
  const body = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBytes.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  };

  // Ретрай на разовых сбоях: сеть и 5xx. На 429 не повторяем — квота
  // исчерпана, повтор только сожжёт ещё одну попытку. На 4xx тоже не
  // повторяем: запрос не станет валиднее от повтора.
  const RETRIES = 1;
  let response;
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      response = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify(body),
        // Замерено: ~8× быстрее реального времени, то есть 10 минут аудио
        // это ~75 с. 120 с даёт полуторакратный запас. Сверху всё равно
        // висит общий дедлайн — он и есть настоящий потолок.
        signal: deadline
          ? AbortSignal.any([AbortSignal.timeout(120_000), deadline])
          : AbortSignal.timeout(120_000),
      });
    } catch (error) {
      lastError = error;
      if (deadline?.aborted) {
        throw new TranscribeError("не уложились в общий лимит времени");
      }
      if (attempt < RETRIES) {
        console.warn(`[gemini] ${error.name}, повтор`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new TranscribeError("Gemini не ответил за 2 минуты, даже со второй попытки");
      }
      throw new TranscribeError(`сеть: ${error.message}`);
    }

    if (response.status >= 500 && attempt < RETRIES) {
      console.warn(`[gemini] HTTP ${response.status}, повтор`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    break;
  }

  if (response.status === 429) {
    throw new RateLimited("квота Gemini исчерпана (429)");
  }

  const raw = await response.text();

  if (!response.ok) {
    let detail;
    try {
      detail = JSON.parse(raw)?.error?.message;
    } catch {
      detail = raw.slice(0, 200);
    }
    throw new TranscribeError(`Gemini HTTP ${response.status}: ${detail}`);
  }

  const parsed = JSON.parse(raw);
  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const reason =
      parsed?.candidates?.[0]?.finishReason ??
      parsed?.promptFeedback?.blockReason ??
      "причина неизвестна";
    throw new TranscribeError(`модель не вернула текст (${reason})`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new TranscribeError(`модель вернула не JSON: ${error.message}`);
  }

  return {
    summary: String(payload.summary ?? "").trim(),
    transcript: String(payload.transcript ?? "").trim(),
  };
}
