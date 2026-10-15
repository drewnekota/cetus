import AppKit
import SwiftUI

// Settings → Meetings (sections/meetings.tsx), wired to MeetingEngine: the live
// session card (start / stop, elapsed, live transcript), the settings
// (UserDefaults `settings.meeting`), and the recent-meetings list with
// summaries, transcripts, saved audio and delete.

private enum MeetColors {
    static let emerald600 = Color(nsColor: NSColor(hex: 0x009966))
    static func cardBg(_ dark: Bool) -> Color { dark ? Color(nsColor: NSColor(hex: 0x002C22)).opacity(0.2) : Color(nsColor: NSColor(hex: 0xF4F8F0)) }
    static func cardBorder(_ dark: Bool) -> Color { dark ? Color(nsColor: NSColor(hex: 0x00D492)).opacity(0.2) : CapColors.emerald700.opacity(0.2) }
    static func liveDivider(_ dark: Bool) -> Color { dark ? Color(nsColor: NSColor(hex: 0x5EE9B5)).opacity(0.1) : CapColors.emerald800.opacity(0.1) }
    static func panelBg(_ dark: Bool) -> Color { dark ? Color.white.opacity(0.035) : Color(nsColor: NSColor(hex: 0xF7F7F4)) }
    static func panelBorder(_ dark: Bool) -> Color { dark ? Color.white.opacity(0.1) : Color.black.opacity(0.07) }
    static func headerBorder(_ dark: Bool) -> Color { dark ? Color.white.opacity(0.1) : Color.black.opacity(0.06) }
    static func searchBg(_ dark: Bool) -> Color { dark ? Color.white.opacity(0.06) : Color.black.opacity(0.04) }
    static func mineBg(_ dark: Bool) -> Color { dark ? Color(nsColor: NSColor(hex: 0x004F3B)).opacity(0.5) : Color(nsColor: NSColor(hex: 0xDDEFD7)) }
    static func mineFg(_ dark: Bool) -> Color { dark ? Color(nsColor: NSColor(hex: 0xECFDF5)) : Color(nsColor: NSColor(hex: 0x173819)) }
    static func theirsBg(_ dark: Bool) -> Color { dark ? Color.white.opacity(0.08) : .white }
}

private enum MeetDates {
    static let time: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.dateFormat = "hh:mm a"; return f }()
    static let when: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_US"); f.dateFormat = "MMM d 'at' hh:mm a"; return f }()
    static func t(_ ms: Double) -> String { time.string(from: Date(timeIntervalSince1970: ms / 1000)) }
    static func w(_ ms: Double) -> String { when.string(from: Date(timeIntervalSince1970: ms / 1000)) }
}

struct MeetingsSettingsSection: View {
    @AppStorage("settings.meeting") private var store = CapStored<CapMeetingSettings>()
    @Environment(\.colorScheme) private var scheme
    @State private var meetings: [MeetingRecord] = []
    @State private var expandedId: String?

    var body: some View {
        let s = store.value
        let engine = MeetingEngine.shared
        VStack(alignment: .leading, spacing: 0) {
            CapHeading(title: "Meetings", description: "Transcribe meetings on-device into searchable notes. Your microphone is you; system audio is everyone else. Everything stays on this Mac.")
            liveCard(s, engine.status).padding(.top, 20)
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
            if meetings.isEmpty {
                CapText(text: "No meetings recorded yet.").padding(.top, 12)
            } else {
                VStack(spacing: 8) {
                    ForEach(meetings) { m in row(m) }
                }
                .padding(.top, 12)
            }
        }
        .onAppear(perform: reload)
        .onChange(of: engine.eventSeq) { reload() }
    }

    private func reload() { meetings = MeetingEngine.shared.list(limit: 50) }

    // MARK: Live card

