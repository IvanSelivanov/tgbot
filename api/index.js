// Точка входа вебхука. Тонкая обёртка — вся логика в lib/handle.js.
//
// Суть архитектуры: отвечаем Telegram 200 немедленно, а расшифровку
// доделываем в waitUntil. Отсюда три следствия:
//   - Telegram нас не ждёт, значит ретраев и дублей нет;
//   - длина голосовухи больше не упирается в таймаут вебхука;
//   - упереться в потолок нечем, отравлять инстанс нечему.

import { waitUntil } from "@vercel/functions";
import { handleUpdate } from "../lib/handle.js";

export default function handler(request, response) {
  // Проверка секрета первой строкой, до любой работы. Защищает не от расходов
  // (их закрывает тариф Hobby), а от мусорных апдейтов и чужих запросов.
  const secret = process.env.WEBHOOK_SECRET;

  if (secret && request.headers["x-telegram-bot-api-secret-token"] !== secret) {
    response.status(403).json({ ok: false });
    return;
  }

  const update = typeof request.body === "string" ? safeParse(request.body) : request.body;

  if (update) {
    // Ошибку глотаем здесь: handleUpdate уже сообщил о ней пользователю в чат,
    // а необработанный reject в фоне уронил бы инстанс.
    waitUntil(
      handleUpdate(update).catch((error) => {
        console.error("[webhook] фоновая обработка упала:", error);
      }),
    );
  }

  // Telegram всегда получает 200 и получает его сразу.
  response.status(200).json({ ok: true });
}

function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    console.error("[webhook] тело запроса не JSON:", error.message);
    return null;
  }
}
