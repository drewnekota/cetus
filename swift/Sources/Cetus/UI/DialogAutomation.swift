import AppKit
import SwiftUI

/// Cetus's automation-dialog.tsx: breadcrumb header, Name / Prompt / Schedule
/// form, a metadata bar (workspace, runtime, model) and a footer with the hint
/// or validation error plus Cancel / Create. Mounted through DialogHost.
struct AutomationEditor: View {
    @Environment(AppState.self) private var app
    /// The automation being edited; createdAt == 0 means "new".
    let draft: Automation
    let onClose: () -> Void

    @State private var name = ""
    @State private var prompt = ""
    @State private var backend = "pi"
    @State private var model = ""
    @State private var effort = ""
    @State private var workspaceDir = ""
    @State private var mode = "daily"
    @State private var intervalValue = "1"
    @State private var intervalUnit = "hours"
    @State private var lastValidInterval = 1
    @State private var dailyTime = "09:00"
    @State private var weekdays: [Int] = []
    @State private var onceAt = Date().addingTimeInterval(3600)
    @State private var cronExpr = "0 9 * * *"
    @State private var error: String?
    @State private var loaded = false

    @State private var workspaceFrame = CGRect.zero
    @State private var runtimeFrame = CGRect.zero
    @State private var modelFrame = CGRect.zero
    @State private var unitFrame = CGRect.zero
    @FocusState private var focus: Field?
    enum Field: Hashable { case name, prompt, interval, time, once, cron }

    private var isNew: Bool { draft.createdAt == 0 }
    private var canSubmit: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        GeometryReader { g in
            VStack(spacing: 0) {
                DialogBreadcrumb(icon: "clock", root: "Automation", leaf: isNew ? "New" : "Edit") { EmptyView() }
                ScrollView {
                    form.padding(.horizontal, 20).padding(.vertical, 16)
                }
                .scrollIndicators(.never)
                .fixedSize(horizontal: false, vertical: true)
                metadataBar
                footer
            }
            .frame(width: min(672, g.size.width * 0.9))
            .frame(maxHeight: g.size.height * 0.88)
            .fixedSize(horizontal: false, vertical: true)
            .dialogSurface()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear(perform: load)
        .testID("automation-dialog")
    }

