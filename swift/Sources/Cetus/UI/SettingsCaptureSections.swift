import AppKit
import SwiftUI

// Settings → Input & Capture (Launcher, Voice, Screen context, Meetings) and
// Data (Archived chats), ported from cetus/src/components/settings/sections.
// The launcher, voice, capture and meeting features have no native backend
// here yet, so their settings persist locally under `settings.*`.

private let gestureOrder = ["off", "both_cmd", "both_opt", "double_cmd", "double_opt"]

private func gestureName(_ g: String) -> String {
    switch g {
    case "off": "Off"
    case "double_cmd": "Double-tap ⌘"
    case "double_opt": "Double-tap right ⌥"
    case "both_opt": "Both ⌥"
    default: "Both ⌘"
    }
}

// MARK: - Launcher

struct LauncherSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.quick") private var store = CapStored<CapQuickSettings>()
    @State private var trusted = CapPermissions.accessibility
    @State private var screenRec = CapPermissions.screenRecording

    var body: some View {
        let s = store.value
        let firstGesture = s.gesturePlain != "off" ? s.gesturePlain : s.gestureShot != "off" ? s.gestureShot : s.gestureReply
        let wantsScreenshot = s.gestureShot != "off" || s.gestureReply != "off"
        let runtimes = Runtimes.ordered(app.prefs)
        let reply = runtimes.contains { $0.id == s.replyBackend } ? s.replyBackend : "pi"
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Quick launcher", description: "Summon a floating panel from anywhere to start a session — optionally with a screenshot of your screen as context.")
            if !trusted {
                CapWarningBanner(text: "The launcher needs Accessibility access to detect the ⌘ gesture system-wide.",
                                 grant: { trusted = CapPermissions.requestAccessibility() },
                                 openSettings: { CapPermissions.openPane("Privacy_Accessibility") })
                    .padding(.top, 16)
            } else {
                CapSuccessLine(text: "● Accessibility access granted").padding(.top, 12)
            }
            if wantsScreenshot && !screenRec {
                CapWarningBanner(text: "Screenshots need Screen Recording access — without it Cetus can only capture your wallpaper, not the windows on screen.",
                                 grant: { screenRec = CapPermissions.requestScreenRecording() },
                                 openSettings: { CapPermissions.openPane("Privacy_ScreenCapture") })
                    .padding(.top, 12)
            } else if wantsScreenshot {
                CapSuccessLine(text: "● Screen Recording access granted").padding(.top, 8)
            }
            CapToggleRow(title: "Enable quick launcher", detail: "Trigger: \(gestureName(firstGesture)). Works even when Cetus is in the background.",
                         isOn: $store.value.enabled, testID: "launcher-enabled")
                .padding(.top, 24)
            VStack(alignment: .leading, spacing: 20) {
                gestureRow("Quick launch", "Open the launcher (no screenshot).", \.gesturePlain, others: [s.gestureShot, s.gestureReply], id: "launcher-plain")
                gestureRow("Quick launch + screenshot", "Select a screen area to attach — click for the full screen — then launch.", \.gestureShot, others: [s.gesturePlain, s.gestureReply], id: "launcher-shot")
                gestureRow("Visual quick reply", "Capture the current screen and AX context, ask your chosen agent runtime for reply options, and insert one back into the focused app.", \.gestureReply, others: [s.gesturePlain, s.gestureShot], id: "launcher-reply")
                CapRow(title: "Quick-reply runtime", detail: "Use one of the agent runtimes enabled in Settings → Runtimes.") {
                    CapSelect(value: reply, options: runtimes.map { ($0.id, $0.label) }, testID: "launcher-runtime") { store.value.replyBackend = $0 }
                }
                CapRow(title: "Summon Cetus", detail: "Global shortcut to bring Cetus to the front, switching desktops if it's on another.") {
                    CapHotkeyRecorder(value: s.summonHotkey, testID: "launcher-summon") { store.value.summonHotkey = $0 }
                }
                CapSegmentRow(title: "Default session", detail: "Start a fresh chat or continue your most recent one.",
                              options: [("new", "New"), ("last", "Last")], value: s.sessionMode, testID: "launcher-session") { store.value.sessionMode = $0 }
            }
            .capDimmed(!s.enabled)
            .padding(.top, 16)
        }
        .onAppear {
            trusted = CapPermissions.accessibility
            screenRec = CapPermissions.screenRecording
        }
    }

    private func gestureRow(_ title: String, _ detail: String, _ key: WritableKeyPath<CapQuickSettings, String>, others: [String], id: String) -> some View {
        let current = store.value[keyPath: key]
        let opts = gestureOrder.filter { $0 == "off" || $0 == current || !others.contains($0) }
        return CapRow(title: title, detail: detail) {
            CapSelect(value: current, options: opts.map { ($0, gestureName($0)) }, testID: id) { store.value[keyPath: key] = $0 }
        }
    }
}

