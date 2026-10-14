import AppKit
import ApplicationServices
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// Rewind-like screen-context collection (capture.rs + ocr.rs), ported natively:
// event-driven frame capture of the main display, perceptual-hash dedupe,
// JPEG + thumbnail on disk under the Swift data dir, an indexed row, on-device
// Apple Vision OCR, the agent-facing recall log, and tiered retention.
// Settings live in UserDefaults `settings.capture` (CapCaptureSettings).

// MARK: - Accessibility / frontmost helpers (ax.rs)

enum ScreenAX {
    /// Frontmost app (localized name, bundle id, pid) via NSWorkspace.
    static func frontmost() -> (app: String, bundle: String, pid: pid_t)? {
        guard let a = NSWorkspace.shared.frontmostApplication else { return nil }
        return (a.localizedName ?? "", a.bundleIdentifier ?? "", a.processIdentifier)
    }

    static var trusted: Bool { AXIsProcessTrusted() }

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
        return v
    }

    private static func string(_ el: AXUIElement, _ name: String) -> String? {
        attr(el, name) as? String
    }

    private static func window(_ pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        if let w = attr(app, "AXFocusedWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
        if let w = attr(app, "AXMainWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
        return nil
    }

    /// Focused (else main) window title; nil without Accessibility.
    static func windowTitle(_ pid: pid_t) -> String? {
        guard trusted, pid > 0, let w = window(pid) else { return nil }
        return string(w, "AXTitle").flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
    }

    /// Bounded walk of the focused window's text (node/depth/char/250ms caps),
    /// skipping secure text fields — `ax::visible_text`.
    static func visibleText(_ pid: pid_t, maxChars: Int) -> String? {
        guard trusted, pid > 0, let win = window(pid) else { return nil }
        let started = Date()
        var out: [String] = []
        var chars = 0, visited = 0
        var seen = Set<String>()
        var stack: [(AXUIElement, Int)] = [(win, 0)]
        while let (el, depth) = stack.popLast() {
            if visited >= 800 || chars >= maxChars || Date().timeIntervalSince(started) > 0.25 { break }
            visited += 1
            let role = string(el, "AXRole") ?? ""
            if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role), string(el, "AXSubrole") == "AXSecureTextField" { continue }
            let text: String?
            switch role {
            case "AXStaticText", "AXHeading": text = string(el, "AXValue") ?? string(el, "AXTitle")
            case "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField": text = string(el, "AXValue")
            case "AXLink": text = string(el, "AXTitle")
            default: text = nil
            }
            if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                let dup = out.last == t || (t.count >= 4 && seen.contains(t))
                if !dup {
                    chars += t.count + 1
                    seen.insert(t)
                    out.append(t)
                }
            }
            if depth >= 20 { continue }
            if let kids = attr(el, "AXChildren") as? [AXUIElement] {
                for k in kids.reversed() { stack.append((k, depth + 1)) }
            }
        }
        var joined = out.joined(separator: "\n")
        if joined.count > maxChars { joined = String(joined.prefix(maxChars)) }
        joined = joined.trimmingCharacters(in: .whitespacesAndNewlines)
        return joined.isEmpty ? nil : joined
    }

    nonisolated(unsafe) private static var woken: [pid_t: Date] = [:]
    private static let wakeLock = NSLock()

    /// Poke an Electron app's AX tree awake (debounced per pid).
    static func wake(_ pid: pid_t) {
        guard trusted, pid > 0 else { return }
        wakeLock.lock()
        if let t = woken[pid], Date().timeIntervalSince(t) < 600 { wakeLock.unlock(); return }
        woken = woken.filter { Date().timeIntervalSince($0.value) < 3600 }
        woken[pid] = Date()
        wakeLock.unlock()
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL,
              FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path) else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    private static let chromium = ["com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta", "com.brave.Browser", "com.brave.Browser.beta",
                                   "com.brave.Browser.nightly", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.vivaldi.Vivaldi",
                                   "com.operasoftware.Opera", "company.thebrowser.Browser", "com.thebrowser.Browser"]

    /// Active browser tab (url, title) via AppleScript (2s timeout); nil for non-browsers.
    static func browserURL(_ bundle: String) -> (String, String)? {
        let src: String
        if bundle == "com.apple.Safari" || bundle == "com.apple.SafariTechnologyPreview" {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of front document\nset t to name of front document\nreturn {u, t}\nend tell\nend timeout"
        } else if chromium.contains(bundle) {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of active tab of front window\nset t to title of active tab of front window\nreturn {u, t}\nend tell\nend timeout"
        } else {
            return nil
        }
        var err: NSDictionary?
        guard let desc = NSAppleScript(source: src)?.executeAndReturnError(&err), err == nil else { return nil }
        if desc.numberOfItems >= 2 {
            return (desc.atIndex(1)?.stringValue ?? "", desc.atIndex(2)?.stringValue ?? "")
        }
        return desc.stringValue.map { ($0, "") }
    }

    static func secondsSinceLastInput() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }

    static func isExcluded(_ patterns: [String], app: String, bundle: String) -> Bool {
        let name = app.lowercased(), b = bundle.lowercased()
        return patterns.contains { p in
            let p = p.trimmingCharacters(in: .whitespaces).lowercased()
            return !p.isEmpty && (name.contains(p) || b.contains(p))
        }
    }
}