    // MARK: - Form

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                label("Name")
                AutoInput(text: $name, placeholder: "Daily news digest", focused: focus == .name)
                    .focused($focus, equals: .name)
                        .focusOnTap(focus == .name) { focus = .name }
                    .testID("automation-name")
            }
            VStack(alignment: .leading, spacing: 6) {
                label("Prompt")
                AutoTextArea(text: $prompt, placeholder: "What should the agent do each time this runs?", focused: focus == .prompt)
                    .focused($focus, equals: .prompt)
                        .focusOnTap(focus == .prompt) { focus = .prompt }
                    .testID("automation-prompt")
            }
            VStack(alignment: .leading, spacing: 8) {
                label("Schedule")
                modeTabs
                schedulePanel
            }
        }
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
    }

    private var modeTabs: some View {
        HStack(spacing: 0) {
            ForEach([("interval", "Interval"), ("daily", "Daily"), ("once", "Once"), ("cron", "Cron")], id: \.0) { id, title in
                ModeTab(title: title, selected: mode == id) { mode = id }
                    .testID("automation-mode-\(id)")
            }
        }
        .padding(2)
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.border, lineWidth: 1))
    }

    private var schedulePanel: some View {
        Group {
            switch mode {
            case "interval":
                HStack(spacing: 8) {
                    Text("Every").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineBox(20.02)
                    AutoInput(text: $intervalValue, placeholder: "", focused: focus == .interval, height: 32, numeric: true)
                        .focused($focus, equals: .interval)
                        .focusOnTap(focus == .interval) { focus = .interval }
                        .overlay(alignment: .trailing) {
                            NativeSpinner(up: { step(1) }, down: { step(-1) }).padding(.trailing, 11)
                        }
                        .frame(width: 80)
                        .onChange(of: intervalValue) { _, v in if let n = Int(v.trimmingCharacters(in: .whitespaces)), n >= 1 { lastValidInterval = n } }
                        .onChange(of: focus) { old, _ in if old == .interval { intervalValue = "\(Int(intervalValue.trimmingCharacters(in: .whitespaces)).map { max(1, $0) } ?? lastValidInterval)" } }
                        .testID("automation-interval")
                    unitSelect
                }
            case "once":
                HStack(spacing: 8) {
                    Text("On").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineBox(20.02)
                    AutoDateField(date: $onceAt, time: false, focused: focus == .once)
                        .focused($focus, equals: .once)
                        .focusOnTap(focus == .once) { focus = .once }
                        .frame(width: 240)
                        .testID("automation-once")
                }
            case "cron":
                VStack(alignment: .leading, spacing: 6) {
                    AutoInput(text: $cronExpr, placeholder: "0 9 * * 1-5", focused: focus == .cron, height: 32, mono: true)
                        .focused($focus, equals: .cron)
                        .focusOnTap(focus == .cron) { focus = .cron }
                        .testID("automation-cron")
                    (Text("Standard 5-field cron (min hour day month weekday), local time. e.g. ")
                        + Text("0 9 * * 1-5").font(.system(size: 12, design: .monospaced))
                        + Text(" = weekdays at 9am."))
                        .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                        .lineSpacing(16.2 - 14.3).frame(minHeight: 16.2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            default:
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Text("At").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineBox(20.02)
                        AutoTimeField(time: $dailyTime, focused: focus == .time)
                            .focused($focus, equals: .time)
                        .focusOnTap(focus == .time) { focus = .time }
                            .frame(width: 128)
                            .testID("automation-time")
                    }
                    HStack(spacing: 4) {
                        ForEach(0 ..< 7, id: \.self) { d in
                            WeekdayDot(letter: ["S", "M", "T", "W", "T", "F", "S"][d], on: weekdays.contains(d)) {
                                if let i = weekdays.firstIndex(of: d) { weekdays.remove(at: i) } else { weekdays.append(d) }
                            }
                            .help(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
                            .testID("automation-weekday-\(d)")
                        }
                    }
                    Text(weekdays.isEmpty ? "Runs every day." : "Runs only on the selected days.")
                        .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.border, lineWidth: 1))
    }

    /// Native <select> h-8: input border, transparent, px-2, 14px.
    private var unitSelect: some View {
        Button {
            if app.popup?.id == "automation-unit" { app.popup = nil; return }
            let items = ["minutes", "hours", "days"].map { u in
                MenuItem(id: u, title: u, checked: intervalUnit == u, testID: "automation-unit-\(u)") { app.popup = nil; intervalUnit = u }
            }
            app.popup = PopupSpec(id: "automation-unit", anchor: unitFrame, style: .select,
                                  content: AnyView(MenuList(items: items, style: .select, minWidth: unitFrame.width, textSize: 14)))
        } label: {
            // WebKit's native menulist: 14px text at px-2, bold up/down chevrons, radius 5.
            Text(intervalUnit).font(.system(size: 14)).foregroundStyle(Theme.foreground).lineBox(20.02)
                .padding(.leading, 9)
                .frame(width: 85, height: 32, alignment: .leading)
                .overlay(alignment: .trailing) { NativeChevrons().padding(.trailing, 7) }
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.input, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .readFrame($unitFrame)
        .testID("automation-unit")
    }

    private func step(_ d: Int) {
        intervalValue = "\(max(1, (Int(intervalValue) ?? 1) + d))"
    }

    // MARK: - Metadata bar

    private var metadataBar: some View {
        HStack(spacing: 8) {
            AutoPill(chevron: 16, chevronOpacity: 0.5, gap: 6) {
                Glyph(name: ComposerView.isChatWorkspace(workspaceDir) ? "message-square" : "folder", size: 12, color: Theme.mutedForeground)
                Text(ComposerView.workspaceLabel(workspaceDir)).lineLimit(1)
            } action: { toggle("automation-workspace", frame: workspaceFrame, style: .select, content: AnyView(MenuList(items: workspaceMenu(), style: .select, minWidth: workspaceFrame.width, maxWidth: 352))) }
                .readFrame($workspaceFrame)
                .testID("automation-workspace")
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                AutoPill(chevron: 16, chevronOpacity: 0.5, gap: 6) {
                    RuntimeIcon(id: backend, size: 12)
                    Text(Runtimes.byId(backend).label).lineLimit(1)
                } action: { toggle("automation-runtime", frame: runtimeFrame, style: .select, alignEnd: true, content: AnyView(MenuList(items: runtimeMenu(), style: .select, minWidth: runtimeFrame.width))) }
                    .readFrame($runtimeFrame)
                    .testID("automation-runtime")
                if Runtimes.hasModelMenu(backend) {
                    AutoPill(chevron: 12, chevronOpacity: 0.6, gap: 4) {
                        Text(tuningLabel).lineLimit(1)
                    } action: { toggle("automation-model", frame: modelFrame, style: .dropdown, alignEnd: true, content: AnyView(MenuList(items: modelMenu(), style: .dropdown, minWidth: 176))) }
                        .readFrame($modelFrame)
                        .testID("automation-model")
                }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .padding(.top, 1)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let error {
                Text(error).font(.system(size: 12)).foregroundStyle(Theme.destructive).lineBox(16.2).testID("automation-error")
            } else {
                Text("Each run starts a fresh task in the chosen workspace.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            }
            Spacer(minLength: 0)
            Button("Cancel", action: onClose)
                .buttonStyle(CetusButtonStyle(variant: .ghost, height: 32))
                .testID("automation-cancel")
            Button(action: submit) {
                HStack(spacing: 6) {
                    Text(isNew ? "Create automation" : "Save changes").lineBox(20.02)
                    HStack(spacing: 2) {
                        Glyph(name: "command", size: 12, color: Theme.primaryForeground.opacity(0.7))
                        Glyph(name: "corner-down-left", size: 12, color: Theme.primaryForeground.opacity(0.7))
                    }
                    .padding(.horizontal, 6).padding(.vertical, 2).padding(1)
                    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.primaryForeground.opacity(0.1)))
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.primaryForeground.opacity(0.2), lineWidth: 1))
                }
            }
            .buttonStyle(CetusButtonStyle(variant: .primary, height: 32))
            .disabled(!canSubmit)
            .testID("automation-save")
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .padding(.top, 1)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    // MARK: - Menus

    private func toggle(_ id: String, frame: CGRect, style: MenuStyle, alignEnd: Bool = false, content: AnyView) {
        if app.popup?.id == id { app.popup = nil; return }
        app.popup = PopupSpec(id: id, anchor: frame, style: style, alignEnd: alignEnd, content: content)
    }

    private func close(_ f: @escaping () -> Void) -> () -> Void { { app.popup = nil; f() } }

    private func workspaceMenu() -> [MenuItem] {
        var dirs: [String] = []
        for d in [workspaceDir, Env.chatDir] + app.prefs.recentWorkspaces where !dirs.contains(d) && !d.isEmpty { dirs.append(d) }
        var items = dirs.enumerated().map { i, d in
            let chat = ComposerView.isChatWorkspace(d)
            return MenuItem(id: d, title: ComposerView.workspaceLabel(d),
                            icon: AnyView(Glyph(name: chat ? "message-square" : "folder", size: 16)),
                            checked: d == workspaceDir || (chat && ComposerView.isChatWorkspace(workspaceDir)),
                            testID: chat ? "automation-workspace-chat" : "automation-workspace-\(i)",
                            action: close { workspaceDir = chat ? "" : d })
        }
        items.append(MenuItem(id: "choose", title: "Add folder…", icon: AnyView(Glyph(name: "folder-plus", size: 16)), group: " ", testID: "automation-workspace-choose", muted: true,
                              action: close { chooseFolder() }))
        return items
    }

    private func runtimeMenu() -> [MenuItem] {
        var rows = Runtimes.ordered(app.prefs)
        if !rows.contains(where: { $0.id == backend }) { rows.append(Runtimes.byId(backend)) }
        return rows.enumerated().map { i, r in
            MenuItem(id: r.id, title: r.label, icon: AnyView(RuntimeIcon(id: r.id, size: 16)), checked: r.id == backend,
                     hint: i < 9 ? Shortcuts.hint("runtime\(i + 1)", app.prefs) : nil, testID: "automation-runtime-\(i)",
                     action: close {
                         guard backend != r.id else { return }
                         backend = r.id
                         if r.id == "pi" { let t = app.prefs.tuning["pi"]; model = t?.model ?? ""; effort = t?.effort ?? "" } else { model = ""; effort = "" }
                     })
        }
    }

    private var runtime: Runtime { Runtimes.byId(backend) }
    private var currentModel: Option? {
        if backend == "pi" {
            if model.isEmpty || model == "flash" || model == "pro" { return runtime.models.first }
            return Option(id: model, label: model.split(separator: "/").dropFirst().joined(separator: "/").nonEmpty ?? model)
        }
        return runtime.models.first { $0.id == model }
    }
    private var currentEffort: Option? {
        if backend == "pi" {
            let axis = Runtimes.piReasoningAxis
            let want = axis.contains(effort) ? effort : "high"
            guard currentModel?.id == "flash" else { return nil }
            let i = axis.firstIndex(of: want)!
            for id in Array(axis[i...]) + axis[..<i].reversed() { if let hit = runtime.efforts.first(where: { $0.id == id }) { return hit } }
            return nil
        }
        return runtime.efforts.first { $0.id == effort }
    }
    private var tuningLabel: String {
        if backend == "pi" { return [currentModel?.label ?? "Flash", currentEffort?.label].compactMap { $0 }.joined(separator: " · ") }
        let m = currentModel?.label ?? (model.isEmpty ? "Default" : model)
        return currentEffort.map { "\(m) · \($0.label)" } ?? m
    }

    private func modelMenu() -> [MenuItem] {
        let pi = backend == "pi"
        let effortRows = pi && currentModel?.id != "flash" ? [] : runtime.efforts
        let efforts = effortRows.enumerated().map { i, e in
            MenuItem(id: "e:\(e.id)", title: e.label, checked: e.id == currentEffort?.id, group: "Reasoning", testID: "automation-effort-\(i)",
                     action: close { effort = e.id })
        }
        let models = runtime.models.enumerated().map { i, m in
            MenuItem(id: "m:\(m.id)", title: m.label, icon: pi ? AnyView(Glyph(name: "zap", size: 16, color: Theme.foreground)) : nil,
                     checked: m.id == currentModel?.id, group: "Model", testID: "automation-model-\(i)",
                     action: close { model = m.id })
        }
        let shown = currentModel?.label ?? (model.isEmpty ? "Default" : model)
        return efforts + [MenuItem(id: "models", title: shown, group: efforts.isEmpty ? nil : " ", testID: "automation-model-sub", submenu: models)]
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        if panel.runModal() == .OK, let d = panel.url?.path {
            app.controller.prefStore.touchWorkspace(d)
            workspaceDir = d
        }
    }

    // MARK: - Load / submit

    private func load() {
        guard !loaded else { return }
        loaded = true
        name = draft.name
        prompt = draft.prompt
        workspaceDir = ComposerView.isChatWorkspace(draft.workspaceDir) ? "" : draft.workspaceDir
        if isNew {
            // Create defaults: the built-in runtime with the app's model choice.
            backend = "pi"
            let t = app.selection.runtime == "pi" ? (model: app.selection.model, effort: app.selection.effort) : (model: app.prefs.tuning["pi"]?.model ?? "", effort: app.prefs.tuning["pi"]?.effort ?? "")
            model = t.model
            effort = t.effort
            workspaceDir = ""
        } else {
            backend = draft.backend
            model = draft.model
            effort = draft.effort
        }
        switch draft.schedule {
        case .daily(let t, let w): mode = "daily"; dailyTime = t; weekdays = w
        case .interval: if case .interval(let e, let u) = Schedule.interval(minutes: draft.schedule.everyMinutes) { mode = "interval"; intervalValue = "\(e)"; intervalUnit = u; lastValidInterval = e }
        case .once(let at): mode = "once"; onceAt = Date(timeIntervalSince1970: at / 1000)
        case .cron(let expr): mode = "cron"; cronExpr = expr
        }
        DialogHost.onSubmit = { submit() }
        DispatchQueue.main.async { focus = .name }
    }

    private func submit() {
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { error = "A prompt is required."; return }
        let schedule: Schedule
        switch mode {
        case "interval":
            // NumberInput: an out-of-range draft never reaches the value; it keeps the last valid one.
            let v = Int(intervalValue.trimmingCharacters(in: .whitespaces)).flatMap { $0 >= 1 ? $0 : nil } ?? lastValidInterval
            guard v >= 1 else { error = "Interval must be at least 1."; return }
            schedule = .interval(minutes: v * (intervalUnit == "days" ? 1440 : intervalUnit == "hours" ? 60 : 1))
        case "once":
            schedule = .once(at: (onceAt.timeIntervalSince1970 * 1000).rounded(.down))
        case "cron":
            let expr = cronExpr.trimmingCharacters(in: .whitespacesAndNewlines)
            guard expr.split(whereSeparator: \.isWhitespace).count == 5 else { error = "Cron needs 5 fields: min hour day month weekday."; return }
            schedule = .cron(expr: expr)
        default:
            guard dailyTime.range(of: #"^\d{1,2}:\d{2}$"#, options: .regularExpression) != nil else { error = "Enter a time as HH:MM."; return }
            schedule = .daily(time: dailyTime, weekdays: weekdays.sorted())
        }
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = AutomationInput(name: n.isEmpty ? (String(p.split(separator: "\n", omittingEmptySubsequences: false).first?.prefix(60) ?? "").nonEmpty ?? "Automation") : n,
                                    prompt: p, workspaceDir: workspaceDir, backend: backend,
                                    model: model, effort: backend == "pi" ? effort : effort, schedule: schedule, enabled: isNew ? true : draft.enabled)
        error = nil
        let result = isNew ? AutomationScheduler.create(app.controller, input) : AutomationScheduler.update(app.controller, id: draft.id, input)
        switch result {
        case .success: onClose()
        case .failure(let e): error = e.message
        }
    }
}

// MARK: - Controls

/// Mode tab: flex-1, rounded-md px-2.5 py-1 text-xs medium; active = foreground fill.
private struct ModeTab: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .medium))
                .foregroundStyle(selected ? Theme.background : hover ? Theme.foreground : Theme.mutedForeground)
                .lineBox(16.2)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.foreground : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// size-7 rounded-full weekday toggle.
private struct WeekdayDot: View {
    let letter: String
    let on: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(letter).font(.system(size: 12, weight: .medium))
                .foregroundStyle(on ? Theme.background : hover ? Theme.foreground : Theme.mutedForeground)
                .frame(width: 28, height: 28)
                .background(Circle().fill(on ? Theme.foreground : Theme.card))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// SelectTrigger size sm (h-7 px-2 text-xs, muted → foreground + muted fill on hover).
struct AutoPill<Content: View>: View {
    var chevron: CGFloat
    var chevronOpacity: Double
    var gap: CGFloat
    @ViewBuilder var content: Content
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: gap) {
                HStack(spacing: 6) { content }
                Glyph(name: "chevron-down", size: chevron, color: hover ? Theme.foreground : Theme.mutedForeground).opacity(chevronOpacity)
            }
            .font(.system(size: 12))
            .foregroundStyle(hover ? Theme.foreground : Theme.mutedForeground)
            .lineBox(16.2)
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.muted : .clear))
            .contentShape(Rectangle())
            .fixedSize()
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// shadcn Input field chrome: rounded-md border-input, dark:bg-input/30,
/// shadow-xs; focus = ring border + 3px ring/50 halo.
struct AutoFieldChrome: ViewModifier {
    var focused: Bool
    var height: CGFloat?
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .frame(height: height)
            .background(
                RoundedRectangle(cornerRadius: 6).fill(scheme == .dark ? Theme.input.opacity(0.3) : .clear)
                    .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
            )
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(focused ? Theme.primary : Theme.input, lineWidth: 1))
            .overlay(RoundedRectangle(cornerRadius: 6).inset(by: -1.5).stroke(Theme.primary.opacity(focused ? 0.5 : 0), lineWidth: 3))
    }
}

