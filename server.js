const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/u, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:4b";
const MAX_BODY_SIZE = 100_000;
const MAX_HISTORY_MESSAGES = 24;
const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, "static");
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(ROOT, "data", "chat.db");

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Новый чат',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS messages_conversation
    ON messages(conversation_id, id);
`);

const statements = {
  listConversations: database.prepare(
    "SELECT c.id, c.title, c.created_at, c.updated_at, " +
      "(SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview " +
      "FROM conversations c ORDER BY c.updated_at DESC",
  ),
  getConversation: database.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
  ),
  createConversation: database.prepare(
    "INSERT INTO conversations (id) VALUES (?)",
  ),
  listMessages: database.prepare(
    "SELECT id, role, content, created_at FROM messages " +
      "WHERE conversation_id = ? ORDER BY id",
  ),
  recentMessages: database.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? " +
      "ORDER BY id DESC LIMIT ?",
  ),
  insertMessage: database.prepare(
    "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
  ),
  updateConversation: database.prepare(
    "UPDATE conversations SET title = CASE WHEN title = 'Новый чат' THEN ? ELSE title END, " +
      "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ),
  deleteConversation: database.prepare(
    "DELETE FROM conversations WHERE id = ?",
  ),
};

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

function sendSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; script-src 'self'; " +
      "connect-src 'self'; img-src 'self' data:; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
}

function sendJson(response, status, payload) {
  const content = JSON.stringify(payload);
  sendSecurityHeaders(response);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
  });
  response.end(content);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let tooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_SIZE) {
        tooLarge = true;
        reject(Object.assign(new Error("Запрос слишком большой"), { status: 413 }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (!body) {
        reject(Object.assign(new Error("Запрос не содержит данных"), { status: 400 }));
        return;
      }
      try {
        const payload = JSON.parse(body);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          reject(Object.assign(new Error("Ожидался JSON-объект"), { status: 400 }));
          return;
        }
        resolve(payload);
      } catch {
        reject(Object.assign(new Error("Некорректный JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function readRequestJson(request, response) {
  return readJson(request).catch((error) => {
    sendJson(response, error.status || 400, { error: error.message });
    return null;
  });
}

function sendStreamEvent(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function getOllamaError(status) {
  if (status === 404) {
    return `Модель «${OLLAMA_MODEL}» ещё не установлена. Запусти команду: ollama pull ${OLLAMA_MODEL}`;
  }
  return "Локальная ИИ-модель недоступна. Проверь, что запущен Ollama.";
}

async function streamAssistantReply(request, response, conversationId, userMessage) {
  const history = statements.recentMessages
    .all(conversationId, MAX_HISTORY_MESSAGES)
    .reverse()
    .map((message) => ({ role: message.role, content: message.content }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let disconnected = false;
  response.on("close", () => {
    disconnected = true;
    controller.abort();
  });

  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "Ты — дружелюбный, умный ИИ-помощник. Отвечай естественно и по делу " +
              "на языке пользователя. Учитывай всю историю разговора. " +
              "Не показывай внутренние рассуждения: приводи только ответ и краткие " +
              "объяснения, если они нужны. Если не знаешь ответа — честно скажи. " +
              "Используй Markdown, когда это помогает.",
          },
          ...history,
          { role: "user", content: userMessage },
        ],
        think: false,
        options: { num_ctx: 4096 },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      sendJson(response, upstream.status === 404 ? 503 : 502, {
        error: getOllamaError(upstream.status),
      });
      return;
    }

    sendSecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    let remainder = "";
    let answer = "";
    let modelTextBuffer = "";
    let detectingThoughtFormat = true;
    let insideThought = false;
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    function appendVisibleText(text, final = false) {
      modelTextBuffer += text;
      let visible = "";
      while (modelTextBuffer) {
        if (detectingThoughtFormat) {
          const openingTag = modelTextBuffer.indexOf("<think>");
          const closingTag = modelTextBuffer.indexOf("</think>");
          if (closingTag !== -1 && (openingTag === -1 || closingTag < openingTag)) {
            // Older Ollama Qwen3 templates may omit the opening thought tag.
            modelTextBuffer = modelTextBuffer.slice(closingTag + "</think>".length);
            detectingThoughtFormat = false;
            continue;
          }
          if (openingTag !== -1) {
            visible += modelTextBuffer.slice(0, openingTag);
            modelTextBuffer = modelTextBuffer.slice(openingTag + "<think>".length);
            detectingThoughtFormat = false;
            insideThought = true;
            continue;
          }
          if (final) {
            visible += modelTextBuffer;
            modelTextBuffer = "";
            detectingThoughtFormat = false;
          }
          break;
        }

        if (insideThought) {
          const closingTag = modelTextBuffer.indexOf("</think>");
          if (closingTag === -1) {
            if (final) modelTextBuffer = "";
            break;
          }
          modelTextBuffer = modelTextBuffer.slice(closingTag + "</think>".length);
          insideThought = false;
          continue;
        }

        const openingTag = modelTextBuffer.indexOf("<think>");
        if (openingTag !== -1) {
          visible += modelTextBuffer.slice(0, openingTag);
          modelTextBuffer = modelTextBuffer.slice(openingTag + "<think>".length);
          insideThought = true;
          continue;
        }

        let retainedLength = 0;
        if (!final) {
          for (let length = 1; length < "<think>".length; length += 1) {
            if (
              modelTextBuffer.endsWith("<think>".slice(0, length)) &&
              length > retainedLength
            ) {
              retainedLength = length;
            }
          }
        }
        const readyLength = modelTextBuffer.length - retainedLength;
        visible += modelTextBuffer.slice(0, readyLength);
        modelTextBuffer = modelTextBuffer.slice(readyLength);
        break;
      }

      if (final && !insideThought && modelTextBuffer) {
        visible += modelTextBuffer;
        modelTextBuffer = "";
      }
      if (visible) {
        answer += visible;
        sendStreamEvent(response, "token", { text: visible });
      }
    }

    function handleModelLine(line) {
      if (!line.trim()) return;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch (error) {
        throw new Error("Получен некорректный ответ от ИИ-модели", { cause: error });
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) {
        appendVisibleText(chunk.message.content);
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      remainder += decoder.decode(value, { stream: !done });
      const lines = remainder.split("\n");
      remainder = lines.pop() || "";
      for (const line of lines) handleModelLine(line);
      if (done) break;
    }
    handleModelLine(remainder);
    appendVisibleText("", true);

    if (!answer.trim()) throw new Error("ИИ-модель вернула пустой ответ");
    database.exec("BEGIN");
    try {
      statements.insertMessage.run(conversationId, "user", userMessage);
      statements.insertMessage.run(conversationId, "assistant", answer);
      statements.updateConversation.run(userMessage.slice(0, 80), conversationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    sendStreamEvent(response, "done", { conversationId });
    response.end();
  } catch (error) {
    if (disconnected) return;
    console.error("Ошибка запроса к локальной ИИ-модели:", error);
    if (!response.headersSent) {
      const unavailable = error.cause?.code === "ECONNREFUSED" ||
        error.cause?.code === "ENOTFOUND" ||
        error.name === "TimeoutError" ||
        error.name === "AbortError";
      sendJson(response, unavailable ? 503 : 502, {
        error: unavailable ? getOllamaError(0) : "Не удалось получить ответ от ИИ-модели",
      });
      return;
    }
    sendStreamEvent(response, "error", { error: "Генерация ответа прервалась. Попробуй ещё раз." });
    response.end();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleRequest(request, response) {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || HOST}`);
  } catch {
    sendJson(response, 400, { error: "Некорректный адрес запроса" });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: "Некорректный адрес запроса" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    try {
      const ollama = await fetch(`${OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!ollama.ok) {
        sendJson(response, 200, {
          status: "ok",
          modelReady: false,
          model: OLLAMA_MODEL,
          modelError: getOllamaError(ollama.status),
        });
        return;
      }
      const { models = [] } = await ollama.json();
      const installed = models.some((model) => model.name === OLLAMA_MODEL);
      sendJson(response, 200, {
        status: "ok",
        modelReady: installed,
        model: OLLAMA_MODEL,
        modelError: installed ? undefined : getOllamaError(404),
      });
    } catch {
      sendJson(response, 200, {
        status: "ok",
        modelReady: false,
        model: OLLAMA_MODEL,
        modelError: getOllamaError(0),
      });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/conversations") {
    sendJson(response, 200, statements.listConversations.all());
    return;
  }

  if (request.method === "POST" && pathname === "/api/conversations") {
    const body = await readRequestJson(request, response);
    if (!body) return;
    const id = typeof body.id === "string" ? body.id : randomUUID();
    if (!/^[0-9a-f-]{36}$/iu.test(id)) {
      sendJson(response, 400, { error: "Некорректный идентификатор чата" });
      return;
    }
    if (!statements.getConversation.get(id)) {
      statements.createConversation.run(id);
    }
    sendJson(response, 201, statements.getConversation.get(id));
    return;
  }

  const messagesMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/messages$/iu.exec(pathname);
  if (request.method === "GET" && messagesMatch) {
    const conversation = statements.getConversation.get(messagesMatch[1]);
    if (!conversation) {
      sendJson(response, 404, { error: "Чат не найден" });
      return;
    }
    sendJson(response, 200, statements.listMessages.all(messagesMatch[1]));
    return;
  }

  const conversationMatch = /^\/api\/conversations\/([0-9a-f-]{36})$/iu.exec(pathname);
  if (request.method === "DELETE" && conversationMatch) {
    const result = statements.deleteConversation.run(conversationMatch[1]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Чат не найден" });
      return;
    }
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/chat") {
    const body = await readRequestJson(request, response);
    if (!body) return;
    if (
      typeof body.conversationId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(body.conversationId)
    ) {
      sendJson(response, 400, { error: "Сначала создай новый чат" });
      return;
    }
    if (typeof body.message !== "string" || !body.message.trim()) {
      sendJson(response, 400, { error: "Напиши сообщение" });
      return;
    }
    const message = body.message.trim();
    if (message.length > 10_000) {
      sendJson(response, 400, { error: "Сообщение слишком длинное (максимум 10 000 символов)" });
      return;
    }
    if (!statements.getConversation.get(body.conversationId)) {
      sendJson(response, 404, { error: "Чат не найден. Создай новый." });
      return;
    }
    await streamAssistantReply(request, response, body.conversationId, message);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 404, { error: "Маршрут не найден" });
    return;
  }

  const asset = staticFiles.get(pathname);
  if (!asset) {
    sendJson(response, 404, { error: "Страница не найдена" });
    return;
  }

  const filePath = path.join(STATIC_DIR, asset[0]);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      console.error(`Не удалось прочитать ${filePath}:`, error);
      sendJson(response, 500, { error: "Не удалось загрузить страницу" });
      return;
    }
    sendSecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": asset[1],
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Ошибка обработки запроса:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Внутренняя ошибка сервера" });
    } else {
      response.end();
    }
  });
});

server.on("error", (error) => {
  console.error("Не удалось запустить сервер:", error);
  process.exitCode = 1;
  database.close();
});

server.listen(PORT, HOST, () => {
  console.log(`Чат запущен: http://${HOST}:${PORT}`);
  console.log(`ИИ-модель: ${OLLAMA_MODEL} (${OLLAMA_URL})`);
});

function shutdown() {
  server.close((error) => {
    database.close();
    if (error) {
      console.error("Ошибка при остановке сервера:", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
