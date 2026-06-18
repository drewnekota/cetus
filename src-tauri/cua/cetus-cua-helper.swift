// cetus-cua-helper.swift
//
// A long-lived macOS "computer use" helper. It enumerates the accessibility
// (AX) UI tree of the frontmost (or a named) application, returns a flat,
// indexed list of interactive elements, and performs actions on those elements
// (click / type / key / scroll / move-click). It speaks newline-delimited JSON
// over stdin/stdout: exactly one request JSON object per line in, exactly one
// response JSON object per line out.
//
// WHY LONG-LIVED: AXUIElement references are process-local opaque handles and
// cannot be serialized across processes. A "dump" mints an observationId and
// caches index -> AXUIElement in memory; a subsequent "act" looks elements up
// by index against that cached map. Therefore dump and act MUST share a single
// helper process. The Rust host keeps the process alive and replays the last
// observationId on each act; a mismatch yields {"ok":false,"error":"stale-observation"}.
//
// Protocol (one JSON object per line):
//   stdin  <- {"op":"ping"}
//   stdout -> {"ok":true}
//
//   stdin  <- {"op":"dump"}                         dump frontmost app
//   stdin  <- {"op":"dump","app":"Safari"}          dump app by bundleId or name
//   stdout -> {"ok":true,"observationId":"o_1","app":"Safari","count":N,
//              "elements":[{"index":0,"role":"AXButton","label":"Send","value":"",
//                           "x":..,"y":..,"w":..,"h":..,"enabled":true,"focused":false}, ...]}
//   stdout -> {"ok":true,"fallback":"ocr","app":"Chrome","observationId":"o_2","elements":[]}
//                 (Chromium/Electron host, too few actionable elements, or
//                  kAXErrorCannotComplete: the Rust host should run OCR instead)
//   stdout -> {"ok":false,"error":"ax-not-trusted"}  accessibility permission missing
//
//   stdin  <- {"op":"act","observationId":"o_1","actions":[{"op":"click","index":3}, ...]}
//   stdout -> {"ok":true,"result":"clicked [3] Send"}   (actions applied in order, stop at first failure)
//   stdout -> {"ok":false,"error":"stale-observation"}
//
// Action ops (applied in array order, stop at first error):
//   {"op":"click","index":N}              AXPress, else synthetic CGEvent click at element center
//   {"op":"type","index":N,"text":"..."}  set kAXValue, else focus + unicode CGEvent keystrokes
//   {"op":"key","keys":"cmd+shift+s"}     parse modifiers + keycode, post key down/up
//   {"op":"scroll","dx":0,"dy":-120}      pixel scroll wheel; optional "index" moves cursor first
//   {"op":"move_click","x":640,"y":400}   synthetic click at GLOBAL logical top-left points (no scaling)
//
// The helper is compiled lazily by the Rust host on first use with:
//   swiftc -O -framework ApplicationServices -framework AppKit -framework CoreGraphics \
//     -o cetus-cua-helper cetus-cua-helper.swift
//
// It is intentionally dependency-free (no SwiftPM manifest) so it can be built
// and cached next to the other bundled native helpers.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - JSON output helper

/// Serialize a JSON-compatible dictionary and write it to stdout as a single
/// line, then flush so the Rust host can read it immediately.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let str = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"json-encode-failed\"}\n".utf8))
        fflush(stdout)
        return
    }
    FileHandle.standardOutput.write(Data((str + "\n").utf8))
    fflush(stdout)
}

// MARK: - Accessibility permission gate

/// Returns true if this process is trusted for the Accessibility API. Passing
/// kAXTrustedCheckOptionPrompt prompts the user (once) on first denied call.
func axTrusted() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

// MARK: - AX attribute readers (robust: any miss -> nil / "")

/// Read an arbitrary attribute value as a CFTypeRef, or nil.
func axCopy(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard err == .success else { return nil }
    return value
}

