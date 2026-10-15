import AppKit
import SQLite3
import SwiftUI

// Settings → Intelligence (API Keys, Models, Memory, Skills, Slash commands,
// MCP, Plugins). These sections read and write the same on-disk sources as the
// Tauri build (its app data dir: memory.json, custom-models.json, the
// `app_settings` table of pi-desktop.db, plugin folders), so both apps show the
// same data. Shared plumbing and shadcn-style building blocks live here.

// MARK: - Data sources

/// The Tauri app's data dir (`CETUS_APP_DATA` overrides, same as cetus-agentd).
enum IntelData {
    static var appData: URL {
        if let p = Env.process["CETUS_APP_DATA"], !p.isEmpty { return URL(fileURLWithPath: p) }
        return URL(fileURLWithPath: Env.home).appendingPathComponent("Library/Application Support/dev.cetus.app")
    }

    /// Tauri dev builds keep provider keys in a plaintext blob under the stock
    /// identifier (never the keychain); release builds use the keychain, which
    /// we deliberately don't touch.
    static var secretsPath: URL {
        if let p = Env.process["CETUS_SECRETS_PATH"], !p.isEmpty { return URL(fileURLWithPath: p) }
        return URL(fileURLWithPath: Env.home).appendingPathComponent("Library/Application Support/dev.cetus.app/dev-secrets.json")
    }

    static func file(_ name: String) -> URL { appData.appendingPathComponent(name) }

    // JSON files

    static func readJSON(_ url: URL) -> Any? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: d)
    }

    static func writeJSON(_ url: URL, _ obj: Any) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: url, options: .atomic)
    }

    // app_settings (pi-desktop.db)

    private static func withDB<T>(_ body: (OpaquePointer) -> T?) -> T? {
        let path = file("pi-desktop.db").path
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db else { sqlite3_close(db); return nil }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 2000)
        return body(db)
    }

    static func setting(_ key: String) -> String? {
        withDB { db in
            var st: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT value FROM app_settings WHERE key = ?1", -1, &st, nil) == SQLITE_OK else { return nil }
            defer { sqlite3_finalize(st) }
            sqlite3_bind_text(st, 1, key, -1, intelTransient)
            guard sqlite3_step(st) == SQLITE_ROW, let c = sqlite3_column_text(st, 0) else { return nil }
            return String(cString: c)
        }
    }

    static func settingJSON(_ key: String) -> [String: Any]? {
        guard let s = setting(key), let d = s.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    static func setSetting(_ key: String, _ value: String) {
        _ = withDB { db -> Bool in
            var st: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", -1, &st, nil) == SQLITE_OK else { return false }
            defer { sqlite3_finalize(st) }
            sqlite3_bind_text(st, 1, key, -1, intelTransient)
            sqlite3_bind_text(st, 2, value, -1, intelTransient)
            return sqlite3_step(st) == SQLITE_DONE
        }
    }

    static func setSettingJSON(_ key: String, _ obj: Any) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        setSetting(key, s)
    }

    /// Non-archived conversations' workspace dirs, newest first (max 50).
    static func conversationWorkspaces() -> [String] {
        withDB { db -> [String] in
            var st: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT workspace_dir FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 50", -1, &st, nil) == SQLITE_OK else { return [] }
            defer { sqlite3_finalize(st) }
            var out: [String] = []
            while sqlite3_step(st) == SQLITE_ROW { if let c = sqlite3_column_text(st, 0) { out.append(String(cString: c)) } }
            return out
        } ?? []
    }

    // Secrets (masked only — raw values never reach the UI except on Copy)

    static func secrets() -> [String: String] {
        (readJSON(secretsPath) as? [String: String]) ?? [:]
    }

    static func writeSecrets(_ m: [String: String]) {
        if m.isEmpty { try? FileManager.default.removeItem(at: secretsPath) } else { writeJSON(secretsPath, m) }
    }

    /// secrets::mask — first and last four chars around eight bullets; short keys fully masked.
    static func mask(_ s: String) -> String {
        let n = s.count
        if n <= 10 { return String(repeating: "•", count: max(n, 8)) }
        return String(s.prefix(4)) + String(repeating: "•", count: 8) + String(s.suffix(4))
    }

    static func uuid() -> String { UUID().uuidString.lowercased() }
    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// `new Date(ms).toLocaleDateString()` in en-US: 6/2/2026.
    static func localeDate(_ ms: Double) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "M/d/yyyy"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func pickFolder() -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}

private let intelTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Colors not in Theme

