const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const svg = (p, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"${extra}>${p}</svg>`;
const icons = {
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  more: svg('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>'),
  compose: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>'),
  attach: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.83l-8.59 8.57A2 2 0 1 1 6.6 14.6l8.49-8.48"/>'),
  send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  stop: svg('<rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" stroke="none"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>', ' class="chev"'),
  brain: svg('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>', ' class="glyph"'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', ' class="glyph"'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  rename: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>'),
  archive: svg('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  swap: svg('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};
const BACKENDS = [
  { id: "pi", label: "Cetus", cls: "" },
  { id: "codex", label: "Codex", cls: "codex" },
  { id: "claude-code", label: "Claude Code", cls: "claude-code" },
];
const backendMeta = (id) => BACKENDS.find((b) => b.id === id) || BACKENDS[0];
const S = {
  conversations: [],
  current: null,
  messages: [],
  archived: false,
  running: new Set(),
  controls: [],
  menu: false,
  images: [],
};
async function api(path, options = {}) {
  const r = await fetch("/api" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Cetus-Remote": "1",
      ...(options.headers || {}),
    },
  });
  if (r.status === 401)
    throw Object.assign(new Error("unauthorized"), { unauthorized: true });
  if (!r.ok) {
    let b = {};
    try {
      b = await r.json();
    } catch {}
    throw new Error(b.error || `HTTP ${r.status}`);
  }
  return r.status === 204 || r.status === 202 ? null : r.json();
}
function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}
async function boot() {
  try {
    await api("/status");
    await loadList();
    connect();
  } catch (e) {
    if (e.unauthorized) locked();
    else locked("Cetus Remote 暂时无法连接");
  }
}
function locked(
  detail = "请在 Mac 的 Cetus 设置中打开 Remote Access，然后扫描配对二维码。",
) {
  $("#app").innerHTML =
    `<div class="locked"><span class="mark">C</span><h1>Cetus Remote</h1><p>${esc(detail)}</p></div>`;
}
function shell(title = "Remote") {
  return `<div class="shell"><header class="topbar"><button class="icon back hidden" aria-label="返回">${icons.back}</button><img class="brand-mark" src="/remote-icon.svg" alt=""><h1>${esc(title)}</h1><span class="spacer"></span><span class="status live" aria-label="已连接"></span><button class="icon more hidden" aria-label="对话操作">${icons.more}</button></header><main class="body"></main></div>`;
}
async function loadList() {
  const rows = await api("/conversations?archived=" + S.archived);
  S.conversations = S.archived ? rows.filter((c) => c.archivedAt != null) : rows;
  renderList();
}
function renderList() {
  S.current = null;
  $("#app").innerHTML = shell("Cetus");
  const body = $(".body");
  body.innerHTML = `<div class="list-view"><div class="list-head"><h2>对话</h2><p>继续这台 Mac 上的 Cetus 会话</p></div><div class="filter"><button class="pill ${!S.archived ? "on" : ""}" data-filter="active">当前</button><button class="pill ${S.archived ? "on" : ""}" data-filter="archived">已归档</button></div><div class="conversations">${S.conversations.length ? S.conversations.map(row).join("") : '<div class="empty">这里还没有对话</div>'}</div></div>${S.archived ? "" : `<button class="fab" aria-label="新对话">${icons.compose}</button>`}`;
  document
    .querySelectorAll(".conversation")
    .forEach((b) => (b.onclick = () => openChat(b.dataset.id)));
  document.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = async () => {
        S.archived = b.dataset.filter === "archived";
        await loadList();
      }),
  );
  const fab = $(".fab");
  if (fab) fab.onclick = createChat;
}
function row(c) {
  const running = S.running.has(c.id);
  const m = backendMeta(c.backend || "pi");
  const badge = running
    ? '<span class="badge running"><span class="dot"></span>运行中</span>'
    : `<span class="badge ${m.cls || "pi"}"><span class="dot"></span>${esc(m.label)}</span>`;
  return `<button class="conversation" data-id="${c.id}"><strong>${esc(c.title || "未命名对话")}</strong><span class="when">${relative(c.updatedAt)}</span><span class="row-meta">${badge}<small>${esc(shortPath(c.workspaceDir))}</small></span></button>`;
}
function shortPath(p = "") {
  const bits = p.split("/").filter(Boolean);
  return bits.slice(-2).join("/") || "Default workspace";
}
function relative(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1
    ? "刚刚"
    : m < 60
      ? `${m} 分钟前`
      : m < 1440
        ? `${Math.floor(m / 60)} 小时前`
        : `${Math.floor(m / 1440)} 天前`;
}
function createChat() {
  runtimeSheet("新对话使用的 Runtime", null, async (backend) => {
    try {
      const c = await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ backend }),
      });
      await loadList();
      openChat(c.id);
    } catch (e) {
      toast(e.message);
    }
  });
}
/** A bottom action sheet for picking a runtime — reused for new chats and for
 *  switching an existing conversation's backend. */