/// Read a string-valued attribute. Coerces numbers/bools to a String too so a
/// static element's AXValue can be surfaced as a label.
func axString(_ element: AXUIElement, _ attr: String) -> String? {
    guard let value = axCopy(element, attr) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() {
        return (value as! CFString) as String
    }
    if CFGetTypeID(value) == CFNumberGetTypeID() {
        return "\((value as! NSNumber).description)"
    }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
    }
    return nil
}

/// Read a bool-valued attribute, defaulting to `def` when absent.
func axBool(_ element: AXUIElement, _ attr: String, _ def: Bool) -> Bool {
    guard let value = axCopy(element, attr) else { return def }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean))
    }
    if CFGetTypeID(value) == CFNumberGetTypeID() {
        return (value as! NSNumber).intValue != 0
    }
    return def
}

/// Read the element's screen position (top-left, global logical points).
func axPosition(_ element: AXUIElement) -> CGPoint? {
    guard let value = axCopy(element, kAXPositionAttribute as String) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue((value as! AXValue), .cgPoint, &point) {
        return point
    }
    return nil
}

/// Read the element's size.
func axSize(_ element: AXUIElement) -> CGSize? {
    guard let value = axCopy(element, kAXSizeAttribute as String) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    if AXValueGetValue((value as! AXValue), .cgSize, &size) {
        return size
    }
    return nil
}

/// Read children as an array of AXUIElement.
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = axCopy(element, kAXChildrenAttribute as String) else { return [] }
    guard CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
    return (value as! NSArray).compactMap { item -> AXUIElement? in
        let ref = item as CFTypeRef
        guard CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return (ref as! AXUIElement)
    }
}

// MARK: - Interactive role classification

/// Roles we expose to the model as actionable targets.
let interactiveRoles: Set<String> = [
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSecureTextField",
    "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuButton", "AXPopUpButton",
    "AXComboBox", "AXSlider", "AXTabGroup", "AXTab", "AXCell", "AXRow",
    "AXDisclosureTriangle", "AXSegmentedControl",
]

/// Roles whose value carries the meaningful label (static text fields).
let staticValueRoles: Set<String> = [
    "AXStaticText", "AXTextField", "AXTextArea", "AXSecureTextField",
    "AXComboBox", "AXValueIndicator", "AXSlider",
]

/// Known Chromium / Electron hosts whose native AX tree is sparse: prefer OCR.
let ocrFallbackBundles: Set<String> = [
    "com.google.Chrome", "com.microsoft.VSCode", "com.tinyspeck.slackmacgap",
    "com.github.Electron", "org.chromium.Chromium", "com.brave.Browser",
    "com.microsoft.edgemac",
]

// MARK: - Helper state (held across stdin lines)

var lastObsId: String?
var elementMap: [Int: AXUIElement] = [:]
var obsCounter = 0
/// When the dump is rooted at the whole app element (no window found), the AX
/// tree includes the system menu bar; skip recursing into it so the walk finds
/// the document window's controls instead of a wall of AXMenuItems.
var skipMenuBar = false

// MARK: - App resolution

/// Resolve the target app: by bundleId or localized name (case-insensitive
/// contains) if `app` is given, else the frontmost application.
func resolveApp(_ app: String?) -> NSRunningApplication? {
    guard let needleRaw = app, !needleRaw.isEmpty else {
        return NSWorkspace.shared.frontmostApplication
    }
    let needle = needleRaw.lowercased()
    let running = NSWorkspace.shared.runningApplications
    // Prefer an exact bundle-id match, then a name/bundle contains match.
    if let exact = running.first(where: { ($0.bundleIdentifier?.lowercased() ?? "") == needle }) {
        return exact
    }
    return running.first(where: {
        let bid = $0.bundleIdentifier?.lowercased() ?? ""
        let name = $0.localizedName?.lowercased() ?? ""
        return bid.contains(needle) || name.contains(needle)
    })
}

// MARK: - Tree walk