enum IntelColor {
    static func dyn(_ light: NSColor, _ dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { a in a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }
    static func hex(_ h: UInt32, _ a: CGFloat = 1) -> NSColor { NSColor(hex: h, alpha: a) }

    /// Outline button: border-border bg-background / dark:border-input dark:bg-input/30.
    static let outlineBorder = dyn(hex(0xE5E5E6), hex(0x2E2F31))
    static let outlineFill = dyn(hex(0xFCFCFD), hex(0x2E2F31, 0.3))
    static let outlineHover = dyn(hex(0xEFEFF0), hex(0x2E2F31, 0.5))
    /// Input: bg-transparent / dark:bg-input/30.
    static let inputFill = dyn(.clear, hex(0x2E2F31, 0.3))
    /// Ghost hover: muted / dark:muted/50.
    static let ghostHover = dyn(hex(0xEFEFF0), hex(0x252528, 0.5))
    /// Destructive button: destructive/10 / dark:destructive/20.
    static let destructiveFill = dyn(hex(0xC94446, 0.1), hex(0xFF7E78, 0.2))
    static let destructiveHover = dyn(hex(0xC94446, 0.2), hex(0xFF7E78, 0.3))
    /// Switch track off: input / dark:input/80; thumb: background|foreground (dark, off), primary-foreground (dark, on).
    static let switchOff = dyn(hex(0xDDDDDE), hex(0x2E2F31, 0.8))
    static let thumbOff = dyn(hex(0xFCFCFD), hex(0xE3E4E6))
    static let thumbOn = dyn(hex(0xFCFCFD), hex(0xE3E4E6))
    static let skill = Theme.info
}

// MARK: - Text with CSS line boxes

extension View {
    /// Font + CSS line-height for (possibly multi-line) text: each line box is
    /// `lh` tall with the glyphs centered, like WebKit lays out text.
    func intelText(_ size: CGFloat, _ lh: CGFloat, _ weight: Font.Weight = .regular, mono: Bool = false) -> some View {
        let f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular) : NSFont.systemFont(ofSize: size)
        let extra = max(0, lh - NSLayoutManager().defaultLineHeight(for: f))
        return self
            .font(.system(size: size, weight: weight, design: mono ? .monospaced : .default))
            // Wrapped lines come out a little taller than the first in SwiftUI.
            .lineSpacing(max(0, extra - (size == 14 ? 0.05 : size == 12 ? 0.3 : 0.4)))
            .padding(.vertical, extra / 2)
    }
}

/// Text that stays on one line, truncating, in a `lh`-tall box.
struct IntelLine: View {
    let text: String
    var size: CGFloat = 14
    var lh: CGFloat = 20.02
    var weight: Font.Weight = .regular
    var mono = false
    var color: Color = Theme.foreground
    var body: some View {
        Text(text)
            .font(.system(size: size, weight: weight, design: mono ? .monospaced : .default))
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(height: lh)
            .offset(y: size == 18 ? 0.5 : 0)
    }
}

/// Wrapping paragraph with CSS line boxes.
struct IntelPara: View {
    let text: String
    var size: CGFloat = 12
    var lh: CGFloat = 16.2
    var weight: Font.Weight = .regular
    var mono = false
    var color: Color = Theme.mutedForeground
    var lineLimit: Int? = nil
    var body: some View {
        Text(text)
            .intelText(size, lh, weight, mono: mono)
            .foregroundStyle(color)
            .lineLimit(lineLimit)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Building blocks

/// `SectionHeading`: h2 18/27 semibold + 14/20 muted description, 4px apart.
struct IntelHeading: View {
    let title: String
    let description: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            IntelLine(text: title, size: 18, lh: 27, weight: .semibold)
            IntelPara(text: description, size: 14, lh: 20.02).testID("intel-heading-desc")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// shadcn Button (size sm by default: h32 px10 14/500, radius 8).
struct IntelButtonStyle: ButtonStyle {
    enum Variant { case primary, outline, ghost, destructive }
    var variant: Variant = .outline
    var height: CGFloat = 32
    var horizontal: CGFloat = 10
    var fontSize: CGFloat = 14
    var muted = false
    var destructiveText = false
    func makeBody(configuration: Configuration) -> some View { StyledBody(configuration: configuration, style: self) }

    private struct StyledBody: View {
        let configuration: Configuration
        let style: IntelButtonStyle
        @Environment(\.isEnabled) private var enabled
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: style.fontSize, weight: .medium))
                .foregroundStyle(fg)
                .padding(.horizontal, style.horizontal + 1)
                .frame(height: style.height)
                .background(RoundedRectangle(cornerRadius: 7).fill(bg).padding(1))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style.variant == .outline ? IntelColor.outlineBorder : .clear, lineWidth: 1))
                .shadow(color: style.variant == .outline ? .black.opacity(0.05) : .clear, radius: 1, y: 1)
                .compositingGroup()
                .opacity(enabled ? 1 : 0.5)
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
        private var fg: Color {
            if style.destructiveText || style.variant == .destructive { return Theme.destructive }
            switch style.variant {
            case .primary: return Theme.primaryForeground
            case .ghost: return style.muted && !hover ? Theme.mutedForeground : Theme.foreground
            default: return Theme.foreground
            }
        }
        private var bg: Color {
            switch style.variant {
            case .primary: Theme.primary.opacity(hover ? 0.8 : 1)
            case .outline: hover ? IntelColor.outlineHover : IntelColor.outlineFill
            case .ghost: hover ? IntelColor.ghostHover : .clear
            case .destructive: hover ? IntelColor.destructiveHover : IntelColor.destructiveFill
            }
        }
    }
}

