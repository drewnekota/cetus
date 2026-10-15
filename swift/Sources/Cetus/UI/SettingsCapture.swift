import AppKit
import AVFoundation
import Speech
import SwiftUI

// Building blocks for the "Input & Capture" and "Data" settings sections
// (settings-controls.tsx, hotkey-recorder.tsx and the shadcn primitives they
// use), plus the locally persisted settings those sections edit.

// MARK: - Persisted settings

/// A Codable settings struct stored as one JSON string in UserDefaults
/// (`@AppStorage("settings.…")`). Missing keys fall back to the defaults, like
/// the serde defaults on the Cetus side.
struct CapStored<T: Codable & CapDefaults>: RawRepresentable {
    var value: T
    init(_ value: T = T()) { self.value = value }
    init?(rawValue: String) {
        let defaults = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(T()))) as? [String: Any] ?? [:]
        let stored = rawValue.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let merged = defaults.merging(stored) { _, s in s }
        guard let data = try? JSONSerialization.data(withJSONObject: merged), let v = try? JSONDecoder().decode(T.self, from: data) else {
            value = T()
            return
        }
        value = v
    }
    var rawValue: String { (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}" }
}

protocol CapDefaults { init() }

/// `QuickSettings` (launcher + voice), DEFAULT_QUICK_SETTINGS.
struct CapQuickSettings: Codable, CapDefaults {
    var enabled = true
    var gesturePlain = "both_cmd"
    var gestureShot = "off"
    var gestureReply = "double_opt"
    var replyBackend = "pi"
    var summonHotkey = ""
    var sessionMode = "new"
    var voiceEnabled = false
    var voiceGesture = "right_option"
    var voiceHandsfreeShortcut = false
    var voiceAsrEngine = "doubao"
    var voiceContextBiasing = true
    var voiceHotwords = ""
    var voiceStartSound = true
}

/// Dictation history (`TranscriptState`).
struct CapTranscripts: Codable, CapDefaults {
    var enabled = false
    var entries: [String] = []
}

/// `CaptureSettings` (capture.rs defaults).
struct CapCaptureSettings: Codable, CapDefaults {
    var enabled = false
    var intervalSeconds = 30
    var excludedApps: [String] = []
    var retentionDays = 7
    var frameRetentionDays = 3
    var ocrEnabled = true
}

/// `AmbientSettings` (ambient.rs defaults).
struct CapAmbientSettings: Codable, CapDefaults {
    var enabled = false
    var intervalSeconds = 2
    var excludedApps: [String] = []
    var retentionDays = 3
}

/// `MeetingSettings` (meeting.rs defaults).
struct CapMeetingSettings: Codable, CapDefaults {
    var enabled = false
    var autoDetect = true
    var systemAudio = true
    var summarize = true
    var saveAudio = true
    var asrEngine = "auto"
    var retentionDays = 90
    var toggleHotkey = "Cmd+Shift+M"
}

/// `AutoArchiveSettings` (auto_archive.rs defaults).
struct CapAutoArchiveSettings: Codable, CapDefaults {
    var enabled = false
    var value = 30
    var unit = "days"
    var deleteEnabled = false
    var deleteValue = 7
    var deleteUnit = "days"

    static func ms(_ value: Int, _ unit: String) -> Double { Double(max(1, value)) * (unit == "hours" ? 3_600_000 : 86_400_000) }
    static var current: CapAutoArchiveSettings {
        CapStored<CapAutoArchiveSettings>(rawValue: UserDefaults.standard.string(forKey: "settings.autoArchive") ?? "{}")?.value ?? .init()
    }
}

/// The auto-archive / auto-delete sweep of auto_archive.rs: every 5 minutes
/// (after a 60s grace), and immediately whenever the settings change.
enum CaptureArchiveSweeper {
    nonisolated(unsafe) private static var timer: Timer?
    nonisolated(unsafe) private static weak var app: AppState?

