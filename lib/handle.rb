# Ядро. Вся логика живёт здесь в одном экземпляре.
#
# bot.rb (локальный полинг) и api/index.rb (вебхук на Vercel) — тонкие обёртки
# по ~15 строк, которые только достают update и зовут handle_update.
# Копировать логику между двумя точками входа нельзя: через полгода они
# разъедутся, и чинить придётся дважды.

require_relative "telegram"
require_relative "transcribe"

module Handle
  # Порог длины аудио. Его задаёт НЕ Gemini и НЕ Vercel, а таймаут вебхука
  # Telegram: он ждёт ответа порядка 60 секунд, потом ретраит, а дедупа у нас
  # нет сознательно — значит ретрай означает дубль ответа пользователю.
  #
  # Задержку определяет генерация транскрипта, а не размер входа: три минуты
  # речи это ~3000 знаков вывода, реально 15-40 секунд у Flash. Запас к
  # таймауту получается полутора-трёхкратный.
  #
  # Если Этап 0 покажет потолок функции 60 секунд — снижать до 120.
  MAX_DURATION_SECONDS = Integer(ENV.fetch("MAX_VOICE_SECONDS", "180"))

  # Короче этого саммари не добавляем — на реплике в десять секунд оно шумит.
  SUMMARY_THRESHOLD_SECONDS = Integer(ENV.fetch("SUMMARY_THRESHOLD_SECONDS", "60"))

  # Не 4096: теги блок-цитаты и экранирование добавляют символы к тому, что
  # реально уходит в sendMessage.
  INLINE_TRANSCRIPT_LIMIT = 3500

  # sendChatAction живёт около пяти секунд, а ждём мы 15-40.
  TYPING_REFRESH_SECONDS = 4

  module_function

  def allowed_user_ids
    @allowed_user_ids ||= ENV.fetch("ALLOWED_USER_IDS", "")
                             .split(",")
                             .map { |id| id.strip.to_i }
                             .reject(&:zero?)
                             .freeze
  end

  def handle_update(update)
    message = update["message"]
    return unless message

    # message.from отсутствует, например, у сообщений из канала.
    # Проверять до обращения к .id, иначе исключение вылетит раньше,
    # чем сработает проверка доступа.
    from = message["from"]
    return unless from

    return unless allowed_user_ids.include?(from["id"])

    chat_id = message.dig("chat", "id")
    message_id = message["message_id"]
    voice = message["voice"]

    if voice
      handle_voice(chat_id, message_id, voice)
    else
      handle_non_voice(chat_id, message_id)
    end
  rescue StandardError => e
    warn "[handle] #{e.class}: #{e.message}"
    warn e.backtrace&.first(5)&.join("\n").to_s
    notify_failure(chat_id, message_id, e) if chat_id
  end

  def handle_voice(chat_id, message_id, voice)
    duration = voice["duration"]

    # Некоторые клиенты присылают duration = 0 или не присылают вовсе.
    # Это единственная защита таймаутного бюджета, поэтому пустое значение
    # трактуем как превышение, а не как «наверное, короткое».
    if duration.nil? || duration.to_i <= 0
      return reply(chat_id, message_id,
                   "Не могу определить длину этой голосовухи, поэтому не берусь — " \
                   "рискую не уложиться в таймаут и ответить дважды.")
    end

    if duration.to_i > MAX_DURATION_SECONDS
      return reply(chat_id, message_id,
                   "Голосовуха на #{format_duration(duration)} — длиннее моего порога " \
                   "в #{format_duration(MAX_DURATION_SECONDS)}. " \
                   "Длиннее я не успеваю ответить до того, как Telegram решит, что я упал.")
    end

    if voice["file_size"] && voice["file_size"] > Telegram::MAX_FILE_BYTES
      return reply(chat_id, message_id,
                   "Файл больше 20 МБ — Telegram не отдаёт такие ботам.")
    end

    result = with_typing(chat_id) do
      file = Telegram.get_file(voice["file_id"])
      audio = Telegram.download(file["file_path"])
      Transcribe.call(audio, mime_type: voice["mime_type"] || "audio/ogg")
    end

    deliver(chat_id, message_id, result, duration.to_i)
  end

  def handle_non_voice(chat_id, message_id)
    reply(chat_id, message_id,
          "Пришли голосовое — отвечу текстом. Длиннее " \
          "#{format_duration(MAX_DURATION_SECONDS)} не беру.")
  end

  # Индикатор «печатает» живёт ~5 секунд, поэтому переотправляем его в фоновом
  # треде, пока идёт основная работа. Тред живёт внутри запроса и завершается
  # до ответа — Vercel-ограничение на фоновую работу после ответа не нарушается.
  def with_typing(chat_id)
    ticker = Thread.new do
      loop do
        begin
          Telegram.send_chat_action(chat_id, "typing")
        rescue StandardError
          # Индикатор — украшение. Его падение не должно ронять расшифровку.
        end
        sleep TYPING_REFRESH_SECONDS
      end
    end

    yield
  ensure
    ticker&.kill
  end

  def deliver(chat_id, message_id, result, duration)
    transcript = result.transcript.to_s.strip
    summary = result.summary.to_s.strip
    show_summary = duration >= SUMMARY_THRESHOLD_SECONDS && !summary.empty?

    if transcript.empty?
      return reply(chat_id, message_id, "Модель вернула пустую расшифровку. Попробуй ещё раз.")
    end

    if transcript.length <= INLINE_TRANSCRIPT_LIMIT
      body = +""
      body << "#{Telegram.escape_html(summary)}\n\n" if show_summary
      body << "<blockquote expandable>#{Telegram.escape_html(transcript)}</blockquote>"

      Telegram.send_message(chat_id, body, parse_mode: "HTML", reply_to: message_id)
    else
      # Длинный транскрипт уходит документом. Подписью его не отправить:
      # лимит подписи 1024 знака, а не 4096.
      Telegram.send_message(
        chat_id,
        show_summary ? summary : "Расшифровка длинная — прикладываю файлом.",
        reply_to: message_id
      )
      Telegram.send_document(
        chat_id,
        "transcript-#{Time.now.strftime("%Y%m%d-%H%M%S")}.txt",
        transcript,
        reply_to: message_id
      )
    end
  end

  def notify_failure(chat_id, message_id, error)
    text = case error
           when Transcribe::RateLimited
             "Квота Gemini на сегодня кончилась. Попробуй позже."
           when Transcribe::Error
             "Не смог расшифровать: #{error.message}"
           when Telegram::Error
             "Telegram не отдал файл: #{error.message}"
           else
             "Что-то сломалось: #{error.message}"
           end

    Telegram.send_message(chat_id, text, reply_to: message_id)
  rescue StandardError => e
    warn "[handle] не смог сообщить об ошибке: #{e.message}"
  end

  def reply(chat_id, message_id, text)
    Telegram.send_message(chat_id, text, reply_to: message_id)
  end

  def format_duration(seconds)
    seconds = seconds.to_i
    return "#{seconds} сек" if seconds < 60

    minutes, rest = seconds.divmod(60)
    rest.zero? ? "#{minutes} мин" : "#{minutes} мин #{rest} сек"
  end
end