/// Button content: optional 14px lucide icon + label, `gap` apart.
struct IntelLabel: View {
    var icon: String? = nil
    let text: String
    var gap: CGFloat = 6
    var iconColor: Color? = nil
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        HStack(spacing: gap) {
            if let icon { IntelIcon(name: icon, size: 14, color: iconColor) }
            Text(text)
        }
    }
}

/// Lucide glyph that inherits the foreground style unless a color is given.
struct IntelIcon: View {
    let name: String
    var size: CGFloat = 14
    var color: Color? = nil
    var body: some View {
        if let img = Theme.lucide(name) {
            let base = Image(nsImage: img).renderingMode(.template).resizable().interpolation(.high).frame(width: size, height: size)
            if let color { base.foregroundStyle(color) } else { base }
        }
    }
}

/// `Button size=icon variant=ghost className="size-8 text-muted-foreground [hover:text-destructive]"`.
struct IntelIconButton: View {
    let icon: String
    var glyph: CGFloat = 14
    var box: CGFloat = 32
    var destructiveHover = false
    var rotate: Double = 0
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            IntelIcon(name: icon, size: glyph, color: hover ? (destructiveHover ? Theme.destructive : Theme.foreground) : Theme.mutedForeground)
                .rotationEffect(.degrees(rotate))
                .frame(width: box, height: box)
                .background(RoundedRectangle(cornerRadius: 7).fill(hover ? IntelColor.ghostHover : .clear).padding(1))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .onHover { hover = $0 }
        .testID(testID)
    }
}

/// shadcn Switch (32×18.4, dark-mode thumb colors).
struct IntelSwitch: View {
    let isOn: Bool
    var disabled = false
    var testID: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { set(!isOn) } } label: {
            Capsule()
                .fill(isOn ? Theme.primary : IntelColor.switchOff)
                .frame(width: 32, height: 18.4)
                .overlay(alignment: .leading) {
                    Circle().fill(isOn ? IntelColor.thumbOn : IntelColor.thumbOff).frame(width: 16, height: 16)
                        .offset(x: isOn ? 15 : 1)
                }
                .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
                .compositingGroup()
                .opacity(disabled ? 0.5 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .testID(testID)
    }
}

/// `ToggleRow`: py-12, label 14/500 leading-none + 2px + 12/16.2 muted description; switch on the right.
struct IntelToggleRow: View {
    let label: String
    let description: String
    let isOn: Bool
    var disabled = false
    var testID: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                IntelLine(text: label, size: 14, lh: 14, weight: .medium)
                IntelPara(text: description).testID("intel-toggle-desc")
            }
            .opacity(disabled ? 0.5 : 1)
            IntelSwitch(isOn: isOn, disabled: disabled, testID: testID, set: set)
        }
        .padding(.vertical, 12)
    }
}

/// `SettingsList`: rounded-lg bordered card with dividers.
struct IntelList<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group(subviews: content) { subs in
                ForEach(Array(subs.enumerated()), id: \.offset) { i, v in
                    if i > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
                    v
                }
            }
        }
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }
}

/// Small rounded tag: `rounded px-1.5 py-0.5 text-xs`.
struct IntelTag: View {
    let text: String
    var fill: Color = Theme.muted
    var color: Color = Theme.mutedForeground
    var weight: Font.Weight = .medium
    var body: some View {
        Text(text).font(.system(size: 12, weight: weight)).foregroundStyle(color)
            .frame(height: 16.2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 6).fill(fill))
    }
}