    /// Idempotent. Call once at launch (and from the Archived chats section).
    static func start(_ app: AppState) {
        self.app = app
        guard timer == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { sweep() }
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in sweep() }
    }

    static func sweep() {
        guard let app else { return }
        let s = CapAutoArchiveSettings.current
        let c = app.controller
        let now = nowMs()
        if s.enabled {
            let cutoff = now - CapAutoArchiveSettings.ms(s.value, s.unit)
            for conv in c.conversations where conv.updatedAt < cutoff {
                if conv.id == app.active || conv.sourceAutomationId != nil || conv.unread { continue }
                if conv.runState == .running || c.chatIfLoaded(conv.id)?.isStreaming == true { continue }
                c.archive(conv.id)
            }
        }
        if s.deleteEnabled {
            let cutoff = now - CapAutoArchiveSettings.ms(s.deleteValue, s.deleteUnit)
            for conv in c.archived where (conv.archivedAt ?? now) < cutoff { c.delete(conv.id) }
        }
    }
}

// MARK: - OS permissions

enum CapPermissions {
    static var accessibility: Bool { AXIsProcessTrusted() }
    static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
    static var microphone: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
    static var speech: Bool { SFSpeechRecognizer.authorizationStatus() == .authorized }

    static func requestAccessibility() -> Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    /// Asking without a usage string would crash an unbundled build, so fall
    /// back to System Settings there.
    static func requestVoice(_ done: @escaping () -> Void) {
        let info = Bundle.main.infoDictionary ?? [:]
        guard info["NSMicrophoneUsageDescription"] != nil, info["NSSpeechRecognitionUsageDescription"] != nil else {
            openPane("Privacy_Microphone")
            done()
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async(execute: done) }
        }
    }

    static func openPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") { NSWorkspace.shared.open(url) }
    }
}

// MARK: - Text

/// Multi-line text with a CSS line-height: the extra leading is split above
/// and below each line, as WebKit lays it out. Drawn by AppKit so the line
/// breaking is greedy like the web (SwiftUI's Text avoids one-word last
/// lines, which moves words between lines).
struct CapText: View {
    let text: String
    var size: CGFloat = 12
    var weight: Font.Weight = .regular
    var color: Color = Theme.mutedForeground
    var lineHeight: CGFloat = 16.2

    var body: some View {
        CapWrapText(text: text, font: NSFont.systemFont(ofSize: size, weight: CapText.nsWeight(weight)), color: NSColor(color), lineHeight: lineHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func nsWeight(_ w: Font.Weight) -> NSFont.Weight {
        switch w {
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        default: .regular
        }
    }

    static func natural(_ size: CGFloat, _ weight: Font.Weight) -> CGFloat {
        let f = NSFont.systemFont(ofSize: size)
        return ceil(f.ascender - f.descender + f.leading)
    }
}

final class CapTextNSView: NSView {
    var attributed = NSAttributedString()
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        // A touch taller than the bounds: pixel rounding must not drop the last line.
        attributed.draw(with: NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height + 4), options: [.usesLineFragmentOrigin])
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct CapWrapText: NSViewRepresentable {
    let text: String
    let font: NSFont
    let color: NSColor
    let lineHeight: CGFloat

    private var attributed: NSAttributedString {
        let p = NSMutableParagraphStyle()
        p.lineBreakMode = .byWordWrapping
        p.lineBreakStrategy = []
        p.minimumLineHeight = lineHeight
        p.maximumLineHeight = lineHeight
        let natural = font.ascender - font.descender
        return NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: p,
            .baselineOffset: (lineHeight - natural) / 2,
        ])
    }

    func makeNSView(context: Context) -> CapTextNSView { CapTextNSView() }

    func updateNSView(_ v: CapTextNSView, context: Context) {
        v.attributed = attributed
        v.needsDisplay = true
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: CapTextNSView, context: Context) -> CGSize? {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let r = attributed.boundingRect(with: NSSize(width: w ?? 100_000, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
        return CGSize(width: w ?? ceil(r.width), height: r.height)
    }
}

/// `SectionHeading`: h2 18/27 semibold, space-y-1, muted 14/20 description.
struct CapHeading: View {
    let title: String
    let description: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(27)
            CapText(text: description, size: 14, lineHeight: 20.02)
        }
    }
}

/// Label (14/500, leading-none) over a 12px muted description, space-y-0.5.
struct CapLabelBlock: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(14)
            if let detail { CapText(text: detail) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `flex items-center justify-between gap-4` label row with a trailing control.
struct CapRow<Trailing: View>: View {
    let title: String
    var detail: String? = nil
    @ViewBuilder let trailing: Trailing
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            CapLabelBlock(title: title, detail: detail)
            trailing.fixedSize()
        }
    }
}

