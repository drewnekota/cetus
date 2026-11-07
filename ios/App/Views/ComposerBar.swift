import CetusRemoteKit
import PhotosUI
import SwiftUI

/// The rounded message box shared by the chat and new-chat screens: text on
/// top, a toolbar row below (attach, runtime chip, send / stop).
struct ComposerBar<Chip: View>: View {
    @Binding var text: String
    @Binding var images: [OutgoingImage]
    var placeholder = "Message"
    var running = false
    var busy = false
    var onSend: () -> Void
    var onStop: () -> Void = {}
    @ViewBuilder var chip: Chip

    @State private var picked: [PhotosPickerItem] = []
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !busy && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(images) { img in
                            Image(uiImage: img.preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        images.removeAll { $0.id == img.id }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 5, y: -5)
                                }
                        }
                    }
                    .padding(.top, 6)
                    .padding(.horizontal, 2)
                }
            }
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...8)
                .focused($focused)
                .font(Theme.content)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 6)
                .padding(.top, 4)
            HStack(spacing: 6) {
                PhotosPicker(selection: $picked, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "plus")
                        .font(.system(size: 19, weight: .light))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 36, height: 36)
                }
                chip
                Spacer(minLength: 4)
                if running && !canSend {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Color(uiColor: UIColor(hex: 0xDC2626)), in: Circle())
                    }
                } else {
                    Button(action: onSend) {
                        Group {
                            if busy {
                                ProgressView().controlSize(.small).tint(.white)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 15, weight: .semibold))
                            }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(canSend || busy ? Theme.accent : Theme.faint.opacity(0.45), in: Circle())
                    }
                    .disabled(!canSend)
                }
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Theme.borderAccent, lineWidth: 1))
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data),
                       let out = OutgoingImage(img)
                    {
                        images.append(out)
                    }
                }
                picked = []
            }
        }
    }
}

/// Small runtime label inside the composer.
struct RuntimeChip: View {
    let backend: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: Runtime.symbol(for: backend))
                .font(.system(size: 12, weight: .medium))
            Text(Runtime.label(for: backend))
                .font(Theme.label)
                .lineLimit(1)
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 6)
        .frame(height: 32)
    }
}

extension Runtime {
    static func symbol(for id: String) -> String {
        switch Runtime(rawValue: id) {
        case .claudeCode: "asterisk"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .pi: "circle.hexagongrid"
        case .dsh, .kimi, .grok, .opencode: "terminal"
        case nil: "cpu"
        }
    }
}