    @ViewBuilder
    private func liveCard(_ s: CapMeetingSettings, _ st: MeetingStatus) -> some View {
        let dark = scheme == .dark
        let recording = st.recording && st.startedTs != nil
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                if recording, let started = st.startedTs {
                    HStack(spacing: 10) {
                        Glyph(name: "audio-lines", size: 16, color: .white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(CapColors.emerald700)
                                .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1).shadow(color: .black.opacity(0.1), radius: 1, y: 1))
                        VStack(alignment: .leading, spacing: 0) {
                            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                                Text("Transcribing… \(MeetingFormat.elapsed(started, now: ctx.date))")
                                    .font(.system(size: 14, weight: .semibold)).tracking(-0.35).foregroundStyle(Theme.foreground)
                                    .lineLimit(1).lineBox(20.02)
                            }
                            Text(subtitle(st)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Stop & save") { Task { await MeetingEngine.shared.stop(suppressAuto: true); reload() } }
                        .buttonStyle(CapButtonStyle(variant: .foreground, horizontal: 16, radius: 16))
                        .testID("meeting-stop")
                } else {
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
                    Button { Task { try? await MeetingEngine.shared.start(auto: false, appHint: nil) } } label: { CapIconLabel(icon: "audio-lines", title: "Start capture now", color: .white) }
                        .buttonStyle(CapButtonStyle(variant: .emerald, horizontal: 16, radius: 16))
                        .disabled(!s.enabled)
                        .testID("meeting-start")
                }
            }
            .padding(16)
            if recording, let id = st.meetingId {
                Rectangle().fill(MeetColors.liveDivider(dark)).frame(height: 1)
                MeetingTranscriptPanel(meetingId: id, live: true).padding(12)
            }
        }
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 16).fill(recording ? MeetColors.cardBg(dark) : Theme.muted.opacity(0.2))
            .shadow(color: recording ? Color(red: 31 / 255, green: 70 / 255, blue: 35 / 255).opacity(0.08) : .clear, radius: 20, y: 12))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(recording ? MeetColors.cardBorder(dark) : Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func subtitle(_ st: MeetingStatus) -> String {
        let mode = st.auto ? "Auto-detected" + (st.appHint.map { " · \($0)" } ?? "") : "Manual session"
        return "\(mode) · \(st.segments) segments · \(st.engine == "cloud" ? "SeedASR cloud" : "Apple on-device")"
    }

    // MARK: Recent list

    private func row(_ m: MeetingRecord) -> some View {
        let expanded = expandedId == m.id
        var meta = MeetDates.w(m.startedTs)
        if let e = m.endedTs { meta += " · \(max(1, Int(((e - m.startedTs) / 60_000).rounded()))) min" }
        meta += " · \(m.segmentCount) segments"
        if let a = m.appName { meta += " · \(a)" }
        return VStack(alignment: .leading, spacing: 0) {
            Button { expandedId = expanded ? nil : m.id } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text((m.title ?? "").isEmpty ? "Untitled meeting" : m.title!).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                        Text(meta).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
                    }
                    Spacer(minLength: 0)
                    Glyph(name: "chevron-down", size: 16, color: Theme.mutedForeground).rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .testID("meeting-row-\(m.id)")
            if expanded {
                CapDivider()
                VStack(alignment: .leading, spacing: 0) {
                    if let sum = m.summary, !sum.isEmpty {
                        MarkdownView(text: sum, baseSize: 14)
                    } else {
                        CapText(text: "No summary was generated for this meeting.")
                    }
                    MeetingTranscriptPanel(meetingId: m.id, live: false).padding(.top, 16)
                    HStack(spacing: 4) {
                        Spacer(minLength: 0)
                        if let dir = MeetingPaths.existingAudioDir(m.id) {
                            Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dir)]) } label: {
                                CapIconLabel(icon: "folder-open", title: "Show audio files", color: Theme.mutedForeground)
                            }
                            .buttonStyle(CapButtonStyle(variant: .ghost, color: Theme.mutedForeground))
                            .testID("meeting-audio-\(m.id)")
                        }
                        Button {
                            MeetingEngine.shared.delete(m.id)
                            reload()
                        } label: { MeetingDeleteLabel() }
                            .buttonStyle(CapButtonStyle(variant: .ghost, color: Theme.mutedForeground, hoverColor: Theme.destructive))
                            .testID("meeting-delete-\(m.id)")
                    }
                    .padding(.top, 8)
                }
                .padding(12)
            }
        }
        .padding(1)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }
}