/// `pointer-events-none opacity-50` when disabled.
extension View {
    func capDimmed(_ dimmed: Bool) -> some View {
        compositingGroup().opacity(dimmed ? 0.5 : 1).allowsHitTesting(!dimmed)
    }
}

// MARK: - Switch / toggle row

/// shadcn Switch 32×18.4: checked primary with a primary-foreground thumb;
/// unchecked input/80 with a foreground thumb (dark) or background thumb (light).
struct CapSwitch: View {
    @Binding var isOn: Bool
    var testID: String? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { isOn.toggle() } } label: {
            Capsule()
                .fill(isOn ? Theme.primary : Theme.input.opacity(scheme == .dark ? 0.8 : 1))
                .frame(width: 32, height: 18.4)
                .overlay(alignment: isOn ? .trailing : .leading) {
                    Circle().fill(isOn ? (scheme == .dark ? Theme.primaryForeground : Theme.background) : (scheme == .dark ? Theme.foreground : Theme.background))
                        .frame(width: 16, height: 16).padding(.horizontal, 1)
                }
                .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
                .contentShape(Rectangle().inset(by: -8))
        }
        .buttonStyle(.plain)
        .testID(testID)
    }
}

/// `ToggleRow`: py-3, optional px-3 when boxed.
struct CapToggleRow: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool
    var boxed = false
    var testID: String? = nil
    var body: some View {
        CapRow(title: title, detail: detail) { CapSwitch(isOn: $isOn, testID: testID) }
            .padding(.vertical, 12)
            .padding(.horizontal, boxed ? 12 : 0)
    }
}

/// `rounded-lg border border-border` wrapper.
struct CapBox<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }
}

struct CapDivider: View {
    var body: some View { Rectangle().fill(Theme.border).frame(height: 1) }
}

// MARK: - Buttons

/// shadcn Button, size sm (h32, px-2.5, gap-1/1.5) / icon (36) / custom.
struct CapButtonStyle: ButtonStyle {
    enum Variant { case primary, outline, ghost, destructive, emerald, foreground }
    var variant: Variant = .outline
    var height: CGFloat = 32
    var horizontal: CGFloat = 10
    var fontSize: CGFloat = 14
    var radius: CGFloat = 8
    var color: Color? = nil
    var hoverColor: Color? = nil
    var width: CGFloat? = nil

    func makeBody(configuration: Configuration) -> some View { StyledBody(configuration: configuration, style: self) }

    private struct StyledBody: View {
        let configuration: Configuration
        let style: CapButtonStyle
        @Environment(\.isEnabled) private var enabled
        @Environment(\.colorScheme) private var scheme
        @State private var hover = false
        var body: some View {
            let dark = scheme == .dark
            configuration.label
                .font(.system(size: style.fontSize, weight: .medium))
                .foregroundStyle(fg)
                .padding(.horizontal, style.horizontal + 1) // + the transparent 1px border
                .frame(width: style.width, height: style.height)
                .background(RoundedRectangle(cornerRadius: style.radius - 1).fill(bg(dark)).padding(1))
                .overlay(RoundedRectangle(cornerRadius: style.radius).strokeBorder(style.variant == .outline ? (dark ? Theme.input : Theme.border) : .clear, lineWidth: 1))
                .background(RoundedRectangle(cornerRadius: style.radius).fill(Color.black.opacity(0.001))
                    .shadow(color: style.variant == .outline ? .black.opacity(0.05) : .clear, radius: 1, y: 1))
                .compositingGroup()
                .opacity(enabled ? 1 : 0.5)
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
        private var fg: Color {
            if hover, let h = style.hoverColor { return h }
            if let c = style.color { return c }
            switch style.variant {
            case .primary: return Theme.primaryForeground
            case .destructive: return Theme.destructive
            case .emerald: return .white
            case .foreground: return Theme.background
            default: return Theme.foreground
            }
        }
        private func bg(_ dark: Bool) -> Color {
            switch style.variant {
            case .primary: return Theme.primary.opacity(hover ? 0.8 : 1)
            case .outline: return dark ? Theme.input.opacity(hover ? 0.5 : 0.3) : (hover ? Theme.muted : Theme.background)
            case .ghost: return hover ? (dark ? Theme.muted.opacity(0.5) : Theme.muted) : .clear
            case .destructive: return Theme.destructive.opacity(dark ? (hover ? 0.3 : 0.2) : (hover ? 0.2 : 0.1))
            case .emerald: return hover ? CapColors.emerald800 : CapColors.emerald700
            case .foreground: return Theme.foreground.opacity(hover ? 0.85 : 1)
            }
        }
    }
}

enum CapColors {
    static let emerald700 = Color(nsColor: NSColor(hex: 0x007A55))
    static let emerald800 = Color(nsColor: NSColor(hex: 0x006045))
}

/// Icon + label inside a Button (gap-1.5, 14px icon).
struct CapIconLabel: View {
    let icon: String
    let title: String
    var color: Color = Theme.foreground
    var gap: CGFloat = 6
    var body: some View {
        HStack(spacing: gap) {
            Glyph(name: icon, size: 14, color: color)
            Text(title).lineBox(20.02)
        }
    }
}

// MARK: - Banner

/// Warning banner: rounded-md border warning/50 bg warning/5 px-3 py-2 text-xs.
struct CapWarningBanner: View {
    let text: String
    let grant: () -> Void
    let openSettings: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            CapText(text: text, color: Theme.warning)
            HStack(spacing: 8) {
                Button("Grant access", action: grant).buttonStyle(CapButtonStyle(color: Theme.warning, hoverColor: Theme.foreground))
                Button("Open Settings", action: openSettings).buttonStyle(CapButtonStyle(color: Theme.warning, hoverColor: Theme.foreground))
            }
            .fixedSize()
        }
        .padding(.horizontal, 13).padding(.vertical, 9) // + the 1px border
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warning.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.warning.opacity(0.5), lineWidth: 1))
    }
}

