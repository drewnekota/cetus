import CetusRemoteKit
import SwiftUI

@main
struct CetusApp: App {
    @State private var store = RemoteStore()
    @State private var pendingOffer: PairingOffer?
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView(pendingOffer: $pendingOffer)
                .environment(store)
                // System Camera scans of the QR land here (cetus://pair#…).
                .onOpenURL { url in
                    if let offer = PairingOffer.parse(url.absoluteString) { pendingOffer = offer }
                }
                .onChange(of: phase) { _, now in
                    if now == .active { store.ensureConnected() }
                }
                #if DEBUG
                // Simulator testing without a camera or taps:
                //   simctl launch … -pairLink 'cetus://pair#…' [-openChat <id>]
                .task {
                    if let link = UserDefaults.standard.string(forKey: "pairLink"),
                       let offer = PairingOffer.parse(link)
                    {
                        pendingOffer = offer
                    }
                }
                #endif
        }
    }
}

struct RootView: View {
    @Environment(RemoteStore.self) private var store
    @Binding var pendingOffer: PairingOffer?

    var body: some View {
        Group {
            if store.hosts.isEmpty {
                PairView(initialOffer: pendingOffer)
            } else {
                ConversationListView()
            }
        }
        .sheet(item: Binding(
            get: { store.hosts.isEmpty ? nil : pendingOffer },
            set: { pendingOffer = $0 }
        )) { offer in
            NavigationStack { PairView(initialOffer: offer) }
        }
        .onAppear { store.ensureConnected() }
        // An offer is single-use: once it produced a host, drop it so the
        // sheet above doesn't reopen on the consumed code.
        .onChange(of: store.hosts.count) { pendingOffer = nil }
    }
}

extension PairingOffer: Identifiable {
    public var id: String { sid + ps }
}
