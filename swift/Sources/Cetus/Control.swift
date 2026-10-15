import AppKit

/// Line-based remote control for side-by-side visual comparison:
/// `CETUS_CONTROL=/tmp/cetus-ctl Cetus` reads commands appended to
/// `<path>.in` and appends one result line per command to `<path>.out`.
///
///     keys cmd-k | type hello | click <testID> | hover <testID> | move x y
///     shot /tmp/a.png | wait 300 | settings <Section> | page chats|kanban|automations
///     frame <testID> | esc | origin x y | back | open <convId>
@MainActor
final class Control {
    let driver: Driver
    let input: URL
    let output: URL
    var offset: UInt64 = 0

    static func start(app: AppState, window: NSWindow, path: String) {
        let driver = Driver(app: app, window: window)
        driver.activates = false
        let c = Control(driver: driver, path: path)
        Task { @MainActor in await c.loop() }
    }

    init(driver: Driver, path: String) {
        self.driver = driver
        input = URL(fileURLWithPath: path + ".in")
        output = URL(fileURLWithPath: path + ".out")
        FileManager.default.createFile(atPath: input.path, contents: Data())
        FileManager.default.createFile(atPath: output.path, contents: Data())
    }

    private func loop() async {
        while true {
            if let h = try? FileHandle(forReadingFrom: input) {
                try? h.seek(toOffset: offset)
                let data = h.readDataToEndOfFile()
                try? h.close()
                if let text = String(data: data, encoding: .utf8), let end = text.lastIndex(of: "\n") {
                    let complete = text[...end]
                    offset += UInt64(complete.utf8.count)
                    for line in complete.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
                        let r = await run(String(line))
                        append("\(line) => \(r)")
                    }
                }
            }
            await driver.sleep(100)
        }
    }

    private func append(_ s: String) {
        guard let h = try? FileHandle(forWritingTo: output) else { return }
        h.seekToEndOfFile()
        h.write(Data((s + "\n").utf8))
        try? h.close()
    }

    private func run(_ line: String) async -> String {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts[0], arg = parts.count > 1 ? parts[1] : ""
        let app = driver.app, window = driver.window
        do {
            switch cmd {
            case "keys": await driver.keys(arg)
            case "type": await driver.type(arg)
            case "click": try await driver.click(arg)
            case "rclick":
                guard let f = driver.element(arg) else { return "missing" }
                driver.clickAt(CGPoint(x: f.midX, y: f.midY), button: 1)
            case "esc": await driver.keys("escape")
            case "wait": await driver.sleep(Int(arg) ?? 300)
            case "hero":
                // hero "<headline text>" | "<placeholder text>"
                let h = arg.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                if let i = HeroCopy.headlines.firstIndex(of: h[0]) { app.heroIndex = i }
                if h.count > 1, let i = HeroCopy.placeholders.firstIndex(of: h[1]) { app.placeholderIndex = i }
            case "origin":
                // origin x y : move the window (global CG points, top-left) so it stops occluding others.
                let n = arg.split(separator: " ").compactMap { Double($0) }
                guard n.count == 2, let screen = NSScreen.screens.first else { return "bad args" }
                window.setFrameTopLeftPoint(NSPoint(x: n[0], y: screen.frame.maxY - n[1]))
            case "back": window.orderBack(nil)
            case "active": return app.active ?? "nil"
            case "activate": NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
            case "open": app.openChat(arg)
            case "settings": app.settingsSection = arg; app.settings = true
            case "page":
                app.setView(ViewState(page: arg == "kanban" ? .kanban : arg == "automations" ? .automations : .chats, active: app.active))
            case "frame":
                guard let f = driver.element(arg) else { return "missing" }
                return "\(f.minX) \(f.minY) \(f.width) \(f.height)"
            case "drag":
                // drag <testID> dx dy : press on the element's centre, move by (dx, dy), release.
                let a = arg.split(separator: " ").map(String.init)
                guard a.count == 3, let dx = Double(a[1]), let dy = Double(a[2]), let f = driver.element(a[0]) else { return "bad args" }
                await driver.dragAt(CGPoint(x: f.midX, y: f.midY), by: CGSize(width: dx, height: dy))
            case "hover":
                guard let f = driver.element(arg) else { return "missing" }
                move(CGPoint(x: f.midX, y: f.midY))
            case "tip":
                // tip <text|id> : show that trigger's tooltip (synthetic hover can't reach a background window).
                guard let f = TooltipLayer.registry[arg] else { return "missing" }
                driver.app.tooltip = arg.isEmpty ? nil : f()
            case "toast":
                // toast <title> : show an error toast (layout checks).
                driver.app.toast(arg, kind: .error)
            case "untip":
                driver.app.tooltip = nil
            case "move":
                let n = arg.split(separator: " ").compactMap { Double($0) }
                guard n.count == 2 else { return "bad args" }
                move(CGPoint(x: n[0], y: n[1]))
                return "ok " + hoverAreas.map { "\(type(of: $0.owner!)):\($0.options.rawValue)" }.joined(separator: ",")
            case "ax":
                // ax x0 y0 x1 y1 [path] : accessibility elements inside the box, window coordinates.
                let a = arg.split(separator: " ").map(String.init)
                let n = a.prefix(4).compactMap { Double($0) }
                let box = n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2] - n[0], height: n[3] - n[1]) : CGRect(x: 0, y: 0, width: 1e5, height: 1e5)
                var lines: [String] = []
                dumpAX(window.contentView, box: box, into: &lines)
                let path = a.count > 4 ? a[4] : "/tmp/cetus-ax.txt"
                try lines.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
                return "\(lines.count) -> \(path)"
            case "shot":
                await driver.sleep(250)
                _ = System.run(["/usr/sbin/screencapture", "-x", "-o", "-l", "\(window.windowNumber)", arg])
            default:
                if let h = ScreenControl.handler(cmd) { return await h(app, arg) }
                if let r = await ControlHooks.run(cmd, arg, app) { return r }
                return "unknown"
            }
            return "ok"
        } catch {
            return "error \(error)"
        }
    }

    private func dumpAX(_ root: Any?, box: CGRect, into lines: inout [String], depth: Int = 0) {
        guard depth < 60, let el = root as? NSAccessibilityElementProtocol & NSObjectProtocol else { return }
        let obj = el as AnyObject
        let w = driver.window
        let screenH = w.screen?.frame.maxY ?? 0
        if let frame = (obj as? NSAccessibilityProtocol)?.accessibilityFrame(), frame.width > 0 {
            // Screen (bottom-left) → window content (top-left).
            let winFrame = w.contentRect(forFrameRect: w.frame)
            let x = frame.minX - winFrame.minX
            let y = (screenH - frame.maxY) - (screenH - winFrame.maxY)
            let r = CGRect(x: x, y: y, width: frame.width, height: frame.height)
            if r.intersects(box) {
                let p = obj as? NSAccessibilityProtocol
                let role = p?.accessibilityRole()?.rawValue ?? "?"
                let label = [p?.accessibilityLabel(), p?.accessibilityValue() as? String, p?.accessibilityTitle()].compactMap { $0 }.first { !$0.isEmpty } ?? ""
                if role != "AXGroup" || !label.isEmpty {
                    lines.append(String(format: "%@|%@|%.1f|%.1f|%.1f|%.1f", role, String(label.prefix(30)), r.minX, r.minY, r.width, r.height))
                }
            }
        }
        for c in (obj as? NSAccessibilityProtocol)?.accessibilityChildren() ?? [] { dumpAX(c, box: box, into: &lines, depth: depth + 1) }
    }

    /// Posts a synthetic mouse-moved event (the real cursor is left alone).
    private func move(_ p: CGPoint) {
        let w = driver.window
        guard let cv = w.contentView else { return }
        let inWindow = NSPoint(x: p.x, y: cv.frame.height - p.y)
        if let e = NSEvent.mouseEvent(with: .mouseMoved, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                      windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) {
            w.acceptsMouseMovedEvents = true
            w.sendEvent(e)
        }
        // A background window gets no tracking-area events for synthetic moves,
        // so drive SwiftUI's hover tracking areas directly.
        var now: [NSTrackingArea] = []
        func walk(_ v: NSView) {
            let lp = v.convert(inWindow, from: nil)
            for a in v.trackingAreas where (a.options.contains(.inVisibleRect) ? v.visibleRect : a.rect).contains(lp) { now.append(a) }
            v.subviews.forEach(walk)
        }
        walk(cv)
        let ts = ProcessInfo.processInfo.systemUptime
        func enterExit(_ type: NSEvent.EventType, _ a: NSTrackingArea) -> NSEvent? {
            NSEvent.enterExitEvent(with: type, location: inWindow, modifierFlags: [], timestamp: ts, windowNumber: w.windowNumber,
                                   context: nil, eventNumber: 0, trackingNumber: 0, userData: Unmanaged.passUnretained(a).toOpaque())
        }
        for a in hoverAreas where !now.contains(where: { $0 === a }) {
            if let e = enterExit(.mouseExited, a) { (a.owner as? NSResponder)?.mouseExited(with: e) }
        }
        for a in now {
            if !hoverAreas.contains(where: { $0 === a }), let e = enterExit(.mouseEntered, a) { (a.owner as? NSResponder)?.mouseEntered(with: e) }
            if let e = NSEvent.mouseEvent(with: .mouseMoved, location: inWindow, modifierFlags: [], timestamp: ts, windowNumber: w.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 0, pressure: 0) { (a.owner as? NSResponder)?.mouseMoved(with: e) }
        }
        hoverAreas = now
    }
    private var hoverAreas: [NSTrackingArea] = []
}