/// `text-xs text-success` status line.
struct CapSuccessLine: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Theme.success).lineBox(16.2).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Segmented control

/// `SegmentRow` control: rounded-md border bg-muted p-0.5, rounded px-2.5 py-1 12/500 buttons.
struct CapSegment: View {
    let options: [(String, String)]
    let value: String
    var testID: String? = nil
    let set: (String) -> Void
    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { o in
                CapSegmentButton(title: o.1, selected: o.0 == value) { set(o.0) }
                    .testID(testID.map { "\($0)-\(o.0)" })
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
    }
}

private struct CapSegmentButton: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .medium))
                .foregroundStyle(selected || hover ? Theme.foreground : Theme.mutedForeground)
                .lineBox(16.2)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background {
                    if selected {
                        RoundedRectangle(cornerRadius: 4).fill(Theme.background)
                            .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1)
                            .shadow(color: .black.opacity(0.1), radius: 1, y: 1)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// `SegmentRow`.
struct CapSegmentRow: View {
    let title: String
    let detail: String
    let options: [(String, String)]
    let value: String
    var testID: String? = nil
    let set: (String) -> Void
    var body: some View {
        CapRow(title: title, detail: detail) { CapSegment(options: options, value: value, testID: testID, set: set) }
    }
}

// MARK: - Select

/// shadcn Select: h36 trigger (border-input, px-3, 14px value, 16px chevron
/// at 50%), popper content below with 32px items and a check on the right.
struct CapSelect: View {
    let value: String
    let options: [(String, String)]
    var width: CGFloat = 208
    var testID: String? = nil
    let set: (String) -> Void
    @Environment(AppState.self) private var app
    @State private var frame: CGRect = .zero

    var body: some View {
        Button {
            let id = testID ?? "cap-select"
            if app.popup?.id == id { app.popup = nil; return }
            app.popup = PopupSpec(id: id, anchor: frame, style: .select,
                                  content: AnyView(CapSelectMenu(options: options, value: value, width: width) { v in
                                      app.popup = nil
                                      set(v)
                                  }.environment(app)))
        } label: {
            HStack(spacing: 8) {
                // line-clamp-1 clips (no ellipsis) at the value span's width.
                Text(options.first { $0.0 == value }?.1 ?? "")
                    .font(.system(size: 14)).foregroundStyle(Theme.foreground).lineLimit(1).fixedSize().lineBox(20.02)
                    .frame(width: width - 50, alignment: .leading).clipped()
                Glyph(name: "chevron-down", size: 16, color: Theme.mutedForeground).opacity(0.5)
            }
            .padding(.horizontal, 13)
            .frame(width: width, height: 36)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.001)).shadow(color: .black.opacity(0.05), radius: 1, y: 1))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .readFrame($frame)
        .testID(testID)
    }
}