/// Recursively collect interactive elements starting from `root`. Appends
/// {index, role, label, value, x, y, w, h, enabled, focused} dictionaries to
/// `out` and records index -> AXUIElement in the module elementMap.
/// Depth-capped (~60) and total-capped (~400) to stay responsive.
func collect(_ root: AXUIElement, depth: Int, out: inout [[String: Any]]) {
    if depth > 60 { return }
    if out.count >= 400 { return }

    let role = axString(root, kAXRoleAttribute as String) ?? ""

    // When rooted at the whole app element, the system menu bar is in the tree;
    // skip it so we surface the document window's controls, not its menu items.
    if skipMenuBar && role == "AXMenuBar" { return }

    if interactiveRoles.contains(role) {
        let title = axString(root, kAXTitleAttribute as String)
        let desc = axString(root, kAXDescriptionAttribute as String)
        let help = axString(root, kAXHelpAttribute as String)
        let value = axString(root, kAXValueAttribute as String) ?? ""

        var label = title ?? desc ?? help ?? ""
        if label.isEmpty, staticValueRoles.contains(role) {
            label = value
        }

        let pos = axPosition(root) ?? CGPoint.zero
        let size = axSize(root) ?? CGSize.zero
        let enabled = axBool(root, kAXEnabledAttribute as String, true)
        let focused = axBool(root, kAXFocusedAttribute as String, false)

        // Skip non-actionable zero-size nodes (closed/offscreen menu items,
        // collapsed containers). Still recurse below in case children are real.
        if size.width > 0 || size.height > 0 {
            let index = out.count
            out.append([
                "index": index,
                "role": role,
                "label": label,
                "value": value,
                "x": pos.x,
                "y": pos.y,
                "w": size.width,
                "h": size.height,
                "enabled": enabled,
                "focused": focused,
            ])
            elementMap[index] = root
        }
    }

    for child in axChildren(root) {
        if out.count >= 400 { break }
        collect(child, depth: depth + 1, out: &out)
    }
}

// MARK: - dump

func handleDump(_ obj: [String: Any]) {
    if !axTrusted() {
        emit(["ok": false, "error": "ax-not-trusted"])
        return
    }

    guard let app = resolveApp(obj["app"] as? String) else {
        emit(["ok": false, "error": "app-not-found"])
        return
    }
    let pid = app.processIdentifier
    let name = app.localizedName ?? (app.bundleIdentifier ?? "unknown")
    let bundleId = app.bundleIdentifier ?? ""

    let axApp = AXUIElementCreateApplication(pid)

    // Best-effort: ask web/Electron content to expose its AX tree.
    AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

    // Mint a fresh observation; reset the cached element map.
    obsCounter += 1
    let obsId = "o_\(obsCounter)"
    elementMap = [:]

    // Prefer the focused window; fall back to the main window, then the first
    // window, then the whole app element.
    var root = axApp
    var topErr: AXError = .success
    var focusedRef: CFTypeRef?
    topErr = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedRef)
    if topErr == .success, let fr = focusedRef, CFGetTypeID(fr) == AXUIElementGetTypeID() {
        root = (fr as! AXUIElement)
    }
    if root == axApp {
        var mainRef: CFTypeRef?
        let mainErr = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainRef)
        if mainErr == .success, let mr = mainRef, CFGetTypeID(mr) == AXUIElementGetTypeID() {
            root = (mr as! AXUIElement)
        }
    }
    if root == axApp {
        var windowsRef: CFTypeRef?
        let winErr = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)
        if winErr == .success, let wr = windowsRef, CFGetTypeID(wr) == CFArrayGetTypeID() {
            let windows = (wr as! NSArray).compactMap { item -> AXUIElement? in
                let ref = item as CFTypeRef
                guard CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
                return (ref as! AXUIElement)
            }
            if let first = windows.first {
                root = first
            }
        }
    }

    // No window found: we walk the whole app element, which includes the system
    // menu bar. Tell collect to skip the menu bar so it finds real controls.
    let rootedAtApp = (root == axApp)
    skipMenuBar = rootedAtApp

    // If the top-level AX call cannot complete (common for unresponsive or
    // sandboxed content), signal the OCR fallback to the Rust host.
    if topErr == .cannotComplete {
        lastObsId = obsId
        emit(["ok": true, "fallback": "ocr", "app": name, "observationId": obsId, "elements": []])
        return
    }

    var elements: [[String: Any]] = []
    collect(root, depth: 0, out: &elements)
    skipMenuBar = false

    // Chromium/Electron host, or a suspiciously sparse tree, -> OCR fallback.
    if ocrFallbackBundles.contains(bundleId) || elements.count < 3 {
        lastObsId = obsId
        emit(["ok": true, "fallback": "ocr", "app": name, "observationId": obsId, "elements": []])
        return
    }

    lastObsId = obsId
    emit([
        "ok": true,
        "observationId": obsId,
        "app": name,
        "count": elements.count,
        "elements": elements,
    ])
}