function runtimeSheet(title, current, onPick) {
  document.querySelector(".sheet-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  backdrop.innerHTML = `<div class="sheet"><div class="grip"></div><div class="sheet-title">${esc(title)}</div>${BACKENDS.map(
    (b) =>
      `<button class="opt ${b.cls}" data-id="${b.id}"><span class="dot"></span><span class="opt-label">${esc(b.label)}</span>${b.id === current ? `<span class="check">${icons.check}</span>` : ""}</button>`,
  ).join("")}</div>`;
  const close = () => backdrop.remove();
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  backdrop.querySelectorAll(".opt").forEach(
    (b) =>
      (b.onclick = () => {
        close();
        onPick(b.dataset.id);
      }),
  );
  document.body.append(backdrop);
}
async function openChat(id) {
  try {
    const data = await api("/conversations/" + id);
    S.current = data.conversation;
    S.messages = data.messages || [];
    S.controls = data.pendingControls || [];
    renderChat();
  } catch (e) {
    toast(e.message);
  }
}
function renderChat() {
  const c = S.current;
  S.menu = false;
  $("#app").innerHTML = shell(c.title || "未命名对话");
  $(".back").classList.remove("hidden");
  $(".more").classList.remove("hidden");
  $(".back").onclick = () => loadList();
  $(".more").onclick = () => {
    S.menu = !S.menu;
    renderMenu();
  };
  const body = $(".body");
  const m = backendMeta(c.backend || "pi");
  const thumbs = S.images
    .map(
      (img, i) =>
        `<div class="thumb"><img src="data:${esc(img.mimeType)};base64,${img.data}" alt=""><button class="rm" data-i="${i}" aria-label="移除">${icons.x}</button></div>`,
    )
    .join("");
  body.innerHTML = `<div class="chat-view"><div class="messages">${S.messages.map(messageHtml).join("")}</div><div class="controls"></div><div class="composer"><div class="composer-box ${m.cls}"><div class="attachments">${thumbs}</div><input class="file hidden" type="file" accept="image/*" multiple><textarea rows="1" maxlength="100000" placeholder="Message ${esc(m.label)}…"></textarea><div class="composer-bar"><button class="ghost-icon attach ${S.images.length ? "on" : ""}" aria-label="添加图片">${icons.attach}</button><button class="runtime-chip ${m.cls}" aria-label="切换 Runtime"><span class="dot"></span>${esc(m.label)}</button><span class="spacer"></span><button class="send" aria-label="发送">${icons.send}</button></div></div></div></div>`;
  renderControls();
  const ta = $(".composer textarea");
  ta.oninput = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(168, ta.scrollHeight) + "px";
  };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  requestAnimationFrame(() => ta.dispatchEvent(new Event("input")));
  $(".attach").onclick = () => $(".file").click();
  $(".file").onchange = pickImages;
  $(".runtime-chip").onclick = () =>
    runtimeSheet("切换 Runtime", S.current.backend || "pi", (backend) => {
      if (backend !== (S.current.backend || "pi")) changeRuntime(backend);
    });
  document
    .querySelectorAll(".attachments .rm")
    .forEach((b) => (b.onclick = () => removeImage(+b.dataset.i)));
  $(".send").onclick = send;
  requestAnimationFrame(() => {
    const v = $(".chat-view");
    v.scrollTop = v.scrollHeight;
  });
}
function removeImage(i) {
  S.images.splice(i, 1);
  renderChat();
}
function renderMessages() {
  const host = $(".messages");
  const view = $(".chat-view");
  if (!host || !view) return;
  const followsTail = view.scrollHeight - view.scrollTop - view.clientHeight < 120;
  host.innerHTML = S.messages.map(messageHtml).join("");
  if (followsTail) requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; });
}
function renderMenu() {
  document.querySelector(".menu")?.remove();
  document.querySelector(".menu-closer")?.remove();
  if (!S.menu) return;
  const c = S.current;
  const closeMenu = () => {
    S.menu = false;
    renderMenu();
  };
  const closer = document.createElement("div");
  closer.className = "menu-closer";
  closer.onclick = closeMenu;
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = `<button data-action="rename">${icons.rename}重命名</button><button data-action="runtime">${icons.swap}切换 Runtime</button><button data-action="archive">${icons.archive}${c.archivedAt ? "恢复对话" : "归档对话"}</button>${S.running.has(c.id) ? `<div class="sep"></div><button class="danger" data-action="stop">${icons.stop}停止当前任务</button>` : ""}`;
  $(".body").append(closer, menu);
  menu.querySelector("[data-action=rename]").onclick = rename;
  menu.querySelector("[data-action=runtime]").onclick = () => {
    closeMenu();
    runtimeSheet("切换 Runtime", c.backend || "pi", (b) => {
      if (b !== (c.backend || "pi")) changeRuntime(b);
    });
  };
  menu.querySelector("[data-action=archive]").onclick = archive;
  const stopButton = menu.querySelector("[data-action=stop]");
  if (stopButton) stopButton.onclick = stop;
}
async function changeRuntime(backend) {
  try {
    await api("/conversations/" + S.current.id, {
      method: "PATCH",
      body: JSON.stringify({ backend }),
    });
    S.current.backend = backend;
    S.menu = false;
    renderChat();
    toast("Runtime 已切换");
  } catch (e) {
    toast(e.message);
  }
}
async function rename() {
  const title = prompt("对话名称", S.current.title || "");
  if (title === null) return;
  try {
    await api("/conversations/" + S.current.id, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    S.current.title = title;
    S.menu = false;
    renderChat();
  } catch (e) {
    toast(e.message);
  }
}
async function archive() {
  try {
    await api("/conversations/" + S.current.id, {
      method: "PATCH",
      body: JSON.stringify({ archived: !S.current.archivedAt }),
    });
    S.archived = false;
    await loadList();
    toast("已更新归档状态");
  } catch (e) {
    toast(e.message);
  }
}
function contentBlocks(m) {
  if (typeof m.content === "string") return [{ type: "text", text: m.content }];
  return Array.isArray(m.content) ? m.content : [];
}
function messageHtml(m) {
  if (m.role === "toolResult" || m.role === "system" || m.display === false)
    return "";
  const isUser = m.role === "user";
  const blocks = contentBlocks(m).map(blockHtml).join("");
  const eyebrow = isUser ? "" : '<div class="eyebrow-role">Assistant</div>';
  return `<article class="message ${isUser ? "user" : "assistant"}"><div class="col">${eyebrow}<div class="bubble">${blocks || '<span class="cursor"></span>'}</div></div></article>`;
}
function argPreview(args) {
  if (!args || typeof args !== "object") return "";
  const v =
    args.command ??
    args.path ??
    args.file_path ??
    args.pattern ??
    args.query ??
    args.description ??
    Object.values(args)[0];
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
function blockHtml(b) {
  if (!b) return "";
  if (b.type === "text")
    return `<div class="block ${b.streaming ? "cursor" : ""}">${esc(b.text).replace(/\n/g, "<br>")}</div>`;
  if (b.type === "thinking")
    return `<details class="thinking"><summary>${icons.chevron}${icons.brain}<span class="label">Thinking</span></summary><div class="body"><pre>${esc(b.thinking || b.text || "")}</pre></div></details>`;
  if (b.type === "toolCall" || b.type === "tool_use") {
    const args = b.arguments || b.args || {};
    const res = b.result ? esc(resultText(b.result)) : "";
    const status = b.result ? `<span class="tool-status">${icons.check}</span>` : "";
    return `<details class="tool"><summary>${icons.chevron}${icons.wrench}<span class="tool-name">${esc(b.name || "tool")}</span><span class="tool-preview">${esc(argPreview(args))}</span>${status}</summary><div class="body"><div class="pre-label">Arguments</div><pre>${esc(JSON.stringify(args, null, 2))}</pre>${res ? `<div class="pre-label">Result</div><pre>${res}</pre>` : ""}</div></details>`;
  }
  if (b.type === "image")
    return '<div class="block" style="color:var(--muted-foreground);font-size:12.5px">🖼 图片附件</div>';
  return "";
}
function resultText(r) {
  const c = r.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x.text || "").join("\n");
  return JSON.stringify(c ?? r);
}
async function send() {
  const ta = $(".composer textarea"),
    text = ta.value.trim(),
    images = S.images;
  if (!text && !images.length) return;
  ta.value = "";
  S.images = [];
  S.messages.push({ role: "user", content: [{ type: "text", text: text || "[图片]" }] });
  S.running.add(S.current.id);
  renderChat();
  try {
    await api("/conversations/" + S.current.id + "/messages", {
      method: "POST",
      body: JSON.stringify({ message: text || "请查看这些图片。", images }),
    });
  } catch (e) {
    S.running.delete(S.current.id);
    renderChat();
    toast(e.message);
  }
}
async function pickImages(event) {
  const files = [...event.target.files].slice(0, 4);
  try {
    S.images = await Promise.all(files.map(readImage));
    renderChat();
  } catch (error) {
    toast(error.message);
  }
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) return reject(new Error("单张图片不能超过 10 MB"));
    const reader = new FileReader();
    reader.onload = () => resolve({ type: "image", data: String(reader.result).split(",")[1], mimeType: file.type || "image/jpeg" });
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
async function stop() {
  try {
    await api("/conversations/" + S.current.id + "/abort", { method: "POST" });
    S.running.delete(S.current.id);
    renderChat();
  } catch (e) {
    toast(e.message);
  }
}
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/events`);
  ws.onmessage = (e) => {
    try {
      event(JSON.parse(e.data));
    } catch {}
  };
  ws.onclose = () => {
    document.querySelector(".status")?.classList.remove("live");
    setTimeout(connect, 1800);
  };
  ws.onopen = () => document.querySelector(".status")?.classList.add("live");
}
function event(envelope) {
  const id = envelope.conversationId;
  if (envelope.type === "conversation_updated") {
    const i = S.conversations.findIndex(
      (c) => c.id === envelope.conversation.id,
    );
    if (i >= 0) S.conversations[i] = envelope.conversation;
    if (S.current?.id === envelope.conversation.id)
      S.current = envelope.conversation;
    return;
  }
  if (envelope.type !== "pi_event" || !id) return;
  const e = envelope.event;
  if (e.type === "agent_start") S.running.add(id);
  if (e.type === "agent_end") {
    S.running.delete(id);
    if (S.current?.id === id) setTimeout(() => openChat(id), 80);
    return;
  }
  if (S.current?.id !== id) return;
  if (e.type === "cli_control_request") {
    S.controls.push(e);
    renderControls();
    return;
  }
  if (e.type === "message_start" && e.message?.role === "assistant")
    S.messages.push({ role: "assistant", content: [] });
  if (e.type === "message_update") delta(e.assistantMessageEvent);
  if (e.type === "tool_execution_end") toolEnd(e);
  renderMessages();
}
function assistant() {
  for (let i = S.messages.length - 1; i >= 0; i--)
    if (S.messages[i].role === "assistant") return S.messages[i];
  const m = { role: "assistant", content: [] };
  S.messages.push(m);
  return m;
}
function delta(d) {
  if (!d) return;
  const m = assistant();
  if (!Array.isArray(m.content)) m.content = [];
  const i = d.contentIndex ?? 0;
  while (m.content.length <= i) m.content.push({ type: "text", text: "" });
  if (d.type === "text_start")
    m.content[i] = { type: "text", text: "", streaming: true };
  if (d.type === "text_delta") {
    if (m.content[i].type !== "text") m.content[i] = { type: "text", text: "" };
    m.content[i].text += d.delta;
    m.content[i].streaming = true;
  }
  if (d.type === "text_end") m.content[i] = { type: "text", text: d.content };
  if (d.type === "thinking_start")
    m.content[i] = { type: "thinking", thinking: "", streaming: true };
  if (d.type === "thinking_delta") {
    if (m.content[i].type !== "thinking")
      m.content[i] = { type: "thinking", thinking: "" };
    m.content[i].thinking += d.delta;
  }
  if (d.type === "thinking_end")
    m.content[i] = { type: "thinking", thinking: d.content };
  if (d.type === "toolcall_end")
    m.content[i] = { type: "toolCall", ...d.toolCall };
}
function toolEnd(e) {
  for (let mi = S.messages.length - 1; mi >= 0; mi--) {
    const c = S.messages[mi].content;
    if (!Array.isArray(c)) continue;
    const b = c.find((x) => x.id === e.toolCallId);
    if (b) {
      b.result = e.result;
      break;
    }
  }
}
function renderControls() {
  const host = $(".controls");
  if (!host) return;
  host.innerHTML = S.controls
    .slice(0, 1)
    .map(
      (c) =>
        `<section class="control"><h3>${esc(c.toolName || "Agent needs confirmation")}</h3><p>${esc(JSON.stringify(c.input || {}, null, 2))}</p>${c.toolName === "AskUserQuestion" || c.requestKind === "request_user_input" ? '<textarea placeholder="输入回答…"></textarea>' : ""}<div class="actions"><button class="deny">拒绝</button><button class="allow">允许 / 提交</button></div></section>`,
    )
    .join("");
  const c = S.controls[0];
  if (!c) return;
  host.querySelector(".deny").onclick = () => respondControl(c, false);
  host.querySelector(".allow").onclick = () => respondControl(c, true);
}
async function respondControl(c, allow) {
  let response;
  if (c.source === "codex") {
    if (c.requestKind === "request_user_input" && allow) {
      const answer = $(".control textarea")?.value || "";
      const answers = {};
      for (const q of c.input.questions || [])
        answers[q.id] = { answers: [answer] };
      response = { answers };
    } else
      response = allow
        ? { action: "accept", content: {}, _meta: null }
        : { action: "decline", content: null, _meta: null };
  } else if (c.toolName === "AskUserQuestion" && allow) {
    const answer = $(".control textarea")?.value || "";
    const answers = {};
    for (const q of c.input.questions || []) answers[q.question] = answer;
    response = { behavior: "allow", updatedInput: { ...c.input, answers } };
  } else
    response = allow
      ? { behavior: "allow", updatedInput: c.input }
      : { behavior: "deny", message: "Denied from Cetus Remote" };
  try {
    await api("/conversations/" + S.current.id + "/control", {
      method: "POST",
      body: JSON.stringify({
        requestId: c.requestId,
        response,
        source: c.source,
      }),
    });
    S.controls.shift();
    renderControls();
  } catch (e) {
    toast(e.message);
  }
}
boot();