// MARK: - Input timing signals (input_signals.rs)

/// Commit gestures (Enter / ⌘Enter / ⌘S / ⌘C) and typing bursts, distilled
/// from key-down timing only (no characters are kept). Monitors are installed
/// only while capture is on.
enum ScreenInputSignals {
    nonisolated(unsafe) static var lastCommitMs: Double = 0
    nonisolated(unsafe) static var lastKeydownMs: Double = 0
    nonisolated(unsafe) static var burstKeys = 0
    nonisolated(unsafe) private static var monitors: [Any] = []

    static func noteKeyDown(_ keyCode: UInt16, _ flags: NSEvent.ModifierFlags) {
        let now = nowMs()
        let prev = lastKeydownMs
        lastKeydownMs = now
        burstKeys = now - prev > 4000 ? 1 : burstKeys + 1
        let cmd = flags.contains(.command)
        if keyCode == 36 || keyCode == 76 || (cmd && (keyCode == 1 || keyCode == 8)) { lastCommitMs = now }
    }

    @MainActor static func setActive(_ on: Bool) {
        if on, monitors.isEmpty {
            if let g = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { noteKeyDown($0.keyCode, $0.modifierFlags) }) { monitors.append(g) }
            if let l = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { noteKeyDown($0.keyCode, $0.modifierFlags); return $0 }) { monitors.append(l) }
        } else if !on, !monitors.isEmpty {
            monitors.forEach(NSEvent.removeMonitor)
            monitors = []
        }
    }
}

// MARK: - Capture service (capture.rs)

enum ScreenCapture {
    static let commitSettleMs = 1200.0
    static let switchSettleMs = 900.0
    static let typingMinBurst = 8
    static let typingPauseMs = 3000.0
    static let idleSkipSecs = 120.0
    static let dedupeHamming = 6
    static let maxEdge = 1600
    static let thumbEdge = 400

    static var settings: CapCaptureSettings {
        CapStored<CapCaptureSettings>(rawValue: UserDefaults.standard.string(forKey: "settings.capture") ?? "{}")?.value ?? .init()
    }

    /// Remote-controlled parity instances (CETUS_CONTROL) share UserDefaults
    /// with every other instance and the real app, so their background loops
    /// stay off regardless of the shared toggle. CETUS_SCREEN_LOOPS=1 instead
    /// forces them on for that one test instance.
    static var loopsAllowed: Bool { Env.process["CETUS_CONTROL"] == nil || loopsForced }
    static var loopsForced: Bool { Env.process["CETUS_CONTROL"] != nil && Env.process["CETUS_SCREEN_LOOPS"] == "1" }

    nonisolated(unsafe) private static var started = false
    nonisolated(unsafe) private(set) static var running = false
    nonisolated(unsafe) static var lastHash: UInt64?
    nonisolated(unsafe) private static var askedPermission = false

    /// Start the loop (idempotent). Cheap while disabled: polls the toggle every 3s.
    static func start() {
        guard !started else { return }
        started = true
        Env.shell["CETUS_SCREEN_LOG"] = ScreenStore.shared.recallLog.path
        Task.detached(priority: .utility) { await loop() }
    }

    private struct Probe: Equatable { var app = "", bundle = "", pid: pid_t = 0, title = "" }

    private static func probe() -> Probe {
        guard let f = ScreenAX.frontmost() else { return Probe() }
        return Probe(app: f.app, bundle: f.bundle, pid: f.pid, title: f.pid > 0 ? (ScreenAX.windowTitle(f.pid) ?? "") : "")
    }

