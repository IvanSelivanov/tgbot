// Тонкая обёртка над Bot API. Только глобальный fetch, без зависимостей.

const API_BASE = "https://api.telegram.org";

// getFile отдаёт файлы не больше 20 МБ. Лимит платформы, снимается только
// собственным Local Bot API Server.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Лимиты Bot API: 4096 — текст сообщения, 1024 — подпись к документу.
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;

export class TelegramError extends Error {}

function token() {
  const value = process.env.BOT_TOKEN;
  if (!value) throw new TelegramError("BOT_TOKEN не задан");
  return value;
}

export async function call(method, params, { timeoutMs = 60_000 } = {}) {
  const response = await fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new TelegramError(`${method}: ${payload.description ?? response.status}`);
  }
  return payload.result;
}

export async function getFile(fileId) {
  return call("getFile", { file_id: fileId });
}

export async function download(filePath) {
  const response = await fetch(`${API_BASE}/file/bot${token()}/${filePath}`, {
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new TelegramError(`скачивание файла: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function sendMessage(chatId, text, { parseMode, replyTo } = {}) {
  const params = { chat_id: chatId, text };
  if (parseMode) params.parse_mode = parseMode;
  if (replyTo) params.reply_parameters = { message_id: replyTo };
  return call("sendMessage", params);
}

// Живёт около пяти секунд, поэтому на долгих операциях переотправляется —
// этим занимается withTyping в lib/handle.js.
export async function sendChatAction(chatId, action = "typing") {
  return call("sendChatAction", { chat_id: chatId, action });
}

export async function sendDocument(chatId, filename, content, { caption, replyTo } = {}) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([content], { type: "text/plain" }), filename);
  if (caption) form.set("caption", caption);
  if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo }));

  const response = await fetch(`${API_BASE}/bot${token()}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new TelegramError(`sendDocument: ${payload.description ?? response.status}`);
  }
  return payload.result;
}

// Экранирование для parse_mode=HTML. Три замены, библиотека не нужна.
export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
