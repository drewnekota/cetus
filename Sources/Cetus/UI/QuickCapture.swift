import AppKit
import ApplicationServices
import Foundation

// Native capture helpers for the quick launcher, visual quick reply and the
// snip overlay — ports of quick/screenshot.rs, capture.rs
// (capture_region_jpeg_native), ax.rs (identity / selection / window title /
// visible-text walk / browser URL) and text_input.rs (⌘C selection grab,
// clipboard paste). Everything here is blocking; call it off the main thread.

/// `Screenshot`: bare base64 JPEG (≤1600px edge).
struct QuickShot: Equatable {
    var data: Data
    var mimeType = "image/jpeg"
    var base64: String { data.base64EncodedString() }
}

/// `ocr::AmbientContext`.
struct QuickAmbient: Equatable {
    var app = ""
    var bundleId = ""
    var url = ""
    var title = ""
    var selection = ""
    var isEmpty: Bool { app.isEmpty && url.isEmpty && title.isEmpty && selection.isEmpty }
}

enum QuickCapture {
    /// Test instances (CETUS_CONTROL) never touch the user's apps: no synthetic
    /// ⌘C/⌘V, no Apple Events, no AX walks of the frontmost app.
    static var sandboxed: Bool { Env.process["CETUS_CONTROL"] != nil && Env.process["CETUS_QUICK_LIVE"] == nil }

    /// ocr::MAX_SELECTION_CHARS
    static let maxSelectionChars = 40_000
    /// ax::REPLY_TEXT_CHARS
    static let replyTextChars = 8_000

    // MARK: - Screen Recording

