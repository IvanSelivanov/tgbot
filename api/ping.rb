# Этап 0, блокирующая проверка: какой реальный потолок длительности
# у Ruby-функции на Vercel Hobby?
#
# 300 секунд задокументированы для рантаймов Node.js и Python на Fluid Compute.
# Ruby в списке Fluid-рантаймов отсутствует, а легаси-потолок Hobby — 60 секунд
# при дефолте 10. От ответа зависит, годится ли выбранный стек вообще.
#
# Как проверять:
#   vercel --prod
#   time curl "https://<project>.vercel.app/api/ping?sleep=90"
#
# Ожидания:
#   {"slept":90,...}                 -> путь открыт, порог аудио можно держать 3 мин
#   FUNCTION_INVOCATION_TIMEOUT ~60s -> остаёмся, но порог вниз до 2 мин
#   FUNCTION_INVOCATION_TIMEOUT ~10s -> Ruby на Vercel не подходит, см. Fallback
#
# Пройди лесенкой, а не одним выстрелом: ?sleep=5, 15, 30, 60, 90.
# Так ты узнаешь точную границу, а не только факт её существования.

require "json"

Handler = Proc.new do |request, response|
  seconds = (request.query["sleep"] || "90").to_i.clamp(0, 290)

  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  sleep(seconds)
  elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

  response.status = 200
  response["Content-Type"] = "application/json; charset=utf-8"
  response.body = JSON.generate(
    requested: seconds,
    slept: elapsed.round(2),
    ruby: RUBY_VERSION,
    ok: true
  )
end