struct AutoInput: View {
    @Binding var text: String
    let placeholder: String
    var focused: Bool
    var height: CGFloat = 36
    var mono = false
    var numeric = false
    var body: some View {
        let font: Font = mono ? .system(size: 14, design: .monospaced) : .system(size: 14)
        // NSTextField paints its own (lighter) placeholder color; draw it ourselves.
        TextField("", text: $text)
            .textFieldStyle(.plain)
            .font(font)
            .foregroundStyle(Theme.foreground)
            .background(alignment: .leading) {
                if text.isEmpty { Text(placeholder).font(font).foregroundStyle(Theme.mutedForeground).padding(.leading, 0.5).allowsHitTesting(false) }
            }
            .padding(.leading, mono ? 0.5 : 0)
            .padding(.horizontal, 10.5)
            .modifier(AutoFieldChrome(focused: focused, height: height))
    }
}

/// Textarea rows=4 min-h-[96px]: px-2.5 py-2, 14px / 20px lines.
struct AutoTextArea: View {
    @Binding var text: String
    let placeholder: String
    var focused: Bool
    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                    .lineBox(20.02).padding(.horizontal, 11).padding(.top, 9)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.foreground)
                .lineSpacing(20.02 - 16.7)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .padding(.horizontal, 6).padding(.top, 10.5).padding(.bottom, 7.5)
        }
        .frame(height: 96)
        .modifier(AutoFieldChrome(focused: focused, height: 96))
    }
}