    nonisolated(unsafe) private static var tccDenied = false

    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }
    /// `screen_recording_effective`: preflight plus whether the last real
    /// capture failed the way a paused grant fails.
    static var screenRecordingEffective: Bool { screenRecordingGranted && !tccDenied }

    /// `capture_screenshot`: the display holding the cursor (bounded grab when
    /// there are several), falling back to the plain grab.
    static func captureScreen() -> QuickShot? {
        if let region = cursorDisplayRegion() {
            return captureRegion(region) ?? captureRegion(nil)
        }
        return captureRegion(nil)
    }

    /// Bounds (CG global, top-left origin) of the display under the cursor;
    /// nil with a single display.
    static func cursorDisplayRegion() -> CGRect? {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(16, &ids, &count) == .success, count >= 2 else { return nil }
        guard let cursor = CGEvent(source: nil)?.location else { return nil }
        return ids[..<Int(count)].map { CGDisplayBounds($0) }.first { $0.contains(cursor) }
    }

    /// `capture_screenshot_region` → `capture_region_jpeg_native(region, 1600)`.
    static func captureRegion(_ region: CGRect?) -> QuickShot? {
        guard screenRecordingGranted else { return nil }
        let path = NSTemporaryDirectory() + "cetus-launch-shot-\(getpid())-\(Int(nowMs())).jpg"
        var args = ["-x", "-t", "jpg"]
        if let r = region { args += ["-R", String(format: "%.0f,%.0f,%.0f,%.0f", r.minX, r.minY, r.width, r.height)] }
        args.append(path)
        let (ok, stderr) = run("/usr/sbin/screencapture", args)
        if !ok {
            tccDenied = stderr.contains("could not create image") || stderr.contains("declined")
            try? FileManager.default.removeItem(atPath: path)
            return nil
        }
        tccDenied = false
        _ = run("/usr/bin/sips", ["-Z", "1600", path])
        defer { try? FileManager.default.removeItem(atPath: path) }
        guard let data = FileManager.default.contents(atPath: path), !data.isEmpty else { return nil }
        return QuickShot(data: data)
    }

    private static func run(_ exe: String, _ args: [String]) -> (Bool, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let err = Pipe()
        p.standardError = err
        p.standardOutput = FileHandle.nullDevice
        do { try p.run() } catch { return (false, "\(error)") }
        p.waitUntilExit()
        let e = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus == 0, e.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: - Frontmost identity / context

    /// (localized name, bundle id, pid) of the frontmost app.
    static func frontmostIdentity() -> (String, String, pid_t)? {
        guard let a = NSWorkspace.shared.frontmostApplication else { return nil }
        return (a.localizedName ?? "", a.bundleIdentifier ?? "", a.processIdentifier)
    }

    /// `gather_pre_focus_context`: frontmost app + selected text (AX first,
    /// synthetic ⌘C fallback). Must run before the panel presents.
    static func preFocusContext() -> QuickAmbient? {
        let (app, bundle, pid) = frontmostIdentity() ?? ("", "", 0)
        // Our own app in front (e.g. a test instance) carries nothing useful.
        if pid == getpid() { return nil }
        wakeElectron(pid)
        var selection = focusedSelectedText(pid) ?? (sandboxed ? nil : copySelectionViaClipboard()) ?? ""
        if selection.count > maxSelectionChars { selection = String(selection.prefix(maxSelectionChars)) }
        let ctx = QuickAmbient(app: app, bundleId: bundle, selection: selection)
        return ctx.isEmpty ? nil : ctx
    }

    /// `gather_reply_identity`.
    static func replyIdentity() -> (QuickAmbient?, pid_t) {
        var ambient = preFocusContext() ?? QuickAmbient()
        let (_, bundle, pid) = frontmostIdentity() ?? ("", "", 0)
        if ambient.bundleId.isEmpty { ambient.bundleId = bundle }
        return (ambient.isEmpty ? nil : ambient, pid)
    }

    struct ReplyDetails { var title = ""; var url = ""; var visibleText = "" }

    /// `gather_reply_details`: window title, browser URL and the bounded AX walk.
    static func replyDetails(pid: pid_t, bundle: String) -> ReplyDetails {
        var d = ReplyDetails(title: focusedWindowTitle(pid) ?? "", url: "", visibleText: settledVisibleText(pid))
        if !bundle.isEmpty, let (url, title) = browserURL(bundle) {
            d.url = url
            if !title.isEmpty { d.title = title }
        }
        return d
    }

    // MARK: - Accessibility

    nonisolated(unsafe) private static var woken: [pid_t: Date] = [:]

    /// `wake_app`: force an Electron app's AX tree on (debounced per pid).
    static func wakeElectron(_ pid: pid_t) {
        guard pid > 0, AXIsProcessTrusted() else { return }
        if let t = woken[pid], Date().timeIntervalSince(t) < 600 { return }
        woken[pid] = Date()
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL,
              FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path) else { return }
        let el = AXUIElementCreateApplication(pid)
        for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            AXUIElementSetAttributeValue(el, name as CFString, kCFBooleanTrue)
        }
    }

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
        return v
    }

    private static func attrString(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }

    /// `focused_selected_text`.
    static func focusedSelectedText(_ pid: pid_t) -> String? {
        guard AXIsProcessTrusted(), pid > 0 else { return nil }
        let app = AXUIElementCreateApplication(pid)
        guard let f = attr(app, "AXFocusedUIElement"), CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
        let text = attrString(f as! AXUIElement, "AXSelectedText") ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }

    private static func focusedWindow(_ pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        for name in ["AXFocusedWindow", "AXMainWindow"] {
            if let w = attr(app, name), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
        }
        return nil
    }

    /// `focused_window_title`.
    static func focusedWindowTitle(_ pid: pid_t) -> String? {
        guard AXIsProcessTrusted(), pid > 0, let w = focusedWindow(pid) else { return nil }
        let t = attrString(w, "AXTitle") ?? ""
        return t.trimmingCharacters(in: .whitespaces).isEmpty ? nil : t
    }

    /// `visible_text`: bounded DFS (800 nodes, depth 20, 250ms) over
    /// text-bearing roles, skipping secure fields and their subtrees.
    static func visibleText(_ pid: pid_t, maxChars: Int) -> String? {
        guard AXIsProcessTrusted(), pid > 0, let win = focusedWindow(pid) else { return nil }
        let started = Date()
        var out: [String] = []
        var seen = Set<String>()
        var chars = 0, visited = 0
        var stack: [(AXUIElement, Int)] = [(win, 0)]
        while let (el, depth) = stack.popLast() {
            if visited >= 800 || chars >= maxChars || Date().timeIntervalSince(started) * 1000 > 250 { break }
            visited += 1
            let role = attrString(el, "AXRole") ?? ""
            if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role), attrString(el, "AXSubrole") == "AXSecureTextField" { continue }
            var text: String?
            switch role {
            case "AXStaticText", "AXHeading": text = attrString(el, "AXValue") ?? attrString(el, "AXTitle")
            case "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField": text = attrString(el, "AXValue")
            case "AXLink": text = attrString(el, "AXTitle")
            default: break
            }
            if let raw = text {
                let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                let dup = out.last == t || (t.count >= 4 && seen.contains(t))
                if !t.isEmpty && !dup {
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

    /// `settled_visible_text`: one retry for a cold (Electron) tree.
    static func settledVisibleText(_ pid: pid_t) -> String {
        let first = visibleText(pid, maxChars: replyTextChars) ?? ""
        if first.count >= 40 { return first }
        wakeElectron(pid)
        usleep(280_000)
        let second = visibleText(pid, maxChars: replyTextChars) ?? ""
        return second.count > first.count ? second : first
    }

    // MARK: - Browser URL

    private static let chromium = ["com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta", "com.brave.Browser", "com.brave.Browser.beta",
                                   "com.brave.Browser.nightly", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.vivaldi.Vivaldi",
                                   "com.operasoftware.Opera", "company.thebrowser.Browser", "com.thebrowser.Browser"]

    /// `fetch_browser_url`: (url, title) of the active tab via AppleScript.
    static func browserURL(_ bundle: String) -> (String, String)? {
        if sandboxed { return nil }
        let src: String
        if bundle == "com.apple.Safari" || bundle == "com.apple.SafariTechnologyPreview" {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of front document\nset t to name of front document\nreturn {u, t}\nend tell\nend timeout"
        } else if chromium.contains(bundle) {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of active tab of front window\nset t to title of active tab of front window\nreturn {u, t}\nend tell\nend timeout"
        } else {
            return nil
        }
        var result: (String, String)?
        let work = {
            var err: NSDictionary?
            guard let desc = NSAppleScript(source: src)?.executeAndReturnError(&err), err == nil else { return }
            if desc.numberOfItems >= 2 {
                result = (desc.atIndex(1)?.stringValue ?? "", desc.atIndex(2)?.stringValue ?? "")
            } else if let s = desc.stringValue {
                result = (s, "")
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
        return result
    }

    // MARK: - Clipboard

    /// `copy_selection_via_clipboard`: synthesize ⌘C, read the pasteboard,
    /// restore every item. Nil when nothing was selected.
    static func copySelectionViaClipboard() -> String? {
        let pb = NSPasteboard.general
        let before = pb.changeCount
        let saved = snapshot(pb)
        postKey(8, flags: .maskCommand) // C
        var text: String?
        var copied = false
        for _ in 0 ..< 8 {
            usleep(10_000)
            if pb.changeCount == before { continue }
            copied = true
            text = pb.string(forType: .string)
            break
        }
        if copied { restore(pb, saved) }
        return text.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }

    /// `insert_text(.., Paste)`: clipboard + ⌘V, then put the old text back.
    static func pasteText(_ text: String) {
        let pb = NSPasteboard.general
        let saved = pb.string(forType: .string)
        pb.clearContents()
        pb.setString(text, forType: .string)
        postKey(9, flags: .maskCommand) // V
        usleep(120_000)
        if let saved {
            pb.clearContents()
            pb.setString(saved, forType: .string)
        }
    }

    /// `clipboard_file_paths`: Finder-copied file paths on the pasteboard.
    static func clipboardFilePaths() -> [String] {
        (NSPasteboard.general.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.map(\.path) ?? []
    }

    private static func snapshot(_ pb: NSPasteboard) -> [(NSPasteboard.PasteboardType, Data)] {
        var out: [(NSPasteboard.PasteboardType, Data)] = []
        for item in pb.pasteboardItems ?? [] {
            for t in item.types { if let d = item.data(forType: t) { out.append((t, d)) } }
        }
        return out
    }

    private static func restore(_ pb: NSPasteboard, _ saved: [(NSPasteboard.PasteboardType, Data)]) {
        pb.clearContents()
        guard !saved.isEmpty else { return }
        let item = NSPasteboardItem()
        for (t, d) in saved { item.setData(d, forType: t) }
        pb.writeObjects([item])
    }

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            e.post(tap: .cgSessionEventTap)
        }
    }
}
