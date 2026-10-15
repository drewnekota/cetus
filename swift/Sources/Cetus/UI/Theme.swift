import AppKit
import CoreText
import SwiftUI

/// Cetus's design tokens (cetus-tokens.json) as appearance-aware colors.
enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light, alpha: alpha)
        })
    }

    /// A skin-derived token: the stock hex pair for the Cetus skin, else
    /// `derive(seeds, isDark)` from the active skin (Skin.swift).
    private static func token(_ light: UInt32, _ dark: UInt32, _ derive: @escaping (GSkinSeeds, Bool) -> NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if let s = Skin.seeds(dark: isDark) { return derive(s, isDark) }
            return NSColor(hex: isDark ? dark : light)
        })
    }
    /// `ink` mixed into `surface` at light% / dark% (times the skin's contrast).
    private static func neutral(_ light: UInt32, _ dark: UInt32, _ lp: Double, _ dp: Double) -> Color {
        token(light, dark) { s, d in Skin.neutral(s, d ? dp : lp) }
    }

    // Resolved from Cetus globals.css (default skin, contrast 50).
    static let background = token(0xFCFCFD, 0x0F0F11) { s, _ in Skin.color(s.surface) }
    static let card = token(0xFCFCFD, 0x1B1B1D) { s, d in d ? Skin.neutral(s, 7) : Skin.color(s.surface) }
    static let popover = card
    static let secondary = neutral(0xEFEFF0, 0x252528, 5, 13)
    static let muted = secondary
    static let mutedForeground = token(0x7D7D7E, 0x7C7D7F) { s, d in Skin.mutedText(s, base: d ? 56 : 52) }
    static let accent = neutral(0xEDEDEE, 0x272729, 6, 14)
    static let border = neutral(0xE5E5E6, 0x222224, 9, 11)
    static let input = neutral(0xDDDDDE, 0x2E2F31, 12, 18)
    static let sidebar = neutral(0xF7F7F8, 0x161618, 2, 4)
    static let sidebarAccent = neutral(0xEAEAEB, 0x2D2D2F, 7, 17)
    static let foreground = token(0x1B1B1B, 0xE3E4E6) { s, _ in Skin.color(s.ink) }
    static let primary = token(0x827BE6, 0x827BE6) { s, _ in Skin.color(s.accent) }
    static let primaryForeground = token(0xFCFCFD, 0xE3E4E6) { s, _ in Skin.onAccent(s) }
    /// primary/15 light, primary/20 dark, pre-composited on the background.
    static let userBubble = token(0xEAE9FA, 0x26253C) { s, d in Skin.over(Skin.color(s.accent), d ? 0.2 : 0.15, Skin.color(s.surface)) }
    static let codeBackground = secondary
    static let destructive = token(0xC94446, 0xFF7E78) { s, _ in Skin.color(s.diffRemoved) }
    static let success = token(0x52A450, 0x69C967) { s, _ in Skin.color(s.diffAdded) }
    static let warning = primary
    static let info = token(0x8160D8, 0xC2A1FF) { s, _ in Skin.color(s.skill) }
    static let added = success
    static let removed = destructive
    /// Ghost-button hover: muted in light, muted/50 in dark.
    static let ghostHover = token(0xEFEFF0, 0x1A1A1C) { s, d in
        d ? Skin.over(Skin.neutral(s, 13), 0.5, Skin.color(s.surface)) : Skin.neutral(s, 5)
    }
    /// ring-foreground/10 hairline around popovers.
    static let hairline = token(0xE6E6E6, 0x2F2F31) { s, d in
        Skin.over(Skin.color(s.ink), 0.1, d ? Skin.neutral(s, 7) : Skin.color(s.surface))
    }
    static let tooltip = foreground
    // Tailwind Typography gray palette used by the assistant's markdown.
    static let proseBody = dynamic(0x364153, 0xD1D5DC)
    static let proseHeading = dynamic(0x101828, 0xFFFFFF)
    static let proseCounter = dynamic(0x6A7282, 0x99A1AF)
    static let proseBullet = dynamic(0xD1D5DC, 0x4A5565)
    static let proseRule = dynamic(0xE5E7EB, 0x364153)
    static let proseQuote = dynamic(0x101828, 0xF3F4F6)
    static let proseThRule = dynamic(0xD1D5DC, 0x4A5565)
    static let amber = Color(nsColor: NSColor(hex: 0xFE9A00))
    static let sky = Color(nsColor: NSColor(hex: 0x00A6F4))
    // Legacy aliases.
    static let hover = ghostHover
    static let selected = sidebarAccent

    static func runtimeColor(_ id: String) -> Color {
        id == "dsh" ? foreground : id == "pi" ? primary : Color(nsColor: NSColor(hex: Runtimes.byId(id).color))
    }

    static let serifName = "OldStandardTT-Italic"
    static let serifBoldName = "OldStandardTT-Bold"

    static func registerFonts() {
        for f in ["OldStandardTT-Italic.ttf", "OldStandardTT-Bold.woff"] {
            if let url = resource(f) { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
    }

    /// A lucide icon (exported from the Cetus frontend) as a template image.
    static func lucide(_ name: String) -> NSImage? {
        let key = "lucide/" + name
        if let img = svgCache[key] { return img }
        guard let url = resourceBundle.url(forResource: "Resources/lucide/\(name)", withExtension: "svg"),
              let img = NSImage(contentsOf: url) else { return nil }
        img.isTemplate = true
        svgCache[key] = img
        return img
    }

    /// SwiftPM resources: inside Cetus.app they live in Contents/Resources, where Bundle.module doesn't look.
    private static let resourceBundle: Bundle = {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("Cetus_Cetus.bundle"), let b = Bundle(url: url) { return b }
        return Bundle.module
    }()

    static func resource(_ name: String) -> URL? {
        let parts = name.split(separator: ".")
        return resourceBundle.url(forResource: "Resources/\(parts[0])", withExtension: parts.count > 1 ? String(parts[1]) : nil)
    }

    nonisolated(unsafe) private static var svgCache: [String: NSImage] = [:]

    /// A runtime's brand mark, as a template image tinted by the caller.
    /// Full-color brand mark (public/brands/<id>.svg in the web build).
    /// WebKit-rendered @2x raster of a brand icon at an exact point size (12/14/16),
    /// so it matches the Tauri build pixel for pixel; nil for other sizes.
    static func runtimeRaster(_ id: String, size: CGFloat) -> NSImage? {
        let file = id != "pi" && Runtimes.all.contains { $0.id == id } ? id : "cetus"
        let key = "raster:\(file)-\(Int(size))"
        if let img = svgCache[key] { return img }
        guard [12, 14, 16].contains(size), let url = resource("brands/\(file)-\(Int(size))@2x.png"), let img = NSImage(contentsOf: url) else { return nil }
        img.size = NSSize(width: size, height: size)
        svgCache[key] = img
        return img
    }

    static func runtimeImage(_ id: String) -> NSImage? {
        let file = id != "pi" && Runtimes.all.contains { $0.id == id } ? id : "cetus"
        if let img = svgCache["brand:" + file] { return img }
        guard let url = resource("brands/\(file).svg"), var svg = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        svg = svg.replacingOccurrences(of: "\"1em\"", with: "\"24\"")
        guard let img = NSImage(data: Data(svg.utf8)) else { return nil }
        svgCache["brand:" + file] = img
        return img
    }
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// Font scale from prefs.fontSize (14 = 1.0), applied by `.cetusFont`.
struct FontScaleKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }
extension EnvironmentValues {
    var fontScale: CGFloat {
        get { self[FontScaleKey.self] }
        set { self[FontScaleKey.self] = newValue }
    }
}

/// Line-height multiplier from prefs.lineScale (Settings → Appearance → Line height).
struct LineScaleKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }
extension EnvironmentValues {
    var lineScale: CGFloat {
        get { self[LineScaleKey.self] }
        set { self[LineScaleKey.self] = newValue }
    }
}