// MARK: - Voice

struct VoiceSection: View {
    @AppStorage("settings.quick") private var store = CapStored<CapQuickSettings>()
    @AppStorage("settings.voice.history") private var history = CapStored<CapTranscripts>()
    @State private var voiceReady = CapPermissions.microphone && CapPermissions.speech
    @State private var trusted = CapPermissions.accessibility

    var body: some View {
        let s = store.value
        let gesture = switch s.voiceGesture {
        case "right_option": "Right ⌥"
        case "fn": "fn (Globe)"
        case "caps_lock": "Caps Lock"
        default: "Right ⌘"
        }
        let doubao = s.voiceAsrEngine != "apple"
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Voice dictation", description: "Speak instead of type. Pick the recognition engine below, then hold the push-to-talk key to dictate into the focused app.")
            if !voiceReady {
                CapWarningBanner(text: "Dictation needs Microphone and Speech Recognition access.",
                                 grant: { CapPermissions.requestVoice { voiceReady = CapPermissions.microphone && CapPermissions.speech } },
                                 openSettings: { CapPermissions.openPane("Privacy_Microphone") })
                    .padding(.top, 16)
            } else {
                CapSuccessLine(text: "● Microphone & Speech Recognition access granted").padding(.top, 12)
            }
            CapSegmentRow(title: "Recognition engine",
                          detail: doubao ? "Doubao (Volcano Engine) real-time streaming — fastest (~90ms), live text as you speak, great at mixed Chinese/English, works in mainland China. Needs a Doubao API key (X-Api-Key)."
                              : "Apple on-device — instant, audio never leaves your Mac, but weaker at Chinese/English code-switching.",
                          options: [("doubao", "Doubao (cloud)"), ("apple", "Apple (on-device)")], value: doubao ? "doubao" : "apple", testID: "voice-engine") { store.value.voiceAsrEngine = $0 }
                .padding(.top, 24)
            CapToggleRow(title: "System-wide dictation", detail: "Hold \(gesture) anywhere to dictate; release to insert the text into the focused app.",
                         isOn: $store.value.voiceEnabled, testID: "voice-enabled")
                .padding(.top, 24)
            if s.voiceEnabled && !trusted {
                CapWarningBanner(text: "Typing into other apps needs Accessibility access (the same grant the launcher uses).",
                                 grant: { trusted = CapPermissions.requestAccessibility() },
                                 openSettings: { CapPermissions.openPane("Privacy_Accessibility") })
                    .padding(.top, 12)
            }
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    CapSegmentRow(title: "Trigger key", detail: "Hold this modifier to talk and release to insert. A short tap is ignored, so normal shortcuts keep working.",
                                  options: [("right_cmd", "Right ⌘"), ("right_option", "Right ⌥"), ("fn", "fn"), ("caps_lock", "Caps Lock")],
                                  value: s.voiceGesture, testID: "voice-trigger") { store.value.voiceGesture = $0 }
                    if s.voiceGesture == "caps_lock" {
                        CapText(text: "Cetus reassigns Caps Lock to dictation while it's running and restores it when you quit.")
                    }
                }
                CapBox {
                    CapToggleRow(title: "Hands-free double-tap shortcut",
                                 detail: "Optional and off by default. Double-tap \(gesture) to start or stop hands-free dictation. If that double-tap is assigned to quick reply or the launcher, that action takes priority. Requires Doubao.",
                                 isOn: $store.value.voiceHandsfreeShortcut, boxed: true, testID: "voice-handsfree")
                }
                CapBox {
                    CapToggleRow(title: "Start sound", detail: "Play a soft bubble pop when the dictation capsule appears, so you know it's listening.",
                                 isOn: $store.value.voiceStartSound, boxed: true, testID: "voice-sound")
                }
                if doubao {
                    CapBox {
                        CapToggleRow(title: "Bias to your vocabulary",
                                     detail: "Boost recognition of your terms and what you're writing by sending hotwords plus the focused field's text to Doubao. Also learns from your edits: shortly after inserting, Cetus re-reads the same field and saves spelling fixes you made (e.g. names) to a local correction dictionary. Doubao engine only; password fields are never read.",
                                     isOn: $store.value.voiceContextBiasing, boxed: true, testID: "voice-biasing")
                        if s.voiceContextBiasing {
                            CapDivider()
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Hotwords").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(16.2)
                                CapText(text: "One term per line, under 10 characters each — names, jargon, and product names you say often (English or Chinese). Cetus also learns terms from your dictation automatically.")
                                CapTextArea(text: $store.value.voiceHotwords, placeholder: "DeepSeek\nTauri\ncetus")
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                        }
                    }
                }
            }
            .capDimmed(!s.voiceEnabled)
            .padding(.top, 16)
            CapBox {
                CapToggleRow(title: "Save dictation history",
                             detail: "Keep a log of what you dictate so you — and the agent (via the recall_dictation tool) — can refer back to it. Off by default.",
                             isOn: $history.value.enabled, boxed: true, testID: "voice-history")
                if history.value.enabled {
                    CapDivider()
                    VStack(alignment: .leading, spacing: 0) {
                        if history.value.entries.isEmpty {
                            CapText(text: "Nothing dictated yet — your transcripts will show up here.")
                        } else {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(Array(history.value.entries.reversed().prefix(50).enumerated()), id: \.offset) { _, e in
                                        Text(e).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2).help(e)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true)
                            Button("Clear history (\(history.value.entries.count))") { history.value.entries = [] }
                                .buttonStyle(CapButtonStyle(variant: .ghost, height: 28, horizontal: 8, fontSize: 12, color: Theme.mutedForeground, hoverColor: Theme.foreground))
                                .padding(.top, 8)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
            }
            .padding(.top, 24)
        }
        .onAppear {
            voiceReady = CapPermissions.microphone && CapPermissions.speech
            trusted = CapPermissions.accessibility
        }
    }
}

