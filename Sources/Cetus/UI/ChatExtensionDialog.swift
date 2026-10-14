import AppKit
import SwiftUI

// Port of components/extension-ui/dialog-host.tsx: pi extensions' blocking
// ctx.ui select / confirm / input / editor requests render as a shadcn Dialog,
// one at a time (later requests queue); closing it answers {cancelled: true}.
// `notify` shows a transient toast. Replies go back through agentd's
// `extensionUiRespond` op to the pi that asked.

extension AgentHost {
    func extensionUiRespond(conv: String, id: String, body: JSON) {
        send(["op": "extensionUiRespond", "conv": .string(conv), "id": .string(id), "body": body])
    }
}

@MainActor
enum ChatExtensionDialogs {
    private struct Req { let conv: String; let event: JSON }
    private static var queue: [Req] = []
    private static var responded = Set<String>()
    nonisolated(unsafe) static weak var app: AppState?

    /// Called for every pi event; picks out extension_ui_request.
    static func observe(conv: String, event: JSON, controller: Controller) {
        guard event["type"].string == "extension_ui_request", let app else { return }
        switch event["method"].string ?? "" {
        case "select", "confirm", "input", "editor":
            queue.append(Req(conv: conv, event: event))
            let n = controller.prefs.notifications
            if n.enabled && n.awaitingInput {
                Notifier.post(title: "cetus needs your input", body: text(event["title"]), muteWhenFocused: true)
            }
            if queue.count == 1 { present(app) }
        case "notify":
            let kind: Toast.Kind = event["notifyType"].string == "error" ? .error : .plain
            app.toast(event["message"].stringValue, kind: kind)
        default: break
        }
    }

    static func text(_ v: JSON) -> String {
        if let s = v.string { return s }
        if v.isNull { return "" }
        return v.compact
    }

    private static func present(_ app: AppState) {
        guard let head = queue.first else { return }
        DialogHost.present("extension-ui", app: app) {
            ExtensionDialogView(event: head.event) { body in respond(head, body) }
        }
        DialogHost.onEscape = { respond(head, ["cancelled": true]); return true }
    }

    private static func respond(_ req: Req, _ body: JSON) {
        let id = req.event["id"].stringValue
        guard !responded.contains(id) else { return }
        responded.insert(id)
        app?.controller.host.extensionUiRespond(conv: req.conv, id: id, body: body)
        queue.removeAll { $0.event["id"].stringValue == id }
        DialogHost.dismiss()
        if let app, !queue.isEmpty { present(app) }
    }

    /// The overlay click (Radix onOpenChange(false)) also cancels.
    static func cancel(_ id: String) {
        if let req = queue.first(where: { $0.event["id"].stringValue == id }) { respond(req, ["cancelled": true]) }
    }
}

private struct ExtensionDialogView: View {
    let event: JSON
    let onSubmit: (JSON) -> Void
    @State private var text = ""
    @State private var hoverRow: String?

    private var method: String { event["method"].stringValue }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text(ChatExtensionDialogs.text(event["title"]))
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.trailing, 32)
                if method == "confirm", let m = event["message"].string, !m.isEmpty { description(m) }
                if method == "input", let p = event["placeholder"].string, !p.isEmpty { description(p) }
            }
            switch method {
            case "select": selectBody
            case "confirm":
                footer {
                    Button("Cancel") { onSubmit(["cancelled": true]) }.buttonStyle(SecondaryButton())
                    Button("No") { onSubmit(["confirmed": false]) }.buttonStyle(CetusButtonStyle(variant: .outline, height: 36))
                    Button("Yes") { onSubmit(["confirmed": true]) }.buttonStyle(CetusButtonStyle(variant: .primary, height: 36))
                }
            case "input":
                VStack(spacing: 12) {
                    TextField(event["placeholder"].stringValue, text: $text)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
                        .onSubmit { onSubmit(["value": .string(text)]) }
                    footer {
                        Button("Cancel") { onSubmit(["cancelled": true]) }.buttonStyle(SecondaryButton())
                        Button("Submit") { onSubmit(["value": .string(text)]) }.buttonStyle(CetusButtonStyle(variant: .primary, height: 36))
                    }
                }
            case "editor":
                VStack(spacing: 12) {
                    TextEditor(text: $text)
                        .font(.system(size: 12, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .frame(minHeight: 180)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
                    footer {
                        Button("Cancel") { onSubmit(["cancelled": true]) }.buttonStyle(SecondaryButton())
                        Button("Save (⌘↩)") { onSubmit(["value": .string(text)]) }.buttonStyle(CetusButtonStyle(variant: .primary, height: 36))
                    }
                }
                .onAppear {
                    text = event["prefill"].stringValue
                    DialogHost.onSubmit = { onSubmit(["value": .string(text)]) }
                }
            default: EmptyView()
            }
        }
        .padding(24)
        .frame(width: 448, alignment: .leading)
        .overlay(alignment: .topTrailing) {
            GhostIconButton(icon: "x", box: 32, glyph: 16) { onSubmit(["cancelled": true]) }
                .padding(16)
        }
        .dialogSurface()
        .onDisappear { ChatExtensionDialogs.cancel(event["id"].stringValue) }
        .testID("extension-dialog")
    }

    private func description(_ s: String) -> some View {
        Text(s).font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true)
    }

    private func footer<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        HStack(spacing: 8) { Spacer(minLength: 0); c() }
    }

    @ViewBuilder private var selectBody: some View {
        let options = (event["options"].array ?? []).map { ChatExtensionDialogs.text($0) }
        if options.count <= 6 {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(options, id: \.self) { o in
                    Button(o) { onSubmit(["value": .string(o)]) }.buttonStyle(SecondaryButton(fullWidth: true))
                }
            }
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(options, id: \.self) { o in
                        Button { onSubmit(["value": .string(o)]) } label: {
                            Text(o).font(.system(size: 14)).foregroundStyle(Theme.foreground)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(hoverRow == o ? Theme.secondary : .clear)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { hoverRow = $0 ? o : (hoverRow == o ? nil : hoverRow) }
                    }
                }
            }
            .frame(maxHeight: 288)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// shadcn Button variant="secondary" (h-9 px-2.5, bg-secondary, hover /80).
private struct SecondaryButton: ButtonStyle {
    var fullWidth = false
    func makeBody(configuration: Configuration) -> some View { SecondaryBody(configuration: configuration, fullWidth: fullWidth) }
    private struct SecondaryBody: View {
        let configuration: Configuration
        let fullWidth: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.foreground)
                .padding(.horizontal, 11)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 7).fill(Theme.secondary.opacity(hover ? 0.8 : 1)).padding(1))
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}
