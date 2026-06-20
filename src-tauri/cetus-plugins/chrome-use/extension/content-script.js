function clippedPageContext() {
  return {
    url: location.href,
    title: document.title,
    selection: String(getSelection?.() || "").slice(0, 4000),
    text: document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 8000) || "",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "page_context") return false;
  sendResponse({ ok: true, context: clippedPageContext() });
  return true;
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "cetus_chrome_context") return;
  chrome.runtime.sendMessage({
    type: "content_context",
    payload: clippedPageContext(),
  }).catch(() => {});
});
