import AppKit
import SwiftUI
import WebKit

/// One Browser tab's state (BrowserViewState): kept per tab id so it survives
/// the view being rebuilt, like the tab's `browserState` in Tauri.
@MainActor @Observable
final class WorkspaceBrowserModel {
    var address = "about:blank"
    var url = "about:blank"
    var inlinePreview = false
    var history: [String] = ["about:blank"]
    var historyIndex = 0
    var loading = false
    var openError: String?
    var annotating = false
    var suggestionsOpen = false
    var highlighted = -1
    /// Bumped to make the panel webview load `url` again (Reload / re-open).
    var reloadToken = 0
    @ObservationIgnored weak var panel: WKWebView?
    @ObservationIgnored weak var inline: WKWebView?

    static let historyKey = "settings.browserUrlHistory"
    static let maxSaved = 80
    static let maxSuggestions = 8

    var displayHost: String { URL(string: url)?.host ?? url }

    var suggestions: [String] {
        let needle = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let candidates = Self.unique(history.reversed() + Self.saved()).filter { $0 != "about:blank" }
        let filtered = needle.isEmpty ? candidates : candidates.filter { Self.matches($0, needle) }
        return Array(filtered.prefix(Self.maxSuggestions))
    }

    static func saved() -> [String] {
        let raw = UserDefaults.standard.stringArray(forKey: historyKey) ?? []
        return Array(unique(raw).filter { !$0.isEmpty && $0 != "about:blank" }.prefix(maxSaved))
    }

    static func remember(_ url: String) {
        guard url != "about:blank" else { return }
        UserDefaults.standard.set(Array(unique([url] + saved()).prefix(maxSaved)), forKey: historyKey)
    }

    static func unique(_ urls: [String]) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for u in urls {
            let t = u.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty || seen.contains(t) { continue }
            seen.insert(t)
            out.append(t)
        }
        return out
    }

    static func matches(_ url: String, _ needle: String) -> Bool {
        if url.lowercased().contains(needle) { return true }
        return URL(string: url)?.host?.lowercased().contains(needle) ?? false
    }

    /// `normalizeUrl` from browser-view.tsx.
    static func normalize(_ raw: String) -> String {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "about:blank" }
        if t.range(of: "^(https?:|file:|about:)", options: [.regularExpression, .caseInsensitive]) != nil { return t }
        if t.range(of: "^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?(/|$)", options: [.regularExpression, .caseInsensitive]) != nil { return "http://" + t }
        return "https://" + t
    }

    /// `browserTitle(url, fallback)`.
    static func title(_ url: String, fallback: String) -> String {
        if url.isEmpty || url == "about:blank" { return fallback }
        if let u = URL(string: url), u.scheme != nil {
            if let h = u.host, !h.isEmpty { return h }
            if !u.path.isEmpty { return u.path }
            return fallback
        }
        return url.count > 24 ? String(url.prefix(21)) + "..." : url
    }

    // MARK: Navigation

    func navigate(_ raw: String, replace: Bool = false) {
        let next = Self.normalize(raw)
        let shouldReplace = replace || next == url
        address = next
        url = next
        suggestionsOpen = false
        Self.remember(next)
        if shouldReplace {
            if history.indices.contains(historyIndex) { history[historyIndex] = next }
        } else {
            history = Array(history.prefix(historyIndex + 1)) + [next]
            historyIndex += 1
        }
        openError = nil
        reloadToken += 1
    }

    func move(_ delta: Int) {
        let i = historyIndex + delta
        guard history.indices.contains(i) else { return }
        historyIndex = i
        address = history[i]
        url = history[i]
        suggestionsOpen = false
        Self.remember(url)
        openError = nil
        reloadToken += 1
    }

    func reload() {
        if inlinePreview { inline?.reload(); loading = true; return }
        reloadToken += 1
    }
}

@MainActor
enum WorkspaceBrowsers {
    static var models: [Int: WorkspaceBrowserModel] = [:]
    /// The tab whose toolbar has keyboard focus (browser-view's onKeyDownCapture scope).
    static var focusedTab: Int?

    static func model(_ id: Int) -> WorkspaceBrowserModel {
        if let m = models[id] { return m }
        let m = WorkspaceBrowserModel()
        models[id] = m
        return m
    }

    static func close(_ id: Int) {
        models.removeValue(forKey: id)
        if focusedTab == id { focusedTab = nil }
    }
}

