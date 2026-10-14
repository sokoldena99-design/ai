const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

let fakeOllama;
let app;
let appDirectory;
let baseUrl;
let receivedMessages;

async function startHttpServer(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
}

test.before(async () => {
  fakeOllama = http.createServer(async (request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "qwen3:4b" }] }));
      return;
    }
    if (request.url !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    receivedMessages.push(payload.messages);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.end([
      JSON.stringify({ message: { role: "assistant", content: "<thi" } }),
      JSON.stringify({ message: { role: "assistant", content: "nk>скрытые рассуждения</think>Привет! " } }),
      JSON.stringify({ message: { role: "assistant", content: "Я помогу." }, done: true }),
    ].join("\n"));
  });
  const ollamaPort = await startHttpServer(fakeOllama);

  appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-chat-"));
  const portProbe = http.createServer();
  const appPort = await startHttpServer(portProbe);
  await new Promise((resolve, reject) => {
    portProbe.close((error) => (error ? reject(error) : resolve()));
  });

  receivedMessages = [];
  app = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(appPort),
      OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
      OLLAMA_MODEL: "qwen3:4b",
      DATABASE_PATH: path.join(appDirectory, "chat.db"),
    },
    stdio: "ignore",
  });
  baseUrl = `http://127.0.0.1:${appPort}`;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Chat server exited (${app.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Chat server did not start");
});

test.after(async () => {
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill();
    await exited;
  }
  if (fakeOllama?.listening) {
    await new Promise((resolve, reject) => {
      fakeOllama.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (appDirectory) fs.rmSync(appDirectory, { recursive: true, force: true });
});

test("serves a chat-only website and reports local model health", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /личный ИИ-чат/u);
  assert.doesNotMatch(html, /Твои задачи/u);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.status, "ok");
  assert.equal(status.modelReady, true);
  assert.equal(status.model, "qwen3:4b");
});

test("streams model replies and persists multi-turn conversation history", async () => {
  const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const created = await jsonRequest(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  assert.equal(created.response.status, 201);

  const chat = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: id, message: "Привет!" }),
  });
  assert.equal(chat.status, 200);
  assert.match(chat.headers.get("content-type"), /text\/event-stream/u);
  const stream = await chat.text();
  assert.match(stream, /event: token/u);
  assert.match(stream, /Привет!/u);
  assert.doesNotMatch(stream, /скрытые рассуждения/u);
  assert.match(stream, /event: done/u);

  const history = await fetch(`${baseUrl}/api/conversations/${id}/messages`);
  assert.deepEqual(
    (await history.json()).map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Привет!" },
      { role: "assistant", content: "Привет! Я помогу." },
    ],
  );

  const secondChat = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: id, message: "Продолжи разговор" }),
  });
  assert.equal(secondChat.status, 200);
  await secondChat.text();
  assert.ok(receivedMessages[1].some(
    (message) => message.role === "user" && message.content === "Привет!",
  ));

  const list = await fetch(`${baseUrl}/api/conversations`);
  const conversations = await list.json();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].title, "Привет!");

  const removed = await fetch(`${baseUrl}/api/conversations/${id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const removedHistory = await fetch(`${baseUrl}/api/conversations/${id}/messages`);
  assert.equal(removedHistory.status, 404);
});

test("validates chat requests without contacting the model", async () => {
  const before = receivedMessages.length;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "invalid", message: "Привет" }),
  });
  assert.equal(response.status, 400);
  assert.equal(receivedMessages.length, before);
});