private struct MeetingDeleteLabel: View {
    var body: some View {
        HStack(spacing: 6) {
            Glyph(name: "trash-2", size: 14, color: Theme.mutedForeground)
            Text("Delete").lineBox(20.02)
        }
    }
}

// MARK: - Transcript panel

struct MeetingTranscriptPanel: View {
    let meetingId: String
    var live = false
    @Environment(\.colorScheme) private var scheme
    @State private var segments: [MeetingSegmentRecord] = []
    @State private var partials: [String: MeetingSegmentRecord] = [:]
    @State private var query = ""
    @State private var copied = false
    @State private var contentHeight: CGFloat = 0
    @State private var bodyWidth: CGFloat = 600
    @State private var listener = UUID()
    @State private var timer: Timer?

    private var filtered: [MeetingSegmentRecord] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? segments : segments.filter { $0.text.lowercased().contains(needle) }
    }

    var body: some View {
        let dark = scheme == .dark
        VStack(spacing: 0) {
            header(dark)
            Rectangle().fill(MeetColors.headerBorder(dark)).frame(height: 1)
            ScrollView {
                content(dark)
                    .padding(.horizontal, 12).padding(.vertical, 16)
                    .background(GeometryReader { g in
                        Color.clear.preference(key: MeetHeightKey.self, value: g.size.height)
                            .onAppear { bodyWidth = g.size.width - 24 }
                            .onChange(of: g.size.width) { bodyWidth = g.size.width - 24 }
                    })
            }
            .scrollIndicators(.automatic)
            .frame(height: min(max(contentHeight, 1), 320))
            .onPreferenceChange(MeetHeightKey.self) { contentHeight = $0 }
        }
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 14).fill(MeetColors.panelBg(dark)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(MeetColors.panelBorder(dark), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onAppear(perform: appear)
        .onDisappear(perform: disappear)
    }

    private func header(_ dark: Bool) -> some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                if live { MeetingLiveBars() }
                Text(live ? "Live transcript" : "Transcript").font(.system(size: 12, weight: .semibold)).tracking(-0.3).foregroundStyle(Theme.foreground).lineBox(16.2)
            }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                ZStack(alignment: .leading) {
                    TextField("", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.foreground)
                        .background(alignment: .leading) {
                            if query.isEmpty { Text("Search transcript").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).allowsHitTesting(false) }
                        }
                        .padding(.leading, 28).padding(.trailing, 10)
                        .frame(width: 160, height: 28)
                        .background(RoundedRectangle(cornerRadius: 8).fill(MeetColors.searchBg(dark)))
                        .testID("meeting-transcript-search")
                    Glyph(name: "search", size: 12, color: Theme.mutedForeground).padding(.leading, 8).allowsHitTesting(false)
                }
                Button(action: copyAll) {
                    HStack(spacing: 6) {
                        Glyph(name: copied ? "check" : "copy", size: 12, color: Theme.mutedForeground)
                        Text(copied ? "Copied" : "Copy all").lineBox(16.2)
                    }
                }
                .buttonStyle(CapButtonStyle(variant: .ghost, height: 28, horizontal: 8, fontSize: 12, color: Theme.mutedForeground))
                .disabled(segments.isEmpty)
                .testID("meeting-transcript-copy")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    @ViewBuilder
    private func content(_ dark: Bool) -> some View {
        let rows = filtered
        let ghost = live && query.trimmingCharacters(in: .whitespaces).isEmpty ? partials.values.sorted { $0.ts < $1.ts } : []
        VStack(spacing: 12) {
            if rows.isEmpty {
                Text("Listening for the first words…").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                    .frame(maxWidth: .infinity, minHeight: 96)
            } else {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, seg in bubbleRow(seg, dark) }
            }
            ForEach(ghost, id: \.source) { p in
                let mine = p.source == "mic"
                HStack(spacing: 0) {
                    if mine { Spacer(minLength: 0) }
                    bubble(p.text, mine: mine, dark: dark).italic().opacity(0.6)
                    if !mine { Spacer(minLength: 0) }
                }
            }
        }
    }

    private func bubbleRow(_ seg: MeetingSegmentRecord, _ dark: Bool) -> some View {
        let mine = seg.source == "mic"
        return HStack(spacing: 0) {
            if mine { Spacer(minLength: 0) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(mine ? "YOU" : "THEM").font(.system(size: 11, weight: .medium)).tracking(0.88)
                    Text(MeetDates.t(seg.ts)).font(.system(size: 11)).opacity(0.7)
                }
                .foregroundStyle(Theme.mutedForeground)
                .lineBox(15.4)
                .padding(.horizontal, 4)
                bubble(seg.text, mine: mine, dark: dark)
            }
            .frame(maxWidth: max(0, bodyWidth * 0.86), alignment: mine ? .trailing : .leading)
            if !mine { Spacer(minLength: 0) }
        }
    }

    private func bubble(_ text: String, mine: Bool, dark: Bool) -> some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: mine ? 16 : 8, bottomTrailingRadius: mine ? 8 : 16, topTrailingRadius: 16)
        return Text(text)
            .font(.system(size: 13))
            .lineSpacing(21.125 - 15.5)
            .foregroundStyle(mine ? MeetColors.mineFg(dark) : Theme.foreground)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 10.55)
            .background(shape.fill(mine ? MeetColors.mineBg(dark) : MeetColors.theirsBg(dark)).shadow(color: .black.opacity(0.04), radius: 1, y: 1))
            .textSelection(.enabled)
    }

    private func appear() {
        refresh()
        guard live else { return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: true) { _ in Task { @MainActor in refresh() } }
        let id = meetingId
        MeetingEngine.shared.captionListeners[listener] = { c in
            guard c.meetingId == id else { return }
            if c.kind == "final" || c.text.trimmingCharacters(in: .whitespaces).isEmpty {
                partials[c.source] = nil
            } else {
                partials[c.source] = MeetingSegmentRecord(ts: c.ts, source: c.source, text: c.text)
            }
            if c.kind == "final" { refresh() }
        }
    }

    private func disappear() {
        timer?.invalidate()
        timer = nil
        MeetingEngine.shared.captionListeners[listener] = nil
    }

    private func refresh() {
        let next = MeetingEngine.shared.transcript(meetingId)
        if next != segments { segments = next }
    }

    private func copyAll() {
        let text = segments.map { "\($0.source == "mic" ? "You" : "Them"): \($0.text)" }.joined(separator: "\n\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

private struct MeetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Four pulsing emerald bars (h-3 items-end gap-px, heights 7/11/5/9).
private struct MeetingLiveBars: View {
    @State private var dim = false
    var body: some View {
        HStack(alignment: .bottom, spacing: 1) {
            ForEach(Array([7.0, 11, 5, 9].enumerated()), id: \.offset) { i, h in
                Capsule().fill(MeetColors.emerald600).frame(width: 2, height: h)
                    .opacity(dim ? 0.5 : 1)
                    .animation(.easeInOut(duration: 1).repeatForever().delay(Double(i) * 0.12), value: dim)
            }
        }
        .frame(height: 12, alignment: .bottom)
        .onAppear { dim = true }
    }
}