/// ⌘R, ⌘[ / ⌘], ⌥← / ⌥→ while the Browser toolbar has focus (captured before
/// the app shortcuts, as `onKeyDownCapture` stops them in Tauri); Esc closes
/// the URL suggestions.
enum WorkspaceBrowserKeys {
    static func handle(_ e: NSEvent, _ app: AppState) -> Bool {
        MainActor.assumeIsolated { handleOnMain(e) }
    }

    @MainActor private static func handleOnMain(_ e: NSEvent) -> Bool {
        guard e.type == .keyDown, let id = WorkspaceBrowsers.focusedTab, let m = WorkspaceBrowsers.models[id] else { return false }
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let mod = f.contains(.command) || f.contains(.control)
        let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
        let plainMod = mod && !f.contains(.option) && !f.contains(.shift)
        if plainMod && key == "r" { m.reload(); return true }
        if plainMod && e.keyCode == 33 { m.move(-1); return true } // [
        if plainMod && e.keyCode == 30 { m.move(1); return true } // ]
        let altOnly = f.contains(.option) && !f.contains(.command) && !f.contains(.control) && !f.contains(.shift)
        if altOnly && e.keyCode == 123 { m.move(-1); return true }
        if altOnly && e.keyCode == 124 { m.move(1); return true }
        if e.keyCode == 53, m.suggestionsOpen { m.suggestionsOpen = false; return true }
        return false
    }
}

/// browser-view.tsx: toolbar (back / forward / reload, address with URL
/// suggestions, Preview, Annotate, open externally) over the page. The page is
/// a WKWebView with Cetus's annotation script (the Tauri child webview), or a
/// plain one for the inline preview (the iframe).
struct WorkspaceBrowserView: View {
    @Environment(AppState.self) private var app
    let tab: WorkspaceTab
    let layout: WorkspaceState.Layout
    let visible: Bool
    @State private var model: WorkspaceBrowserModel
    @FocusState private var addressFocused: Bool

    init(tab: WorkspaceTab, layout: WorkspaceState.Layout, visible: Bool) {
        self.tab = tab
        self.layout = layout
        self.visible = visible
        _model = State(initialValue: WorkspaceBrowsers.model(tab.id))
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
                .zIndex(2)
            ZStack(alignment: .topLeading) {
                Theme.background
                if model.inlinePreview {
                    if visible {
                        WorkspaceWebPage(model: model, url: model.url, annotation: false)
                            .background(Color.white)
                            .testID("browser-inline-frame")
                    }
                } else {
                    placeholder
                    // The loading chip is DOM under Tauri's native child webview: hidden once the page is up.
                    if model.loading { loadingChip }
                    if visible, model.url != "about:blank", model.openError == nil {
                        WorkspaceWebPage(model: model, url: model.url, annotation: true)
                            .testID("browser-panel")
                    }
                }
                if model.inlinePreview, model.loading { loadingChip }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .zIndex(1)
        }
        .background(Theme.background)
        .modifier(WorkspaceBrowserEvents(app: app, model: model, tab: tab, layout: layout, addressFocused: $addressFocused))
        .testID("browser-view")
    }

    private var loadingChip: some View {
        HStack(spacing: 8) { Spinner(size: 14); Text(model.displayHost).lineLimit(1).lineBox(16.2) }
            .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background.opacity(0.95)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
            .padding(12)
            .allowsHitTesting(false)
    }

    // MARK: Toolbar — `flex h-11 items-center gap-2 border-b px-3`

