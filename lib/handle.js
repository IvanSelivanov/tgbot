// Ядро. Вся логика живёт здесь в одном экземпляре.
//
// api/index.js (вебхук на Vercel) и bot.js (локальный полинг) — тонкие
// обёртки, которые только достают update и зовут handleUpdate.
//
// Важно: этот файл НЕ импортирует waitUntil. Фоновый запуск — забота точки
// входа; локально мы просто дожидаемся промиса. Так ядро остаётся
// одинаковым в обоих режимах и переживает смену хостинга.

import * as Telegram from "./telegram.js";
import { transcribe, TranscribeError, RateLimited } from "./transcribe.js";

// Порог длины голосовухи. С waitUntil его больше НЕ задаёт таймаут вебхука
// Telegram: мы отвечаем мгновенно, и Telegram нас не ждёт. Теперь потолок —
// maxDuration функции (300 с на Hobby) и лимиты Gemini.
//
// 600 секунд аудио это ~19k входных токенов и файл ~2.4 МБ — обе величины
// далеко от лимитов. Обработка занимает существенно меньше 300 с.
const MAX_VOICE_SECONDS = Number(process.env.MAX_VOICE_SECONDS ?? 600);

// Короче этого саммари не добавляем: на реплике в десять секунд оно шумит.
const SUMMARY_THRESHOLD_SECONDS = Number(process.env.SUMMARY_THRESHOLD_SECONDS ?? 60);

// Не 4096: теги блок-цитаты и экранирование добавляют символы к тому,
// что реально уходит в sendMessage.
const INLINE_TRANSCRIPT_LIMIT = 3500;

// sendChatAction живёт около пяти секунд.
const TYPING_REFRESH_MS = 4000;

// Общий бюджет на обработку одной голосовухи. maxDuration функции 300 с;
// оставляем 30 с на холодный старт, отправку ответа и разбор ошибки.
//
// Без этого потолка сумма таймаутов трёх звеньев с ретраями (getFile 4×15,
// download 4×30, Gemini 2×120) переваливает за 300 с — функцию прибьют на
// середине, и пользователь не получит НИЧЕГО: ни текста, ни ошибки.
// Дедлайн превращает тихий отказ в понятное сообщение.
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 270_000);