    private static func loop() async {
        var lastPrune = Date()
        var consumedCommit = 0.0, consumedTyping = 0.0
        var lastProbe = Probe()
        var switchPending: Double?
        var lastAttempt = 0.0
        while true {
            var s = settings
            if !loopsAllowed { s.enabled = false }
            if loopsForced { s.enabled = true }
            if !s.enabled {
                if running { running = false; await MainActor.run { ScreenInputSignals.setActive(false) } }
                consumedCommit = ScreenInputSignals.lastCommitMs
                consumedTyping = ScreenInputSignals.lastKeydownMs
                lastProbe = Probe()
                switchPending = nil
                try? await Task.sleep(for: .seconds(3))
                continue
            }
            if !running { running = true; await MainActor.run { ScreenInputSignals.setActive(true) } }
            if Date().timeIntervalSince(lastPrune) >= 3600 {
                prune(s)
                lastPrune = Date()
            }
            let p = probe()
            let now = nowMs()
            let idle = ScreenAX.secondsSinceLastInput() >= idleSkipSecs
            if p.bundle != lastProbe.bundle || p.title != lastProbe.title {
                switchPending = now
                lastProbe = p
            }
            let commit = ScreenInputSignals.lastCommitMs, keydown = ScreenInputSignals.lastKeydownMs
            let interval = Double(max(2, s.intervalSeconds)) * 1000
            var trigger: String?
            if commit > consumedCommit {
                if now - commit >= commitSettleMs {
                    consumedCommit = commit
                    consumedTyping = keydown
                    trigger = "commit"
                }
            } else if keydown > consumedTyping, ScreenInputSignals.burstKeys >= typingMinBurst, now - keydown >= typingPauseMs {
                consumedTyping = keydown
                trigger = "typing"
            } else if !idle, let t = switchPending, now - t >= switchSettleMs {
                switchPending = nil
                trigger = "switch"
            } else if !idle, now - lastAttempt >= interval {
                trigger = "interval"
            }
            if let trigger {
                lastAttempt = now
                if let h = await captureOnce(s, app: p.app, bundle: p.bundle, title: p.title, trigger: trigger, prevHash: lastHash) { lastHash = h }
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// Capture, dedupe, store and OCR one frame. Returns the new baseline hash
    /// when a frame was stored. `force` skips the dedupe (manual capture).
    @discardableResult
    static func captureOnce(_ s: CapCaptureSettings, app: String, bundle: String, title: String, trigger: String, prevHash: UInt64?) async -> UInt64? {
        if ScreenAX.isExcluded(s.excludedApps, app: app, bundle: bundle) { return nil }
        if !CGPreflightScreenCaptureAccess() {
            // macOS asks the first time capture runs; never nag repeatedly.
            if !askedPermission { askedPermission = true; _ = CGRequestScreenCaptureAccess() }
            return nil
        }
        guard let img = await grab() else { return nil }
        let hash = dhash(img)
        if let p = prevHash, (p ^ hash).nonzeroBitCount <= dedupeHamming { return nil }
        // Re-sample the frontmost app: drop the frame if the user switched into an excluded app meanwhile.
        let fresh = probe()
        var appName = app, appTitle = title
        if !(fresh.bundle.isEmpty && fresh.app.isEmpty) {
            if ScreenAX.isExcluded(s.excludedApps, app: fresh.app, bundle: fresh.bundle) { return nil }
            appName = fresh.app
            appTitle = fresh.title
        }
        let ts = nowMs()
        guard let (path, thumb, bytes) = save(img, ts: ts) else { return nil }
        var frame = ScreenFrame(id: UUID().uuidString.lowercased(), ts: ts, appName: appName.isEmpty ? nil : appName,
                                windowTitle: appTitle.isEmpty ? nil : appTitle, filePath: path, thumbPath: thumb,
                                phash: Int64(bitPattern: hash), bytes: bytes, ocrText: nil, trigger: trigger)
        ScreenStore.shared.insertScreenshot(frame)
        var text = ""
        if s.ocrEnabled, let t = recognize(img) {
            text = t
            if !t.isEmpty {
                ScreenStore.shared.setScreenshotOCR(frame.id, t)
                frame.ocrText = t
            }
        }
        appendRecall(ts: ts, app: frame.appName, text: text)
        return hash
    }

    /// Main display, long edge bounded to `maxEdge` (ScreenCaptureKit).
    static func grab() async -> CGImage? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { return nil }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let scale = CGFloat(filter.pointPixelScale)
            var w = CGFloat(display.width) * scale, h = CGFloat(display.height) * scale
            let longest = max(w, h)
            if longest > CGFloat(maxEdge) {
                let k = CGFloat(maxEdge) / longest
                w = (w * k).rounded()
                h = (h * k).rounded()
            }
            let cfg = SCStreamConfiguration()
            cfg.width = Int(w)
            cfg.height = Int(h)
            cfg.showsCursor = false
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        } catch {
            NSLog("screen capture: grab failed: \(error)")
            return nil
        }
    }

    // MARK: dHash

    private static func gray(_ img: CGImage, _ w: Int, _ h: Int, quality: CGInterpolationQuality) -> [UInt8] {
        var px = [UInt8](repeating: 0, count: w * h)
        px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            ctx.interpolationQuality = quality
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return px
    }

    /// 64-bit difference hash: nearest pre-shrink to 72x64, then 9x8 grayscale.
    static func dhash(_ img: CGImage) -> UInt64 {
        var src = img
        if img.width > 72, img.height > 64 {
            let pre = gray(img, 72, 64, quality: .none)
            let provider = CGDataProvider(data: Data(pre) as CFData)!
            src = CGImage(width: 72, height: 64, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: 72, space: CGColorSpaceCreateDeviceGray(),
                          bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: true,
                          intent: .defaultIntent) ?? img
        }
        let small = gray(src, 9, 8, quality: .medium)
        var hash: UInt64 = 0
        var bit: UInt64 = 0
        for y in 0 ..< 8 {
            for x in 0 ..< 8 {
                if small[y * 9 + x] > small[y * 9 + x + 1] { hash |= 1 << bit }
                bit += 1
            }
        }
        return hash
    }

    // MARK: storage

    static func downscale(_ img: CGImage, _ edge: Int) -> CGImage {
        let longest = max(img.width, img.height)
        guard longest > edge, longest > 0 else { return img }
        let k = Double(edge) / Double(longest)
        let w = max(1, Int((Double(img.width) * k).rounded())), h = max(1, Int((Double(img.height) * k).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return img }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage() ?? img
    }

    @discardableResult
    static func writeJPEG(_ img: CGImage, to url: URL) -> Bool {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }

    private static func save(_ img: CGImage, ts: Double) -> (String, String?, Int64)? {
        let date = Date(timeIntervalSince1970: ts / 1000)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        let day = ScreenStore.shared.screenshotsDir.appendingPathComponent(f.string(from: date), isDirectory: true)
        try? FileManager.default.createDirectory(at: day, withIntermediateDirectories: true)
        f.dateFormat = "HH-mm-ss-SSS"
        let stem = f.string(from: date)
        let full = day.appendingPathComponent("\(stem).jpg"), thumb = day.appendingPathComponent("\(stem).thumb.jpg")
        guard writeJPEG(downscale(img, maxEdge), to: full) else { return nil }
        let thumbOK = writeJPEG(downscale(img, thumbEdge), to: thumb)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: full.path)[.size] as? Int64) ?? 0
        return (full.path, thumbOK ? thumb.path : nil, bytes ?? 0)
    }

