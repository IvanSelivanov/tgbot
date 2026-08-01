# Точка входа вебхука на Vercel. Тонкая обёртка — вся логика в lib/handle.rb.
#
# Контракт Ruby-рантайма Vercel: Handler — это Proc с сигнатурой
# |request, response|, где request это WEBrick::HTTPRequest.

require "json"
require_relative "../lib/handle"

Handler = Proc.new do |request, response|
  # Проверка секрета первой строкой, до любой работы. Защищает не от расходов
  # (их закрывает тариф Hobby), а от мусорных апдейтов и чужих запросов.
  secret = ENV["WEBHOOK_SECRET"]

  if secret && request["X-Telegram-Bot-Api-Secret-Token"] != secret
    response.status = 403
    response["Content-Type"] = "text/plain"
    response.body = "forbidden"
  else
    begin
      Handle.handle_update(JSON.parse(request.body.to_s))
    rescue JSON::ParserError => e
      warn "[webhook] тело запроса не JSON: #{e.message}"
    end

    # Telegram всегда получает 200. Ошибку мы уже сообщили пользователю в чат
    # изнутри handle_update; отдавать не-200 значит попросить Telegram
    # прислать тот же апдейт ещё раз и получить дубль.
    response.status = 200
    response["Content-Type"] = "application/json; charset=utf-8"
    response.body = '{"ok":true}'
  end
end
