import AppKit

/// Extra control commands registered by feature areas. Control.swift's
/// `default:` case asks these before answering "unknown".
enum ControlHooks {
    /// Areas append their handler at launch (e.g. `VoiceControl.install()`).
    nonisolated(unsafe) static var handlers: [@MainActor (String, String, AppState) async -> String?] = [{ await QuickControl.run($0, $1, $2) }]

    @MainActor static func run(_ cmd: String, _ arg: String, _ app: AppState) async -> String? {
        for h in handlers { if let r = await h(cmd, arg, app) { return r } }
        return nil
    }
}

/// `quick <sub> [args]` — drive the launcher / reply surface / snip overlay
/// in a comparison run without global gestures or keyboard focus:
///
///     quick open [shot] | reply | snip | close | state | submit | tab | esc
///     quick type <text> | quick click <testID> | quick frame <testID>
///     quick shot <path> | quick snipshot <path> | quick backdrop <hex|off>
///     quick menu <workspace|runtime|model|reply-runtime|off> | quick tip <id|off>
///     quick fakeshot <path> | quick context <app>|<url>|<selection>
///     quick replystate loading|streaming <text>|drafted <text>|error <text>
///     quick snipdrag x0 y0 x1 y1 | quick snipfinish [x y w h] | quick set <key> <value>
///     quick gesture plain|shot|reply | quick hotkeys
@MainActor
enum QuickControl {
    static func run(_ cmd: String, _ arg: String, _ app: AppState) async -> String? {
        guard cmd == "quick" else { return nil }
        let qc = QuickController.shared
        if qc.app == nil { qc.start(app) }
        let parts = arg.split(separator: " ", maxSplits: 1).map(String.init)
        let sub = parts.first ?? ""
        let rest = parts.count > 1 ? parts[1] : ""
        let m = qc.model
        func sleep(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }
        switch sub {
        case "open":
            if qc.shown { qc.park() }
            if rest == "shot" { qc.openPanel(capture: true) } else { qc.openPanel(capture: false) }
            await sleep(400)
        case "reply":
            if qc.shown { qc.park() }
            qc.openReply()
            await sleep(600)
        case "snip":
            Snip.shared.begin()
            await sleep(400)
        case "gesture":
            HotkeyGesture.shared.trigger(rest == "reply" ? HotkeyGesture.actReply : rest == "shot" ? HotkeyGesture.actShot : HotkeyGesture.actPlain)
            await sleep(500)
        case "close": qc.dismiss(); if qc.snipActive { Snip.shared.cancel() }
        case "submit": qc.submit(); await sleep(300)
        case "tab": if m.surface == .reply { _ = qc.enabledRuntimes(); qc.regenerateReply(nextRuntime(qc, m.replyBackend)) } else { qc.cycleBackend() }
        case "esc": if m.menu != nil { m.menu = nil } else { qc.dismiss() }
        case "type":
            m.text += rest.replacingOccurrences(of: "\\n", with: "\n")
            await sleep(200)
        case "draft": m.replyDraft = rest
        case "click":
            guard let w = clickWindow(rest), let f = TestRegistry.shared.frame(rest) else { return "missing" }
            click(w, CGPoint(x: f.midX, y: f.midY))
            await sleep(250)
        case "clickat":
            let n = rest.split(separator: " ").compactMap { Double($0) }
            guard n.count == 2, let w = qc.window else { return "bad args" }
            click(w, CGPoint(x: n[0], y: n[1]))
            await sleep(250)
        case "frame":
            guard let f = TestRegistry.shared.frame(rest) else { return "missing" }
            return "\(f.minX) \(f.minY) \(f.width) \(f.height)"
        case "shot":
            guard let w = qc.window else { return "no panel" }
            await sleep(250)
            _ = System.run(["/usr/sbin/screencapture", "-x", "-o", "-l", "\(w.windowNumber)", rest])
            return "ok \(Int(w.frame.width))x\(Int(w.frame.height))"
        case "snipshot":
            guard let w = Snip.shared.window else { return "no overlay" }
            await sleep(250)
            _ = System.run(["/usr/sbin/screencapture", "-x", "-o", "-l", "\(w.windowNumber)", rest])
        case "backdrop":
            if rest == "off" || rest.isEmpty { qc.setBackdrop(nil) } else if let v = UInt32(rest.replacingOccurrences(of: "#", with: ""), radix: 16) { qc.setBackdrop(NSColor(hex: v)) }
        case "menu": m.menu = rest == "off" ? nil : rest; await sleep(200)
        case "tip": m.tooltip = rest == "off" ? nil : rest; await sleep(250)
        case "fakeshot":
            guard let d = FileManager.default.contents(atPath: rest) else { return "missing file" }
            m.screenshot = QuickShot(data: d)
            m.includeScreenshot = true
            m.screenshotDenied = false
        case "denied":
            m.screenshot = nil
            m.includeScreenshot = true
            m.screenshotDenied = true
        case "attach":
            qc.addPaths(rest.split(separator: "|").map(String.init))
        case "context":
            let f = rest.components(separatedBy: "|")
            m.context = QuickAmbient(app: f[safe: 0] ?? "", url: f[safe: 1] ?? "", selection: f[safe: 2] ?? "")
            m.includeScreenshot = true
        case "replystate":
            let p = rest.split(separator: " ", maxSplits: 1).map(String.init)
            let text = p.count > 1 ? p[1] : ""
            if m.surface != .reply || m.replyOpen == nil {
                m.surface = .reply
                m.replyOpen = QuickReplyOpen(openId: nowMs(), app: "", screenshotPermission: true, screenshot: m.screenshot, context: nil, axChars: 0)
                qc.presentReplyForTest()
            }
            switch p.first ?? "" {
            case "loading": m.replyResult = nil; m.replyDraft = ""
            case "streaming": m.replyResult = nil; m.replyDraft = text
            case "drafted": m.replyResult = .success(text); m.replyDraft = text
            case "error": m.replyResult = .failure(.init(text)); m.replyDraft = ""
            case "open":
                let f = text.components(separatedBy: "|")
                m.replyOpen?.app = f[safe: 0] ?? ""
                m.replyOpen?.context = QuickAmbient(app: f[safe: 0] ?? "", url: f[safe: 1] ?? "", selection: f[safe: 2] ?? "")
                m.replyOpen?.axChars = Int(f[safe: 3] ?? "") ?? 0
                m.replyOpen?.screenshot = m.screenshot
            default: return "bad state"
            }
        case "snipdrag":
            let n = rest.split(separator: " ").compactMap { Double($0) }.map { CGFloat($0) }
            Snip.shared.simulate(n.count == 4 ? (n[0], n[1], n[2], n[3]) : nil)
        case "snipfinish":
            let n = rest.split(separator: " ").compactMap { Double($0) }
            Snip.shared.finish(n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil)
            await sleep(900)
        case "set":
            let p = rest.split(separator: " ", maxSplits: 1).map(String.init)
            let v = p.count > 1 ? p[1] : ""
            switch p.first ?? "" {
            case "keepOpen": qc.setKeepOpen(v == "1")
            case "openMain": qc.setOpenMain(v == "1")
            case "session": m.sessionMode = v
            case "hasLast": m.hasLastChat = v == "1"
            case "backend": qc.selectBackend(v)
            case "effort": qc.setTuning(effort: v)
            case "model": qc.setTuning(model: v)
            case "workspace": qc.setWorkspace(v)
            case "launched": m.launchedTick = Int(v) ?? 0
            case "replyBackend": m.replyBackend = v
            default: return "bad key"
            }
            await sleep(150)
        case "hotkeys":
            return "gesture=\(HotkeyGesture.shared.active) summon=\(HotkeySummon.shared.registered.isEmpty ? "-" : HotkeySummon.shared.registered)"
        case "state":
            let res: String
            switch m.replyResult { case .none: res = "nil"; case .success(let s): res = "ok:\(s.prefix(80))"; case .failure(let e): res = "err:\(e.message)" }
            return "shown=\(qc.shown) surface=\(m.surface) text=\(m.text.debugDescription) session=\(m.sessionMode) backend=\(m.backend) cli=\(m.cliModel)/\(m.cliEffort) pi=\(m.piModel)/\(m.piEffort) ws=\(m.workspaceDir ?? "nil") keepOpen=\(m.keepOpen) openMain=\(m.openMain) shot=\(m.screenshot?.data.count ?? 0) include=\(m.includeScreenshot) denied=\(m.screenshotDenied) ctx=\(m.context.map { "\($0.app)|\($0.url)|\($0.selection.count)" } ?? "nil") attach=\(m.attachments.count) menu=\(m.menu ?? "-") reply=\(m.replyBackend) result=\(res) draft=\(m.replyDraft.count) snip=\(qc.snipActive) frame=\(qc.window.map { "\(Int($0.frame.width))x\(Int($0.frame.height))" } ?? "-")"
        default: return "unknown quick command"
        }
        return "ok"
    }

    private static func nextRuntime(_ qc: QuickController, _ id: String) -> String {
        let list = qc.enabledRuntimes()
        guard !list.isEmpty else { return id }
        let i = list.firstIndex { $0.id == id } ?? -1
        return list[(i + 1) % list.count].id
    }

    private static func clickWindow(_ id: String) -> NSWindow? {
        id.hasPrefix("snip") ? Snip.shared.window : QuickController.shared.window
    }

    /// Synthetic click into a background panel (the real cursor is untouched).
    private static func click(_ w: NSWindow, _ p: CGPoint) {
        guard let cv = w.contentView else { return }
        let pt = NSPoint(x: p.x, y: cv.frame.height - p.y)
        for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: t, location: pt, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                w.sendEvent(e)
            }
        }
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
