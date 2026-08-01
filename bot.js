#!/usr/bin/env node
// Локальный режим для разработки: long polling вместо вебхука.
// Тонкая обёртка — логика в lib/handle.js, ровно та же, что в проде.
//
//   node --env-file=.env bot.js
//
// В проде полинг невозможен: serverless-функция существует только во время
// запроса, а без запроса некому крутить цикл.
//
// Отличие от прода одно: здесь мы дожидаемся handleUpdate, а на Vercel он
// уезжает в waitUntil. Ядро об этом не знает.

import { call, TelegramError } from "./lib/telegram.js";
import { handleUpdate } from "./lib/handle.js";

let offset;
let running = true;

process.on("SIGINT", () => {
  running = false;
  console.log("\nОстанавливаюсь.");
  process.exit(0);
});

console.log("Слушаю. Ctrl-C чтобы остановить.");

while (running) {
  try {
    const updates = await call(
      "getUpdates",
      { timeout: 30, offset, allowed_updates: ["message"] },
      { timeoutMs: 40_000 },
    );

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (error) {
    if (error instanceof TelegramError || error.name === "TimeoutError") {
      console.warn(`[polling] ${error.message}, повтор через 3 с`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      throw error;
    }
  }
}
