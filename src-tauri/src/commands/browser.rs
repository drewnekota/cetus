use super::{
    err, AppHandle, AppState, BrowserAnnotationLabels, BrowserAnnotationPayload,
    BrowserPanelBounds, CmdResult, Emitter, LogicalPosition, LogicalSize, Manager, Path, Position,
    Rect, Size, State, Url, Uuid, WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

const BROWSER_ANNOTATION_TITLE_PREFIX: &str = "__CETUS_BROWSER_ANNOTATION__";
pub(crate) const BROWSER_PANEL_LABEL: &str = "browser-panel";
/// The standalone in-app browser window. Named here so the navigation guard in
/// `run()` can tell "cetus' own UI" apart from "a webview whose job is to
/// navigate anywhere the user points it".
pub(crate) const BROWSER_WINDOW_LABEL: &str = "browser";

const BROWSER_ANNOTATION_SCRIPT: &str = r###"
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
"###;

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(super) fn browser_annotation_script(
    token: &str,
    labels: &BrowserAnnotationLabels,
    show_toggle: bool,
) -> String {
    let toggle = if show_toggle {
        format!(
            r#"<button id="cetus-browser-annotation-toggle" type="button">{}</button>"#,
            escape_html_attr(&labels.annotate)
        )
    } else {
        String::new()
    };
    BROWSER_ANNOTATION_SCRIPT
        .replace("__CETUS_BROWSER_ANNOTATION_TOKEN__", token)
        .replace("__CETUS_BROWSER_ANNOTATION_TOGGLE__", &toggle)
        .replace(
            "__CETUS_BROWSER_ANNOTATE_PLACEHOLDER__",
            &escape_html_attr(&labels.placeholder),
        )
        .replace(
            "__CETUS_BROWSER_ANNOTATE_CANCEL__",
            &escape_html_attr(&labels.cancel),
        )
        .replace(
            "__CETUS_BROWSER_ANNOTATE_SEND__",
            &escape_html_attr(&labels.send),
        )
}

pub(super) fn supported_browser_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "about" | "file")
}

/// Open a URL in a Cetus-owned browser webview window. This is the Browser
/// surface's escape hatch for sites that refuse iframe embedding; it behaves
/// like a real top-level browser page instead of a nested frame.
#[tauri::command]
pub async fn open_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<()> {
    open_browser_window_with_app_data_dir(&app, &state.app_data_dir, &url).await
}

pub(crate) async fn open_browser_window_with_app_data_dir(
    app: &AppHandle,
    app_data_dir: &Path,
    url: &str,
) -> CmdResult<()> {
    let parsed = Url::parse(url).map_err(err)?;
    if !supported_browser_scheme(parsed.scheme()) {
        return Err(format!(
            "refusing to open unsupported browser url scheme: {}",
            parsed.scheme()
        ));
    }
    if let Some(win) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        win.navigate(parsed).map_err(err)?;
        win.show().map_err(err)?;
        return Ok(());
    }
    let data_dir = app_data_dir.join("browser-webview");
    std::fs::create_dir_all(&data_dir).map_err(err)?;
    let app_for_annotation = app.clone();
    let annotation_token = format!(
        "{}{}__",
        BROWSER_ANNOTATION_TITLE_PREFIX,
        Uuid::new_v4().simple()
    );
    let annotation_script =
        browser_annotation_script(&annotation_token, &BrowserAnnotationLabels::default(), true);
    let browser_url = WebviewUrl::External(parsed.clone());
    match WebviewWindowBuilder::new(app, BROWSER_WINDOW_LABEL, browser_url)
        .title("Cetus Browser")
        .inner_size(1200.0, 820.0)
        .resizable(true)
        .data_directory(data_dir)
        .initialization_script(annotation_script)
        .on_document_title_changed(move |win, title| {
            let Some(raw) = title.strip_prefix(&annotation_token) else {
                return;
            };
            match serde_json::from_str::<BrowserAnnotationPayload>(raw) {
                Ok(payload) => {
                    let _ = app_for_annotation.emit_to("main", "browser-annotation", payload);
                    let _ = win.set_title("Cetus Browser");
                }
                Err(e) => {
                    tracing::warn!("browser annotation payload parse failed: {e}");
                }
            }
        })
        .build()
    {
        Ok(_) => {}
        Err(e) => {
            if let Some(win) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
                win.navigate(parsed).map_err(err)?;
                win.show().map_err(err)?;
            } else {
                return Err(err(e));
            }
        }
    }
    Ok(())
}

fn browser_panel_rect(bounds: &BrowserPanelBounds) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0))),
        size: Size::Logical(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        )),
    }
}

#[tauri::command]
pub async fn open_browser_panel(
    app: AppHandle,
    url: String,
    bounds: BrowserPanelBounds,
    labels: Option<BrowserAnnotationLabels>,
) -> CmdResult<()> {
    let parsed = Url::parse(&url).map_err(err)?;
    if !supported_browser_scheme(parsed.scheme()) {
        return Err(format!(
            "refusing to open unsupported browser url scheme: {}",
            parsed.scheme()
        ));
    }
    if bounds.width < 2.0 || bounds.height < 2.0 {
        return Ok(());
    }
    let rect = browser_panel_rect(&bounds);
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview.set_bounds(rect).map_err(err)?;
        webview.navigate(parsed).map_err(err)?;
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let app_for_annotation = app.clone();
    let annotation_token = format!(
        "{}{}__",
        BROWSER_ANNOTATION_TITLE_PREFIX,
        Uuid::new_v4().simple()
    );
    let annotation_script =
        browser_annotation_script(&annotation_token, &labels.unwrap_or_default(), false);
    let builder = WebviewBuilder::new(BROWSER_PANEL_LABEL, WebviewUrl::External(parsed.clone()))
        .initialization_script(annotation_script)
        .on_document_title_changed(move |_webview, title| {
            let Some(raw) = title.strip_prefix(&annotation_token) else {
                return;
            };
            match serde_json::from_str::<BrowserAnnotationPayload>(raw) {
                Ok(payload) => {
                    let _ = app_for_annotation.emit_to("main", "browser-annotation", payload);
                }
                Err(e) => {
                    tracing::warn!("browser panel annotation payload parse failed: {e}");
                }
            }
        });
    match window.add_child(
        builder,
        LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
        LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    ) {
        Ok(_) => {}
        Err(e) => {
            if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
                webview.set_bounds(rect).map_err(err)?;
                webview.navigate(parsed).map_err(err)?;
            } else {
                return Err(err(e));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_browser_panel_bounds(app: AppHandle, bounds: BrowserPanelBounds) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview
            .set_bounds(browser_panel_rect(&bounds))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_browser_panel_annotation_mode(app: AppHandle, enabled: bool) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        let enabled_js = if enabled { "true" } else { "false" };
        webview
            .eval(format!(
                "window.dispatchEvent(new CustomEvent('cetus-browser-annotation-mode', {{ detail: {{ enabled: {enabled_js} }} }}));"
            ))
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_browser_panel(app: AppHandle) -> CmdResult<()> {
    if let Some(webview) = app.get_webview(BROWSER_PANEL_LABEL) {
        webview.close().map_err(err)?;
    }
    Ok(())
}
