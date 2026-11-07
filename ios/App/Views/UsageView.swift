import CetusRemoteKit
import SwiftUI

/// The Claude / Codex plan limits the Mac is signed into (same data as the
/// desktop's sidebar Usage popover).
struct UsageView: View {
    @Environment(RemoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var providers: [JSON] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error).foregroundStyle(.secondary).font(.footnote)
                }
                ForEach(providers.indices, id: \.self) { i in
                    ProviderSection(p: providers[i])
                }
            }
            .overlay { if loading && providers.isEmpty { ProgressView() } }
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load(force: true) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await load(force: false) }
        }
    }

    private func load(force: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let r = try await store.request("usage.get", ["force": .bool(force)])
            let all = r["providers"].array ?? []
            let signedIn = all.filter { $0["status"].string != "signedOut" }
            providers = signedIn.isEmpty ? all : signedIn
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct ProviderSection: View {
    let p: JSON

    var body: some View {
        Section {
            if p["status"].string == "ok" {
                ForEach((p["windows"].array ?? []).indices, id: \.self) { i in
                    WindowRow(w: p["windows"][i])
                }
                ForEach((p["details"].array ?? []).indices, id: \.self) { i in
                    LabeledContent(p["details"][i]["label"].string ?? "", value: p["details"][i]["value"].string ?? "")
                        .font(.subheadline)
                }
            } else {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            HStack(spacing: 6) {
                Text(name)
                if let plan = p["plan"].string {
                    Text(plan.capitalized)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
            }
        } footer: {
            if let account = p["account"].string { Text(account) }
        }
    }

    private var name: String { p["provider"].string == "codex" ? "Codex" : "Claude" }

    private var message: String {
        switch p["status"].string {
        case "signedOut": "Not signed in to \(name) on your Mac."
        case "expired": "\(name) login expired. Run \(name) once on your Mac to refresh it."
        default: p["error"].string ?? "Unavailable"
        }
    }
}

private struct WindowRow: View {
    let w: JSON

    var body: some View {
        let pct = min(100, max(0, w["usedPct"].number ?? 0))
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(w["label"].string ?? "")
                Spacer()
                Text(w["usedPct"].isNull ? "—" : "\(Int(pct.rounded()))% used")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .font(.subheadline)
            ProgressView(value: pct, total: 100)
                .tint(pct > 90 ? .red : pct >= 70 ? .orange : .accentColor)
            if let iso = w["resetsAt"].string, let date = ISO8601DateFormatter.flexible.date(from: iso) {
                Text("Resets \(date, format: .relative(presentation: .named)) · \(date, format: .dateTime.weekday().hour().minute())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

extension ISO8601DateFormatter {
    /// Accepts both "…Z" and fractional-second timestamps.
    static let flexible = FlexibleISO8601()
}

final class FlexibleISO8601: @unchecked Sendable {
    private let plain = ISO8601DateFormatter()
    private let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func date(from s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
}