/// <input type="time"> (WebKit: "09:00 AM"). Edits as text; commits HH:MM.
struct AutoTimeField: View {
    @Binding var time: String
    var focused: Bool
    @State private var text = ""
    var body: some View {
        ZStack(alignment: .leading) {
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Theme.foreground)
                .opacity(focused ? 1 : 0)
            if !focused { segments.allowsHitTesting(false) }
        }
        .padding(.horizontal, 11)
        .modifier(AutoFieldChrome(focused: focused, height: 32))
        .onAppear { text = Self.display(time) }
            .onChange(of: time) { _, t in if Self.parse(text) != t { text = Self.display(t) } }
            .onChange(of: text) { _, s in if let t = Self.parse(s) { time = t } }
            .onSubmit { text = Self.display(time) }
    }

    /// WebKit's time field: editable segments, the ":" separator padded ~1.5pt a side.
    private var segments: some View {
        let parts = Self.display(time).split(separator: " ")
        let hm = parts.first.map { $0.split(separator: ":").map(String.init) } ?? []
        return HStack(spacing: 0) {
            Text(hm.first ?? "--")
            Text(":").padding(.leading, 1.5).padding(.trailing, 0.5)
            Text(hm.count > 1 ? hm[1] : "--")
            Text(" " + (parts.count > 1 ? String(parts[1]) : "")).padding(.leading, 0.5)
        }
        .font(.system(size: 14)).monospacedDigit().foregroundStyle(Theme.foreground)
        .padding(.leading, 1.5)
    }

    static func display(_ hhmm: String) -> String {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        guard p.count == 2 else { return hhmm }
        let h12 = p[0] % 12 == 0 ? 12 : p[0] % 12
        return String(format: "%02d:%02d %@", h12, p[1], p[0] < 12 ? "AM" : "PM")
    }

    static func parse(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces).uppercased()
        guard let m = t.range(of: #"^(\d{1,2}):(\d{2})\s*(AM|PM)?$"#, options: .regularExpression) else { return nil }
        let str = String(t[m])
        let digits = str.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        guard digits.count >= 2, digits[1] < 60 else { return nil }
        var h = digits[0]
        if str.hasSuffix("PM") { guard h <= 12 else { return nil }; h = h % 12 + 12 } else if str.hasSuffix("AM") { guard h <= 12 else { return nil }; h = h % 12 }
        guard h < 24 else { return nil }
        return String(format: "%02d:%02d", h, digits[1])
    }
}