// MARK: - Screen context (+ Ambient context)

struct ScreenContextSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.capture") private var store = CapStored<CapCaptureSettings>()
    @State private var excluded = ""
    @State private var frames = ScreenStore.shared.screenshotsCount()

    var body: some View {
        let s = store.value
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Screen context", description: "Periodically capture your screen and read it on-device (Apple Vision OCR) so the agent can recall what you were working on. Images and text stay on your Mac — nothing is uploaded.")
            Button { ScreenHistoryModel.shared.show(app) } label: { CapIconLabel(icon: "monitor", title: "Browse captured frames") }
                .buttonStyle(CapButtonStyle())
                .testID("screen-browse")
                .padding(.top, 16)
            CapToggleRow(title: "Enable screen capture", detail: "Off by default. When on, Cetus captures at the moments that matter — pressing Enter, saving or copying, switching windows, pausing after typing — plus a fallback timer.",
                         isOn: $store.value.enabled, testID: "screen-enabled")
                .padding(.top, 24)
            VStack(alignment: .leading, spacing: 20) {
                CapRow(title: "Fallback interval", detail: "Seconds between timer captures when no event fires. Near-identical frames are skipped automatically.") {
                    CapNumberUnit(value: s.intervalSeconds, min: 2, fallback: 30, unit: "sec") { store.value.intervalSeconds = $0 }
                }
                CapRow(title: "Keep text for", detail: "Searchable on-screen text older than this is deleted. Text is tiny — this can be long. Set 0 to keep forever.") {
                    CapNumberUnit(value: s.retentionDays, unit: "days") { store.value.retentionDays = $0 }
                }
                CapRow(title: "Keep images for", detail: "Full frames and thumbnails older than this are deleted from disk; the searchable text above stays. Images are ~99% of the disk use. Set 0 to keep images as long as the text.") {
                    CapNumberUnit(value: s.frameRetentionDays, unit: "days") { store.value.frameRetentionDays = $0 }
                }
                CapBox {
                    CapToggleRow(title: "Read text on-device (OCR)", detail: "Use Apple Vision to extract on-screen text so the agent can search it. Runs locally.",
                                 isOn: $store.value.ocrEnabled, boxed: true, testID: "screen-ocr")
                }
                CapExcluded(detail: "Comma-separated app names or bundle ids. Capture is skipped while one of these is frontmost (e.g. 1Password, Messages).",
                            text: $excluded) { store.value.excludedApps = CapExcluded.parse(excluded) }
            }
            .capDimmed(!s.enabled)
            .padding(.top, 16)
            CapText(text: "\(frames.formatted()) \(frames == 1 ? "frame" : "frames") captured · macOS asks for Screen Recording permission the first time capture runs.")
                .padding(.top, 24)
            AmbientContextSection().padding(.top, 40)
        }
        .onAppear { excluded = s.excludedApps.joined(separator: ", "); frames = ScreenStore.shared.screenshotsCount() }
    }
}