private struct CapSelectMenu: View {
    let options: [(String, String)]
    let value: String
    let width: CGFloat
    let pick: (String) -> Void
    @State private var hovered: String?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(options, id: \.0) { o in
                Button { pick(o.0) } label: {
                    Text(o.1).font(.system(size: 14)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                        .padding(.leading, 8).padding(.trailing, 32).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .trailing) {
                            if o.0 == value { Glyph(name: "check", size: 16, color: Theme.mutedForeground).frame(width: 14, height: 14).padding(.trailing, 8) }
                        }
                        .background(RoundedRectangle(cornerRadius: 6).fill((hovered ?? value) == o.0 ? Theme.accent : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { if $0 { hovered = o.0 } }
                .testID("cap-option-\(o.0)")
            }
        }
        .padding(4)
        .frame(width: width)
        .padding(1)
    }
}

// MARK: - Inputs

/// `Input`: h36, rounded-md, border-input, dark bg input/30, px-2.5, 14px.
struct CapInputChrome: ViewModifier {
    var focused: Bool
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: 8).fill(scheme == .dark ? Theme.input.opacity(0.3) : .clear)
                .shadow(color: .black.opacity(0.05), radius: 1, y: 1))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.primary : Theme.input, lineWidth: 1))
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? Theme.primary.opacity(0.5) : .clear, lineWidth: 3).padding(-2))
    }
}

/// Full-width text input that commits on blur or Enter.
struct CapTextInput: View {
    let placeholder: String
    @Binding var text: String
    var testID: String? = nil
    let commit: () -> Void
    @FocusState private var focused: Bool
    var body: some View {
        TextField("", text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .foregroundStyle(Theme.foreground)
            .focused($focused)
            .background(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder).font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineLimit(1).allowsHitTesting(false)
                }
            }
            .onSubmit(commit)
            .onChange(of: focused) { _, f in if !f { commit() } }
            .padding(.horizontal, 11)
            .frame(height: 36)
            .modifier(CapInputChrome(focused: focused))
            .testID(testID)
    }
}

/// `NumberInput` (w-20): free editing, clamped on blur / Enter, with
/// WebKit's always-visible spin button.
struct CapNumberField: View {
    let value: Int
    var min: Int = 0
    var fallback: Int = 0
    var width: CGFloat = 80
    var testID: String? = nil
    let set: (Int) -> Void
    @State private var draft: String?
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 0) {
            TextField("", text: Binding(get: { draft ?? String(value) }, set: { raw in
                draft = raw
                if let n = Int(raw.trimmingCharacters(in: .whitespaces)), n >= min, n != value { set(n) }
            }))
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .foregroundStyle(Theme.foreground)
            .focused($focused)
            .onSubmit { commit() }
            .onChange(of: focused) { _, f in if !f { commit() } }
            CapSpinButton { step($0) }
        }
        .padding(.leading, 11).padding(.trailing, 11)
        .frame(width: width, height: 36)
        .modifier(CapInputChrome(focused: focused))
        .testID(testID)
    }

    private func commit() {
        let raw = (draft ?? String(value)).trimmingCharacters(in: .whitespaces)
        let next = Swift.max(min, Int(raw) ?? fallback)
        draft = nil
        if next != value { set(next) }
    }

    private func step(_ d: Int) {
        draft = nil
        let next = Swift.max(min, value + d)
        if next != value { set(next) }
    }
}