/// <input type="datetime-local"> (WebKit: "10/14/2026, 03:05 PM").
struct AutoDateField: View {
    @Binding var date: Date
    var time: Bool
    var focused: Bool
    @State private var text = ""
    private static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MM/dd/yyyy, hh:mm a"
        return f
    }()
    var body: some View {
        ZStack(alignment: .leading) {
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Theme.foreground)
                .opacity(focused ? 1 : 0)
            if !focused { segments.allowsHitTesting(false) }
        }
        .padding(.horizontal, 10.5)
        .modifier(AutoFieldChrome(focused: focused, height: 32))
        .onAppear { text = Self.fmt.string(from: date) }
        .onChange(of: text) { _, s in if let d = Self.fmt.date(from: s) { date = d } }
        .onSubmit { text = Self.fmt.string(from: date) }
    }

    /// WebKit's datetime-local field: "10 / 14 / 2026 , 12 : 50 PM" with padded separators.
    private var segments: some View {
        let s = Self.fmt.string(from: date)
        return HStack(spacing: 0) {
            ForEach(Array(Self.tokens(s).enumerated()), id: \.offset) { _, t in
                switch t {
                case "/": Text("/").padding(.leading, 2).padding(.trailing, 1.5)
                case ",": Text(",").padding(.leading, 1).padding(.trailing, 1.5)
                case ":": Text(":").padding(.leading, 3).padding(.trailing, 1.5)
                case " ": Text(" ")
                default: Text(t).padding(.leading, t.first?.isLetter == true ? 0.5 : 0)
                }
            }
        }
        .font(.system(size: 14)).foregroundStyle(Theme.foreground)
        .padding(.leading, 3.5)
    }

    static func tokens(_ s: String) -> [String] {
        var out: [String] = [], cur = ""
        for c in s {
            if "/,: ".contains(c) { if !cur.isEmpty { out.append(cur); cur = "" }; out.append(String(c)) } else { cur.append(c) }
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }
}