/// shadcn Input: h36, radius 8, 1px input border, px-10, 14px text.
struct IntelInput: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var secure = false
    var fontSize: CGFloat = 14
    var height: CGFloat = 36
    var horizontal: CGFloat = 10
    var readOnly = false
    var borderless = false
    var autofocus = false
    var testID: String? = nil
    var onSubmit: () -> Void = {}
    var onEscape: (() -> Void)? = nil
    @FocusState private var focused: Bool
    var body: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(placeholder).font(font).foregroundStyle(Theme.mutedForeground).lineLimit(1)
            }
            Group {
                if readOnly {
                    Text(text).font(font).foregroundStyle(Theme.foreground).lineLimit(1).textSelection(.enabled)
                } else if secure {
                    SecureField("", text: $text).focused($focused)
                } else {
                    TextField("", text: $text).focused($focused)
                }
            }
            .textFieldStyle(.plain)
            .font(font)
            .foregroundStyle(Theme.foreground)
            .onSubmit(onSubmit)
            .onKeyPress(.escape) {
                guard let onEscape else { return .ignored }
                onEscape()
                return .handled
            }
        }
        .padding(.horizontal, horizontal + (borderless ? 0 : 1))
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 8).fill(borderless ? .clear : IntelColor.inputFill))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(borderless ? .clear : (focused ? Theme.primary : Theme.input), lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(focused && !borderless ? Theme.primary.opacity(0.5) : .clear, lineWidth: 3).padding(-3))
        .shadow(color: borderless ? .clear : .black.opacity(0.05), radius: 1, y: 1)
        .onAppear { if autofocus { DispatchQueue.main.async { focused = true } } }
        .testID(testID)
    }
    private var font: Font { .system(size: fontSize, design: mono ? .monospaced : .default) }
}

/// shadcn Textarea: min-h 64, px-10 py-8, 14px, grows with content (field-sizing-content).
struct IntelTextArea: View {
    let placeholder: String
    @Binding var text: String
    var rows: Int = 2
    var mono = false
    var fontSize: CGFloat = 14
    var autofocus = false
    var onCommand: () -> Void = {}
    var onEscape: (() -> Void)? = nil
    @FocusState private var focused: Bool
    var body: some View {
        let lh: CGFloat = fontSize == 12 ? 16.2 : 20.02
        ZStack(alignment: .topLeading) {
            TextField("", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .intelText(fontSize, lh, mono: mono)
                .foregroundStyle(Theme.foreground)
                .focused($focused)
                .padding(.horizontal, 11).padding(.vertical, 9)
                .onKeyPress(keys: [.return]) { press in
                    if press.modifiers.contains(.command) || press.modifiers.contains(.control) { onCommand(); return .handled }
                    return .ignored
                }
                .onKeyPress(.escape) {
                    guard let onEscape else { return .ignored }
                    onEscape()
                    return .handled
                }
        }
        // field-sizing-content: `rows` is ignored; min-h-16, then grows with content.
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
        // The placeholder doesn't size the field (it may overflow, as in WebKit).
        .overlay(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).intelText(fontSize, lh, mono: mono).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 11).padding(.vertical, 9)
                    .allowsHitTesting(false)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .bottomTrailing) { IntelResizeGrip() }
        .background(RoundedRectangle(cornerRadius: 8).fill(IntelColor.inputFill))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.primary : Theme.input, lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.primary.opacity(0.5) : .clear, lineWidth: 3).padding(-3))
        .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .onAppear { if autofocus { DispatchQueue.main.async { focused = true } } }
    }
}

/// `text-xs text-destructive` error line.
struct IntelError: View {
    let text: String?
    var top: CGFloat = 16
    var body: some View {
        if let text, !text.isEmpty {
            IntelPara(text: text, color: Theme.destructive).padding(.top, top)
        }
    }
}

/// `h3 text-xs font-medium text-muted-foreground` list caption.
struct IntelCaption: View {
    let text: String
    var body: some View { IntelLine(text: text, size: 12, lh: 16.2, weight: .medium, color: Theme.mutedForeground) }
}

/// Count label: "1 memory" / "4 memories".
func intelCount(_ n: Int, _ one: String, _ other: String) -> String { "\(n) \(n == 1 ? one : other)" }

/// WebKit's textarea resize grip (two diagonal hairlines in the corner).
struct IntelResizeGrip: View {
    var body: some View {
        Path { p in
            p.move(to: CGPoint(x: 8.5, y: 1.9)); p.addLine(to: CGPoint(x: 1, y: 9.4))
            p.move(to: CGPoint(x: 9, y: 4.9)); p.addLine(to: CGPoint(x: 5, y: 9.4))
        }
        .stroke(IntelColor.dyn(NSColor(white: 0.45, alpha: 1), NSColor(hex: 0x989899)), lineWidth: 1.1)
        .frame(width: 10, height: 10)
        .padding(.trailing, 5.5).padding(.bottom, 5.1)
        .allowsHitTesting(false)
    }
}