    private var toolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                navButton("arrow-left", "Back", enabled: model.historyIndex > 0) { model.move(-1) }
                navButton("arrow-right", "Forward", enabled: model.historyIndex < model.history.count - 1) { model.move(1) }
                navButton("refresh-cw", "Reload", enabled: true) { model.reload() }
            }
            address
                .frame(maxWidth: .infinity)
            WorkspaceToggleButton(icon: "globe", label: "Preview", on: model.inlinePreview) {
                model.inlinePreview.toggle()
                if model.inlinePreview { model.annotating = false }
            }
            .help("Toggle inline preview")
            .testID("browser-inline-preview-toggle")
            WorkspaceToggleButton(icon: "highlighter", label: "Annotate", on: model.annotating) { setAnnotating(!model.annotating) }
                .help("Annotate")
                .testID("browser-annotate")
            navButton("external-link", "Open in default browser", enabled: true) {
                if let u = URL(string: model.url) { NSWorkspace.shared.open(u) }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 43)
        .padding(.bottom, 1)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private func navButton(_ icon: String, _ title: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        GhostIconButton(icon: icon, box: 32, glyph: 16, color: Theme.foreground, testID: "browser-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))", action: action)
            .disabled(!enabled)
            .compositingGroup()
            .opacity(enabled ? 1 : 0.5)
            .help(title)
    }

    private var address: some View {
        let m = model
        return ZStack(alignment: .leading) {
            TextField("", text: Binding(get: { m.address }, set: { v in guard v != m.address else { return }; m.address = v; m.suggestionsOpen = true }))
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Theme.foreground)
                .focused($addressFocused)
                .padding(.leading, 32).padding(.trailing, 8)
                .frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 7).fill(Theme.input.opacity(0.3)).padding(1))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
                .onSubmit {
                    let s = m.suggestions
                    if m.suggestionsOpen, s.indices.contains(m.highlighted) { select(s[m.highlighted]) } else { m.navigate(m.address) }
                }
                .onKeyPress(.downArrow) { arrow(1) }
                .onKeyPress(.upArrow) { arrow(-1) }
                .testID("browser-address")
            Glyph(name: "globe", size: 14, color: Theme.mutedForeground).padding(.leading, 10).allowsHitTesting(false)
        }
        .overlay(alignment: .topLeading) {
            let s = m.suggestions
            if m.suggestionsOpen && !s.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(s.enumerated()), id: \.element) { i, url in
                        WorkspaceSuggestionRow(url: url, highlighted: i == m.highlighted, onHover: { m.highlighted = i }) { select(url) }
                    }
                }
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.popover))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.1), radius: 2.5, y: 4)
                .shadow(color: .black.opacity(0.1), radius: 1.5, y: 2)
                .offset(y: 32)
                .testID("browser-url-suggestions")
            }
        }
    }

    private func arrow(_ d: Int) -> KeyPress.Result {
        let s = model.suggestions
        if !model.suggestionsOpen { model.suggestionsOpen = !s.isEmpty }
        guard !s.isEmpty else { return .ignored }
        if d > 0 { model.highlighted = (model.highlighted + 1) % s.count }
        else { model.highlighted = model.highlighted <= 0 ? s.count - 1 : model.highlighted - 1 }
        return .handled
    }

    private func select(_ url: String) { model.navigate(url, replace: url == model.url) }

    private func setAnnotating(_ on: Bool) {
        model.annotating = on
        if model.inlinePreview { model.inlinePreview = false; return }
        WorkspaceWebPage.setAnnotationMode(model.panel, on)
    }

    // MARK: Body

    @ViewBuilder
    private var placeholder: some View {
        if let err = model.openError {
            VStack(spacing: 0) {
                Glyph(name: "globe", size: 20, color: Theme.mutedForeground)
                    .frame(width: 48, height: 48)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.4)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                Text("Cetus Browser").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02).padding(.top, 16)
                Text(model.url).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2).padding(.top, 4)
                Text(err).font(.system(size: 12)).foregroundStyle(Theme.destructive)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.destructive.opacity(0.1)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.destructive.opacity(0.3), lineWidth: 1))
                    .padding(.top, 12)
                Button { model.openError = nil; model.reloadToken += 1 } label: {
                    HStack(spacing: 4) { Glyph(name: "external-link", size: 14, color: Theme.foreground); Text("Open").lineBox(20.02) }
                }
                .buttonStyle(WorkspaceOutlineButtonStyle())
                .padding(.top, 16)
            }
            .frame(maxWidth: 448)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
        } else {
            VStack(spacing: 0) {
                Glyph(name: "globe", size: 24, color: Theme.mutedForeground).opacity(0.5).padding(.bottom, 12)
                Text("Cetus Browser").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(16.2)
                Text("Enter a URL or ask Cetus to open a page.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2).padding(.top, 4)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
        }
    }
}

/// shadcn `Button size="xs"`: outline (dark: border-input, bg-input/30) or, when on, default (primary).
private struct WorkspaceToggleButton: View {
    let icon: String
    let label: String
    let on: Bool
    let action: () -> Void
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let dark = scheme == .dark
        let fg = on ? Theme.primaryForeground : Theme.foreground
        Button(action: action) {
            HStack(spacing: 4) {
                Glyph(name: icon, size: 14, color: fg)
                Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(fg).lineBox(16.2)
            }
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 7).fill(
                on ? Theme.primary.opacity(hover ? 0.8 : 1) : dark ? Theme.input.opacity(hover ? 0.5 : 0.3) : hover ? Theme.muted : Theme.background).padding(1))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? .clear : dark ? Theme.input : Theme.border, lineWidth: 1))
            .shadow(color: on ? .clear : .black.opacity(0.05), radius: 1, y: 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .onHover { hover = $0 }
    }
}