struct CetusFont: ViewModifier {
    @Environment(\.fontScale) private var scale
    let size: CGFloat
    let weight: Font.Weight
    let design: Font.Design
    func body(content: Content) -> some View {
        content.font(.system(size: (size * scale).rounded(), weight: weight, design: design))
    }
}

extension View {
    func cetusFont(_ size: CGFloat, _ weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(CetusFont(size: size, weight: weight, design: design))
    }

    func mono(_ size: CGFloat = 12, _ weight: Font.Weight = .regular) -> some View {
        modifier(CetusFont(size: size, weight: weight, design: .monospaced))
    }

    @ViewBuilder
    func `if`<V: View>(_ condition: Bool, transform: (Self) -> V) -> some View {
        if condition { transform(self) } else { self }
    }
}

/// An icon at a fixed point size: a lucide name (as in Cetus) or an SF Symbol fallback.
struct Glyph: View {
    let name: String
    var size: CGFloat = 13
    var color: Color = Theme.mutedForeground
    var weight: Font.Weight = .regular
    var body: some View {
        if let img = Theme.lucide(name) {
            Image(nsImage: img)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .foregroundStyle(color)
        } else {
            Image(systemName: name)
                .font(.system(size: size * 0.86, weight: weight))
                .foregroundStyle(color)
                .frame(width: size, height: size)
        }
    }
}