    // MARK: OCR (Apple Vision, as cetus-screen-helper `ocr`)

    static func recognize(_ img: CGImage) -> String? {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        req.recognitionLanguages = ["en-US", "zh-Hans"]
        do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([req]) } catch { return nil }
        let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: recall log

    private static func appendRecall(ts: Double, app: String?, text: String) {
        let url = ScreenStore.shared.recallLog
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var t = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
        if t.count > 1500 { t = String(t.prefix(1500)) }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
        let obj: [String: Any] = ["ts": Int64(ts), "iso": f.string(from: Date(timeIntervalSince1970: ts / 1000)), "app": app ?? "", "text": t]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(data + Data("\n".utf8))
            try? h.close()
        }
        if let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int, size > 2_000_000,
           let content = try? String(contentsOf: url, encoding: .utf8)
        {
            let lines = content.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.isEmpty }
            try? (lines.suffix(1500).joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        }
    }

    // MARK: retention

    static func prune(_ s: CapCaptureSettings) {
        let day = 86_400_000.0
        if s.frameRetentionDays > 0 {
            for p in ScreenStore.shared.pruneScreenshotFrames(before: nowMs() - Double(s.frameRetentionDays) * day) { try? FileManager.default.removeItem(atPath: p) }
        }
        guard s.retentionDays > 0 else { return }
        for p in ScreenStore.shared.pruneScreenshots(before: nowMs() - Double(s.retentionDays) * day) { try? FileManager.default.removeItem(atPath: p) }
    }
}