private struct AmbientContextSection: View {
    @AppStorage("settings.ambient") private var store = CapStored<CapAmbientSettings>()
    @State private var count = ScreenStore.shared.axContextCount()
    @State private var excluded = ""

    var body: some View {
        let s = store.value
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Ambient context", description: "Keep a rolling, text-only memory of what you're looking at by reading the frontmost app's accessibility tree — window titles, visible text, browser URLs. No screenshots, no keystrokes, never password fields. Everything stays on your Mac.")
            CapToggleRow(title: "Enable ambient context", detail: "Off by default. When on, chats can attach a summary of your recent activity via the composer's radar toggle.",
                         isOn: $store.value.enabled, testID: "ambient-enabled")
                .padding(.top, 24)
            VStack(alignment: .leading, spacing: 20) {
                CapRow(title: "Keep history for", detail: "Older entries are deleted automatically. Set 0 to keep forever.") {
                    CapNumberUnit(value: s.retentionDays, unit: "days") { store.value.retentionDays = $0 }
                }
                CapExcluded(detail: "Comma-separated app names or bundle ids. Nothing is read while one of these is frontmost (e.g. 1Password, banking apps).",
                            text: $excluded) { store.value.excludedApps = CapExcluded.parse(excluded) }
                Button("Delete all history") { ScreenStore.shared.clearAxContext(); count = 0 }.buttonStyle(CapButtonStyle()).testID("ambient-clear")
            }
            .capDimmed(!s.enabled)
            .padding(.top, 16)
            CapText(text: "\(count.formatted()) \(count == 1 ? "entry" : "entries") stored · reading window text uses the Accessibility permission.")
                .padding(.top, 24)
        }
        .onAppear { excluded = s.excludedApps.joined(separator: ", "); count = ScreenStore.shared.axContextCount() }
    }
}

