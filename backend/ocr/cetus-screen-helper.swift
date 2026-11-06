// cetus screen-context helper.
//
// A tiny on-device companion compiled lazily by the Rust capture module with
// `swiftc` (see src/ocr.rs). It exposes three subcommands:
//
//   cetus-screen-helper frontapp        -> {"app":"Safari","bundleId":"com.apple.Safari"}
//   cetus-screen-helper ocr <imagePath> -> recognized text on stdout (lines joined by \n)
//   cetus-screen-helper context         -> {"app","bundleId","url","title","selection"}
//
// OCR uses Apple's Vision framework (VNRecognizeTextRequest) — the same
// on-device engine behind Live Text and Rewind. `context` reads the frontmost
// app, the active browser tab's URL/title (via AppleScript / Apple Events), and
// the focused element's selected text (via the Accessibility API). All
// on-device; nothing leaves the machine.

import Foundation
import AppKit
import Vision
import ImageIO
import ApplicationServices

func eprint(_ s: String) {
    if let data = (s + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// Minimal JSON string escaping (no Foundation JSONEncoder needed for two fields).
func jsonEscape(_ s: String) -> String {
    var out = ""
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

// Read a string Accessibility attribute off an element; nil if absent/denied.
func axString(_ element: AXUIElement, _ attr: String) -> String? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard err == .success else { return nil }
    return value as? String
}

// Selected text of the frontmost app's focused UI element. Empty when nothing
// is selected, the app exposes no AX text, or Accessibility isn't granted.
func focusedSelectedText(_ pid: pid_t) -> String {
    let appEl = AXUIElementCreateApplication(pid)
    var focused: AnyObject?
    guard
        AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
        let focused
    else { return "" }
    let el = focused as! AXUIElement
    return axString(el, kAXSelectedTextAttribute as String) ?? ""
}

// AppleScript that returns {url, title} for the active tab/document of a known
// browser, or nil for apps we don't script. Chromium family + WebKit Safari.
func browserScript(_ bundle: String) -> String? {
    let chromium: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta",
        "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
        "company.thebrowser.Browser", "com.thebrowser.Browser", // Arc
    ]
    if bundle == "com.apple.Safari" || bundle == "com.apple.SafariTechnologyPreview" {
        return """
        tell application id "\(bundle)"
            set u to URL of front document
            set t to name of front document
            return {u, t}
        end tell
        """
    }
    if chromium.contains(bundle) {
        return """
        tell application id "\(bundle)"
            set u to URL of active tab of front window
            set t to title of active tab of front window
            return {u, t}
        end tell
        """
    }
    return nil
}

// Run an AppleScript that returns a two-item list; (url, title) or nil on any
// error (no front window, automation permission denied, app not running).
func runBrowserScript(_ source: String) -> (String, String)? {
    guard let script = NSAppleScript(source: source) else { return nil }
    var err: NSDictionary?
    let out = script.executeAndReturnError(&err)
    if err != nil { return nil }
    if out.numberOfItems >= 2 {
        let u = out.atIndex(1)?.stringValue ?? ""
        let t = out.atIndex(2)?.stringValue ?? ""
        return (u, t)
    }
    if let s = out.stringValue { return (s, "") }
    return nil
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    eprint("usage: cetus-screen-helper <frontapp|ocr|context> [imagePath]")
    exit(2)
}

switch args[1] {
case "frontapp":
    let app = NSWorkspace.shared.frontmostApplication
    let name = app?.localizedName ?? ""
    let bundle = app?.bundleIdentifier ?? ""
    print("{\"app\":\"\(jsonEscape(name))\",\"bundleId\":\"\(jsonEscape(bundle))\"}")

case "ocr":
    guard args.count >= 3 else {
        eprint("ocr requires an image path")
        exit(2)
    }
    let url = URL(fileURLWithPath: args[2])
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        eprint("cannot load image at \(args[2])")
        exit(1)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Recognize both English and Simplified Chinese screen text.
    request.recognitionLanguages = ["en-US", "zh-Hans"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        eprint("vision failed: \(error)")
        exit(1)
    }

    let observations = request.results as? [VNRecognizedTextObservation] ?? []
    var lines: [String] = []
    for obs in observations {
        if let candidate = obs.topCandidates(1).first {
            lines.append(candidate.string)
        }
    }
    print(lines.joined(separator: "\n"))

case "context":
    let app = NSWorkspace.shared.frontmostApplication
    let name = app?.localizedName ?? ""
    let bundle = app?.bundleIdentifier ?? ""
    var url = ""
    var title = ""
    if let script = browserScript(bundle), let r = runBrowserScript(script) {
        url = r.0
        title = r.1
    }
    var selection = ""
    if let pid = app?.processIdentifier {
        selection = focusedSelectedText(pid)
    }
    print(
        "{\"app\":\"\(jsonEscape(name))\","
        + "\"bundleId\":\"\(jsonEscape(bundle))\","
        + "\"url\":\"\(jsonEscape(url))\","
        + "\"title\":\"\(jsonEscape(title))\","
        + "\"selection\":\"\(jsonEscape(selection))\"}"
    )

default:
    eprint("unknown subcommand: \(args[1])")
    exit(2)
}
