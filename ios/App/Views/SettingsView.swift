import CetusRemoteKit
import SwiftUI

struct SettingsView: View {
    @Environment(RemoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = false
    @State private var forgetting: PairedHost?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.hosts) { host in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(host.macName)
                                Text("Paired \(host.pairedAt, format: .dateTime.year().month().day())")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if host.sid == store.selectedHostId {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { store.selectedHostId = host.sid }
                        .swipeActions {
                            Button("Forget", role: .destructive) { forgetting = host }
                        }
                    }
                    Button("Pair Another Mac…", systemImage: "qrcode.viewfinder") { pairing = true }
                } header: {
                    Text("Macs")
                } footer: {
                    Text("Messages travel end-to-end encrypted through relay.cetus.run, which only forwards ciphertext. To revoke this iPhone from the Mac, use Cetus → Settings → Remote Access.")
                }
                Section("About") {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $pairing) { NavigationStack { PairView() } }
            .confirmationDialog(
                "Forget \(forgetting?.macName ?? "this Mac")?",
                isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                titleVisibility: .visible
            ) {
                Button("Forget", role: .destructive) {
                    if let h = forgetting { store.forget(h) }
                }
            } message: {
                Text("You'll need to scan the QR code again to reconnect.")
            }
        }
    }
}