/// "Excluded apps" block: label, hint, full-width input (space-y-1.5).
private struct CapExcluded: View {
    let detail: String
    @Binding var text: String
    let commit: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Excluded apps").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
            CapText(text: detail)
            CapTextInput(placeholder: "1Password, Messages, com.apple.keychainaccess", text: $text, commit: commit)
        }
    }

    static func parse(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

// MARK: - Meetings

struct MeetingsSection: View {
    @AppStorage("settings.meeting") private var store = CapStored<CapMeetingSettings>()

    var body: some View {
        let s = store.value
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Meetings", description: "Transcribe meetings on-device into searchable notes. Your microphone is you; system audio is everyone else. Everything stays on this Mac.")
            readyCard(s).padding(.top, 20)
            CapToggleRow(title: "Enable meeting memory", detail: "Master switch. Off means Cetus never listens, including auto-detection.",
                         isOn: $store.value.enabled, testID: "meeting-enabled")
                .padding(.top, 24)
            VStack(alignment: .leading, spacing: 20) {
                CapBox {
                    HStack(alignment: .center, spacing: 16) {
                        HStack(alignment: .top, spacing: 10) {
                            Glyph(name: s.asrEngine == "local" ? "shield-check" : "cloud", size: 16,
                                  color: s.asrEngine == "local" ? Theme.mutedForeground : CapColors.emerald700)
                                .padding(.top, 2)
                            CapLabelBlock(title: "Transcription quality", detail: "Auto uses real-time SeedASR when your Doubao key is configured, and privately falls back to Apple on-device. Audio is streamed only for recognition.")
                        }
                        CapSelect(value: s.asrEngine, options: [("auto", "Auto · best available"), ("local", "On-device only")], width: 176, testID: "meeting-asr") { store.value.asrEngine = $0 }
                    }
                    .padding(12)
                    CapDivider()
                    CapToggleRow(title: "Start automatically", detail: "Begin transcribing when a known meeting app (Zoom, Teams, FaceTime…) uses the microphone. Browsers only qualify on supported meeting sites; other apps are ignored.",
                                 isOn: $store.value.autoDetect, boxed: true, testID: "meeting-auto")
                    CapDivider()
                    CapToggleRow(title: "Transcribe other participants", detail: "Also transcribe the system audio output (what you hear). Requires macOS 14.2+; falls back to mic-only below that.",
                                 isOn: $store.value.systemAudio, boxed: true, testID: "meeting-system-audio")
                    CapDivider()
                    CapToggleRow(title: "Generate meeting notes", detail: "After each meeting, distill a title and minutes (key points, decisions, action items) with DeepSeek.",
                                 isOn: $store.value.summarize, boxed: true, testID: "meeting-summarize")
                    CapDivider()
                    CapToggleRow(title: "Keep raw audio", detail: "Save each stream as an m4a file next to the transcript, on this Mac only.",
                                 isOn: $store.value.saveAudio, boxed: true, testID: "meeting-save-audio")
                }
                CapRow(title: "Keep meetings for", detail: "Older meetings are deleted. 0 keeps them forever.") {
                    CapNumberUnit(value: s.retentionDays, unit: "days", testID: "meeting-retention") { store.value.retentionDays = $0 }
                }
                CapRow(title: "Toggle hotkey", detail: "Global shortcut to start/stop a session manually — for in-person meetings nothing can auto-detect.") {
                    CapHotkeyRecorder(value: s.toggleHotkey, testID: "meeting-hotkey") { store.value.toggleHotkey = $0 }
                }
            }
            .capDimmed(!s.enabled)
            .padding(.top, 16)
            Text("Recent meetings").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(20.02)
                .padding(.top, 32)
            CapText(text: "No meetings recorded yet.").padding(.top, 12)
        }
    }

    private func readyCard(_ s: CapMeetingSettings) -> some View {
        HStack(spacing: 16) {
            HStack(spacing: 12) {
                Glyph(name: "mic", size: 16, color: Theme.mutedForeground)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Theme.background))
                    .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                VStack(alignment: .leading, spacing: 0) {
                    Text("Ready for your next conversation").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(20.02)
                    Text("Start a note manually or use \(s.toggleHotkey) from anywhere.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                }
            }
            Spacer(minLength: 0)
            Button {} label: { CapIconLabel(icon: "audio-lines", title: "Start capture now", color: .white) }
                .buttonStyle(CapButtonStyle(variant: .emerald, horizontal: 16, radius: 16))
                .disabled(!s.enabled)
                .testID("meeting-start")
        }
        .padding(16)
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.muted.opacity(0.2)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border, lineWidth: 1))
    }
}

// MARK: - Archived chats

