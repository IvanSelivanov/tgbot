# Движок расшифровки. Единственная точка, которая знает про Gemini.
#
# Интерфейс намеренно узкий: Transcribe.call(bytes) -> Result.
# Если Этап 0 покажет, что Gemini не подходит (гео, формат Opus, качество
# русского) — Approach C меняет только этот файл на Groq/whisper.

require "net/http"
require "json"
require "uri"

module Transcribe
  # ВНИМАНИЕ (Open Question 5 в дизайн-доке): имя модели надо сверить в
  # AI Studio. gemini-2.5-flash устарел, 2.0-flash выключен. Держим в env,
  # чтобы менять без правки кода.
  MODEL = ENV.fetch("GEMINI_MODEL", "gemini-3.5-flash")

  # ВНИМАНИЕ (Open Question 4): generateContent объявлен легаси, новые модели
  # приземляются в Interactions API. Стартуем здесь — форма проще и примеров
  # больше — понимая, что миграция когда-нибудь будет.
  ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"

  PROMPT = <<~PROMPT.freeze
    Ты расшифровываешь голосовое сообщение из Telegram.

    Верни JSON с двумя полями:

    transcript — дословная расшифровка. Ровно то, что человек сказал.
    Не приглаживай речь, не убирай повторы, не дописывай связки, которых не
    было. Расставь знаки препинания и раздели на абзацы по смыслу — это всё.
    Если часть неразборчива, поставь [неразборчиво] вместо догадки.

    summary — суть в двух-трёх строках. Пиши сразу по делу.
    Никаких преамбул вида «в этом сообщении говорится» или «автор рассказывает».
    Если в сообщении есть договорённость, дата, сумма или просьба — они должны
    попасть в summary.

    Отвечай по-русски, даже если в аудио есть вставки на другом языке.
  PROMPT

  SCHEMA = {
    type: "OBJECT",
    properties: {
      summary: { type: "STRING" },
      transcript: { type: "STRING" }
    },
    required: %w[summary transcript]
  }.freeze

  Result = Struct.new(:summary, :transcript, keyword_init: true)

  class Error < StandardError; end
  class RateLimited < Error; end

  module_function

  def api_key
    ENV["GEMINI_API_KEY"] or raise Error, "GEMINI_API_KEY не задан"
  end

  # audio_bytes — сырые байты .ogg из Telegram.
  # mime_type — Open Question 2: Gemini документирует audio/ogg как OGG Vorbis,
  # а Telegram шлёт Opus. Если прилетит 400 на формате, это здесь.
  def call(audio_bytes, mime_type: "audio/ogg")
    body = {
      contents: [
        {
          parts: [
            { text: PROMPT },
            {
              inline_data: {
                mime_type: mime_type,
                # pack("m0") вместо require "base64": base64 перестал быть
                # default-гемом в Ruby 3.4, а проект должен пережить апгрейд
                # рантайма без правок.
                data: [audio_bytes].pack("m0")
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA
      }
    }

    parsed = post(body)
    text = extract_text(parsed)
    payload = JSON.parse(text)

    Result.new(
      summary: payload["summary"].to_s.strip,
      transcript: payload["transcript"].to_s.strip
    )
  rescue JSON::ParserError => e
    raise Error, "модель вернула не JSON: #{e.message}"
  end

  def post(body)
    uri = URI("#{ENDPOINT}/#{MODEL}:generateContent")

    request = Net::HTTP::Post.new(uri)
    request["Content-Type"] = "application/json"
    request["x-goog-api-key"] = api_key
    request.body = JSON.generate(body)

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    # Держим ниже таймаута вебхука Telegram (~60 с): лучше своя внятная
    # ошибка, чем ретрай Telegram и дубль ответа пользователю.
    http.read_timeout = 45

    response = http.request(request)

    case response
    when Net::HTTPSuccess
      JSON.parse(response.body)
    when Net::HTTPTooManyRequests
      raise RateLimited, "квота Gemini исчерпана (429)"
    else
      detail = begin
        JSON.parse(response.body).dig("error", "message")
      rescue StandardError
        nil
      end
      raise Error, "Gemini HTTP #{response.code}: #{detail || response.body[0, 200]}"
    end
  rescue Net::OpenTimeout, Net::ReadTimeout
    raise Error, "Gemini не ответил вовремя"
  end

  def extract_text(parsed)
    text = parsed.dig("candidates", 0, "content", "parts", 0, "text")
    return text if text && !text.empty?

    reason = parsed.dig("candidates", 0, "finishReason") ||
             parsed.dig("promptFeedback", "blockReason")
    raise Error, "модель не вернула текст (#{reason || "причина неизвестна"})"
  end
end