/// WebKit's <input type=number> spin button: 14×17 rounded well, divider, two chevrons.
private struct NativeSpinner: View {
    let up: () -> Void
    let down: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            Button(action: up) { chevron(flip: false) }.buttonStyle(.plain)
            Button(action: down) { chevron(flip: true) }.buttonStyle(.plain)
        }
        .background(RoundedRectangle(cornerRadius: 2.5).fill(Theme.foreground.opacity(0.052)))
        .overlay(Rectangle().fill(Theme.foreground.opacity(0.06)).frame(width: 12, height: 1.5))
        .frame(width: 14, height: 17)
    }
    private func chevron(flip: Bool) -> some View {
        Path { p in
            p.move(to: CGPoint(x: 3, y: 6)); p.addLine(to: CGPoint(x: 7, y: 2)); p.addLine(to: CGPoint(x: 11, y: 6))
        }
        .stroke(Theme.foreground, style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
        .frame(width: 14, height: 8.5)
        .scaleEffect(x: 1, y: flip ? -1 : 1)
        .contentShape(Rectangle())
    }
}

/// The native <select>'s bold up/down chevron pair (8×10).
struct NativeChevrons: View {
    var color: Color = Theme.foreground
    var body: some View {
        Path { p in
            p.move(to: CGPoint(x: 0.75, y: 3.75)); p.addLine(to: CGPoint(x: 4, y: 0.75)); p.addLine(to: CGPoint(x: 7.25, y: 3.75))
            p.move(to: CGPoint(x: 0.75, y: 6.25)); p.addLine(to: CGPoint(x: 4, y: 9.25)); p.addLine(to: CGPoint(x: 7.25, y: 6.25))
        }
        .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        .frame(width: 8, height: 10)
    }
}

extension View {
    /// Focus a field on the first click even while the window is in the
    /// background (AppKit text views ignore that click: no acceptsFirstMouse).
    func focusOnTap(_ focused: Bool, _ focus: @escaping () -> Void) -> some View {
        overlay {
            // A Button (not a tap gesture): only buttons take the first mouse in a background window.
            if !focused { Button(action: focus) { Color.clear.contentShape(Rectangle()) }.buttonStyle(.plain) }
        }
    }
}