struct ArchivedChatsSection: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.autoArchive") private var auto = CapStored<CapAutoArchiveSettings>()
    @State private var confirmingAll = false

    private static let dateFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "M/d/yyyy"
        return f
    }()

    var body: some View {
        let chats = app.controller.archived.sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
        let count = chats.count
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Archived chats", description: "Conversations you've archived from the sidebar. Restore one to bring it back, or clear them all to free up space — deletion is permanent.")
            autoArchiveBlock.padding(.top, 24)
            HStack(spacing: 16) {
                Text(count == 0 ? "No archived chats." : count == 1 ? "1 archived chat" : "\(count) archived chats")
                    .font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineBox(20.02)
                Spacer(minLength: 0)
                if count > 0 {
                    if confirmingAll {
                        HStack(spacing: 8) {
                            Text("Delete all \(count)?").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                            Button("Confirm") {
                                for c in chats { app.controller.delete(c.id) }
                                confirmingAll = false
                            }
                            .buttonStyle(CapButtonStyle(variant: .destructive)).testID("archived-confirm-all")
                            Button("Cancel") { confirmingAll = false }.buttonStyle(CapButtonStyle()).testID("archived-cancel-all")
                        }
                    } else {
                        Button { confirmingAll = true } label: { CapIconLabel(icon: "trash-2", title: "Delete all", color: Theme.destructive) }
                            .buttonStyle(CapButtonStyle(color: Theme.destructive))
                            .testID("archived-delete-all")
                    }
                }
            }
            .padding(.top, 24)
            if count > 0 {
                VStack(spacing: 0) {
                    ForEach(Array(chats.enumerated()), id: \.element.id) { i, c in
                        if i > 0 { CapDivider() }
                        row(c)
                    }
                }
                .padding(1)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
                .padding(.top, 16)
            }
        }
        .onAppear { CaptureArchiveSweeper.start(app) }
        .onChange(of: auto.rawValue) { _, _ in CaptureArchiveSweeper.sweep() }
    }

    private func row(_ c: Conversation) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.title.isEmpty ? "Untitled" : c.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
                    .lineLimit(1).truncationMode(.tail).lineBox(20.02)
                Text(c.archivedAt.map { "Archived \(Self.dateFormat.string(from: Date(timeIntervalSince1970: $0 / 1000)))" } ?? "")
                    .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // flex (align stretch): the 32px Restore sits at the top of the 36px icon button's row.
            HStack(alignment: .top, spacing: 6) {
                Button {
                    // Like Cetus's set_archived: restoring also bumps updated_at (so the
                    // auto-archive idle clock restarts) and clears the unread dot.
                    app.controller.store.update(c.id, [.archivedAt(nil), .updatedAt(nowMs()), .unread(false)])
                    app.controller.reload()
                } label: { CapIconLabel(icon: "archive-restore", title: "Restore") }
                    .buttonStyle(CapButtonStyle(variant: .ghost))
                    .testID("restore-\(c.id)")
                CapDeleteIconButton { app.controller.delete(c.id) }
                    .testID("delete-\(c.id)")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private var autoArchiveBlock: some View {
        let s = auto.value
        let units = [("hours", "hours"), ("days", "days")]
        return VStack(alignment: .leading, spacing: 0) {
            CapToggleRow(title: "Auto-archive idle chats", detail: "Automatically move conversations you haven't touched in a while into the archive. They stay restorable here.",
                         isOn: $auto.value.enabled, testID: "auto-archive-enabled")
            CapRow(title: "Archive after", detail: "How long a conversation can sit untouched before it's archived. Open chats, unread results, and automation results are left alone.") {
                HStack(spacing: 6) {
                    CapNumberField(value: s.value, min: 1, fallback: 1, testID: "auto-archive-value") { auto.value.value = $0 }
                    CapSelect(value: s.unit, options: units, width: 96, testID: "auto-archive-unit") { auto.value.unit = $0 }
                }
            }
            .capDimmed(!s.enabled)
            .padding(.top, 16)
            VStack(alignment: .leading, spacing: 0) {
                CapToggleRow(title: "Auto-delete archived chats", detail: "Permanently delete chats that have sat in the archive for a while. This can't be undone.",
                             isOn: $auto.value.deleteEnabled, testID: "auto-delete-enabled")
                CapRow(title: "Delete after", detail: "How long a chat stays in the archive before it's deleted. Only archived chats are affected; anything still in the sidebar is never touched.") {
                    HStack(spacing: 6) {
                        CapNumberField(value: s.deleteValue, min: 1, fallback: 1, testID: "auto-delete-value") { auto.value.deleteValue = $0 }
                        CapSelect(value: s.deleteUnit, options: units, width: 96, testID: "auto-delete-unit") { auto.value.deleteUnit = $0 }
                    }
                }
                .capDimmed(!s.deleteEnabled)
                .padding(.top, 16)
            }
            .padding(.top, 17) // border-t + pt-4
            .overlay(alignment: .top) { CapDivider() }
            .padding(.top, 16)
        }
        .padding(17)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }
}

/// Ghost `size="icon"` (36×36) trash button, muted → destructive on hover.
private struct CapDeleteIconButton: View {
    let action: () -> Void
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: action) {
            Glyph(name: "trash-2", size: 14, color: hover ? Theme.destructive : Theme.mutedForeground)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 7).fill(hover ? (scheme == .dark ? Theme.muted.opacity(0.5) : Theme.muted) : .clear).padding(1))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .onHover { hover = $0 }
        .help("Delete chat")
    }
}
