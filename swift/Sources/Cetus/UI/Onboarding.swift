import AppKit
import SwiftUI

// First-run welcome + permission setup (components/onboarding/onboarding.tsx).
// Shown once, gated by a "done" flag (localStorage `cetus:onboardingDone` in
// Cetus; a marker file in this app's data dir here). Step 1 shows every runtime's
// readiness; step 2 reuses the Settings → Permissions rows.

@Observable
@MainActor
final class OnboardingModel {
    static let shared = OnboardingModel()
    var show: Bool
    var step = 0
    var deepseekReady: Bool?
    var cliStatus: [String: Bool]?
    var showKeyInput = false
    var key = ""
    var saving = false
    var keyError: String?
    var permissions: [String: Bool] = [:]

    static var flag: URL { Env.dataDir.appendingPathComponent("onboarding-done") }

    init() {
        // Comparison instances start with a fresh data dir; keep them out of first-run
        // unless asked (CETUS_ONBOARDING=1).
        let seen = FileManager.default.fileExists(atPath: Self.flag.path)
        show = !seen && (Env.process["CETUS_CONTROL"] == nil || Env.process["CETUS_ONBOARDING"] != nil)
        if show { probe() }
    }

    func probe() {
        DispatchQueue.global().async {
            let ds = IntelData.secrets()["deepseek"] != nil
            var cli: [String: Bool] = [:]
            for r in Runtimes.all where r.id != "pi" { cli[r.id] = RuntimeStatus.installed(r.id) }
            DispatchQueue.main.async {
                self.deepseekReady = ds
                self.cliStatus = cli
            }
        }
    }

    func finish() {
        try? FileManager.default.createDirectory(at: Env.dataDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: Self.flag.path, contents: Data("1".utf8))
        show = false
    }

    func saveKey() {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty else { return }
        saving = true
        keyError = nil
        var m = IntelData.secrets()
        m["deepseek"] = k
        IntelData.writeSecrets(m)
        deepseekReady = true
        key = ""
        showKeyInput = false
        saving = false
    }

    func recheckPermissions() {
        for m in GPermissions.all { GPermissions.check(m.id) { self.permissions[m.id] = $0 } }
    }

    var allGranted: Bool { GPermissions.all.allSatisfy { permissions[$0.id] == true } }
}

/// `fixed inset-0 z-[60] bg-background`, the dialog centered.
struct OnboardingOverlay: View {
    @State private var model = OnboardingModel.shared
    var body: some View {
        if model.show {
            ZStack {
                Theme.background.ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {}
                OnboardingCard(model: model)
                    .frame(width: 672)
            }
            .testID("onboarding")
        }
    }
}

private struct OnboardingCard: View {
    @Bindable var model: OnboardingModel

