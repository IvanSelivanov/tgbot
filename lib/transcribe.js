// Движок расшифровки. Единственный файл, который знает про Gemini.
//
// Интерфейс намеренно узкий: transcribe(bytes) -> {summary, transcript}.
// Если Gemini не подойдёт (гео, формат Opus, качество русского) — замена на
// Groq/whisper меняет только этот файл.

// ВНИМАНИЕ: имя модели сверить в AI Studio. gemini-2.5-flash устарел,
// 2.0-flash выключен. Держим в env, чтобы менять без правки кода.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

// ВНИМАНИЕ: generateContent объявлен легаси, новые модели приземляются в
// Interactions API. Стартуем здесь — форма проще, примеров больше.
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const PROMPT = `Ты расшифровываешь голосовое сообщение из Telegram.

Верни JSON с двумя полями:

transcript — дословная расшифровка. Ровно то, что человек сказал.
Не приглаживай речь, не убирай повторы, не дописывай связки, которых не было.
Расставь знаки препинания и раздели на абзацы по смыслу — это всё.
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
export async function transcribe(audioBytes, { mimeType = "audio/ogg" } = {}) {
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

  let response;
  try {
    response = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey(),
      },
      body: JSON.stringify(body),
      // Щедро: мы в фоне через waitUntil, Telegram нас уже не ждёт.
      // Потолок — maxDuration функции (300 с), а не таймаут вебхука.
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new TranscribeError("Gemini не ответил за 4 минуты");
    }
    throw new TranscribeError(`сеть: ${error.message}`);
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
