// Generated from src-tauri/src/commands/browser.rs (BROWSER_ANNOTATION_SCRIPT), verbatim.
enum WorkspaceBrowserScript {
    static let annotation = #"""
(function () {
  if (window.__cetusBrowserAnnotationInstalled) return;
  window.__cetusBrowserAnnotationInstalled = true;
  var PREFIX = "__CETUS_BROWSER_ANNOTATION_TOKEN__";
  var annotating = false;
  var pending = null;
  var highlighted = null;
  var root = document.createElement("div");
  root.id = "cetus-browser-annotation-root";
  root.innerHTML = [
    '<style>',
    '#cetus-browser-annotation-root{all:initial;position:fixed;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111}',
    '#cetus-browser-annotation-toggle{all:initial;position:fixed;right:18px;bottom:18px;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:8px;background:#111;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.24);cursor:pointer}',
    '#cetus-browser-annotation-root[data-on=true] #cetus-browser-annotation-toggle{background:#0f766e}',
    '#cetus-browser-annotation-highlight{all:initial;display:none;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #0f766e;background:rgba(15,118,110,.08);box-shadow:0 0 0 99999px rgba(15,23,42,.06),0 8px 22px rgba(15,118,110,.18);border-radius:4px}',
    '#cetus-browser-annotation-root[data-on=true] #cetus-browser-annotation-highlight{display:block}',
    '#cetus-browser-annotation-pop{all:initial;display:none;position:fixed;z-index:2147483647;width:310px;border:1px solid rgba(0,0,0,.16);border-radius:10px;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.25);padding:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111}',
    '#cetus-browser-annotation-pop textarea{all:initial;box-sizing:border-box;display:block;width:100%;height:110px;resize:none;border:1px solid rgba(0,0,0,.16);border-radius:7px;padding:8px;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;background:#fff;white-space:pre-wrap}',
    '#cetus-browser-annotation-pop .row{all:initial;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#666}',
    '#cetus-browser-annotation-target{all:initial;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:178px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#666}',
    '#cetus-browser-annotation-pop button{all:initial;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:7px;font:600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer}',
    '#cetus-browser-annotation-cancel{background:#f2f2f2;color:#333;margin-right:6px}',
    '#cetus-browser-annotation-send{background:#111;color:#fff}',
    '</style>',
    '<div id="cetus-browser-annotation-highlight"></div>',
    '__CETUS_BROWSER_ANNOTATION_TOGGLE__',
    '<div id="cetus-browser-annotation-pop">',
    '  <textarea id="cetus-browser-annotation-note" maxlength="2000" placeholder="__CETUS_BROWSER_ANNOTATE_PLACEHOLDER__"></textarea>',
    '  <div class="row"><span id="cetus-browser-annotation-target"></span><span><button id="cetus-browser-annotation-cancel" type="button">__CETUS_BROWSER_ANNOTATE_CANCEL__</button><button id="cetus-browser-annotation-send" type="button">__CETUS_BROWSER_ANNOTATE_SEND__</button></span></div>',
    '</div>'
  ].join("");
  function mount() {
    if (!document.documentElement || document.getElementById("cetus-browser-annotation-root")) return;
    document.documentElement.appendChild(root);
    wire();
  }
  function describeElement(el) {
    if (!el || el === document || el === window) return null;
    var parts = [];
    if (el.tagName) parts.push(String(el.tagName).toLowerCase());
    if (el.id) parts.push("#" + el.id);
    if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      if (cls) parts.push("." + cls);
    }
    return parts.join("");
  }
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }
  function selectorFor(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return String(el.tagName).toLowerCase() + "#" + cssEscape(el.id);
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && path.length < 5) {
      var name = String(cur.tagName).toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        var cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(function (c) {
          return "." + cssEscape(c);
        }).join("");
        name += cls;
      }
      var sameTag = 0;
      var index = 0;
      var child = cur.parentElement ? cur.parentElement.firstElementChild : null;
      while (child) {
        if (child.tagName === cur.tagName) {
          sameTag += 1;
          if (child === cur) index = sameTag;
        }
        child = child.nextElementSibling;
      }
      if (sameTag > 1) name += ":nth-of-type(" + index + ")";
      path.unshift(name);
      cur = cur.parentElement;
    }
    return path.join(" > ");
  }
  function clippedText(el) {
    if (!el || !el.innerText) return null;
    var s = String(el.innerText).replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 240) : null;
  }
  function isChrome(el) {
    return !!(el && (el === root || (el.closest && el.closest("#cetus-browser-annotation-root"))));
  }
  function setAnnotating(next) {
    annotating = next;
    root.setAttribute("data-on", annotating ? "true" : "false");
    if (!annotating) {
      pending = null;
      highlighted = null;
      var highlight = document.getElementById("cetus-browser-annotation-highlight");
      var pop = document.getElementById("cetus-browser-annotation-pop");
      if (highlight) highlight.style.display = "none";
      if (pop) pop.style.display = "none";
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onPick, true);
      return;
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onPick, true);
  }
  function drawHighlight(el) {
    var highlight = document.getElementById("cetus-browser-annotation-highlight");
    if (!highlight || !el || isChrome(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    highlighted = el;
    highlight.style.display = "block";
    highlight.style.left = Math.max(0, r.left) + "px";
    highlight.style.top = Math.max(0, r.top) + "px";
    highlight.style.width = Math.max(1, r.width) + "px";
    highlight.style.height = Math.max(1, r.height) + "px";
  }
  function targetFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || isChrome(el)) return highlighted;
    return el;
  }
  function onMove(e) {
    if (!annotating) return;
    drawHighlight(targetFromPoint(e.clientX, e.clientY));
  }
  function onPick(e) {
    if (!annotating) return;
    if (isChrome(e.target)) return;
    var target = targetFromPoint(e.clientX, e.clientY);
    if (!target || isChrome(target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    drawHighlight(target);
    var r = target.getBoundingClientRect();
    var selector = selectorFor(target);
    pending = {
      url: location.href,
      title: document.title || "",
      selector: selector,
      element: describeElement(target),
      text: clippedText(target),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    };
    var pop = document.getElementById("cetus-browser-annotation-pop");
    var note = document.getElementById("cetus-browser-annotation-note");
    var label = document.getElementById("cetus-browser-annotation-target");
    if (!pop || !note || !label) return;
    label.textContent = selector || describeElement(target) || "";
    pop.style.left = Math.min(window.innerWidth - 330, Math.max(12, r.right + 12)) + "px";
    pop.style.top = Math.min(window.innerHeight - 190, Math.max(12, r.top)) + "px";
    pop.style.display = "block";
    note.value = "";
    note.focus();
  }
  function wire() {
    var toggle = document.getElementById("cetus-browser-annotation-toggle");
    var pop = document.getElementById("cetus-browser-annotation-pop");
    var note = document.getElementById("cetus-browser-annotation-note");
    var cancel = document.getElementById("cetus-browser-annotation-cancel");
    var send = document.getElementById("cetus-browser-annotation-send");
    if (!pop || !note || !cancel || !send) return;
    if (toggle) {
      toggle.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        setAnnotating(!annotating);
      });
    }
    cancel.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setAnnotating(false);
    });
    send.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!pending || !note.value.trim()) return;
      pending.note = note.value.trim().slice(0, 2000);
      document.title = PREFIX + JSON.stringify(pending);
      setTimeout(function () {
        document.title = pending.title || "Cetus Browser";
        setAnnotating(false);
      }, 0);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && annotating) {
        setAnnotating(false);
      }
    }, true);
  }
  window.__cetusSetBrowserAnnotationMode = setAnnotating;
  window.addEventListener("cetus-browser-annotation-mode", function (e) {
    setAnnotating(!!(e.detail && e.detail.enabled));
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
"""#
}