// MARK: - Synthetic input (CGEvent)

/// Shared HID event source; HID system state is the most reliable for input
/// other apps will accept (matches text_input.rs on the Rust side).
let eventSource = CGEventSource(stateID: .hidSystemState)

/// Synthesize a left mouse down + up at a global point.
func synthClick(at point: CGPoint) {
    if let down = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown,
                          mouseCursorPosition: point, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp,
                        mouseCursorPosition: point, mouseButton: .left) {
        up.post(tap: .cghidEventTap)
    }
}

/// Move the mouse (no buttons) to a global point.
func synthMove(to point: CGPoint) {
    if let move = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
                          mouseCursorPosition: point, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
}

/// The center of an element's AX frame in global logical points.
func elementCenter(_ element: AXUIElement) -> CGPoint? {
    guard let pos = axPosition(element), let size = axSize(element) else { return nil }
    return CGPoint(x: pos.x + size.width / 2.0, y: pos.y + size.height / 2.0)
}

/// Type a string via unicode keyboard events (layout-independent), chunked to
/// stay under CGEventKeyboardSetUnicodeString's practical per-event limit.
func synthType(_ text: String) {
    let utf16 = Array(text.utf16)
    for chunk in stride(from: 0, to: utf16.count, by: 20).map({ Array(utf16[$0..<min($0 + 20, utf16.count)]) }) {
        if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true) {
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) {
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            up.post(tap: .cghidEventTap)
        }
    }
}

// MARK: - Keycode mapping (US QWERTY virtual key codes)

/// Map a single named key or character to a virtual keycode.
func keycodeFor(_ keyRaw: String) -> CGKeyCode? {
    let key = keyRaw.lowercased()
    let named: [String: CGKeyCode] = [
        "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "spacebar": 0x31,
        "delete": 0x33, "backspace": 0x33, "forwarddelete": 0x75,
        "esc": 0x35, "escape": 0x35,
        "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
        "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    ]
    if let code = named[key] { return code }
    // Single character: letters, digits.
    if key.count == 1, let c = key.first {
        let letters: [Character: CGKeyCode] = [
            "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
            "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
            "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
            "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26,
            "k": 0x28, "n": 0x2D, "m": 0x2E,
        ]
        if let code = letters[c] { return code }
        let digits: [Character: CGKeyCode] = [
            "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
            "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
        ]
        if let code = digits[c] { return code }
    }
    return nil
}

/// Parse a combo like "cmd+shift+s" into modifier flags + a keycode.
func parseKeyCombo(_ combo: String) -> (CGEventFlags, CGKeyCode)? {
    let parts = combo.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard !parts.isEmpty else { return nil }
    var flags: CGEventFlags = []
    var keyToken: String?
    for part in parts {
        switch part.lowercased() {
        case "cmd", "command", "meta", "super", "win":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option", "opt":
            flags.insert(.maskAlternate)
        case "ctrl", "control":
            flags.insert(.maskControl)
        case "fn", "function":
            flags.insert(.maskSecondaryFn)
        default:
            keyToken = part
        }
    }
    guard let token = keyToken, let code = keycodeFor(token) else { return nil }
    return (flags, code)
}

/// Post a key down + up for a keycode with modifier flags.
func synthKey(_ flags: CGEventFlags, _ code: CGKeyCode) {
    if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true) {
        down.flags = flags
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) {
        up.flags = flags
        up.post(tap: .cghidEventTap)
    }
}

// MARK: - act

