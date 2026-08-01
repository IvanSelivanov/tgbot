#!/usr/bin/env ruby
# Локальный режим для разработки (Этап 1): long polling вместо вебхука.
# Тонкая обёртка — вся логика в lib/handle.rb, ровно та же, что в проде.
#
#   ruby bot.rb
#
# В проде полинг невозможен: serverless-функция существует только во время
# запроса, а без запроса некому крутить цикл.

require_relative "lib/env"
require_relative "lib/handle"

Signal.trap("INT") { exit(0) }

offset = nil
puts "Слушаю. Ctrl-C чтобы остановить."

loop do
  updates = Telegram.call(
    "getUpdates",
    { timeout: 30, offset: offset, allowed_updates: ["message"] }.compact,
    read_timeout: 40
  )

  updates.each do |update|
    offset = update["update_id"] + 1
    Handle.handle_update(update)
  end
rescue Telegram::Error, Net::ReadTimeout, Net::OpenTimeout => e
  warn "[polling] #{e.message}, повтор через 3 с"
  sleep 3
end
