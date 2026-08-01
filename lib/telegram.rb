# Тонкая обёртка над Bot API на стандартной библиотеке.
# Без гемов сознательно: нужны четыре вызова, гем дороже.

require "net/http"
require "json"
require "uri"

module Telegram
  API_BASE = "https://api.telegram.org"

  # getFile отдаёт файлы не больше 20 МБ. Лимит платформы, обойти нельзя
  # (снимается только собственным Local Bot API Server).
  MAX_FILE_BYTES = 20 * 1024 * 1024

  # Лимиты Bot API. 4096 — текст сообщения, 1024 — подпись к документу.
  MAX_MESSAGE_CHARS = 4096
  MAX_CAPTION_CHARS = 1024

  class Error < StandardError; end

  module_function

  def token
    ENV["BOT_TOKEN"] or raise Error, "BOT_TOKEN не задан"
  end

  def http_for(uri, read_timeout: 60)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = read_timeout
    http
  end

  def call(method, params, read_timeout: 60)
    uri = URI("#{API_BASE}/bot#{token}/#{method}")
    request = Net::HTTP::Post.new(uri, "Content-Type" => "application/json")
    request.body = JSON.generate(params)

    response = http_for(uri, read_timeout: read_timeout).request(request)
    parsed = JSON.parse(response.body)

    unless parsed["ok"]
      raise Error, "#{method}: #{parsed["description"] || response.code}"
    end

    parsed["result"]
  end

  def get_file(file_id)
    call("getFile", { file_id: file_id })
  end

  def download(file_path)
    uri = URI("#{API_BASE}/file/bot#{token}/#{file_path}")
    response = http_for(uri, read_timeout: 120).request(Net::HTTP::Get.new(uri))

    unless response.is_a?(Net::HTTPSuccess)
      raise Error, "скачивание файла: HTTP #{response.code}"
    end

    response.body
  end

  def send_message(chat_id, text, parse_mode: nil, reply_to: nil)
    params = { chat_id: chat_id, text: text }
    params[:parse_mode] = parse_mode if parse_mode
    params[:reply_parameters] = { message_id: reply_to } if reply_to
    call("sendMessage", params)
  end

  # Живёт примерно пять секунд. Для длинных операций переотправлять —
  # этим занимается Handle.with_typing.
  def send_chat_action(chat_id, action = "typing")
    call("sendChatAction", { chat_id: chat_id, action: action })
  end

  def send_document(chat_id, filename, content, caption: nil, reply_to: nil)
    uri = URI("#{API_BASE}/bot#{token}/sendDocument")
    boundary = "----tgbot#{Time.now.to_i}#{rand(1_000_000)}"

    fields = { "chat_id" => chat_id.to_s }
    fields["caption"] = caption if caption
    fields["reply_parameters"] = JSON.generate(message_id: reply_to) if reply_to

    body = +""
    fields.each do |name, value|
      body << "--#{boundary}\r\n"
      body << %(Content-Disposition: form-data; name="#{name}"\r\n\r\n)
      body << "#{value}\r\n"
    end
    body << "--#{boundary}\r\n"
    body << %(Content-Disposition: form-data; name="document"; filename="#{filename}"\r\n)
    body << "Content-Type: text/plain; charset=utf-8\r\n\r\n"
    body << content
    body << "\r\n--#{boundary}--\r\n"

    request = Net::HTTP::Post.new(uri)
    request["Content-Type"] = "multipart/form-data; boundary=#{boundary}"
    request.body = body.b

    response = http_for(uri, read_timeout: 120).request(request)
    parsed = JSON.parse(response.body)
    raise Error, "sendDocument: #{parsed["description"]}" unless parsed["ok"]

    parsed["result"]
  end

  # Экранирование для parse_mode=HTML.
  # Своя реализация вместо CGI.escapeHTML: не хочется зависеть от того,
  # останется ли cgi default-гемом в следующих версиях Ruby.
  def escape_html(text)
    text.to_s.gsub("&", "&amp;").gsub("<", "&lt;").gsub(">", "&gt;")
  end
end