/// Apply a single action. Returns a human summary on success, or throws via the
/// returned error string on failure.
func applyAction(_ action: [String: Any]) -> (ok: Bool, summary: String, error: String) {
    let op = (action["op"] as? String) ?? ""
    switch op {
    case "click":
        guard let index = action["index"] as? Int, let el = elementMap[index] else {
            return (false, "", "no-element-at-index")
        }
        let label = axString(el, kAXTitleAttribute as String)
            ?? axString(el, kAXDescriptionAttribute as String) ?? ""
        let pressErr = AXUIElementPerformAction(el, kAXPressAction as CFString)
        if pressErr == .success {
            return (true, "clicked [\(index)] \(label)", "")
        }
        // Fall back to a synthetic click at the element's center.
        guard let center = elementCenter(el) else {
            return (false, "", "no-frame-for-click")
        }
        synthClick(at: center)
        return (true, "clicked [\(index)] \(label)", "")

    case "type":
        guard let index = action["index"] as? Int, let el = elementMap[index] else {
            return (false, "", "no-element-at-index")
        }
        let text = (action["text"] as? String) ?? ""
        let setErr = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString)
        if setErr == .success {
            return (true, "typed into [\(index)]", "")
        }
        // Fall back: focus the element (set AXFocused, else AXPress) then type.
        let focusErr = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if focusErr != .success {
            _ = AXUIElementPerformAction(el, kAXPressAction as CFString)
        }
        synthType(text)
        return (true, "typed into [\(index)]", "")

    case "key":
        guard let keys = action["keys"] as? String, let (flags, code) = parseKeyCombo(keys) else {
            return (false, "", "bad-key-combo")
        }
        synthKey(flags, code)
        return (true, "pressed \(keys)", "")

    case "scroll":
        let dx = (action["dx"] as? Int) ?? Int((action["dx"] as? Double) ?? 0)
        let dy = (action["dy"] as? Int) ?? Int((action["dy"] as? Double) ?? 0)
        if let index = action["index"] as? Int, let el = elementMap[index],
           let center = elementCenter(el) {
            synthMove(to: center)
        }
        if let scroll = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel,
                                wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) {
            scroll.post(tap: .cghidEventTap)
        }
        return (true, "scrolled dx=\(dx) dy=\(dy)", "")

    case "move_click":
        let x = (action["x"] as? Double) ?? Double((action["x"] as? Int) ?? 0)
        let y = (action["y"] as? Double) ?? Double((action["y"] as? Int) ?? 0)
        // GLOBAL logical top-left points; CGEvent uses the same space -> no scaling.
        synthClick(at: CGPoint(x: x, y: y))
        return (true, "clicked at (\(Int(x)), \(Int(y)))", "")

    default:
        return (false, "", "unknown-action")
    }
}

func handleAct(_ obj: [String: Any]) {
    if !axTrusted() {
        emit(["ok": false, "error": "ax-not-trusted"])
        return
    }
    guard let obsId = obj["observationId"] as? String else {
        emit(["ok": false, "error": "missing-observation"])
        return
    }
    guard obsId == lastObsId else {
        emit(["ok": false, "error": "stale-observation"])
        return
    }
    guard let actions = obj["actions"] as? [[String: Any]] else {
        emit(["ok": false, "error": "missing-actions"])
        return
    }

    var summaries: [String] = []
    for action in actions {
        let r = applyAction(action)
        if !r.ok {
            emit(["ok": false, "error": r.error, "result": summaries.joined(separator: "; ")])
            return
        }
        summaries.append(r.summary)
        // A small settle delay so chained actions land in order.
        usleep(40_000)
    }
    emit(["ok": true, "result": summaries.joined(separator: "; ")])
}

// MARK: - Main loop

/// Read newline-delimited JSON requests from stdin until EOF.
func main() {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            emit(["ok": false, "error": "bad-json"])
            continue
        }
        let op = (obj["op"] as? String) ?? ""
        switch op {
        case "ping":
            emit(["ok": true])
        case "dump":
            handleDump(obj)
        case "act":
            handleAct(obj)
        default:
            emit(["ok": false, "error": "unknown-op"])
        }
    }
    exit(0)
}

main()
