const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcome");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const sendButton = document.querySelector("#send-button");
const chatError = document.querySelector("#chat-error");
const chatHistory = document.querySelector("#chat-history");
const newChatButton = document.querySelector("#new-chat");
const sidebar = document.querySelector("#sidebar");
let conversationId = null;
let isGenerating = false;

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос");
  return result;
}

function formatMessage(text) {
  const escaped = text.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
  const blocks = escaped.split(/```(?:[\w+-]+)?\s*\n?([\s\S]*?)```/gu);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return `<pre><code>${block.trim()}</code></pre>`;
    return block
      .replace(/^### (.+)$/gmu, "<h3>$1</h3>")
      .replace(/^## (.+)$/gmu, "<h2>$1</h2>")
      .replace(/^# (.+)$/gmu, "<h2>$1</h2>")
      .replace(/`([^`\n]+)`/gu, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\n]+)\*/gu, "$1<em>$2</em>")
      .replace(/((?:^|\n)(?:[-*] .+(?:\n|$))+)/gu, (list) => {
        const items = list.trim().split("\n").map((item) => (
          `<li>${item.replace(/^[-*] /u, "")}</li>`
        ));
        return `<ul>${items.join("")}</ul>`;
      })
      .replace(/\n/gu, "<br>");
  }).join("");
}

function addMessage(role, text = "") {
  const article = document.createElement("article");
  article.className = `message message-${role}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-label", "ИИ-помощник");
    avatar.textContent = "✳";
    article.append(avatar);
  } else {
    const label = document.createElement("span");
    label.className = "visually-hidden";
    label.textContent = "Вы";
    article.append(label);
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.setAttribute("data-role", role === "assistant" ? "assistant" : "user");
  content.innerHTML = formatMessage(text);
  article.append(content);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  welcome.hidden = true;
  return content;
}

function renderHistory(items) {
  chatHistory.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Здесь появятся твои разговоры";
    chatHistory.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.classList.toggle("is-active", item.id === conversationId);

    const select = document.createElement("button");
    select.className = "history-item";
    select.type = "button";
    select.title = item.title;
    select.textContent = item.title;
    select.addEventListener("click", () => openConversation(item.id));

    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.type = "button";
    remove.setAttribute("aria-label", `Удалить чат: ${item.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeConversation(item.id));

    row.append(select, remove);
    chatHistory.append(row);
  }
}

async function refreshHistory() {
  const conversations = await request("/api/conversations");
  renderHistory(conversations);
}

async function openConversation(id) {
  if (isGenerating) return;
  const items = await request(`/api/conversations/${id}/messages`);
  conversationId = id;
  messages.replaceChildren();
  welcome.hidden = items.length > 0;
  for (const item of items) addMessage(item.role, item.content);
  chatError.textContent = "";
  await refreshHistory();
  sidebar.classList.remove("is-open");
  chatInput.focus();
}

async function startNewConversation() {
  if (isGenerating) return;
  const id = crypto.randomUUID();
  await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  conversationId = id;
  messages.replaceChildren();
  welcome.hidden = false;
  chatError.textContent = "";
  await refreshHistory();
  sidebar.classList.remove("is-open");
  chatInput.focus();
}

async function removeConversation(id) {
  try {
    await request(`/api/conversations/${id}`, { method: "DELETE" });
    const items = await request("/api/conversations");
    renderHistory(items);
    if (conversationId === id) {
      if (items.length > 0) await openConversation(items[0].id);
      else await startNewConversation();
    }
  } catch (error) {
    chatError.textContent = error.message;
  }
}

function updateComposer() {
  sendButton.disabled = isGenerating || chatInput.value.trim().length === 0;
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message || isGenerating) return;

  if (!conversationId) await startNewConversation();
  chatError.textContent = "";
  addMessage("user", message);
  const assistantContent = addMessage("assistant");
  assistantContent.textContent = "Модель думает…";
  const cursor = document.createElement("span");
  cursor.className = "typing-cursor";
  assistantContent.append(cursor);

  isGenerating = true;
  chatInput.value = "";
  chatInput.disabled = true;
  updateComposer();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Не удалось получить ответ");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let fullResponse = "";
    let completed = false;

    function handleEvent(rawEvent) {
      const line = rawEvent.split("\n").find((value) => value.startsWith("data: "));
      if (!line) return;
      const payload = JSON.parse(line.slice(6));
      if (rawEvent.startsWith("event: token")) {
        fullResponse += payload.text;
        assistantContent.innerHTML = formatMessage(fullResponse);
        messages.scrollTop = messages.scrollHeight;
      } else if (rawEvent.startsWith("event: done")) {
        completed = true;
      } else if (rawEvent.startsWith("event: error")) {
        throw new Error(payload.error || "Генерация ответа прервалась");
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const events = pending.split("\n\n");
      pending = events.pop() || "";
      for (const event of events) handleEvent(event);
      if (done) break;
    }
    if (pending.trim()) handleEvent(pending);
    if (!completed) throw new Error("Соединение с моделью прервалось. Попробуй ещё раз.");
    await refreshHistory();
  } catch (error) {
    assistantContent.closest(".message").remove();
    chatError.textContent = error.message;
  } finally {
    isGenerating = false;
    chatInput.disabled = false;
    updateComposer();
    chatInput.focus();
  }
}

chatInput.addEventListener("input", updateComposer);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(chatInput.value);
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt));
});

newChatButton.addEventListener("click", () => {
  startNewConversation().catch((error) => {
    chatError.textContent = error.message;
  });
});

document.querySelector("#open-sidebar").addEventListener("click", () => {
  sidebar.classList.add("is-open");
});
document.querySelector("#close-sidebar").addEventListener("click", () => {
  sidebar.classList.remove("is-open");
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewConversation().catch((error) => {
      chatError.textContent = error.message;
    });
  }
  if (event.key === "Escape") sidebar.classList.remove("is-open");
});

async function initialize() {
  try {
    const healthResponse = await fetch("/api/health");
    const health = await healthResponse.json();
    const modelName = health.model || "локальная модель";
    document.querySelector("#model-name").textContent = modelName;
    document.querySelector("#topbar-model").textContent = modelName;
    if (!health.modelReady) {
      document.querySelector("#model-status").textContent = "Модель не запущена";
      chatError.textContent = health.modelError || "Проверь настройки сервера.";
    } else {
      document.querySelector("#model-status").textContent = "Приватный ИИ · на этом сервере";
      document.querySelectorAll(".model-indicator").forEach((indicator) => {
        indicator.classList.add("is-online");
      });
    }
  } catch (error) {
    document.querySelector("#model-status").textContent = "Сервер недоступен";
    chatError.textContent = error.message;
  }

  try {
    const items = await request("/api/conversations");
    renderHistory(items);
    if (items.length > 0) {
      await openConversation(items[0].id);
    } else {
      conversationId = null;
      messages.replaceChildren();
      welcome.hidden = false;
    }
  } catch (error) {
    chatError.textContent = error.message;
  }
  updateComposer();
}

initialize();