// ALLOWED_USER_IDS принимает и числовые id, и @username вперемешку:
//   ALLOWED_USER_IDS=123456789, @ivselivanov
//
// Числовой id надёжнее: он неизменен. Username можно сменить, а
// освободившийся — занять кому-то другому, и тогда доступ уедет вместе с ним.
// Поэтому при совпадении по username мы разово печатаем числовой id в лог,
// чтобы его можно было зафиксировать.
function allowList() {
  const raw = (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const ids = new Set();
  const usernames = new Set();

  for (const item of raw) {
    if (/^-?\d+$/.test(item)) {
      ids.add(Number(item));
    } else {
      usernames.add(item.replace(/^@/, "").toLowerCase());
    }
  }

  return { ids, usernames };
}

function isAllowed(from) {
  const { ids, usernames } = allowList();

  if (ids.has(from.id)) return true;

  const username = from.username?.toLowerCase();
  if (username && usernames.has(username)) {
    console.log(
      `[handle] доступ по @${from.username}. Числовой id: ${from.id} — ` +
        `надёжнее вписать его в ALLOWED_USER_IDS вместо username.`,
    );
    return true;
  }

  return false;
}

export async function handleUpdate(update) {
  const message = update?.message;
  if (!message) return;

  // message.from отсутствует, например, у сообщений из канала.
  // Проверять до обращения к .id.
  const from = message.from;
  if (!from) return;

  if (!isAllowed(from)) return;

  const chatId = message.chat?.id;
  const messageId = message.message_id;
  if (!chatId) return;

  try {
    if (message.voice) {
      await handleVoice(chatId, messageId, message.voice);
    } else {
      await Telegram.sendMessage(
        chatId,
        `Пришли голосовое — отвечу текстом. Длиннее ${formatDuration(MAX_VOICE_SECONDS)} не беру.`,
        { replyTo: messageId },
      );
    }
  } catch (error) {
    console.error("[handle]", error);
    await notifyFailure(chatId, messageId, error);
  }
}

async function handleVoice(chatId, messageId, voice) {
  const duration = Number(voice.duration);

  // Некоторые клиенты присылают duration = 0 или не присылают вовсе.
  // Раз мы больше не боремся с таймаутом вебхука, это уже не вопрос
  // безопасности — но пропускать неизвестную длину в Gemini всё равно
  // не стоит: квота у нас конечная.
  if (!Number.isFinite(duration) || duration <= 0) {
    return Telegram.sendMessage(
      chatId,
      "Не могу определить длину этой голосовухи — не берусь, чтобы не жечь квоту вслепую.",
      { replyTo: messageId },
    );
  }

  if (duration > MAX_VOICE_SECONDS) {
    return Telegram.sendMessage(
      chatId,
      `Голосовуха на ${formatDuration(duration)} — длиннее моего порога в ${formatDuration(MAX_VOICE_SECONDS)}.`,
      { replyTo: messageId },
    );
  }

  if (voice.file_size && voice.file_size > Telegram.MAX_FILE_BYTES) {
    return Telegram.sendMessage(chatId, "Файл больше 20 МБ — Telegram не отдаёт такие ботам.", {
      replyTo: messageId,
    });
  }

  const deadline = AbortSignal.timeout(BUDGET_MS);

  const result = await withTyping(chatId, async () => {
    const file = await Telegram.getFile(voice.file_id, { deadline });
    const audio = await Telegram.download(file.file_path, { deadline });
    return transcribe(audio, { mimeType: voice.mime_type ?? "audio/ogg", deadline });
  });

  await deliver(chatId, messageId, result, duration);
}

// Индикатор «печатает» живёт ~5 секунд, поэтому переотправляем его, пока
// идёт работа. Интервал обязательно гасится в finally.
async function withTyping(chatId, work) {
  const tick = () => Telegram.sendChatAction(chatId, "typing").catch(() => {});
  tick();
  const timer = setInterval(tick, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function deliver(chatId, messageId, result, duration) {
  const transcript = result.transcript?.trim() ?? "";
  const summary = result.summary?.trim() ?? "";
  const showSummary = duration >= SUMMARY_THRESHOLD_SECONDS && summary.length > 0;

  if (!transcript) {
    return Telegram.sendMessage(chatId, "Модель вернула пустую расшифровку. Попробуй ещё раз.", {
      replyTo: messageId,
    });
  }

  if (transcript.length <= INLINE_TRANSCRIPT_LIMIT) {
    const head = showSummary ? `${Telegram.escapeHtml(summary)}\n\n` : "";
    const body = `${head}<blockquote expandable>${Telegram.escapeHtml(transcript)}</blockquote>`;
    return Telegram.sendMessage(chatId, body, { parseMode: "HTML", replyTo: messageId });
  }

  // Длинный транскрипт уходит документом. Подписью его не отправить:
  // лимит подписи 1024 знака, а не 4096.
  await Telegram.sendMessage(
    chatId,
    showSummary ? summary : "Расшифровка длинная — прикладываю файлом.",
    { replyTo: messageId },
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await Telegram.sendDocument(chatId, `transcript-${stamp}.txt`, transcript, {
    replyTo: messageId,
  });
}

async function notifyFailure(chatId, messageId, error) {
  let text;
  if (error instanceof RateLimited) {
    text = "Квота Gemini на сегодня кончилась. Попробуй позже.";
  } else if (error instanceof TranscribeError) {
    text = `Не смог расшифровать: ${error.message}`;
  } else if (error instanceof Telegram.BudgetExhausted) {
    text = "Не уложился по времени — Telegram или Gemini сегодня тормозят. Пришли ещё раз.";
  } else if (error instanceof Telegram.TelegramError) {
    text = `Не получилось: ${error.message}`;
  } else {
    // Сюда попадает только то, что мы не предусмотрели. Сырой текст
    // исключения пользователю не показываем — он английский и невнятный
    // (как было с DOMException «The operation was aborted due to timeout»).
    // Подробности уходят в лог, пользователю — понятное действие.
    text = "Что-то пошло не так на моей стороне. Пришли это голосовое ещё раз.";
  }

  try {
    await Telegram.sendMessage(chatId, text, { replyTo: messageId });
  } catch (sendError) {
    console.error("[handle] не смог сообщить об ошибке:", sendError);
  }
}

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (total < 60) return `${total} сек`;

  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} сек`;
}
