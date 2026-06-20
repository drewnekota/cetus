const NATIVE_HOST = "com.cetus.chrome_use";

let nativePort = null;
let nativeReady = false;

function connectNative() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener((message) => {
      nativeReady = true;
      if (message?.type === "command") {
        handleNativeCommand(message).catch((error) => {
          sendNative({
            type: "command_result",
            commandId: message.id || null,
            command: message.command || "",
            ok: false,
            error: String(error),
            createdAt: Date.now(),
          });
        });
        return;
      }
      chrome.runtime.sendMessage({ type: "native_message", message }).catch(() => {});
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      nativeReady = false;
      chrome.runtime.sendMessage({
        type: "native_disconnected",
        error: chrome.runtime.lastError?.message || "Native host disconnected",
      }).catch(() => {});
    });
  } catch (error) {
    nativeReady = false;
    chrome.runtime.sendMessage({
      type: "native_disconnected",
      error: String(error),
    }).catch(() => {});
  }
  return nativePort;
}

function sendNative(message) {
  const port = connectNative();
  if (!port) return false;
  try {
    port.postMessage(message);
    nativeReady = true;
    return true;
  } catch {
    nativePort = null;
    nativeReady = false;
    return false;
  }
}

async function activeTabSnapshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  let page = null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        selection: String(getSelection?.() || "").slice(0, 4000),
        text: document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 8000) || "",
      }),
    });
    page = result;
  } catch {
    page = null;
  }
  return {
    tab: {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || "",
      url: tab.url || "",
      active: tab.active,
    },
    page,
  };
}

async function resolveTabId(tabId) {
  if (tabId) return Number(tabId);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error("No active Chrome tab is available.");
  return active.id;
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    active: tab.active,
  }));
}

function collectElements(maxElements) {
  const selectors = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[contenteditable='true']",
  ].join(",");
  const nodes = Array.from(document.querySelectorAll(selectors));
  const out = [];
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.width < 2 ||
      rect.height < 2 ||
      style.visibility === "hidden" ||
      style.display === "none" ||
      el.closest("[hidden], [aria-hidden='true']")
    ) {
      continue;
    }
    const tag = el.tagName.toLowerCase();
    const inputType = tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
    const hay = `${text} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("name") || ""} ${el.id || ""}`.toLowerCase();
    const consequential = /\b(submit|send|post|publish|delete|remove|buy|purchase|checkout|pay|order|login|log in|sign in|sign up|confirm|approve|authorize|transfer|withdraw|save|update|change password|security)\b/.test(hay);
    out.push({
      uid: `e${out.length + 1}`,
      tag,
      role: el.getAttribute("role") || "",
      type: inputType,
      text: text.slice(0, 160),
      href: tag === "a" ? el.href || "" : "",
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      risk: consequential ? "consequential" : "",
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
    if (out.length >= maxElements) break;
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
  };
}

function findElementByUid(uid) {
  const snapshot = collectElements(300);
  const item = snapshot.elements.find((el) => el.uid === uid);
  if (!item) return { snapshot, item: null, element: null };
  const el = document.elementFromPoint(item.x, item.y);
  return { snapshot, item, element: el };
}

async function pageSnapshot(tabId, maxElements) {
  const id = await resolveTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: collectElements,
    args: [Math.max(1, Math.min(Number(maxElements) || 80, 200))],
  });
  return result;
}