/// WebKit's inner spin button: 14×17 rounded chip with two chevrons.
private struct CapSpinButton: View {
    let step: (Int) -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let fg = scheme == .dark ? Color(white: 0.87) : Color(white: 0.25)
        ZStack {
            RoundedRectangle(cornerRadius: 3.5).fill(scheme == .dark ? Color(nsColor: NSColor(hex: 0x252527)) : Color(white: 0.92))
            Rectangle().fill(scheme == .dark ? Color(nsColor: NSColor(hex: 0x3A3A3C)) : Color(white: 0.8)).frame(width: 8.5, height: 1)
            VStack(spacing: 0) {
                Chevron(up: true).stroke(fg, style: StrokeStyle(lineWidth: 1.1, lineCap: .round, lineJoin: .round))
                    .frame(width: 6, height: 3.8).padding(.top, 2.1)
                Spacer(minLength: 0)
                Chevron(up: false).stroke(fg, style: StrokeStyle(lineWidth: 1.1, lineCap: .round, lineJoin: .round))
                    .frame(width: 6, height: 3.8).padding(.bottom, 2.1)
            }
            VStack(spacing: 0) {
                Color.clear.contentShape(Rectangle()).onTapGesture { step(1) }
                Color.clear.contentShape(Rectangle()).onTapGesture { step(-1) }
            }
        }
        .frame(width: 14, height: 17)
    }

    private struct Chevron: Shape {
        let up: Bool
        func path(in r: CGRect) -> Path {
            var p = Path()
            if up {
                p.move(to: CGPoint(x: r.minX, y: r.maxY)); p.addLine(to: CGPoint(x: r.midX, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
            } else {
                p.move(to: CGPoint(x: r.minX, y: r.minY)); p.addLine(to: CGPoint(x: r.midX, y: r.maxY)); p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
            }
            return p
        }
    }
}

/// Number input + muted unit (`flex items-center gap-1.5`).
struct CapNumberUnit: View {
    let value: Int
    var min: Int = 0
    var fallback: Int = 0
    let unit: String
    var testID: String? = nil
    let set: (Int) -> Void
    var body: some View {
        HStack(spacing: 6) {
            CapNumberField(value: value, min: min, fallback: fallback, testID: testID, set: set)
            Text(unit).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
        }
    }
}

/// `Textarea` rows=4: field-sizing-content, min-h-16, px-2.5 py-2, 14px.
/// The placeholder does not size the field (it is clipped, as in WebKit).
struct CapTextArea: View {
    @Binding var text: String
    let placeholder: String
    @FocusState private var focused: Bool
    var body: some View {
        let lines = CGFloat(max(1, text.components(separatedBy: "\n").count))
        TextEditor(text: $text)
            .font(.system(size: 14))
            .foregroundStyle(Theme.foreground)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.never)
            .focused($focused)
            .padding(.horizontal, 6).padding(.vertical, 9)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    CapText(text: placeholder, size: 14, lineHeight: 20.02)
                        .padding(.horizontal, 11).padding(.top, 9)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: max(64, lines * 20.02 + 18))
            .clipped()
            .modifier(CapInputChrome(focused: focused))
    }
}

// MARK: - Hotkey recorder

/// `HotkeyRecorder`: click to arm, press a modifier chord to commit; ✕ clears.
struct CapHotkeyRecorder: View {
    let value: String
    var testID: String? = nil
    let set: (String) -> Void
    @Environment(AppState.self) private var app
    @State private var recording = false
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            Button { recording ? stop() : start() } label: {
                HStack(spacing: 4) {
                    if recording {
                        Text("Press keys…").foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                    } else if !CapHotkeyRecorder.chips(value).isEmpty {
                        ForEach(Array(CapHotkeyRecorder.chips(value).enumerated()), id: \.offset) { _, c in
                            Text(c).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                                .frame(height: 12)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background)
                                    .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1)
                                    .shadow(color: .black.opacity(0.1), radius: 1, y: 1))
                        }
                    } else {
                        Text("Set shortcut").foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 11)
                .frame(minWidth: 112).frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 8).fill(recording ? Theme.primary.opacity(0.1) : (hover ? Theme.muted.opacity(0.7) : Theme.muted)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(recording ? Theme.primary : Theme.border, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hover = $0 }
            .testID(testID)
            if !value.isEmpty && !recording {
                GhostIconButton(icon: "x", box: 28, glyph: 14, hoverFill: Theme.muted, tip: "Clear shortcut") { set("") }
            }
        }
        .onDisappear { if recording { stop() } }
    }

    private func start() {
        recording = true
        app.recorder = { event in
            if event.keyCode == 53 { stop(); return true }
            let f = event.modifierFlags
            guard let accel = Shortcuts.accelerator(for: event), !f.isDisjoint(with: [.command, .control, .option]) else { return true }
            set(accel)
            stop()
            return true
        }
    }

    private func stop() {
        recording = false
        app.recorder = nil
    }

    /// `shortcutChips`: canonical order, mac glyphs for modifiers.
    static func chips(_ accel: String) -> [String] {
        guard !accel.isEmpty else { return [] }
        let labels = ["Ctrl": "⌃", "Alt": "⌥", "Shift": "⇧", "Cmd": "⌘"]
        return Shortcuts.normalize(accel).split(separator: "+").map { p in labels[String(p)] ?? Shortcuts.format(String(p)) }
    }
}