struct RuntimeIcon: View {
    let id: String
    var size: CGFloat = 12
    var tinted = true
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if let img = Theme.runtimeRaster(id, size: size) ?? Theme.runtimeImage(id) {
            Image(nsImage: img)
                .renderingMode(tinted ? .original : .template)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .foregroundStyle(Theme.mutedForeground)
                .colorInvert(id == "dsh" && scheme == .dark) // dark:invert
        }
    }
}

/// A small muted key hint like "⌘N".
struct Hint: View {
    let text: String
    var body: some View {
        if !text.isEmpty {
            Text(text)
                .cetusFont(11)
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted.opacity(0.7)))
        }
    }
}

/// Borderless icon button with a hover fill and a tooltip that carries the shortcut.
struct IconButton: View {
    let icon: String
    var help: String = ""
    var shortcut: String = ""
    var size: CGFloat = 14
    var active = false
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Glyph(name: icon, size: size, color: active ? Theme.foreground : Theme.mutedForeground)
                .frame(width: size + 14, height: size + 14)
                .background(RoundedRectangle(cornerRadius: 7).fill(active ? Theme.selected : hover ? Theme.hover : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(shortcut.isEmpty ? help : "\(help)  \(shortcut)")
        .testID(testID)
    }
}

/// Plain row-style button with hover background.
struct HoverButtonStyle: ButtonStyle {
    var radius: CGFloat = 8
    var padding: EdgeInsets = EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8)
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        HoverBody(configuration: configuration, radius: radius, padding: padding, selected: selected)
    }

    private struct HoverBody: View {
        let configuration: Configuration
        let radius: CGFloat
        let padding: EdgeInsets
        let selected: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .padding(padding)
                .background(RoundedRectangle(cornerRadius: radius).fill(selected ? Theme.selected : (hover || configuration.isPressed) ? Theme.hover : .clear))
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

struct PillButtonStyle: ButtonStyle {
    var prominent = false
    var destructive = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .cetusFont(12, .medium)
            .padding(.horizontal, 10)
            .frame(height: 26)
            .foregroundStyle(prominent ? Color.white : destructive ? Theme.destructive : Theme.foreground)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(prominent ? Theme.primary.opacity(configuration.isPressed ? 0.8 : 1) : Theme.secondary.opacity(configuration.isPressed ? 0.7 : 1))
            )
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(prominent ? .clear : Theme.border, lineWidth: 1))
            .contentShape(Rectangle())
    }
}

// MARK: - Formatting and system helpers

enum Fmt {
    /// Cetus formatRelativeTime: now, 5m, 3h, 2d, 1w, 4mo, 1y.
    static func relative(_ ms: Double, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince1970 - ms / 1000)
        if s < 45 { return "now" }
        let m = s / 60, h = m / 60, d = h / 24
        if m < 60 { return "\(max(1, Int(m.rounded())))m" }
        if h < 24 { return "\(Int(h))h" }
        if d < 7 { return "\(Int(d))d" }
        if d < 35 { return "\(Int(d / 7))w" }
        if d < 365 { return "\(max(1, Int(d / 30)))mo" }
        return "\(Int(d / 365))y"
    }

    static func duration(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(max(1, s))s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    /// Activity durations: <1s omitted, "12s", "1m 4s", "2m".
    static func stepDuration(_ ms: Double) -> String? {
        let s = Int(ms / 1000)
        if s < 1 { return nil }
        if s < 60 { return "\(s)s" }
        return s % 60 == 0 ? "\(s / 60)m" : "\(s / 60)m \(s % 60)s"
    }

    /// "14:05".
    static func time(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func clock(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        return (Calendar.current.isDateInToday(date) ? clockToday : clockOther).string(from: date)
    }
    private static let clockToday: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f }()
    private static let clockOther: DateFormatter = { let f = DateFormatter(); f.dateFormat = "MMM d, HH:mm"; return f }()

    /// 84123 → "84K".
    static func tokens(_ n: Double) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", n / 1_000_000) : n >= 1000 ? "\(Int((n / 1000).rounded()))K" : "\(Int(n))"
    }

    /// "Oct 14, 2026, 09:41".
    /// formatDateTimeMinute: "May 29, 2026 at 10:11 AM".
    static func created(_ ms: Double) -> String { createdFormatter.string(from: Date(timeIntervalSince1970: ms / 1000)) }
    private static let createdFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    static func bytes(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1024 / 1024)
    }
}

enum System {
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    static func open(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    static func openURL(_ s: String) {
        if let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }

    /// Run a command and return stdout (blocking; for quick git/ps calls off the main thread).
    static func run(_ args: [String], cwd: String? = nil) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.environment = Env.shell
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}

extension View {
    @ViewBuilder func colorInvert(_ on: Bool) -> some View { if on { colorInvert() } else { self } }
}