async function clickElement(tabId, uid, allowConsequential) {
  const id = await resolveTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (targetUid, allowConsequential) => {
      function collect(maxElements) {
        const selectors = ["a[href]", "button", "input", "textarea", "select", "[role='button']", "[role='link']", "[contenteditable='true']"].join(",");
        const nodes = Array.from(document.querySelectorAll(selectors));
        const out = [];
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none" || node.closest("[hidden], [aria-hidden='true']")) continue;
          const tag = node.tagName.toLowerCase();
          const inputType = tag === "input" ? String(node.getAttribute("type") || "text").toLowerCase() : "";
          const label = (node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
          const hay = `${label} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("name") || ""} ${node.id || ""}`.toLowerCase();
          const consequential = /\b(submit|send|post|publish|delete|remove|buy|purchase|checkout|pay|order|login|log in|sign in|sign up|confirm|approve|authorize|transfer|withdraw|save|update|change password|security)\b/.test(hay);
          out.push({
            uid: `e${out.length + 1}`,
            tag,
            role: node.getAttribute("role") || "",
            type: inputType,
            text: label.slice(0, 160),
            risk: consequential ? "consequential" : "",
            disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
          if (out.length >= maxElements) break;
        }
        return out;
      }
      const item = collect(300).find((candidate) => candidate.uid === targetUid);
      const element = item ? document.elementFromPoint(item.x, item.y) : null;
      if (!item || !element) throw new Error(`Element ${targetUid} was not found on the current page.`);
      if (item.disabled) throw new Error(`Element ${targetUid} is disabled.`);
      if (item.risk === "consequential" && !allowConsequential) {
        throw new Error(`Refusing consequential click on ${targetUid}. Re-run with allowConsequential after explicit user confirmation.`);
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { clicked: item, url: location.href, title: document.title };
    },
    args: [uid, Boolean(allowConsequential)],
  });
  return result;
}

async function fillElement(tabId, uid, value) {
  const id = await resolveTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (targetUid, text) => {
      function collect(maxElements) {
        const selectors = ["a[href]", "button", "input", "textarea", "select", "[role='button']", "[role='link']", "[contenteditable='true']"].join(",");
        const nodes = Array.from(document.querySelectorAll(selectors));
        const out = [];
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none" || node.closest("[hidden], [aria-hidden='true']")) continue;
          const tag = node.tagName.toLowerCase();
          const inputType = tag === "input" ? String(node.getAttribute("type") || "text").toLowerCase() : "";
          const label = (node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
          out.push({
            uid: `e${out.length + 1}`,
            tag,
            role: node.getAttribute("role") || "",
            type: inputType,
            text: label.slice(0, 160),
            disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
          if (out.length >= maxElements) break;
        }
        return out;
      }
      const item = collect(300).find((candidate) => candidate.uid === targetUid);
      const element = item ? document.elementFromPoint(item.x, item.y) : null;
      if (!item || !element) throw new Error(`Element ${targetUid} was not found on the current page.`);
      if (item.disabled) throw new Error(`Element ${targetUid} is disabled.`);
      const tag = element.tagName.toLowerCase();
      const type = tag === "input" ? String(element.getAttribute("type") || "text").toLowerCase() : "";
      const sensitive = `${type} ${element.getAttribute("autocomplete") || ""} ${element.getAttribute("name") || ""} ${element.id || ""} ${element.getAttribute("placeholder") || ""}`.toLowerCase();
      if (["password", "file", "hidden"].includes(type) || /(password|passcode|otp|token|secret|credit|card|cvc|cvv|ssn|social security)/.test(sensitive)) {
        throw new Error(`Refusing to fill sensitive ${type || tag} field ${targetUid}.`);
      }
      if (tag !== "input" && tag !== "textarea" && element.getAttribute("contenteditable") !== "true") {
        throw new Error(`Element ${targetUid} is not fillable.`);
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      if (element.getAttribute("contenteditable") === "true") {
        element.textContent = text;
      } else {
        element.value = text;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: item, url: location.href, title: document.title };
    },
    args: [uid, String(value ?? "")],
  });
  return result;
}

async function selectTab(tabId) {
  const tab = await chrome.tabs.update(Number(tabId), { active: true });
  if (tab?.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return activeTabSnapshot();
}

async function navigateTab(url, tabId) {
  const targetTabId = await resolveTabId(tabId);
  await chrome.tabs.update(Number(targetTabId), { url });
  await waitForTabLoad(Number(targetTabId));
  return activeTabSnapshot();
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function handleNativeCommand(message) {
  let result = null;
  if (message.command === "active_tab_snapshot") {
    result = await activeTabSnapshot();
  } else if (message.command === "list_tabs") {
    result = await listTabs();
  } else if (message.command === "page_snapshot") {
    result = await pageSnapshot(message.params?.tabId, message.params?.maxElements);
  } else if (message.command === "select_tab") {
    result = await selectTab(message.params?.tabId);
  } else if (message.command === "navigate") {
    result = await navigateTab(message.params?.url, message.params?.tabId);
  } else if (message.command === "click") {
    result = await clickElement(message.params?.tabId, message.params?.uid, message.params?.allowConsequential);
  } else if (message.command === "fill") {
    result = await fillElement(message.params?.tabId, message.params?.uid, message.params?.text);
  } else {
    throw new Error(`unknown Chrome command: ${message.command}`);
  }
  sendNative({
    type: "command_result",
    commandId: message.id || null,
    command: message.command,
    ok: true,
    result,
    createdAt: Date.now(),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ cetusChromeUseInstalledAt: Date.now() });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "status") {
      sendNative({ type: "ping", createdAt: Date.now() });
      sendResponse({ ok: true, nativeReady });
      return;
    }
    if (message?.type === "connect_native") {
      const ok = sendNative({ type: "ping", createdAt: Date.now() });
      sendResponse({ ok, nativeReady });
      return;
    }
    if (message?.type === "active_tab_snapshot") {
      const snapshot = await activeTabSnapshot();
      sendNative({ type: "active_tab_snapshot", snapshot, createdAt: Date.now() });
      sendResponse({ ok: true, snapshot, nativeReady });
      return;
    }
    if (message?.type === "list_tabs") {
      const tabs = await listTabs();
      sendNative({ type: "list_tabs", tabs, createdAt: Date.now() });
      sendResponse({ ok: true, tabs, nativeReady });
      return;
    }
    if (message?.type === "content_context") {
      sendNative({ type: "content_context", payload: message.payload, createdAt: Date.now() });
      sendResponse({ ok: true, nativeReady });
      return;
    }
    sendResponse({ ok: false, error: "unknown message" });
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
