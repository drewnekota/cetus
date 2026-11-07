import CetusRemoteKit
import SwiftUI
import VisionKit

/// Scan (or paste) the QR from Cetus → Settings → Remote Access on the Mac.
struct PairView: View {
    @Environment(RemoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var initialOffer: PairingOffer?

    @State private var scanning = false
    @State private var link = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 14) {
                    Image("Logo")
                        .resizable()
                        .frame(width: 72, height: 72)
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                    Text("Cetus on iPhone")
                        .font(.title2.weight(.semibold))
                    Text("Keep an eye on your agents and reply from anywhere. Everything stays end-to-end encrypted between this iPhone and your Mac.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 40)

                VStack(alignment: .leading, spacing: 14) {
                    Step(n: 1, text: "On your Mac, open Cetus → Settings → Remote Access and turn it on.")
                    Step(n: 2, text: "Scan the QR code shown there.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                Button {
                    scanning = true
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || !DataScannerViewController.isSupported)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or paste the pairing link")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    HStack {
                        TextField("cetus://pair#…", text: $link)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                            .submitLabel(.go)
                            .onSubmit { pair(link) }
                        Button("Pair") { pair(link) }
                            .disabled(link.isEmpty || busy)
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if busy {
                    ProgressView("Pairing…")
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $scanning) {
            QRScannerSheet { code in
                scanning = false
                pair(code)
            }
        }
        .toolbar {
            if !store.hosts.isEmpty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task(id: initialOffer?.id) {
            if let initialOffer { await run(initialOffer) }
        }
    }

    private func pair(_ text: String) {
        guard let offer = PairingOffer.parse(text) else {
            error = "That isn't a Cetus pairing code."
            return
        }
        Task { await run(offer) }
    }

    private func run(_ offer: PairingOffer) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await store.pair(with: offer)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct Step: View {
    let n: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .frame(width: 20, height: 20)
                .background(Color.accentColor.opacity(0.15), in: Circle())
                .foregroundStyle(Color.accentColor)
            Text(text)
                .font(.subheadline)
        }
    }
}

/// VisionKit's live scanner, QR codes only. Calls back once.
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            QRScanner(onCode: onCode)
                .ignoresSafeArea()
                .navigationTitle("Scan pairing code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case .barcode(let code) = item, let value = code.payloadStringValue,
                   PairingOffer.parse(value) != nil, !done
                {
                    done = true
                    scanner.stopScanning()
                    onCode(value)
                    return
                }
            }
        }
    }
}