private struct WorkspaceSuggestionRow: View {
    let url: String
    let highlighted: Bool
    let onHover: () -> Void
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Glyph(name: "globe", size: 14, color: Theme.mutedForeground)
                Text(url).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(highlighted ? Theme.accent : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { if $0 { onHover() } }
        .help(url)
    }
}

extension Notification.Name {
    static let workspaceBrowserAnnotation = Notification.Name("cetus.workspace.browserAnnotation")
}

/// The page itself. With `annotation`, Cetus's annotation script is injected
/// (no floating toggle, as in the panel) and the document title is watched for
/// its tokenised payload, which is sent to the active chat like Tauri's
/// `browser-annotation` event.
struct WorkspaceWebPage: NSViewRepresentable {
    let model: WorkspaceBrowserModel
    let url: String
    let annotation: Bool
    @Environment(AppState.self) private var app

    static let labels = (annotate: "Annotate", placeholder: "Describe what Cetus should change here", cancel: "Cancel annotation", send: "Send")

    static func script(token: String, toggle: Bool) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
                .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
        }
        let t = toggle ? "<button id=\"cetus-browser-annotation-toggle\" type=\"button\">\(esc(labels.annotate))</button>" : ""
        return WorkspaceBrowserScript.annotation
            .replacingOccurrences(of: "__CETUS_BROWSER_ANNOTATION_TOKEN__", with: token)
            .replacingOccurrences(of: "__CETUS_BROWSER_ANNOTATION_TOGGLE__", with: t)
            .replacingOccurrences(of: "__CETUS_BROWSER_ANNOTATE_PLACEHOLDER__", with: esc(labels.placeholder))
            .replacingOccurrences(of: "__CETUS_BROWSER_ANNOTATE_CANCEL__", with: esc(labels.cancel))
            .replacingOccurrences(of: "__CETUS_BROWSER_ANNOTATE_SEND__", with: esc(labels.send))
    }

    static func setAnnotationMode(_ v: WKWebView?, _ on: Bool) {
        v?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('cetus-browser-annotation-mode', { detail: { enabled: \(on) } }));")
    }

    func makeCoordinator() -> Coordinator { Coordinator(model: model, app: app) }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        if annotation {
            let token = "__CETUS_BROWSER_ANNOTATION__\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())__"
            context.coordinator.token = token
            cfg.userContentController.addUserScript(WKUserScript(source: Self.script(token: token, toggle: false), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.navigationDelegate = context.coordinator
        v.allowsBackForwardNavigationGestures = false
        if annotation { model.panel = v } else { model.inline = v }
        context.coordinator.observe(v)
        context.coordinator.load(v, url, token: model.reloadToken)
        return v
    }

    func updateNSView(_ v: WKWebView, context: Context) {
        context.coordinator.model = model
        if context.coordinator.loadedToken != model.reloadToken || context.coordinator.loadedURL != url {
            context.coordinator.load(v, url, token: model.reloadToken)
        }
    }

    static func dismantleNSView(_ v: WKWebView, coordinator: Coordinator) {
        coordinator.titleObservation = nil
        v.stopLoading()
        if coordinator.model.panel === v { coordinator.model.panel = nil }
        coordinator.model.loading = false
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var model: WorkspaceBrowserModel
        let app: AppState
        var token: String?
        var loadedURL: String?
        var loadedToken = -1
        var titleObservation: NSKeyValueObservation?

        init(model: WorkspaceBrowserModel, app: AppState) {
            self.model = model
            self.app = app
        }

        func load(_ v: WKWebView, _ url: String, token: Int) {
            loadedURL = url
            loadedToken = token
            guard let u = URL(string: url), let scheme = u.scheme?.lowercased() else {
                MainActor.assumeIsolated { model.openError = "relative URL without a base"; model.loading = false }
                return
            }
            guard ["http", "https", "about", "file"].contains(scheme) else {
                MainActor.assumeIsolated { model.openError = "refusing to open unsupported browser url scheme: \(scheme)"; model.loading = false }
                return
            }
            MainActor.assumeIsolated { model.loading = true; model.openError = nil }
            if u.isFileURL { v.loadFileURL(u, allowingReadAccessTo: URL(fileURLWithPath: "/")) } else { v.load(URLRequest(url: u)) }
            if MainActor.assumeIsolated({ model.annotating }) {
                WorkspaceWebPage.setAnnotationMode(v, true)
            }
        }

        func observe(_ v: WKWebView) {
            titleObservation = v.observe(\.title, options: [.new]) { [weak self] web, _ in
                guard let self, let token = self.token, let title = web.title, title.hasPrefix(token) else { return }
                let raw = String(title.dropFirst(token.count))
                DispatchQueue.main.async { self.deliver(raw) }
            }
        }

        private func deliver(_ raw: String) {
            guard let data = raw.data(using: .utf8),
                  let p = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            NotificationCenter.default.post(name: .workspaceBrowserAnnotation, object: nil, userInfo: p)
            MainActor.assumeIsolated { WorkspaceBrowserAnnotation.send(p, app: app) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            MainActor.assumeIsolated { model.loading = false }
            if MainActor.assumeIsolated({ model.annotating }) { WorkspaceWebPage.setAnnotationMode(webView, true) }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { model.loading = false }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { model.loading = false }
        }
    }
}

/// page.tsx's `browser-annotation` listener: the payload becomes a user message
/// (`browserAnnotationMessage`) sent to the active conversation.
@MainActor
enum WorkspaceBrowserAnnotation {
    static func message(_ p: [String: Any]) -> String {
        var lines = ["@Browser 页面批注", "", "URL: \(p["url"] as? String ?? "")"]
        if let t = p["title"] as? String, !t.isEmpty { lines.append("页面标题: \(t)") }
        let sel = (p["selector"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (p["element"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if let sel { lines.append("页面元素: \(sel)") }
        if let t = p["text"] as? String, !t.isEmpty { lines.append("元素文本: \(t)") }
        if let r = p["rect"] as? [String: Any] {
            func n(_ k: String) -> Int { Int(((r[k] as? NSNumber)?.doubleValue ?? 0).rounded()) }
            lines.append("元素区域: \(n("width"))×\(n("height")) at (\(n("x")), \(n("y")))")
        } else if let x = (p["xPct"] as? NSNumber)?.doubleValue, let y = (p["yPct"] as? NSNumber)?.doubleValue {
            lines.append(String(format: "位置: x=%.1f%%, y=%.1f%%", x, y))
        }
        lines += ["", p["note"] as? String ?? ""]
        return lines.joined(separator: "\n")
    }

    static func send(_ p: [String: Any], app: AppState) {
        guard let url = p["url"] as? String, !url.isEmpty, let note = p["note"] as? String, !note.isEmpty else { return }
        let text = message(p)
        if ProcessInfo.processInfo.environment["CETUS_BROWSER_ANNOTATION_DRYRUN"] != nil {
            app.toast("Browser annotation", text)
            return
        }
        app.setView(ViewState(page: .chats, active: app.view.active))
        let s = app.selection
        let id = app.controller.send(SendOptions(conversationId: app.view.active, text: text, backend: s.runtime, model: s.model, effort: s.effort, workspaceDir: app.cwd))
        if app.view.active != id { app.setView(ViewState(page: .chats, active: id)) }
        app.scrollToBottomToken += 1
    }
}

/// Tab title sync, toolbar focus scope and annotation reset for a Browser tab.
private struct WorkspaceBrowserEvents: ViewModifier {
    let app: AppState
    let model: WorkspaceBrowserModel
    let tab: WorkspaceTab
    let layout: WorkspaceState.Layout
    var addressFocused: FocusState<Bool>.Binding

    func body(content: Content) -> some View {
        content
            .onChange(of: model.url) { _, u in
                // updateBrowserWorkspaceTab: the tab title follows the page host.
                app.updateDock(layout) { d in
                    if let i = d.tabs.firstIndex(where: { $0.id == tab.id }) {
                        d.tabs[i].title = WorkspaceBrowserModel.title(u, fallback: d.tabs[i].title ?? "Browser")
                    }
                }
            }
            .onChange(of: addressFocused.wrappedValue) { _, f in
                if f {
                    WorkspaceBrowsers.focusedTab = tab.id
                    model.suggestionsOpen = !model.suggestions.isEmpty
                } else {
                    if WorkspaceBrowsers.focusedTab == tab.id { WorkspaceBrowsers.focusedTab = nil }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { model.suggestionsOpen = false }
                }
            }
            .onChange(of: model.address) { _, _ in model.highlighted = -1 }
            .onReceive(NotificationCenter.default.publisher(for: .workspaceBrowserAnnotation)) { _ in model.annotating = false }
    }
}
