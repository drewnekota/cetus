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
    @State private var sends = 0
    @State private var focused = false

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
            ComposerTextView(text: $text, focused: $focused, placeholder: placeholder) { pasted in
                images += pasted.prefix(max(0, 4 - images.count)).compactMap(OutgoingImage.init)
            }
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
                    Button {
                        sends += 1
                        onStop()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Color(uiColor: UIColor(hex: 0xDC2626)), in: Circle())
                    }
                } else {
                    Button {
                        sends += 1
                        onSend()
                    } label: {
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
        // Swipe the box down to put the keyboard away.
        .swipeDownDismissesKeyboard()
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
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
        HStack(spacing: 6) {
            RuntimeIcon(id: backend, size: 16)
            Text(Runtime.label(for: backend))
                .font(Theme.label)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.faint)
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 6)
        .frame(height: 32)
        .contentShape(Rectangle())
        // The model chip beside it gives way first when the row is tight.
        .fixedSize()
    }
}

/// Model and effort label next to the runtime chip ("Fable · High").
struct TuningChip: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Text(text)
                .font(Theme.label)
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.faint)
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 6)
        .frame(height: 32)
        .contentShape(Rectangle())
    }
}

/// Pick a model and a reasoning effort from a runtime's catalog: efforts on
/// top, models below, a check on the one that runs. `model` / `effort` are
/// the stored pick ("" = the runtime's default, shown checked).
struct TuningMenu<L: View>: View {
    let tuning: RuntimeTuning
    let model: String
    let effort: String
    let onPick: (TuningChoice) -> Void
    @ViewBuilder var label: L

    var body: some View {
        let offered = tuning.efforts(forModel: model)
        Menu {
            if !offered.isEmpty {
                Section("Effort") {
                    Picker("Effort", selection: Binding(
                        get: { tuning.effort(for: effort, model: model)?.id ?? "" },
                        set: { onPick(TuningChoice(model: model, effort: $0)) }
                    )) {
                        ForEach(offered) { Text($0.label).tag($0.id) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
            if !tuning.models.isEmpty {
                Section("Model") {
                    Picker("Model", selection: Binding(
                        get: { tuning.model(for: model)?.id ?? model },
                        set: { onPick(TuningChoice(model: $0, effort: effort)) }
                    )) {
                        ForEach(tuning.models) { Text($0.label).tag($0.id) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
        } label: {
            label
        }
        .menuOrder(.fixed)
    }
}

/// The runtime's brand mark (same artwork as the desktop's public/brands).
struct RuntimeIcon: View {
    let id: String
    var size: CGFloat = 16

    var body: some View {
        if let ui = Runtime.icon(for: id) {
            Image(uiImage: ui)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        } else {
            Image(systemName: "cpu")
                .font(.system(size: size * 0.8, weight: .medium))
                .frame(width: size, height: size)
        }
    }
}

/// Pick a runtime: a pull-down anchored to whatever it wraps, each row with
/// its brand icon and a check on the current one.
struct RuntimeMenu<L: View>: View {
    let selected: String
    let onPick: (Runtime) -> Void
    @ViewBuilder var label: L

    var body: some View {
        Menu {
            Picker("Runtime", selection: Binding(
                get: { selected },
                set: { id in if id != selected, let r = Runtime(rawValue: id) { onPick(r) } }
            )) {
                ForEach(Runtime.allCases) { r in
                    // Menus tint SwiftUI images; a UIImage marked
                    // .alwaysOriginal keeps the brand colors.
                    Label {
                        Text(r.label)
                    } icon: {
                        if let ui = Runtime.icon(for: r.rawValue, menu: true) { Image(uiImage: ui) }
                    }
                    .tag(r.rawValue)
                }
            }
            .pickerStyle(.inline)
        } label: {
            label
        }
        .menuOrder(.fixed)
    }
}

extension Runtime {
    /// Brand icon from the asset catalog. `menu` returns it pre-sized and
    /// in original colors for UIMenu rows.
    static func icon(for id: String, menu: Bool = false) -> UIImage? {
        let known = Runtime(rawValue: id) != nil ? id : nil
        guard let known, let img = UIImage(named: "runtime-\(known == "pi" ? "cetus" : known)") else { return nil }
        guard menu else { return img }
        let size = CGSize(width: 20, height: 20)
        let r = UIGraphicsImageRenderer(size: size).image { _ in
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 4.5).addClip()
            img.draw(in: CGRect(origin: .zero, size: size))
        }
        // The DeepSeek whale is black line art: let the menu tint it.
        return id == Runtime.dsh.rawValue ? r.withRenderingMode(.alwaysTemplate) : r.withRenderingMode(.alwaysOriginal)
    }
}
