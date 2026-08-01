# Загрузка .env для локального запуска. Пятнадцать строк вместо гема dotenv —
# принцип тот же, что и везде в проекте: стандартная библиотека не ломается.
#
# В проде не используется: Vercel отдаёт переменные через ENV сам.

%w[.env.local .env].each do |filename|
  path = File.expand_path("../#{filename}", __dir__)
  next unless File.exist?(path)

  File.foreach(path) do |line|
    line = line.strip
    next if line.empty? || line.start_with?("#")

    key, _, value = line.partition("=")
    next if value.empty?

    value = value.strip
    value = value[1..-2] if value.start_with?('"') && value.end_with?('"')
    value = value[1..-2] if value.start_with?("'") && value.end_with?("'")

    # Первый найденный файл выигрывает: .env.local важнее .env,
    # а уже выставленное окружение важнее обоих.
    ENV[key.strip] ||= value
  end
end