    var body: some View {
        Group {
            if model.step == 0 { welcome } else { permissions }
        }
        .padding(33) // p-8 + the 1px border
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.background))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 12.5, y: 20)
        .shadow(color: .black.opacity(0.1), radius: 5, y: 8)
    }

    // MARK: Step 1

    private var welcome: some View {
        VStack(spacing: 0) {
            // font-serif text-3xl font-semibold italic: Old Standard italic with WebKit's synthetic bold.
            Text("cetus").font(SerifFont.italic(30)).foregroundStyle(Theme.foreground)
                .overlay(alignment: .leading) { Text("cetus").font(SerifFont.italic(30)).foregroundStyle(Theme.foreground).offset(x: 1) }
                .lineBox(36)
            Text("Choose how cetus thinks").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(28)
                .padding(.top, 24)
            // The card is a fixed 606pt measure, so WebKit's break is fixed too; TextKit would
            // otherwise pull "switch" down to avoid a one-word last line.
            Text("Use the built-in agent or your existing Claude Code and Codex installations. You can switch\u{2028}anytime.")
                .font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
                .gLines(14, 20.02).fixedSize(horizontal: false, vertical: true)
                .testID("onboarding-subtitle")
                .padding(.top, 8)
            grid.padding(.top, 28)
            if model.showKeyInput && model.deepseekReady != true { keyPanel.padding(.top, 12) }
            VStack(spacing: 8) {
                Button { model.step = 1; model.recheckPermissions() } label: {
                    HStack(spacing: 6) {
                        Text("Continue to permissions")
                        Glyph(name: "arrow-right", size: 16, color: Theme.primaryForeground)
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .primary, height: 36, horizontal: 16, fullWidth: true))
                .testID("onboarding-continue")
                Button("Skip for now") { model.finish() }
                    .buttonStyle(CetusButtonStyle(variant: .ghost, height: 36, horizontal: 16, fullWidth: true))
                    .testID("onboarding-skip")
            }
            .padding(.top, 24)
        }
        .frame(maxWidth: .infinity)
    }

    private var cards: [(id: String, name: String, description: String, ready: Bool?, missing: String, configure: Bool)] {
        var out: [(String, String, String, Bool?, String, Bool)] = [
            ("pi", "Cetus", "Built on pi and powered by DeepSeek for affordable everyday agent work.", model.deepseekReady, "Key needed", true),
        ]
        for r in Runtimes.all where r.id != "pi" {
            out.append((r.id, r.label, "Use the \(r.label) CLI already installed and signed in on this Mac.", model.cliStatus?[r.id], "Not installed", false))
        }
        return out.map { (id: $0.0, name: $0.1, description: $0.2, ready: $0.3, missing: $0.4, configure: $0.5) }
    }

    private var grid: some View {
        let all = cards
        let rows = stride(from: 0, to: all.count, by: 3).map { Array(all[$0 ..< min($0 + 3, all.count)]) }
        return VStack(spacing: 12) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(rows[i], id: \.id) { c in
                        RuntimeCard(id: c.id, name: c.name, description: c.description, ready: c.ready, missingLabel: c.missing,
                                    onConfigure: c.configure ? { model.showKeyInput.toggle() } : nil)
                            .frame(width: 194)
                            .frame(maxHeight: .infinity)
                    }
                    if rows[i].count < 3 { Spacer(minLength: 0) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(width: 606, alignment: .leading)
    }

    private var keyPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("DeepSeek API key").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(16.2)
            HStack(spacing: 8) {
                SecureField("sk-…", text: $model.key)
                    .textFieldStyle(.plain).font(.system(size: 14, design: .monospaced))
                    .padding(.horizontal, 12).frame(height: 36)
                    .background(RoundedRectangle(cornerRadius: 8).fill(GTheme.fieldFill))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
                    .onSubmit { model.saveKey() }
                    .testID("onboarding-deepseek-key")
                Button { model.saveKey() } label: {
                    HStack(spacing: 6) {
                        if model.saving { Spinner(size: 16, color: Theme.primaryForeground) }
                        Text("Save key")
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .primary))
                .disabled(model.key.trimmingCharacters(in: .whitespaces).isEmpty || model.saving)
                .testID("onboarding-save-key")
            }
            .padding(.top, 8)
            if let e = model.keyError { GDetail(text: e, color: Theme.destructive).padding(.top, 8) }
            GDetail(text: "Stored securely in your macOS Keychain.").padding(.top, 8)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
    }

    // MARK: Step 2

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Grant permissions").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(28)
            GDetail(text: "Grant what you'd like to use now. You can change any of these later in Settings → Permissions.", size: 14, lineHeight: 20.02)
                .padding(.top, 8)
            VStack(spacing: 0) {
                ForEach(Array(GPermissions.all.enumerated()), id: \.element.id) { i, m in
                    GPermissionRow(meta: m, status: model.permissions[m.id]) { model.permissions[m.id] = $0 }
                    if i < GPermissions.all.count - 1 { Rectangle().fill(Theme.border).frame(height: 1) }
                }
            }
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 24)
            GDetail(text: "All optional — cetus runs fine without them, and each feature only needs the ones it uses.").padding(.top, 12)
            HStack {
                Button("Back") { model.step = 0 }
                    .buttonStyle(CetusButtonStyle(variant: .ghost, height: 36, horizontal: 16))
                    .testID("onboarding-back")
                Spacer()
                Button { model.finish() } label: {
                    HStack(spacing: 6) {
                        if model.allGranted { Glyph(name: "check", size: 16, color: Theme.primaryForeground) }
                        Text("Done")
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .primary, height: 36, horizontal: 16))
                .testID("onboarding-done")
            }
            .padding(.top, 32)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in model.recheckPermissions() }
    }
}

private struct RuntimeCard: View {
    let id: String
    let name: String
    let description: String
    let ready: Bool?
    let missingLabel: String
    let onConfigure: (() -> Void)?
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                RuntimeIcon(id: id, size: 20)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
                    .padding(1)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
                Spacer(minLength: 0)
                if let ready {
                    HStack(spacing: 4) {
                        if ready { Glyph(name: "check", size: 12, color: Theme.success) }
                        Text(ready ? "Ready" : missingLabel).font(.system(size: 12, weight: .medium))
                            .foregroundStyle(ready ? Theme.success : Theme.mutedForeground).lineBox(16.2)
                    }
                } else {
                    Spinner(size: 14).padding(.top, 4)
                }
            }
            Text(name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(20.02)
                .padding(.top, 16)
            GDetail(text: description, lineHeight: 19.5).padding(.top, 4)
            if ready == false, let onConfigure {
                Spacer(minLength: 0)
                Button(action: onConfigure) {
                    Text("Configure DeepSeek key").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                        .underline(hover, pattern: .solid).lineBox(16.2)
                }
                .buttonStyle(.plain)
                .onHover { hover = $0 }
                .padding(.top, 12)
                .testID("onboarding-configure-key")
            }
        }
        .padding(17) // p-4 + the 1px border
        .frame(minHeight: 144, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14).fill(ready == true ? Theme.success.opacity(0.035) : Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(ready == true ? Theme.success.opacity(0.35) : Theme.border, lineWidth: 1))
    }
}
